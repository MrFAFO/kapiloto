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
--   rewrite  command := concurrency_guard_v1 in the check's rewrite_routing
--            (jobid, schedule, active unchanged; see below);
--   pause    active := false (the job is kept, never unscheduled);
--   resume   active := true, only when desired is 'enabled', the job is
--            inactive and its definition is already concurrency_guard_v1.
-- It never creates, re-creates or unschedules a job, never changes a schedule,
-- owner or database, never touches another job, and never reads or writes a
-- Vault secret. A job not owned by postgres in database postgres is never
-- written, not even paused. Every refusal, a token mismatch and any failed
-- post-condition raise, which rolls the whole execution back. In sync means
-- nothing to do, whatever the token.
--
-- Idle-queue guard (rewrite only), enforced, not just observed: the template
-- requires READ COMMITTED, takes
--   LOCK TABLE public.kapiloto_research_runs, public.kapiloto_research_attempts IN SHARE MODE
-- with lock_timeout 2s, then re-derives the state and requires the same token
-- and the same rewrite_routing.
-- SHARE conflicts with the ROW EXCLUSIVE lock every INSERT/UPDATE/DELETE takes,
-- so no research run or attempt can be created or change status between that
-- re-check and commit; writers wait (milliseconds) and continue afterwards.
-- If the lock is not granted within 2s, or the queue is no longer idle, it
-- raises and nothing changes. Pause and resume take no lock: an emergency stop
-- never waits for research writers.
--
-- What a rewrite installs (D-064 routes the worker's URL through Vault):
--   vault_target  once D-064 is applied: the migration ledger records
--                 20261108100000_kapiloto_scheduler_target_guard_v1 (by version
--                 or by name), or the live-sync job already runs D-064's routed
--                 command. It installs exactly that migration's research-worker
--                 command, which reads its URL from the Vault secret
--                 kapiloto_research_worker_target_url and posts nothing without
--                 it. A drift after D-064 is never repaired to a hard-coded
--                 endpoint.
--   hard_coded    otherwise: exactly the scheduled command body of
--                 20261020120216_kapiloto_research_worker_concurrency_guard_v1.sql,
--                 the command D-064's migration expects before it routes the
--                 target.

do $scheduler_reconcile$
declare
  v_confirm text := nullif(btrim(current_setting('kapiloto_scheduler.confirm', true)), '');
  v_reason text := nullif(btrim(current_setting('kapiloto_scheduler.reason', true)), '');
  v_before record;
  v_locked record;
  v_after record;
  v_install_routing text;
  v_desired_command text;
  -- rewrite_routing = hard_coded: 20261020120216_kapiloto_research_worker_concurrency_guard_v1.sql.
  v_hard_coded_command constant text := $cron$
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
  -- rewrite_routing = vault_target: the research-worker command of
  -- 20261108100000_kapiloto_scheduler_target_guard_v1.sql (D-064).
  v_routed_command constant text := $cron$
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
  $cron$;
begin
  select s.* into v_before from (
-- >>> worker scheduler state (shared verbatim with kapiloto-research-worker-scheduler-reconcile.sql)
with params as (
  select
    nullif(btrim(current_setting('kapiloto_scheduler.desired', true)), '') as desired,
    'postgres'::text as expected_username,
    'postgres'::text as expected_database
),
known (definition, semantics_current, routing, command_sha256) as (
  values
    ('scheduler_v1_single', false, 'hard_coded', '6c5cafc2bee207442366050772e437ccdb225c97bb52253d137857b2f44c9252'),
    ('parallelism_v1_unconditional', false, 'hard_coded', '65b8317f539a34e8297c17e9c633a84ca2e00a43b2b2fb885edf87609c2220b3'),
    ('concurrency_guard_v1', true, 'hard_coded', 'b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453'),
    ('concurrency_guard_v1', true, 'vault_target', 'afd9c6ea76bae2577984cbc05f1239c7d3f65a8324c130c6b725335d06655ebd')
),
d064 as (
  select
    exists (
      select 1
      from supabase_migrations.schema_migrations m
      where m.version = '20261108100000'
        or m.name = 'kapiloto_scheduler_target_guard_v1'
    ) as d064_recorded,
    exists (
      select 1
      from cron.job l
      where l.jobname = 'kapiloto-live-sync-every-2-min'
        and encode(sha256(convert_to(btrim(regexp_replace(l.command, '\s+', ' ', 'g')), 'UTF8')), 'hex')
          = 'f45be91f919fe489b6b01e0987942b76790573cff900cf9b1c35febf829e096c'
    ) as d064_live_sync_routed
),
jobs as (
  select
    j.jobid,
    j.schedule,
    j.active,
    j.username,
    j.database,
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
    t.database,
    t.command_sha256,
    case when o.job_count = 1 then coalesce(t.definition, 'unknown') end as definition,
    t.routing,
    o.active_runs,
    o.nonterminal_attempts,
    d.d064_recorded,
    d.d064_live_sync_routed,
    case
      when d.d064_recorded or d.d064_live_sync_routed then 'vault_target'
      else 'hard_coded'
    end as rewrite_routing,
    case
      when p.desired is null or p.desired not in ('enabled', 'paused') then 'desired_state_required'
      when o.job_count > 1 then 'duplicate'
      when o.job_count = 0 and p.desired = 'paused' then 'in_sync'
      when o.job_count = 0 then 'absent'
      when t.username is distinct from p.expected_username
        or t.database is distinct from p.expected_database then 'unexpected_job_identity'
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
  cross join d064 d
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
    when pl.status = 'unexpected_job_identity' then 'the job is not owned by postgres in database postgres; nothing is written, a pause included; review it by hand'
    when pl.status = 'unknown_definition' then 'the command matches no reviewed definition; review it by hand'
    when pl.status = 'wrong_schedule' then 'the schedule is not */2 * * * *; review it by hand'
    when pl.action = 'refuse' then 'research work is queued or running; rewrite only on an idle queue'
    when pl.action = 'rewrite' and pl.rewrite_routing = 'vault_target'
      then 'replace the command with D-064''s Vault-routed concurrency_guard_v1 (D-064 is applied); jobid, schedule and active flag unchanged'
    when pl.action = 'rewrite' then 'replace the command with the hard-coded concurrency_guard_v1 (D-064 is not applied); jobid, schedule and active flag unchanged'
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

  raise notice 'kapiloto scheduler: desired=% jobs=% jobid=% active=% definition=% routing=% runs=% attempts=% status=% action=% rewrite_routing=% (d064_recorded=% d064_live_sync_routed=%)',
    v_before.desired, v_before.job_count, v_before.jobid, v_before.active, v_before.definition,
    v_before.routing, v_before.active_runs, v_before.nonterminal_attempts, v_before.status, v_before.action,
    v_before.rewrite_routing, v_before.d064_recorded, v_before.d064_live_sync_routed;

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
    -- Under REPEATABLE READ or SERIALIZABLE the re-check below would read the
    -- snapshot from before the lock and could miss a run committed meanwhile.
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'kapiloto scheduler: run in READ COMMITTED (got %); nothing changed',
        current_setting('transaction_isolation');
    end if;
    perform set_config('lock_timeout', '2s', true);
    lock table public.kapiloto_research_runs, public.kapiloto_research_attempts in share mode;

    select s.* into v_locked from (
-- >>> worker scheduler state (shared verbatim with kapiloto-research-worker-scheduler-reconcile.sql)
with params as (
  select
    nullif(btrim(current_setting('kapiloto_scheduler.desired', true)), '') as desired,
    'postgres'::text as expected_username,
    'postgres'::text as expected_database
),
known (definition, semantics_current, routing, command_sha256) as (
  values
    ('scheduler_v1_single', false, 'hard_coded', '6c5cafc2bee207442366050772e437ccdb225c97bb52253d137857b2f44c9252'),
    ('parallelism_v1_unconditional', false, 'hard_coded', '65b8317f539a34e8297c17e9c633a84ca2e00a43b2b2fb885edf87609c2220b3'),
    ('concurrency_guard_v1', true, 'hard_coded', 'b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453'),
    ('concurrency_guard_v1', true, 'vault_target', 'afd9c6ea76bae2577984cbc05f1239c7d3f65a8324c130c6b725335d06655ebd')
),
d064 as (
  select
    exists (
      select 1
      from supabase_migrations.schema_migrations m
      where m.version = '20261108100000'
        or m.name = 'kapiloto_scheduler_target_guard_v1'
    ) as d064_recorded,
    exists (
      select 1
      from cron.job l
      where l.jobname = 'kapiloto-live-sync-every-2-min'
        and encode(sha256(convert_to(btrim(regexp_replace(l.command, '\s+', ' ', 'g')), 'UTF8')), 'hex')
          = 'f45be91f919fe489b6b01e0987942b76790573cff900cf9b1c35febf829e096c'
    ) as d064_live_sync_routed
),
jobs as (
  select
    j.jobid,
    j.schedule,
    j.active,
    j.username,
    j.database,
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
    t.database,
    t.command_sha256,
    case when o.job_count = 1 then coalesce(t.definition, 'unknown') end as definition,
    t.routing,
    o.active_runs,
    o.nonterminal_attempts,
    d.d064_recorded,
    d.d064_live_sync_routed,
    case
      when d.d064_recorded or d.d064_live_sync_routed then 'vault_target'
      else 'hard_coded'
    end as rewrite_routing,
    case
      when p.desired is null or p.desired not in ('enabled', 'paused') then 'desired_state_required'
      when o.job_count > 1 then 'duplicate'
      when o.job_count = 0 and p.desired = 'paused' then 'in_sync'
      when o.job_count = 0 then 'absent'
      when t.username is distinct from p.expected_username
        or t.database is distinct from p.expected_database then 'unexpected_job_identity'
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
  cross join d064 d
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
    when pl.status = 'unexpected_job_identity' then 'the job is not owned by postgres in database postgres; nothing is written, a pause included; review it by hand'
    when pl.status = 'unknown_definition' then 'the command matches no reviewed definition; review it by hand'
    when pl.status = 'wrong_schedule' then 'the schedule is not */2 * * * *; review it by hand'
    when pl.action = 'refuse' then 'research work is queued or running; rewrite only on an idle queue'
    when pl.action = 'rewrite' and pl.rewrite_routing = 'vault_target'
      then 'replace the command with D-064''s Vault-routed concurrency_guard_v1 (D-064 is applied); jobid, schedule and active flag unchanged'
    when pl.action = 'rewrite' then 'replace the command with the hard-coded concurrency_guard_v1 (D-064 is not applied); jobid, schedule and active flag unchanged'
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

    if v_locked.action is distinct from 'rewrite'
       or v_locked.confirm_token is distinct from v_before.confirm_token
       or v_locked.rewrite_routing is distinct from v_before.rewrite_routing then
      raise exception 'kapiloto scheduler: state changed before the idle-queue lock was held (now status %, action %, runs %, attempts %, rewrite_routing %); nothing changed',
        v_locked.status, v_locked.action, v_locked.active_runs, v_locked.nonterminal_attempts, v_locked.rewrite_routing;
    end if;

    v_install_routing := v_locked.rewrite_routing;
    v_desired_command := case v_install_routing
      when 'vault_target' then v_routed_command
      when 'hard_coded' then v_hard_coded_command
    end;
    if v_desired_command is null then
      raise exception 'kapiloto scheduler: no reviewed command for rewrite_routing %; nothing changed', v_install_routing;
    end if;

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
  select
    nullif(btrim(current_setting('kapiloto_scheduler.desired', true)), '') as desired,
    'postgres'::text as expected_username,
    'postgres'::text as expected_database
),
known (definition, semantics_current, routing, command_sha256) as (
  values
    ('scheduler_v1_single', false, 'hard_coded', '6c5cafc2bee207442366050772e437ccdb225c97bb52253d137857b2f44c9252'),
    ('parallelism_v1_unconditional', false, 'hard_coded', '65b8317f539a34e8297c17e9c633a84ca2e00a43b2b2fb885edf87609c2220b3'),
    ('concurrency_guard_v1', true, 'hard_coded', 'b37670903bc0055b1cc12ae5551643d83c85c3ab5260aed6f20c646b1912d453'),
    ('concurrency_guard_v1', true, 'vault_target', 'afd9c6ea76bae2577984cbc05f1239c7d3f65a8324c130c6b725335d06655ebd')
),
d064 as (
  select
    exists (
      select 1
      from supabase_migrations.schema_migrations m
      where m.version = '20261108100000'
        or m.name = 'kapiloto_scheduler_target_guard_v1'
    ) as d064_recorded,
    exists (
      select 1
      from cron.job l
      where l.jobname = 'kapiloto-live-sync-every-2-min'
        and encode(sha256(convert_to(btrim(regexp_replace(l.command, '\s+', ' ', 'g')), 'UTF8')), 'hex')
          = 'f45be91f919fe489b6b01e0987942b76790573cff900cf9b1c35febf829e096c'
    ) as d064_live_sync_routed
),
jobs as (
  select
    j.jobid,
    j.schedule,
    j.active,
    j.username,
    j.database,
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
    t.database,
    t.command_sha256,
    case when o.job_count = 1 then coalesce(t.definition, 'unknown') end as definition,
    t.routing,
    o.active_runs,
    o.nonterminal_attempts,
    d.d064_recorded,
    d.d064_live_sync_routed,
    case
      when d.d064_recorded or d.d064_live_sync_routed then 'vault_target'
      else 'hard_coded'
    end as rewrite_routing,
    case
      when p.desired is null or p.desired not in ('enabled', 'paused') then 'desired_state_required'
      when o.job_count > 1 then 'duplicate'
      when o.job_count = 0 and p.desired = 'paused' then 'in_sync'
      when o.job_count = 0 then 'absent'
      when t.username is distinct from p.expected_username
        or t.database is distinct from p.expected_database then 'unexpected_job_identity'
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
  cross join d064 d
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
    when pl.status = 'unexpected_job_identity' then 'the job is not owned by postgres in database postgres; nothing is written, a pause included; review it by hand'
    when pl.status = 'unknown_definition' then 'the command matches no reviewed definition; review it by hand'
    when pl.status = 'wrong_schedule' then 'the schedule is not */2 * * * *; review it by hand'
    when pl.action = 'refuse' then 'research work is queued or running; rewrite only on an idle queue'
    when pl.action = 'rewrite' and pl.rewrite_routing = 'vault_target'
      then 'replace the command with D-064''s Vault-routed concurrency_guard_v1 (D-064 is applied); jobid, schedule and active flag unchanged'
    when pl.action = 'rewrite' then 'replace the command with the hard-coded concurrency_guard_v1 (D-064 is not applied); jobid, schedule and active flag unchanged'
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
     or v_after.username is distinct from v_before.username
     or v_after.database is distinct from v_before.database
     or v_after.status = 'unexpected_job_identity'
     or (v_before.action = 'rewrite' and (
           v_after.definition is distinct from 'concurrency_guard_v1'
           or v_after.routing is distinct from v_install_routing
           or v_after.active is distinct from v_before.active))
     or (v_before.action = 'pause' and (
           v_after.active is distinct from false
           or v_after.command_sha256 is distinct from v_before.command_sha256))
     or (v_before.action = 'resume' and (
           v_after.active is distinct from true
           or v_after.status is distinct from 'in_sync'
           or v_after.command_sha256 is distinct from v_before.command_sha256)) then
    raise exception 'kapiloto scheduler: post-condition failed after % (status %, definition %, routing %, active %); rolled back',
      v_before.action, v_after.status, v_after.definition, v_after.routing, v_after.active;
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
      'idle_queue_locked', v_before.action = 'rewrite',
      'before', jsonb_build_object(
        'jobid', v_before.jobid, 'active', v_before.active, 'schedule', v_before.schedule,
        'username', v_before.username, 'database', v_before.database,
        'definition', v_before.definition, 'routing', v_before.routing,
        'command_sha256', v_before.command_sha256, 'status', v_before.status),
      'after', jsonb_build_object(
        'jobid', v_after.jobid, 'active', v_after.active, 'schedule', v_after.schedule,
        'definition', v_after.definition, 'routing', v_after.routing,
        'command_sha256', v_after.command_sha256, 'status', v_after.status)
    )
  );

  raise notice 'kapiloto scheduler: APPLIED % on jobid %; now status=% definition=% active=% routing=%',
    v_before.action, v_before.jobid, v_after.status, v_after.definition, v_after.active, v_after.routing;
end;
$scheduler_reconcile$;
