# Research-worker scheduler reconciliation (D-065, issue #60)

Status: proposed in Draft PR #61. Not merged. No production write has been made; no job, secret or row was changed anywhere. The read-only pre-checks P1–P3 were run against production by the independent review of 2026-11-08 (PR #61 review `5816097257`); their results are recorded below.

Reviewed operator SQL (never migrations):
- `docs/operations/sql/kapiloto-research-worker-scheduler-check.sql`: read-only drift check;
- `docs/operations/sql/kapiloto-research-worker-scheduler-reconcile.sql`: write template, confirmation token required.

Tests: `lib/kapiloto/scheduler-reconciliation-db.test.ts` runs both files verbatim on the real migration chain.

## A. History of the drift

### Proven

| When | Evidence | Fact |
|---|---|---|
| 2026-10-20 | commits `b7ffddb`, `f31bf91`, `e006548`; production versions recorded in `5f986cb` | Three migrations define `kapiloto-research-worker-every-2-min` in sequence on the same day: `20261020112327` (one request per tick), `20261020114109` (two requests per tick), `20261020120216` (capacity-bounded, one finalizer). Each unschedules the job by name and schedules it again. |
| 2026-10-21 04:07 +03:00 (01:07Z) | `cae3d70`, `docs/prompts/CLAUDE-KAPILOTO-RESEARCH-RED-TEAM.md` | Production `cron.job` had **no** research-worker job, only live sync, although all three migrations were recorded as applied. The active run had 16 queued and 4 failed attempts. The note asked to keep it paused. |
| 2026-10-22 08:52:00.090004Z | P2, production, review `5816097257` | First recorded run of the current worker job, jobid **10**. The catalog today: live sync jobid 3, research worker jobid 10, round precompute jobid 11. |
| 2026-10-21 | `f1cf5b3` | `supabase/drafts/005_kapiloto_scheduler_reconciliation.sql` was added: desired state seeded as PAUSED (incident 264201), command left as a placeholder. |
| 2026-10-24 | `5f986cb` | Local migration files were renamed to production's recorded versions. At that time production history matched the repository for all three worker migrations (29 matches, no extra worker rows). |
| 2026-11-08 | independent PR #59 review | Production has the job **active**. Its whitespace-normalized SHA-256 is `6c5cafc2bee207442366050772e437ccdb225c97bb52253d137857b2f44c9252`. 0 active research runs, 0 queued or running attempts. |
| 2026-11-08 | P1 (this PR's check SQL), production, review `5816097257` | jobid 10, active, `*/2 * * * *`, owner `postgres`, database `postgres`, `scheduler_v1_single`, sha `6c5cafc2…`, 0 runs, 0 attempts → `wrong_definition`, action `rewrite`. |
| 2026-11-08 | P3, production, review `5816097257` | The migration ledger has exactly the three original worker rows (`20261020112327`, `20261020114109`, `20261020120216`), with no additional or re-applied worker row. |
| 2026-11-08 | computed here, pinned by test | `6c5cafc2…` is exactly the normalized `$cron$` body of `20261020112327_kapiloto_research_worker_scheduler_v1.sql`. The live command is that file's text, not a later definition and not a hand-written variant. |
| — | grep of `app`, `lib`, `scripts`, `tools`, `supabase/functions` | No application code calls `cron.schedule`, `cron.unschedule` or `cron.alter_job`. Only migrations, the unused draft and tests do. |

### Not found

The action that re-created the job is not recorded anywhere I could search:
- no commit on any local or remote branch;
- no file in any local worktree;
- no indexed local Claude Code session transcript. I searched for:
  - the job name, and `cron.schedule(` with the job name;
  - resume, re-enable and re-create phrasing;
  - `execute_sql`;
  - the production hash.

  The one indexed session active in the window (`Opus 5.5 Kapiloto architecture review`, 2026-10-17 to 2026-10-22 14:46Z) was a read-only review.

**Narrowed by P2 and P3:**
- **When.** Re-created after 2026-10-21 01:07Z, the documented absence, and no later than 2026-10-22 08:52:00Z, its first run.
- **How.** Out of band: not through a migration tool, since the ledger has no extra worker row.
- **Who and with what tool:** still unproven.

### Inference (not proven)

- Someone ran the scheduling SQL of `20261020112327_kapiloto_research_worker_scheduler_v1.sql` by hand, for example in the SQL editor, the dashboard's Cron screen, `db query` or an SQL tool that records no migration.
- Why that file is a plausible pick:
  - its name reads as "the scheduler";
  - nothing in the repository says that two later migrations redefine the same job;
  - the 2026-10-21 draft had only a placeholder for the command.
- Jobid 10 below the precompute job's 11 fits a re-creation before that job was created.

## B. Intended scheduler semantics today

| | `scheduler_v1_single` (112327) | `parallelism_v1_unconditional` (114109) | `concurrency_guard_v1` (120216) |
|---|---|---|---|
| Requests per tick | 1 while any run is queued/running | 2 while any run is queued/running | free capacity up to 2 live attempts; 1 when only finalization is left; 0 at capacity |
| Watches live leases | no | no | yes |
| Finalizing requests | every request (body `{}`; the route defaults `finalizeRuns` to true) | both | slot 1 only (`finalizeRuns: slot_no = 1`) |
| Bound on concurrent attempts | none: invocations run up to 300 s against a 120 s tick, so up to 3 scheduler workers plus the demand worker | none (about 2× that) | 2 live attempts on the scheduler side |
| New attempts per tick | at most 1, so 16 fixtures take ≥ 32 min | 2 | 2 |

What the current code and database require:
1. **The scheduler is the only finalization path.** Demand workers always pass `finalizeRuns: false` (`lib/kapiloto/worker-demand.ts`, pinned by `worker-demand.test.ts`), and so does the operator-demand route. The worker route parses `finalizeRuns` and defaults it to true (`app/api/internal/kapiloto/worker/route.ts`). All three definitions send a finalizing request, so none of them strands a finished run.
2. **Duplicate finalizers are safe but not free.** `20261022083017_kapiloto_finalization_lifecycle_v1.sql` admits one live finalizer per run (run-row lock plus partial unique index), fences publication and bounds attempts. `worker-runtime.ts` says correctness does not depend on which slot finalizes. So slot 1 being the only finalizer is a cost and noise optimization, not the correctness boundary. Finalization therefore does not decide between the definitions.
3. **Only `concurrency_guard_v1` bounds concurrency.** `kapiloto_claim_research_attempt` (`20261018140125`) claims the next available attempt with `skip locked` and has no global cap. The two-live-attempt bound that red-team review 001 (items 9 and 13) describes exists only in the 120216 command. Item 13 says the scheduler "observes that live attempt, fills at most one remaining slot, and remains the sole finalization path"; only 120216 does that.
4. **Throughput matters.** Red-team item 6: the UI polls for up to 30 minutes, which one new attempt per tick cannot meet for a full 16-fixture run.
5. **D-064 expects it.** PR #59 rewrites only the 120216 command (`b3767090…`).

The PGlite test pins the behaviour of each definition: what it posts with no active run, finalizer only, work available, one live lease and two live leases.

**Recommendation.** The intended production definition is `concurrency_guard_v1`: exactly the `$cron$` body of `20261020120216_kapiloto_research_worker_concurrency_guard_v1.sql`, normalized SHA-256 `b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453`, schedule `*/2 * * * *`, active.
- Production should not stay on the single-call body: it is unbounded and too slow for the 30-minute poll window.
- No newer command is needed: nothing in the current runtime or the finalization lifecycle requires one.
- Using the chain's own command makes production and a fresh project converge, and lets D-064 apply unchanged.

## C. Reconciliation design

**Two operations, one state query.**
- **The check** is one `SELECT`. It reads only the worker job's row in `cron.job` and the counts of queued/running research runs and attempts. It never reads Vault or any other job's command, and the test runs it inside a `READ ONLY` transaction.
- **The template** is one `DO` block. It derives the state with the check's query, copied verbatim, three times: before acting, again under the idle-queue lock (rewrite only), and after the write. A test pins that all three copies are byte-identical to the check's query.

**Desired state is explicit.** Both take `kapiloto_scheduler.desired` = `enabled` or `paused`. Anything else gives `desired_state_required`, and the template does nothing.

**Job identity.** The expected identity is owner `postgres` in database `postgres`, which production P1 and P2 confirm. A job with the right name but another owner or database is `unexpected_job_identity`, and the template writes nothing to it, not even a pause. A post-condition also requires owner and database to be unchanged after every write.

**Classification.** The command is hashed after collapsing whitespace and matched against the reviewed definitions: `scheduler_v1_single`, `parallelism_v1_unconditional`, `concurrency_guard_v1` hard-coded, and `concurrency_guard_v1` routed through Vault (D-064, from PR #59 at `f49e537`). Anything else is `unknown`.

Precedence, top to bottom:
1. `desired_state_required`, `duplicate`, `absent` and `unexpected_job_identity` are decided first, for either desired state.
2. With desired `paused`, an active job is then offered `pause` whatever its command or schedule. This is deliberate: an emergency stop only stops calls, so an unknown or wrong-schedule job is not refused when the goal is to pause it.
3. With desired `enabled`, an unknown command or a wrong schedule is refused.

| Observed | desired = enabled | desired = paused |
|---|---|---|
| absent | `absent` → refuse; re-creating is a separately reviewed action | `in_sync` |
| more than one job with the name | `duplicate` → refuse | `duplicate` → refuse |
| owner ≠ `postgres` or database ≠ `postgres` | `unexpected_job_identity` → refuse | `unexpected_job_identity` → refuse (no pause either) |
| active, unknown command | `unknown_definition` → refuse | `running_while_paused` → pause |
| schedule ≠ `*/2 * * * *` | `wrong_schedule` → refuse | pause if active, else `in_sync` |
| active, historical definition | `wrong_definition` → rewrite, only on an idle queue | `running_while_paused` → pause |
| inactive, historical definition | `inactive_wrong_definition` → rewrite (stays inactive) | `in_sync` |
| inactive, `concurrency_guard_v1` | `inactive` → resume | `in_sync` |
| active, `concurrency_guard_v1` (either routing) | `in_sync` | `running_while_paused` → pause |

**Writes.** Each one is a single `cron.alter_job` on the existing jobid, plus one `admin_audit_log` row with group `NULL`, so no group admin can read it:
- **rewrite** changes `command` only;
- **pause** sets `active := false`;
- **resume** sets `active := true`.

It never schedules, unschedules or creates a job, never changes schedule, owner or database, and never touches another job or Vault. Besides `alter_job` and the audit row, the only other statement with an effect is the rewrite's transaction-scoped `LOCK TABLE … IN SHARE MODE`; it writes nothing.

**Fail-closed.**
- With no token it is a dry run that reports the plan.
- The token is `<action>:<jobname>:jobid=<id>:sha=<first 16 hex>:active=<bool>`. Any other token raises, including one for another action, jobid, command or active flag.
- Applying needs a `reason`.
- A rewrite needs an idle research queue, and this is enforced, not just observed (see below).
- Post-conditions are checked inside the same execution; a failure raises, which rolls everything back.
- In sync means nothing to do, whatever the token, so re-running is safe.

**Idle-queue guard (rewrite only).** The check's `active_runs` and `nonterminal_attempts` are observations at read time. The template makes the rewrite's guard atomic:
1. **READ COMMITTED required.** Under REPEATABLE READ or SERIALIZABLE the re-check would read the snapshot taken before the lock and could miss a run committed in between. Any other level raises before any lock is taken.
2. **Lock both tables.** It sets `lock_timeout` to `2s` for the transaction and runs `LOCK TABLE public.kapiloto_research_runs, public.kapiloto_research_attempts IN SHARE MODE`. `SHARE` conflicts with the `ROW EXCLUSIVE` lock that every `INSERT`, `UPDATE` and `DELETE` takes. From the moment the lock is granted until commit:
   - no research run or attempt can be created;
   - none can change status;
   - none can be claimed.

   Waiting writers proceed after commit, a matter of milliseconds. While the template is itself waiting for the lock (at most 2 s), new writers queue behind it.
3. **Re-check under the lock.** It derives the state again and requires the same `rewrite` token. If anything changed (a run appeared, the job changed), it raises and nothing changes.
4. **Write.** `cron.alter_job` runs while the lock is held, and the audit row records `idle_queue_locked: true`.

If the lock is not granted within 2 s, the statement fails and nothing changes. Pause and resume take no lock, so an emergency stop never waits for research writers.

Proof and its limit:
- **Shown in PGlite:** the order isolation check → lock → re-check → write, that both `ShareLock`s are held by the backend until the transaction ends, `lock_timeout = 2s`, and that REPEATABLE READ and SERIALIZABLE are refused.
- **Not shown in PGlite:** PGlite runs a single backend, so it cannot interleave a concurrent writer. That the lock blocks other backends' writes rests on PostgreSQL's documented table-lock conflict between `SHARE` and `ROW EXCLUSIVE`. It is not rehearsed here against a multi-backend server.

**Never resumes implicitly.**
- With desired `paused`, no path sets `active := true`.
- A rewrite keeps the job's current `active` flag.
- Resuming is its own action with its own token, offered only when the definition is already correct.

**Independent of D-064.**
- Routing is reported but never acted on, and the files contain no Vault reference outside the installed command.
- A routed command is `in_sync` and left alone.
- The rewrite installs exactly the command PR #59 accepts, so the two compose in either merge order.

**Relation to the 2026-10-21 draft.** It keeps the draft's separation of read-only drift detection from confirmed repair, and its rule that pausing changes desired state rather than deleting the job. It does not promote the draft:
- **No persistent desired-state table and no `SECURITY DEFINER` functions.** That avoids new privileges and new RLS surface. Desired state is an explicit argument, and the audit row records it durably.
- **Pause and resume use `active`, not `unschedule`.**
- **A token bound to the observed state.** It replaces a fixed per-job string.

The draft can be deleted after this PR and PR #59 are merged; it is left unedited here to avoid a conflict with PR #59, which changes its comment.

## D. Production plan (not executed; every write needs explicit user approval in chat)

Run as `postgres` with `supabase db query --linked`, one statement per call (it returns the last result set only).

### Read-only pre-check

**P1. Drift check.**

```sql
select set_config('kapiloto_scheduler.desired', 'enabled', true);
-- then, in the same execution, the full text of
-- docs/operations/sql/kapiloto-research-worker-scheduler-check.sql
```

**P2. Jobs overview and first run** (no command text: an out-of-band job may embed a credential).

```sql
select jobid, jobname, schedule, active, username, database from cron.job order by jobid;

select d.jobid, min(d.start_time) as first_run, max(d.start_time) as last_run, count(*) as runs
from cron.job_run_details d
where d.jobid = (select jobid from cron.job where jobname = 'kapiloto-research-worker-every-2-min')
group by d.jobid;
```

**P3. Was a worker migration re-applied by a tool?**

```sql
select version, name from supabase_migrations.schema_migrations
where name like '%research_worker%' order by version;
```

**P4. Live sync untouched.** Expect `c9c296763980744b0d3e6426817f7819b0f9c088871c6b4e105ccc97eba90107`.

```sql
select encode(sha256(convert_to(btrim(regexp_replace(command, '\s+', ' ', 'g')), 'UTF8')), 'hex')
from cron.job where jobname = 'kapiloto-live-sync-every-2-min';
```

### Expected results, confirmed by the 2026-11-08 read-only run

The review ran P1 with the check as of `571bab8`. The current check adds the `database` column and the `unexpected_job_identity` status. Re-run it at W1; with the identity P2 confirmed, the expected row is unchanged.

**P1:**

| column | expected (observed 2026-11-08) |
|---|---|
| `job_count` | 1 |
| `jobid` | 10 |
| `active` | true |
| `schedule` | `*/2 * * * *` |
| `username`, `database` | `postgres`, `postgres` |
| `definition` | `scheduler_v1_single` |
| `routing` | `hard_coded` |
| `command_sha256` | `6c5cafc2…9252` |
| `active_runs`, `nonterminal_attempts` | 0 |
| `status` | `wrong_definition` |
| `action` | `rewrite` |
| `confirm_token` | `rewrite:kapiloto-research-worker-every-2-min:jobid=10:sha=6c5cafc2bee20744:active=true` |

**P3:** observed exactly `20261020112327`, `20261020114109`, `20261020120216`.

**P2:** observed first run of jobid 10 at 2026-10-22 08:52:00.090004Z; jobids 3 (live sync), 10 (worker), 11 (precompute). P2 is forensic only and does not gate the write.

### Write plan (blocked on approval)

1. **W1.** Re-run P1 immediately before the write. Stop on any difference from the expected values. Copy `confirm_token`.
2. **W2. Dry run.** Same execution:

   ```sql
   select set_config('kapiloto_scheduler.desired', 'enabled', true);
   ```

   followed by the template text. Expect `DRY RUN, nothing changed` and the same token.
3. **W3. Apply.** Same execution:

   ```sql
   select set_config('kapiloto_scheduler.desired', 'enabled', true),
          set_config('kapiloto_scheduler.confirm', '<token from W1>', true),
          set_config('kapiloto_scheduler.reason', 'issue #60 (D-065): restore concurrency_guard_v1', true);
   ```

   followed by the template text, in the default READ COMMITTED isolation. Expect `APPLIED rewrite on jobid 10; now status=in_sync definition=concurrency_guard_v1 active=true`.

   During this execution, writes to research runs and attempts wait on its `SHARE` lock: at most 2 s while it acquires the lock, then milliseconds until it commits. No research run is expected at this point; this PR does not create one.
4. **W4.** Run the verification below.

### Abort conditions

Nothing changes in any of these cases.
- **P1 differs from expected:**
  - another status, definition or hash;
  - `job_count ≠ 1`, or a jobid other than 10;
  - inactive, or a wrong schedule;
  - an owner or database other than `postgres` (`unexpected_job_identity`);
  - any queued or running research work.

  Stop and report.
- **The W2 token differs from the W1 token:** the state changed in between. Restart at W1.
- **W3 raises:** any of the following rolls the whole execution back. Re-run P1 and report.
  - token mismatch or a refusal;
  - `run in READ COMMITTED`;
  - a `lock_timeout` on the research tables;
  - `state changed before the idle-queue lock was held`;
  - a post-condition failure.
- **A research run starts between W1 and W3:** the template refuses the rewrite, either at its first derivation or at the re-check under the lock. Wait for an idle queue.

### Verification after W3

**V1.** P1 again. Expect:
- `status = in_sync`;
- `definition = concurrency_guard_v1`;
- `command_sha256 = b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453`;
- jobid 10;
- `active = true`;
- `schedule = */2 * * * *`;
- owner and database `postgres`.

**V2. Audit row.**

```sql
select id, created_at, metadata->>'action' as action,
       metadata->'before'->>'command_sha256' as before_sha,
       metadata->'after'->>'command_sha256' as after_sha
from public.admin_audit_log
where action = 'kapiloto_scheduler_reconcile'
order by id desc limit 1;
```

Expect `rewrite`, before `6c5cafc2…`, after `b3767090…`, and `metadata->>'idle_queue_locked' = 'true'`.

**V3.** P4 unchanged.

**V4.** PR #59's read-only pre-check now matches both jobs.

### Rollback

- **Emergency stop.** Run the template with desired `paused` and the `pause:` token from P1 run with desired `paused`. The job and command are kept.
- **Going back to the single-call body** is deliberately not offered: it is not a reviewed desired definition. If ever required, a separately approved `select cron.alter_job(job_id := <N>, command := <the $cron$ body of 20261020112327>);`.

## Ordering with PR #59 (D-064)

1. **Merge either PR first.** Neither applies anything in production. This PR adds no migration.

   How the two branches interact:
   - Both carry byte-identical changes to `lib/kapiloto/test-support/pglite-migrations.ts` and `lib/kapiloto-v4/m2c-pause-db.test.ts`, so those merge cleanly.
   - Both append to `docs/decisions/DECISION-LOG.md`, a trivial conflict.
   - Only PR #59 edits draft 005.
2. **Production, with approval:** this plan, W1–W4.
3. **Production, with approval:** PR #59's rollout.
   1. Re-run its pre-check: the worker is now `b3767090…` and live sync `c9c29676…`.
   2. Create the two Vault target secrets.
   3. Apply `20261108100000`.
   4. Verify.
4. **Afterwards,** P1 shows `concurrency_guard_v1` / `vault_target` / `in_sync`.

Applying D-064 before step 2 is safe but blocked: its migration raises on the drifted worker command and changes nothing.

Once both PRs are in one tree, `scheduler-reconciliation-db.test.ts` also asserts that its D-064 fixture equals the migration's worker body.

## Remaining blockers

- The production write (W1–W4) needs the user's explicit approval in chat.
- PR #59 stays NO-GO for production rollout until W4 passes.
- Who re-created the job, and with which tool, remains unproven. P2 and P3 have narrowed the window and ruled out a migration tool; nothing else in the repository or local transcripts records it.
- The idle-queue lock's effect on other backends is argued from PostgreSQL's lock semantics, not rehearsed against a multi-backend server. The PR #58 real-PostgreSQL harness could add that rehearsal if wanted.
