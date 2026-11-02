import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { buildProviderMatchObservationPayload } from "./provider-ingest";
import { attestedWorld, ingestV2 } from "./test-support/attestation-fixtures";
import { createLedgerDatabase, setClock } from "./test-support/ledger-fixtures";
import { advisoryLockModes } from "./test-support/lock-inspection";
import { recoveryDataDigest, runRunbookSql, runbookSql } from "./test-support/recovery-runbook";

/**
 * M2C, the emergency pause (runbook §A): the reviewed body is revoke-only,
 * pauses a simulated M2B grant without touching data, and the separate
 * read-only verification passes only when no application path can still
 * execute a provider ingest RPC. PGlite runs one backend: the in-flight case
 * is shown as an open transaction that already executed a call when the
 * revoke lands (it completes and commits; every later call is refused,
 * including a statement prepared before the revoke). True multi-backend
 * interleaving rests on PostgreSQL checking EXECUTE once per call, at
 * executor start.
 */

const KICKOFF = "2026-08-15T18:00:00.000Z";
const CAPTURED = "2026-10-30T08:59:00.000Z";
const SEEN = "2026-10-30T09:00:00.000Z";
const V2 = "public.match_ledger_ingest_provider_fixture_v2(jsonb)";
const V1 = "public.match_ledger_ingest_provider_fixture(jsonb)";
const SIMULATED_M2B = `grant execute on function ${V2} to service_role`;

async function asRole<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

async function executable(db: PGlite, role: string, fn: string): Promise<boolean> {
  return (await db.query<{ ok: boolean }>("select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).rows[0].ok;
}

const verifyM2c = (db: PGlite) => runRunbookSql(db, "m2cVerify");

test("the reviewed M2C body is revoke-only and pauses a simulated M2B grant without mutating any data", async () => {
  const body = runbookSql("m2cRevoke");
  const statements = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  assert.equal(
    statements,
    `revoke execute on function ${V2} from public, anon, authenticated, service_role; ` +
      `revoke execute on function ${V1} from public, anon, authenticated, service_role;`,
  );
  assert.doesNotMatch(statements, /\b(grant|insert|update|delete|truncate|alter|drop|create|set|do|begin|commit|select)\b/);

  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true });
  const w = await attestedWorld(db, { kickoffAt: KICKOFF, capturedAt: CAPTURED });
  await db.exec(SIMULATED_M2B);
  const ingested = await asRole(db, "service_role", () => ingestV2(db, w.observation(), SEEN));
  assert.equal(ingested.status, "recorded");

  // Before M2C the verification fails and names the open path.
  await assert.rejects(verifyM2c(db), /M2C verification FAILED.*EXECUTE granted to service_role.*executable by non-operator role service_role/);

  const before = await recoveryDataDigest(db);
  await db.exec(body);
  assert.deepEqual(await recoveryDataDigest(db), before);

  for (const role of ["service_role", "anon", "authenticated"]) {
    assert.equal(await executable(db, role, V2), false, `${role} V2`);
    assert.equal(await executable(db, role, V1), false, `${role} V1`);
  }
  assert.ok((await verifyM2c(db)).some((notice) => notice.includes("M2C verification PASSED")));
  await assert.rejects(asRole(db, "service_role", () => ingestV2(db, w.observation(), "2026-10-30T09:30:00.000Z")), /permission denied/);

  // Recovery keeps everything it needs: identity RPCs, reports and V2 reads.
  for (const fn of [
    "public.provider_identity_revoke_team(jsonb)",
    "public.provider_identity_attest_team(jsonb)",
    "public.provider_identity_revoke_competition(jsonb)",
    "public.provider_identity_attest_competition(jsonb)",
    "public.provider_identity_revocation_impact(text, text, text)",
    "public.provider_identity_attestation_conflicts(text)",
    "public.match_ledger_provider_ref_conflicts_v2(text)",
    "public.match_ledger_observation_as_of_v2(uuid, text, timestamptz)",
    "public.match_ledger_record_observation(jsonb)",
  ]) {
    assert.equal(await executable(db, "service_role", fn), true, fn);
  }

  // Re-running the body is a no-op.
  await db.exec(body);
  assert.deepEqual(await recoveryDataDigest(db), before);
  assert.ok((await verifyM2c(db)).some((notice) => notice.includes("M2C verification PASSED")));
  await db.close();
});

test("the M2C verification fails on every other path that could still execute ingest, and the body closes them", async () => {
  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true });
  await db.exec(runbookSql("m2cRevoke"));
  await verifyM2c(db);

  const openPaths: Array<[string, string, RegExp]> = [
    [`grant execute on function ${V2} to authenticated`, `revoke execute on function ${V2} from authenticated`, /EXECUTE granted to authenticated.*executable by non-operator role authenticated/],
    [`grant execute on function ${V2} to public`, `revoke execute on function ${V2} from public`, /match_ledger_ingest_provider_fixture_v2\(jsonb\): EXECUTE granted to PUBLIC/],
    [`grant execute on function ${V1} to service_role`, `revoke execute on function ${V1} from service_role`, /match_ledger_ingest_provider_fixture\(jsonb\): EXECUTE granted to service_role/],
    // Any other role is caught, not only the known application roles.
    [
      `create role synthetic_ingest_worker; grant execute on function ${V2} to synthetic_ingest_worker`,
      `revoke execute on function ${V2} from synthetic_ingest_worker; drop role synthetic_ingest_worker`,
      /EXECUTE granted to synthetic_ingest_worker/,
    ],
    [
      `create role synthetic_ingest_parent; create role synthetic_ingest_member; grant execute on function ${V2} to synthetic_ingest_parent; grant synthetic_ingest_parent to synthetic_ingest_member`,
      `revoke synthetic_ingest_parent from synthetic_ingest_member; revoke execute on function ${V2} from synthetic_ingest_parent; drop role synthetic_ingest_member; drop role synthetic_ingest_parent`,
      /executable by non-operator role synthetic_ingest_member/,
    ],
    [
      `create role synthetic_ingest_owner; alter function ${V2} owner to synthetic_ingest_owner`,
      `alter function ${V2} owner to postgres; drop role synthetic_ingest_owner`,
      /owned by non-operator role synthetic_ingest_owner/,
    ],
    [
      "create function public.synthetic_ingest_wrapper(p jsonb) returns jsonb language sql security definer set search_path = '' as $$ select public.match_ledger_ingest_provider_fixture_v2(p) $$",
      "drop function public.synthetic_ingest_wrapper(jsonb)",
      /SECURITY DEFINER function synthetic_ingest_wrapper\(jsonb\) references a provider ingest RPC/,
    ],
    [
      // The harness stubs cron.job without pg_cron's command column; add it.
      "alter table cron.job add column command text; insert into cron.job (jobid, jobname, command) values (1, 'synthetic', 'select public.match_ledger_ingest_provider_fixture_v2(''{}''::jsonb)')",
      "delete from cron.job where jobid = 1",
      /1 pg_cron job\(s\) call a provider ingest RPC/,
    ],
  ];
  for (const [open, close, failure] of openPaths) {
    await db.exec(open);
    await assert.rejects(verifyM2c(db), failure, open);
    await db.exec(close);
    await verifyM2c(db);
  }

  // The Supabase operator roles may hold EXECUTE through default privileges
  // when another role owns the function; they are not an application path.
  await db.exec(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then create role supabase_admin; end if; end $$`);
  await db.exec(`grant execute on function ${V2} to supabase_admin`);
  assert.ok((await verifyM2c(db)).some((notice) => notice.includes("M2C verification PASSED")));
  await db.exec(`revoke execute on function ${V2} from supabase_admin`);

  // Accidental grants on both RPCs and to several roles: one body execution closes them all.
  await db.exec(`grant execute on function ${V2} to public, authenticated, service_role; grant execute on function ${V1} to service_role`);
  await assert.rejects(verifyM2c(db), /M2C verification FAILED/);
  await db.exec(runbookSql("m2cRevoke"));
  assert.ok((await verifyM2c(db)).some((notice) => notice.includes("M2C verification PASSED")));
  await db.close();
});

test("an ingest call that already executed when M2C lands completes and commits; every later call is refused", async () => {
  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true });
  const w = await attestedWorld(db, { kickoffAt: KICKOFF, capturedAt: CAPTURED });
  await db.exec(SIMULATED_M2B);
  const payload = JSON.stringify(buildProviderMatchObservationPayload(w.observation()));
  await asRole(db, "service_role", () => db.exec("prepare synthetic_ingest_v2(jsonb) as select public.match_ledger_ingest_provider_fixture_v2($1) as r"));
  await setClock(db, SEEN);

  await db.exec("begin");
  await db.exec("set role service_role");
  const inFlight = (await db.query<{ r: { status: string; observation_id: string } }>(
    "select public.match_ledger_ingest_provider_fixture_v2($1::jsonb) as r",
    [payload],
  )).rows[0].r;
  assert.equal(inFlight.status, "recorded");
  // The in-flight ingest holds the provider identity lock SHARED until commit:
  // an attestation revoke (EXCLUSIVE) waits for it, so the revoke is the
  // barrier after which no ingest under the old generation can still write.
  assert.deepEqual(await advisoryLockModes(db, "kapiloto_v4_provider_identity:sportmonks"), ["ShareLock"]);
  await db.exec("reset role");
  await db.exec(runbookSql("m2cRevoke"));
  await db.exec("savepoint drain_check");
  await assert.rejects(
    db.exec(runbookSql("m2cVerify")),
    /still holds the Sportmonks provider-identity ShareLock/,
    "the drain check must use the ingest advisory lock, not only query text",
  );
  await db.exec("rollback to savepoint drain_check");
  await db.exec("set role service_role");
  await db.exec("savepoint after_m2c");
  await assert.rejects(db.query("select public.match_ledger_ingest_provider_fixture_v2($1::jsonb)", [payload]), /permission denied/);
  await db.exec("rollback to savepoint after_m2c");
  await db.exec("reset role");
  await db.exec("commit");

  assert.deepEqual(await advisoryLockModes(db, "kapiloto_v4_provider_identity:sportmonks"), []);
  const committed = await db.query("select 1 from public.match_ledger_observations where id = $1", [inFlight.observation_id]);
  assert.equal(committed.rows.length, 1, "the call that passed its EXECUTE check before M2C committed");
  assert.equal(await executable(db, "service_role", V2), false);
  // A statement prepared before M2C is checked again when it executes.
  await assert.rejects(
    asRole(db, "service_role", () => db.exec(`execute synthetic_ingest_v2('${payload.replace(/'/g, "''")}'::jsonb)`)),
    /permission denied/,
  );
  await verifyM2c(db);
  await db.close();
});
