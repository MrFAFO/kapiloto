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

// Production's research-worker command hash, read 2026-11-08 by the
// independent PR #59 review (normalized SHA-256).
const PRODUCTION_WORKER_SHA256 = "6c5cafc2bee207442366050772e437ccdb225c97bb52253d137857b2f44c9252";
// The only worker hash the D-064 target-guard migration (PR #59) rewrites.
const D064_ACCEPTED_WORKER_SHA256 = "b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453";

const normalize = (command: string) => command.replace(/\s+/g, " ").trim();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const commandSha = (command: string) => sha256(normalize(command));
const cronBody = (sql: string) => [...sql.matchAll(/\$cron\$([\s\S]*?)\$cron\$/g)].map((m) => m[1]).at(-1)!;
const migrationBody = (file: string) => cronBody(readFileSync(join(ROOT, "supabase", "migrations", file), "utf8"));

const BODY = {
  single: migrationBody("20261020112327_kapiloto_research_worker_scheduler_v1.sql"),
  parallel: migrationBody("20261020114109_kapiloto_research_worker_parallelism_v1.sql"),
  guard: migrationBody("20261020120216_kapiloto_research_worker_concurrency_guard_v1.sql"),
  routed: D064_ROUTED_WORKER_COMMAND,
};
const DESIRED_IN_TEMPLATE = cronBody(RECONCILE);
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
  command_sha256: string | null;
  definition: string | null;
  routing: string | null;
  active_runs: number;
  nonterminal_attempts: number;
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
  return { jobs: jobs.rows, audit: audit.rows, vault: vault.rows };
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

/** Production as the PR #59 review found it: one active job running the historical single-call body. */
async function productionDrift(): Promise<PGlite> {
  const db = await createMigratedDatabase();
  await setWorkerCommand(db, BODY.single);
  return db;
}

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
  // Independent of D-064: neither file reads Vault or names the live-sync job.
  for (const sql of [CHECK, RECONCILE.replace(/\$cron\$[\s\S]*?\$cron\$/g, "")]) {
    assert.doesNotMatch(sql, /vault\.|_target_url|kapiloto-live-sync/);
  }
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
  assert.equal(reconcileText.split(shared).length - 1, 2, "both template evaluations use the check's query verbatim");
  assert.equal(normalize(DESIRED_IN_TEMPLATE), normalize(BODY.guard));
  assert.equal(commandSha(DESIRED_IN_TEMPLATE), D064_ACCEPTED_WORKER_SHA256);
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

test("the D-064 routed fixture is the target-guard migration's worker body once PR #59 is merged", () => {
  const dir = join(ROOT, "supabase", "migrations");
  const guard = readdirSync(dir).find((name) => /_kapiloto_scheduler_target_guard_v1\.sql$/.test(name));
  if (!guard) return; // PR #59 not merged into this tree yet.
  const bodies = [...readFileSync(join(dir, guard), "utf8").matchAll(/\$cron\$([\s\S]*?)\$cron\$/g)].map((m) => m[1]);
  assert.equal(normalize(bodies[1]), normalize(D064_ROUTED_WORKER_COMMAND));
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
  // The D-064 routed form has the same semantics once its target is set.
  assert.deepEqual(await run(BODY.routed), [], "no target, no post");
  await db.query("select vault.create_secret('https://worker.example/api/internal/kapiloto/worker', 'kapiloto_research_worker_target_url', 't')");
  assert.deepEqual(await run(BODY.routed), expected);
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
  assert.equal(state.routing, "hard_coded");
  assert.equal(state.command_sha256, D064_ACCEPTED_WORKER_SHA256);
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
  assert.equal(audit.metadata.reason, "issue #60");
  assert.equal(audit.metadata.before.definition, "scheduler_v1_single");
  assert.equal(audit.metadata.after.definition, "concurrency_guard_v1");
  assert.equal(audit.metadata.after.command_sha256, D064_ACCEPTED_WORKER_SHA256);

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

test("D-064 target routing stays orthogonal: a routed job is in sync, and Vault targets change nothing", async () => {
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
  await db.close();
  await drifted.close();
});
