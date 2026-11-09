import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { D064_ROUTED_WORKER_COMMAND } from "./test-support/d064-routed-worker-command";
import { createMigratedDatabase, seedRoundWithRunningRun } from "./test-support/pglite-migrations";

/**
 * D-065 / issue #60: the reviewed research-worker scheduler drift check and
 * reconciliation template (docs/operations/sql), executed verbatim on the real
 * migration chain, exactly as an operator pastes them.
 */

const ROOT = process.cwd();
const SQL_DIR = join(ROOT, "docs", "operations", "sql");
const CHECK = readFileSync(join(SQL_DIR, "kapiloto-research-worker-scheduler-check.sql"), "utf8");
const RECONCILE = readFileSync(join(SQL_DIR, "kapiloto-research-worker-scheduler-reconcile.sql"), "utf8");
const WORKER_JOB = "kapiloto-research-worker-every-2-min";
const LIVE_SYNC_JOB = "kapiloto-live-sync-every-2-min";

// D-064's target guard. A project counts as having it once the migration
// ledger records it or live sync already runs its routed command.
const GUARD_MIGRATION = "20261108100000_kapiloto_scheduler_target_guard_v1.sql";
const GUARD_PATTERN = /_kapiloto_scheduler_target_guard_v1\.sql$/;
const GUARD_VERSION = "20261108100000";
const GUARD_NAME = "kapiloto_scheduler_target_guard_v1";

// Production's research-worker command hash, read 2026-11-08 by the
// independent PR #59 review (normalized SHA-256).
const PRODUCTION_WORKER_SHA256 = "6c5cafc2bee207442366050772e437ccdb225c97bb52253d137857b2f44c9252";
// The only worker hash the D-064 target-guard migration (PR #59) rewrites.
const D064_ACCEPTED_WORKER_SHA256 = "b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453";
// What D-064 rewrites the worker and live sync to.
const D064_ROUTED_WORKER_SHA256 = "afd9c6ea76bae2577984cbc05f1239c7d3f65a8324c130c6b725335d06655ebd";
const D064_ROUTED_LIVE_SYNC_SHA256 = "f45be91f919fe489b6b01e0987942b76790573cff900cf9b1c35febf829e096c";
// An http(s) URL with a host; the routed command's `^https://[^[:space:]]+$` check is not one.
const LITERAL_URL = /https?:\/\/[a-z0-9]/i;

const lf = (text: string) => text.replace(/\r\n/g, "\n");
const normalize = (command: string) => command.replace(/\s+/g, " ").trim();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const commandSha = (command: string) => sha256(normalize(command));
const cronBodies = (sql: string) => [...sql.matchAll(/\$cron\$([\s\S]*?)\$cron\$/g)].map((m) => m[1]);
const migrationBodies = (file: string) => cronBodies(readFileSync(join(ROOT, "supabase", "migrations", file), "utf8"));
const migrationBody = (file: string) => migrationBodies(file).at(-1)!;

const [GUARD_LIVE_SYNC, GUARD_WORKER] = migrationBodies(GUARD_MIGRATION);
const BODY = {
  single: migrationBody("20261020112327_kapiloto_research_worker_scheduler_v1.sql"),
  parallel: migrationBody("20261020114109_kapiloto_research_worker_parallelism_v1.sql"),
  guard: migrationBody("20261020120216_kapiloto_research_worker_concurrency_guard_v1.sql"),
  routed: D064_ROUTED_WORKER_COMMAND,
};
const LIVE_SYNC_BODY = { legacy: migrationBody("20261020101804_live_sync_scheduler_v1.sql"), routed: GUARD_LIVE_SYNC };
// The template's two commands: before D-064 (hard-coded) and after it (routed).
const [HARD_CODED_IN_TEMPLATE, ROUTED_IN_TEMPLATE] = cronBodies(RECONCILE);
const MUTANTS = {
  threeSlots: BODY.guard.replace("greatest(0, 2 - live_running)", "greatest(0, 3 - live_running)"),
  finalizerSlot2: BODY.guard.replace("worker_slot.slot_no = 1", "worker_slot.slot_no = 2"),
  alwaysFinalize: BODY.guard.replace("worker_slot.slot_no = 1", "true"),
};

type State = {
  jobname: string;
  desired: string | null;
  job_count: number;
  jobid: number | null;
  active: boolean | null;
  schedule: string | null;
  username: string | null;
  database: string | null;
  command_sha256: string | null;
  definition: string | null;
  routing: string | null;
  active_runs: number;
  nonterminal_attempts: number;
  d064_recorded: boolean;
  d064_live_sync_routed: boolean;
  rewrite_routing: string;
  status: string;
  action: string;
  detail: string;
  confirm_token: string | null;
};
type Params = { desired?: string; confirm?: string; reason?: string };

/** The read-only check, inside a READ ONLY transaction: it cannot write. */
async function check(db: PGlite, desired?: string): Promise<State> {
  return db.transaction(async (tx) => {
    await tx.exec("set transaction read only");
    if (desired !== undefined) await tx.query("select set_config('kapiloto_scheduler.desired', $1, true)", [desired]);
    const row = (await tx.query<State>(CHECK)).rows[0];
    return { ...row, jobid: row.jobid == null ? null : Number(row.jobid) };
  });
}

/** One operator execution of the reconcile template; an exception rolls it all back. */
async function reconcile(db: PGlite, params: Params): Promise<string[]> {
  const notices: string[] = [];
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(params)) {
      await tx.query("select set_config($1, $2, true)", [`kapiloto_scheduler.${key}`, value]);
    }
    await tx.exec(RECONCILE, { onNotice: (notice) => notices.push(notice.message ?? "") });
  });
  return notices;
}

type JobRow = { jobid: number; jobname: string; schedule: string; command: string; active: boolean; username: string; database: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuditRow = { action: string; entity_id: string; metadata: Record<string, any> };

/** Everything the reconciliation could conceivably touch. */
async function snapshot(db: PGlite) {
  const jobs = await db.query<JobRow>("select jobid::int, jobname, schedule, command, active, username, database from cron.job order by jobid");
  const audit = await db.query<AuditRow>("select action, entity_id, metadata from public.admin_audit_log order by id");
  const vault = await db.query<{ name: string; secret: string }>("select name, secret from vault.secrets order by name");
  const ledger = await db.query<{ version: string; name: string | null }>(
    "select version, name from supabase_migrations.schema_migrations order by version",
  );
  return { jobs: jobs.rows, audit: audit.rows, vault: vault.rows, ledger: ledger.rows };
}

async function workerJobId(db: PGlite): Promise<number> {
  return Number((await db.query<{ jobid: number }>("select jobid from cron.job where jobname = $1", [WORKER_JOB])).rows[0].jobid);
}

async function setWorkerCommand(db: PGlite, command: string): Promise<void> {
  await db.query("select cron.alter_job(job_id := $1, command := $2)", [await workerJobId(db), command]);
}

async function setWorkerActive(db: PGlite, active: boolean): Promise<void> {
  await db.query("select cron.alter_job(job_id := $1, active := $2)", [await workerJobId(db), active]);
}

/**
 * Production as the PR #59 review found it: D-064 not applied yet (no ledger
 * row, live sync hard-coded) and one active job running the historical
 * single-call body.
 */
async function productionDrift(): Promise<PGlite> {
  const db = await createMigratedDatabase({ exclude: GUARD_PATTERN });
  await setWorkerCommand(db, BODY.single);
  return db;
}

/** The same drift recurring after D-064 is applied: the ledger records it and live sync is routed. */
async function postD064Drift(command: string = BODY.single): Promise<PGlite> {
  const db = await createMigratedDatabase();
  await setWorkerCommand(db, command);
  return db;
}

async function setLiveSyncCommand(db: PGlite, command: string): Promise<void> {
  const row = await db.query<{ jobid: number }>("select jobid from cron.job where jobname = $1", [LIVE_SYNC_JOB]);
  await db.query("select cron.alter_job(job_id := $1, command := $2)", [Number(row.rows[0].jobid), command]);
}

/** The D-064 evidence and what a rewrite would install, as the check reports them. */
const d064Signals = (state: State) => [state.d064_recorded, state.d064_live_sync_routed, state.rewrite_routing];
/** Everything else the check reports; D-064 must never change it. */
const withoutD064Signals = ({ d064_recorded, d064_live_sync_routed, rewrite_routing, detail, ...rest }: State) => rest;

const tokenFor = (state: Pick<State, "jobid" | "command_sha256" | "active">, action: string) =>
  `${action}:${WORKER_JOB}:jobid=${state.jobid}:sha=${state.command_sha256!.slice(0, 16)}:active=${state.active}`;

// ---------------------------------------------------------------------------
// The reviewed SQL itself
// ---------------------------------------------------------------------------

test("the check is one read-only query and the template's only writes are alter_job and one audit row", () => {
  const code = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
  const checkCode = code(CHECK);
  assert.doesNotMatch(checkCode, /\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|comment|do|perform|set_config)\b/i);
  assert.equal(checkCode.replace(/;\s*$/, "").includes(";"), false, "one statement");

  const reconcileCode = code(RECONCILE.replace(/\$cron\$[\s\S]*?\$cron\$/g, "''"));
  assert.doesNotMatch(reconcileCode, /\b(update|delete|merge|truncate|create|drop|grant|revoke|comment)\b/i);
  assert.doesNotMatch(reconcileCode, /\balter\s+(table|function|role|schema)\b/i);
  assert.doesNotMatch(reconcileCode, /\bcron\.(schedule|unschedule|schedule_in_database)\s*\(/i);
  assert.deepEqual([...reconcileCode.matchAll(/cron\.alter_job\(([^)]*)\)/g)].map((m) => m[1]), [
    "job_id := v_before.jobid, command := v_desired_command",
    "job_id := v_before.jobid, active := false",
    "job_id := v_before.jobid, active := true",
  ]);
  assert.deepEqual([...reconcileCode.matchAll(/\binsert\s+into\s+([a-z_.]+)/gi)].map((m) => m[1]), ["public.admin_audit_log"]);
  // Outside the installed commands neither file reads Vault. Of any other job,
  // the state query reads only whether live sync's command hash is D-064's.
  const liveSyncProbe =
    /from cron\.job l\s+where l\.jobname = 'kapiloto-live-sync-every-2-min'\s+and encode\(sha256\(convert_to\(btrim\(regexp_replace\(l\.command, '\\s\+', ' ', 'g'\)\), 'UTF8'\)\), 'hex'\)\s+= '([0-9a-f]{64})'/g;
  const codeKeepingStrings = (sql: string) => lf(sql).replace(/--[^\n]*/g, "");
  for (const [sql, copies] of [[CHECK, 1], [RECONCILE.replace(/\$cron\$[\s\S]*?\$cron\$/g, "''"), 3]] as const) {
    const text = codeKeepingStrings(sql);
    assert.doesNotMatch(text, /vault\.|_target_url/);
    assert.deepEqual([...text.matchAll(liveSyncProbe)].map((m) => m[1]), Array(copies).fill(D064_ROUTED_LIVE_SYNC_SHA256));
    assert.equal(text.split("kapiloto-live-sync-every-2-min").length - 1, copies, "named only by the probe");
    assert.equal(text.split(/\bl\.command\b/).length - 1, copies, "its command is only hashed");
  }
});

test("a rewrite is ordered: READ COMMITTED check, idle-queue SHARE lock, re-derived state, then the write", () => {
  const code = RECONCILE.replace(/\r\n/g, "\n").replace(/--[^\n]*/g, "").replace(/\$cron\$[\s\S]*?\$cron\$/g, "''");
  const locks = [...code.matchAll(/\block\s+table\b[^;]*;/gi)].map((m) => m[0].replace(/\s+/g, " "));
  assert.deepEqual(locks, ["lock table public.kapiloto_research_runs, public.kapiloto_research_attempts in share mode;"]);
  const at = (needle: string) => {
    const index = code.indexOf(needle);
    assert.ok(index >= 0, needle);
    return index;
  };
  const rewriteBranch = at("if v_before.action = 'rewrite' then");
  const isolation = at("current_setting('transaction_isolation') <> 'read committed'");
  const timeout = at("perform set_config('lock_timeout', '2s', true);");
  const lock = at("lock table public.kapiloto_research_runs");
  const relock = at("select s.* into v_locked from (");
  const recheck = at("v_locked.confirm_token is distinct from v_before.confirm_token");
  const write = at("perform cron.alter_job(job_id := v_before.jobid, command := v_desired_command);");
  const pause = at("perform cron.alter_job(job_id := v_before.jobid, active := false);");
  assert.ok(at("if v_confirm is distinct from v_before.confirm_token then") < rewriteBranch, "token checked before any lock");
  assert.ok(rewriteBranch < isolation && isolation < timeout && timeout < lock && lock < relock && relock < recheck && recheck < write && write < pause);
});

test("the check and the template derive state from the same query, and the template installs exactly the chain's concurrency guard", () => {
  const region = (sql: string) => {
    const text = sql.replace(/\r\n/g, "\n");
    const start = text.indexOf("-- >>> worker scheduler state");
    const end = text.indexOf("-- <<< worker scheduler state");
    assert.ok(start >= 0 && end > start);
    return text.slice(start, end);
  };
  const shared = region(CHECK);
  const reconcileText = RECONCILE.replace(/\r\n/g, "\n");
  assert.equal(reconcileText.split(shared).length - 1, 3, "before, under the idle-queue lock and after: the check's query verbatim");
  // Exactly two commands: before D-064, the chain's hard-coded concurrency
  // guard (what D-064 accepts); after it, D-064's own routed worker command.
  assert.equal(cronBodies(RECONCILE).length, 2);
  assert.equal(lf(HARD_CODED_IN_TEMPLATE), lf(BODY.guard));
  assert.equal(commandSha(HARD_CODED_IN_TEMPLATE), D064_ACCEPTED_WORKER_SHA256);
  assert.equal(lf(ROUTED_IN_TEMPLATE), lf(GUARD_WORKER));
  assert.equal(commandSha(ROUTED_IN_TEMPLATE), D064_ROUTED_WORKER_SHA256);
  assert.doesNotMatch(ROUTED_IN_TEMPLATE, LITERAL_URL);
  assert.ok(reconcileText.includes("v_hard_coded_command constant text := $cron$" + lf(BODY.guard) + "$cron$;"));
  assert.ok(reconcileText.includes("v_routed_command constant text := $cron$" + lf(GUARD_WORKER) + "$cron$;"));
  // The command is chosen from the routing derived under the idle-queue lock, and nothing else.
  const code = reconcileText.replace(/--[^\n]*/g, "");
  assert.deepEqual(
    [...code.matchAll(/v_desired_command := ([^;]*);/g)].map((m) => normalize(m[1])),
    ["case v_install_routing when 'vault_target' then v_routed_command when 'hard_coded' then v_hard_coded_command end"],
  );
  assert.deepEqual([...code.matchAll(/v_install_routing := ([^;]*);/g)].map((m) => m[1]), ["v_locked.rewrite_routing"]);
});

test("D-064 is recognised by its ledger version and name and by its routed live-sync command", () => {
  assert.equal(GUARD_MIGRATION, `${GUARD_VERSION}_${GUARD_NAME}.sql`);
  const code = lf(CHECK).replace(/--[^\n]*/g, "");
  assert.match(code, new RegExp(`from supabase_migrations\\.schema_migrations m\\s+where m\\.version = '${GUARD_VERSION}'\\s+or m\\.name = '${GUARD_NAME}'`));
  assert.equal(commandSha(LIVE_SYNC_BODY.routed), D064_ROUTED_LIVE_SYNC_SHA256);
  assert.notEqual(commandSha(LIVE_SYNC_BODY.legacy), D064_ROUTED_LIVE_SYNC_SHA256);
  assert.match(code, /when d\.d064_recorded or d\.d064_live_sync_routed then 'vault_target'\s+else 'hard_coded'\s+end as rewrite_routing/);
});

test("the reviewed definitions are recognised by the hashes of their historical migration bodies", () => {
  assert.equal(commandSha(BODY.single), PRODUCTION_WORKER_SHA256, "production runs the scheduler_v1 body");
  const known = [...CHECK.matchAll(/\('([a-z0-9_]+)', (true|false), '([a-z_]+)', '([0-9a-f]{64})'\)/g)]
    .map(([, definition, current, routing, hash]) => ({ definition, current: current === "true", routing, hash }));
  assert.deepEqual(known, [
    { definition: "scheduler_v1_single", current: false, routing: "hard_coded", hash: commandSha(BODY.single) },
    { definition: "parallelism_v1_unconditional", current: false, routing: "hard_coded", hash: commandSha(BODY.parallel) },
    { definition: "concurrency_guard_v1", current: true, routing: "hard_coded", hash: commandSha(BODY.guard) },
    { definition: "concurrency_guard_v1", current: true, routing: "vault_target", hash: commandSha(BODY.routed) },
  ]);
  for (const [name, mutant] of Object.entries(MUTANTS)) {
    assert.notEqual(mutant, BODY.guard, name);
    assert.ok(!known.some((k) => k.hash === commandSha(mutant)), name);
  }
});

test("the D-064 routed fixture is the target-guard migration's worker body", () => {
  // PR #59 is merged: the migration must exist, exactly once, and match the pinned copy.
  const guards = readdirSync(join(ROOT, "supabase", "migrations")).filter((name) => GUARD_PATTERN.test(name));
  assert.deepEqual(guards, [GUARD_MIGRATION]);
  assert.equal(migrationBodies(GUARD_MIGRATION).length, 2);
  assert.equal(lf(GUARD_WORKER), lf(D064_ROUTED_WORKER_COMMAND));
  assert.equal(commandSha(D064_ROUTED_WORKER_COMMAND), D064_ROUTED_WORKER_SHA256);
});

// ---------------------------------------------------------------------------
// Intended semantics: what each definition actually posts
// ---------------------------------------------------------------------------

async function recordHttpPosts(db: PGlite): Promise<void> {
  await db.exec(`
    create table public.test_http_posts (n serial primary key, url text, body jsonb);
    create or replace function net.http_post(
      url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 1000
    ) returns bigint language sql as $$
      insert into public.test_http_posts (url, body) values ($1, $3) returning n::bigint
    $$;
  `);
}

async function postedBodies(db: PGlite, command: string): Promise<unknown[]> {
  await db.exec("delete from public.test_http_posts");
  await db.exec(command);
  return (await db.query<{ body: unknown }>("select body from public.test_http_posts order by n")).rows.map((r) => r.body);
}

test("the desired definition fills free capacity up to two live attempts with one finalizer; the historical ones do not", async () => {
  const db = await createMigratedDatabase();
  await recordHttpPosts(db);
  const run = (command: string) => postedBodies(db, command);
  const F = { finalizeRuns: true };
  const N = { finalizeRuns: false };

  const DESIRED_IN_TEMPLATE = HARD_CODED_IN_TEMPLATE;
  // No active run: nobody posts.
  for (const command of [DESIRED_IN_TEMPLATE, BODY.single, BODY.parallel]) assert.deepEqual(await run(command), []);

  const seed = await seedRoundWithRunningRun(db, { researchProtocolVersion: "kapiloto-research-v3" });
  const attempt = (n: number, status: "queued" | "running", leaseMinutes = 5) =>
    db.query(
      status === "queued"
        ? `insert into public.kapiloto_research_attempts (run_id, round_id, task_key, round_game_id, attempt_no, status, available_at)
           values ($1, $2, $3, $4, 1, 'queued', now() - interval '1 minute')`
        : `insert into public.kapiloto_research_attempts
             (run_id, round_id, task_key, round_game_id, attempt_no, status, worker_id, claimed_at, heartbeat_at, lease_expires_at)
           values ($1, $2, $3, $4, 1, 'running', 'test-worker', now(), now(), now() + make_interval(mins => ${leaseMinutes}))`,
      [seed.runId, seed.roundId, `fixture:${n}`, seed.fixtures[n - 1].roundGameId],
    );

  // Active run, every task terminal: exactly one finalizer.
  assert.deepEqual(await run(DESIRED_IN_TEMPLATE), [F]);
  // Work available, nothing running: two slots, only slot 1 finalizes.
  await attempt(1, "queued");
  assert.deepEqual(await run(DESIRED_IN_TEMPLATE), [F, N]);
  // One live lease: one free slot.
  await attempt(2, "running");
  assert.deepEqual(await run(DESIRED_IN_TEMPLATE), [F]);
  // Two live leases: at capacity, nobody posts.
  await attempt(3, "running");
  assert.deepEqual(await run(DESIRED_IN_TEMPLATE), []);
  // The historical bodies ignore capacity: they post (and finalize, {} defaults
  // to finalizeRuns=true in the worker route) even with two live leases.
  assert.deepEqual(await run(BODY.single), [{}]);
  assert.deepEqual(await run(BODY.parallel), [{}, {}]);

  await db.exec("delete from public.kapiloto_research_attempts where task_key in ('fixture:2', 'fixture:3')");
  const expected = await run(DESIRED_IN_TEMPLATE);
  assert.deepEqual(expected, [F, N]);
  // The D-064 routed form, which the template installs after D-064, has the
  // same semantics once its target is set, and posts nothing without it.
  for (const command of [BODY.routed, ROUTED_IN_TEMPLATE]) assert.deepEqual(await run(command), [], "no target, no post");
  await db.query("select vault.create_secret('https://worker.example/api/internal/kapiloto/worker', 'kapiloto_research_worker_target_url', 't')");
  for (const command of [BODY.routed, ROUTED_IN_TEMPLATE]) assert.deepEqual(await run(command), expected);
  assert.deepEqual(
    (await db.query<{ url: string }>("select distinct url from public.test_http_posts")).rows.map((r) => r.url),
    ["https://worker.example/api/internal/kapiloto/worker"],
  );
  // Each mutant of the slot / finalizer rule changes what is posted.
  for (const [name, mutant] of Object.entries(MUTANTS)) {
    assert.notDeepEqual(await run(mutant), expected, name);
  }
  await db.close();
});

// ---------------------------------------------------------------------------
// Drift classification
// ---------------------------------------------------------------------------

test("a freshly migrated project is in sync; no desired state means no action", async () => {
  const db = await createMigratedDatabase();
  const state = await check(db, "enabled");
  assert.equal(state.job_count, 1);
  assert.equal(state.definition, "concurrency_guard_v1");
  // The chain ends with the D-064 target guard, which routes the worker through Vault.
  assert.equal(state.routing, "vault_target");
  assert.equal(state.command_sha256, commandSha(BODY.routed));
  assert.deepEqual(d064Signals(state), [true, true, "vault_target"]);
  assert.equal(state.status, "in_sync");
  assert.equal(state.action, "none");
  assert.equal(state.confirm_token, null);
  for (const desired of [undefined, "", "on", "ENABLED"]) {
    const unset = await check(db, desired);
    assert.equal(unset.status, "desired_state_required", String(desired));
    assert.equal(unset.action, "refuse");
    assert.equal(unset.confirm_token, null);
  }
  await db.close();
});

test("the exact production drift is detected as the historical single-call body and planned as a rewrite", async () => {
  const db = await productionDrift();
  const state = await check(db, "enabled");
  assert.equal(state.command_sha256, PRODUCTION_WORKER_SHA256);
  assert.equal(state.definition, "scheduler_v1_single");
  assert.equal(state.active, true);
  assert.equal(state.active_runs, 0);
  assert.equal(state.nonterminal_attempts, 0);
  assert.equal(state.status, "wrong_definition");
  assert.equal(state.action, "rewrite");
  assert.equal(state.confirm_token, tokenFor(state, "rewrite"));
  assert.match(state.confirm_token!, /^rewrite:kapiloto-research-worker-every-2-min:jobid=\d+:sha=6c5cafc2bee20744:active=true$/);
  // D-064 is not applied in production yet, so a rewrite installs the hard-coded guard.
  assert.deepEqual(d064Signals(state), [false, false, "hard_coded"]);
  assert.match(state.detail, /hard-coded concurrency_guard_v1 \(D-064 is not applied\)/);

  await setWorkerCommand(db, BODY.parallel);
  const parallel = await check(db, "enabled");
  assert.equal(parallel.definition, "parallelism_v1_unconditional");
  assert.equal(parallel.status, "wrong_definition");
  assert.equal(parallel.action, "rewrite");
  await db.close();
});

test("absent, inactive, duplicate, unknown and wrong-schedule jobs are each classified, and only safe actions are offered", async () => {
  const db = await createMigratedDatabase();
  const jobid = await workerJobId(db);

  await setWorkerActive(db, false);
  let state = await check(db, "enabled");
  assert.deepEqual([state.status, state.action, state.definition], ["inactive", "resume", "concurrency_guard_v1"]);
  assert.equal(state.confirm_token, tokenFor(state, "resume"));
  assert.deepEqual([(await check(db, "paused")).status, (await check(db, "paused")).action], ["in_sync", "none"]);

  await setWorkerCommand(db, BODY.single);
  state = await check(db, "enabled");
  assert.deepEqual([state.status, state.action], ["inactive_wrong_definition", "rewrite"]);
  await setWorkerActive(db, true);

  await setWorkerCommand(db, MUTANTS.threeSlots);
  state = await check(db, "enabled");
  assert.deepEqual([state.definition, state.status, state.action, state.confirm_token], ["unknown", "unknown_definition", "refuse", null]);
  // Pausing is always available: it only stops calls.
  assert.deepEqual([(await check(db, "paused")).status, (await check(db, "paused")).action], ["running_while_paused", "pause"]);

  await setWorkerCommand(db, BODY.guard);
  await db.query("select cron.alter_job(job_id := $1, schedule := '*/5 * * * *')", [jobid]);
  state = await check(db, "enabled");
  assert.deepEqual([state.status, state.action], ["wrong_schedule", "refuse"]);
  await db.query("select cron.alter_job(job_id := $1, schedule := '*/2 * * * *')", [jobid]);

  await db.query(
    "insert into cron.job (jobname, schedule, command, username) values ($1, '*/2 * * * *', $2, 'other_owner')",
    [WORKER_JOB, BODY.guard],
  );
  for (const desired of ["enabled", "paused"]) {
    state = await check(db, desired);
    assert.deepEqual([state.job_count, state.status, state.action, state.jobid, state.confirm_token], [2, "duplicate", "refuse", null, null]);
  }
  await db.exec("delete from cron.job where username = 'other_owner'");

  await db.exec(`select cron.unschedule('${WORKER_JOB}')`);
  state = await check(db, "enabled");
  assert.deepEqual([state.job_count, state.status, state.action, state.definition, state.confirm_token], [0, "absent", "refuse", null, null]);
  assert.deepEqual([(await check(db, "paused")).status, (await check(db, "paused")).action], ["in_sync", "none"]);
  await db.close();
});

// ---------------------------------------------------------------------------
// The write template
// ---------------------------------------------------------------------------

test("a dry run reports the plan and token and changes nothing", async () => {
  const db = await productionDrift();
  const before = await snapshot(db);
  const state = await check(db, "enabled");
  const notices = await reconcile(db, { desired: "enabled" });
  assert.ok(notices.some((n) => n.includes("DRY RUN") && n.includes(state.confirm_token!)), notices.join("\n"));
  await reconcile(db, { desired: "enabled", confirm: "   ", reason: "issue #60" });
  assert.deepEqual(await snapshot(db), before);
  await db.close();
});

test("a wrong or stale confirmation, or a missing reason, is refused and changes nothing", async () => {
  const db = await productionDrift();
  const state = await check(db, "enabled");
  const before = await snapshot(db);
  const wrong = [
    "yes",
    state.confirm_token!.toUpperCase(),
    tokenFor(state, "resume"),
    tokenFor(state, "pause"),
    tokenFor({ ...state, jobid: state.jobid! + 1 }, "rewrite"),
    tokenFor({ ...state, command_sha256: D064_ACCEPTED_WORKER_SHA256 }, "rewrite"),
    tokenFor({ ...state, active: false }, "rewrite"),
  ];
  for (const confirm of wrong) {
    await assert.rejects(reconcile(db, { desired: "enabled", confirm, reason: "issue #60" }), /does not match the current state/, confirm);
  }
  await assert.rejects(reconcile(db, { desired: "enabled", confirm: state.confirm_token! }), /set kapiloto_scheduler\.reason/);
  await assert.rejects(reconcile(db, { confirm: state.confirm_token!, reason: "issue #60" }), /refusing \(desired_state_required\)/);
  assert.deepEqual(await snapshot(db), before);
  await db.close();
});

test("the confirmed rewrite installs the chain's concurrency guard in place, audits it, and is then idempotent", async () => {
  const db = await productionDrift();
  const state = await check(db, "enabled");
  const beforeJobs = (await snapshot(db)).jobs;
  const notices = await reconcile(db, { desired: "enabled", confirm: state.confirm_token!, reason: "issue #60" });
  assert.ok(notices.some((n) => n.includes("APPLIED rewrite")), notices.join("\n"));

  const after = await snapshot(db);
  const worker = after.jobs.find((j) => j.jobname === WORKER_JOB)!;
  const workerBefore = beforeJobs.find((j) => j.jobname === WORKER_JOB)!;
  assert.deepEqual({ ...worker, command: null }, { ...workerBefore, command: null }, "jobid, schedule, active, owner unchanged");
  assert.equal(normalize(String(worker.command)), normalize(BODY.guard));
  // Exactly the command the D-064 migration expects before routing the target.
  assert.equal(commandSha(String(worker.command)), D064_ACCEPTED_WORKER_SHA256);
  // No other job changed.
  assert.deepEqual(after.jobs.filter((j) => j.jobname !== WORKER_JOB), beforeJobs.filter((j) => j.jobname !== WORKER_JOB));

  assert.equal(after.audit.length, 1);
  const audit = after.audit[0];
  assert.equal(audit.action, "kapiloto_scheduler_reconcile");
  assert.equal(audit.entity_id, WORKER_JOB);
  assert.equal(audit.metadata.action, "rewrite");
  assert.equal(audit.metadata.decision, "D-065");
  assert.equal(audit.metadata.idle_queue_locked, true);
  assert.deepEqual([audit.metadata.before.username, audit.metadata.before.database], ["postgres", "postgres"]);
  assert.equal(audit.metadata.reason, "issue #60");
  assert.equal(audit.metadata.before.definition, "scheduler_v1_single");
  assert.equal(audit.metadata.after.definition, "concurrency_guard_v1");
  assert.equal(audit.metadata.after.routing, "hard_coded");
  assert.equal(audit.metadata.after.command_sha256, D064_ACCEPTED_WORKER_SHA256);
  assert.ok(notices.some((n) => n.includes("rewrite_routing=hard_coded (d064_recorded=f d064_live_sync_routed=f)")), notices.join("\n"));

  const synced = await check(db, "enabled");
  assert.deepEqual([synced.status, synced.action], ["in_sync", "none"]);
  // Re-running with the now-stale token, or any token, changes nothing.
  for (const confirm of [state.confirm_token!, "anything"]) {
    const again = await reconcile(db, { desired: "enabled", confirm, reason: "issue #60" });
    assert.ok(again.some((n) => n.includes("in sync; nothing changed")));
  }
  assert.deepEqual(await snapshot(db), after);
  await db.close();
});

test("a rewrite waits for an idle research queue, while a pause is always possible", async () => {
  const db = await productionDrift();
  await seedRoundWithRunningRun(db, { researchProtocolVersion: "kapiloto-research-v3" });
  const state = await check(db, "enabled");
  assert.deepEqual([state.status, state.action, state.active_runs, state.confirm_token], ["wrong_definition", "refuse", 1, null]);
  const before = await snapshot(db);
  await assert.rejects(
    reconcile(db, { desired: "enabled", confirm: tokenFor(state, "rewrite"), reason: "issue #60" }),
    /refusing \(wrong_definition\): research work is queued or running/,
  );
  assert.deepEqual(await snapshot(db), before);

  const paused = await check(db, "paused");
  assert.equal(paused.action, "pause");
  await reconcile(db, { desired: "paused", confirm: paused.confirm_token!, reason: "incident" });
  const worker = (await snapshot(db)).jobs.find((j) => j.jobname === WORKER_JOB)!;
  assert.equal(worker.active, false);
  assert.equal(commandSha(String(worker.command)), PRODUCTION_WORKER_SHA256, "pause keeps the command");
  await db.close();
});

type LockRow = { relation: string; mode: string; granted: boolean };
const RESEARCH_TABLES = ["kapiloto_research_attempts", "kapiloto_research_runs"];

/** Runs the template and reads this backend's research-table locks before the transaction ends. */
async function reconcileAndInspectLocks(db: PGlite, params: Params) {
  return db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(params)) {
      await tx.query("select set_config($1, $2, true)", [`kapiloto_scheduler.${key}`, value]);
    }
    await tx.exec(RECONCILE);
    const locks = await tx.query<LockRow>(
      `select c.relname as relation, l.mode, l.granted
       from pg_locks l join pg_class c on c.oid = l.relation
       where l.locktype = 'relation' and l.pid = pg_backend_pid()
         and c.relnamespace = 'public'::regnamespace and c.relname = any($1)
       order by c.relname, l.mode`,
      [RESEARCH_TABLES],
    );
    const timeout = (await tx.query<{ lock_timeout: string }>("select current_setting('lock_timeout') as lock_timeout")).rows[0];
    return { locks: locks.rows, lockTimeout: timeout.lock_timeout };
  });
}

test("the rewrite holds a SHARE lock on research runs and attempts until commit; pause and resume take none", async () => {
  const db = await productionDrift();
  const rewrite = await check(db, "enabled");
  const held = await reconcileAndInspectLocks(db, { desired: "enabled", confirm: rewrite.confirm_token!, reason: "issue #60" });
  // SHARE conflicts with the ROW EXCLUSIVE lock of every INSERT/UPDATE/DELETE,
  // so no run or attempt can appear or change status before this commits.
  assert.deepEqual(
    held.locks.filter((l) => l.mode === "ShareLock").map((l) => [l.relation, l.granted]),
    RESEARCH_TABLES.map((t) => [t, true]),
  );
  assert.equal(held.lockTimeout, "2s");
  assert.equal((await check(db, "enabled")).status, "in_sync");

  const pause = await check(db, "paused");
  const paused = await reconcileAndInspectLocks(db, { desired: "paused", confirm: pause.confirm_token!, reason: "incident" });
  assert.deepEqual(paused.locks.filter((l) => l.mode !== "AccessShareLock"), [], "an emergency pause never waits for research writers");
  const resume = await check(db, "enabled");
  const resumed = await reconcileAndInspectLocks(db, { desired: "enabled", confirm: resume.confirm_token!, reason: "approved" });
  assert.deepEqual(resumed.locks.filter((l) => l.mode !== "AccessShareLock"), []);
  const audit = (await snapshot(db)).audit.map((a) => [a.metadata.action, a.metadata.idle_queue_locked]);
  assert.deepEqual(audit, [["rewrite", true], ["pause", false], ["resume", false]]);
  await db.close();
});

test("a rewrite outside READ COMMITTED is refused before taking the lock, and nothing changes", async () => {
  const db = await productionDrift();
  const state = await check(db, "enabled");
  const before = await snapshot(db);
  for (const level of ["repeatable read", "serializable"]) {
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec(`set transaction isolation level ${level}`);
        for (const [key, value] of Object.entries({ desired: "enabled", confirm: state.confirm_token!, reason: "issue #60" })) {
          await tx.query("select set_config($1, $2, true)", [`kapiloto_scheduler.${key}`, value]);
        }
        await tx.exec(RECONCILE);
      }),
      new RegExp(`run in READ COMMITTED \\(got ${level}\\)`),
    );
  }
  assert.deepEqual(await snapshot(db), before);
  await db.close();
});

test("a job owned by another role or in another database is unexpected_job_identity and is never written, not even paused", async () => {
  for (const [column, value] of [["username", "other_owner"], ["database", "other_db"]] as const) {
    for (const command of [BODY.guard, BODY.single]) {
      const db = await createMigratedDatabase();
      await setWorkerCommand(db, command);
      const jobid = await workerJobId(db);
      await db.query(`select cron.alter_job(job_id := $1, ${column} := $2)`, [jobid, value]);
      for (const desired of ["enabled", "paused"]) {
        const state = await check(db, desired);
        assert.equal(state[column], value);
        assert.deepEqual([state.status, state.action, state.confirm_token], ["unexpected_job_identity", "refuse", null], `${column} ${desired}`);
      }
      const before = await snapshot(db);
      // Even a token minted for the job's otherwise-valid state is refused.
      const asIfExpected = { jobid, command_sha256: commandSha(command), active: true };
      for (const [desired, confirm] of [
        ["enabled", tokenFor(asIfExpected, "rewrite")],
        ["paused", tokenFor(asIfExpected, "pause")],
        ["enabled", undefined],
      ] as const) {
        await assert.rejects(
          reconcile(db, { desired, ...(confirm ? { confirm } : {}), reason: "r" }),
          /refusing \(unexpected_job_identity\)/,
          `${column} ${desired}`,
        );
      }
      assert.deepEqual(await snapshot(db), before);
      await db.close();
    }
  }
});

test("absent, duplicate and unknown jobs are refused by the template and nothing changes", async () => {
  const db = await createMigratedDatabase();
  await setWorkerCommand(db, MUTANTS.finalizerSlot2);
  let before = await snapshot(db);
  await assert.rejects(reconcile(db, { desired: "enabled", confirm: "x", reason: "r" }), /refusing \(unknown_definition\)/);
  assert.deepEqual(await snapshot(db), before);

  await setWorkerCommand(db, BODY.single);
  await db.query(
    "insert into cron.job (jobname, schedule, command, username) values ($1, '*/2 * * * *', $2, 'other_owner')",
    [WORKER_JOB, BODY.single],
  );
  before = await snapshot(db);
  for (const desired of ["enabled", "paused"]) {
    await assert.rejects(reconcile(db, { desired, confirm: "x", reason: "r" }), /refusing \(duplicate\)/);
  }
  assert.deepEqual(await snapshot(db), before);

  await db.exec("delete from cron.job where jobname = 'kapiloto-research-worker-every-2-min'");
  before = await snapshot(db);
  await assert.rejects(reconcile(db, { desired: "enabled", confirm: "x", reason: "r" }), /refusing \(absent\).*never a reconciliation/);
  assert.ok((await reconcile(db, { desired: "paused" })).some((n) => n.includes("in sync")));
  assert.deepEqual(await snapshot(db), before);
  await db.close();
});

test("a paused scheduler is never resumed implicitly", async () => {
  const db = await productionDrift();
  // Pause the drifted production job.
  const pause = await check(db, "paused");
  await reconcile(db, { desired: "paused", confirm: pause.confirm_token!, reason: "incident" });
  const paused = await snapshot(db);
  assert.equal(paused.jobs.find((j) => j.jobname === WORKER_JOB)!.active, false);

  // With desired = paused there is nothing to do, whatever the token.
  const asEnabled = await check(db, "enabled");
  for (const confirm of [pause.confirm_token!, tokenFor(asEnabled, "resume"), tokenFor(asEnabled, "rewrite"), "resume"]) {
    assert.ok((await reconcile(db, { desired: "paused", confirm, reason: "r" })).some((n) => n.includes("in sync")));
  }
  assert.equal((await snapshot(db)).jobs.length, paused.jobs.length);
  assert.deepEqual((await snapshot(db)).jobs, paused.jobs);

  // Desired = enabled on a paused, drifted job: the rewrite keeps it paused.
  assert.deepEqual([asEnabled.status, asEnabled.action], ["inactive_wrong_definition", "rewrite"]);
  await reconcile(db, { desired: "enabled", confirm: asEnabled.confirm_token!, reason: "issue #60" });
  let worker = (await snapshot(db)).jobs.find((j) => j.jobname === WORKER_JOB)!;
  assert.equal(worker.active, false);
  assert.equal(commandSha(String(worker.command)), D064_ACCEPTED_WORKER_SHA256);

  // Resuming is its own action with its own token; no other token resumes.
  const resume = await check(db, "enabled");
  assert.deepEqual([resume.status, resume.action], ["inactive", "resume"]);
  for (const confirm of [asEnabled.confirm_token!, tokenFor(resume, "rewrite"), tokenFor(resume, "pause")]) {
    await assert.rejects(reconcile(db, { desired: "enabled", confirm, reason: "r" }), /does not match/);
  }
  assert.ok((await reconcile(db, { desired: "enabled" })).some((n) => n.includes("DRY RUN")));
  worker = (await snapshot(db)).jobs.find((j) => j.jobname === WORKER_JOB)!;
  assert.equal(worker.active, false, "still paused after every refused or dry attempt");

  await reconcile(db, { desired: "enabled", confirm: resume.confirm_token!, reason: "approved resume" });
  const resumed = await check(db, "enabled");
  assert.deepEqual([resumed.active, resumed.status], [true, "in_sync"]);
  const actions = (await snapshot(db)).audit.map((a) => a.metadata.action);
  assert.deepEqual(actions, ["pause", "rewrite", "resume"]);
  await db.close();
});

test("a routed job is in sync, and Vault targets change neither the classification nor the rewrite", async () => {
  const db = await createMigratedDatabase();
  await setWorkerCommand(db, BODY.routed);
  const routed = await check(db, "enabled");
  assert.deepEqual([routed.definition, routed.routing, routed.status, routed.action], ["concurrency_guard_v1", "vault_target", "in_sync", "none"]);
  const before = await snapshot(db);
  assert.ok((await reconcile(db, { desired: "enabled", confirm: "x", reason: "r" })).some((n) => n.includes("in sync")));
  assert.deepEqual(await snapshot(db), before);

  // The classification is identical with and without the D-064 target secrets.
  const drifted = await productionDrift();
  const without = await check(drifted, "enabled");
  await drifted.query("select vault.create_secret('https://worker.example/api/internal/kapiloto/worker', 'kapiloto_research_worker_target_url', 't')");
  await drifted.query("select vault.create_secret('https://live.example/functions/v1/kapiloto-live-sync', 'kapiloto_live_sync_target_url', 't')");
  assert.deepEqual(await check(drifted, "enabled"), without);
  const vaultBefore = (await snapshot(drifted)).vault;
  const liveSyncBefore = (await snapshot(drifted)).jobs.find((j) => j.jobname === LIVE_SYNC_JOB);
  await reconcile(drifted, { desired: "enabled", confirm: without.confirm_token!, reason: "issue #60" });
  assert.deepEqual((await snapshot(drifted)).vault, vaultBefore, "no Vault read or write");
  assert.deepEqual((await snapshot(drifted)).jobs.find((j) => j.jobname === LIVE_SYNC_JOB), liveSyncBefore);
  // Target secrets alone do not make D-064 applied: still the hard-coded guard.
  const installed = (await snapshot(drifted)).jobs.find((j) => j.jobname === WORKER_JOB)!;
  assert.equal(commandSha(installed.command), D064_ACCEPTED_WORKER_SHA256);
  await db.close();
  await drifted.close();
});

// ---------------------------------------------------------------------------
// After D-064: a recurring drift is repaired to the routed command
// ---------------------------------------------------------------------------

async function recordLedger(db: PGlite, version: string, name: string | null): Promise<void> {
  await db.query("insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)", [version, name]);
}

test("D-064 counts as applied when the ledger records it by version or name, or live sync runs its routed command; only the rewrite target changes", async () => {
  // Before D-064: neither signal.
  const pre = await productionDrift();
  const baseline = await check(pre, "enabled");
  assert.deepEqual(d064Signals(baseline), [false, false, "hard_coded"]);
  assert.ok(!(await snapshot(pre)).ledger.some((row) => row.version === GUARD_VERSION || row.name === GUARD_NAME));

  // Ledger rows that are not D-064 do not count.
  for (const [version, name] of [
    ["20261108100001", "kapiloto_scheduler_target_guard_v2"],
    ["20261108100002", "kapiloto_scheduler_target_guard"],
    ["2026110810000", null],
  ] as const) {
    await recordLedger(pre, version, name);
    assert.deepEqual(d064Signals(await check(pre, "enabled")), [false, false, "hard_coded"], `${version} ${name}`);
    await pre.query("delete from supabase_migrations.schema_migrations where version = $1", [version]);
  }

  // D-064 recorded by its version (a ledger without names), or by its name
  // under the version the migration tool chose: either is enough.
  for (const [version, name] of [[GUARD_VERSION, null], ["20261109123456", GUARD_NAME]] as const) {
    await recordLedger(pre, version, name);
    const state = await check(pre, "enabled");
    assert.deepEqual(d064Signals(state), [true, false, "vault_target"], `${version} ${name}`);
    assert.match(state.detail, /Vault-routed concurrency_guard_v1 \(D-064 is applied\)/);
    assert.deepEqual(withoutD064Signals(state), withoutD064Signals(baseline), "status, action and token unchanged");
    await pre.query("delete from supabase_migrations.schema_migrations where version = $1", [version]);
  }

  // D-064 applied without a ledger row: live sync already runs its routed
  // command (whitespace does not matter); a near miss does not count.
  await setLiveSyncCommand(pre, LIVE_SYNC_BODY.routed.replace(/\n/g, "\r\n  "));
  const viaLiveSync = await check(pre, "enabled");
  assert.deepEqual(d064Signals(viaLiveSync), [false, true, "vault_target"]);
  assert.deepEqual(withoutD064Signals(viaLiveSync), withoutD064Signals(baseline));
  const nearMiss = LIVE_SYNC_BODY.routed.replace("interval '30 minutes'", "interval '31 minutes'");
  assert.notEqual(nearMiss, LIVE_SYNC_BODY.routed);
  await setLiveSyncCommand(pre, nearMiss);
  assert.deepEqual(d064Signals(await check(pre, "enabled")), [false, false, "hard_coded"]);
  await pre.close();

  // After D-064: both signals. Either alone still routes; with neither (no
  // ledger row and live sync absent) the project is indistinguishable from
  // one before D-064.
  const post = await postD064Drift();
  assert.deepEqual(d064Signals(await check(post, "enabled")), [true, true, "vault_target"]);
  await post.exec(`select cron.unschedule('${LIVE_SYNC_JOB}')`);
  assert.deepEqual(d064Signals(await check(post, "enabled")), [true, false, "vault_target"]);
  await post.query("delete from supabase_migrations.schema_migrations where version = $1", [GUARD_VERSION]);
  assert.deepEqual(d064Signals(await check(post, "enabled")), [false, false, "hard_coded"]);
  await post.close();
});

test("after D-064 a recurring drift is repaired to D-064's routed command, never to a hard-coded endpoint", async () => {
  const cases = [
    { label: "single-call body, active", command: BODY.single, active: true, status: "wrong_definition" },
    { label: "two-call body, active", command: BODY.parallel, active: true, status: "wrong_definition" },
    { label: "single-call body, paused", command: BODY.single, active: false, status: "inactive_wrong_definition" },
  ];
  for (const { label, command, active, status } of cases) {
    const db = await postD064Drift(command);
    if (!active) await setWorkerActive(db, false);
    const state = await check(db, "enabled");
    assert.deepEqual([state.status, state.action, state.active], [status, "rewrite", active], label);
    assert.deepEqual(d064Signals(state), [true, true, "vault_target"], label);
    assert.match(state.detail, /Vault-routed concurrency_guard_v1 \(D-064 is applied\)/, label);
    // The token keeps its form: action, job, jobid, command hash, active flag.
    assert.equal(state.confirm_token, tokenFor(state, "rewrite"), label);

    const dry = await reconcile(db, { desired: "enabled" });
    assert.ok(dry.some((n) => n.includes("DRY RUN") && n.includes(state.confirm_token!)), label);
    assert.ok(dry.some((n) => n.includes("rewrite_routing=vault_target (d064_recorded=t d064_live_sync_routed=t)")), label);

    const before = await snapshot(db);
    const notices = await reconcile(db, { desired: "enabled", confirm: state.confirm_token!, reason: "drift after D-064" });
    assert.ok(notices.some((n) => n.includes("APPLIED rewrite") && n.includes("routing=vault_target")), notices.join("\n"));
    const after = await snapshot(db);

    const worker = after.jobs.find((j) => j.jobname === WORKER_JOB)!;
    const workerBefore = before.jobs.find((j) => j.jobname === WORKER_JOB)!;
    assert.deepEqual({ ...worker, command: null }, { ...workerBefore, command: null }, `${label}: jobid, schedule, active, owner kept`);
    assert.equal(lf(worker.command), lf(GUARD_WORKER), `${label}: exactly D-064's worker command`);
    assert.equal(commandSha(worker.command), D064_ROUTED_WORKER_SHA256, label);
    assert.doesNotMatch(worker.command, LITERAL_URL, `${label}: no hard-coded endpoint`);
    for (const job of after.jobs) assert.doesNotMatch(job.command, LITERAL_URL, `${label}: ${job.jobname}`);
    assert.deepEqual(after.jobs.filter((j) => j.jobname !== WORKER_JOB), before.jobs.filter((j) => j.jobname !== WORKER_JOB));
    assert.deepEqual([after.vault, after.ledger], [before.vault, before.ledger], `${label}: no Vault or ledger write`);

    // The same audit row as before D-064; its after-state records the routing.
    assert.equal(after.audit.length, 1, label);
    const audit = after.audit[0];
    assert.deepEqual(Object.keys(audit.metadata).sort(), [
      "action", "after", "before", "confirm_token", "decision", "desired", "executed_by", "idle_queue_locked", "reason",
    ]);
    assert.deepEqual(
      [audit.metadata.action, audit.metadata.decision, audit.metadata.idle_queue_locked, audit.metadata.confirm_token],
      ["rewrite", "D-065", true, state.confirm_token],
    );
    assert.equal(audit.metadata.before.command_sha256, commandSha(command));
    assert.deepEqual(
      [audit.metadata.after.definition, audit.metadata.after.routing, audit.metadata.after.command_sha256, audit.metadata.after.active],
      ["concurrency_guard_v1", "vault_target", D064_ROUTED_WORKER_SHA256, active],
    );

    const synced = await check(db, "enabled");
    assert.deepEqual([synced.definition, synced.routing], ["concurrency_guard_v1", "vault_target"], label);
    assert.deepEqual([synced.status, synced.action], active ? ["in_sync", "none"] : ["inactive", "resume"], label);
    if (active) {
      assert.ok((await reconcile(db, { desired: "enabled", confirm: state.confirm_token!, reason: "again" })).some((n) => n.includes("in sync")));
      assert.deepEqual(await snapshot(db), after);
    }
    await db.close();
  }
});

test("each D-064 signal alone repairs a drift to the routed command; neither keeps the hard-coded guard", async () => {
  const repaired = async (db: PGlite) => {
    const state = await check(db, "enabled");
    await reconcile(db, { desired: "enabled", confirm: state.confirm_token!, reason: "issue #60" });
    const worker = (await snapshot(db)).jobs.find((j) => j.jobname === WORKER_JOB)!;
    await db.close();
    return { routing: state.rewrite_routing, sha: commandSha(worker.command) };
  };

  // Ledger only: live sync was unscheduled after D-064.
  const ledgerOnly = await postD064Drift();
  await ledgerOnly.exec(`select cron.unschedule('${LIVE_SYNC_JOB}')`);
  assert.deepEqual(await repaired(ledgerOnly), { routing: "vault_target", sha: D064_ROUTED_WORKER_SHA256 });

  // Live sync only: D-064 applied by hand, no ledger row.
  const liveSyncOnly = await productionDrift();
  await setLiveSyncCommand(liveSyncOnly, LIVE_SYNC_BODY.routed);
  assert.deepEqual(await repaired(liveSyncOnly), { routing: "vault_target", sha: D064_ROUTED_WORKER_SHA256 });

  // Ledger only, recorded under another version by name.
  const renamed = await productionDrift();
  await recordLedger(renamed, "20261109123456", GUARD_NAME);
  assert.deepEqual(await repaired(renamed), { routing: "vault_target", sha: D064_ROUTED_WORKER_SHA256 });

  // Neither: the pre-D-064 rewrite, which D-064's migration then routes.
  assert.deepEqual(await repaired(await productionDrift()), { routing: "hard_coded", sha: D064_ACCEPTED_WORKER_SHA256 });
});

/**
 * Runs the template with `interleaved` executed between its first derivation
 * and the idle-queue lock, standing in for another transaction that commits in
 * that window (READ COMMITTED sees it). PGlite has one backend, so the hook is
 * a shadowing set_config that fires on the template's lock_timeout call.
 */
async function reconcileWithInterleavedCommit(db: PGlite, params: Params, interleaved: string): Promise<string[]> {
  const notices: string[] = [];
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(params)) {
      await tx.query("select set_config($1, $2, true)", [`kapiloto_scheduler.${key}`, value]);
    }
    await tx.exec(`
      create function public.set_config(setting text, value text, is_local boolean) returns text
      language plpgsql as $hook$
      begin
        if setting = 'lock_timeout' then
          ${interleaved};
        end if;
        return pg_catalog.set_config(setting, value, is_local);
      end $hook$;
      set local search_path = public, pg_catalog;
    `);
    await tx.exec(RECONCILE, { onNotice: (notice) => notices.push(notice.message ?? "") });
    await tx.exec("reset search_path; drop function public.set_config(text, text, boolean);");
  });
  return notices;
}

test("the rewrite target is re-derived under the idle-queue lock and must not have changed", async () => {
  const db = await productionDrift();
  const state = await check(db, "enabled");
  assert.equal(state.rewrite_routing, "hard_coded");
  const params = { desired: "enabled", confirm: state.confirm_token!, reason: "issue #60" };
  const before = await snapshot(db);

  // D-064 becomes recorded between the first derivation and the lock.
  await assert.rejects(
    reconcileWithInterleavedCommit(
      db,
      params,
      `insert into supabase_migrations.schema_migrations (version, name) values ('${GUARD_VERSION}', '${GUARD_NAME}')`,
    ),
    /state changed before the idle-queue lock was held \(now status wrong_definition, action rewrite, runs 0, attempts 0, rewrite_routing vault_target\); nothing changed/,
  );
  assert.deepEqual(await snapshot(db), before);
  // So does live sync becoming routed.
  await assert.rejects(
    reconcileWithInterleavedCommit(
      db,
      params,
      `perform cron.alter_job(job_id := (select jobid from cron.job where jobname = '${LIVE_SYNC_JOB}'), command := $c$${LIVE_SYNC_BODY.routed}$c$)`,
    ),
    /state changed before the idle-queue lock was held \(.*rewrite_routing vault_target\)/,
  );
  // The same window, for the existing token re-check: the job is paused meanwhile.
  await assert.rejects(
    reconcileWithInterleavedCommit(db, params, `update cron.job set active = false where jobname = '${WORKER_JOB}'`),
    /state changed before the idle-queue lock was held \(now status inactive_wrong_definition, action rewrite, .*rewrite_routing hard_coded\)/,
  );
  assert.deepEqual(await snapshot(db), before);

  // Control: with nothing committed in the window the hook changes nothing.
  await reconcileWithInterleavedCommit(db, params, "perform 1");
  const worker = (await snapshot(db)).jobs.find((j) => j.jobname === WORKER_JOB)!;
  assert.equal(commandSha(worker.command), D064_ACCEPTED_WORKER_SHA256);
  assert.equal((await db.query("select 1 from pg_proc where proname = 'set_config' and pronamespace = 'public'::regnamespace")).rows.length, 0);
  await db.close();
});

/** Replaces cron.alter_job with one that installs `installed` whenever it is given a command. */
async function misinstallingAlterJob(db: PGlite, installed: string): Promise<void> {
  await db.exec(`
    create or replace function cron.alter_job(
      job_id bigint,
      schedule text default null,
      command text default null,
      database text default null,
      username text default null,
      active boolean default null
    ) returns void language plpgsql as $$
    begin
      update cron.job j
      set command = case when alter_job.command is null then j.command else $installed$${installed}$installed$ end,
          active = coalesce(alter_job.active, j.active)
      where j.jobid = alter_job.job_id;
    end $$;
  `);
}

test("a rewrite that does not end in the routing it chose is rolled back", async () => {
  // After D-064, a hard-coded result fails the post-condition.
  const post = await postD064Drift();
  await misinstallingAlterJob(post, BODY.guard);
  const postState = await check(post, "enabled");
  const postBefore = await snapshot(post);
  await assert.rejects(
    reconcile(post, { desired: "enabled", confirm: postState.confirm_token!, reason: "drift after D-064" }),
    /post-condition failed after rewrite \(status in_sync, definition concurrency_guard_v1, routing hard_coded, active t\); rolled back/,
  );
  assert.deepEqual(await snapshot(post), postBefore);
  await post.close();

  // Before D-064, a routed result fails it too.
  const pre = await productionDrift();
  await misinstallingAlterJob(pre, BODY.routed);
  const preState = await check(pre, "enabled");
  const preBefore = await snapshot(pre);
  await assert.rejects(
    reconcile(pre, { desired: "enabled", confirm: preState.confirm_token!, reason: "issue #60" }),
    /post-condition failed after rewrite \(status in_sync, definition concurrency_guard_v1, routing vault_target, active t\); rolled back/,
  );
  assert.deepEqual(await snapshot(pre), preBefore);
  await pre.close();
});
