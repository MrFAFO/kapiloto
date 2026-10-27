-- Autonomous demand-driven Kapiloto research worker scheduling.
-- The raw scheduler secret is generated and retained inside Supabase Vault.
-- Vercel stores only its SHA-256 digest.

create or replace function public.kapiloto_fail_exhausted_runs(
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.kapiloto_research_runs%rowtype;
  v_failure_class text;
  v_failure_detail text;
  v_failed_count integer := 0;
begin
  if p_limit < 1 or p_limit > 100 then
    raise exception 'limit must be between 1 and 100';
  end if;

  for v_run in
    select r.*
    from public.kapiloto_research_runs r
    where r.status in ('queued', 'running')
      and exists (
        select 1
        from public.kapiloto_research_attempts a
        where a.run_id = r.id
        group by a.task_key
        having
          bool_or(a.status = 'succeeded') = false
          and bool_or(a.status in ('queued', 'running')) = false
      )
    order by r.created_at
    for update skip locked
    limit p_limit
  loop
    select
      coalesce(a.failure_class, 'internal'),
      coalesce(
        a.failure_detail,
        'Kapiloto research task exhausted without a successful attempt.'
      )
      into v_failure_class, v_failure_detail
    from public.kapiloto_research_attempts a
    where a.run_id = v_run.id
      and a.status in ('failed', 'abandoned')
    order by a.finished_at desc nulls last, a.attempt_no desc
    limit 1;

    update public.kapiloto_research_runs
    set status = 'failed',
        failed_at = now(),
        failure_class = coalesce(v_failure_class, 'internal'),
        failure_detail = coalesce(
          v_failure_detail,
          'Kapiloto research task exhausted without a successful attempt.'
        )
    where id = v_run.id
      and status in ('queued', 'running');

    update public.kapiloto_research_attempts
    set status = 'abandoned',
        finished_at = coalesce(finished_at, now()),
        failure_class = coalesce(failure_class, 'cancelled'),
        failure_code = coalesce(failure_code, 'run_failed'),
        failure_detail = coalesce(
          failure_detail,
          'Attempt abandoned because another fixture task made the run unrecoverable.'
        ),
        lease_expires_at = null
    where run_id = v_run.id
      and status in ('queued', 'running');

    update public.kapiloto_round_research_state
    set active_run_id = null,
        version = version + 1,
        updated_at = now()
    where round_id = v_run.round_id
      and active_run_id = v_run.id;

    v_failed_count := v_failed_count + 1;
  end loop;

  return jsonb_build_object('failed_runs', v_failed_count);
end;
$$;

revoke all on function public.kapiloto_fail_exhausted_runs(integer)
from public, anon, authenticated;
grant execute on function public.kapiloto_fail_exhausted_runs(integer)
to service_role;

do $worker_secret$
declare
  v_secret text;
begin
  select decrypted_secret
    into v_secret
  from vault.decrypted_secrets
  where name = 'kapiloto_research_worker_secret'
  limit 1;

  if v_secret is null then
    v_secret := encode(extensions.gen_random_bytes(32), 'hex');
    perform vault.create_secret(
      v_secret,
      'kapiloto_research_worker_secret',
      'Kapiloto research worker scheduler secret'
    );
  end if;
end;
$worker_secret$;

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
    where exists (
      select 1
      from public.kapiloto_research_runs r
      where r.status in ('queued', 'running')
    );
  $cron$
);
