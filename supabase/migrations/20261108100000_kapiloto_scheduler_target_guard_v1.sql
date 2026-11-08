-- Kapiloto scheduler target guard (D-064).
--
-- Problem: 20261020101804 (live sync) and 20261020112327 / 20261020114109 /
-- 20261020120216 (research worker) schedule pg_cron jobs whose net.http_post
-- URL is a hard-coded PRODUCTION endpoint. Applying the migration chain to any
-- other Supabase project (staging, a disposable rehearsal, local, a preview
-- branch) therefore scheduled jobs that call production as soon as that
-- project has an unsettled Winner 16 round near kickoff or an active research
-- run.
--
-- Fix: each job's HTTP target becomes a per-project setting in Supabase Vault.
--   kapiloto_live_sync_target_url        -> kapiloto-live-sync-every-2-min
--   kapiloto_research_worker_target_url  -> kapiloto-research-worker-every-2-min
-- A job posts only when its target secret is exactly one https:// URL with no
-- whitespace; a missing, blank or malformed target posts nothing. This
-- migration creates neither secret, so every project is disarmed by default.
-- The stored value is used as is (never trimmed or rewritten). Production
-- (and only production) creates both secrets, set to its current endpoints,
-- BEFORE this migration is applied there:
-- docs/operations/2026-11-08-pg-cron-production-target-guard.md.
--
-- Nothing else changes. Each new command is the previous command with two
-- edits: the URL literal is replaced by the target secret, and the target is
-- joined as a source that yields no row when it is unusable. Schedule, gates,
-- slot count, headers, body and timeout are the same text as before.
--
-- How the rewrite stays safe:
-- - A job is rewritten in place with cron.alter_job, so it keeps its jobid,
--   schedule, owner, database and active flag. A job that does not exist (for
--   example one paused by unscheduling it) stays absent. This migration never
--   creates, re-creates, re-activates or deletes a job.
-- - A job is touched only while it is still the job the chain scheduled:
--   its name is scheduled exactly once, it is owned by postgres in database
--   postgres, its schedule is exactly '*/2 * * * *', and its command is the
--   one the chain installed, compared after collapsing whitespace (so CRLF
--   checkouts and indentation do not matter). A command already in the new
--   form is left alone, but only after the same name, owner, database and
--   schedule checks. The active flag is deliberately not checked: a paused job
--   (active = false) is a supported state and stays paused.
-- - Anything else means the job was changed out of band: the migration raises
--   and, being one statement, changes nothing, including a job it had already
--   rewritten earlier in the same run.
-- - After each rewrite the job is read back. Unless it has the same jobid,
--   schedule, owner, database and active flag, and exactly the new command,
--   the migration raises and changes nothing.

do $scheduler_target_guard$
declare
  -- The identity the migration chain gave both jobs (cron.schedule run as
  -- postgres in database postgres), as production shows it.
  c_username constant text := 'postgres';
  c_database constant text := 'postgres';
  c_schedule constant text := '*/2 * * * *';
  v_spec record;
  v_job record;
  v_after record;
  v_matches integer;
  v_current text;
begin
  for v_spec in
    select *
    from (
      values
        (
          'kapiloto-live-sync-every-2-min',
          'kapiloto_live_sync_target_url',
          -- Command installed by 20261020101804_live_sync_scheduler_v1.sql.
          'c9c296763980744b0d3e6426817f7819b0f9c088871c6b4e105ccc97eba90107',
          $cron$
    select net.http_post(
      url := target.url,
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := jsonb_build_object(
        'secret',
        (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'kapiloto_live_sync_cron_secret'
          limit 1
        )
      ),
      timeout_milliseconds := 30000
    )
    from (
      select s.decrypted_secret as url
      from vault.decrypted_secrets s
      where s.name = 'kapiloto_live_sync_target_url'
        and s.decrypted_secret ~ '^https://[^[:space:]]+$'
      limit 1
    ) as target
    where exists (
      select 1
      from public.rounds r
      join public.round_games g on g.round_id = r.id
      where r.source = 'telesport-winner16'
        and r.status <> 'settled'
      group by r.id
      having now() >= min(g.kickoff_at) - interval '30 minutes'
    );
  $cron$
        ),
        (
          'kapiloto-research-worker-every-2-min',
          'kapiloto_research_worker_target_url',
          -- Command installed by
          -- 20261020120216_kapiloto_research_worker_concurrency_guard_v1.sql.
          'b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453',
          $cron$
    with scheduler_state as (
      select
        exists (
          select 1
          from public.kapiloto_research_runs r
          where r.status in ('queued', 'running')
        ) as has_active_run,
        exists (
          select 1
          from public.kapiloto_research_attempts a
          join public.kapiloto_research_runs r on r.id = a.run_id
          where a.status = 'queued'
            and a.available_at <= now()
            and r.status in ('queued', 'running')
        ) as has_available_queue,
        exists (
          select 1
          from public.kapiloto_research_attempts a
          join public.kapiloto_research_runs r on r.id = a.run_id
          where a.status = 'running'
            and a.lease_expires_at < now()
            and r.status in ('queued', 'running')
        ) as has_expired_running,
        exists (
          select 1
          from public.kapiloto_research_attempts a
          join public.kapiloto_research_runs r on r.id = a.run_id
          where a.status in ('queued', 'running')
            and r.status in ('queued', 'running')
        ) as has_nonterminal_attempt,
        (
          select count(*)::integer
          from public.kapiloto_research_attempts a
          join public.kapiloto_research_runs r on r.id = a.run_id
          where a.status = 'running'
            and a.lease_expires_at > now()
            and r.status in ('queued', 'running')
        ) as live_running
    ),
    capacity as (
      select case
        when not has_active_run then 0
        when has_available_queue or has_expired_running
          then greatest(0, 2 - live_running)
        when not has_nonterminal_attempt and live_running = 0
          then 1
        else 0
      end as slots
      from scheduler_state
    ),
    target as (
      select s.decrypted_secret as url
      from vault.decrypted_secrets s
      where s.name = 'kapiloto_research_worker_target_url'
        and s.decrypted_secret ~ '^https://[^[:space:]]+$'
      limit 1
    )
    select net.http_post(
      url := t.url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization',
        'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'kapiloto_research_worker_secret'
          limit 1
        )
      ),
      body := jsonb_build_object(
        'finalizeRuns',
        worker_slot.slot_no = 1
      ),
      timeout_milliseconds := 30000
    )
    from capacity c
    cross join target t
    cross join lateral generate_series(1, c.slots) as worker_slot(slot_no)
    where c.slots > 0;
  $cron$
        )
    ) as spec(jobname, target_secret, legacy_command_sha256, guarded_command)
  loop
    select count(*)::integer
      into v_matches
    from cron.job j
    where j.jobname = v_spec.jobname;

    if v_matches = 0 then
      raise notice '% is not scheduled on this project; left absent', v_spec.jobname;
      continue;
    end if;

    if v_matches > 1 then
      raise exception '% is scheduled % times; refusing to guess which to rewrite',
        v_spec.jobname, v_matches;
    end if;

    select j.jobid, j.schedule, j.command, j.username, j.database, j.active
      into v_job
    from cron.job j
    where j.jobname = v_spec.jobname;

    if v_job.username is distinct from c_username then
      raise exception
        '% (jobid %) is owned by %, not %; refusing to rewrite it. See docs/operations/2026-11-08-pg-cron-production-target-guard.md',
        v_spec.jobname, v_job.jobid, coalesce(v_job.username, '<null>'), c_username;
    end if;

    if v_job.database is distinct from c_database then
      raise exception
        '% (jobid %) runs in database %, not %; refusing to rewrite it. See docs/operations/2026-11-08-pg-cron-production-target-guard.md',
        v_spec.jobname, v_job.jobid, coalesce(v_job.database, '<null>'), c_database;
    end if;

    if v_job.schedule is distinct from c_schedule then
      raise exception
        '% (jobid %) has schedule ''%'', not ''%''; refusing to rewrite it. See docs/operations/2026-11-08-pg-cron-production-target-guard.md',
        v_spec.jobname, v_job.jobid, coalesce(v_job.schedule, '<null>'), c_schedule;
    end if;

    v_current := btrim(regexp_replace(v_job.command, '\s+', ' ', 'g'));

    if v_current = btrim(regexp_replace(v_spec.guarded_command, '\s+', ' ', 'g')) then
      raise notice '% already reads its target from Vault', v_spec.jobname;
      continue;
    end if;

    if encode(sha256(convert_to(v_current, 'UTF8')), 'hex')
        <> v_spec.legacy_command_sha256 then
      raise exception
        '% (jobid %) has a command this migration did not install; refusing to rewrite it. See docs/operations/2026-11-08-pg-cron-production-target-guard.md',
        v_spec.jobname, v_job.jobid;
    end if;

    perform cron.alter_job(job_id := v_job.jobid, command := v_spec.guarded_command);

    select j.jobid, j.schedule, j.command, j.username, j.database, j.active
      into v_after
    from cron.job j
    where j.jobid = v_job.jobid
      and j.jobname = v_spec.jobname;

    if not found
        or v_after.schedule is distinct from v_job.schedule
        or v_after.username is distinct from v_job.username
        or v_after.database is distinct from v_job.database
        or v_after.active is distinct from v_job.active
        or btrim(regexp_replace(v_after.command, '\s+', ' ', 'g'))
          <> btrim(regexp_replace(v_spec.guarded_command, '\s+', ' ', 'g')) then
      raise exception
        '% (jobid %) did not keep its jobid, schedule, owner, database and active flag with exactly the new command after cron.alter_job; nothing was changed',
        v_spec.jobname, v_job.jobid;
    end if;

    if not exists (
      select 1
      from vault.decrypted_secrets s
      where s.name = v_spec.target_secret
        and s.decrypted_secret ~ '^https://[^[:space:]]+$'
    ) then
      raise warning '% now posts nothing on this project until Vault secret % holds an https:// URL',
        v_spec.jobname, v_spec.target_secret;
    end if;
  end loop;
end;
$scheduler_target_guard$;
