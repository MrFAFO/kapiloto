-- Kapiloto research-worker scheduler drift check (READ-ONLY; D-065, issue #60).
-- Not a migration; never place it under supabase/migrations.
--
-- Parameter, set in the SAME execution immediately before this query:
--   select set_config('kapiloto_scheduler.desired', 'enabled', true);   -- or 'paused'
--
-- Returns one row describing `kapiloto-research-worker-every-2-min`:
--   job_count / jobid / active / schedule   what cron.job holds;
--   command_sha256                          SHA-256 of the whitespace-collapsed command;
--   definition                              which reviewed command it is, or 'unknown':
--     scheduler_v1_single           20261020112327: one request per tick, always finalizing
--     parallelism_v1_unconditional  20261020114109: two requests per tick, both finalizing
--     concurrency_guard_v1          20261020120216: fill free capacity up to two live
--                                   attempts, slot 1 is the only finalizer (desired)
--   routing                                 hard_coded, or vault_target after D-064;
--                                           reported only, never acted on;
--   status                                  in_sync | wrong_definition | inactive_wrong_definition |
--                                           inactive | running_while_paused | absent | duplicate |
--                                           unknown_definition | wrong_schedule | desired_state_required;
--   action                                  none | rewrite | pause | resume | refuse;
--   confirm_token                           what the reconcile template requires to perform
--                                           `action`; it binds the action to this exact jobid,
--                                           command hash and active flag.
--
-- It reads cron.job, kapiloto_research_runs and kapiloto_research_attempts only.
-- It never reads a Vault secret and never reads a job command other than this job's.

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
;
