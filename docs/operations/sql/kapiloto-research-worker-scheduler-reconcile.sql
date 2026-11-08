-- Kapiloto research-worker scheduler reconciliation (WRITE; D-065, issue #60).
-- Not a migration; never place it under supabase/migrations.
--
-- Run the read-only kapiloto-research-worker-scheduler-check.sql first. Then
-- set the parameters in the SAME execution immediately before this block:
--   select set_config('kapiloto_scheduler.desired', 'enabled', true),   -- or 'paused'
--          set_config('kapiloto_scheduler.confirm', '<confirm_token from the check>', true),
--          set_config('kapiloto_scheduler.reason', '<why, e.g. issue #60>', true);
--
-- Leave kapiloto_scheduler.confirm unset for a dry run: it reports the planned
-- action and the token, and changes nothing.
--
-- It re-derives the state with the same query as the check, so a token taken
-- from an earlier state (another jobid, command or active flag) is refused.
-- The only writes are one cron.alter_job call on the existing job and one
-- admin_audit_log row:
--   rewrite  command := concurrency_guard_v1 (jobid, schedule, active unchanged);
--   pause    active := false (the job is kept, never unscheduled);
--   resume   active := true, only when desired is 'enabled', the job is
--            inactive and its definition is already concurrency_guard_v1.
-- It never creates, re-creates or unschedules a job, never changes a schedule,
-- owner or database, never touches another job, and never reads or writes a
-- Vault secret. A rewrite needs an idle research queue. Every refusal, a token
-- mismatch and any failed post-condition raise, which rolls the whole
-- execution back. In sync means nothing to do, whatever the token.
--
-- The rewrite installs exactly the scheduled command body of
-- 20261020120216_kapiloto_research_worker_concurrency_guard_v1.sql, which is
-- the command D-064 (PR #59) expects before it routes the target through Vault.

do $scheduler_reconcile$
declare
  v_confirm text := nullif(btrim(current_setting('kapiloto_scheduler.confirm', true)), '');
  v_reason text := nullif(btrim(current_setting('kapiloto_scheduler.reason', true)), '');
  v_before record;
  v_after record;
  v_desired_command constant text := $cron$
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
  $cron$;
begin
  select s.* into v_before from (
-- >>> worker scheduler state (shared verbatim with kapiloto-research-worker-scheduler-reconcile.sql)
with params as (
  select nullif(btrim(current_setting('kapiloto_scheduler.desired', true)), '') as desired
),
known (definition, semantics_current, routing, command_sha256) as (
  values
    ('scheduler_v1_single', false, 'hard_coded', '6c5cafc2bee207442366050772e437ccdb225c97bb52253d137857b2f44c9252'),
    ('parallelism_v1_unconditional', false, 'hard_coded', '65b8317f539a34e8297c17e9c633a84ca2e00a43b2b2fb885edf87609c2220b3'),
    ('concurrency_guard_v1', true, 'hard_coded', 'b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453'),
    ('concurrency_guard_v1', true, 'vault_target', 'afd9c6ea76bae2577984cbc05f1239c7d3f65a8324c130c6b725335d06655ebd')
),
jobs as (
  select
    j.jobid,
    j.schedule,
    j.active,
    j.username,
    encode(sha256(convert_to(btrim(regexp_replace(j.command, '\s+', ' ', 'g')), 'UTF8')), 'hex') as command_sha256
  from cron.job j
  where j.jobname = 'kapiloto-research-worker-every-2-min'
),
observed as (
  select
    (select count(*)::integer from jobs) as job_count,
    (select count(*)::integer from public.kapiloto_research_runs r
      where r.status in ('queued', 'running')) as active_runs,
    (select count(*)::integer from public.kapiloto_research_attempts a
      where a.status in ('queued', 'running')) as nonterminal_attempts
),
the_job as (
  select j.*, k.definition, k.semantics_current, k.routing
  from jobs j
  left join known k on k.command_sha256 = j.command_sha256
  where (select o.job_count from observed o) = 1
),
assessed as (
  select
    'kapiloto-research-worker-every-2-min'::text as jobname,
    p.desired,
    o.job_count,
    t.jobid,
    t.active,
    t.schedule,
    t.username,
    t.command_sha256,
    case when o.job_count = 1 then coalesce(t.definition, 'unknown') end as definition,
    t.routing,
    o.active_runs,
    o.nonterminal_attempts,
    case
      when p.desired is null or p.desired not in ('enabled', 'paused') then 'desired_state_required'
      when o.job_count > 1 then 'duplicate'
      when o.job_count = 0 and p.desired = 'paused' then 'in_sync'
      when o.job_count = 0 then 'absent'
      when p.desired = 'paused' and t.active then 'running_while_paused'
      when p.desired = 'paused' then 'in_sync'
      when t.definition is null then 'unknown_definition'
      when t.schedule <> '*/2 * * * *' then 'wrong_schedule'
      when not t.semantics_current and t.active then 'wrong_definition'
      when not t.semantics_current then 'inactive_wrong_definition'
      when not t.active then 'inactive'
      else 'in_sync'
    end as status
  from params p
  cross join observed o
  left join the_job t on true
),
planned as (
  select
    a.*,
    case
      when a.status = 'in_sync' then 'none'
      when a.status = 'running_while_paused' then 'pause'
      when a.status in ('wrong_definition', 'inactive_wrong_definition')
        and a.active_runs = 0
        and a.nonterminal_attempts = 0 then 'rewrite'
      when a.status = 'inactive' then 'resume'
      else 'refuse'
    end as action
  from assessed a
)
select
  pl.*,
  case
    when pl.status = 'desired_state_required' then 'set kapiloto_scheduler.desired to enabled or paused'
    when pl.status = 'duplicate' then 'more than one job has this name; resolve by hand'
    when pl.status = 'absent' then 'the job does not exist; re-creating it is a separately reviewed action, never a reconciliation'
    when pl.status = 'unknown_definition' then 'the command matches no reviewed definition; review it by hand'
    when pl.status = 'wrong_schedule' then 'the schedule is not */2 * * * *; review it by hand'
    when pl.action = 'refuse' then 'research work is queued or running; rewrite only on an idle queue'
    when pl.action = 'rewrite' then 'replace the command with concurrency_guard_v1; jobid, schedule and active flag unchanged'
    when pl.action = 'pause' then 'deactivate the job (active := false); the job is kept'
    when pl.action = 'resume' then 'reactivate the job; its definition is already concurrency_guard_v1'
    else 'nothing to do'
  end as detail,
  case
    when pl.action in ('rewrite', 'pause', 'resume') then
      pl.action || ':' || pl.jobname || ':jobid=' || pl.jobid::text
        || ':sha=' || left(pl.command_sha256, 16) || ':active=' || pl.active::text
  end as confirm_token
from planned pl
-- <<< worker scheduler state
  ) s;

  raise notice 'kapiloto scheduler: desired=% jobs=% jobid=% active=% definition=% routing=% runs=% attempts=% status=% action=%',
    v_before.desired, v_before.job_count, v_before.jobid, v_before.active, v_before.definition,
    v_before.routing, v_before.active_runs, v_before.nonterminal_attempts, v_before.status, v_before.action;

  if v_before.action = 'none' then
    raise notice 'kapiloto scheduler: in sync; nothing changed';
    return;
  end if;

  if v_before.action = 'refuse' then
    raise exception 'kapiloto scheduler: refusing (%): %', v_before.status, v_before.detail;
  end if;

  if v_confirm is null then
    raise notice 'kapiloto scheduler: DRY RUN, nothing changed. To %, set kapiloto_scheduler.confirm = %',
      v_before.action, v_before.confirm_token;
    return;
  end if;

  if v_confirm is distinct from v_before.confirm_token then
    raise exception 'kapiloto scheduler: confirmation token % does not match the current state (expected %); nothing changed',
      v_confirm, v_before.confirm_token;
  end if;

  if v_reason is null then
    raise exception 'kapiloto scheduler: set kapiloto_scheduler.reason; nothing changed';
  end if;

  if v_before.action = 'rewrite' then
    perform cron.alter_job(job_id := v_before.jobid, command := v_desired_command);
  elsif v_before.action = 'pause' then
    perform cron.alter_job(job_id := v_before.jobid, active := false);
  elsif v_before.action = 'resume' then
    perform cron.alter_job(job_id := v_before.jobid, active := true);
  else
    raise exception 'kapiloto scheduler: unknown action %', v_before.action;
  end if;

  select s.* into v_after from (
-- >>> worker scheduler state (shared verbatim with kapiloto-research-worker-scheduler-reconcile.sql)
with params as (
  select nullif(btrim(current_setting('kapiloto_scheduler.desired', true)), '') as desired
),
known (definition, semantics_current, routing, command_sha256) as (
  values
    ('scheduler_v1_single', false, 'hard_coded', '6c5cafc2bee207442366050772e437ccdb225c97bb52253d137857b2f44c9252'),
    ('parallelism_v1_unconditional', false, 'hard_coded', '65b8317f539a34e8297c17e9c633a84ca2e00a43b2b2fb885edf87609c2220b3'),
    ('concurrency_guard_v1', true, 'hard_coded', 'b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453'),
    ('concurrency_guard_v1', true, 'vault_target', 'afd9c6ea76bae2577984cbc05f1239c7d3f65a8324c130c6b725335d06655ebd')
),
jobs as (
  select
    j.jobid,
    j.schedule,
    j.active,
    j.username,
    encode(sha256(convert_to(btrim(regexp_replace(j.command, '\s+', ' ', 'g')), 'UTF8')), 'hex') as command_sha256
  from cron.job j
  where j.jobname = 'kapiloto-research-worker-every-2-min'
),
observed as (
  select
    (select count(*)::integer from jobs) as job_count,
    (select count(*)::integer from public.kapiloto_research_runs r
      where r.status in ('queued', 'running')) as active_runs,
    (select count(*)::integer from public.kapiloto_research_attempts a
      where a.status in ('queued', 'running')) as nonterminal_attempts
),
the_job as (
  select j.*, k.definition, k.semantics_current, k.routing
  from jobs j
  left join known k on k.command_sha256 = j.command_sha256
  where (select o.job_count from observed o) = 1
),
assessed as (
  select
    'kapiloto-research-worker-every-2-min'::text as jobname,
    p.desired,
    o.job_count,
    t.jobid,
    t.active,
    t.schedule,
    t.username,
    t.command_sha256,
    case when o.job_count = 1 then coalesce(t.definition, 'unknown') end as definition,
    t.routing,
    o.active_runs,
    o.nonterminal_attempts,
    case
      when p.desired is null or p.desired not in ('enabled', 'paused') then 'desired_state_required'
      when o.job_count > 1 then 'duplicate'
      when o.job_count = 0 and p.desired = 'paused' then 'in_sync'
      when o.job_count = 0 then 'absent'
      when p.desired = 'paused' and t.active then 'running_while_paused'
      when p.desired = 'paused' then 'in_sync'
      when t.definition is null then 'unknown_definition'
      when t.schedule <> '*/2 * * * *' then 'wrong_schedule'
      when not t.semantics_current and t.active then 'wrong_definition'
      when not t.semantics_current then 'inactive_wrong_definition'
      when not t.active then 'inactive'
      else 'in_sync'
    end as status
  from params p
  cross join observed o
  left join the_job t on true
),
planned as (
  select
    a.*,
    case
      when a.status = 'in_sync' then 'none'
      when a.status = 'running_while_paused' then 'pause'
      when a.status in ('wrong_definition', 'inactive_wrong_definition')
        and a.active_runs = 0
        and a.nonterminal_attempts = 0 then 'rewrite'
      when a.status = 'inactive' then 'resume'
      else 'refuse'
    end as action
  from assessed a
)
select
  pl.*,
  case
    when pl.status = 'desired_state_required' then 'set kapiloto_scheduler.desired to enabled or paused'
    when pl.status = 'duplicate' then 'more than one job has this name; resolve by hand'
    when pl.status = 'absent' then 'the job does not exist; re-creating it is a separately reviewed action, never a reconciliation'
    when pl.status = 'unknown_definition' then 'the command matches no reviewed definition; review it by hand'
    when pl.status = 'wrong_schedule' then 'the schedule is not */2 * * * *; review it by hand'
    when pl.action = 'refuse' then 'research work is queued or running; rewrite only on an idle queue'
    when pl.action = 'rewrite' then 'replace the command with concurrency_guard_v1; jobid, schedule and active flag unchanged'
    when pl.action = 'pause' then 'deactivate the job (active := false); the job is kept'
    when pl.action = 'resume' then 'reactivate the job; its definition is already concurrency_guard_v1'
    else 'nothing to do'
  end as detail,
  case
    when pl.action in ('rewrite', 'pause', 'resume') then
      pl.action || ':' || pl.jobname || ':jobid=' || pl.jobid::text
        || ':sha=' || left(pl.command_sha256, 16) || ':active=' || pl.active::text
  end as confirm_token
from planned pl
-- <<< worker scheduler state
  ) s;

  if v_after.job_count <> 1
     or v_after.jobid is distinct from v_before.jobid
     or v_after.schedule is distinct from v_before.schedule
     or (v_before.action = 'rewrite' and (
           v_after.definition is distinct from 'concurrency_guard_v1'
           or v_after.routing is distinct from 'hard_coded'
           or v_after.active is distinct from v_before.active))
     or (v_before.action = 'pause' and (
           v_after.active is distinct from false
           or v_after.command_sha256 is distinct from v_before.command_sha256))
     or (v_before.action = 'resume' and (
           v_after.active is distinct from true
           or v_after.status is distinct from 'in_sync'
           or v_after.command_sha256 is distinct from v_before.command_sha256)) then
    raise exception 'kapiloto scheduler: post-condition failed after % (status %, definition %, active %); rolled back',
      v_before.action, v_after.status, v_after.definition, v_after.active;
  end if;

  insert into public.admin_audit_log (action, entity_type, entity_id, metadata)
  values (
    'kapiloto_scheduler_reconcile',
    'cron_job',
    v_before.jobname,
    jsonb_build_object(
      'decision', 'D-065',
      'action', v_before.action,
      'desired', v_before.desired,
      'reason', v_reason,
      'confirm_token', v_confirm,
      'executed_by', current_user,
      'before', jsonb_build_object(
        'jobid', v_before.jobid, 'active', v_before.active, 'schedule', v_before.schedule,
        'definition', v_before.definition, 'routing', v_before.routing,
        'command_sha256', v_before.command_sha256, 'status', v_before.status),
      'after', jsonb_build_object(
        'jobid', v_after.jobid, 'active', v_after.active, 'schedule', v_after.schedule,
        'definition', v_after.definition, 'routing', v_after.routing,
        'command_sha256', v_after.command_sha256, 'status', v_after.status)
    )
  );

  raise notice 'kapiloto scheduler: APPLIED % on jobid %; now status=% definition=% active=%',
    v_before.action, v_before.jobid, v_after.status, v_after.definition, v_after.active;
end;
$scheduler_reconcile$;
