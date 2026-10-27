-- Kapiloto task-lease RPCs DRAFT.
-- Not applied to a Supabase project yet.
--
-- All functions are service_role-only. They implement fixture-task claiming,
-- heartbeats, bounded retries and abandoned-worker recovery.

create or replace function public.kapiloto_claim_research_attempt(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
set search_path = ''
as $claim$
declare
  v_attempt public.kapiloto_research_attempts%rowtype;
  v_run public.kapiloto_research_runs%rowtype;
  v_fixture_card jsonb;
begin
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'worker_id is required';
  end if;

  if p_lease_seconds < 60 or p_lease_seconds > 3600 then
    raise exception 'lease_seconds must be between 60 and 3600';
  end if;

  select a.*
    into v_attempt
  from public.kapiloto_research_attempts a
  join public.kapiloto_research_runs r on r.id = a.run_id
  where a.status = 'queued'
    and a.available_at <= now()
    and r.status in ('queued', 'running')
  order by a.available_at, a.id
  for update of a skip locked
  limit 1;

  if not found then
    return null;
  end if;

  select r.*
    into v_run
  from public.kapiloto_research_runs r
  where r.id = v_attempt.run_id
  for update;

  if v_attempt.round_game_id is not null then
    select fixture -> 'card'
      into v_fixture_card
    from jsonb_array_elements(v_run.fixture_set) fixture
    where fixture ->> 'mode' = 'research'
      and fixture ->> 'roundGameId' = v_attempt.round_game_id::text
    limit 1;

    if v_fixture_card is null then
      raise exception 'research attempt has no matching fixture card in run snapshot';
    end if;
  end if;

  update public.kapiloto_research_attempts
  set status = 'running',
      worker_id = p_worker_id,
      claimed_at = now(),
      heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = v_attempt.id
  returning * into v_attempt;

  update public.kapiloto_research_runs
  set status = 'running',
      started_at = coalesce(started_at, now())
  where id = v_run.id
    and status = 'queued'
  returning * into v_run;

  if not found then
    select r.*
      into v_run
    from public.kapiloto_research_runs r
    where r.id = v_attempt.run_id;
  end if;

  return jsonb_build_object(
    'attempt_id', v_attempt.id,
    'run_id', v_attempt.run_id,
    'round_id', v_attempt.round_id,
    'task_key', v_attempt.task_key,
    'round_game_id', v_attempt.round_game_id,
    'attempt_no', v_attempt.attempt_no,
    'lease_expires_at', v_attempt.lease_expires_at,
    'fixture_card', v_fixture_card,
    'run', jsonb_build_object(
      'model_key', v_run.model_key,
      'research_protocol_version', v_run.research_protocol_version,
      'prompt_template_sha256', v_run.prompt_template_sha256,
      'max_attempts_per_task', v_run.max_attempts_per_task,
      'execution_topology', v_run.execution_topology,
      'research_cutoff_at', v_run.research_cutoff_at
    )
  );
end;
$claim$;

create or replace function public.kapiloto_heartbeat_research_attempt(
  p_attempt_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
set search_path = ''
as $heartbeat$
declare
  v_updated integer;
begin
  if p_lease_seconds < 60 or p_lease_seconds > 3600 then
    raise exception 'lease_seconds must be between 60 and 3600';
  end if;

  update public.kapiloto_research_attempts
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_attempt_id
    and status = 'running'
    and worker_id = p_worker_id
    and lease_expires_at >= now();

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$heartbeat$;

create or replace function public.kapiloto_finish_research_attempt(
  p_attempt_id uuid,
  p_worker_id text,
  p_success boolean,
  p_retryable boolean,
  p_retry_delay_seconds integer,
  p_model_snapshot text,
  p_provider_response_id text,
  p_input_tokens integer,
  p_cached_input_tokens integer,
  p_output_tokens integer,
  p_reasoning_tokens integer,
  p_web_search_calls integer,
  p_sources_count integer,
  p_cost_micros bigint,
  p_pricing_version text,
  p_model_ms integer,
  p_validation_ms integer,
  p_total_ms integer,
  p_failure_class text,
  p_failure_code text,
  p_failure_detail text,
  p_validated_output jsonb,
  p_validation_report jsonb,
  p_trace_id text
)
returns jsonb
language plpgsql
set search_path = ''
as $finish$
declare
  v_attempt public.kapiloto_research_attempts%rowtype;
  v_run public.kapiloto_research_runs%rowtype;
  v_next_attempt_id uuid;
  v_retry_created boolean := false;
begin
  if p_retry_delay_seconds < 0 or p_retry_delay_seconds > 86400 then
    raise exception 'retry delay is outside allowed range';
  end if;

  select a.*
    into v_attempt
  from public.kapiloto_research_attempts a
  where a.id = p_attempt_id
  for update;

  if not found then
    raise exception 'research attempt not found';
  end if;

  if v_attempt.status <> 'running'
     or v_attempt.worker_id is distinct from p_worker_id then
    raise exception 'research attempt is no longer owned by this worker';
  end if;

  -- A lease that already expired must be recovered by the lease-recovery path.
  -- This prevents a zombie worker from publishing a late result.
  if v_attempt.lease_expires_at is null or v_attempt.lease_expires_at < now() then
    raise exception 'research attempt lease expired';
  end if;

  select r.*
    into v_run
  from public.kapiloto_research_runs r
  where r.id = v_attempt.run_id
  for update;

  if v_run.status not in ('queued', 'running') then
    raise exception 'research run is no longer executable';
  end if;

  if p_success then
    if p_validated_output is null then
      raise exception 'successful attempt requires validated_output';
    end if;

    update public.kapiloto_research_attempts
    set status = 'succeeded',
        finished_at = now(),
        model_snapshot = p_model_snapshot,
        provider_response_id = p_provider_response_id,
        input_tokens = p_input_tokens,
        cached_input_tokens = p_cached_input_tokens,
        output_tokens = p_output_tokens,
        reasoning_tokens = p_reasoning_tokens,
        web_search_calls = p_web_search_calls,
        sources_count = p_sources_count,
        cost_micros = p_cost_micros,
        pricing_version = p_pricing_version,
        model_ms = p_model_ms,
        validation_ms = p_validation_ms,
        total_ms = p_total_ms,
        failure_class = null,
        failure_code = null,
        failure_detail = null,
        validated_output = p_validated_output,
        validation_report = p_validation_report,
        trace_id = p_trace_id,
        heartbeat_at = now(),
        lease_expires_at = null
    where id = v_attempt.id;
  else
    update public.kapiloto_research_attempts
    set status = 'failed',
        finished_at = now(),
        model_snapshot = p_model_snapshot,
        provider_response_id = p_provider_response_id,
        input_tokens = p_input_tokens,
        cached_input_tokens = p_cached_input_tokens,
        output_tokens = p_output_tokens,
        reasoning_tokens = p_reasoning_tokens,
        web_search_calls = p_web_search_calls,
        sources_count = p_sources_count,
        cost_micros = p_cost_micros,
        pricing_version = p_pricing_version,
        model_ms = p_model_ms,
        validation_ms = p_validation_ms,
        total_ms = p_total_ms,
        failure_class = p_failure_class,
        failure_code = p_failure_code,
        failure_detail = p_failure_detail,
        validated_output = null,
        validation_report = p_validation_report,
        trace_id = p_trace_id,
        heartbeat_at = now(),
        lease_expires_at = null
    where id = v_attempt.id;

    if p_retryable and v_attempt.attempt_no < v_run.max_attempts_per_task then
      insert into public.kapiloto_research_attempts (
        run_id,
        round_id,
        task_key,
        round_game_id,
        attempt_no,
        status,
        available_at
      )
      values (
        v_attempt.run_id,
        v_attempt.round_id,
        v_attempt.task_key,
        v_attempt.round_game_id,
        v_attempt.attempt_no + 1,
        'queued',
        now() + make_interval(secs => p_retry_delay_seconds)
      )
      returning id into v_next_attempt_id;

      v_retry_created := true;

      update public.kapiloto_round_research_state
      set attempts_total = attempts_total + 1,
          version = version + 1,
          updated_at = now()
      where round_id = v_attempt.round_id;
    end if;
  end if;

  update public.kapiloto_research_runs
  set attempt_count = attempt_count + 1,
      input_tokens_total = input_tokens_total + coalesce(p_input_tokens, 0),
      cached_input_tokens_total = cached_input_tokens_total + coalesce(p_cached_input_tokens, 0),
      output_tokens_total = output_tokens_total + coalesce(p_output_tokens, 0),
      reasoning_tokens_total = reasoning_tokens_total + coalesce(p_reasoning_tokens, 0),
      web_search_calls_total = web_search_calls_total + coalesce(p_web_search_calls, 0),
      cost_micros_total = cost_micros_total + coalesce(p_cost_micros, 0)
  where id = v_attempt.run_id;

  update public.kapiloto_round_research_state
  set cost_micros_total = cost_micros_total + coalesce(p_cost_micros, 0),
      version = version + 1,
      updated_at = now()
  where round_id = v_attempt.round_id;

  return jsonb_build_object(
    'attempt_id', v_attempt.id,
    'status', case when p_success then 'succeeded' else 'failed' end,
    'retry_created', v_retry_created,
    'next_attempt_id', v_next_attempt_id
  );
end;
$finish$;

create or replace function public.kapiloto_recover_expired_attempts(
  p_limit integer default 50,
  p_retry_delay_seconds integer default 5
)
returns jsonb
language plpgsql
set search_path = ''
as $recover$
declare
  v_attempt public.kapiloto_research_attempts%rowtype;
  v_run public.kapiloto_research_runs%rowtype;
  v_recovered integer := 0;
  v_retried integer := 0;
begin
  if p_limit < 1 or p_limit > 500 then
    raise exception 'limit must be between 1 and 500';
  end if;

  if p_retry_delay_seconds < 0 or p_retry_delay_seconds > 86400 then
    raise exception 'retry delay is outside allowed range';
  end if;

  for v_attempt in
    select a.*
    from public.kapiloto_research_attempts a
    join public.kapiloto_research_runs r on r.id = a.run_id
    where a.status = 'running'
      and a.lease_expires_at < now()
      and r.status in ('queued', 'running')
    order by a.lease_expires_at
    for update of a skip locked
    limit p_limit
  loop
    select r.*
      into v_run
    from public.kapiloto_research_runs r
    where r.id = v_attempt.run_id
    for update;

    update public.kapiloto_research_attempts
    set status = 'abandoned',
        finished_at = now(),
        failure_class = 'worker_lost',
        failure_code = 'lease_expired',
        failure_detail = 'Worker lease expired before terminal result.',
        lease_expires_at = null
    where id = v_attempt.id;

    v_recovered := v_recovered + 1;

    if v_attempt.attempt_no < v_run.max_attempts_per_task then
      insert into public.kapiloto_research_attempts (
        run_id,
        round_id,
        task_key,
        round_game_id,
        attempt_no,
        status,
        available_at
      )
      values (
        v_attempt.run_id,
        v_attempt.round_id,
        v_attempt.task_key,
        v_attempt.round_game_id,
        v_attempt.attempt_no + 1,
        'queued',
        now() + make_interval(secs => p_retry_delay_seconds)
      )
      on conflict (run_id, task_key, attempt_no) do nothing;

      if found then
        v_retried := v_retried + 1;

        update public.kapiloto_round_research_state
        set attempts_total = attempts_total + 1,
            version = version + 1,
            updated_at = now()
        where round_id = v_attempt.round_id;
      end if;
    end if;

    update public.kapiloto_research_runs
    set attempt_count = attempt_count + 1
    where id = v_attempt.run_id;
  end loop;

  return jsonb_build_object(
    'recovered', v_recovered,
    'retries_created', v_retried
  );
end;
$recover$;

revoke all on function public.kapiloto_claim_research_attempt(text, integer)
  from public, anon, authenticated;
revoke all on function public.kapiloto_heartbeat_research_attempt(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.kapiloto_finish_research_attempt(
  uuid, text, boolean, boolean, integer, text, text,
  integer, integer, integer, integer, integer, integer, bigint, text,
  integer, integer, integer, text, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
revoke all on function public.kapiloto_recover_expired_attempts(integer, integer)
  from public, anon, authenticated;

grant execute on function public.kapiloto_claim_research_attempt(text, integer)
  to service_role;
grant execute on function public.kapiloto_heartbeat_research_attempt(uuid, text, integer)
  to service_role;
grant execute on function public.kapiloto_finish_research_attempt(
  uuid, text, boolean, boolean, integer, text, text,
  integer, integer, integer, integer, integer, integer, bigint, text,
  integer, integer, integer, text, text, text, jsonb, jsonb, text
) to service_role;
grant execute on function public.kapiloto_recover_expired_attempts(integer, integer)
  to service_role;
