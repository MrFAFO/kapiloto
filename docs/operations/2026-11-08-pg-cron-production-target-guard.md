# pg_cron production target guard (D-064)

Status: proposed in Draft PR #59. Not merged and not applied anywhere. Production is unchanged.

Production rollout depends on D-065 (PR #61, merged):
- **Production's worker today.** It runs the historical single-call body `6c5cafc2…`, which this migration refuses by design.
- **Order.** D-065's reconciliation W1–W4 must first bring it to `concurrency_guard_v1` (`b3767090…`), with approval, as described in `2026-11-08-research-worker-scheduler-reconciliation.md`. The rollout below starts only after that.

## Problem

Applying the migration chain to any Supabase project schedules two pg_cron jobs that `net.http_post` to hard-coded production endpoints:

| Job | Installed by | Hard-coded target | Fires when |
|---|---|---|---|
| `kapiloto-live-sync-every-2-min` | `20261020101804_live_sync_scheduler_v1.sql` | `https://lodbntwfdnzzvgjlnowu.supabase.co/functions/v1/kapiloto-live-sync` | an unsettled `telesport-winner16` round is within 30 minutes of its first kickoff |
| `kapiloto-research-worker-every-2-min` | `20261020112327_…`, redefined by `20261020114109_…` and `20261020120216_kapiloto_research_worker_concurrency_guard_v1.sql` | `https://kapiloto-kappa.vercel.app/api/internal/kapiloto/worker` | `kapiloto_research_runs` has a queued or running run |

This was found on 2026-11-08 during the M2B/M2C real-PostgreSQL rehearsal (PR #58) on a freshly migrated disposable project. Both jobs had run every 2 minutes since migration. Their gates were closed there: no rounds, no research runs, no `pg_net` responses. With the user's approval, both jobs were unscheduled in that project.

What a non-production project could do to production:
- **Freshly migrated project** (staging, rehearsal, local `supabase db reset`, a preview branch). The migrations generate a random `kapiloto_live_sync_cron_secret` and `kapiloto_research_worker_secret` inside that project's Vault. Production's live-sync function checks the secret against production's own digest (`kapiloto_verify_scheduler_secret`). The worker route checks it against `KAPILOTO_WORKER_SECRET_SHA256`. So once a gate opens, the expected result is a stream of rejected requests against production: noise and load, but no writes.
- **Restore or copy of production** in another project. The copy also has production's Vault secrets, so its requests are accepted. That project would trigger production's live sync and research worker based on the copy's own rounds and queue. The worker's two-slot concurrency bound is computed from the caller's queue, not production's, so production's bound would no longer hold.

## Options evaluated

**(a) Per-project target in Vault; a job with no target posts nothing.** Chosen.
- Fail-closed by default. A project that does nothing posts nothing.
- Needs no human step on non-production projects, including ones nobody sets up by hand (preview branches, `db reset`).
- Production keeps its endpoints by setting two secrets once.

**(b) Documented bootstrap step that unschedules both jobs on non-production projects.** Rejected.
- Fail-open by default: the jobs are live from `db push` until someone runs the step.
- Projects that apply migrations automatically have nobody to run it.
- It must be repeated whenever a job is scheduled again.
- It still leaves the production URL in every project's `cron.job`.

**Also rejected:**
- **Detecting production inside the migration**, from data presence, run history or the project ref. Postgres has no reliable signal for which project it is: a staging project can hold data, a disposable project accumulates run history, and the project ref cannot be read from SQL. A heuristic is not acceptable for a safety boundary.
- **A `private` config table instead of Vault.** Vault is where the jobs already read their auth secrets, it uses the same read path as the `cron` owner, and it adds no table, grant or RLS surface.

## What the migration does

`supabase/migrations/20261108100000_kapiloto_scheduler_target_guard_v1.sql`:
- **Target secrets.** Each job's URL now comes from a Vault secret:
  - `kapiloto_live_sync_target_url` for live sync;
  - `kapiloto_research_worker_target_url` for the worker.
- **Fail-closed.** A job posts only when its secret is exactly one `https://` URL with no whitespace. The value is used as stored, never trimmed. A missing, blank or malformed value (`disabled`, `http://…`, leading or trailing whitespace) yields no row, so nothing is posted.
- **Creates nothing in Vault.** The migration creates neither secret, so every project starts disarmed.
- **Two edits to each command.** Each new command is the old one with:
  1. the URL literal replaced by the target;
  2. the target joined as a row source that is empty when the target is unusable.

  Schedule, gates, slot arithmetic, headers, body and timeout are unchanged.
- **Rewritten in place.** Jobs are rewritten with `cron.alter_job(job_id, command := …)`, which keeps the jobid, schedule, owner, database and `active` flag. The migration never calls `cron.schedule` or `cron.unschedule`. A job that is absent (for example paused by unscheduling it) stays absent, and an inactive job stays inactive.
- **Chain-scheduled jobs only.** A job is rewritten only while all of these hold:
  - its name is scheduled exactly once;
  - its owner (`username`) is `postgres`;
  - its `database` is `postgres`;
  - its schedule is exactly `*/2 * * * *`;
  - its command, after collapsing whitespace, has the SHA-256 of the command the chain installed.

  A command already in the new form is skipped, but only after the name, owner, database and schedule checks, so re-running the migration is safe. The `active` flag is deliberately not checked: a paused job is a supported state and stays paused. If any check fails, the migration raises with a message naming the job, its jobid and the failed check. The whole rewrite is one `DO` statement, so a raise leaves both jobs as they were, even when live sync passed and was rewritten before the worker failed.
- **Read back.** After each `cron.alter_job`, the migration reads the job again. It raises unless the job still has the same jobid, schedule, owner, database and `active` flag, and exactly the new command.
- **Warning.** It raises a `WARNING` for each rewritten job whose target is not set on that project.

## Production-safety argument

1. **Same endpoints.** Production sets the two secrets to exactly the URLs the historical migrations hard-code. `lib/kapiloto/scheduler-target-guard-db.test.ts` runs the old and new commands on the real migration chain with a recording `net.http_post`. In every gate state tested, both post the same list of `(url, headers, body, timeout)`:
   - both gates closed;
   - finalizer only;
   - queue available (two slots, slot 1 finalizes);
   - one live lease;
   - round settled.

   A mutation check confirms the test catches drift: changing the new worker command to three slots made it fail.
2. **Same job.** Only `command` changes. The jobid, `cron.job_run_details` history, schedule, owner, database and `active` flag stay the same, and a paused or unscheduled job stays that way (tested). The migration reads each job back after rewriting it and aborts if anything but the command changed.
3. **No gap if the order is followed.** Until the migration runs, nothing reads the secrets, so they can be created first with no effect. Once the migration runs, the next tick posts to the same URL.
4. **Fail-closed if the order is not followed.** If the migration lands before the secrets, production posts nothing: no wrong calls, but live sync and the worker stop. This shows in three places:
   - the migration's `WARNING`;
   - the verification query below;
   - a stalled live sync or research queue.

   The fix is to create the secret; it takes effect on the next 2-minute tick and needs no migration.
5. **Out-of-band drift stops the migration.** Here, drift means any of the following on either job:
   - its name scheduled more than once;
   - an owner other than `postgres`;
   - a database other than `postgres`;
   - a schedule other than `*/2 * * * *`;
   - a command that is neither the chain-installed one nor the new form.

   On drift, the migration aborts and changes nothing, and a reviewer decides what to do next. Each case is tested on each job on its own, including a worker failure after live sync has passed. Not drift: `active = false` (kept as is) and an absent job (left absent).
6. **No new access surface.** No table, function, grant, policy or browser-visible value. The jobs keep reading Vault as the `cron` job owner, as they already do for their auth secrets.

## Production rollout

Not done. Every production write needs the user's explicit approval in chat. Run as `postgres` with `supabase db query --linked`.

**0. D-065 first.** Complete D-065's W1–W4. Its V1 must show the worker `in_sync` with `concurrency_guard_v1`, hard-coded routing, sha `b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453`, jobid 10, active.

**1. Read-only pre-check.**

```sql
select jobid, jobname, schedule, active, username, database,
       encode(sha256(convert_to(btrim(regexp_replace(command, '\s+', ' ', 'g')), 'UTF8')), 'hex') as command_sha256
from cron.job
where jobname in ('kapiloto-live-sync-every-2-min', 'kapiloto-research-worker-every-2-min')
order by jobid;

select name
from vault.secrets
where name in ('kapiloto_live_sync_target_url', 'kapiloto_research_worker_target_url');
```

Expect:
- **Live sync:** jobid 3, `command_sha256 = c9c296763980744b0d3e6426817f7819b0f9c088871c6b4e105ccc97eba90107`.
- **Worker:** jobid 10, `command_sha256 = b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453`.
- **Both:** `*/2 * * * *`, owner and database `postgres`, each job present exactly once.
- **No target secrets yet.**

If the worker still shows `6c5cafc2…`, D-065 has not been applied. Stop; the migration would refuse it. Stop too if either job shows a different owner, database or schedule; the migration would refuse that as well.

Record whether each job is present and active. The migration preserves exactly that state.

**2. Create the targets (production write).**

```sql
select vault.create_secret(
  'https://lodbntwfdnzzvgjlnowu.supabase.co/functions/v1/kapiloto-live-sync',
  'kapiloto_live_sync_target_url',
  'pg_cron target for kapiloto-live-sync-every-2-min. Production only (D-064).'
);
select vault.create_secret(
  'https://kapiloto-kappa.vercel.app/api/internal/kapiloto/worker',
  'kapiloto_research_worker_target_url',
  'pg_cron target for kapiloto-research-worker-every-2-min. Production only (D-064).'
);
```

**3. Apply the migration** through the normal path after the PR is merged. If it raises "has a command this migration did not install", stop: production's job differs from the chain and needs review. Nothing has changed at that point.

**4. Verify.**

```sql
select jobid, jobname, schedule, active,
       command ~ 'https?://[a-z0-9]' as has_literal_url,
       command like '%kapiloto_live_sync_target_url%'
         or command like '%kapiloto_research_worker_target_url%' as reads_target
from cron.job
where jobname in ('kapiloto-live-sync-every-2-min', 'kapiloto-research-worker-every-2-min');

select name, decrypted_secret
from vault.decrypted_secrets
where name in ('kapiloto_live_sync_target_url', 'kapiloto_research_worker_target_url');
```

Expect:
- the jobids, schedules and `active` flags from step 1;
- `has_literal_url = false` and `reads_target = true`;
- the two URLs exactly as in step 2.

Then run D-065's read-only check with desired `enabled`. Expect the worker as `concurrency_guard_v1` / `vault_target` / `in_sync`, action `none`, jobid 10, owner and database `postgres`.

When a gate is next open, `net._http_response` shows the usual status codes. `pg_net` keeps responses for about six hours.

**Rollback.** No rollback of the migration is needed to restore the endpoints: they come from the secrets. To return a job to its pre-D-064 command anyway, each with a separate approval:

```sql
select cron.alter_job(job_id := <jobid>, command := <the $cron$ body of the historical migration>);
```

Use the body of `20261020101804` for live sync and of `20261020120216` (`concurrency_guard_v1`) for the worker. Never use `20261020112327` or `20261020114109`: D-065 rules them out as intended definitions.

## Non-production projects

- **Nothing to do by default.** After the chain is applied, both jobs exist and post nothing.
- **Never set production's URLs as targets** on a non-production project.
- **Exercising a project end-to-end.** Set the targets to that project's own endpoints:
  - its own `https://<project-ref>.supabase.co/functions/v1/kapiloto-live-sync`;
  - a worker deployment whose `KAPILOTO_WORKER_SECRET_SHA256` is the digest of that project's own `kapiloto_research_worker_secret`.
- **After restoring or copying production into another project,** first disarm the copy:

  ```sql
  delete from vault.secrets
  where name in ('kapiloto_live_sync_target_url', 'kapiloto_research_worker_target_url');
  ```

  Then unschedule the jobs that production created by hand, which are not in any migration and therefore not guarded here. For example, the `*/15` precompute job noted in `2026-10-30-sportmonks-mapping-overwrite.md` posts to the production app.
- **The 2026-11-08 rehearsal project** already has both jobs unscheduled.

## Re-enabling a job later

- **Re-creating an absent job** is a separately reviewed action; D-065's reconciliation never does it. If it is ever done, use the command from `20261108100000_kapiloto_scheduler_target_guard_v1.sql`. Never use the body of a historical scheduler migration: it hard-codes production.
- **Pausing and resuming** go through D-065's reviewed template, which uses the `active` flag and leaves the routed command untouched.
- **`supabase/drafts/005_kapiloto_scheduler_reconciliation.sql`** is superseded by D-065 and must not be promoted.

## Residual risks

- **A copy of production carries the targets,** because Vault data is part of the database. The disarm step above is mandatory after a restore. Vault's encryption key may also prevent decryption in another project, which would leave the target `NULL` and the jobs inert, but this guard does not rely on that.
- **A human can set production URLs on the wrong project.** Only the documentation prevents this.
- **Skipping step 2 stops production's live sync and worker** until the secrets are created. The failure is fail-closed and visible.
- **D-065's rewrite installs the hard-coded `concurrency_guard_v1` body.** In the documented order that is harmless, because D-064 then routes it. Its rewrite applies only to a job running a historical body. After D-064 that can happen only if someone changed the job out of band again. If that ever happens, re-route the command by hand (an approved `cron.alter_job` with D-064's worker body) before relying on the target secrets. Teaching D-065 to install the routed form is a possible follow-up; this PR leaves D-065 unchanged.
