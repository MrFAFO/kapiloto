import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { createLedgerDatabase } from "./test-support/ledger-fixtures";
import { asIdentityOperator } from "./test-support/provider-ingest-fixtures";

/**
 * Stage 0 containment (D-057): automated writers cannot update an existing
 * Sportmonks identity mapping, nor any manual_override mapping. The update is
 * skipped, never raised, so V3's structured sync keeps succeeding.
 */

const T1 = "00000071-0000-4000-8000-000000000001";
const T2 = "00000071-0000-4000-8000-000000000002";
const C1 = "00000072-0000-4000-8000-000000000001";
const C2 = "00000072-0000-4000-8000-000000000002";
const F1 = "00000073-0000-4000-8000-000000000001";
const F2 = "00000073-0000-4000-8000-000000000002";
const FIRST_SEEN = "2026-10-30T05:22:00.000Z";
const LATER = "2026-10-30T20:45:05.000Z";

async function world(): Promise<PGlite> {
  // Supabase's default grants, so the V3 writes below can run as service_role.
  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true, testClock: false });
  await db.query("insert into public.teams (id, canonical_name) values ($1, 'Team One'), ($2, 'Team Two')", [T1, T2]);
  await db.query("insert into public.competitions (id, canonical_name) values ($1, 'League One'), ($2, 'League Two')", [C1, C2]);
  await db.query(
    `insert into public.fixtures (id, competition_id, home_team_id, away_team_id, kickoff_at)
     values ($1, $3, $4, $5, '2026-11-01T15:00:00Z'), ($2, $3, $5, $4, '2027-03-01T15:00:00Z')`,
    [F1, F2, C1, T1, T2],
  );
  return db;
}

/**
 * The statement PostgREST runs for supabase-js `.upsert(row, { onConflict })`
 * with the default `return=minimal` (merge-duplicates: every payload column is
 * set from EXCLUDED), as the V3 Sportmonks store issues it.
 */
async function postgrestUpsert(
  db: PGlite,
  table: "provider_team_mappings" | "provider_competition_mappings" | "provider_fixture_mappings",
  onConflict: string[],
  row: Record<string, unknown>,
): Promise<number> {
  const columns = Object.keys(row);
  const list = columns.map((c) => `"${c}"`).join(", ");
  const set = columns.map((c) => `"${c}" = excluded."${c}"`).join(", ");
  const result = await db.query<{ page_total: number }>(
    `with pgrst_source as (
       insert into public.${table} (${list})
       select ${list} from json_populate_recordset(null::public.${table}, $1::json) _
       on conflict (${onConflict.map((c) => `"${c}"`).join(", ")}) do update set ${set}
       returning 1
     )
     select count(pgrst_source) as page_total from pgrst_source`,
    [JSON.stringify([row])],
  );
  return Number(result.rows[0].page_total);
}

async function asServiceRole<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

const teamRow = (db: PGlite, provider: string, providerTeamId: string) =>
  db
    .query<{ team_id: string; provider_name: string | null; mapping_status: string; mapping_confidence: number | null; last_verified_at: Date | null }>(
      `select team_id, provider_name, mapping_status, mapping_confidence::float8 as mapping_confidence, last_verified_at
       from public.provider_team_mappings where provider = $1 and provider_team_id = $2`,
      [provider, providerTeamId],
    )
    .then((r) => r.rows[0]);

const competitionRow = (db: PGlite, provider: string, providerCompetitionId: string) =>
  db
    .query<{ competition_id: string; mapping_status: string }>(
      "select competition_id, mapping_status from public.provider_competition_mappings where provider = $1 and provider_competition_id = $2",
      [provider, providerCompetitionId],
    )
    .then((r) => r.rows[0]);

const fixtureRows = (db: PGlite, provider: string) =>
  db
    .query<{ fixture_id: string; provider_fixture_id: string; mapping_status: string; mapping_confidence: number | null }>(
      `select fixture_id, provider_fixture_id, mapping_status, mapping_confidence::float8 as mapping_confidence
       from public.provider_fixture_mappings where provider = $1 order by provider_fixture_id`,
      [provider],
    )
    .then((r) => r.rows);

function v3Team(providerTeamId: string, teamId: string, confidence: number, at: string) {
  return {
    provider: "sportmonks",
    provider_team_id: providerTeamId,
    team_id: teamId,
    provider_name: `SM ${providerTeamId} @ ${at}`,
    mapping_status: "confirmed",
    mapping_confidence: confidence,
    last_verified_at: at,
  };
}

test("a V3-style Sportmonks upsert of an existing row succeeds as a no-op and changes nothing", async () => {
  const db = await world();
  await asServiceRole(db, async () => {
    assert.equal(await postgrestUpsert(db, "provider_team_mappings", ["provider", "provider_team_id"], v3Team("14", T1, 0.9, FIRST_SEEN)), 1);
    const before = await teamRow(db, "sportmonks", "14");
    // Re-point, re-status and refresh: the statement succeeds, the row is skipped.
    assert.equal(await postgrestUpsert(db, "provider_team_mappings", ["provider", "provider_team_id"], v3Team("14", T2, 1, LATER)), 0);
    assert.deepEqual(await teamRow(db, "sportmonks", "14"), before);
    // A plain UPDATE is skipped the same way, with no error.
    const plain = await db.query("update public.provider_team_mappings set team_id = $1 where provider = 'sportmonks' and provider_team_id = '14'", [T2]);
    assert.equal(plain.affectedRows, 0);
    assert.deepEqual(await teamRow(db, "sportmonks", "14"), before);
  });
  // The writing role needs no EXECUTE on the trigger function.
  const grant = await db.query<{ ok: boolean }>(
    "select has_function_privilege('service_role', 'private.guard_v3_identity_mapping_update()'::regprocedure, 'execute') as ok",
  );
  assert.equal(grant.rows[0].ok, false);
  await db.close();
});

test("a 0.9 name match cannot be laundered to confidence 1 by seeing its own fixture mapping again", async () => {
  const db = await world();
  await asServiceRole(db, async () => {
    // First sync: name match writes fixture and team mappings at 0.9.
    assert.equal(
      await postgrestUpsert(db, "provider_fixture_mappings", ["fixture_id", "provider"], {
        fixture_id: F1, round_game_id: null, provider: "sportmonks", provider_fixture_id: "19000001",
        mapping_status: "confirmed", mapping_confidence: 0.9, mapped_at: FIRST_SEEN,
      }),
      1,
    );
    await postgrestUpsert(db, "provider_team_mappings", ["provider", "provider_team_id"], v3Team("14", T1, 0.9, FIRST_SEEN));
    // Next sync: the fixture id is now "provided", so V3 writes confidence 1.
    assert.equal(
      await postgrestUpsert(db, "provider_fixture_mappings", ["fixture_id", "provider"], {
        fixture_id: F1, round_game_id: null, provider: "sportmonks", provider_fixture_id: "19000001",
        mapping_status: "confirmed", mapping_confidence: 1, mapped_at: LATER,
      }),
      0,
    );
    assert.equal(await postgrestUpsert(db, "provider_team_mappings", ["provider", "provider_team_id"], v3Team("14", T1, 1, LATER)), 0);
  });
  assert.deepEqual(await fixtureRows(db, "sportmonks"), [{ fixture_id: F1, provider_fixture_id: "19000001", mapping_status: "confirmed", mapping_confidence: 0.9 }]);
  assert.equal((await teamRow(db, "sportmonks", "14")).mapping_confidence, 0.9);
  await db.close();
});

test("a manual_override mapping cannot be downgraded or re-pointed by an automated write", async () => {
  const db = await world();
  await db.query(
    "insert into public.provider_competition_mappings (provider, provider_competition_id, competition_id, mapping_status) values ('sportmonks', '8', $1, 'manual_override')",
    [C1],
  );
  await asServiceRole(db, async () => {
    const written = await postgrestUpsert(db, "provider_competition_mappings", ["provider", "provider_competition_id"], {
      provider: "sportmonks", provider_competition_id: "8", competition_id: C2, provider_name: "Premier League",
      mapping_status: "confirmed", last_verified_at: LATER,
    });
    assert.equal(written, 0);
    await db.query("update public.provider_competition_mappings set mapping_status = 'confirmed' where provider_competition_id = '8'");
  });
  assert.deepEqual(await competitionRow(db, "sportmonks", "8"), { competition_id: C1, mapping_status: "manual_override" });
  await db.close();
});

test("a missing Sportmonks mapping is still inserted (V3 can bootstrap an absent identity)", async () => {
  const db = await world();
  await asServiceRole(db, async () => {
    assert.equal(await postgrestUpsert(db, "provider_team_mappings", ["provider", "provider_team_id"], v3Team("52", T2, 0.9, FIRST_SEEN)), 1);
    assert.equal(
      await postgrestUpsert(db, "provider_competition_mappings", ["provider", "provider_competition_id"], {
        provider: "sportmonks", provider_competition_id: "24", competition_id: C2, provider_name: "FA Cup", mapping_status: "confirmed", last_verified_at: FIRST_SEEN,
      }),
      1,
    );
  });
  assert.deepEqual(
    [(await teamRow(db, "sportmonks", "52")).team_id, (await competitionRow(db, "sportmonks", "24")).competition_id],
    [T2, C2],
  );
  await db.close();
});

test("a Sportmonks fixture mapping cannot be re-pointed; a primary-key conflict still raises as before", async () => {
  const db = await world();
  await db.query(
    "insert into public.provider_fixture_mappings (fixture_id, provider, provider_fixture_id, mapping_status, mapping_confidence) values ($1, 'sportmonks', '19000001', 'confirmed', 1)",
    [F1],
  );
  await asServiceRole(db, async () => {
    // Same canonical fixture, a different provider fixture id (V3's conflict target).
    const moved = await postgrestUpsert(db, "provider_fixture_mappings", ["fixture_id", "provider"], {
      fixture_id: F1, round_game_id: null, provider: "sportmonks", provider_fixture_id: "19000002",
      mapping_status: "confirmed", mapping_confidence: 0.9, mapped_at: LATER,
    });
    assert.equal(moved, 0);
    // The same provider fixture id on another canonical fixture violates the
    // primary key, exactly as it did before the guard.
    await assert.rejects(
      postgrestUpsert(db, "provider_fixture_mappings", ["fixture_id", "provider"], {
        fixture_id: F2, round_game_id: null, provider: "sportmonks", provider_fixture_id: "19000001",
        mapping_status: "confirmed", mapping_confidence: 0.9, mapped_at: LATER,
      }),
      /duplicate key value/,
    );
  });
  assert.deepEqual(await fixtureRows(db, "sportmonks"), [{ fixture_id: F1, provider_fixture_id: "19000001", mapping_status: "confirmed", mapping_confidence: 1 }]);
  await db.close();
});

test("API-Football confirmed rows still update as before; API-Football manual_override rows are protected", async () => {
  const db = await world();
  await db.query(
    `insert into public.provider_team_mappings (provider, provider_team_id, team_id, provider_name, mapping_status, mapping_confidence)
     values ('api-football', '746', $1, 'Sunderland', 'confirmed', 0.95), ('api-football', '63', $1, 'Leeds', 'manual_override', 1)`,
    [T1],
  );
  await db.query(
    "insert into public.provider_fixture_mappings (fixture_id, provider, provider_fixture_id, mapping_status, mapping_confidence) values ($1, 'api-football', '555', 'unverified', 0.9)",
    [F1],
  );
  await asServiceRole(db, async () => {
    const promote = { provider: "api-football", provider_team_id: "746", team_id: T2, provider_name: "Sunderland AFC", mapping_status: "confirmed", mapping_confidence: 1, last_verified_at: LATER };
    assert.equal(await postgrestUpsert(db, "provider_team_mappings", ["provider", "provider_team_id"], promote), 1);
    const override = { ...promote, provider_team_id: "63", provider_name: "Leeds United", mapping_confidence: 0.9 };
    assert.equal(await postgrestUpsert(db, "provider_team_mappings", ["provider", "provider_team_id"], override), 0);
    assert.equal(
      await postgrestUpsert(db, "provider_fixture_mappings", ["fixture_id", "provider"], {
        fixture_id: F1, round_game_id: null, provider: "api-football", provider_fixture_id: "555", mapping_status: "confirmed", mapping_confidence: 1, mapped_at: LATER,
      }),
      1,
    );
  });
  const promoted = await teamRow(db, "api-football", "746");
  assert.deepEqual([promoted.team_id, promoted.provider_name, promoted.mapping_confidence], [T2, "Sunderland AFC", 1]);
  const kept = await teamRow(db, "api-football", "63");
  assert.deepEqual([kept.team_id, kept.provider_name, kept.mapping_status, kept.mapping_confidence], [T1, "Leeds", "manual_override", 1]);
  assert.deepEqual((await fixtureRows(db, "api-football")).map((r) => [r.mapping_status, r.mapping_confidence]), [["confirmed", 1]]);
  await db.close();
});

test("the operator override applies only inside the transaction that set it", async () => {
  const db = await world();
  await db.query(
    "insert into public.provider_competition_mappings (provider, provider_competition_id, competition_id, mapping_status) values ('sportmonks', '372', $1, 'confirmed')",
    [C1],
  );
  // Without the flag, even inside an explicit transaction, nothing changes.
  await db.exec("begin; update public.provider_competition_mappings set mapping_status = 'manual_override' where provider_competition_id = '372'; commit;");
  assert.equal((await competitionRow(db, "sportmonks", "372")).mapping_status, "confirmed");

  // The documented operator form.
  await db.exec(`
    begin;
    set local kapiloto.identity_operator = 'on';
    update public.provider_competition_mappings set mapping_status = 'manual_override'
    where provider = 'sportmonks' and provider_competition_id = '372' and competition_id = '${C1}';
    commit;
  `);
  assert.equal((await competitionRow(db, "sportmonks", "372")).mapping_status, "manual_override");
  // The setting ended with that transaction.
  const after = await db.query<{ value: string | null }>("select nullif(current_setting('kapiloto.identity_operator', true), '') as value");
  assert.equal(after.rows[0].value, null);
  await db.query("update public.provider_competition_mappings set mapping_status = 'confirmed' where provider_competition_id = '372'");
  assert.equal((await competitionRow(db, "sportmonks", "372")).mapping_status, "manual_override");

  // A rolled-back operator transaction leaves nothing behind either.
  await db.exec(`
    begin;
    set local kapiloto.identity_operator = 'on';
    update public.provider_competition_mappings set mapping_status = 'confirmed' where provider_competition_id = '372';
    rollback;
  `);
  assert.equal((await competitionRow(db, "sportmonks", "372")).mapping_status, "manual_override");

  // The test helper uses the same mechanism.
  await asIdentityOperator(db, "update public.provider_competition_mappings set competition_id = $1 where provider_competition_id = '372'", [C2]);
  assert.deepEqual(await competitionRow(db, "sportmonks", "372"), { competition_id: C2, mapping_status: "manual_override" });
  await db.close();
});

test("deletes and foreign-key cascades still remove guarded rows", async () => {
  const db = await world();
  await db.query(
    `insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_status, mapping_confidence)
     values ('sportmonks', '14', $1, 'confirmed', 1), ('sportmonks', '52', $2, 'manual_override', 1)`,
    [T1, T2],
  );
  await db.query(
    "insert into public.provider_competition_mappings (provider, provider_competition_id, competition_id, mapping_status) values ('sportmonks', '82', $1, 'manual_override')",
    [C2],
  );
  await db.query(
    "insert into public.provider_fixture_mappings (fixture_id, provider, provider_fixture_id, mapping_status, mapping_confidence) values ($1, 'sportmonks', '19000002', 'confirmed', 1)",
    [F2],
  );
  await asServiceRole(db, async () => {
    const direct = await db.query("delete from public.provider_team_mappings where provider = 'sportmonks' and provider_team_id = '14'");
    assert.equal(direct.affectedRows, 1);
  });
  await db.query("delete from public.fixtures where id = $1", [F2]);
  await db.query("delete from public.fixtures where id = $1", [F1]);
  await db.query("delete from public.teams where id = $1", [T2]);
  await db.query("delete from public.competitions where id = $1", [C2]);
  const left = await db.query<{ n: number }>(
    `select (select count(*) from public.provider_team_mappings where provider = 'sportmonks')
          + (select count(*) from public.provider_competition_mappings where provider = 'sportmonks')
          + (select count(*) from public.provider_fixture_mappings where provider = 'sportmonks') as n`,
  );
  assert.equal(Number(left.rows[0].n), 0);
  await db.close();
});

test("historical ingest is paused: service_role cannot execute the ingest RPC", async () => {
  const db = await world();
  const privileges = await db.query<{ service_role: boolean; anon: boolean; authenticated: boolean }>(
    `select has_function_privilege('service_role', 'public.match_ledger_ingest_provider_fixture(jsonb)'::regprocedure, 'execute') as service_role,
            has_function_privilege('anon', 'public.match_ledger_ingest_provider_fixture(jsonb)'::regprocedure, 'execute') as anon,
            has_function_privilege('authenticated', 'public.match_ledger_ingest_provider_fixture(jsonb)'::regprocedure, 'execute') as authenticated`,
  );
  assert.deepEqual(privileges.rows[0], { service_role: false, anon: false, authenticated: false });
  await asServiceRole(db, async () => {
    await assert.rejects(db.query("select public.match_ledger_ingest_provider_fixture('{}'::jsonb)"), /permission denied/);
    // The failure audit stays available to the operator tooling.
    const failure = await db.query<{ ok: boolean }>(
      "select has_function_privilege('service_role', 'public.provider_ingest_record_failure(uuid, text, text, text, jsonb)'::regprocedure, 'execute') as ok",
    );
    assert.equal(failure.rows[0].ok, true);
  });
  await db.close();
});

test("the guard is three row-level BEFORE UPDATE triggers scoped to Sportmonks and manual_override rows", async () => {
  const db = await world();
  const triggers = await db.query<{ table_name: string; tgname: string; tgtype: number; definition: string }>(
    `select c.relname as table_name, t.tgname, t.tgtype, pg_get_triggerdef(t.oid) as definition
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_proc p on p.oid = t.tgfoid
     where not t.tgisinternal and p.proname = 'guard_v3_identity_mapping_update'
     order by c.relname`,
  );
  assert.deepEqual(triggers.rows.map((r) => [r.table_name, r.tgname]), [
    ["provider_competition_mappings", "provider_competition_mappings_identity_guard"],
    ["provider_fixture_mappings", "provider_fixture_mappings_identity_guard"],
    ["provider_team_mappings", "provider_team_mappings_identity_guard"],
  ]);
  // tgtype bits: ROW = 1, BEFORE = 2, INSERT = 4, DELETE = 8, UPDATE = 16, TRUNCATE = 32.
  assert.ok(triggers.rows.every((r) => r.tgtype === (1 | 2 | 16)), JSON.stringify(triggers.rows.map((r) => r.tgtype)));
  assert.ok(
    triggers.rows.every((r) => r.definition.includes("WHEN (((old.provider = 'sportmonks'::text) OR (old.mapping_status = 'manual_override'::text)))")),
    triggers.rows.map((r) => r.definition).join("\n"),
  );
  const fn = await db.query<{ definer: boolean; anon: boolean; authenticated: boolean }>(
    `select p.prosecdef as definer,
            has_function_privilege('anon', p.oid, 'execute') as anon,
            has_function_privilege('authenticated', p.oid, 'execute') as authenticated
     from pg_proc p where p.oid = 'private.guard_v3_identity_mapping_update()'::regprocedure`,
  );
  assert.deepEqual(fn.rows[0], { definer: false, anon: false, authenticated: false });
  await db.close();
});
