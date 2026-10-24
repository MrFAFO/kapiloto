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

const STUB_SCHEMA = `
create role anon;
create role authenticated;
create role service_role;
create schema private;
create table public.teams (id uuid primary key);
create table public.fixtures (id uuid primary key);
create table public.round_games (id uuid primary key);
create table public.kapiloto_analyses (id uuid primary key);
create table public.kapiloto_fixture_publications (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null unique,
  fixture_id uuid not null,
  published_at timestamptz not null
);
`;

const HOME = "00000000-0000-4000-8000-0000000000a1";
const AWAY = "00000000-0000-4000-8000-0000000000a2";
const FIXTURE = "00000000-0000-4000-8000-000000000f01";
const OTHER_FIXTURE = "00000000-0000-4000-8000-000000000f02";
const ANALYSIS = "00000000-0000-4000-8000-0000000000b1";
const HASH = "a".repeat(64);

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(STUB_SCHEMA);
  await db.exec(readFileSync(MIGRATION, "utf8"));
  await db.exec(`
    insert into public.teams values ('${HOME}'), ('${AWAY}');
    insert into public.fixtures values ('${FIXTURE}'), ('${OTHER_FIXTURE}');
    insert into public.kapiloto_analyses values ('${ANALYSIS}');
    insert into public.kapiloto_fixture_publications (analysis_id, fixture_id, published_at)
    values ('${ANALYSIS}', '${FIXTURE}', '2026-10-24T08:00:00Z');
  `);
  return db;
}

type PredictionRow = Record<string, unknown>;

function predictionRow(overrides: PredictionRow = {}): PredictionRow {
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

async function insertPrediction(db: PGlite, overrides: PredictionRow = {}) {
  const row = predictionRow(overrides);
  const columns = Object.keys(row);
  const result = await db.query<{ id: string; issued_at: Date; recorded_at: Date }>(
    `insert into public.kapiloto_eval_predictions (${columns.join(", ")})
     values (${columns.map((_, index) => `$${index + 1}`).join(", ")})
     returning id, issued_at, recorded_at`,
    Object.values(row),
  );
  return result.rows[0];
}

test("recorded predictions get a database-stamped issue time", async () => {
  const db = await database();
  const row = await insertPrediction(db);
  assert.notEqual(row.issued_at.getUTCFullYear(), 1999);
  assert.equal(row.issued_at.getTime(), row.recorded_at.getTime());
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

test("Kapiloto projections take the immutable publication time", async () => {
  const db = await database();
  const projection = {
    arm: "kapiloto_published",
    arm_version: "kapiloto-published-projection-v1",
    deterministic: false,
    issued_at_source: "kapiloto_publication",
    source_analysis_id: ANALYSIS,
    information_cutoff_at: "2026-10-24T06:00:00Z",
  };
  const row = await insertPrediction(db, projection);
  assert.equal(row.issued_at.toISOString(), "2026-10-24T08:00:00.000Z");

  await assert.rejects(
    insertPrediction(db, { ...projection, information_cutoff_at: "2026-10-24T09:00:00Z" }),
    /kapiloto_eval_information_after_issue/,
  );
  await assert.rejects(
    insertPrediction(db, { ...projection, fixture_id: OTHER_FIXTURE }),
    /kapiloto_eval_publication_fixture_mismatch/,
  );
  await assert.rejects(
    insertPrediction(db, { ...projection, source_analysis_id: null }),
    /kapiloto_eval_publication_not_found/,
  );
  await assert.rejects(
    insertPrediction(db, { ...projection, evaluation_mode: "replay" }),
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
      arm: "kapiloto_sol",
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
    insertPrediction(db, { arm: "league_base", home_team_id: AWAY, away_team_id: AWAY }),
    /check constraint/,
  );
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

test("scores require a consistent status, metrics and prediction link", async () => {
  const db = await database();
  const prediction = await insertPrediction(db);
  const insertScore = (status: string, predictionId: string | null, brier: number | null) =>
    db.query(
      `insert into public.kapiloto_eval_scores (
         fixture_id, arm, arm_version, evaluation_mode, selection_rule_version,
         scoring_version, status, prediction_id, outcome, home_goals_90,
         away_goals_90, outcome_source, brier, rps, log_loss, top_pick, top_pick_score
       ) values ($1, 'uniform', 'kapiloto-uniform-v1', 'forward', 'sel-v1', 'score-v1',
         $2, $3, '1', 2, 1, 'fixtures.regular_time_score', $4,
         case when $4::double precision is null then null else 0.2777 end,
         case when $4::double precision is null then null else 1.0986 end,
         case when $4::double precision is null then null else '1' end,
         case when $4::double precision is null then null else 0.3333 end)`,
      [FIXTURE, status, predictionId, brier],
    );
  await assert.rejects(insertScore("scored", prediction.id, null), /check constraint/);
  await assert.rejects(insertScore("no_eligible_prediction", prediction.id, null), /check constraint/);
  await insertScore("scored", prediction.id, 0.6667);
  await assert.rejects(insertScore("scored", prediction.id, 0.6667), /duplicate key/);
  await assert.rejects(
    db.query(`update public.kapiloto_eval_scores set brier = 0`),
    /immutable/,
  );
  await db.close();
});

test("market quotes cannot be backdated and must carry normalized probabilities", async () => {
  const db = await database();
  const insertQuote = (capturedAt: string | null, impliedHome = 0.45) =>
    db.query(
      `insert into public.fixture_market_quotes (
         fixture_id, provider, provider_fixture_id, bookmaker_id, odds_home,
         odds_draw, odds_away, overround, implied_home, implied_draw, implied_away,
         devig_method_version, capture_version, captured_at
       ) values ($1, 'api-football', '1001', '8', 2.1, 3.4, 3.6, 0.0485,
         $2, 0.3, 0.25, 'devig-power-v1', 'capture-v1', coalesce($3::timestamptz, now()))`,
      [FIXTURE, impliedHome, capturedAt],
    );
  await insertQuote(null);
  await assert.rejects(insertQuote("2026-01-01T00:00:00Z"), /check constraint/);
  await assert.rejects(insertQuote(null, 0.5), /check constraint/);
  await assert.rejects(db.query(`delete from public.fixture_market_quotes`), /immutable/);
  await db.close();
});

test("match results are unique per provider fixture and only observable after kickoff", async () => {
  const db = await database();
  const insertResult = (fixtureId: string, observedAt: string) =>
    db.query(
      `insert into public.football_match_results (
         provider, provider_fixture_id, provider_competition_id, kickoff_at,
         provider_home_team_id, provider_away_team_id, home_goals_90,
         away_goals_90, observed_at, ingest_version
       ) values ('sportmonks', $1, '8', '2026-05-01T18:00:00Z', '1', '2', 2, 1, $2,
         'football-results-ingest-v1')`,
      [fixtureId, observedAt],
    );
  await insertResult("100", "2026-05-02T00:00:00Z");
  await assert.rejects(insertResult("100", "2026-05-02T00:00:00Z"), /duplicate key/);
  await assert.rejects(insertResult("101", "2026-05-01T17:00:00Z"), /check constraint/);
  await db.close();
});

test("all shadow tables have RLS and no client-role privileges", async () => {
  const db = await database();
  const tables = [
    "football_match_results",
    "fixture_market_quotes",
    "kapiloto_eval_predictions",
    "kapiloto_eval_scores",
  ];
  const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
    `select relname, relrowsecurity from pg_class
     where relnamespace = 'public'::regnamespace and relname = any($1)
     order by relname`,
    [tables],
  );
  assert.equal(rls.rows.length, 4);
  assert.ok(rls.rows.every((row) => row.relrowsecurity));

  for (const role of ["anon", "authenticated"]) {
    for (const table of tables) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const result = await db.query<{ allowed: boolean }>(
          `select has_table_privilege($1, $2, $3) as allowed`,
          [role, `public.${table}`, privilege],
        );
        assert.equal(result.rows[0].allowed, false, `${role} ${privilege} ${table}`);
      }
    }
  }
  const policies = await db.query(
    `select 1 from pg_policies where schemaname = 'public' and tablename = any($1)`,
    [tables],
  );
  assert.equal(policies.rows.length, 0);
  await db.close();
});
