import assert from "node:assert/strict";
import test from "node:test";

import { buildMatchLedgerObservationPayload } from "./match-ledger";
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
];

const V4_PUBLIC_FUNCTIONS = [
  "public.match_ledger_record_observation(jsonb)",
  "public.match_ledger_observation_as_of(uuid, text, timestamptz)",
  "public.match_ledger_team_matches_as_of(uuid, timestamptz, integer, text)",
  "public.match_ledger_player_matches_as_of(uuid, timestamptz, integer, text)",
  "public.team_coach_tenures_as_of(uuid, timestamptz)",
];

const V4_PRIVATE_HELPERS_FOR_SERVICE_ROLE = [
  "private.kapiloto_information_clock()",
  "private.normalize_entity_alias(text)",
  "private.match_ledger_assert_keys(jsonb, text[], text)",
  "private.match_ledger_record_withdrawal(jsonb)",
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
    "select * from public.match_ledger_team_matches_as_of($1, now(), 5, null)",
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
