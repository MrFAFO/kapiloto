-- Kapiloto run finalization lifecycle: database-owned single-finalizer claim,
-- lease recovery, bounded retries and terminal failure.
--
-- Before this migration finalization had no persistent state. Overlapping
-- scheduler ticks could run two finalizers (duplicate paid entailment), and a
-- permanently failing finalization was retried every tick forever while the
-- run stayed active.
--
-- Lock order everywhere in this file: research run row first, then the
-- finalization attempt row, then round research state. This matches
-- kapiloto_materialize_and_complete_run / kapiloto_complete_research_run.

create table public.kapiloto_run_finalization_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.kapiloto_research_runs(id) on delete restrict,
  attempt_no smallint not null check (attempt_no between 1 and 10),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'abandoned')),
  worker_id text not null,
  claimed_at timestamptz not null default now(),
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  failure_class text check (failure_class is null or failure_class in (
    'operational', 'terminal', 'lease_expired'
  )),
  failure_code text,
  failure_detail text,
  retryable boolean,
  next_available_at timestamptz,
  -- Observability: written by heartbeat progress, publish and fail. Values
  -- the provider did not return stay null; nothing is estimated here.
  checked_claims integer check (checked_claims is null or checked_claims >= 0),
  unsupported_claims integer check (unsupported_claims is null or unsupported_claims >= 0),
  downgraded_fixture_ids jsonb not null default '[]'::jsonb,
  entailment_response_ids text[] not null default '{}',
  entailment_model text,
  input_tokens integer,
  cached_input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  total_tokens integer,
  publication jsonb,
  report jsonb not null default '{}'::jsonb,
  unique (run_id, attempt_no),
  check (status <> 'running' or lease_expires_at is not null),
  check (status not in ('succeeded', 'failed', 'abandoned') or finished_at is not null),
  check (status <> 'failed' or (failure_class is not null and retryable is not null))
);

-- At most one live finalizer per run, enforced by the database.
create unique index kapiloto_run_finalization_one_running_uq
  on public.kapiloto_run_finalization_attempts (run_id)
  where status = 'running';

create unique index kapiloto_run_finalization_one_success_uq
  on public.kapiloto_run_finalization_attempts (run_id)
  where status = 'succeeded';

create index kapiloto_run_finalization_run_idx
  on public.kapiloto_run_finalization_attempts (run_id, attempt_no desc);

alter table public.kapiloto_run_finalization_attempts enable row level security;
revoke all on table public.kapiloto_run_finalization_attempts
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal: fail a run whose finalization can no longer succeed.
-- Caller must already hold the run row lock.
-- ---------------------------------------------------------------------------
create or replace function private.kapiloto_terminate_run_finalization(
  p_run_id uuid,
  p_failure_class text,
  p_failure_detail text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round_id uuid;
begin
  update public.kapiloto_research_runs
  set status = 'failed',
      failed_at = now(),
      failure_class = p_failure_class,
      failure_detail = left(p_failure_detail, 2000)
  where id = p_run_id
    and status in ('queued', 'running')
  returning round_id into v_round_id;

  if v_round_id is null then
    return;
  end if;

  -- Release the round so the run can never stay active forever. The budget
  -- slot is neither refunded nor re-consumed here; no new run is created.
  update public.kapiloto_round_research_state
  set active_run_id = null,
      version = version + 1,
      updated_at = now()
  where round_id = v_round_id
    and active_run_id = p_run_id;
end;
$$;

revoke all on function private.kapiloto_terminate_run_finalization(uuid, text, text)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal: merge observability fields reported by the worker.
-- ---------------------------------------------------------------------------
create or replace function private.kapiloto_apply_finalization_observability(
  p_attempt_id uuid,
  p_observability jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_observability is null or jsonb_typeof(p_observability) <> 'object' then
    return;
  end if;

  update public.kapiloto_run_finalization_attempts
  set checked_claims = coalesce((p_observability ->> 'checked_claims')::integer, checked_claims),
      unsupported_claims = coalesce((p_observability ->> 'unsupported_claims')::integer, unsupported_claims),
      downgraded_fixture_ids = coalesce(p_observability -> 'downgraded_fixture_ids', downgraded_fixture_ids),
      entailment_response_ids = coalesce(
        array(select jsonb_array_elements_text(p_observability -> 'entailment_response_ids')),
        entailment_response_ids
      ),
      entailment_model = coalesce(p_observability ->> 'entailment_model', entailment_model),
      input_tokens = coalesce((p_observability ->> 'input_tokens')::integer, input_tokens),
      cached_input_tokens = coalesce((p_observability ->> 'cached_input_tokens')::integer, cached_input_tokens),
      output_tokens = coalesce((p_observability ->> 'output_tokens')::integer, output_tokens),
      reasoning_tokens = coalesce((p_observability ->> 'reasoning_tokens')::integer, reasoning_tokens),
      total_tokens = coalesce((p_observability ->> 'total_tokens')::integer, total_tokens),
      report = report || coalesce(p_observability -> 'report', '{}'::jsonb)
  where id = p_attempt_id;
end;
$$;

revoke all on function private.kapiloto_apply_finalization_observability(uuid, jsonb)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Claim: atomic single-finalizer ownership with lease and bounded attempts.
-- Outcomes: claimed | already_claimed | already_completed | not_finalizable |
--           not_ready | backoff | exhausted
-- ---------------------------------------------------------------------------
create or replace function public.kapiloto_claim_run_finalization(
  p_run_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 180,
  p_max_attempts integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.kapiloto_research_runs%rowtype;
  v_live public.kapiloto_run_finalization_attempts%rowtype;
  v_last public.kapiloto_run_finalization_attempts%rowtype;
  v_attempt_count integer;
  v_active_tasks integer;
  v_missing_tasks integer;
  v_attempt_id uuid;
  v_lease timestamptz;
begin
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'lease must be between 30 and 3600 seconds';
  end if;
  if p_max_attempts < 1 or p_max_attempts > 3 then
    raise exception 'max finalization attempts must be between 1 and 3';
  end if;

  -- Serialize every claim for this run on the run row.
  select r.* into v_run
  from public.kapiloto_research_runs r
  where r.id = p_run_id
  for update;

  if not found then
    raise exception 'Kapiloto research run not found';
  end if;

  if v_run.status = 'completed' then
    return jsonb_build_object('outcome', 'already_completed', 'run_id', p_run_id);
  end if;
  if v_run.status not in ('queued', 'running') then
    return jsonb_build_object(
      'outcome', 'not_finalizable', 'run_id', p_run_id, 'run_status', v_run.status
    );
  end if;

  select a.* into v_live
  from public.kapiloto_run_finalization_attempts a
  where a.run_id = p_run_id and a.status = 'running'
  for update;

  if found then
    if v_live.lease_expires_at > now() then
      return jsonb_build_object(
        'outcome', 'already_claimed',
        'run_id', p_run_id,
        'attempt_no', v_live.attempt_no,
        'worker_id', v_live.worker_id,
        'lease_expires_at', v_live.lease_expires_at
      );
    end if;

    -- Crashed finalizer: its lease expired. Abandoning it counts as one of
    -- the bounded attempts, so repeated crashes cannot loop forever.
    update public.kapiloto_run_finalization_attempts
    set status = 'abandoned',
        finished_at = now(),
        failure_class = 'lease_expired',
        failure_code = 'lease_expired',
        failure_detail = 'Finalizer lease expired before a terminal result.',
        retryable = true,
        lease_expires_at = null
    where id = v_live.id;
  end if;

  -- Readiness is re-checked here so the database, not the caller, decides.
  select count(*) into v_active_tasks
  from public.kapiloto_research_attempts a
  where a.run_id = p_run_id and a.status in ('queued', 'running');

  if v_active_tasks > 0 then
    return jsonb_build_object(
      'outcome', 'not_ready', 'run_id', p_run_id,
      'reason', 'active_attempts:' || v_active_tasks
    );
  end if;

  -- Match by round game, not task_key: the research RPC keys attempts as
  -- 'fixture:<round_game_id>' while fixture_set.taskKey uses the fixture id.
  select count(*) into v_missing_tasks
  from jsonb_array_elements(v_run.fixture_set) f
  where f ->> 'mode' = 'research'
    and not exists (
      select 1
      from public.kapiloto_research_attempts a
      where a.run_id = p_run_id
        and a.status = 'succeeded'
        and a.round_game_id::text = f ->> 'roundGameId'
    );

  if v_missing_tasks > 0 then
    return jsonb_build_object(
      'outcome', 'not_ready', 'run_id', p_run_id,
      'reason', 'missing_succeeded_tasks:' || v_missing_tasks
    );
  end if;

  select count(*) into v_attempt_count
  from public.kapiloto_run_finalization_attempts a
  where a.run_id = p_run_id;

  select a.* into v_last
  from public.kapiloto_run_finalization_attempts a
  where a.run_id = p_run_id
  order by a.attempt_no desc
  limit 1;

  if v_last.id is not null and v_last.retryable is false then
    perform private.kapiloto_terminate_run_finalization(
      p_run_id, 'internal',
      'Kapiloto finalization failed terminally: ' || coalesce(v_last.failure_code, 'unknown')
    );
    return jsonb_build_object('outcome', 'exhausted', 'run_id', p_run_id, 'reason', 'terminal_failure');
  end if;

  if v_attempt_count >= p_max_attempts then
    perform private.kapiloto_terminate_run_finalization(
      p_run_id,
      case when v_last.failure_class = 'lease_expired' then 'worker_lost' else 'provider_transient' end,
      'Kapiloto finalization exhausted ' || v_attempt_count || ' attempts; last failure: '
        || coalesce(v_last.failure_code, 'unknown')
    );
    return jsonb_build_object(
      'outcome', 'exhausted', 'run_id', p_run_id, 'attempts', v_attempt_count
    );
  end if;

  if v_last.id is not null
     and v_last.status = 'failed'
     and v_last.next_available_at is not null
     and v_last.next_available_at > now() then
    return jsonb_build_object(
      'outcome', 'backoff', 'run_id', p_run_id,
      'next_available_at', v_last.next_available_at
    );
  end if;

  v_lease := now() + make_interval(secs => p_lease_seconds);

  insert into public.kapiloto_run_finalization_attempts (
    run_id, attempt_no, status, worker_id, claimed_at, heartbeat_at,
    lease_expires_at, started_at
  )
  values (
    p_run_id, v_attempt_count + 1, 'running', p_worker_id, now(), now(),
    v_lease, now()
  )
  returning id into v_attempt_id;

  return jsonb_build_object(
    'outcome', 'claimed',
    'run_id', p_run_id,
    'attempt_id', v_attempt_id,
    'attempt_no', v_attempt_count + 1,
    'lease_expires_at', v_lease
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Heartbeat: extend the lease while still the owner; optionally persist
-- progress (e.g. paid entailment usage) so a crash after a paid call keeps it.
-- ---------------------------------------------------------------------------
create or replace function public.kapiloto_heartbeat_run_finalization(
  p_attempt_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 180,
  p_observability jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'lease must be between 30 and 3600 seconds';
  end if;

  update public.kapiloto_run_finalization_attempts
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_attempt_id
    and worker_id = p_worker_id
    and status = 'running';

  if not found then
    return false;
  end if;

  perform private.kapiloto_apply_finalization_observability(p_attempt_id, p_observability);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Publish: fenced by the claim. Delegates to the unchanged identity-guarded
-- kapiloto_materialize_and_complete_run inside the same transaction, then
-- marks the claim succeeded. Any materialization exception rolls back both.
-- ---------------------------------------------------------------------------
create or replace function public.kapiloto_publish_run_finalization(
  p_attempt_id uuid,
  p_worker_id text,
  p_analyses jsonb,
  p_round_synthesis jsonb default '{}'::jsonb,
  p_observability jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.kapiloto_run_finalization_attempts%rowtype;
  v_run public.kapiloto_research_runs%rowtype;
  v_result jsonb;
begin
  select a.* into v_attempt
  from public.kapiloto_run_finalization_attempts a
  where a.id = p_attempt_id;

  if not found then
    raise exception 'Kapiloto finalization attempt not found';
  end if;

  -- Lock order: run first, then the attempt.
  select r.* into v_run
  from public.kapiloto_research_runs r
  where r.id = v_attempt.run_id
  for update;

  select a.* into v_attempt
  from public.kapiloto_run_finalization_attempts a
  where a.id = p_attempt_id
  for update;

  if v_run.status = 'completed' then
    -- Another finalizer (or this one before a crash) already published.
    v_result := public.kapiloto_complete_research_run(
      v_run.id, coalesce(p_round_synthesis, '{}'::jsonb)
    );
    if v_attempt.status = 'running' and v_attempt.worker_id = p_worker_id then
      update public.kapiloto_run_finalization_attempts
      set status = 'succeeded', finished_at = now(), lease_expires_at = null,
          publication = v_result
      where id = p_attempt_id
        and not exists (
          select 1 from public.kapiloto_run_finalization_attempts s
          where s.run_id = v_run.id and s.status = 'succeeded'
        );
    end if;
    return v_result || jsonb_build_object('claim_outcome', 'already_completed');
  end if;

  if v_attempt.status <> 'running' or v_attempt.worker_id <> p_worker_id then
    raise exception 'Kapiloto finalization claim lost';
  end if;

  v_result := public.kapiloto_materialize_and_complete_run(
    v_run.id, p_analyses, coalesce(p_round_synthesis, '{}'::jsonb)
  );

  perform private.kapiloto_apply_finalization_observability(p_attempt_id, p_observability);

  update public.kapiloto_run_finalization_attempts
  set status = 'succeeded',
      finished_at = now(),
      lease_expires_at = null,
      publication = v_result
  where id = p_attempt_id;

  return v_result || jsonb_build_object(
    'claim_outcome', 'published',
    'finalization_attempt_no', v_attempt.attempt_no
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Fail: record an operational or terminal finalization failure. Terminal or
-- exhausted failures fail the run and release the round immediately.
-- Outcomes: claim_lost | retry_scheduled | run_failed
-- ---------------------------------------------------------------------------
create or replace function public.kapiloto_fail_run_finalization(
  p_attempt_id uuid,
  p_worker_id text,
  p_retryable boolean,
  p_failure_code text,
  p_failure_detail text,
  p_retry_delay_seconds integer default 60,
  p_observability jsonb default null,
  p_max_attempts integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.kapiloto_run_finalization_attempts%rowtype;
  v_run public.kapiloto_research_runs%rowtype;
begin
  if p_retry_delay_seconds < 0 or p_retry_delay_seconds > 3600 then
    raise exception 'retry delay is outside allowed range';
  end if;
  if p_max_attempts < 1 or p_max_attempts > 3 then
    raise exception 'max finalization attempts must be between 1 and 3';
  end if;

  select a.* into v_attempt
  from public.kapiloto_run_finalization_attempts a
  where a.id = p_attempt_id;

  if not found then
    raise exception 'Kapiloto finalization attempt not found';
  end if;

  select r.* into v_run
  from public.kapiloto_research_runs r
  where r.id = v_attempt.run_id
  for update;

  select a.* into v_attempt
  from public.kapiloto_run_finalization_attempts a
  where a.id = p_attempt_id
  for update;

  if v_attempt.status <> 'running' or v_attempt.worker_id <> p_worker_id then
    return jsonb_build_object('outcome', 'claim_lost', 'run_id', v_attempt.run_id);
  end if;

  perform private.kapiloto_apply_finalization_observability(p_attempt_id, p_observability);

  update public.kapiloto_run_finalization_attempts
  set status = 'failed',
      finished_at = now(),
      lease_expires_at = null,
      failure_class = case when p_retryable then 'operational' else 'terminal' end,
      failure_code = p_failure_code,
      failure_detail = left(p_failure_detail, 2000),
      retryable = p_retryable,
      next_available_at = case
        when p_retryable then now() + make_interval(secs => p_retry_delay_seconds)
        else null
      end
  where id = p_attempt_id;

  if not p_retryable or v_attempt.attempt_no >= p_max_attempts then
    perform private.kapiloto_terminate_run_finalization(
      v_attempt.run_id,
      case when p_retryable then 'provider_transient' else 'internal' end,
      'Kapiloto finalization ' ||
        case when p_retryable then 'exhausted' else 'failed terminally' end ||
        ' at attempt ' || v_attempt.attempt_no || ': ' || coalesce(p_failure_code, 'unknown')
    );
    return jsonb_build_object(
      'outcome', 'run_failed', 'run_id', v_attempt.run_id,
      'attempt_no', v_attempt.attempt_no
    );
  end if;

  return jsonb_build_object(
    'outcome', 'retry_scheduled', 'run_id', v_attempt.run_id,
    'attempt_no', v_attempt.attempt_no,
    'next_available_at', now() + make_interval(secs => p_retry_delay_seconds)
  );
end;
$$;

revoke all on function public.kapiloto_claim_run_finalization(uuid, text, integer, integer)
from public, anon, authenticated;
revoke all on function public.kapiloto_heartbeat_run_finalization(uuid, text, integer, jsonb)
from public, anon, authenticated;
revoke all on function public.kapiloto_publish_run_finalization(uuid, text, jsonb, jsonb, jsonb)
from public, anon, authenticated;
revoke all on function public.kapiloto_fail_run_finalization(uuid, text, boolean, text, text, integer, jsonb, integer)
from public, anon, authenticated;

grant execute on function public.kapiloto_claim_run_finalization(uuid, text, integer, integer)
to service_role;
grant execute on function public.kapiloto_heartbeat_run_finalization(uuid, text, integer, jsonb)
to service_role;
grant execute on function public.kapiloto_publish_run_finalization(uuid, text, jsonb, jsonb, jsonb)
to service_role;
grant execute on function public.kapiloto_fail_run_finalization(uuid, text, boolean, text, text, integer, jsonb, integer)
to service_role;

-- The unfenced materialization RPC stays service_role-only for replay and
-- operator use, but the worker publishes exclusively through
-- kapiloto_publish_run_finalization.
