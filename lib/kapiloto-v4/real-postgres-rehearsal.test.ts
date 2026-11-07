import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { createLedgerDatabase } from "./test-support/ledger-fixtures";
import { recoveryDataDigest, runbookSql } from "./test-support/recovery-runbook";
import {
  EXPERIMENTS,
  HARNESS_ID,
  LOCK_SNAPSHOT_SQL,
  REHEARSED_FUNCTIONS,
  RehearsalRefusal,
  SIMULATED_M2B_GRANT,
  SYNTHETIC_NAME_PREFIX,
  Session,
  TLS_NO_VERIFY_ACK,
  assertEvidenceRedacted,
  createRehearsalWorld,
  expectedFunctionSource,
  loadReviewedM2cSql,
  redactEvidence,
  resolveRehearsalTarget,
  runRealPostgresRehearsal,
  runRealPostgresRehearsalCli,
  type Connector,
  type RawConnection,
  type RehearsalTarget,
} from "./test-support/real-postgres-rehearsal";

/**
 * The real-PostgreSQL rehearsal harness, offline. PGlite runs one backend, so
 * these tests cannot (and do not claim to) reproduce the multi-backend
 * interleavings; they pin the refusal guards, the redaction, the reviewed SQL
 * source of truth, the synthetic world and payloads against the real
 * migration chain, and that a single-backend database fails closed and is
 * always returned to the paused M2C state.
 */

const REF = "abcdefghijklmnopqrst";
const OTHER_REF = "zyxwvutsrqponmlkjihg";
const PASSWORD = "synthetic-disposable-password-0001";
const DIRECT = `postgres://postgres:${PASSWORD}@db.${REF}.supabase.co:5432/postgres`;
const POOLER = `postgres://postgres.${REF}:${PASSWORD}@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`;
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const V2 = "public.match_ledger_ingest_provider_fixture_v2(jsonb)";

const exists = () => true;
const baseEnv = (url = DIRECT): Record<string, string> => ({
  KAPILOTO_REHEARSAL_DATABASE_URL: url,
  KAPILOTO_REHEARSAL_PROJECT_REF: REF,
  KAPILOTO_REHEARSAL_PG_CA_FILE: "synthetic-ca.crt",
});

function refusal(env: Record<string, string | undefined>, options: Parameters<typeof resolveRehearsalTarget>[1] = { fileExists: exists }): RehearsalRefusal {
  try {
    resolveRehearsalTarget(env, options);
  } catch (error) {
    assert.ok(error instanceof RehearsalRefusal, String(error));
    // A refusal never echoes a secret.
    for (const secret of [PASSWORD, DIRECT, POOLER]) assert.ok(!error.message.includes(secret), error.message);
    return error;
  }
  assert.fail("expected a refusal");
}

test("the target guard accepts only a declared disposable Supabase project (direct or session pooler) or a loopback database", () => {
  const direct = resolveRehearsalTarget(baseEnv(), { fileExists: exists });
  assert.equal(direct.kind, "supabase-direct");
  assert.deepEqual(direct.tls, { mode: "verify-full", caFile: "synthetic-ca.crt" });
  assert.equal(direct.projectRefSha256, createHash("sha256").update(REF).digest("hex"));
  for (const secret of [DIRECT, PASSWORD, REF, `db.${REF}.supabase.co`]) assert.ok(direct.secrets.includes(secret), secret);

  const pooler = resolveRehearsalTarget(baseEnv(POOLER), { fileExists: exists });
  assert.equal(pooler.kind, "supabase-session-pooler");
  assert.equal(pooler.user, `postgres.${REF}`);

  const noVerify = resolveRehearsalTarget(
    { ...baseEnv(), KAPILOTO_REHEARSAL_PG_CA_FILE: undefined, KAPILOTO_REHEARSAL_TLS_NO_VERIFY: TLS_NO_VERIFY_ACK },
    { fileExists: exists },
  );
  assert.deepEqual(noVerify.tls, { mode: "no-verify" });

  const local = resolveRehearsalTarget({
    KAPILOTO_REHEARSAL_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:54322/postgres",
    KAPILOTO_REHEARSAL_PROJECT_REF: "local",
  });
  assert.equal(local.kind, "loopback");
  assert.deepEqual(local.tls, { mode: "disabled" });
});

test("the target guard refuses CI, secrets in the environment, PG* defaults, foreign hosts, the transaction pooler and the linked project", () => {
  const cases: Array<[string, Record<string, string | undefined>, Parameters<typeof resolveRehearsalTarget>[1]?]> = [
    ["missing_database_url", { KAPILOTO_REHEARSAL_PROJECT_REF: REF }],
    ["missing_project_ref", { KAPILOTO_REHEARSAL_DATABASE_URL: DIRECT }],
    ["ci_runner", { ...baseEnv(), CI: "true" }],
    ["ci_runner", { ...baseEnv(), GITHUB_ACTIONS: "true" }],
    ["pg_env_defaults", { ...baseEnv(), PGPASSWORD: "x" }],
    ["pg_env_defaults", { ...baseEnv(), PGHOST: "db.example.com" }],
    ["secret_in_environment", { ...baseEnv(), SUPABASE_SERVICE_ROLE_KEY: "synthetic" }],
    ["secret_in_environment", { ...baseEnv(), SPORTMONKS_API_TOKEN: "synthetic" }],
    ["secret_in_environment", { ...baseEnv(), OPENAI_API_KEY: "synthetic" }],
    ["secret_in_environment", { ...baseEnv(), SUPABASE_ACCESS_TOKEN: "synthetic" }],
    ["dsn_reused", { ...baseEnv(), DATABASE_URL: DIRECT }],
    ["dsn_invalid", { ...baseEnv("https://example.com"), KAPILOTO_REHEARSAL_PROJECT_REF: REF }],
    ["dsn_parameters", baseEnv(`${DIRECT}?sslmode=disable`)],
    ["dsn_credentials", baseEnv(`postgres://postgres@db.${REF}.supabase.co:5432/postgres`)],
    ["dsn_credentials", baseEnv(`postgres://postgres:short@db.${REF}.supabase.co:5432/postgres`)],
    ["port_not_session", baseEnv(`postgres://postgres.${REF}:${PASSWORD}@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`)],
    ["host_not_declared_project", baseEnv(`postgres://postgres:${PASSWORD}@db.${OTHER_REF}.supabase.co:5432/postgres`)],
    ["host_not_declared_project", baseEnv(`postgres://postgres:${PASSWORD}@db.example.com:5432/postgres`)],
    ["dsn_user", baseEnv(`postgres://postgres.${OTHER_REF}:${PASSWORD}@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`)],
    ["dsn_user", baseEnv(`postgres://authenticator:${PASSWORD}@db.${REF}.supabase.co:5432/postgres`)],
    ["dsn_database", baseEnv(`postgres://postgres:${PASSWORD}@db.${REF}.supabase.co:5432/other`)],
    ["project_ref_invalid", { ...baseEnv(), KAPILOTO_REHEARSAL_PROJECT_REF: "Not-A-Ref" }],
    ["loopback_ref", { KAPILOTO_REHEARSAL_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/postgres", KAPILOTO_REHEARSAL_PROJECT_REF: REF }],
    ["linked_project", baseEnv(), { fileExists: exists, linkedProjectRef: REF }],
    ["app_project", { ...baseEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` }],
    ["tls_unverified", { ...baseEnv(), KAPILOTO_REHEARSAL_PG_CA_FILE: undefined }],
    ["tls_unverified", { ...baseEnv(), KAPILOTO_REHEARSAL_PG_CA_FILE: undefined, KAPILOTO_REHEARSAL_TLS_NO_VERIFY: "yes" }],
    ["ca_file_missing", baseEnv(), { fileExists: () => false }],
  ];
  for (const [reason, env, options] of cases) {
    assert.equal(refusal(env, options ?? { fileExists: exists }).reason, reason, `${reason}: ${JSON.stringify(Object.keys(env))}`);
  }
});

test("evidence redaction removes every connection secret and the emit check refuses leftovers", () => {
  const target = resolveRehearsalTarget(baseEnv(POOLER), { fileExists: exists });
  const evidence = { error: `connect ECONNREFUSED ${POOLER} as postgres.${REF} (${PASSWORD})`, nested: [{ host: target.host }] };
  const redacted = redactEvidence(evidence, target.secrets);
  const serialized = JSON.stringify(redacted);
  for (const secret of target.secrets) assert.ok(!serialized.includes(secret), secret);
  assert.doesNotThrow(() => assertEvidenceRedacted(serialized, target.secrets));
  assert.throws(() => assertEvidenceRedacted(JSON.stringify(evidence), target.secrets), /still contains a connection secret/);
});

test("the harness executes the reviewed M2C files verbatim and its only privilege change is the simulated M2B grant", () => {
  const sql = loadReviewedM2cSql(process.cwd());
  assert.equal(sql.m2cRevoke, runbookSql("m2cRevoke"));
  assert.equal(sql.m2cVerify, runbookSql("m2cVerify"));
  assert.equal(SIMULATED_M2B_GRANT, `grant execute on function ${V2} to service_role`);
  assert.deepEqual(EXPERIMENTS.map((experiment) => experiment.id), ["P0", "A2", "A4", "B1", "B2", "B3"]);
});

test("the function-identity guard reads each rehearsed function's last definition from the migration chain", async () => {
  const production = await createLedgerDatabase({ testClock: false, supabaseDefaultPrivileges: true });
  const normalize = (text: string) => text.replace(/\r\n/g, "\n");
  for (const fn of REHEARSED_FUNCTIONS) {
    const expected = expectedFunctionSource(MIGRATIONS, fn.schema, fn.name);
    assert.ok(expected, fn.signature);
    const row = (await production.query<{ prosrc: string }>("select prosrc from pg_proc where oid = to_regprocedure($1)", [fn.signature])).rows[0];
    assert.equal(normalize(row.prosrc), normalize(expected), fn.signature);
  }
  await production.close();
});

/** RawConnection over ONE PGlite instance (single backend; optional fake pids per connection). */
function pgliteConnector(db: PGlite, options: { fakePids?: boolean } = {}): Connector {
  let next = 900_000;
  return async () => {
    const notices: string[] = [];
    const pid = (next += 1);
    const raw: RawConnection = {
      async query(sql, params = []) {
        if (options.fakePids && sql === "select pg_catalog.pg_backend_pid() as pid") return [{ pid }];
        if (params.length > 0) return (await db.query<Record<string, unknown>>(sql, params)).rows;
        const results = await db.exec(sql, { onNotice: (notice) => notices.push(notice.message ?? "") });
        return (results[results.length - 1]?.rows ?? []) as Array<Record<string, unknown>>;
      },
      takeNotices: () => notices.splice(0),
      close: async () => undefined,
    };
    return raw;
  };
}

const SYNTHETIC_TARGET: Pick<RehearsalTarget, "kind" | "projectRefSha256" | "tls" | "secrets"> = {
  kind: "loopback",
  projectRefSha256: "0".repeat(64),
  tls: { mode: "disabled" },
  secrets: [PASSWORD],
};

const FAST = { doublePassGapMs: 1, handshakeMs: 50, pollMs: 1 };

async function executable(db: PGlite, role: string, fn: string): Promise<boolean> {
  return (await db.query<{ ok: boolean }>("select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).rows[0].ok;
}

test("check-only: a migrated, empty, paused database passes every read-only guard and nothing is written", async () => {
  const db = await createLedgerDatabase({ testClock: false, supabaseDefaultPrivileges: true });
  const before = await recoveryDataDigest(db);
  const evidence = await runRealPostgresRehearsal({ target: SYNTHETIC_TARGET, connect: pgliteConnector(db), checkOnly: true, timeouts: FAST });
  assert.equal(evidence.outcome, "checked", JSON.stringify(evidence.guards.filter((guard) => !guard.passed)));
  assert.ok(evidence.guards.length > 10);
  assert.ok(evidence.function_identity.every((fn) => fn.matches_checkout));
  assert.equal(evidence.cleanup.ran, false);
  assert.deepEqual(Object.keys(evidence.sql_sources).sort(), ["kapiloto-v4-m2c-revoke-body.sql", "kapiloto-v4-m2c-verify.sql"]);
  assert.deepEqual(await recoveryDataDigest(db), before);
  await db.close();
});

test("check-only refuses a database that holds production-shaped data, an open grant or test-only function bodies", async () => {
  const refusedOn = async (prepare: (db: PGlite) => Promise<void>, options: { testClock?: boolean } = {}) => {
    const db = await createLedgerDatabase({ testClock: options.testClock ?? false, supabaseDefaultPrivileges: true });
    await prepare(db);
    const before = await recoveryDataDigest(db);
    const evidence = await runRealPostgresRehearsal({ target: SYNTHETIC_TARGET, connect: pgliteConnector(db), checkOnly: true, timeouts: FAST });
    assert.equal(evidence.outcome, "refused");
    assert.equal(evidence.cleanup.ran, false, "a refused run never writes, so it never needs cleanup");
    assert.deepEqual(await recoveryDataDigest(db), before);
    const failed = evidence.guards.filter((guard) => !guard.passed).map((guard) => guard.name);
    await db.close();
    return failed;
  };

  assert.ok((await refusedOn((db) => db.query("insert into auth.users (id, email) values (gen_random_uuid(), 'user@example.com')").then(() => undefined))).includes("disposable database: auth_users = 0"));
  assert.ok(
    (await refusedOn((db) => db.query("insert into public.rounds (id, external_round_number, lock_at, source, status) values (gen_random_uuid(), '990001', now(), 'test', 'open')").then(() => undefined))).includes(
      "disposable database: rounds = 0",
    ),
  );
  assert.ok((await refusedOn((db) => db.query("insert into public.teams (canonical_name, country_code) values ('Real Team', 'IL')").then(() => undefined))).includes("disposable database: non_rehearsal_teams = 0"));
  const grantOpen = await refusedOn((db) => db.exec(SIMULATED_M2B_GRANT).then(() => undefined));
  assert.ok(grantOpen.includes("ingest is paused at start: service_role can execute neither V2 nor V1"));
  assert.ok(grantOpen.includes("the reviewed M2C verification PASSES at start"));
  // The PGlite test clock is not the production information clock.
  assert.ok((await refusedOn(async () => undefined, { testClock: true })).includes("private.kapiloto_information_clock() is this checkout's migration text"));
});

test("the synthetic rehearsal world records through V2's existing-mapping path and keeps the database rehearsal-only", async () => {
  const db = await createLedgerDatabase({ testClock: false, supabaseDefaultPrivileges: true });
  const raw = await pgliteConnector(db)("kapiloto-m2b-rehearsal:test:O");
  const o = new Session("O", 0, "kapiloto-m2b-rehearsal:test:O", raw);
  const world = await createRehearsalWorld(o, "123456", 1, "T1");
  assert.match(world.pairKey, /^kapiloto_canonical_fixture_pair:[0-9a-f-]{36}:[0-9a-f-]{36}$/);
  assert.equal(world.providerFixtureId, "2012345613");

  await db.exec(SIMULATED_M2B_GRANT);
  await db.exec("set role service_role");
  const result = (await db.query<{ result: Record<string, unknown> }>("select public.match_ledger_ingest_provider_fixture_v2($1::jsonb) as result", [JSON.stringify(world.payload)])).rows[0].result;
  await db.exec("reset role");
  assert.equal(result.status, "recorded", JSON.stringify(result));
  assert.equal(result.fixture_resolution, "existing_mapping");
  assert.equal(result.fixture_id, world.fixtureId);
  assert.deepEqual(result.attestation_generations, world.generations);

  // The lock snapshot sees this session's xact advisory locks under their labels.
  await db.exec("begin");
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [world.pairKey]);
  const snapshot = (await db.query<{ label: string; mode: string; granted: boolean }>(LOCK_SNAPSHOT_SQL, [["pair", "identity"], [world.pairKey, "kapiloto_v4_provider_identity:sportmonks"]])).rows;
  await db.exec("rollback");
  assert.deepEqual(snapshot.map((row) => [row.label, row.mode, row.granted]), [["pair", "ExclusiveLock", true]]);

  // A later check-only run still passes: every row the harness wrote is marked as rehearsal data.
  await db.exec(runbookSql("m2cRevoke"));
  const names = (await db.query<{ canonical_name: string }>("select canonical_name from public.teams")).rows.map((row) => row.canonical_name);
  assert.ok(names.every((name) => name.startsWith(SYNTHETIC_NAME_PREFIX)), names.join());
  const run = (await db.query<{ scope: Record<string, unknown> }>("select scope from public.provider_ingest_runs")).rows[0].scope;
  assert.equal(run.kapiloto_rehearsal, HARNESS_ID);
  const evidence = await runRealPostgresRehearsal({ target: SYNTHETIC_TARGET, connect: pgliteConnector(db), checkOnly: true, timeouts: FAST });
  assert.equal(evidence.outcome, "checked", JSON.stringify(evidence.guards.filter((guard) => !guard.passed)));
  await db.close();
});

test("a single-backend database fails closed before any interleaving, and the run still ends paused by the reviewed M2C body", async () => {
  const db = await createLedgerDatabase({ testClock: false, supabaseDefaultPrivileges: true });
  const evidence = await runRealPostgresRehearsal({ target: SYNTHETIC_TARGET, connect: pgliteConnector(db, { fakePids: true }), timeouts: FAST });
  assert.equal(evidence.outcome, "fail");
  const [preflight, ...rest] = evidence.experiments;
  assert.equal(preflight.id, "P0");
  assert.equal(preflight.outcome, "fail");
  assert.equal(rest.length, 0, "no later experiment runs after a failure");
  assert.match(preflight.error?.message ?? "", /pg_stat_activity shows each session pid with its own application_name/);
  // The simulated grant was opened, and cleanup took it back with the reviewed body.
  assert.ok(preflight.assertions.some((assertion) => assertion.name.startsWith("simulated M2B grant") && assertion.passed));
  assert.equal(evidence.cleanup.ran, true);
  assert.equal(evidence.cleanup.m2c_body_executed, true);
  assert.deepEqual(evidence.cleanup.final_privileges, { v2_service_role: false, v1_service_role: false });
  assert.deepEqual(evidence.cleanup.verify_runs.map((run) => run.passed), [true, true]);
  assert.equal(evidence.cleanup.error, undefined);
  assert.equal(await executable(db, "service_role", V2), false);
  assert.ok(!JSON.stringify(evidence).includes(PASSWORD));
  await db.close();
});

test("the CLI refuses before connecting, prints only redacted JSON, and validates its arguments", async () => {
  const out: string[] = [];
  const err: string[] = [];
  let connected = false;
  const io = {
    connectorFor: () => {
      connected = true;
      return pgliteConnector(undefined as unknown as PGlite);
    },
    cwd: process.cwd(),
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    writeFile: () => assert.fail("a refused run writes no file"),
  };
  assert.equal(await runRealPostgresRehearsalCli([], { ...baseEnv(), SPORTMONKS_API_TOKEN: "synthetic" }, io), 2);
  assert.equal(connected, false);
  const printed = JSON.parse(out.join(""));
  assert.equal(printed.outcome, "refused");
  assert.equal(printed.refusal.reason, "secret_in_environment");
  for (const text of [...out, ...err]) assert.ok(!text.includes(PASSWORD) && !text.includes(REF), text);

  assert.equal(await runRealPostgresRehearsalCli(["--unknown"], baseEnv(), io), 2);
  assert.equal(await runRealPostgresRehearsalCli(["--out", "../outside.json"], baseEnv(), io), 2);
  assert.equal(connected, false);
});
