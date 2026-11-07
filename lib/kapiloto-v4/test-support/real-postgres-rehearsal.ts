import { createHash, randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { buildProviderMatchObservationPayload, type ProviderIngestResult } from "../provider-ingest";
import { competitionAttestation, teamAttestation } from "./attestation-fixtures";
import { observationFrom, syntheticCapture } from "./provider-ingest-fixtures";
import { RUNBOOK_SQL } from "./recovery-runbook";

/**
 * REAL-PostgreSQL two-session rehearsal of the M2B/M2C concurrency semantics
 * (D-058 / D-061), for a DISPOSABLE database only. Operator entry point:
 * tools/kapiloto-v4-m2b-real-postgres-rehearsal.ts.
 *
 * PGlite runs one backend, so it cannot show one session waiting for
 * another. This harness opens genuinely separate PostgreSQL backends (one
 * client connection each, direct or Supabase session pooler) and reproduces:
 *
 *   A2  M2C revokes EXECUTE while a V2 call is already inside the function;
 *   A4  the M2C verification FAILS on a V2 call that passed EXECUTE and is
 *       waiting for the provider-identity ShareLock (M-1);
 *   B1  an identity revoke queued behind an in-flight ingest fails cleanly
 *       with 55P03 (V2/revoke function lock_timeout 5s) and can be retried;
 *   B2  a queued identity revoke completes after the ingest commits, and the
 *       impact report / V2 read see the revoked generation;
 *   B3  an ingest queued behind an identity revoke fails closed
 *       (team_attestation_missing) once the revoke commits.
 *
 * Correctness rests on OBSERVED lock state (pg_locks, pg_blocking_pids,
 * pg_stat_activity): each competing statement starts only after the observer
 * saw the expected holder/waiter. Polling sleeps only pace those reads.
 *
 * Safety (fail closed, in this order):
 *   - resolveRehearsalTarget refuses anything but an explicitly declared
 *     disposable Supabase project / loopback database, a CI runner, a shell
 *     holding provider or service secrets, and PG* environment defaults;
 *   - before ANY write the database must be a migrated but otherwise empty
 *     Kapiloto schema: no auth user, no round, no team / competition /
 *     ingest run / team attestation the harness did not create, ingest paused
 *     (the M2C verification PASSES), no M2B migration in the history, and the
 *     functions under test byte-identical to this checkout's migration chain.
 *     Production can never pass these checks;
 *   - the only privilege change is the simulated M2B grant
 *     (SIMULATED_M2B_GRANT); M2C is ALWAYS the reviewed body
 *     docs/operations/sql/kapiloto-v4-m2c-revoke-body.sql and the
 *     verification the reviewed docs/operations/sql/kapiloto-v4-m2c-verify.sql,
 *     executed verbatim; once any write happened the run always ends with
 *     that M2C body and a double verification PASS, whatever failed;
 *   - every session has statement, idle-in-transaction and lock timeouts,
 *     handshakes have deadlines, and the whole run has a deadline;
 *   - evidence is built from explicit fields and redacted: no DSN, password,
 *     host, project ref or key ever leaves the process.
 */

export const HARNESS_ID = "kapiloto-v4-m2b-real-postgres-rehearsal-v1";
export const SYNTHETIC_NAME_PREFIX = "KAPILOTO M2B REHEARSAL ";
export const APPLICATION_NAME_PREFIX = "kapiloto-m2b-rehearsal:";

const V2 = "public.match_ledger_ingest_provider_fixture_v2(jsonb)";
const V1 = "public.match_ledger_ingest_provider_fixture(jsonb)";

/**
 * The simulated M2B grant (the reviewed grant-only M2B statement), for the
 * DISPOSABLE database only. The harness's only privilege change; M2C (the
 * reviewed operator body) takes it back.
 */
export const SIMULATED_M2B_GRANT = "grant execute on function public.match_ledger_ingest_provider_fixture_v2(jsonb) to service_role";

/** Every rehearsal session: bounded statements, idle transactions and lock waits. */
export const SESSION_SETTINGS_SQL =
  "set statement_timeout = '20s'; set idle_in_transaction_session_timeout = '60s'; set lock_timeout = '10s'";
/** The M2C session waits at most 2s for any lock: a REVOKE that ever waits fails fast. */
const M2C_SESSION_LOCK_TIMEOUT_SQL = "set lock_timeout = '2s'";

export const IDENTITY_LOCK_KEY = "kapiloto_v4_provider_identity:sportmonks";
const HARNESS_MUTEX_KEY = "kapiloto_v4_m2b_real_postgres_rehearsal_harness";

export type RehearsalTimeouts = {
  /** Deadline for one observed lock-state handshake. */
  handshakeMs: number;
  /** Observer poll interval while waiting for a handshake. */
  pollMs: number;
  /** Deadline for the whole experiment sequence (cleanup runs after it). */
  deadlineMs: number;
  /** Gap between the two M2C verification PASSes (> V2's 5s lock_timeout). */
  doublePassGapMs: number;
};

export const DEFAULT_TIMEOUTS: RehearsalTimeouts = {
  handshakeMs: 3_000,
  pollMs: 20,
  deadlineMs: 300_000,
  doublePassGapMs: 6_500,
};

// ---------------------------------------------------------------------------
// Target resolution and environment refusal guards (no network, no database).
// ---------------------------------------------------------------------------

export const REHEARSAL_ENV = {
  databaseUrl: "KAPILOTO_REHEARSAL_DATABASE_URL",
  projectRef: "KAPILOTO_REHEARSAL_PROJECT_REF",
  caFile: "KAPILOTO_REHEARSAL_PG_CA_FILE",
  tlsNoVerify: "KAPILOTO_REHEARSAL_TLS_NO_VERIFY",
} as const;

/** The only accepted value of KAPILOTO_REHEARSAL_TLS_NO_VERIFY. */
export const TLS_NO_VERIFY_ACK = "disposable-only";

export type RehearsalTargetKind = "supabase-direct" | "supabase-session-pooler" | "loopback";

export type RehearsalTarget = {
  kind: RehearsalTargetKind;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  tls: { mode: "verify-full"; caFile: string } | { mode: "no-verify" } | { mode: "disabled" };
  /** sha256 of the declared project ref ("local" for loopback); the ref itself is never emitted. */
  projectRefSha256: string;
  /** Strings that must never appear in evidence or output. */
  secrets: string[];
};

export class RehearsalRefusal extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "RehearsalRefusal";
  }
}

const SUPABASE_REF = /^[a-z]{20}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PG_ENV_DEFAULTS = ["PGHOST", "PGHOSTADDR", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "PGSSLMODE", "PGOPTIONS", "PGAPPNAME"];
/** Any provider / service secret in the process environment refuses the run: the harness needs none. */
const SECRET_ENV_NAME = /(SERVICE_ROLE|SECRET|TOKEN|API_KEY|PASSWORD|ACCESS_KEY|PRIVATE_KEY)/i;

function refuse(reason: string, message: string): never {
  throw new RehearsalRefusal(reason, message);
}

/** Project ref of a Supabase API URL (https://<ref>.supabase.co), if any. */
function supabaseUrlRef(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^https?:\/\/([a-z]{20})\.supabase\.(co|in)\b/i.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Validates the operator's declared disposable target. Throws
 * RehearsalRefusal (never a secret in the message) unless every guard holds.
 */
export function resolveRehearsalTarget(
  env: Record<string, string | undefined>,
  options: { linkedProjectRef?: string | null; fileExists?: (path: string) => boolean } = {},
): RehearsalTarget {
  const fileExists = options.fileExists ?? existsSync;
  if (env.CI || env.GITHUB_ACTIONS) {
    refuse("ci_runner", "the real-PostgreSQL rehearsal is operator-run only and never runs in CI");
  }
  for (const name of PG_ENV_DEFAULTS) {
    if (env[name]) refuse("pg_env_defaults", `unset ${name}: the rehearsal connects only to the declared DSN`);
  }
  for (const [name, value] of Object.entries(env)) {
    if (!value || name.startsWith("KAPILOTO_REHEARSAL_") || name.startsWith("npm_")) continue;
    if (SECRET_ENV_NAME.test(name)) {
      refuse("secret_in_environment", `unset ${name}: run the rehearsal in a clean shell without provider or service secrets`);
    }
  }

  const dsn = env[REHEARSAL_ENV.databaseUrl];
  const declaredRef = env[REHEARSAL_ENV.projectRef]?.trim();
  if (!dsn) refuse("missing_database_url", `${REHEARSAL_ENV.databaseUrl} must hold the DISPOSABLE database DSN`);
  if (!declaredRef) refuse("missing_project_ref", `${REHEARSAL_ENV.projectRef} must name the DISPOSABLE Supabase project ref (or "local")`);
  for (const [name, value] of Object.entries(env)) {
    if (name !== REHEARSAL_ENV.databaseUrl && value && value.trim() === dsn.trim()) {
      refuse("dsn_reused", `the rehearsal DSN is also configured as ${name}; use a dedicated DSN for the disposable project only`);
    }
  }

  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    refuse("dsn_invalid", `${REHEARSAL_ENV.databaseUrl} is not a postgres:// URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    refuse("dsn_invalid", `${REHEARSAL_ENV.databaseUrl} is not a postgres:// URL`);
  }
  if (url.search || url.hash) {
    refuse("dsn_parameters", "the DSN must not carry query parameters; TLS is configured through KAPILOTO_REHEARSAL_PG_CA_FILE");
  }
  const host = url.hostname.toLowerCase();
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
  const port = url.port ? Number(url.port) : 5432;
  if (!user || !password) refuse("dsn_credentials", "the DSN must carry an explicit user and password for the disposable project");

  let kind: RehearsalTargetKind;
  if (LOOPBACK_HOSTS.has(host)) {
    if (declaredRef !== "local") refuse("loopback_ref", `a loopback database must be declared with ${REHEARSAL_ENV.projectRef}=local`);
    kind = "loopback";
  } else {
    if (!SUPABASE_REF.test(declaredRef)) refuse("project_ref_invalid", `${REHEARSAL_ENV.projectRef} is not a Supabase project ref`);
    if (port !== 5432) {
      refuse("port_not_session", "use the direct connection or the session pooler on port 5432; the transaction pooler (6543) cannot hold a rehearsal session");
    }
    if (host === `db.${declaredRef}.supabase.co`) {
      if (user !== "postgres") refuse("dsn_user", "a direct Supabase connection must use the postgres user");
      kind = "supabase-direct";
    } else if (/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)) {
      if (user !== `postgres.${declaredRef}`) refuse("dsn_user", "a session-pooler connection must use postgres.<declared project ref>");
      kind = "supabase-session-pooler";
    } else {
      refuse("host_not_declared_project", "the DSN host is neither the declared project's direct host nor a Supabase session pooler");
    }
    if (password.length < 12) refuse("dsn_credentials", "the disposable project's database password is implausibly short");
  }
  if (database !== "postgres") refuse("dsn_database", "the rehearsal runs only against the postgres database");

  const linked = options.linkedProjectRef?.trim();
  if (linked && linked === declaredRef) {
    refuse("linked_project", "the declared ref is this checkout's linked Supabase project (supabase/.temp/project-ref); the rehearsal never targets the linked project");
  }
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]) {
    if (supabaseUrlRef(env[name]) === declaredRef) {
      refuse("app_project", `${name} points the application at the declared project; that is not a disposable rehearsal target`);
    }
  }

  let tls: RehearsalTarget["tls"];
  if (kind === "loopback") {
    tls = { mode: "disabled" };
  } else if (env[REHEARSAL_ENV.caFile]) {
    const caFile = env[REHEARSAL_ENV.caFile] as string;
    if (!fileExists(caFile)) refuse("ca_file_missing", `${REHEARSAL_ENV.caFile} does not name a readable file`);
    tls = { mode: "verify-full", caFile };
  } else if (env[REHEARSAL_ENV.tlsNoVerify] === TLS_NO_VERIFY_ACK) {
    tls = { mode: "no-verify" };
  } else {
    refuse(
      "tls_unverified",
      `set ${REHEARSAL_ENV.caFile} to the project's CA certificate (or ${REHEARSAL_ENV.tlsNoVerify}=${TLS_NO_VERIFY_ACK} to accept an unverified TLS channel to the disposable project)`,
    );
  }

  const secrets = [dsn.trim(), password, declaredRef, host].filter((value) => value && value !== "local" && !LOOPBACK_HOSTS.has(value));
  if (kind === "supabase-session-pooler") secrets.push(user);
  return { kind, host, port, user, password, database, tls, projectRefSha256: sha256(declaredRef), secrets };
}

/** The checkout's linked Supabase project ref, if the CLI linked one. */
export function readLinkedProjectRef(cwd: string): string | null {
  const file = join(cwd, "supabase", ".temp", "project-ref");
  return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
}

// ---------------------------------------------------------------------------
// Sessions: one client connection = one PostgreSQL backend.
// ---------------------------------------------------------------------------

/** One client connection. query() without params uses the simple protocol (multi-statement). */
export type RawConnection = {
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  takeNotices(): string[];
  close(): Promise<void>;
};

export type Connector = (applicationName: string) => Promise<RawConnection>;

export class SqlFailure extends Error {
  constructor(readonly sqlstate: string | null, message: string, readonly where: string | null) {
    super(message);
    this.name = "SqlFailure";
  }
}

function toSqlFailure(error: unknown): SqlFailure {
  if (error instanceof SqlFailure) return error;
  const e = error as { code?: unknown; message?: unknown; where?: unknown };
  const code = typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  return new SqlFailure(code, typeof e?.message === "string" ? e.message : String(error), typeof e?.where === "string" ? e.where : null);
}

export class Session {
  constructor(
    readonly name: string,
    readonly pid: number,
    readonly applicationName: string,
    private readonly raw: RawConnection,
    /** Throws once the run is aborted: no experiment statement may follow cleanup. */
    private readonly gate: () => void = () => undefined,
  ) {}

  owns(raw: RawConnection): boolean {
    return this.raw === raw;
  }

  async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.gate();
    try {
      return (await this.raw.query(sql, params)) as T[];
    } catch (error) {
      throw toSqlFailure(error);
    }
  }

  async one<T>(sql: string, params: unknown[] = []): Promise<T> {
    const rows = await this.rows<T>(sql, params);
    if (rows.length !== 1) throw new HarnessFailure("unexpected_row_count", `expected one row, got ${rows.length}`);
    return rows[0];
  }

  /** One simple-protocol execution (e.g. a reviewed operator SQL file), with its notices. */
  async execute(sql: string): Promise<{ notices: string[] }> {
    this.gate();
    this.raw.takeNotices();
    try {
      await this.raw.query(sql);
      return { notices: this.raw.takeNotices() };
    } catch (error) {
      this.raw.takeNotices();
      throw toSqlFailure(error);
    }
  }

  close(): Promise<void> {
    return this.raw.close();
  }
}

export class HarnessFailure extends Error {
  constructor(readonly reason: string, message: string, readonly observed?: unknown) {
    super(message);
    this.name = "HarnessFailure";
  }
}

/** The experiment could not hold its interleaving inside V2's 5s lock window; rerun it. */
class Inconclusive extends Error {
  constructor(message: string, readonly observed?: unknown) {
    super(message);
    this.name = "Inconclusive";
  }
}

type Settled<T> = { ok: true; value: T; ms: number } | { ok: false; error: SqlFailure; ms: number };

/** Starts a statement without awaiting it; never leaves an unhandled rejection behind. */
function inFlight<T>(promise: Promise<T>, now: () => number): Promise<Settled<T>> {
  const started = now();
  return promise.then(
    (value) => ({ ok: true as const, value, ms: Math.round(now() - started) }),
    (error: unknown) => ({ ok: false as const, error: toSqlFailure(error), ms: Math.round(now() - started) }),
  );
}

// ---------------------------------------------------------------------------
// SQL used by the observer and the experiments (reads, synthetic seeds, RPCs).
// ---------------------------------------------------------------------------

const utc = (expr: string) => `to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const UTC_NOW = utc("pg_catalog.clock_timestamp()");

const V2_CALL_SQL = "select public.match_ledger_ingest_provider_fixture_v2($1::jsonb) as result";
const REVOKE_TEAM_SQL = "select public.provider_identity_revoke_team($1::jsonb) as result";
const HOLD_ADVISORY_XACT_LOCK_SQL = "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))";
const PRIVILEGES_SQL = `select pg_catalog.has_function_privilege('service_role', $1, 'execute') as v2,
       pg_catalog.has_function_privilege('service_role', $2, 'execute') as v1`;

export const LOCK_SNAPSHOT_SQL = `
select k.label, l.pid, l.mode, l.granted,
       pg_catalog.pg_blocking_pids(l.pid) as blocked_by,
       a.state, a.wait_event_type, a.wait_event, a.backend_xid::text as backend_xid,
       ${UTC_NOW} as observed_at
from pg_catalog.pg_locks l
join unnest($1::text[], $2::text[]) as k(label, lock_key)
  on l.locktype = 'advisory' and l.objsubid = 1
 and ((l.classid::bigint << 32) | l.objid::bigint) = pg_catalog.hashtextextended(k.lock_key, 0)
left join pg_catalog.pg_stat_activity a on a.pid = l.pid
order by k.label, l.pid, l.mode`;

/** Read-only: production has users, rounds, teams, competitions, runs and team attestations. */
const DISPOSABLE_GUARD_SQL = `
select
  (select count(*) from auth.users)::int as auth_users,
  (select count(*) from public.rounds)::int as rounds,
  (select count(*) from public.teams where canonical_name not like $1)::int as non_rehearsal_teams,
  (select count(*) from public.competitions where canonical_name not like $1)::int as non_rehearsal_competitions,
  (select count(*) from public.provider_ingest_runs where scope->>'kapiloto_rehearsal' is distinct from $2)::int as non_rehearsal_ingest_runs,
  (select count(*) from private.provider_team_identity_attestation_events e
    where not exists (select 1 from public.teams t where t.id = e.team_id and t.canonical_name like $1))::int as non_rehearsal_team_attestations`;

const ROLE_SQL = `
select current_user::text as current_user, session_user::text as session_user,
       pg_catalog.pg_has_role(current_user, 'service_role', 'MEMBER') as can_become_service_role,
       pg_catalog.current_setting('server_version_num')::int as server_version_num,
       pg_catalog.current_setting('server_version') as server_version,
       pg_catalog.current_setting('default_transaction_isolation') as isolation,
       (select pg_catalog.pg_get_userbyid(p.proowner)::text from pg_catalog.pg_proc p where p.oid = '${V2}'::regprocedure) as v2_owner`;

/** Functions whose semantics the rehearsal exercises: they must be this checkout's migration text. */
export const REHEARSED_FUNCTIONS = [
  { schema: "public", name: "match_ledger_ingest_provider_fixture_v2", signature: V2, lockTimeout: "5s" },
  { schema: "public", name: "match_ledger_ingest_provider_fixture", signature: V1, lockTimeout: null },
  { schema: "public", name: "provider_identity_revoke_team", signature: "public.provider_identity_revoke_team(jsonb)", lockTimeout: "5s" },
  { schema: "public", name: "provider_identity_attest_team", signature: "public.provider_identity_attest_team(jsonb)", lockTimeout: "5s" },
  { schema: "public", name: "provider_identity_attest_competition", signature: "public.provider_identity_attest_competition(jsonb)", lockTimeout: "5s" },
  { schema: "public", name: "provider_identity_revocation_impact", signature: "public.provider_identity_revocation_impact(text, text, text)", lockTimeout: null },
  { schema: "public", name: "match_ledger_observation_as_of_v2", signature: "public.match_ledger_observation_as_of_v2(uuid, text, timestamptz)", lockTimeout: null },
  { schema: "private", name: "lock_provider_identity", signature: "private.lock_provider_identity(text, boolean)", lockTimeout: null },
  { schema: "private", name: "provider_identity_begin_change", signature: "private.provider_identity_begin_change(text)", lockTimeout: null },
  // The production information clock, not the PGlite test override.
  { schema: "private", name: "kapiloto_information_clock", signature: "private.kapiloto_information_clock()", lockTimeout: null },
] as const;

/**
 * The reviewed operator SQL, read from docs/operations/sql (RUNBOOK_SQL):
 * the harness executes these files verbatim and holds no copy of them.
 */
export function loadReviewedM2cSql(rootDir: string): Sql {
  const read = (file: string) => readFileSync(join(rootDir, "docs", "operations", "sql", file), "utf8");
  return { m2cRevoke: read(RUNBOOK_SQL.m2cRevoke), m2cVerify: read(RUNBOOK_SQL.m2cVerify) };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const normalizeSource = (text: string) => text.replace(/\r\n/g, "\n");

/** The body (prosrc) of the LAST definition of a function in the checkout's migration chain. */
export function expectedFunctionSource(migrationsDir: string, schema: string, name: string): string | null {
  const header = new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+${schema}\.${name}\s*\(`, "gi");
  let found: string | null = null;
  for (const file of readdirSync(migrationsDir).filter((entry) => entry.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const match of sql.matchAll(header)) {
      const rest = sql.slice((match.index ?? 0) + match[0].length);
      const open = /\bas\s+(\$[A-Za-z0-9_]*\$)/i.exec(rest);
      if (!open) continue;
      const bodyStart = (open.index ?? 0) + open[0].length;
      const bodyEnd = rest.indexOf(open[1], bodyStart);
      if (bodyEnd < 0) continue;
      found = rest.slice(bodyStart, bodyEnd);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Evidence.
// ---------------------------------------------------------------------------

export type LockRow = {
  label: string;
  pid: number;
  session: string | null;
  mode: string;
  granted: boolean;
  blocked_by: number[];
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  backend_xid: string | null;
  observed_at: string;
};

export type EvidenceStep = {
  t_ms: number;
  session: string;
  action: string;
  ok?: boolean;
  sqlstate?: string | null;
  ms?: number;
  detail?: unknown;
};

export type Assertion = { name: string; passed: boolean; observed?: unknown };

export type VerifyRun = { at: string; passed: boolean; message: string };

export type ExperimentOutcome = "pass" | "fail" | "inconclusive";

export type ExperimentEvidence = {
  id: string;
  title: string;
  outcome: ExperimentOutcome;
  sessions: Record<string, number>;
  world?: { provider_fixture_id: string; run_id: string };
  steps: EvidenceStep[];
  handshakes: Array<{ label: string; polls: number; waited_ms: number; snapshot: LockRow[] }>;
  verify_runs: VerifyRun[];
  assertions: Assertion[];
  error?: { kind: string; message: string; sqlstate?: string | null; observed?: unknown };
};

export type RehearsalOutcome = "pass" | "fail" | "inconclusive" | "refused" | "checked";

export type RehearsalEvidence = {
  harness: typeof HARNESS_ID;
  outcome: RehearsalOutcome;
  started_at: string;
  finished_at: string | null;
  mode: "full" | "check-only";
  target: { kind: RehearsalTargetKind; project_ref_sha256: string; tls: string } | null;
  run_tag: string | null;
  server: Record<string, unknown> | null;
  sql_sources: Record<string, string>;
  function_identity: Array<{ signature: string; prosrc_sha256: string | null; expected_sha256: string | null; matches_checkout: boolean; owner: string | null; security_definer: boolean | null; config: string[] }>;
  guards: Assertion[];
  experiments: ExperimentEvidence[];
  cleanup: { ran: boolean; m2c_body_executed: boolean; terminated_pids: number[]; verify_runs: VerifyRun[]; final_privileges: { v2_service_role: boolean; v1_service_role: boolean } | null; error?: string } ;
  refusal?: { reason: string; message: string };
  error?: { kind: string; message: string };
};

/** Replaces every secret substring in every string of the evidence. */
export function redactEvidence<T>(value: T, secrets: readonly string[]): T {
  const live = secrets.filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return live.reduce((text, secret) => text.split(secret).join("[redacted]"), node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, entry]) => [walk(key) as string, walk(entry)]));
    }
    return node;
  };
  return walk(value) as T;
}

/** Throws if a serialized evidence document still contains any secret. */
export function assertEvidenceRedacted(serialized: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret.length > 0 && serialized.includes(secret)) {
      throw new Error("refusing to emit evidence: it still contains a connection secret");
    }
  }
}

// ---------------------------------------------------------------------------
// Rehearsal context.
// ---------------------------------------------------------------------------

export type Sql = { m2cRevoke: string; m2cVerify: string };

type World = {
  label: string;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  fixtureId: string;
  providerLeagueId: string;
  providerHomeTeamId: string;
  providerAwayTeamId: string;
  providerFixtureId: string;
  runId: string;
  payload: Record<string, unknown>;
  pairKey: string;
  fixtureKey: string;
  generations: { league: string; team_home: string; team_away: string };
};

type Context = {
  connect: Connector;
  timeouts: RehearsalTimeouts;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  t0: number;
  runTag: string;
  sql: Sql;
  observer: Session;
  raws: Set<RawConnection>;
  pidNames: Map<number, string>;
  /** Set when the experiments end or the deadline fires; gated sessions then refuse every statement. */
  state: { aborted: boolean };
};

type SessionContext = Pick<Context, "connect" | "runTag" | "raws" | "pidNames"> & { state?: { aborted: boolean } };

async function openSession(ctx: SessionContext, name: string, options: { gated?: boolean } = {}): Promise<Session> {
  const applicationName = `${APPLICATION_NAME_PREFIX}${ctx.runTag}:${name}`;
  const state = ctx.state;
  const gate =
    options.gated === false || !state
      ? () => undefined
      : () => {
          if (state.aborted) throw new HarnessFailure("aborted", "the rehearsal was aborted; no further experiment statement is sent");
        };
  const raw = await ctx.connect(applicationName);
  ctx.raws.add(raw);
  const session = new Session(name, 0, applicationName, raw, gate);
  await session.execute(SESSION_SETTINGS_SQL);
  // Explicit, because a pooler need not forward the startup application_name.
  await session.rows("select pg_catalog.set_config('application_name', $1, false)", [applicationName]);
  const first = await session.one<{ pid: number }>("select pg_catalog.pg_backend_pid() as pid");
  const second = await session.one<{ pid: number }>("select pg_catalog.pg_backend_pid() as pid");
  if (first.pid !== second.pid) {
    throw new HarnessFailure("session_backend_unstable", `session ${name} moved between backends (transaction pooling?); use a direct or session-pooler connection`);
  }
  const pinned = new Session(name, Number(first.pid), applicationName, raw, gate);
  ctx.pidNames.set(pinned.pid, name);
  return pinned;
}

class Recorder {
  readonly ex: ExperimentEvidence;
  constructor(private readonly ctx: Context, id: string, title: string) {
    this.ex = { id, title, outcome: "fail", sessions: {}, steps: [], handshakes: [], verify_runs: [], assertions: [] };
  }

  step(session: string, action: string, extra: Omit<EvidenceStep, "t_ms" | "session" | "action"> = {}): void {
    this.ex.steps.push({ t_ms: Math.round(this.ctx.now() - this.ctx.t0), session, action, ...extra });
  }

  settled(session: string, action: string, result: Settled<unknown>, detail?: unknown): void {
    this.step(session, action, {
      ok: result.ok,
      ms: result.ms,
      ...(result.ok ? {} : { sqlstate: result.error.sqlstate, detail: { message: result.error.message, where: result.error.where } }),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  check(name: string, passed: boolean, observed?: unknown): void {
    this.ex.assertions.push({ name, passed, ...(observed === undefined ? {} : { observed }) });
    if (!passed) throw new HarnessFailure("assertion_failed", name, observed);
  }
}

async function lockSnapshot(ctx: Context, keys: Record<string, string>): Promise<LockRow[]> {
  const labels = Object.keys(keys);
  const rows = await ctx.observer.rows<Omit<LockRow, "session">>(LOCK_SNAPSHOT_SQL, [labels, labels.map((label) => keys[label])]);
  return rows.map((row) => ({
    ...row,
    pid: Number(row.pid),
    blocked_by: (row.blocked_by ?? []).map(Number),
    session: ctx.pidNames.get(Number(row.pid)) ?? null,
  }));
}

const holds = (snapshot: LockRow[], pid: number, label: string, mode: string, granted: boolean) =>
  snapshot.some((row) => row.pid === pid && row.label === label && row.mode === mode && row.granted === granted);
const blockedBy = (snapshot: LockRow[], pid: number, blocker: number) =>
  snapshot.some((row) => row.pid === pid && !row.granted && row.blocked_by.includes(blocker));

/** Polls the observer until the lock state satisfies the predicate (the handshake), or fails. */
async function handshake(ctx: Context, rec: Recorder, label: string, keys: Record<string, string>, predicate: (snapshot: LockRow[]) => boolean): Promise<LockRow[]> {
  const started = ctx.now();
  let polls = 0;
  let snapshot: LockRow[] = [];
  for (;;) {
    polls += 1;
    snapshot = await lockSnapshot(ctx, keys);
    if (predicate(snapshot)) break;
    if (ctx.now() - started > ctx.timeouts.handshakeMs) {
      rec.ex.handshakes.push({ label: `TIMED OUT: ${label}`, polls, waited_ms: Math.round(ctx.now() - started), snapshot });
      throw new HarnessFailure("handshake_timeout", `lock-state handshake not observed within ${ctx.timeouts.handshakeMs}ms: ${label}`, snapshot);
    }
    await ctx.sleep(ctx.timeouts.pollMs);
  }
  rec.ex.handshakes.push({ label, polls, waited_ms: Math.round(ctx.now() - started), snapshot });
  rec.step("O", `handshake: ${label}`);
  return snapshot;
}

async function privileges(o: Session): Promise<{ v2: boolean; v1: boolean }> {
  return o.one<{ v2: boolean; v1: boolean }>(PRIVILEGES_SQL, [V2, V1]);
}

async function serverNow(o: Session): Promise<string> {
  return (await o.one<{ now: string }>(`select ${UTC_NOW} as now`)).now;
}

/** One execution of the reviewed M2C verification file, verbatim. */
async function runVerify(ctx: Context, session: Session = ctx.observer): Promise<VerifyRun> {
  const at = await serverNow(session);
  try {
    const { notices } = await session.execute(ctx.sql.m2cVerify);
    const passedNotice = notices.find((notice) => notice.includes("M2C verification PASSED"));
    return { at, passed: Boolean(passedNotice), message: passedNotice ?? "no PASS notice" };
  } catch (error) {
    return { at, passed: false, message: toSqlFailure(error).message };
  }
}

/** Two PASSes of the reviewed verification at least doublePassGapMs apart (runbook §A). */
async function verifyDoublePass(ctx: Context, runs: VerifyRun[], session: Session = ctx.observer, attempts = 1): Promise<boolean> {
  let first: VerifyRun | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    first = await runVerify(ctx, session);
    runs.push(first);
    if (first.passed) break;
    await ctx.sleep(500);
  }
  if (!first?.passed) return false;
  await ctx.sleep(ctx.timeouts.doublePassGapMs);
  const second = await runVerify(ctx, session);
  runs.push(second);
  return second.passed;
}

const ACL_PROBLEMS = /EXECUTE granted to|executable by non-operator role|owned by non-operator role|references a provider ingest RPC|pg_cron job/;

async function ensureSimulatedGrant(ctx: Context, rec: Recorder): Promise<void> {
  await ctx.observer.execute(SIMULATED_M2B_GRANT);
  const state = await privileges(ctx.observer);
  rec.step("O", "simulated M2B grant (disposable database only)", { detail: state });
  rec.check("simulated M2B grant opened V2 to service_role only; V1 stays revoked", state.v2 && !state.v1, state);
}

async function runM2cBody(ctx: Context, rec: Recorder, b: Session): Promise<void> {
  await b.execute(M2C_SESSION_LOCK_TIMEOUT_SQL);
  const result = await inFlight(b.execute(ctx.sql.m2cRevoke), ctx.now);
  rec.settled(b.name, "M2C revoke body (docs/operations/sql, verbatim, alone)", result);
  rec.check("M2C revoke body committed without waiting for the in-flight ingest", result.ok, result.ok ? { ms: result.ms } : result.error.message);
}

/** Every session pid is distinct and is its own backend, as pg_stat_activity shows. */
async function assertSeparateBackends(ctx: Context, rec: Recorder, sessions: Session[]): Promise<void> {
  const all = [ctx.observer, ...sessions];
  const pids = all.map((session) => session.pid);
  for (const session of all) rec.ex.sessions[session.name] = session.pid;
  rec.check("every session is a distinct PostgreSQL backend", new Set(pids).size === pids.length, rec.ex.sessions);
  const seen = await ctx.observer.rows<{ pid: number; application_name: string }>(
    "select pid, application_name from pg_catalog.pg_stat_activity where pid = any($1::int[])",
    [pids],
  );
  const byPid = new Map(seen.map((row) => [Number(row.pid), row.application_name]));
  rec.check(
    "pg_stat_activity shows each session pid with its own application_name",
    all.every((session) => byPid.get(session.pid) === session.applicationName),
    seen,
  );
}

async function closeSessions(ctx: Context, sessions: Session[]): Promise<void> {
  for (const session of sessions) {
    await session.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Synthetic worlds (fresh per experiment; ids unique per run).
// ---------------------------------------------------------------------------

function worldIds(runTag: string, index: number) {
  // 10-digit ids below 2^31: teams/league/fixture 20<tag><index><k>, players 1<tag><index><nn>.
  const id = (k: number) => `20${runTag}${index}${k}`;
  return {
    providerLeagueId: id(0),
    providerHomeTeamId: id(1),
    providerAwayTeamId: id(2),
    providerFixtureId: id(3),
    playerIdBase: [Number(`1${runTag}${index}00`), Number(`1${runTag}${index}50`)] as [number, number],
  };
}

/** A run tag whose provider ids are unused in this database. */
async function chooseRunTag(o: Session): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tag = String(randomInt(100_000, 1_000_000));
    const used = await o.one<{ n: number }>(
      `select ((select count(*) from public.provider_team_mappings where provider_team_id like $1)
             + (select count(*) from public.provider_competition_mappings where provider_competition_id like $1)
             + (select count(*) from public.provider_fixture_mappings where provider_fixture_id like $1)
             + (select count(*) from public.provider_player_mappings where provider_player_id like $2))::int as n`,
      [`20${tag}%`, `1${tag}%`],
    );
    if (used.n === 0) return tag;
  }
  throw new HarnessFailure("run_tag_exhausted", "could not choose an unused synthetic id range");
}

export async function createRehearsalWorld(o: Session, runTag: string, index: number, label: string): Promise<World> {
  const ids = worldIds(runTag, index);
  const name = (what: string) => `${SYNTHETIC_NAME_PREFIX}${runTag} ${label} ${what}`;
  const competitionId = randomUUID();
  const homeTeamId = randomUUID();
  const awayTeamId = randomUUID();
  const fixtureId = randomUUID();
  const { now } = await o.one<{ now: string }>(`select ${UTC_NOW} as now`);
  const nowMs = Date.parse(now);
  // Finished long ago (kickoff + 105 minutes << now), captured just now.
  const kickoffAt = new Date(Math.floor((nowMs - 30 * 24 * 3600_000) / 60_000) * 60_000).toISOString();
  const capturedAt = new Date(Math.floor((nowMs - 5 * 60_000) / 1000) * 1000).toISOString();

  await o.rows("insert into public.competitions (id, canonical_name, country_code, competition_type) values ($1, $2, 'IL', 'league')", [competitionId, name("league")]);
  await o.rows("insert into public.teams (id, canonical_name, country_code) values ($1, $2, 'IL'), ($3, $4, 'IL')", [homeTeamId, name("home"), awayTeamId, name("away")]);
  await o.rows(
    "insert into public.provider_competition_mappings (provider, provider_competition_id, competition_id, mapping_status) values ('sportmonks', $1, $2, 'manual_override')",
    [ids.providerLeagueId, competitionId],
  );
  await o.rows(
    `insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_status, mapping_confidence)
     values ('sportmonks', $1, $2, 'manual_override', 1), ('sportmonks', $3, $4, 'manual_override', 1)`,
    [ids.providerHomeTeamId, homeTeamId, ids.providerAwayTeamId, awayTeamId],
  );
  await o.rows(
    "insert into public.fixtures (id, competition_id, home_team_id, away_team_id, kickoff_at, status) values ($1, $2, $3, $4, $5, 'finished')",
    [fixtureId, competitionId, homeTeamId, awayTeamId, kickoffAt],
  );
  await o.rows(
    "insert into public.provider_fixture_mappings (fixture_id, provider, provider_fixture_id, mapping_status, mapping_confidence) values ($1, 'sportmonks', $2, 'confirmed', 0.9)",
    [fixtureId, ids.providerFixtureId],
  );
  const scope = { provider_fixture_ids: [ids.providerFixtureId], kapiloto_rehearsal: HARNESS_ID, rehearsal_run: runTag, world: label };
  const { id: runId } = await o.one<{ id: string }>(
    `insert into public.provider_ingest_runs (provider, purpose, ingest_version, scope, fixture_mint_kickoff_before)
     values ('sportmonks', 'test', 'kapiloto-sportmonks-ledger-mapping-v1', $1::jsonb, null) returning id`,
    [JSON.stringify(scope)],
  );
  // Each attestation is its own autocommit transaction (first-write rule).
  const attest = async (fn: string, payload: unknown) =>
    (await o.one<{ result: { attestation_generation_id: string; status: string } }>(`select public.${fn}($1::jsonb) as result`, [JSON.stringify(payload)])).result;
  const league = await attest("provider_identity_attest_competition", competitionAttestation(ids.providerLeagueId, competitionId));
  const home = await attest("provider_identity_attest_team", teamAttestation(ids.providerHomeTeamId, homeTeamId));
  const away = await attest("provider_identity_attest_team", teamAttestation(ids.providerAwayTeamId, awayTeamId));
  const { key: pairKey } = await o.one<{ key: string }>(
    "select 'kapiloto_canonical_fixture_pair:' || least($1::uuid, $2::uuid)::text || ':' || greatest($1::uuid, $2::uuid)::text as key",
    [homeTeamId, awayTeamId],
  );
  const capture = syntheticCapture({
    providerFixtureId: ids.providerFixtureId,
    leagueId: ids.providerLeagueId,
    homeTeamId: ids.providerHomeTeamId,
    awayTeamId: ids.providerAwayTeamId,
    kickoffAt,
    capturedAt,
    playerIdBase: ids.playerIdBase,
  });
  const payload = buildProviderMatchObservationPayload(observationFrom(capture, { mint: false, runId }));
  return {
    label,
    competitionId,
    homeTeamId,
    awayTeamId,
    fixtureId,
    ...ids,
    runId,
    payload,
    pairKey,
    fixtureKey: `kapiloto_match_ledger_provider_fixture:sportmonks:${ids.providerFixtureId}`,
    generations: { league: league.attestation_generation_id, team_home: home.attestation_generation_id, team_away: away.attestation_generation_id },
  };
}

const lockKeys = (w: World) => ({ identity: IDENTITY_LOCK_KEY, pair: w.pairKey, fixture: w.fixtureKey });

const revocation = (w: World) => ({
  provider: "sportmonks",
  provider_team_id: w.providerHomeTeamId,
  expected_team_id: w.homeTeamId,
  reason: "synthetic real-PostgreSQL rehearsal revocation",
  revoked_by: "synthetic rehearsal operator",
});

async function callV2(session: Session, w: World): Promise<ProviderIngestResult> {
  return (await session.one<{ result: ProviderIngestResult }>(V2_CALL_SQL, [JSON.stringify(w.payload)])).result;
}

async function revokeHome(session: Session, w: World): Promise<{ status: string; event_id: string; attestation_version: number }> {
  return (await session.one<{ result: { status: string; event_id: string; attestation_version: number } }>(REVOKE_TEAM_SQL, [JSON.stringify(revocation(w))])).result;
}

async function teamTrustState(o: Session, w: World) {
  return o.one<{ events: number; projection: number }>(
    `select (select count(*) from private.provider_team_identity_attestation_events where provider = 'sportmonks' and provider_team_id = $1)::int as events,
            (select count(*) from private.provider_team_identity_attestations where provider = 'sportmonks' and provider_team_id = $1)::int as projection`,
    [w.providerHomeTeamId],
  );
}

async function observationImpact(o: Session, w: World) {
  return o.rows<{ observation_id: string; is_latest_version: boolean; generation_state: string; attestation_generation_id: string }>(
    `select observation_id, is_latest_version, generation_state, attestation_generation_id
     from public.provider_identity_revocation_impact('sportmonks', 'team', $1)
     where impact_kind = 'observation_under_generation'`,
    [w.providerHomeTeamId],
  );
}

async function trustedRead(o: Session, w: World): Promise<string | null> {
  return (await o.one<{ id: string | null }>("select public.match_ledger_observation_as_of_v2($1::uuid, 'sportmonks', pg_catalog.clock_timestamp()) as id", [w.fixtureId])).id;
}

function expectRecorded(rec: Recorder, label: string, result: Settled<ProviderIngestResult>, w: World): ProviderIngestResult {
  rec.check(`${label}: V2 call returned`, result.ok, result.ok ? undefined : { sqlstate: result.error.sqlstate, message: result.error.message });
  const value = (result as { value: ProviderIngestResult }).value;
  rec.check(`${label}: recorded through the existing mapping under the world's attestation generations`,
    value.status === "recorded" && value.fixture_resolution === "existing_mapping" && value.fixture_id === w.fixtureId &&
      value.attestation_generations?.league === w.generations.league &&
      value.attestation_generations?.team_home === w.generations.team_home &&
      value.attestation_generations?.team_away === w.generations.team_away,
    value);
  return value;
}

function expectWaiterStillInWindow(result: Settled<unknown>): void {
  if (!result.ok && result.error.sqlstate === "55P03") {
    throw new Inconclusive("the waiting V2 call hit its 5s function lock_timeout before the interleaving completed; rerun", result.error.message);
  }
}

async function expectRefusedAfterM2c(ctx: Context, rec: Recorder, a: Session, w: World): Promise<void> {
  const again = await inFlight(callV2(a, w), ctx.now);
  rec.settled(a.name, "new V2 call in a new transaction after M2C committed", again);
  rec.check("a transaction starting after M2C is refused with 42501", !again.ok && again.error.sqlstate === "42501", again.ok ? again.value : again.error.sqlstate);
  const fresh = await openSession(ctx, `${rec.ex.id}-fresh`);
  try {
    await fresh.execute("set role service_role");
    const call = await inFlight(callV2(fresh, w), ctx.now);
    rec.settled(fresh.name, "V2 call on a brand-new connection after M2C", call);
    rec.check("a brand-new service_role connection is refused with 42501", !call.ok && call.error.sqlstate === "42501", call.ok ? call.value : call.error.sqlstate);
  } finally {
    await fresh.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Experiments.
// ---------------------------------------------------------------------------

type Experiment = { id: string; title: string; run: (ctx: Context, rec: Recorder, w: World) => Promise<void> };

/** P0: the synthetic payload and trust state are valid (a direct call records, a replay is unchanged). */
const P0: Experiment = {
  id: "P0",
  title: "preflight: a direct service_role V2 call records; an identical replay is unchanged",
  async run(ctx, rec, w) {
    await ensureSimulatedGrant(ctx, rec);
    const a = await openSession(ctx, "A");
    try {
      await assertSeparateBackends(ctx, rec, [a]);
      await a.execute("set role service_role");
      const first = await inFlight(callV2(a, w), ctx.now);
      rec.settled("A", "V2 call", first, first.ok ? first.value : undefined);
      expectRecorded(rec, "preflight", first, w);
      const replay = await inFlight(callV2(a, w), ctx.now);
      rec.settled("A", "identical V2 replay", replay, replay.ok ? replay.value : undefined);
      rec.check("identical replay is unchanged", replay.ok && replay.value.status === "unchanged", replay.ok ? replay.value : replay.error.message);
    } finally {
      await closeSessions(ctx, [a]);
    }
  },
};

/** A2: M2C revokes EXECUTE while V2 is already inside the function (past EXECUTE and the identity gate). */
const A2: Experiment = {
  id: "A2",
  title: "M2C while V2 is already inside the function: the in-flight call completes, new calls get 42501, drain verified by the identity lock",
  async run(ctx, rec, w) {
    await ensureSimulatedGrant(ctx, rec);
    const [a, b, c] = [await openSession(ctx, "A"), await openSession(ctx, "B"), await openSession(ctx, "C")];
    try {
      await assertSeparateBackends(ctx, rec, [a, b, c]);
      const keys = lockKeys(w);
      await c.execute("begin");
      await c.rows(HOLD_ADVISORY_XACT_LOCK_SQL, [w.pairKey]);
      rec.step("C", "holds the unordered canonical team-pair advisory lock");
      await a.execute("set role service_role");
      const aCall = inFlight(callV2(a, w), ctx.now);
      rec.step("A", "V2 call started as service_role");
      await handshake(ctx, rec, "A inside V2: identity ShareLock granted, team-pair lock waiting behind C", keys, (s) =>
        holds(s, a.pid, "identity", "ShareLock", true) && holds(s, a.pid, "pair", "ExclusiveLock", false) && blockedBy(s, a.pid, c.pid) &&
        holds(s, c.pid, "pair", "ExclusiveLock", true));

      await runM2cBody(ctx, rec, b);
      const acl = await privileges(ctx.observer);
      rec.check("after M2C service_role can execute neither V2 nor V1", !acl.v2 && !acl.v1, acl);
      await handshake(ctx, rec, "after M2C, A is still inside V2 waiting behind C", keys, (s) =>
        holds(s, a.pid, "identity", "ShareLock", true) && holds(s, a.pid, "pair", "ExclusiveLock", false));
      const during = await runVerify(ctx);
      rec.ex.verify_runs.push(during);
      rec.check("M2C verification FAILS while A holds the identity ShareLock, and only on drain",
        !during.passed && during.message.includes(`backend ${a.pid} still holds the Sportmonks provider-identity ShareLock`) && !ACL_PROBLEMS.test(during.message),
        during.message);

      await c.execute("commit");
      rec.step("C", "commit (releases the team-pair lock)");
      const result = await aCall;
      rec.settled("A", "in-flight V2 call completed", result, result.ok ? result.value : undefined);
      expectWaiterStillInWindow(result);
      expectRecorded(rec, "in-flight call after M2C", result, w);
      await expectRefusedAfterM2c(ctx, rec, a, w);
      await a.execute("reset role");
      rec.check("M2C verification PASSES twice at least the gap apart after drain", await verifyDoublePass(ctx, rec.ex.verify_runs), rec.ex.verify_runs);
    } finally {
      await closeSessions(ctx, [a, b, c]);
    }
  },
};

/** A4 (M-1): a V2 call that passed EXECUTE and waits for the identity ShareLock fails the verification. */
const A4: Experiment = {
  id: "A4",
  title: "M2C verification FAILS on a V2 call waiting for the provider-identity ShareLock (M-1)",
  async run(ctx, rec, w) {
    await ensureSimulatedGrant(ctx, rec);
    const [a, b, c] = [await openSession(ctx, "A"), await openSession(ctx, "B"), await openSession(ctx, "C")];
    try {
      await assertSeparateBackends(ctx, rec, [a, b, c]);
      const keys = lockKeys(w);
      await c.execute("begin");
      await c.rows(HOLD_ADVISORY_XACT_LOCK_SQL, [IDENTITY_LOCK_KEY]);
      rec.step("C", "holds the Sportmonks provider-identity lock EXCLUSIVE");
      await a.execute("set role service_role");
      const aCall = inFlight(callV2(a, w), ctx.now);
      rec.step("A", "V2 call started as service_role");
      await handshake(ctx, rec, "A passed EXECUTE and waits for the identity ShareLock behind C", keys, (s) =>
        holds(s, a.pid, "identity", "ShareLock", false) && blockedBy(s, a.pid, c.pid) && holds(s, c.pid, "identity", "ExclusiveLock", true));

      await runM2cBody(ctx, rec, b);
      const acl = await privileges(ctx.observer);
      rec.check("after M2C service_role can execute neither V2 nor V1", !acl.v2 && !acl.v1, acl);
      const during = await runVerify(ctx);
      rec.ex.verify_runs.push(during);
      rec.check("M2C verification FAILS on the WAITING ShareLock request, and only on drain",
        !during.passed && during.message.includes(`backend ${a.pid} is waiting for the Sportmonks provider-identity ShareLock`) && !ACL_PROBLEMS.test(during.message),
        during.message);

      await c.execute("rollback");
      rec.step("C", "rollback (releases the identity lock)");
      const result = await aCall;
      rec.settled("A", "waiting V2 call completed", result, result.ok ? result.value : undefined);
      expectWaiterStillInWindow(result);
      expectRecorded(rec, "waiting call after M2C", result, w);
      await expectRefusedAfterM2c(ctx, rec, a, w);
      await a.execute("reset role");
      rec.check("M2C verification PASSES twice at least the gap apart after drain", await verifyDoublePass(ctx, rec.ex.verify_runs), rec.ex.verify_runs);
    } finally {
      await closeSessions(ctx, [a, b, c]);
    }
  },
};

/** B1: a revoke queued behind an in-flight ingest times out cleanly (55P03) and succeeds on retry. */
const B1: Experiment = {
  id: "B1",
  title: "identity revoke queued behind an in-flight ingest fails cleanly with 55P03, then succeeds on retry",
  async run(ctx, rec, w) {
    await ensureSimulatedGrant(ctx, rec);
    const [a, b] = [await openSession(ctx, "A"), await openSession(ctx, "B")];
    try {
      await assertSeparateBackends(ctx, rec, [a, b]);
      const keys = lockKeys(w);
      await a.execute("begin");
      await a.execute("set local role service_role");
      const ingest = await inFlight(callV2(a, w), ctx.now);
      rec.settled("A", "V2 call inside an open transaction", ingest, ingest.ok ? ingest.value : undefined);
      expectRecorded(rec, "in-flight ingest", ingest, w);
      await handshake(ctx, rec, "A's open transaction holds the identity ShareLock", keys, (s) => holds(s, a.pid, "identity", "ShareLock", true));
      const before = await teamTrustState(ctx.observer, w);

      await b.execute("set role service_role");
      const revoke = inFlight(revokeHome(b, w), ctx.now);
      rec.step("B", "provider_identity_revoke_team started as service_role");
      const queued = await handshake(ctx, rec, "B waits for the identity lock EXCLUSIVE behind A, before any write", keys, (s) =>
        holds(s, b.pid, "identity", "ExclusiveLock", false) && blockedBy(s, b.pid, a.pid));
      const bRow = queued.find((row) => row.pid === b.pid);
      rec.check("the queued revoke has no transaction id yet (nothing written)", bRow?.backend_xid === null || bRow?.backend_xid === undefined, bRow);
      rec.check("while queued: no new revoke event, projection still present", JSON.stringify(await teamTrustState(ctx.observer, w)) === JSON.stringify(before) && before.projection === 1, before);

      const timedOut = await revoke;
      rec.settled("B", "queued revoke returned", timedOut);
      rec.check("the queued revoke failed with SQLSTATE 55P03 at the identity lock",
        !timedOut.ok && timedOut.error.sqlstate === "55P03" && /lock_provider_identity/.test(timedOut.error.where ?? ""),
        timedOut.ok ? timedOut.value : { sqlstate: timedOut.error.sqlstate, where: timedOut.error.where });
      rec.check("the failed revoke wrote no event and left the projection", JSON.stringify(await teamTrustState(ctx.observer, w)) === JSON.stringify(before), await teamTrustState(ctx.observer, w));

      await a.execute("commit");
      rec.step("A", "commit");
      const observationId = (ingest as { value: ProviderIngestResult }).value.observation_id;
      rec.check("after A commits the trusted V2 read returns A's observation", (await trustedRead(ctx.observer, w)) === observationId);
      const activeImpact = await observationImpact(ctx.observer, w);
      rec.check("impact report: A's observation under the ACTIVE generation", activeImpact.some((row) => row.observation_id === observationId && row.generation_state === "active"), activeImpact);

      const retry = await inFlight(revokeHome(b, w), ctx.now);
      rec.settled("B", "revoke retried as a new execution", retry, retry.ok ? retry.value : undefined);
      rec.check("the retried revoke succeeds", retry.ok && retry.value.status === "revoked", retry.ok ? retry.value : retry.error.message);
      const revokedImpact = await observationImpact(ctx.observer, w);
      rec.check("impact report: A's observation is now under a REVOKED generation", revokedImpact.some((row) => row.observation_id === observationId && row.generation_state === "revoked" && row.is_latest_version), revokedImpact);
      rec.check("the trusted V2 read no longer returns the observation", (await trustedRead(ctx.observer, w)) === null);
      await b.execute("reset role");
    } finally {
      await closeSessions(ctx, [a, b]);
    }
  },
};

/** B2: a queued revoke completes after the in-flight ingest commits; the revoke sees the committed observation. */
const B2: Experiment = {
  id: "B2",
  title: "identity revoke queued behind an in-flight ingest completes after the ingest commits; impact report and V2 read reflect it",
  async run(ctx, rec, w) {
    await ensureSimulatedGrant(ctx, rec);
    const [a, b] = [await openSession(ctx, "A"), await openSession(ctx, "B")];
    try {
      await assertSeparateBackends(ctx, rec, [a, b]);
      const keys = lockKeys(w);
      await a.execute("begin");
      await a.execute("set local role service_role");
      const ingest = await inFlight(callV2(a, w), ctx.now);
      rec.settled("A", "V2 call inside an open transaction", ingest, ingest.ok ? ingest.value : undefined);
      const recorded = expectRecorded(rec, "in-flight ingest", ingest, w);
      await handshake(ctx, rec, "A's open transaction holds the identity ShareLock", keys, (s) => holds(s, a.pid, "identity", "ShareLock", true));
      const preBarrier = await observationImpact(ctx.observer, w);
      rec.check("before the barrier the impact report cannot see A's uncommitted observation", !preBarrier.some((row) => row.observation_id === recorded.observation_id), preBarrier);

      await b.execute("set role service_role");
      const revoke = inFlight(revokeHome(b, w), ctx.now);
      rec.step("B", "provider_identity_revoke_team started as service_role");
      await handshake(ctx, rec, "B waits for the identity lock EXCLUSIVE behind A", keys, (s) =>
        holds(s, b.pid, "identity", "ExclusiveLock", false) && blockedBy(s, b.pid, a.pid));
      await a.execute("commit");
      rec.step("A", "commit (inside the revoke's 5s lock window)");

      const revoked = await revoke;
      rec.settled("B", "queued revoke returned", revoked, revoked.ok ? revoked.value : undefined);
      if (!revoked.ok && revoked.error.sqlstate === "55P03") throw new Inconclusive("the queued revoke timed out before A committed; rerun", revoked.error.message);
      rec.check("the queued revoke completed after A committed", revoked.ok && revoked.value.status === "revoked", revoked.ok ? revoked.value : revoked.error.message);
      const impact = await observationImpact(ctx.observer, w);
      rec.check("impact report: A's observation, latest version, under the REVOKED generation",
        impact.some((row) => row.observation_id === recorded.observation_id && row.is_latest_version && row.generation_state === "revoked"), impact);
      const order = await ctx.observer.one<{ first_seen_at: string; recorded_at: string; before: boolean }>(
        `select ${utc("o.first_seen_at")} as first_seen_at, ${utc("e.recorded_at")} as recorded_at, o.first_seen_at < e.recorded_at as before
         from public.match_ledger_observations o, private.provider_team_identity_attestation_events e
         where o.id = $1 and e.id = $2`,
        [recorded.observation_id, (revoked as { value: { event_id: string } }).value.event_id],
      );
      rec.check("A's observation was first seen before the revoke event was recorded", order.before, order);
      rec.check("the trusted V2 read no longer returns the observation", (await trustedRead(ctx.observer, w)) === null);
      await b.execute("reset role");
    } finally {
      await closeSessions(ctx, [a, b]);
    }
  },
};

/** B3: an ingest queued behind an executed-but-uncommitted revoke fails closed after the revoke commits. */
const B3: Experiment = {
  id: "B3",
  title: "ingest queued behind an identity revoke fails closed (team_attestation_missing) once the revoke commits",
  async run(ctx, rec, w) {
    await ensureSimulatedGrant(ctx, rec);
    const [a, b] = [await openSession(ctx, "A"), await openSession(ctx, "B")];
    try {
      await assertSeparateBackends(ctx, rec, [a, b]);
      const keys = lockKeys(w);
      await b.execute("begin");
      await b.execute("set local role service_role");
      const revoked = await inFlight(revokeHome(b, w), ctx.now);
      rec.settled("B", "provider_identity_revoke_team inside an open transaction", revoked, revoked.ok ? revoked.value : undefined);
      rec.check("the revoke executed", revoked.ok && revoked.value.status === "revoked", revoked.ok ? revoked.value : revoked.error.message);
      await handshake(ctx, rec, "B's open revoke holds the identity lock EXCLUSIVE", keys, (s) => holds(s, b.pid, "identity", "ExclusiveLock", true));
      const itemsBefore = await ctx.observer.one<{ n: number }>("select count(*)::int as n from public.provider_ingest_items where run_id = $1", [w.runId]);

      await a.execute("set role service_role");
      const aCall = inFlight(callV2(a, w), ctx.now);
      rec.step("A", "V2 call started as service_role");
      await handshake(ctx, rec, "A passed EXECUTE and waits for the identity ShareLock behind B", keys, (s) =>
        holds(s, a.pid, "identity", "ShareLock", false) && blockedBy(s, a.pid, b.pid));
      await b.execute("commit");
      rec.step("B", "commit (revoke visible)");

      const result = await aCall;
      rec.settled("A", "queued V2 call returned", result, result.ok ? result.value : undefined);
      expectWaiterStillInWindow(result);
      rec.check("the queued ingest re-read trust after the barrier and quarantined team_attestation_missing",
        result.ok && result.value.status === "quarantined" && result.value.reason_code === "team_attestation_missing",
        result.ok ? result.value : result.error.message);
      const footprint = await ctx.observer.one<{ observations: number; items: number; quarantined: number; projection: number }>(
        `select (select count(*) from public.match_ledger_observations where fixture_id = $1)::int as observations,
                (select count(*) from public.provider_ingest_items where run_id = $2)::int as items,
                (select count(*) from public.provider_ingest_items where run_id = $2 and status = 'quarantined' and reason_code = 'team_attestation_missing')::int as quarantined,
                (select count(*) from private.provider_team_identity_attestations where provider = 'sportmonks' and provider_team_id = $3)::int as projection`,
        [w.fixtureId, w.runId, w.providerHomeTeamId],
      );
      rec.check("fail closed: no observation, exactly one quarantine audit item, no active projection",
        footprint.observations === 0 && footprint.items === itemsBefore.n + 1 && footprint.quarantined === 1 && footprint.projection === 0, footprint);
      await a.execute("reset role");
    } finally {
      await closeSessions(ctx, [a, b]);
    }
  },
};

export const EXPERIMENTS = [P0, A2, A4, B1, B2, B3] as const;

// ---------------------------------------------------------------------------
// Guards against the database (read-only) and the orchestrator.
// ---------------------------------------------------------------------------

async function runGuards(ctx: Context, evidence: RehearsalEvidence, migrationsDir: string): Promise<boolean> {
  const o = ctx.observer;
  const guard = (name: string, passed: boolean, observed?: unknown) => {
    evidence.guards.push({ name, passed, ...(observed === undefined ? {} : { observed }) });
    return passed;
  };

  const role = await o.one<Record<string, unknown>>(ROLE_SQL);
  evidence.server = { server_version: role.server_version, server_version_num: role.server_version_num, isolation: role.isolation, current_user: role.current_user };
  let ok = guard("connected as the V2 owner (the only role that can make the simulated grant)", role.current_user === role.v2_owner && role.session_user === role.current_user, { current_user: role.current_user, v2_owner: role.v2_owner });
  ok = guard("the connecting role can SET ROLE service_role (the production ingest path)", role.can_become_service_role === true) && ok;
  ok = guard("PostgreSQL 15 or later, READ COMMITTED by default", Number(role.server_version_num) >= 150000 && role.isolation === "read committed", { server_version_num: role.server_version_num, isolation: role.isolation }) && ok;

  const data = await o.one<Record<string, number>>(DISPOSABLE_GUARD_SQL, [`${SYNTHETIC_NAME_PREFIX}%`, HARNESS_ID]);
  for (const [key, count] of Object.entries(data)) {
    ok = guard(`disposable database: ${key} = 0`, count === 0, count) && ok;
  }

  const history = await o.one<{ exists: boolean }>("select pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null as exists");
  if (history.exists) {
    const m2b = await o.one<{ n: number }>("select count(*)::int as n from supabase_migrations.schema_migrations where coalesce(name, '') ilike '%m2b%'");
    ok = guard("no M2B migration in the migration history", m2b.n === 0, m2b.n) && ok;
  } else {
    guard("no Supabase migration history table (schema loaded directly)", true);
  }

  const others = await o.one<{ n: number }>(
    "select count(*)::int as n from pg_catalog.pg_stat_activity where application_name like $1 and pid <> pg_catalog.pg_backend_pid()",
    [`${APPLICATION_NAME_PREFIX}%`],
  );
  ok = guard("no other rehearsal session is connected", others.n === 0, others.n) && ok;
  const mutex = await o.one<{ ok: boolean }>("select pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1, 0)) as ok", [HARNESS_MUTEX_KEY]);
  ok = guard("rehearsal mutex acquired (one harness run per database)", mutex.ok === true) && ok;

  for (const fn of REHEARSED_FUNCTIONS) {
    const expected = expectedFunctionSource(migrationsDir, fn.schema, fn.name);
    const rows = await o.rows<{ prosrc: string; prosecdef: boolean; owner: string; config: string[] | null }>(
      `select p.prosrc, p.prosecdef, pg_catalog.pg_get_userbyid(p.proowner)::text as owner, p.proconfig as config
       from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure($1)`,
      [fn.signature],
    );
    const row = rows[0];
    const prosrcSha = row ? sha256(normalizeSource(row.prosrc)) : null;
    const expectedSha = expected === null ? null : sha256(normalizeSource(expected));
    const config = row?.config ?? [];
    evidence.function_identity.push({
      signature: fn.signature,
      prosrc_sha256: prosrcSha,
      expected_sha256: expectedSha,
      matches_checkout: prosrcSha !== null && prosrcSha === expectedSha,
      owner: row?.owner ?? null,
      security_definer: row?.prosecdef ?? null,
      config,
    });
    ok = guard(`${fn.signature} is this checkout's migration text`, prosrcSha !== null && prosrcSha === expectedSha) && ok;
    if (fn.lockTimeout) ok = guard(`${fn.signature} keeps lock_timeout=${fn.lockTimeout}`, config.includes(`lock_timeout=${fn.lockTimeout}`), config) && ok;
  }

  const acl = await privileges(o);
  ok = guard("ingest is paused at start: service_role can execute neither V2 nor V1", !acl.v2 && !acl.v1, acl) && ok;
  const baseline = await runVerify(ctx);
  ok = guard("the reviewed M2C verification PASSES at start", baseline.passed, baseline.message) && ok;
  return ok;
}

async function cleanup(ctx: Context, evidence: RehearsalEvidence): Promise<void> {
  evidence.cleanup.ran = true;
  ctx.state.aborted = true;
  let session: Session;
  try {
    // A fresh, ungated session: the experiment sessions (observer included) may be mid-statement.
    session = await openSession(ctx, "Z", { gated: false });
  } catch (error) {
    evidence.cleanup.error = `cleanup could not connect (${toSqlFailure(error).message}); run docs/operations/sql/kapiloto-v4-m2c-revoke-body.sql and the verification manually on the disposable project`;
    return;
  }
  try {
    const terminated = await session.rows<{ pid: number }>(
      `select pid from pg_catalog.pg_stat_activity
       where application_name like $1 and pid <> pg_catalog.pg_backend_pid() and pg_catalog.pg_terminate_backend(pid)`,
      [`${APPLICATION_NAME_PREFIX}${ctx.runTag}:%`],
    );
    evidence.cleanup.terminated_pids = terminated.map((row) => Number(row.pid));
    for (const raw of ctx.raws) {
      if (!session.owns(raw)) await raw.close().catch(() => undefined);
    }
    await session.execute(M2C_SESSION_LOCK_TIMEOUT_SQL);
    await session.execute(ctx.sql.m2cRevoke);
    evidence.cleanup.m2c_body_executed = true;
    const passed = await verifyDoublePass(ctx, evidence.cleanup.verify_runs, session, 10);
    const acl = await privileges(session);
    evidence.cleanup.final_privileges = { v2_service_role: acl.v2, v1_service_role: acl.v1 };
    if (!passed || acl.v2 || acl.v1) {
      evidence.cleanup.error = "final M2C verification did not PASS twice; run docs/operations/sql/kapiloto-v4-m2c-revoke-body.sql and the verification manually on the disposable project";
    }
  } catch (error) {
    evidence.cleanup.error = `cleanup failed (${toSqlFailure(error).message}); run docs/operations/sql/kapiloto-v4-m2c-revoke-body.sql and the verification manually on the disposable project`;
  }
}

export type RehearsalOptions = {
  target: Pick<RehearsalTarget, "kind" | "projectRefSha256" | "tls" | "secrets">;
  connect: Connector;
  checkOnly?: boolean;
  timeouts?: Partial<RehearsalTimeouts>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Repository root holding docs/operations/sql and supabase/migrations (default: cwd). */
  rootDir?: string;
};

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HarnessFailure("deadline_exceeded", `the rehearsal exceeded its ${ms}ms deadline`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Runs the guards and (unless checkOnly) the experiments; always returns redacted evidence. */
export async function runRealPostgresRehearsal(options: RehearsalOptions): Promise<RehearsalEvidence> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const rootDir = options.rootDir ?? process.cwd();
  const evidence: RehearsalEvidence = {
    harness: HARNESS_ID,
    outcome: "refused",
    started_at: new Date().toISOString(),
    finished_at: null,
    mode: options.checkOnly ? "check-only" : "full",
    target: { kind: options.target.kind, project_ref_sha256: options.target.projectRefSha256, tls: options.target.tls.mode },
    run_tag: null,
    server: null,
    sql_sources: {},
    function_identity: [],
    guards: [],
    experiments: [],
    cleanup: { ran: false, m2c_body_executed: false, terminated_pids: [], verify_runs: [], final_privileges: null },
  };
  const raws = new Set<RawConnection>();
  let ctx: Context | null = null;
  let writesStarted = false;
  try {
    const sql = loadReviewedM2cSql(rootDir);
    evidence.sql_sources = {
      [RUNBOOK_SQL.m2cRevoke]: sha256(normalizeSource(sql.m2cRevoke)),
      [RUNBOOK_SQL.m2cVerify]: sha256(normalizeSource(sql.m2cVerify)),
    };

    const pidNames = new Map<number, string>();
    const state = { aborted: false };
    const preTag = "000000";
    const observer = await openSession({ connect: options.connect, runTag: preTag, raws, pidNames, state }, "O");
    ctx = { connect: options.connect, timeouts, now, sleep, t0: now(), runTag: preTag, sql, observer, raws, pidNames, state };
    if (!(await runGuards(ctx, evidence, join(rootDir, "supabase", "migrations")))) {
      evidence.outcome = "refused";
      return finish(evidence, options.target.secrets);
    }
    if (options.checkOnly) {
      evidence.outcome = "checked";
      return finish(evidence, options.target.secrets);
    }

    const runTag = await chooseRunTag(observer);
    evidence.run_tag = runTag;
    ctx.runTag = runTag;
    const runCtx = ctx;
    await observer.rows("select pg_catalog.set_config('application_name', $1, false)", [`${APPLICATION_NAME_PREFIX}${runTag}:O`]);
    writesStarted = true;
    let outcome: RehearsalOutcome = "pass";
    await withDeadline(
      (async () => {
        let index = 0;
        for (const experiment of EXPERIMENTS) {
          index += 1;
          const rec = new Recorder(runCtx, experiment.id, experiment.title);
          evidence.experiments.push(rec.ex);
          try {
            const world = await createRehearsalWorld(observer, runTag, index, experiment.id);
            rec.ex.world = { provider_fixture_id: world.providerFixtureId, run_id: world.runId };
            await experiment.run(runCtx, rec, world);
            rec.ex.outcome = "pass";
          } catch (error) {
            const inconclusive = error instanceof Inconclusive;
            rec.ex.outcome = inconclusive ? "inconclusive" : "fail";
            const failure = error instanceof SqlFailure ? error : null;
            rec.ex.error = {
              kind: error instanceof Error ? error.name : "Error",
              message: error instanceof Error ? error.message : String(error),
              ...(failure ? { sqlstate: failure.sqlstate } : {}),
              ...(error instanceof HarnessFailure || error instanceof Inconclusive ? { observed: error.observed } : {}),
            };
            outcome = inconclusive ? "inconclusive" : "fail";
            break;
          }
        }
      })(),
      timeouts.deadlineMs,
    ).catch((error: unknown) => {
      runCtx.state.aborted = true;
      outcome = "fail";
      evidence.error = { kind: "deadline", message: error instanceof Error ? error.message : String(error) };
    });
    runCtx.state.aborted = true;
    evidence.outcome = outcome;
  } catch (error) {
    // Nothing written before writesStarted, so nothing to clean up; still a failed run.
    evidence.outcome = "fail";
    evidence.error = { kind: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (ctx && writesStarted) {
      await cleanup(ctx, evidence);
      if (evidence.cleanup.error) evidence.outcome = "fail";
    }
    for (const raw of raws) await raw.close().catch(() => undefined);
  }
  return finish(evidence, options.target.secrets);
}

function finish(evidence: RehearsalEvidence, secrets: readonly string[]): RehearsalEvidence {
  evidence.finished_at = new Date().toISOString();
  return redactEvidence(evidence, secrets);
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

export type RehearsalCliIo = {
  connectorFor: (target: RehearsalTarget) => Connector;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  writeFile: (path: string, text: string) => void;
};

const OUT_PATH = /^artifacts\/kapiloto-v4-m2b-rehearsal\/[A-Za-z0-9._-]+\.json$/;

export const REHEARSAL_USAGE = `Usage: npm run rehearsal:v4-m2b-real-postgres -- [--check-only] [--out artifacts/kapiloto-v4-m2b-rehearsal/<name>.json]

DISPOSABLE databases only. Environment (nothing else may hold a secret):
  ${REHEARSAL_ENV.databaseUrl}  DSN of the disposable project (direct or session pooler, port 5432)
  ${REHEARSAL_ENV.projectRef}   the disposable project's ref ("local" for a loopback database)
  ${REHEARSAL_ENV.caFile}       the project's CA certificate (or ${REHEARSAL_ENV.tlsNoVerify}=${TLS_NO_VERIFY_ACK})
`;

/** Exit code: 0 pass/checked, 1 fail/inconclusive, 2 refused or usage error. */
export async function runRealPostgresRehearsalCli(argv: string[], env: Record<string, string | undefined>, io: RehearsalCliIo): Promise<number> {
  let checkOnly = false;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check-only") checkOnly = true;
    else if (arg === "--out" && i + 1 < argv.length) out = argv[++i];
    else {
      io.stderr(REHEARSAL_USAGE);
      return 2;
    }
  }
  if (out !== null && !OUT_PATH.test(out)) {
    io.stderr(`--out must be artifacts/kapiloto-v4-m2b-rehearsal/<name>.json\n`);
    return 2;
  }

  let target: RehearsalTarget;
  try {
    target = resolveRehearsalTarget(env, { linkedProjectRef: readLinkedProjectRef(io.cwd) });
  } catch (error) {
    if (!(error instanceof RehearsalRefusal)) throw error;
    const refused = { harness: HARNESS_ID, outcome: "refused", refusal: { reason: error.reason, message: error.message } };
    io.stderr(`REFUSED (${error.reason}): ${error.message}\n`);
    io.stdout(`${JSON.stringify(refused, null, 2)}\n`);
    return 2;
  }

  const evidence = await runRealPostgresRehearsal({ target, connect: io.connectorFor(target), checkOnly, rootDir: io.cwd });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assertEvidenceRedacted(serialized, target.secrets);
  if (out) io.writeFile(out, serialized);
  else io.stdout(serialized);
  const summary = evidence.experiments.map((ex) => `${ex.id}=${ex.outcome}`).join(" ");
  const failedGuards = evidence.guards.filter((g) => !g.passed).map((g) => g.name);
  io.stderr(
    `M2B real-PostgreSQL rehearsal: ${evidence.outcome.toUpperCase()}${summary ? ` (${summary})` : ""}` +
      `${failedGuards.length ? `; failed guards: ${failedGuards.join("; ")}` : ""}` +
      `${evidence.cleanup.ran ? `; cleanup M2C ${evidence.cleanup.error ? "INCOMPLETE" : "verified twice"}` : ""}\n`,
  );
  if (evidence.outcome === "pass" || evidence.outcome === "checked") return 0;
  return evidence.outcome === "refused" ? 2 : 1;
}
