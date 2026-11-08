# pg_cron production target guard (D-064)

Status: proposed in a Draft PR. Not merged and not applied anywhere. Production is unchanged.

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
- **Chain-installed commands only.** A job is rewritten only when its current command, after collapsing whitespace, has the SHA-256 of the command the chain installed. A command already in the new form is skipped, so re-running the migration is safe. If the command is anything else, or the job name is scheduled more than once, the migration raises. The whole rewrite is one `DO` statement, so a raise leaves both jobs as they were.
- **Warning.** It raises a `WARNING` for each rewritten job whose target is not set on that project.

## Production-safety argument

1. **Same endpoints.** Production sets the two secrets to exactly the URLs the historical migrations hard-code. `lib/kapiloto/scheduler-target-guard-db.test.ts` runs the old and new commands on the real migration chain with a recording `net.http_post`. In every gate state tested, both post the same list of `(url, headers, body, timeout)`:
   - both gates closed;
   - finalizer only;
   - queue available (two slots, slot 1 finalizes);
   - one live lease;
   - round settled.

   A mutation check confirms the test catches drift: changing the new worker command to three slots made it fail.
2. **Same job.** Only `command` changes. The jobid, `cron.job_run_details` history, schedule, owner and `active` flag stay the same, and a paused or unscheduled job stays that way (tested).
3. **No gap if the order is followed.** Until the migration runs, nothing reads the secrets, so they can be created first with no effect. Once the migration runs, the next tick posts to the same URL.
4. **Fail-closed if the order is not followed.** If the migration lands before the secrets, production posts nothing: no wrong calls, but live sync and the worker stop. This shows in three places:
   - the migration's `WARNING`;
   - the verification query below;
   - a stalled live sync or research queue.

   The fix is to create the secret; it takes effect on the next 2-minute tick and needs no migration.
5. **Out-of-band drift stops the migration.** If production's command was changed by hand, the migration aborts and changes nothing. A reviewer decides what to do next.
6. **No new access surface.** No table, function, grant, policy or browser-visible value. The jobs keep reading Vault as the `cron` job owner, as they already do for their auth secrets.

## Production rollout

Not done. Every production write needs the user's explicit approval in chat. Run as `postgres` with `supabase db query --linked`.

**1. Read-only pre-check.**

```sql
select jobid, jobname, schedule, active, username,
       md5(regexp_replace(btrim(command), '\s+', ' ', 'g')) as command_md5
from cron.job
where jobname in ('kapiloto-live-sync-every-2-min', 'kapiloto-research-worker-every-2-min');

select name
from vault.secrets
where name in ('kapiloto_live_sync_target_url', 'kapiloto_research_worker_target_url');
```

Expect:
- each job present at most once;
- no target secrets yet.

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

When a gate is next open, `net._http_response` shows the usual status codes. `pg_net` keeps responses for about six hours.

**Rollback.** No rollback of the migration is needed to restore the endpoints: they come from the secrets. To return a job to its historical command anyway:

```sql
select cron.alter_job(job_id := <jobid>, command := <the $cron$ body of the historical migration>);
```

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

If a job is absent (unscheduled) and is scheduled again, use the command from `20261108100000_kapiloto_scheduler_target_guard_v1.sql`. Never use the body of a historical scheduler migration: it hard-codes production. `supabase/drafts/005_kapiloto_scheduler_reconciliation.sql` points there.

## Residual risks

- **A copy of production carries the targets,** because Vault data is part of the database. The disarm step above is mandatory after a restore. Vault's encryption key may also prevent decryption in another project, which would leave the target `NULL` and the jobs inert, but this guard does not rely on that.
- **A human can set production URLs on the wrong project.** Only the documentation prevents this.
- **Skipping step 2 stops production's live sync and worker** until the secrets are created. The failure is fail-closed and visible.
