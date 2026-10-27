-- Start two single-task research workers per scheduler tick.
-- Queue claims remain atomic, so this only increases safe fixture fanout
-- concurrency; it does not create additional research tasks.

select cron.unschedule(jobid)
from cron.job
where jobname = 'kapiloto-research-worker-every-2-min';

select cron.schedule(
  'kapiloto-research-worker-every-2-min',
  '*/2 * * * *',
  $cron$
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
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    )
    from generate_series(1, 2)
    where exists (
      select 1
      from public.kapiloto_research_runs r
      where r.status in ('queued', 'running')
    );
  $cron$
);
