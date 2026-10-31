import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildMatchLedgerObservationPayload } from "./match-ledger";
import { buildPredictionSnapshotV2Payload } from "./prediction-registry";
import { buildProviderMatchObservationPayload } from "./provider-ingest";
import { createIngestRun, observationFrom, seedIngestIdentities, syntheticCapture } from "./test-support/provider-ingest-fixtures";
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
  "match_ledger_observation_provider_refs",
  "match_ledger_observation_family_fetches",
  "match_ledger_fixture_mints",
  "match_ledger_observation_identity_attestations",
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
  // Stage 1 (D-058).
  "public.provider_identity_attest_team(jsonb)",
  "public.provider_identity_revoke_team(jsonb)",
  "public.provider_identity_attest_competition(jsonb)",
  "public.provider_identity_revoke_competition(jsonb)",
  "public.match_ledger_team_match_stats_as_of_v2(text, uuid[], timestamptz, timestamptz)",
  "public.match_ledger_team_match_stats_for_training_v2(text, uuid[], timestamptz, timestamptz, text)",
  "public.match_ledger_retrospective_training_exclusions_v2(text, uuid[], timestamptz, timestamptz, text)",
  "public.provider_identity_attestation_conflicts(text)",
  "public.match_ledger_provider_ref_conflicts_v2(text)",
  "public.provider_identity_revocation_impact(text, text, text)",
];

// Historical ingest is not enabled: V1 is permanently revoked (D-057, D-058)
// and V2 stays revoked until the separate grant-only M2B migration.
const V4_PAUSED_PUBLIC_FUNCTIONS = [
  "public.match_ledger_ingest_provider_fixture(jsonb)",
  "public.match_ledger_ingest_provider_fixture_v2(jsonb)",
];

// V1 reads/reports whose trust semantics would mislead after Stage 1: present
// for contract/history inspection, not executable by service_role (D-058).
const V4_DEAUTHORIZED_V1_FUNCTIONS = [
  "public.match_ledger_team_match_stats_as_of(text, uuid[], timestamptz, timestamptz)",
  "public.match_ledger_team_match_stats_for_training(text, uuid[], timestamptz, timestamptz, text)",
  "public.match_ledger_retrospective_training_exclusions(text, uuid[], timestamptz, timestamptz, text)",
  "public.match_ledger_provider_ref_conflicts(text)",
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
  "private.provider_ingest_result(uuid, text, text, text, text, uuid, uuid, jsonb, jsonb, jsonb)",
  "private.match_ledger_effective_versions(text, timestamptz, text, text)",
  "private.match_ledger_team_match_stats(text, uuid[], timestamptz, timestamptz, text, text)",
  "private.match_ledger_team_stat_entry(uuid, uuid, text, text, boolean)",
  "private.provider_mapping_trusted(text, numeric)",
  "private.provider_competition_mapping_trusted(text)",
  "private.match_ledger_retrospective_exclusions(text, uuid[], timestamptz, timestamptz, text)",
  "private.provider_identity_evidence_issue(jsonb)",
  "private.provider_identity_evidence_sha256(jsonb)",
  "private.lock_provider_identity(text, boolean)",
  "private.holds_provider_identity_lock(text, boolean)",
  "private.assert_provider_identity_attestation_write(text)",
  "private.provider_identity_assert_request(text, text, text)",
  "private.provider_identity_begin_change(text)",
  "private.provider_team_attestation_matches(text, text, uuid, uuid)",
  "private.provider_competition_attestation_matches(text, text, uuid, uuid)",
  "private.match_ledger_observation_attestation_issue(uuid)",
  "private.provider_ingest_fixture_candidates_v2(text, text, uuid, uuid, uuid, timestamptz)",
  "private.match_ledger_team_match_stats_v2(text, uuid[], timestamptz, timestamptz, text, text)",
  "private.match_ledger_retrospective_exclusions_v2(text, uuid[], timestamptz, timestamptz, text)",
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
  for (const fn of V4_PAUSED_PUBLIC_FUNCTIONS) {
    const privileges = await db.query<{ anon: boolean; authenticated: boolean; service_role: boolean; definer: boolean }>(
      `select has_function_privilege('anon', $1::regprocedure, 'execute') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'execute') as authenticated,
              has_function_privilege('service_role', $1::regprocedure, 'execute') as service_role,
              (select prosecdef from pg_proc where oid = $1::regprocedure) as definer`,
      [fn],
    );
    assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service_role: false, definer: false }, fn);
  }
  for (const fn of V4_DEAUTHORIZED_V1_FUNCTIONS) {
    const privileges = await db.query<{ anon: boolean; authenticated: boolean; service_role: boolean }>(
      `select has_function_privilege('anon', $1::regprocedure, 'execute') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'execute') as authenticated,
              has_function_privilege('service_role', $1::regprocedure, 'execute') as service_role`,
      [fn],
    );
    assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service_role: false }, fn);
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
    for (const table of ["prediction_membership_inputs", "prediction_tenure_inputs", "prediction_squad_state_context"]) {
      await assert.rejects(db.query(`select * from public.${table}`), /permission denied/, `${role} ${table}`);
    }
    for (const table of ["provider_ingest_runs", "provider_ingest_items", "match_ledger_observation_provider_refs", "match_ledger_observation_family_fetches", "match_ledger_fixture_mints"]) {
      await assert.rejects(db.query(`select * from public.${table}`), /permission denied/, `${role} ${table}`);
    }
    await assert.rejects(db.query("select public.match_ledger_ingest_provider_fixture('{}'::jsonb)"), /permission denied/, role);
    await assert.rejects(db.query("select * from public.match_ledger_team_match_stats_as_of('sportmonks', null, null, now())"), /permission denied/, role);
    await assert.rejects(
      db.query("select * from public.match_ledger_team_match_stats_for_training('sportmonks', null, null, now(), 'kapiloto-retrospective-training-availability-v1')"),
      /permission denied/,
      role,
    );
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
    "supabase/migrations/20261030101247_kapiloto_v4_provider_ingest.sql",
    "supabase/migrations/20261030211645_kapiloto_v4_identity_mapping_guard.sql",
    "supabase/migrations/20261031100000_kapiloto_v4_identity_attestations.sql",
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

test("after M2A neither ingest RPC is executable by service_role; under a simulated M2B grant of V2 only, service_role attests, ingests, reads V2 and is refused V1", async () => {
  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true });
  const ids = { leagueId: "7701", homeTeamId: "77010", awayTeamId: "77011" };
  const seed = await seedIngestIdentities(db, { ...ids, teamMappingStatus: "manual_override" });
  const providerFixtureId = "27700001";
  const run = (await db.query<{ id: string }>(
    `insert into public.provider_ingest_runs (provider, purpose, ingest_version, scope) values ('sportmonks', 'test', 'kapiloto-sportmonks-ledger-mapping-v1', $1::jsonb) returning id`,
    [JSON.stringify({ provider_fixture_ids: [providerFixtureId] })],
  )).rows[0].id;
  const capture = syntheticCapture({ ...ids, providerFixtureId, kickoffAt: "2026-08-15T18:00:00.000Z", capturedAt: "2026-10-30T08:59:00.000Z" });
  const payload = JSON.stringify(buildProviderMatchObservationPayload(observationFrom(capture, { runId: run })));
  await db.query("select set_config('kapiloto.test_clock', '2026-10-29T00:00:00.000Z', false)");

  // M2A: both paused, even with Supabase's default function grants in place.
  await db.exec("set role service_role");
  await assert.rejects(db.query("select public.match_ledger_ingest_provider_fixture($1::jsonb)", [payload]), /permission denied/);
  await assert.rejects(db.query("select public.match_ledger_ingest_provider_fixture_v2($1::jsonb)", [payload]), /permission denied/);
  // Attestation runs as service_role through the invoker RPCs, one identity per call.
  const attest = (fn: string, body: Record<string, unknown>) => db.query(`select public.${fn}($1::jsonb)`, [JSON.stringify(body)]);
  const evidence = { contract_version: "kapiloto-provider-identity-attestation-evidence-v1", sources: ["synthetic"], reviewed_by: "synthetic", duplicate_audit_sha256: "a".repeat(64) };
  await attest("provider_identity_attest_competition", { provider: "sportmonks", provider_competition_id: ids.leagueId, competition_id: seed.competitionId, attestation_basis: "operator_manual", evidence, attested_by: "op" });
  await attest("provider_identity_attest_team", { provider: "sportmonks", provider_team_id: ids.homeTeamId, team_id: seed.homeTeamId, attestation_basis: "operator_manual", evidence, attested_by: "op" });
  await attest("provider_identity_attest_team", { provider: "sportmonks", provider_team_id: ids.awayTeamId, team_id: seed.awayTeamId, attestation_basis: "operator_manual", evidence, attested_by: "op" });
  // Direct projection writes by service_role are refused by the guard; TRUNCATE is not granted.
  await assert.rejects(db.query("delete from private.provider_team_identity_attestations"), /attest\/revoke RPCs/);
  await assert.rejects(db.query("truncate private.provider_team_identity_attestations"), /permission denied/);
  await db.exec("reset role");

  // What M2B (and only M2B) does: grant V2 ingest to service_role.
  await db.exec("grant execute on function public.match_ledger_ingest_provider_fixture_v2(jsonb) to service_role");
  await db.query("select set_config('kapiloto.test_clock', '2026-10-30T09:00:00.000Z', false)");
  await db.exec("set role service_role");
  const result = await db.query<{ result: { status: string; fixture_resolution: string } }>("select public.match_ledger_ingest_provider_fixture_v2($1::jsonb) as result", [payload]);
  assert.deepEqual([result.rows[0].result.status, result.rows[0].result.fixture_resolution], ["recorded", "minted"]);
  const rows = await db.query("select * from public.match_ledger_team_match_stats_as_of_v2('sportmonks', $1::uuid[], null, now())", [[seed.competitionId]]);
  assert.equal(rows.rows.length, 2);
  await assert.rejects(db.query("select * from public.match_ledger_team_match_stats_as_of('sportmonks', $1::uuid[], null, now())", [[seed.competitionId]]), /permission denied/);
  await assert.rejects(db.query("select * from public.match_ledger_provider_ref_conflicts('sportmonks')"), /permission denied/);
  await assert.rejects(db.query("select public.match_ledger_ingest_provider_fixture($1::jsonb)", [payload]), /permission denied/);
  await assert.rejects(db.query("update public.provider_ingest_items set reason_code = 'x'"), /immutable/);
  // No DELETE privilege at all (and the immutability trigger behind it).
  await assert.rejects(db.query("delete from public.match_ledger_observation_identity_attestations"), /permission denied/);
  await db.exec("reset role");
  await db.close();
});

test("Stage 1 tables: exact minimal service_role privileges, nothing for app roles, RLS enabled (not counted as a control against BYPASSRLS)", async () => {
  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true, testClock: false });
  const expected: Record<string, string[]> = {
    "private.provider_team_identity_attestations": ["DELETE", "INSERT", "SELECT", "UPDATE"],
    "private.provider_competition_identity_attestations": ["DELETE", "INSERT", "SELECT", "UPDATE"],
    "private.provider_team_identity_attestation_events": ["INSERT", "SELECT"],
    "private.provider_competition_identity_attestation_events": ["INSERT", "SELECT"],
    "public.match_ledger_observation_identity_attestations": ["INSERT", "SELECT"],
  };
  const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
  for (const [table, allowed] of Object.entries(expected)) {
    for (const role of ["service_role", "anon", "authenticated"]) {
      const held: string[] = [];
      for (const privilege of privileges) {
        const ok = (await db.query<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [role, table, privilege])).rows[0].ok;
        if (ok) held.push(privilege);
      }
      assert.deepEqual(held.sort(), role === "service_role" ? allowed : [], `${role} ${table}`);
    }
    assert.equal((await db.query<{ rls: boolean }>("select relrowsecurity as rls from pg_class where oid = $1::regclass", [table])).rows[0].rls, true, table);
  }
  // V2 ingest: no EXECUTE entry for PUBLIC, anon, authenticated or service_role.
  const acl = await db.query<{ grantee: string }>(
    `select coalesce(r.rolname, 'PUBLIC') as grantee
     from pg_proc p cross join lateral aclexplode(p.proacl) a left join pg_roles r on r.oid = a.grantee
     where p.oid = 'public.match_ledger_ingest_provider_fixture_v2(jsonb)'::regprocedure and a.privilege_type = 'EXECUTE'`,
  );
  assert.deepEqual(acl.rows.map((r) => r.grantee).filter((g) => ["PUBLIC", "anon", "authenticated", "service_role"].includes(g)), []);
  // The D-057 guard is still in place after M2A.
  const guards = await db.query<{ tgname: string }>("select tgname from pg_trigger where tgname like '%_identity_guard' order by tgname");
  assert.deepEqual(guards.rows.map((r) => r.tgname), ["provider_competition_mappings_identity_guard", "provider_fixture_mappings_identity_guard", "provider_team_mappings_identity_guard"]);
  await db.close();
});

test("every function M2A defines is security invoker with an empty search_path and revoked from app roles", async () => {
  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true, testClock: false });
  const names = [...readFileSync("supabase/migrations/20261031100000_kapiloto_v4_identity_attestations.sql", "utf8").matchAll(/create or replace function (public|private)\.([a-z_0-9]+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
  assert.ok(names.length >= 28, String(names.length));
  const rows = await db.query<{ fn: string; definer: boolean; config: string[] | null; anon: boolean; authenticated: boolean }>(
    `select n.nspname || '.' || p.proname as fn, p.prosecdef as definer, p.proconfig as config,
            has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname || '.' || p.proname = any($1)`,
    [names],
  );
  assert.equal(rows.rows.length, new Set(names).size);
  for (const row of rows.rows) {
    assert.deepEqual([row.definer, row.anon, row.authenticated], [false, false, false], row.fn);
    assert.ok((row.config ?? []).includes('search_path=""'), row.fn);
  }
  await db.close();
});
