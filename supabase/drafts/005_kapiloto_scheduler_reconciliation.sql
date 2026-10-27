-- DRAFT — NOT A MIGRATION. Do not move into supabase/migrations until reviewed.
--
-- Kapiloto scheduler drift detection and explicit, idempotent repair.
--
-- Problem: every research-worker scheduler migration ends with
--   cron.unschedule(<job>) ; cron.schedule(<job>, ...)
-- so migration history can only say "this SQL ran once". Any later
-- out-of-band `cron.unschedule`, restore, or role-scoped visibility issue makes
-- `cron.job` diverge silently from what migrations imply.
--
-- Design:
-- 1. Desired state lives in a table, including an explicit paused flag with a
--    reason. Pausing during an incident changes desired state; it never
--    deletes the job behind the system's back.
-- 2. A read-only drift check compares desired state with cron.job.
-- 3. A separate repair function applies desired state only when called with
--    p_apply = true and an exact confirmation token. It never changes desired
--    state, so it cannot "helpfully" resume a paused worker.
-- 4. The seed below records the research worker as PAUSED (the incident
--    state), so applying this file cannot restart research.

create table if not exists private.kapiloto_scheduler_desired_state (
  jobname text primary key,
  desired_enabled boolean not null,
  schedule text not null,
  command text not null,
  paused_reason text,
  updated_at timestamptz not null default now(),
  updated_by text not null default current_user
);

revoke all on table private.kapiloto_scheduler_desired_state
from public, anon, authenticated;

-- Seed with the concurrency-guard command from
-- 20261020120216_kapiloto_research_worker_concurrency_guard_v1.sql,
-- copied verbatim when this draft is promoted. Desired state: PAUSED.
insert into private.kapiloto_scheduler_desired_state (
  jobname, desired_enabled, schedule, command, paused_reason
)
values (
  'kapiloto-research-worker-every-2-min',
  false,
  '*/2 * * * *',
  '<<copy the $cron$ body from 20261020120216 verbatim>>',
  'Incident 264201: paused pending Sol provider/schema fixes.'
)
on conflict (jobname) do nothing;

create or replace function public.kapiloto_scheduler_drift()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb := '[]'::jsonb;
  v_desired private.kapiloto_scheduler_desired_state%rowtype;
  v_job record;
  v_status text;
begin
  for v_desired in
    select * from private.kapiloto_scheduler_desired_state order by jobname
  loop
    -- Runs as the function owner: avoids per-role cron.job row visibility.
    select j.jobid, j.schedule, j.command, j.active, j.username
      into v_job
    from cron.job j
    where j.jobname = v_desired.jobname;

    v_status := case
      when v_desired.desired_enabled and v_job.jobid is null then 'missing'
      when v_desired.desired_enabled and not v_job.active then 'inactive'
      when v_desired.desired_enabled
        and (v_job.schedule <> v_desired.schedule
             or v_job.command <> v_desired.command) then 'definition_mismatch'
      when not v_desired.desired_enabled and v_job.jobid is not null
        then 'running_while_paused'
      else 'in_sync'
    end;

    v_result := v_result || jsonb_build_object(
      'jobname', v_desired.jobname,
      'expected', case when v_desired.desired_enabled then 'scheduled' else 'paused' end,
      'actual', case when v_job.jobid is null then 'absent'
                     when v_job.active then 'scheduled' else 'inactive' end,
      'status', v_status,
      'paused_reason', v_desired.paused_reason,
      'job_owner', v_job.username,
      'command_sha256_expected', encode(extensions.digest(v_desired.command, 'sha256'), 'hex'),
      'command_sha256_actual',
        case when v_job.command is null then null
             else encode(extensions.digest(v_job.command, 'sha256'), 'hex') end
    );
  end loop;

  return jsonb_build_object('checked_at', now(), 'jobs', v_result);
end;
$$;

create or replace function public.kapiloto_scheduler_reconcile(
  p_jobname text,
  p_apply boolean default false,
  p_confirm text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_desired private.kapiloto_scheduler_desired_state%rowtype;
  v_before jsonb := public.kapiloto_scheduler_drift();
begin
  select * into v_desired
  from private.kapiloto_scheduler_desired_state
  where jobname = p_jobname;

  if v_desired.jobname is null then
    raise exception 'No desired scheduler state for %', p_jobname;
  end if;

  if not p_apply then
    return jsonb_build_object('dry_run', true, 'drift', v_before);
  end if;

  if p_confirm is distinct from ('reconcile:' || p_jobname) then
    raise exception 'Repair requires p_confirm = ''reconcile:%''', p_jobname;
  end if;

  if v_desired.desired_enabled then
    perform cron.schedule(v_desired.jobname, v_desired.schedule, v_desired.command);
  else
    perform cron.unschedule(j.jobid)
    from cron.job j
    where j.jobname = v_desired.jobname;
  end if;

  insert into public.admin_audit_log (action, entity_type, entity_id, metadata)
  values (
    'scheduler_reconcile', 'cron_job', p_jobname,
    jsonb_build_object('desired_enabled', v_desired.desired_enabled, 'before', v_before)
  );

  return jsonb_build_object(
    'dry_run', false,
    'before', v_before,
    'after', public.kapiloto_scheduler_drift()
  );
end;
$$;

-- Explicit pause/resume: the only supported way to stop or restart research
-- work. Resuming still requires a separate reconcile(p_apply => true) call.
create or replace function public.kapiloto_set_scheduler_desired_enabled(
  p_jobname text,
  p_enabled boolean,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(trim(p_reason), '') is null then
    raise exception 'A reason is required to change scheduler desired state';
  end if;

  update private.kapiloto_scheduler_desired_state
  set desired_enabled = p_enabled,
      paused_reason = case when p_enabled then null else p_reason end,
      updated_at = now(),
      updated_by = current_user
  where jobname = p_jobname;

  if not found then
    raise exception 'No desired scheduler state for %', p_jobname;
  end if;

  insert into public.admin_audit_log (action, entity_type, entity_id, metadata)
  values (
    case when p_enabled then 'scheduler_resume_requested' else 'scheduler_pause' end,
    'cron_job', p_jobname, jsonb_build_object('reason', p_reason)
  );
end;
$$;

revoke all on function public.kapiloto_scheduler_drift() from public, anon, authenticated;
revoke all on function public.kapiloto_scheduler_reconcile(text, boolean, text) from public, anon, authenticated;
revoke all on function public.kapiloto_set_scheduler_desired_enabled(text, boolean, text) from public, anon, authenticated;
grant execute on function public.kapiloto_scheduler_drift() to service_role;
grant execute on function public.kapiloto_scheduler_reconcile(text, boolean, text) to service_role;
grant execute on function public.kapiloto_set_scheduler_desired_enabled(text, boolean, text) to service_role;

-- Follow-up rule for future scheduler migrations: update desired state, then
-- call kapiloto_scheduler_reconcile(..., true, 'reconcile:<job>') only when the
-- desired state is enabled. Never call cron.unschedule directly in a migration.

-- Finalization correctness (after 20261022083017_kapiloto_finalization_lifecycle_v1):
-- the scheduler no longer has to guarantee a single finalizer. The concurrency
-- guard's "slot 1 sends finalizeRuns=true" remains a cost optimisation only.
-- kapiloto_claim_run_finalization admits one owner per run (run-row lock +
-- partial unique index), publication is fenced by that claim, and attempts are
-- capped at 3 before the run is failed and the round released. When the job is
-- re-created, keep at most one finalization-capable worker per tick to avoid
-- needless claim calls, but do not rely on it for correctness.
