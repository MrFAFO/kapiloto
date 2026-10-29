import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildMatchLedgerObservationPayload } from "./match-ledger";
import { buildPredictionSnapshotV2Payload } from "./prediction-registry";
import { LINEUP_RECORDED, forecastSnapshot, setupLineupWorld } from "./test-support/lineup-fixtures";
import {
  createFixture,
  createLedgerDatabase,
  realisticObservation,
  seedLedger,
} from "./test-support/ledger-fixtures";

const V4_TABLES = [
  "players",
  "player_aliases",
  "provider_player_mappings",
  "coaches",
  "coach_aliases",
  "provider_coach_mappings",
  "team_coach_tenures",
  "match_ledger_observations",
  "match_ledger_team_records",
  "match_ledger_players",
  "match_ledger_substitutions",
  "match_ledger_events",
  "match_ledger_stat_definitions",
  "match_ledger_team_stats",
  "match_ledger_game_state_segments",
  "knowledge_documents",
  "knowledge_document_versions",
  "knowledge_claims",
  "knowledge_claim_observations",
  "knowledge_claim_relations",
  "knowledge_claim_resolutions",
  "knowledge_resolution_evidence",
  "prediction_snapshots",
  "prediction_ledger_inputs",
  "prediction_document_inputs",
  "prediction_claim_inputs",
  "prediction_claim_observation_inputs",
  "prediction_reference_inputs",
  "prediction_identity_bindings",
  "team_player_memberships",
  "prediction_membership_inputs",
  "prediction_tenure_inputs",
  "prediction_squad_state_context",
  "provider_ingest_runs",
  "provider_ingest_items",
  "match_ledger_fixture_mints",
  "match_ledger_observation_provider_refs",
];

const V4_PUBLIC_FUNCTIONS = [
  "public.match_ledger_record_observation(jsonb)",
  "public.match_ledger_observation_as_of(uuid, text, timestamptz)",
  "public.match_ledger_provider_team_matches_as_of(text, uuid, timestamptz, integer)",
  "public.match_ledger_provider_player_matches_as_of(text, uuid, timestamptz, integer)",
  "public.team_coach_tenures_as_of(uuid, timestamptz)",
  "public.player_alias_candidates(text)",
  "public.coach_alias_candidates(text)",
  "public.resolve_provider_player_ids(text, text[])",
  "public.resolve_provider_coach_ids(text, text[])",
  "public.match_ledger_mapping_conflicts(text)",
  "public.knowledge_record_document_version(jsonb)",
  "public.knowledge_record_claim(jsonb)",
  "public.knowledge_record_claim_resolution(jsonb)",
  "public.prediction_record_snapshot(jsonb)",
  "public.knowledge_document_version_as_of(uuid, timestamptz)",
  "public.knowledge_claim_resolutions_as_of(uuid[], timestamptz)",
  "public.knowledge_claim_support_as_of(uuid, timestamptz)",
  "public.knowledge_canonical_claims(uuid[])",
  "public.team_player_memberships_as_of(uuid, timestamptz, date)",
  "public.squad_state_inputs_as_of(uuid, uuid, timestamptz, integer)",
  "public.prediction_record_snapshot_v2(jsonb)",
  "public.provider_ingest_record_failure(uuid, text, text, text, jsonb)",
  "public.match_ledger_ingest_provider_fixture(jsonb)",
  "public.match_ledger_team_match_stats_as_of(text, uuid[], timestamptz, timestamptz)",
  "public.match_ledger_team_match_stats_for_training(text, uuid[], timestamptz, timestamptz, text)",
];

const V4_PRIVATE_HELPERS_FOR_SERVICE_ROLE = [
  "private.kapiloto_information_clock()",
  "private.normalize_entity_alias(text)",
  "private.match_ledger_assert_keys(jsonb, text[], text)",
  "private.match_ledger_record_withdrawal(jsonb)",
  "private.kapiloto_require_read_committed(text)",
  "private.surviving_player_id(uuid)",
  "private.surviving_coach_id(uuid)",
  "private.lock_match_ledger_fixture(text, text, uuid)",
  "private.lock_canonical_identity(text, boolean)",
  "private.match_ledger_assert_surviving_ids(jsonb, jsonb, jsonb, jsonb)",
  "private.kapiloto_v4_assert_keys(jsonb, text[], text)",
  "private.knowledge_document_version_fingerprint(text, text, text, text, text, timestamptz, text, boolean, boolean, boolean)",
  "private.knowledge_claim_fingerprint(text, text, text, text, uuid, uuid, uuid, uuid, jsonb, text, text, date, date)",
  "private.knowledge_claim_group(text, text, text, text, uuid, uuid, uuid, uuid, jsonb, text, text, date, date)",
  "private.prediction_output_sha256(text, text, smallint, smallint, smallint, numeric, jsonb, text, jsonb)",
  "private.prediction_canonical_inputs(jsonb)",
  "private.prediction_input_bundle_sha256(jsonb)",
  "private.prediction_canonical_inputs_v2(jsonb)",
  "private.prediction_input_bundle_sha256_v2(jsonb)",
  "private.prediction_json_int_between(jsonb, integer, integer)",
  "private.prediction_lineup_estimate_issue(jsonb)",
  "private.prepare_match_ledger_observation_provider_ref()",
  "private.provider_ingest_append_item(uuid, text, text, text, text, uuid, uuid, jsonb)",
  "private.match_ledger_ingest_quarantine(uuid, text, text, text, uuid, text, jsonb)",
  "private.match_ledger_effective_versions(text, timestamptz, text, text)",
  "private.match_ledger_team_match_stats_read(text, uuid[], timestamptz, timestamptz, text, text)",
];

test("every V4 table is RLS-protected, policy-free and invisible to app users", async () => {
  // Emulates Supabase's default grants so the migration's revokes are tested.
  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true, testClock: false });

  const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
    "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1)",
    [V4_TABLES],
  );
  assert.equal(rls.rows.length, V4_TABLES.length);
  assert.ok(rls.rows.every((row) => row.relrowsecurity), JSON.stringify(rls.rows));

  const policies = await db.query("select tablename from pg_policies where tablename = any($1)", [V4_TABLES]);
  assert.deepEqual(policies.rows, []);

  const appGrants = await db.query(
    `select table_name, grantee, privilege_type from information_schema.role_table_grants
     where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated', 'PUBLIC')`,
    [V4_TABLES],
  );
  assert.deepEqual(appGrants.rows, []);

  for (const fn of V4_PUBLIC_FUNCTIONS) {
    const privileges = await db.query<{ anon: boolean; authenticated: boolean; service_role: boolean; definer: boolean }>(
      `select has_function_privilege('anon', $1::regprocedure, 'execute') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'execute') as authenticated,
              has_function_privilege('service_role', $1::regprocedure, 'execute') as service_role,
              (select prosecdef from pg_proc where oid = $1::regprocedure) as definer`,
      [fn],
    );
    assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service_role: true, definer: false }, fn);
  }
  for (const fn of V4_PRIVATE_HELPERS_FOR_SERVICE_ROLE) {
    const privileges = await db.query<{ authenticated: boolean; service_role: boolean }>(
      `select has_function_privilege('authenticated', $1::regprocedure, 'execute') as authenticated,
              has_function_privilege('service_role', $1::regprocedure, 'execute') as service_role`,
      [fn],
    );
    assert.deepEqual(privileges.rows[0], { authenticated: false, service_role: true }, fn);
  }

  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query("select * from public.players"), /permission denied/, role);
    await assert.rejects(db.query("select * from public.match_ledger_observations"), /permission denied/, role);
    await assert.rejects(
      db.query("select public.match_ledger_record_observation('{}'::jsonb)"),
      /permission denied/,
      role,
    );
    await assert.rejects(
      db.query("insert into public.players (canonical_name) values ('x')"),
      /permission denied/,
      role,
    );
    await assert.rejects(db.query("select * from public.knowledge_claims"), /permission denied/, role);
    await assert.rejects(db.query("select * from public.prediction_snapshots"), /permission denied/, role);
    await assert.rejects(db.query("select public.prediction_record_snapshot('{}'::jsonb)"), /permission denied/, role);
    await assert.rejects(db.query("select public.prediction_record_snapshot_v2('{}'::jsonb)"), /permission denied/, role);
    await assert.rejects(db.query("select public.match_ledger_ingest_provider_fixture('{}'::jsonb)"), /permission denied/, role);
    await assert.rejects(
      db.query("select * from public.match_ledger_team_match_stats_for_training('sportmonks', array[]::uuid[], now() - interval '1 day', now(), 'kapiloto-retrospective-training-availability-v1')"),
      /permission denied/,
      role,
    );
    for (const table of ["prediction_membership_inputs", "prediction_tenure_inputs", "prediction_squad_state_context"]) {
      await assert.rejects(db.query(`select * from public.${table}`), /permission denied/, `${role} ${table}`);
    }
    await db.exec("reset role");
  }
  await db.close();
});

test("service_role can ingest through the RPC but cannot override the information clock", async () => {
  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true, testClock: false });
  const seed = await seedLedger(db);
  const kickoff = "2024-03-02T18:00:00.000Z";
  const fixture = await createFixture(db, seed, kickoff);
  const payload = buildMatchLedgerObservationPayload(
    realisticObservation(seed, fixture, { kickoffAt: kickoff, retrievedAt: "2024-03-03T00:00:00.000Z" }),
  );

  await db.exec("set role service_role");
  const result = await db.query<{ result: { status: string } }>(
    "select public.match_ledger_record_observation($1::jsonb) as result",
    [JSON.stringify(payload)],
  );
  assert.equal(result.rows[0].result.status, "recorded");
  await db.query(
    "insert into public.player_aliases (player_id, alias, language_code, alias_kind) values ($1, 'שחקן בדיקה', 'he', 'canonical')",
    [seed.home.playerIds[0]],
  );
  const history = await db.query(
    "select * from public.match_ledger_provider_team_matches_as_of('sportmonks', $1, now(), 5)",
    [seed.home.teamId],
  );
  assert.equal(history.rows.length, 1);

  await assert.rejects(
    db.query(
      "create or replace function private.kapiloto_information_clock() returns timestamptz language sql stable as $$ select '2000-01-01'::timestamptz $$",
    ),
    /permission denied|must be owner/,
  );
  await assert.rejects(db.query("update public.match_ledger_players set minutes_played = 1"), /immutable/);
  await db.exec("reset role");
  await db.close();
});

test("service_role records a lineup forecast through the V2 RPC (security invoker) and cannot rewrite it", async () => {
  const world = await setupLineupWorld({ supabaseDefaultPrivileges: true });
  const { db } = world;
  const { snapshot } = await forecastSnapshot(world, world.home.teamId);
  await db.query("select set_config('kapiloto.test_clock', $1, false)", [LINEUP_RECORDED]);
  await db.exec("set role service_role");
  const result = await db.query<{ result: { status: string; snapshot_id: string } }>(
    "select public.prediction_record_snapshot_v2($1::jsonb) as result",
    [JSON.stringify(buildPredictionSnapshotV2Payload(snapshot))],
  );
  assert.equal(result.rows[0].result.status, "recorded");
  const context = await db.query("select squad_state_sha256 from public.prediction_squad_state_context where snapshot_id = $1", [result.rows[0].result.snapshot_id]);
  assert.equal(context.rows.length, 1);
  await assert.rejects(db.query("delete from public.prediction_membership_inputs"), /immutable/);
  await assert.rejects(db.query("update public.prediction_squad_state_context set history_max_fixtures = 1"), /immutable/);
  await db.exec("reset role");
  await db.close();
});

test("no function defined by a V4 migration is executable by app roles or security definer", async () => {
  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true, testClock: false });
  const names = new Set<string>();
  for (const file of [
    "supabase/migrations/20261028010437_kapiloto_v4_entities_match_ledger.sql",
    "supabase/migrations/20261028132857_kapiloto_v4_knowledge_prediction_registry.sql",
    "supabase/migrations/20261029074019_kapiloto_v4_roster_squad_state.sql",
    "supabase/migrations/20261029085303_kapiloto_v4_lineup_prediction_registry_v2.sql",
    "supabase/migrations/20261029211641_kapiloto_v4_squad_state_features_v2.sql",
    "supabase/migrations/20261029231924_kapiloto_v4_provider_ingest.sql",
  ]) {
    for (const match of readFileSync(file, "utf8").matchAll(/create or replace function (?:public|private)\.([a-z_0-9]+)\(/g)) {
      names.add(match[1]);
    }
  }
  const functions = await db.query<{ fn: string; anon: boolean; authenticated: boolean; definer: boolean }>(
    `select p.oid::regprocedure::text as fn,
            has_function_privilege('anon', p.oid, 'execute') as anon,
            has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
            p.prosecdef as definer
     from pg_proc p
     where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.proname = any($1)`,
    [[...names]],
  );
  assert.equal(functions.rows.length, names.size);
  assert.deepEqual(functions.rows.filter((row) => row.anon || row.authenticated || row.definer), []);
  await db.close();
});
