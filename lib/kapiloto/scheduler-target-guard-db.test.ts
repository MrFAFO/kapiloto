import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { createMigratedDatabase, seedRoundWithRunningRun } from "./test-support/pglite-migrations";

/**
 * D-064: the two pg_cron jobs read their HTTP target from a per-project Vault
 * secret. A project that has not set it (every project but production) posts
 * nothing. With production's endpoints set, the jobs post exactly what the
 * hard-coded historical commands posted.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const GUARD = "20261108100000_kapiloto_scheduler_target_guard_v1.sql";
const GUARD_PATTERN = /_kapiloto_scheduler_target_guard_v1\.sql$/;
const LIVE_SYNC_MIGRATION = "20261020101804_live_sync_scheduler_v1.sql";
const WORKER_MIGRATION = "20261020120216_kapiloto_research_worker_concurrency_guard_v1.sql";

const LIVE_SYNC_JOB = "kapiloto-live-sync-every-2-min";
const WORKER_JOB = "kapiloto-research-worker-every-2-min";
const LIVE_SYNC_TARGET = "kapiloto_live_sync_target_url";
const WORKER_TARGET = "kapiloto_research_worker_target_url";
// The endpoints the historical migrations hard-code. Production sets these.
const PRODUCTION_LIVE_SYNC_URL = "https://lodbntwfdnzzvgjlnowu.supabase.co/functions/v1/kapiloto-live-sync";
const PRODUCTION_WORKER_URL = "https://kapiloto-kappa.vercel.app/api/internal/kapiloto/worker";

// An http(s) URL with a host; the guard's own `^https://[^[:space:]]+$` check is not one.
const LITERAL_URL = /https?:\/\/[a-z0-9]/i;

const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8");
const normalize = (command: string) => command.replace(/\s+/g, " ").trim();
const cronBodies = (file: string) => [...read(file).matchAll(/\$cron\$([\s\S]*?)\$cron\$/g)].map((m) => m[1]);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const LEGACY = { liveSync: cronBodies(LIVE_SYNC_MIGRATION).at(-1)!, worker: cronBodies(WORKER_MIGRATION).at(-1)! };
const [GUARDED_LIVE_SYNC, GUARDED_WORKER] = cronBodies(GUARD);
const GUARDED = { liveSync: GUARDED_LIVE_SYNC, worker: GUARDED_WORKER };

type Job = { jobid: number; jobname: string; schedule: string; command: string; active: boolean; username: string; database: string };
type Call = { url: string; headers: unknown; body: unknown; timeout_milliseconds: number };

async function jobs(db: PGlite): Promise<Job[]> {
  const result = await db.query<Job>(
    "select jobid::int as jobid, jobname, schedule, command, active, username, database from cron.job order by jobname, jobid",
  );
  return result.rows;
}

async function job(db: PGlite, jobname: string): Promise<Job | undefined> {
  return (await jobs(db)).find((row) => row.jobname === jobname);
}

/** Replaces the pg_net stand-in with one that records every request. */
async function recordHttpPosts(db: PGlite): Promise<void> {
  await db.exec(`
    create table public.test_http_posts (
      n serial primary key, url text, headers jsonb, body jsonb, timeout_milliseconds int
    );
    create or replace function net.http_post(
      url text,
      headers jsonb default '{}',
      body jsonb default '{}',
      timeout_milliseconds int default 1000
    ) returns bigint language sql as $$
      insert into public.test_http_posts (url, headers, body, timeout_milliseconds)
      values ($1, $2, $3, $4) returning n::bigint
    $$;
  `);
}

/** Runs one job command the way pg_cron would and returns what it posted. */
async function posts(db: PGlite, command: string): Promise<Call[]> {
  await db.exec("delete from public.test_http_posts");
  await db.exec(command);
  const result = await db.query<Call>(
    "select url, headers, body, timeout_milliseconds from public.test_http_posts order by n",
  );
  return result.rows;
}

async function setTarget(db: PGlite, name: string, value: string): Promise<void> {
  await db.query("delete from vault.secrets where name = $1", [name]);
  await db.query("select vault.create_secret($1, $2, 'test target')", [value, name]);
}

/** Opens the live-sync gate (an unsettled Winner 16 round past kickoff - 30m) and the worker gate. */
async function openBothGates(db: PGlite) {
  const seed = await seedRoundWithRunningRun(db, { researchProtocolVersion: "kapiloto-research-v3" });
  // The seeded round is past lock_at, where its source is immutable.
  await db.exec("alter table public.rounds disable trigger trg_guard_locked_round_schedule");
  await db.query("update public.rounds set source = 'telesport-winner16' where id = $1", [seed.roundId]);
  await db.exec("alter table public.rounds enable trigger trg_guard_locked_round_schedule");
  return seed;
}

test("the historical scheduler migrations are byte-for-byte unchanged", () => {
  const applied: Record<string, string> = {
    "20261020101804_live_sync_scheduler_v1.sql": "0b01304c460275cf6820a5124f30cc3336fa79ffc04b73537206c5db5b5e2c48",
    "20261020112327_kapiloto_research_worker_scheduler_v1.sql": "3f3f640eda5107208da30d7c76ea1dfe2965eeb881419c979cd3016573f37b09",
    "20261020114109_kapiloto_research_worker_parallelism_v1.sql": "a073be3eec148cf9055c5473889ebb5bfa69878a1fc54741d04f6144336d6233",
    "20261020120216_kapiloto_research_worker_concurrency_guard_v1.sql": "e6f5380680ca9c2b04d657ef9a6c6411083035b85ad8541a179822589f03b5a8",
  };
  for (const [file, digest] of Object.entries(applied)) {
    assert.equal(sha256(read(file).replace(/\r\n/g, "\n")), digest, file);
  }
});

test("the guard only rewrites commands, recognises exactly the chain-installed ones, and names no endpoint", () => {
  const sql = read(GUARD);
  const code = sql.replace(/--[^\n]*/g, "");
  assert.equal(cronBodies(GUARD).length, 2);
  // It can never create, re-create, re-activate or delete a job.
  assert.doesNotMatch(code, /\bcron\.(schedule|unschedule|schedule_in_database)\s*\(/);
  assert.equal([...code.matchAll(/\bcron\.alter_job\s*\(/g)].length, 1);
  assert.match(code, /cron\.alter_job\(job_id := v_job\.jobid, command := v_spec\.guarded_command\)/);
  assert.doesNotMatch(code, /\bactive\s*:=/);
  // No endpoint and no secret value is written by the migration.
  assert.doesNotMatch(sql, LITERAL_URL);
  assert.doesNotMatch(code, /vault\.(create_secret|update_secret)|insert\s+into\s+vault\./);
  // The hashes it accepts are those of the commands the chain installed.
  assert.ok(sql.includes(`'${sha256(normalize(LEGACY.liveSync))}'`), "live-sync legacy hash");
  assert.ok(sql.includes(`'${sha256(normalize(LEGACY.worker))}'`), "worker legacy hash");
  assert.ok(GUARDED.liveSync.includes(`'${LIVE_SYNC_TARGET}'`));
  assert.ok(GUARDED.worker.includes(`'${WORKER_TARGET}'`));
});

test("no migration from the guard on hard-codes an HTTP endpoint", () => {
  const later = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql") && name >= GUARD).sort();
  assert.equal(later[0], GUARD);
  for (const file of later) {
    assert.doesNotMatch(read(file), /\burl\s*:=\s*'https?:/i, file);
  }
});

test("a freshly migrated project schedules both jobs with no literal endpoint and no target configured", async () => {
  const db = await createMigratedDatabase();
  const scheduled = await jobs(db);
  assert.deepEqual(scheduled.map((row) => row.jobname), [LIVE_SYNC_JOB, WORKER_JOB]);
  for (const row of scheduled) {
    assert.doesNotMatch(row.command, LITERAL_URL, row.jobname);
    assert.equal(row.schedule, "*/2 * * * *");
    assert.equal(row.active, true);
  }
  assert.equal(normalize(scheduled[0].command), normalize(GUARDED.liveSync));
  assert.equal(normalize(scheduled[1].command), normalize(GUARDED.worker));
  const targets = await db.query("select name from vault.secrets where name in ($1, $2)", [LIVE_SYNC_TARGET, WORKER_TARGET]);
  assert.equal(targets.rows.length, 0);
  await db.close();
});

test("with no target, or a blank or malformed one, neither job posts anything even when both gates are open", async () => {
  const db = await createMigratedDatabase();
  await recordHttpPosts(db);
  await openBothGates(db);
  // The gates really are open: the hard-coded historical commands would post.
  assert.equal((await posts(db, LEGACY.liveSync)).length, 1);
  assert.equal((await posts(db, LEGACY.worker)).length, 1);

  const live = (await job(db, LIVE_SYNC_JOB))!.command;
  const worker = (await job(db, WORKER_JOB))!.command;
  assert.deepEqual(await posts(db, live), []);
  assert.deepEqual(await posts(db, worker), []);
  const unusable = [
    "",
    "   ",
    "\n\t",
    "disabled",
    "http://plain-http.example/functions/v1/kapiloto-live-sync",
    ` ${PRODUCTION_LIVE_SYNC_URL}`,
    `${PRODUCTION_WORKER_URL}\n`,
    "https://two.example/a https://three.example/b",
  ];
  for (const value of unusable) {
    await setTarget(db, LIVE_SYNC_TARGET, value);
    await setTarget(db, WORKER_TARGET, value);
    assert.deepEqual(await posts(db, live), [], JSON.stringify(value));
    assert.deepEqual(await posts(db, worker), [], JSON.stringify(value));
  }
  await db.close();
});

test("with production's targets set, the guarded jobs post exactly what the hard-coded jobs posted", async () => {
  const db = await createMigratedDatabase();
  await recordHttpPosts(db);
  await setTarget(db, LIVE_SYNC_TARGET, PRODUCTION_LIVE_SYNC_URL);
  await setTarget(db, WORKER_TARGET, PRODUCTION_WORKER_URL);
  const live = (await job(db, LIVE_SYNC_JOB))!.command;
  const worker = (await job(db, WORKER_JOB))!.command;

  const same = async (scenario: string, expected: { live: number; worker: number }) => {
    const liveLegacy = await posts(db, LEGACY.liveSync);
    const workerLegacy = await posts(db, LEGACY.worker);
    assert.equal(liveLegacy.length, expected.live, `${scenario}: live-sync`);
    assert.equal(workerLegacy.length, expected.worker, `${scenario}: worker`);
    assert.deepEqual(await posts(db, live), liveLegacy, `${scenario}: live-sync`);
    assert.deepEqual(await posts(db, worker), workerLegacy, `${scenario}: worker`);
    for (const call of liveLegacy) assert.equal(call.url, PRODUCTION_LIVE_SYNC_URL);
    for (const call of workerLegacy) assert.equal(call.url, PRODUCTION_WORKER_URL);
    return workerLegacy;
  };

  await same("both gates closed", { live: 0, worker: 0 });

  const seed = await openBothGates(db);
  // An active run with no non-terminal attempt: one finalizer slot.
  const finalizer = await same("finalizer only", { live: 1, worker: 1 });
  assert.deepEqual(finalizer.map((call) => call.body), [{ finalizeRuns: true }]);

  const game = (n: number) => seed.fixtures[n - 1].roundGameId;
  // Available queue, nothing running: two slots, slot 1 finalizes.
  await db.query(
    `insert into public.kapiloto_research_attempts
       (run_id, round_id, task_key, round_game_id, attempt_no, status, available_at)
     values ($1, $2, 'fixture:1', $3, 1, 'queued', now() - interval '1 minute')`,
    [seed.runId, seed.roundId, game(1)],
  );
  const two = await same("queue available", { live: 1, worker: 2 });
  assert.deepEqual(two.map((call) => call.body), [{ finalizeRuns: true }, { finalizeRuns: false }]);
  // One live lease: one remaining slot.
  await db.query(
    `insert into public.kapiloto_research_attempts
       (run_id, round_id, task_key, round_game_id, attempt_no, status, worker_id, claimed_at, heartbeat_at, lease_expires_at)
     values ($1, $2, 'fixture:2', $3, 1, 'running', 'test-worker', now(), now(), now() + interval '5 minutes')`,
    [seed.runId, seed.roundId, game(2)],
  );
  await same("one live lease", { live: 1, worker: 1 });

  await db.query("update public.rounds set status = 'settled' where id = $1", [seed.roundId]);
  await same("round settled", { live: 0, worker: 1 });
  await db.close();
});

test("the guard rewrites a job in place, leaves a paused or unscheduled job as it was, and is idempotent", async () => {
  const db = await createMigratedDatabase({ exclude: GUARD_PATTERN });
  const before = await jobs(db);
  assert.equal(normalize(before[0].command), normalize(LEGACY.liveSync));
  assert.equal(normalize(before[1].command), normalize(LEGACY.worker));
  // Production-like states: live sync paused with active = false, the worker
  // paused by unscheduling it (incident 264201 style).
  await db.query("select cron.alter_job(job_id := $1, active := false)", [before[0].jobid]);
  await db.exec(`select cron.unschedule('${WORKER_JOB}')`);

  await db.exec(read(GUARD));
  const after = await jobs(db);
  assert.equal(after.length, 1);
  assert.deepEqual(
    { ...after[0], command: normalize(after[0].command) },
    { ...before[0], active: false, command: normalize(GUARDED.liveSync) },
  );

  await db.exec(read(GUARD));
  assert.deepEqual(await jobs(db), after);
  await db.close();
});

test("the guard refuses a command it did not install, or a duplicated job, and then changes nothing", async () => {
  const db = await createMigratedDatabase({ exclude: GUARD_PATTERN });
  const before = await jobs(db);
  const outOfBand = LEGACY.worker.replace("greatest(0, 2 - live_running)", "greatest(0, 3 - live_running)");
  assert.notEqual(outOfBand, LEGACY.worker);
  await db.query("select cron.alter_job(job_id := $1, command := $2)", [before[1].jobid, outOfBand]);
  const changed = await jobs(db);

  await assert.rejects(
    db.exec(read(GUARD)),
    new RegExp(`${WORKER_JOB} \\(jobid ${before[1].jobid}\\) has a command this migration did not install`),
  );
  // Live sync is processed first; the whole statement rolled back.
  assert.deepEqual(await jobs(db), changed);

  await db.query("select cron.alter_job(job_id := $1, command := $2)", [before[1].jobid, LEGACY.worker]);
  await db.query(
    "insert into cron.job (jobname, schedule, command, username) values ($1, '*/2 * * * *', $2, 'other_owner')",
    [LIVE_SYNC_JOB, LEGACY.liveSync],
  );
  const duplicated = await jobs(db);
  await assert.rejects(db.exec(read(GUARD)), new RegExp(`${LIVE_SYNC_JOB} is scheduled 2 times`));
  assert.deepEqual(await jobs(db), duplicated);
  await db.close();
});

// The identity the chain gave both jobs. A job with the chain-installed command
// but any other owner, database or schedule was changed out of band.
const IDENTITY_DRIFTS = [
  { column: "username", value: "supabase_admin", refusal: "is owned by supabase_admin, not postgres" },
  { column: "database", value: "kapiloto_staging", refusal: "runs in database kapiloto_staging, not postgres" },
  { column: "schedule", value: "*/5 * * * *", refusal: "has schedule '*/5 * * * *', not '*/2 * * * *'" },
] as const;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const refusal = (row: Job, text: string) =>
  new RegExp(escapeRegExp(`${row.jobname} (jobid ${row.jobid}) ${text}; refusing to rewrite it`));

async function setColumn(db: PGlite, row: Job, column: (typeof IDENTITY_DRIFTS)[number]["column"], value: string) {
  await db.query(`update cron.job set ${column} = $1 where jobid = $2`, [value, row.jobid]);
}

test("the guard refuses a job with an unexpected owner, database or schedule, and then changes nothing", async () => {
  const db = await createMigratedDatabase({ exclude: GUARD_PATTERN });
  const baseline = await jobs(db);
  assert.deepEqual(
    baseline.map((row) => [row.jobname, row.username, row.database, row.schedule, normalize(row.command)]),
    [
      [LIVE_SYNC_JOB, "postgres", "postgres", "*/2 * * * *", normalize(LEGACY.liveSync)],
      [WORKER_JOB, "postgres", "postgres", "*/2 * * * *", normalize(LEGACY.worker)],
    ],
  );

  // Each drift on its own, on each job, with the chain-installed command kept.
  for (const target of baseline) {
    for (const drift of IDENTITY_DRIFTS) {
      const label = `${target.jobname}: ${drift.column}`;
      await setColumn(db, target, drift.column, drift.value);
      const drifted = await jobs(db);

      await assert.rejects(db.exec(read(GUARD)), refusal(target, drift.refusal), label);
      // One statement: nothing changed. When the worker is refused, live sync
      // has already passed its checks and been rewritten in the same run; that
      // rewrite is rolled back with the rest.
      assert.deepEqual(await jobs(db), drifted, label);
      assert.equal(normalize((await job(db, LIVE_SYNC_JOB))!.command), normalize(LEGACY.liveSync), label);
      assert.equal(normalize((await job(db, WORKER_JOB))!.command), normalize(LEGACY.worker), label);

      await setColumn(db, target, drift.column, target[drift.column]);
      assert.deepEqual(await jobs(db), baseline, label);
    }
  }

  // active is deliberately not checked: paused jobs with the chain's identity
  // are rewritten in place and stay paused.
  for (const row of baseline) {
    await db.query("select cron.alter_job(job_id := $1, active := false)", [row.jobid]);
  }
  await db.exec(read(GUARD));
  assert.deepEqual(
    (await jobs(db)).map((row) => ({ ...row, command: normalize(row.command) })),
    [
      { ...baseline[0], active: false, command: normalize(GUARDED.liveSync) },
      { ...baseline[1], active: false, command: normalize(GUARDED.worker) },
    ],
  );
  await db.close();
});

test("re-running the guard still refuses an already-guarded job whose owner, database or schedule drifted", async () => {
  const db = await createMigratedDatabase();
  const baseline = await jobs(db);
  assert.equal(normalize(baseline[0].command), normalize(GUARDED.liveSync));
  assert.equal(normalize(baseline[1].command), normalize(GUARDED.worker));

  for (const target of baseline) {
    for (const drift of IDENTITY_DRIFTS) {
      const label = `${target.jobname}: ${drift.column}`;
      await setColumn(db, target, drift.column, drift.value);
      const drifted = await jobs(db);
      await assert.rejects(db.exec(read(GUARD)), refusal(target, drift.refusal), label);
      assert.deepEqual(await jobs(db), drifted, label);
      await setColumn(db, target, drift.column, target[drift.column]);
    }
  }

  await db.exec(read(GUARD));
  assert.deepEqual(await jobs(db), baseline);
  await db.close();
});

test("the guard reads each rewritten job back and refuses unless only its command changed", async () => {
  const db = await createMigratedDatabase({ exclude: GUARD_PATTERN });
  const baseline = await jobs(db);
  // A cron.alter_job that does more, or less, than replace the command.
  const misbehaviours: Record<string, string> = {
    "flips active": "command = alter_job.command, active = not j.active",
    "changes the schedule": "command = alter_job.command, schedule = '* * * * *'",
    "changes the owner": "command = alter_job.command, username = 'supabase_admin'",
    "changes the database": "command = alter_job.command, database = 'kapiloto_staging'",
    "changes the jobid": "command = alter_job.command, jobid = j.jobid + 1000",
    "ignores the command": "command = j.command",
  };

  for (const [label, assignments] of Object.entries(misbehaviours)) {
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
        update cron.job j set ${assignments} where j.jobid = alter_job.job_id;
      end $$;
    `);
    await assert.rejects(
      db.exec(read(GUARD)),
      new RegExp(
        escapeRegExp(
          `${LIVE_SYNC_JOB} (jobid ${baseline[0].jobid}) did not keep its jobid, schedule, owner, database and active flag with exactly the new command`,
        ),
      ),
      label,
    );
    assert.deepEqual(await jobs(db), baseline, label);
  }
  await db.close();
});

// ---------------------------------------------------------------------------
// Composition with D-065: production's real rollout order
// ---------------------------------------------------------------------------

const OPERATOR_SQL = join(process.cwd(), "docs", "operations", "sql");
const D065_CHECK = readFileSync(join(OPERATOR_SQL, "kapiloto-research-worker-scheduler-check.sql"), "utf8");
const D065_RECONCILE = readFileSync(join(OPERATOR_SQL, "kapiloto-research-worker-scheduler-reconcile.sql"), "utf8");
const HISTORICAL_SINGLE_CALL = cronBodies("20261020112327_kapiloto_research_worker_scheduler_v1.sql").at(-1)!;
// D-065: the only worker command D-064 accepts, and what D-065 installs.
const CONCURRENCY_GUARD_SHA256 = "b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453";

type D065State = { definition: string | null; routing: string | null; status: string; action: string; confirm_token: string | null; command_sha256: string };

async function d065Check(db: PGlite): Promise<D065State> {
  return db.transaction(async (tx) => {
    await tx.exec("set transaction read only");
    await tx.query("select set_config('kapiloto_scheduler.desired', 'enabled', true)");
    return (await tx.query<D065State>(D065_CHECK)).rows[0];
  });
}

async function d065Reconcile(db: PGlite, confirm: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      `select set_config('kapiloto_scheduler.desired', 'enabled', true),
              set_config('kapiloto_scheduler.confirm', $1, true),
              set_config('kapiloto_scheduler.reason', 'issue #60', true)`,
      [confirm],
    );
    await tx.exec(D065_RECONCILE);
  });
}

test("after D-065 reconciles production's drifted worker, D-064 routes exactly concurrency_guard_v1 and keeps the job", async () => {
  // Production today: the chain up to D-065, with the worker drifted back to
  // the historical single-call body by an out-of-band action.
  const db = await createMigratedDatabase({ exclude: GUARD_PATTERN });
  const drifted = (await job(db, WORKER_JOB))!;
  await db.query("select cron.alter_job(job_id := $1, command := $2)", [drifted.jobid, HISTORICAL_SINGLE_CALL]);
  const production = await jobs(db);

  // D-064 alone refuses the drift and changes nothing.
  await assert.rejects(
    db.exec(read(GUARD)),
    new RegExp(`${WORKER_JOB} \\(jobid ${drifted.jobid}\\) has a command this migration did not install`),
  );
  assert.deepEqual(await jobs(db), production);

  // D-065 W3: the confirmed rewrite installs concurrency_guard_v1, hard-coded.
  const plan = await d065Check(db);
  assert.deepEqual([plan.definition, plan.status, plan.action], ["scheduler_v1_single", "wrong_definition", "rewrite"]);
  await d065Reconcile(db, plan.confirm_token!);
  const reconciled = (await job(db, WORKER_JOB))!;
  assert.equal(sha256(normalize(reconciled.command)), CONCURRENCY_GUARD_SHA256);
  assert.equal(normalize(reconciled.command), normalize(LEGACY.worker));

  // D-064 then routes exactly that definition, in place.
  await db.exec(read(GUARD));
  const after = await jobs(db);
  const routed = after.find((row) => row.jobname === WORKER_JOB)!;
  const before = production.find((row) => row.jobname === WORKER_JOB)!;
  assert.deepEqual(
    { ...routed, command: normalize(routed.command) },
    { ...before, command: normalize(GUARDED.worker) },
    "jobid, schedule, owner, database and active flag preserved",
  );
  const liveSync = after.find((row) => row.jobname === LIVE_SYNC_JOB)!;
  assert.equal(normalize(liveSync.command), normalize(GUARDED.liveSync));

  // D-065's read-only check sees the routed worker as correct.
  const final = await d065Check(db);
  assert.deepEqual([final.definition, final.routing, final.status, final.action], ["concurrency_guard_v1", "vault_target", "in_sync", "none"]);

  // Disarmed until production creates its target; then it posts what concurrency_guard_v1 posted.
  await recordHttpPosts(db);
  await openBothGates(db);
  assert.deepEqual(await posts(db, routed.command), []);
  await setTarget(db, WORKER_TARGET, PRODUCTION_WORKER_URL);
  const routedPosts = await posts(db, routed.command);
  assert.equal(routedPosts.length, 1);
  assert.deepEqual(routedPosts, await posts(db, LEGACY.worker));
  await db.close();
});
