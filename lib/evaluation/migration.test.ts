import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20261024090000_kapiloto_shadow_evaluation_v1.sql",
);

// Only the columns the migration's triggers read from existing tables.
const STUB_SCHEMA = `
create role anon;
create role authenticated;
create role service_role;
create schema private;
create table public.teams (id uuid primary key);
create table public.fixtures (
  id uuid primary key,
  kickoff_at timestamptz not null,
  actual_kickoff_at timestamptz,
  home_team_id uuid not null,
  away_team_id uuid not null,
  status text not null,
  home_score smallint,
  away_score smallint
);
create table public.round_games (id uuid primary key);
create table public.kapiloto_analyses (
  id uuid primary key,
  kickoff_at_snapshot timestamptz not null,
  p_final_1_bp smallint, p_final_x_bp smallint, p_final_2_bp smallint,
  p_sol_1_bp smallint, p_sol_x_bp smallint, p_sol_2_bp smallint
);
create table public.kapiloto_fixture_publications (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null unique,
  fixture_id uuid not null,
  published_at timestamptz not null
);
`;

const HOME = "00000000-0000-4000-8000-0000000000a1";
const AWAY = "00000000-0000-4000-8000-0000000000a2";
/** Finished 2-1, kickoff far in the future so rows recorded "now" are pre-deadline. */
const FIXTURE = "00000000-0000-4000-8000-000000000f01";
const FIXTURE_KICKOFF = "2999-01-01T14:00:00.000Z";
const OTHER_FIXTURE = "00000000-0000-4000-8000-000000000f02";
/** Finished 0-0 in the past: anything recorded now is after its deadline. */
const PAST_FIXTURE = "00000000-0000-4000-8000-000000000f03";
const ANALYSIS = "00000000-0000-4000-8000-0000000000b1";
const LATER_ANALYSIS = "00000000-0000-4000-8000-0000000000b2";
const HASH = "a".repeat(64);
const SHADOW_TABLES = [
  "fixture_market_capture_attempts",
  "fixture_market_quotes",
  "football_match_results",
  "kapiloto_eval_predictions",
  "kapiloto_eval_scores",
];

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(STUB_SCHEMA);
  await db.exec(readFileSync(MIGRATION, "utf8"));
  await db.exec(`
    insert into public.teams values ('${HOME}'), ('${AWAY}');
    insert into public.fixtures values
      ('${FIXTURE}', '${FIXTURE_KICKOFF}', null, '${HOME}', '${AWAY}', 'finished', 2, 1),
      ('${OTHER_FIXTURE}', '2999-01-02T14:00:00Z', null, '${HOME}', '${AWAY}', 'upcoming', null, null),
      ('${PAST_FIXTURE}', '2026-01-01T14:00:00Z', null, '${HOME}', '${AWAY}', 'finished', 0, 0);
    insert into public.kapiloto_analyses values
      ('${ANALYSIS}', '${FIXTURE_KICKOFF}', 5000, 2800, 2200, 5400, 2600, 2000),
      ('${LATER_ANALYSIS}', '${FIXTURE_KICKOFF}', 4800, 3000, 2200, 5200, 2800, 2000);
    insert into public.kapiloto_fixture_publications (analysis_id, fixture_id, published_at) values
      ('${ANALYSIS}', '${FIXTURE}', '2026-10-24T08:00:00Z'),
      ('${LATER_ANALYSIS}', '${FIXTURE}', '2026-10-24T09:00:00Z');
  `);
  return db;
}

type Row = Record<string, unknown>;

function predictionRow(overrides: Row = {}): Row {
  return {
    fixture_id: FIXTURE,
    arm: "uniform",
    arm_version: "kapiloto-uniform-v1",
    evaluation_mode: "forward",
    deterministic: true,
    information_cutoff_at: "2026-01-01T00:00:00Z",
    issued_at: "1999-01-01T00:00:00Z",
    issued_at_source: "recorded",
    source_analysis_id: null,
    kickoff_at_snapshot: "2026-10-24T14:00:00Z",
    home_team_id: HOME,
    away_team_id: AWAY,
    valid: true,
    invalid_reason: null,
    p_home: 1 / 3,
    p_draw: 1 / 3,
    p_away: 1 / 3,
    basis: "{}",
    input_sha256: HASH,
    ...overrides,
  };
}

async function insertRow<T>(db: PGlite, table: string, row: Row, returning = "id"): Promise<T> {
  const columns = Object.keys(row);
  const result = await db.query<T>(
    `insert into public.${table} (${columns.join(", ")})
     values (${columns.map((_, index) => `$${index + 1}`).join(", ")})
     returning ${returning}`,
    Object.values(row),
  );
  return result.rows[0];
}

type InsertedPrediction = { id: string; issued_at: Date; recorded_at: Date; kickoff_at_snapshot: Date };

function insertPrediction(db: PGlite, overrides: Row = {}) {
  return insertRow<InsertedPrediction>(
    db,
    "kapiloto_eval_predictions",
    predictionRow(overrides),
    "id, issued_at, recorded_at, kickoff_at_snapshot",
  );
}

const projection = (analysisId = ANALYSIS, arm = "kapiloto_published"): Row => ({
  arm,
  arm_version:
    arm === "kapiloto_published"
      ? "kapiloto-published-projection-v1"
      : "kapiloto-sol-projection-v1",
  deterministic: false,
  issued_at_source: "kapiloto_publication",
  source_analysis_id: analysisId,
  information_cutoff_at: "2026-10-24T06:00:00Z",
  ...(analysisId === ANALYSIS
    ? arm === "kapiloto_published"
      ? { p_home: 0.5, p_draw: 0.28, p_away: 0.22 }
      : { p_home: 0.54, p_draw: 0.26, p_away: 0.2 }
    : { p_home: 0.48, p_draw: 0.3, p_away: 0.22 }),
});

test("recorded predictions get database-stamped issue time, kickoff and orientation", async () => {
  const db = await database();
  const row = await insertPrediction(db);
  assert.notEqual(row.issued_at.getUTCFullYear(), 1999);
  assert.equal(row.issued_at.getTime(), row.recorded_at.getTime());
  assert.equal(row.kickoff_at_snapshot.toISOString(), FIXTURE_KICKOFF);

  await assert.rejects(
    insertPrediction(db, { home_team_id: AWAY, away_team_id: HOME, information_cutoff_at: "2026-01-02T00:00:00Z" }),
    /kapiloto_eval_orientation_mismatch/,
  );
  await assert.rejects(
    insertPrediction(db, { fixture_id: "00000000-0000-4000-8000-00000000ffff" }),
    /kapiloto_eval_fixture_not_found/,
  );
  await db.close();
});

test("forward predictions cannot claim information from after their issue time", async () => {
  const db = await database();
  await assert.rejects(
    insertPrediction(db, { information_cutoff_at: "2999-01-01T00:00:00Z" }),
    /kapiloto_eval_information_after_issue/,
  );
  await db.close();
});

test("Kapiloto projections carry exactly the published probabilities and publication time", async () => {
  const db = await database();
  const row = await insertPrediction(db, projection());
  assert.equal(row.issued_at.toISOString(), "2026-10-24T08:00:00.000Z");
  assert.equal(row.kickoff_at_snapshot.toISOString(), FIXTURE_KICKOFF);
  await insertPrediction(db, projection(ANALYSIS, "kapiloto_sol"));

  await assert.rejects(
    insertPrediction(db, { ...projection(), information_cutoff_at: "2026-10-24T09:00:00Z" }),
    /kapiloto_eval_information_after_issue/,
  );
  await assert.rejects(
    insertPrediction(db, {
      ...projection(),
      information_cutoff_at: "2026-10-24T07:00:00Z",
      p_home: 0.6,
      p_draw: 0.2,
      p_away: 0.2,
    }),
    /kapiloto_eval_publication_probability_mismatch/,
  );
  await assert.rejects(
    insertPrediction(db, { ...projection(), fixture_id: OTHER_FIXTURE }),
    /kapiloto_eval_publication_fixture_mismatch/,
  );
  await assert.rejects(
    insertPrediction(db, { ...projection(), source_analysis_id: null }),
    /kapiloto_eval_publication_not_found/,
  );
  await assert.rejects(
    insertPrediction(db, { ...projection(), evaluation_mode: "replay" }),
    /check constraint/,
  );
  await db.close();
});

test("Kapiloto arms cannot be written as recorded rows, nor other arms as projections", async () => {
  const db = await database();
  await assert.rejects(
    insertPrediction(db, {
      arm: "kapiloto_published",
      arm_version: "kapiloto-published-projection-v1",
      deterministic: false,
      p_home: 0.5,
      p_draw: 0.28,
      p_away: 0.22,
    }),
    /check constraint/,
  );
  await assert.rejects(
    insertPrediction(db, { ...projection(), arm: "uniform", arm_version: "kapiloto-uniform-v1", p_home: 0.54, p_draw: 0.26, p_away: 0.2 }),
    /check constraint/,
  );
  await db.close();
});

test("replay is limited to deterministic arms and is free of the issue-time check", async () => {
  const db = await database();
  await insertPrediction(db, {
    evaluation_mode: "replay",
    information_cutoff_at: "2026-10-24T13:45:00Z",
  });
  await assert.rejects(
    insertPrediction(db, {
      arm: "p_stat",
      evaluation_mode: "replay",
      deterministic: false,
      information_cutoff_at: "2026-10-24T13:45:00Z",
    }),
    /check constraint/,
  );
  await db.close();
});

test("prediction validity, identity and immutability are enforced", async () => {
  const db = await database();
  const first = await insertPrediction(db);
  await assert.rejects(insertPrediction(db), /duplicate key/);
  await insertPrediction(db, {
    arm: "market",
    valid: false,
    invalid_reason: "no_quotes_before_cutoff",
    p_home: null,
    p_draw: null,
    p_away: null,
  });
  await assert.rejects(
    insertPrediction(db, { arm: "p_stat", p_home: 0.5, p_draw: 0.5, p_away: 0.5 }),
    /check constraint/,
  );
  await assert.rejects(
    insertPrediction(db, { arm: "p_stat", valid: false, invalid_reason: "x" }),
    /check constraint/,
  );
  await assert.rejects(insertPrediction(db, { arm: "Bad-Arm" }), /check constraint/);
  await assert.rejects(
    db.query(`update public.kapiloto_eval_predictions set p_home = 1 where id = $1`, [first.id]),
    /immutable/,
  );
  await assert.rejects(
    db.query(`delete from public.kapiloto_eval_predictions where id = $1`, [first.id]),
    /immutable/,
  );
  await db.close();
});

type ScoreInput = {
  fixtureId?: string;
  arm?: string;
  armVersion?: string;
  mode?: string;
  status?: string;
  predictionId: string | null;
  outcome?: string;
  goals?: [number, number];
  selectionRule?: string;
};

function insertScore(db: PGlite, input: ScoreInput) {
  const scored = (input.status ?? "scored") === "scored";
  const [home, away] = input.goals ?? [2, 1];
  return insertRow(db, "kapiloto_eval_scores", {
    fixture_id: input.fixtureId ?? FIXTURE,
    arm: input.arm ?? "uniform",
    arm_version: input.armVersion ?? "kapiloto-uniform-v1",
    evaluation_mode: input.mode ?? "forward",
    selection_rule_version: input.selectionRule ?? "sel-v1",
    scoring_version: "score-v1",
    status: input.status ?? "scored",
    prediction_id: input.predictionId,
    outcome: input.outcome ?? "1",
    home_goals_90: home,
    away_goals_90: away,
    outcome_source: "fixtures.regular_time_score",
    brier: scored ? 0.6667 : null,
    rps: scored ? 0.2777 : null,
    log_loss: scored ? 1.0986 : null,
    top_pick: scored ? "1" : null,
    top_pick_score: scored ? 0.3333 : null,
  });
}

test("scores require a consistent status, metrics, result and prediction link", async () => {
  const db = await database();
  const prediction = await insertPrediction(db);
  await assert.rejects(
    db.query(
      `insert into public.kapiloto_eval_scores (fixture_id, arm, arm_version, evaluation_mode,
         selection_rule_version, scoring_version, status, prediction_id, outcome,
         home_goals_90, away_goals_90, outcome_source)
       values ($1, 'uniform', 'kapiloto-uniform-v1', 'forward', 's', 's', 'scored', $2, '1', 2, 1, 'x')`,
      [FIXTURE, prediction.id],
    ),
    /check constraint/,
  );
  await assert.rejects(
    insertScore(db, { predictionId: prediction.id, goals: [1, 1], outcome: "X" }),
    /kapiloto_eval_score_outcome_mismatch/,
  );
  await assert.rejects(
    insertScore(db, { predictionId: prediction.id, outcome: "2" }),
    /kapiloto_eval_score_outcome_mismatch/,
  );
  await assert.rejects(
    insertScore(db, { fixtureId: OTHER_FIXTURE, predictionId: prediction.id }),
    /kapiloto_eval_score_outcome_mismatch/,
  );
  await assert.rejects(
    insertScore(db, { predictionId: prediction.id, arm: "p_stat" }),
    /kapiloto_eval_score_prediction_mismatch/,
  );
  await assert.rejects(
    insertScore(db, { predictionId: prediction.id, status: "prediction_unavailable" }),
    /kapiloto_eval_score_prediction_mismatch/,
  );
  await insertScore(db, { predictionId: prediction.id });
  await assert.rejects(insertScore(db, { predictionId: prediction.id }), /duplicate key/);
  await assert.rejects(db.query(`update public.kapiloto_eval_scores set brier = 0`), /immutable/);
  await db.close();
});

test("scores cannot use a post-deadline prediction or claim none was eligible", async () => {
  const db = await database();
  const late = await insertPrediction(db, { fixture_id: PAST_FIXTURE });
  await assert.rejects(
    insertScore(db, { fixtureId: PAST_FIXTURE, predictionId: late.id, goals: [0, 0], outcome: "X" }),
    /kapiloto_eval_score_prediction_ineligible/,
  );
  await insertScore(db, {
    fixtureId: PAST_FIXTURE,
    predictionId: null,
    status: "no_eligible_prediction",
    goals: [0, 0],
    outcome: "X",
  });

  await insertPrediction(db);
  await assert.rejects(
    insertScore(db, { predictionId: null, status: "no_eligible_prediction" }),
    /kapiloto_eval_score_prediction_available/,
  );
  await db.close();
});

test("scores cannot fall back to an older prediction than the latest eligible one", async () => {
  const db = await database();
  const early = await insertPrediction(db, projection(ANALYSIS));
  const later = await insertPrediction(db, projection(LATER_ANALYSIS));
  const kapiloto = { arm: "kapiloto_published", armVersion: "kapiloto-published-projection-v1" };
  await assert.rejects(
    insertScore(db, { ...kapiloto, predictionId: early.id }),
    /kapiloto_eval_score_not_latest_prediction/,
  );
  await insertScore(db, { ...kapiloto, predictionId: later.id });

  const replayOld = await insertPrediction(db, {
    evaluation_mode: "replay",
    information_cutoff_at: "2998-12-01T00:00:00Z",
  });
  const replayNew = await insertPrediction(db, {
    evaluation_mode: "replay",
    information_cutoff_at: "2998-12-02T00:00:00Z",
    valid: false,
    invalid_reason: "insufficient_history",
    p_home: null,
    p_draw: null,
    p_away: null,
  });
  await assert.rejects(
    insertScore(db, { mode: "replay", predictionId: replayOld.id }),
    /kapiloto_eval_score_not_latest_prediction/,
  );
  await insertScore(db, { mode: "replay", predictionId: replayNew.id, status: "prediction_unavailable" });
  await db.close();
});

test("market quotes are stamped by the database and must carry normalized probabilities", async () => {
  const db = await database();
  const insertQuote = (capturedAt: string | null, impliedHome = 0.45) =>
    db.query<{ captured_at: Date; created_at: Date }>(
      `insert into public.fixture_market_quotes (
         fixture_id, provider, provider_fixture_id, bookmaker_id, odds_home,
         odds_draw, odds_away, overround, implied_home, implied_draw, implied_away,
         devig_method_version, capture_version, captured_at
       ) values ($1, 'api-football', '1001', '8', 2.1, 3.4, 3.6, 0.0485,
         $2, 0.3, 0.25, 'devig-power-v1', 'capture-v1', coalesce($3::timestamptz, now()))
       returning captured_at, created_at`,
      [FIXTURE, impliedHome, capturedAt],
    );
  const before = Date.now() - 60_000;
  const backdated = await insertQuote("2026-01-01T00:00:00Z");
  assert.ok(backdated.rows[0].captured_at.getTime() > before, "writer timestamp is ignored");
  await assert.rejects(insertQuote(null, 0.5), /check constraint/);
  await assert.rejects(db.query(`delete from public.fixture_market_quotes`), /immutable/);
  await db.close();
});

test("match results carry provenance, are unique and are only observable after the match", async () => {
  const db = await database();
  const insertResult = (fixtureId: string, kickoffAt: string, scoreSource = "2ND_HALF") =>
    db.query<{ observed_at: Date }>(
      `insert into public.football_match_results (
         provider, provider_fixture_id, provider_competition_id, kickoff_at,
         provider_home_team_id, provider_away_team_id, home_goals_90,
         away_goals_90, provider_state, score_source, observed_at, ingest_version
       ) values ('sportmonks', $1, '8', $2, '1', '2', 2, 1, 'FT', $3,
         '1999-01-01T00:00:00Z', 'football-results-ingest-v1')
       returning observed_at`,
      [fixtureId, kickoffAt, scoreSource],
    );
  const saved = await insertResult("100", "2026-05-01T18:00:00Z");
  assert.notEqual(saved.rows[0].observed_at.getUTCFullYear(), 1999);
  await assert.rejects(insertResult("100", "2026-05-01T18:00:00Z"), /duplicate key/);
  await assert.rejects(insertResult("101", "2999-01-01T18:00:00Z"), /check constraint/);
  await assert.rejects(insertResult("102", "2026-05-01T18:00:00Z", "AET"), /check constraint/);
  await db.close();
});

test("capture attempts record unavailable states honestly and are immutable", async () => {
  const db = await database();
  const attempt = (overrides: Row) =>
    insertRow<{ attempted_at: Date }>(
      db,
      "fixture_market_capture_attempts",
      {
        fixture_id: FIXTURE,
        provider: "api-football",
        attempted_at: "1999-01-01T00:00:00Z",
        status: "saved",
        cadence_window: "near",
        quotes_saved: 3,
        provider_requests: 2,
        capture_version: "capture-v1",
        ...overrides,
      },
      "attempted_at",
    );
  const saved = await attempt({});
  assert.notEqual(saved.attempted_at.getUTCFullYear(), 1999);
  await attempt({ status: "no_quotes", quotes_saved: 0 });
  await attempt({ status: "skipped_budget", quotes_saved: 0, provider_requests: 0 });
  await assert.rejects(attempt({ status: "saved", quotes_saved: 0 }), /check constraint/);
  await assert.rejects(attempt({ status: "no_quotes", quotes_saved: 2 }), /check constraint/);
  await assert.rejects(
    attempt({ status: "skipped_budget", quotes_saved: 0, provider_requests: 1 }),
    /check constraint/,
  );
  await assert.rejects(attempt({ cadence_window: "hourly" }), /check constraint/);
  await assert.rejects(
    db.query(`update public.fixture_market_capture_attempts set quotes_saved = 9`),
    /immutable/,
  );
  await db.close();
});

test("no shadow table can be truncated", async () => {
  const db = await database();
  for (const table of SHADOW_TABLES) {
    await assert.rejects(db.query(`truncate public.${table} cascade`), /immutable/, table);
  }
  await db.close();
});

test("all shadow tables have RLS, no policies and no client-role privileges", async () => {
  const db = await database();
  const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
    `select relname, relrowsecurity from pg_class
     where relnamespace = 'public'::regnamespace and relname = any($1)
     order by relname`,
    [SHADOW_TABLES],
  );
  assert.deepEqual(rls.rows.map((row) => row.relname), SHADOW_TABLES);
  assert.ok(rls.rows.every((row) => row.relrowsecurity));

  for (const role of ["anon", "authenticated"]) {
    for (const table of SHADOW_TABLES) {
      for (const privilege of ["select", "insert", "update", "delete", "truncate"]) {
        const result = await db.query<{ allowed: boolean }>(
          `select has_table_privilege($1, $2, $3) as allowed`,
          [role, `public.${table}`, privilege],
        );
        assert.equal(result.rows[0].allowed, false, `${role} ${privilege} ${table}`);
      }
    }
  }
  const functions = await db.query<{ proname: string }>(
    `select proname from pg_proc where pronamespace = 'private'::regnamespace order by proname`,
  );
  assert.equal(functions.rows.length, 5);
  for (const role of ["anon", "authenticated"]) {
    for (const { proname } of functions.rows) {
      const result = await db.query<{ allowed: boolean }>(
        `select has_function_privilege($1, $2, 'execute') as allowed`,
        [role, `private.${proname}()`],
      );
      assert.equal(result.rows[0].allowed, false, `${role} execute ${proname}`);
    }
  }
  const policies = await db.query(
    `select 1 from pg_policies where schemaname = 'public' and tablename = any($1)`,
    [SHADOW_TABLES],
  );
  assert.equal(policies.rows.length, 0);
  await db.close();
});

test("the service role can append through the triggers but cannot rewrite history", async () => {
  const db = await database();
  // Supabase grants service_role table privileges and RLS bypass; the private
  // trigger functions stay non-executable for it.
  await db.exec(`
    alter role service_role bypassrls;
    grant usage on schema public to service_role;
    grant select on public.fixtures, public.kapiloto_analyses,
      public.kapiloto_fixture_publications to service_role;
    grant select, insert, update, delete on public.kapiloto_eval_predictions,
      public.fixture_market_quotes to service_role;
    set role service_role;
  `);
  const row = await insertPrediction(db);
  assert.ok(row.id);
  await insertPrediction(db, projection());
  await assert.rejects(
    db.query(`update public.kapiloto_eval_predictions set valid = false`),
    /immutable/,
  );
  await assert.rejects(db.query(`delete from public.kapiloto_eval_predictions`), /immutable/);
  await db.exec(`reset role`);
  await db.close();
});
