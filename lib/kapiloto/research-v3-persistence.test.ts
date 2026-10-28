import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import {
  materializeKapilotoResearchRun,
  type MaterializableFixture,
} from "./run-materialization";
import {
  createMigratedDatabase,
  seedRoundWithRunningRun,
  type SeededRound,
} from "./test-support/pglite-migrations";
import { groundAndJudge, v3Card, v3Output } from "./test-support/research-v3-fixtures";

const V3_MIGRATION = /kapiloto_research_v3_tactical/;

async function analyses(seed: SeededRound) {
  const [first, ...rest] = seed.fixtures;
  const card = v3Card({}, {
    fixtureId: first.fixtureId,
    roundGameId: first.roundGameId,
    gameNumber: 1,
  });
  card.structured.prior = { ...card.structured.prior, snapshot_id: null };
  const output = v3Output();
  output.fixture_key = first.fixtureId;
  const grounding = await groundAndJudge(output, card, [/^Avi Striker is expected to start/]);
  const fixtures: MaterializableFixture[] = [
    {
      mode: "research",
      gameNumber: 1,
      roundGameId: first.roundGameId,
      fixtureId: first.fixtureId,
      card,
      output,
      grounding,
    },
    ...rest.map((fixture) => ({
      mode: "research_unavailable" as const,
      gameNumber: fixture.gameNumber,
      roundGameId: fixture.roundGameId,
      fixtureId: fixture.fixtureId,
      reason: "missing_prior" as const,
      context: {
        kickoffAt: "2026-10-30T18:00:00.000Z",
        settlementRule: "result_after_90_minutes_including_stoppage_time",
        neutralVenue: false,
      },
      researchCutoffAt: "2026-10-29T12:00:00.000Z",
    })),
  ];
  return materializeKapilotoResearchRun(fixtures);
}

async function persisted(db: PGlite, runId: string) {
  const rows = await db.query<{
    game_number: number;
    expected_lineups: { home: { status: string; starters: unknown[] } } | null;
    tactical_facts: unknown[] | null;
    matchup_analysis: unknown[] | null;
    regime_changes: unknown[] | null;
    availability: Array<{ functions?: string[] }>;
  }>(
    `select rg.game_number, a.expected_lineups, a.tactical_facts, a.matchup_analysis,
            a.regime_changes, a.availability
     from public.kapiloto_analyses a
     join public.round_games rg on rg.id = a.round_game_id
     where a.research_run_id = $1
     order by rg.game_number`,
    [runId],
  );
  return rows.rows;
}

test("new V3 migration exists and earlier migration files are untouched", () => {
  const files = readdirSync(join(process.cwd(), "supabase", "migrations")).sort();
  const v3 = files.filter((file) => V3_MIGRATION.test(file));
  assert.equal(v3.length, 1);
  // V3 stays the latest migration that touches Kapiloto research persistence.
  for (const later of files.slice(files.indexOf(v3[0]) + 1)) {
    const laterSql = readFileSync(join(process.cwd(), "supabase", "migrations", later), "utf8");
    assert.doesNotMatch(
      laterSql,
      /\bkapiloto_(analyses|factors|factor_evidence|evidence|research_|materialize|source_registry|fixture_|round_research_state)/i,
      `${later} must not alter V3 research persistence`,
    );
  }
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", v3[0]), "utf8");
  assert.match(sql, /add column if not exists expected_lineups jsonb/);
  assert.match(sql, /add column if not exists matchup_ids jsonb not null default '\[\]'::jsonb/);
  assert.doesNotMatch(sql, /disable row level security|create policy|grant select/i);
});

test("materialization RPC persists sanitized v3 fields; v1/v2-style rows stay null; replay is idempotent", async () => {
  const db = await createMigratedDatabase();
  const seed = await seedRoundWithRunningRun(db, {
    researchProtocolVersion: "kapiloto-research-v3",
  });
  const round = await analyses(seed);

  const first = await db.query<{ result: { replayed: boolean; analysis_count: number } }>(
    "select public.kapiloto_materialize_and_complete_run($1, $2::jsonb, $3::jsonb) as result",
    [seed.runId, JSON.stringify(round.analyses), JSON.stringify(round.synthesis)],
  );
  assert.equal(first.rows[0].result.replayed, false);
  assert.equal(first.rows[0].result.analysis_count, 16);

  const rows = await persisted(db, seed.runId);
  assert.equal(rows.length, 16);
  assert.equal(rows[0].expected_lineups?.home.status, "partial");
  assert.equal(rows[0].expected_lineups?.home.starters.length, 10);
  assert.equal(rows[0].tactical_facts?.length, 2);
  assert.equal(rows[0].matchup_analysis?.length, 1);
  assert.deepEqual(rows[0].regime_changes, []);
  assert.deepEqual(rows[0].availability[0].functions, ["defensive_anchor"]);
  for (const row of rows.slice(1)) {
    assert.equal(row.expected_lineups, null);
    assert.equal(row.tactical_facts, null);
    assert.equal(row.matchup_analysis, null);
    assert.equal(row.regime_changes, null);
  }

  const factor = await db.query<{ matchup_ids: string[] }>(
    `select f.matchup_ids from public.kapiloto_factors f
     join public.kapiloto_analyses a on a.id = f.analysis_id
     where a.research_run_id = $1 and f.dimension = 'tactical_matchup'`,
    [seed.runId],
  );
  assert.deepEqual(factor.rows[0].matchup_ids, ["m1"]);

  const replay = await db.query<{ result: { replayed: boolean } }>(
    "select public.kapiloto_materialize_and_complete_run($1, $2::jsonb, $3::jsonb) as result",
    [seed.runId, JSON.stringify(round.analyses), JSON.stringify(round.synthesis)],
  );
  assert.equal(replay.rows[0].result.replayed, true);
  assert.equal((await persisted(db, seed.runId)).length, 16);

  // Published analyses stay immutable.
  await assert.rejects(
    db.query(
      "update public.kapiloto_analyses set expected_lineups = null where research_run_id = $1",
      [seed.runId],
    ),
  );
  await db.close();
});

test("fenced finalization publication path persists the same v3 fields", async () => {
  const db = await createMigratedDatabase();
  const seed = await seedRoundWithRunningRun(db, {
    researchProtocolVersion: "kapiloto-research-v3",
  });
  const round = await analyses(seed);
  const claim = await db.query<{ result: { outcome: string; attempt_id?: string } }>(
    "select public.kapiloto_claim_run_finalization($1, 'worker-v3') as result",
    [seed.runId],
  );
  assert.equal(claim.rows[0].result.outcome, "claimed");
  const published = await db.query<{ result: Record<string, unknown> }>(
    "select public.kapiloto_publish_run_finalization($1, 'worker-v3', $2::jsonb, $3::jsonb) as result",
    [claim.rows[0].result.attempt_id, JSON.stringify(round.analyses), JSON.stringify(round.synthesis)],
  );
  assert.equal(published.rows[0].result.status, "completed");
  const rows = await persisted(db, seed.runId);
  assert.equal(rows[0].expected_lineups?.home.status, "partial");
  assert.equal(rows[0].matchup_analysis?.length, 1);
  await db.close();
});

test("RLS and privileges on published tables are unchanged by the V3 migration", async () => {
  const snapshot = async (db: PGlite) => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relname in ('kapiloto_analyses', 'kapiloto_factors', 'kapiloto_source_registry')
       order by relname`,
    );
    const policies = await db.query(
      `select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies
       where tablename in ('kapiloto_analyses', 'kapiloto_factors', 'kapiloto_source_registry')
       order by tablename, policyname`,
    );
    const grants = await db.query(
      `select table_name, grantee, privilege_type from information_schema.role_table_grants
       where table_name in ('kapiloto_analyses', 'kapiloto_factors')
         and grantee in ('anon', 'authenticated', 'service_role')
       order by table_name, grantee, privilege_type`,
    );
    const fn = await db.query(
      `select grantee, privilege_type from information_schema.routine_privileges
       where routine_name = 'kapiloto_materialize_and_complete_run'
       order by grantee, privilege_type`,
    );
    return JSON.stringify([rls.rows, policies.rows, grants.rows, fn.rows]);
  };
  const before = await createMigratedDatabase({ exclude: V3_MIGRATION });
  const after = await createMigratedDatabase();
  assert.equal(await snapshot(after), await snapshot(before));
  const rls = await after.query<{ relrowsecurity: boolean }>(
    "select relrowsecurity from pg_class where relname = 'kapiloto_analyses'",
  );
  assert.equal(rls.rows[0].relrowsecurity, true);
  await before.close();
  await after.close();
});

test("source registry gains explicit v3 claim-type tiers without overriding existing ones", async () => {
  const db = await createMigratedDatabase();
  const rows = await db.query<{ tiers: Record<string, number> }>(
    "select tier_by_claim_type as tiers from public.kapiloto_source_registry",
  );
  assert.ok(rows.rows.length > 0);
  for (const { tiers } of rows.rows) {
    assert.equal(tiers.lineup, tiers.availability ?? tiers.default);
    assert.equal(tiers.tactical_setup, tiers.tactical ?? tiers.default);
    assert.equal(tiers.formation, tiers.tactical ?? tiers.default);
    assert.equal(tiers.coach_regime, tiers.club_coach_news ?? tiers.default);
  }
  await db.close();
});
