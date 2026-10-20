-- Bound Kapiloto research concurrency to two live attempts and assign
-- exactly one primary finalizer per scheduler tick.

select cron.unschedule(jobid)
from cron.job
where jobname = 'kapiloto-research-worker-every-2-min';

select cron.schedule(
  'kapiloto-research-worker-every-2-min',
  '*/2 * * * *',
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
    )
    select net.http_post(
      url := 'https://kapiloto-kappa.vercel.app/api/internal/kapiloto/worker',
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
    cross join lateral generate_series(1, c.slots) as worker_slot(slot_no)
    where c.slots > 0;
  $cron$
);
