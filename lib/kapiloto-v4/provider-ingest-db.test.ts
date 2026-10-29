import assert from "node:assert/strict";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";

import { createFixture, createLedgerDatabase, seedLedger, setClock, type LedgerSeed } from "./test-support/ledger-fixtures";
import { PROVIDER_MATCH_OBSERVATION_CONTRACT_VERSION, RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION, SPORTMONKS_LEDGER_MAPPING_VERSION } from "./versions";

async function seedProviderMappings(db: PGlite, seed: LedgerSeed) {
  await db.query(
    `insert into public.provider_competition_mappings
       (provider,provider_competition_id,competition_id,provider_name,mapping_status)
     values ('sportmonks','8',$1,'Synthetic League','confirmed')`,
    [seed.competitionId],
  );
  await db.query(
    `insert into public.provider_team_mappings
       (provider,provider_team_id,team_id,provider_name,mapping_status,mapping_confidence)
     values ('sportmonks','101',$1,'Synthetic Home','confirmed',1),
            ('sportmonks','202',$2,'Synthetic Away','confirmed',1)`,
    [seed.home.teamId, seed.away.teamId],
  );
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: PROVIDER_MATCH_OBSERVATION_CONTRACT_VERSION,
    provider: "sportmonks",
    provider_fixture_id: "9001",
    provider_endpoint: "/fixtures/9001",
    provider_league_id: "8",
    provider_season_id: "24000",
    provider_home_team_id: "101",
    provider_away_team_id: "202",
    capture_mode: "backfill",
    ingest_version: SPORTMONKS_LEDGER_MAPPING_VERSION,
    source_version: "sportmonks-v3",
    raw_payload_sha256: "a".repeat(64),
    retrieved_at: "2026-10-29T20:00:00Z",
    source_updated_at: null,
    kickoff_at: "2026-01-10T18:00:00Z",
    match_status: "finished",
    neutral_venue: false,
    home_goals_90: 2,
    away_goals_90: 1,
    home_goals_aet: null,
    away_goals_aet: null,
    home_penalties: null,
    away_penalties: null,
    fixture_mint: { allowed: true, kickoff_before: "2026-10-01T00:00:00Z" },
    run_id: null,
    teams: [
      { side: "home", provider_team_id: "101", formation_nominal: "4-2-3-1", lineup_status: "partial", substitutions_status: "not_provided", events_status: "not_provided", statistics_status: "partial" },
      { side: "away", provider_team_id: "202", formation_nominal: "4-3-3", lineup_status: "not_provided", substitutions_status: "not_provided", events_status: "not_provided", statistics_status: "not_provided" },
    ],
    players: [
      { provider_team_id: "101", provider_player_id: "new-501", provider_player_name: "Synthetic New Player", lineup_role: "starter", appeared: true, position_code: "MF", provider_position: "26", formation_position: 6, formation_field: "2:2", shirt_number: 8, is_captain: false, minutes_played: null, entered_minute: null, exited_minute: null, data_completeness: "partial" },
    ],
    team_stats: [
      { provider_team_id: "101", provider_stat_type: "5304", period: "full_time", value: 1.82 },
      { provider_team_id: "101", provider_stat_type: "42", period: "full_time", value: 14 },
    ],
    quality_flags: [],
    ...overrides,
  };
}

async function ingest(db: PGlite, value: Record<string, unknown>, clock = "2026-10-29T20:01:00Z") {
  await setClock(db, clock);
  const result = await db.query<{ result: any }>("select public.match_ledger_ingest_provider_fixture($1::jsonb) as result", [JSON.stringify(value)]);
  return result.rows[0].result;
}

test("A2-A mints atomically, bootstraps a confirmed player and re-ingests unchanged", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  await seedProviderMappings(db, seed);

  const first = await ingest(db, payload());
  assert.equal(first.status, "recorded");
  assert.equal(first.fixture_resolution, "minted");
  assert.equal(first.players_minted, 1);
  assert.equal(first.provider_refs_status, "recorded");

  const mapping = await db.query<any>("select fixture_id,mapping_status,mapping_confidence from public.provider_fixture_mappings where provider='sportmonks' and provider_fixture_id='9001'");
  assert.equal(mapping.rows.length, 1);
  assert.equal(mapping.rows[0].mapping_status, "confirmed");
  const player = await db.query<any>("select mapping_status,mapping_basis,mapping_confidence from public.provider_player_mappings where provider='sportmonks' and provider_player_id='new-501'");
  assert.equal(player.rows[0].mapping_status, "confirmed");
  assert.equal(player.rows[0].mapping_basis, "provider_native_bootstrap");
  assert.equal(Number(player.rows[0].mapping_confidence), 1);
  const refs = await db.query<any>("select ref_kind,provider_ref from public.match_ledger_observation_provider_refs where observation_id=$1 order by ref_kind", [first.observation_id]);
  assert.deepEqual(refs.rows, [
    { ref_kind: "league", provider_ref: "8" },
    { ref_kind: "season", provider_ref: "24000" },
    { ref_kind: "team_away", provider_ref: "202" },
    { ref_kind: "team_home", provider_ref: "101" },
  ]);
  assert.equal((await db.query("select * from public.match_ledger_fixture_mints")).rows.length, 1);

  const second = await ingest(db, payload(), "2026-10-29T20:02:00Z");
  assert.equal(second.status, "unchanged");
  assert.equal(second.provider_refs_status, "matched");
  assert.equal((await db.query("select * from public.match_ledger_observations")).rows.length, 1);
  assert.equal((await db.query("select * from public.match_ledger_observation_provider_refs")).rows.length, 4);
  await db.close();
});

test("provider identity ref drift quarantines before a correction can create a version", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  await seedProviderMappings(db, seed);
  await ingest(db, payload());
  await db.query(
    `insert into public.provider_team_mappings (provider,provider_team_id,team_id,mapping_status)
     values ('sportmonks','303',$1,'confirmed')`,
    [seed.home.teamId],
  );
  const drift = await ingest(db, payload({ provider_home_team_id: "303", home_goals_90: 3 }), "2026-10-30T20:01:00Z");
  assert.equal(drift.status, "quarantined");
  assert.equal(drift.reason_code, "provider_ref_drift");
  assert.equal((await db.query("select * from public.match_ledger_observations")).rows.length, 1);
  await db.close();
});

test("unmapped team/competition quarantine never creates canonical entities", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const beforeTeams = (await db.query("select count(*)::int as n from public.teams")).rows[0] as { n: number };
  const c = await ingest(db, payload({ provider_league_id: "999" }));
  assert.equal(c.reason_code, "competition_unmapped");
  await db.query(
    `insert into public.provider_competition_mappings (provider,provider_competition_id,competition_id,mapping_status)
     values ('sportmonks','8',$1,'confirmed')`,
    [seed.competitionId],
  );
  const t = await ingest(db, payload());
  assert.equal(t.reason_code, "team_unmapped");
  const afterTeams = (await db.query("select count(*)::int as n from public.teams")).rows[0] as { n: number };
  assert.equal(afterTeams.n, beforeTeams.n);
  await db.close();
});

test("single competition-scoped candidate attaches without mint policy", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  await seedProviderMappings(db, seed);
  const existing = await createFixture(db, seed, "2026-01-11T17:00:00Z");
  const result = await ingest(db, payload({ provider_fixture_id: "9002", fixture_mint: { allowed: false, kickoff_before: null } }));
  assert.equal(result.status, "recorded");
  assert.equal(result.fixture_resolution, "attached");
  assert.equal(result.fixture_id, existing.fixtureId);
  await db.close();
});

test("mint policy and candidate guards fail closed", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  await seedProviderMappings(db, seed);
  const denied = await ingest(db, payload({ provider_fixture_id: "9100", fixture_mint: { allowed: false, kickoff_before: null } }));
  assert.equal(denied.reason_code, "fixture_mint_not_permitted");

  await createFixture(db, seed, "2026-01-12T20:00:00Z"); // 50h from provider kickoff => W guard
  const reschedule = await ingest(db, payload({ provider_fixture_id: "9101", fixture_mint: { allowed: true, kickoff_before: "2026-10-01T00:00:00Z" } }));
  assert.equal(reschedule.reason_code, "fixture_possible_reschedule");
  await db.close();
});



test("two Sportmonks fixture ids cannot mint two canonical fixtures for one match", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  await seedProviderMappings(db, seed);
  const first = await ingest(db, payload({ provider_fixture_id: "9200" }));
  assert.equal(first.fixture_resolution, "minted");
  const second = await ingest(db, payload({ provider_fixture_id: "9201" }), "2026-10-29T20:03:00Z");
  assert.equal(second.status, "quarantined");
  assert.equal(second.reason_code, "fixture_candidate_ambiguous");
  const fixtures = await db.query<{ n: number }>(
    "select count(*)::int as n from public.fixtures where competition_id=$1 and home_team_id=$2 and away_team_id=$3 and kickoff_at='2026-01-10T18:00:00Z'",
    [seed.competitionId, seed.home.teamId, seed.away.teamId],
  );
  assert.equal(fixtures.rows[0].n, 1);
  await db.close();
});

test("retrospective training availability never changes strict as-of knowledge", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  await seedProviderMappings(db, seed);
  const first = await ingest(db, payload());

  const strict = await db.query<any>(
    "select * from public.match_ledger_team_match_stats_as_of('sportmonks',$1::uuid[],'2026-01-01T00:00:00Z','2026-01-12T00:00:00Z')",
    [[seed.competitionId]],
  );
  assert.equal(strict.rows.length, 0);
  const retrospective = await db.query<any>(
    "select * from public.match_ledger_team_match_stats_for_training('sportmonks',$1::uuid[],'2026-01-01T00:00:00Z','2026-01-12T00:00:00Z',$2)",
    [[seed.competitionId], RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION],
  );
  assert.equal(retrospective.rows.length, 2);
  assert.ok(retrospective.rows.every((r: any) => r.evaluation_class === "retrospective"));
  assert.ok(retrospective.rows.every((r: any) => r.availability_policy === RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION));
  const home = retrospective.rows.find((r: any) => r.side === "home");
  assert.equal(home.stats_for.expected_goals.status, "observed");
  assert.equal(Number(home.stats_for.expected_goals.value), 1.82);
  assert.equal(home.stats_for.expected_goals_on_target.status, "not_observed");
  assert.equal(home.stats_for.expected_goals_on_target.value, null);
  const away = retrospective.rows.find((r: any) => r.side === "away");
  assert.equal(away.stats_for.expected_goals.status, "family_not_provided");
  assert.equal(away.stats_for.expected_goals.value, null);

  const corrected = payload({ home_goals_90: 3 });
  const v2 = await ingest(db, corrected, "2026-10-30T20:01:00Z");
  assert.equal(v2.observation_version, 2);
  const oldCutoff = await db.query<any>(
    "select * from private.match_ledger_effective_versions('sportmonks','2026-01-12T00:00:00Z','retrospective_training',$1)",
    [RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION],
  );
  assert.equal(oldCutoff.rows[0].observation_version, 1);
  assert.equal(oldCutoff.rows[0].observation_id, first.observation_id);
  await db.close();
});

test("audit runs/items are append-only and failure attempts increment", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  await seedProviderMappings(db, seed);
  const run = await db.query<{ id: string }>(
    `insert into public.provider_ingest_runs (provider,purpose,ingest_version,fixture_mint_kickoff_before)
     values ('sportmonks','test',$1,'2026-10-01T00:00:00Z') returning id`,
    [SPORTMONKS_LEDGER_MAPPING_VERSION],
  );
  const p = payload({ run_id: run.rows[0].id });
  await ingest(db, p);
  await db.query("select public.provider_ingest_record_failure($1,'sportmonks','9001','synthetic_failure','{}'::jsonb)", [run.rows[0].id]);
  const items = await db.query<any>("select attempt_no,status from public.provider_ingest_items where run_id=$1 order by attempt_no", [run.rows[0].id]);
  assert.deepEqual(items.rows, [{ attempt_no: 1, status: "recorded" }, { attempt_no: 2, status: "failed" }]);
  await assert.rejects(db.query("delete from public.provider_ingest_items"), /immutable/);
  await assert.rejects(db.query("update public.provider_ingest_runs set purpose='backfill'"), /immutable/);
  await db.close();
});
