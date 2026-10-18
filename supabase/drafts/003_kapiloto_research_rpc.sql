-- Kapiloto research request/create RPC DRAFT.
-- Not applied to any Supabase project yet.
--
-- This function is intentionally in public so PostgREST can invoke it,
-- but EXECUTE is granted only to service_role. Clients must use the
-- authenticated Next.js server path, which validates the caller first.
--
-- The function mirrors lib/kapiloto/research-policy.ts and is the final
-- concurrency authority for idempotency, single-flight and max-3.

create or replace function public.kapiloto_request_research(
  p_user_id uuid,
  p_round_id uuid,
  p_round_game_id uuid,
  p_intent text,
  p_idempotency_key text,
  p_request_sha256 text,
  p_based_on_run_id uuid,
  p_refresh_eligible boolean,
  p_breaker_open boolean,
  p_model_key text,
  p_research_protocol_version text,
  p_derivation_version text,
  p_source_policy_version text,
  p_recency_policy_version text,
  p_reliability_formula_version text,
  p_blend_policy_version text,
  p_calibration_version text,
  p_prompt_template_sha256 text,
  p_execution_topology text,
  p_research_cutoff_at timestamptz,
  p_fixture_set jsonb,
  p_fixture_set_sha256 text,
  p_input_snapshot jsonb,
  p_task_game_ids uuid[],
  p_max_attempts_per_task smallint default 3
)
returns jsonb
language plpgsql
set search_path = ''
as $kapiloto$
declare
  v_state public.kapiloto_round_research_state%rowtype;
  v_existing_request public.kapiloto_research_requests%rowtype;
  v_request_id uuid;
  v_run_id uuid;
  v_seq_no integer;
  v_budget_slot smallint;
  v_outcome text;
  v_target_run_id uuid;
  v_trigger_type text;
  v_task_count integer;
begin
  if p_user_id is null or p_round_id is null then
    raise exception 'user_id and round_id are required';
  end if;

  if p_intent not in ('consult', 'recheck', 'diego') then
    raise exception 'invalid Kapiloto intent: %', p_intent;
  end if;

  if nullif(trim(p_idempotency_key), '') is null then
    raise exception 'idempotency_key is required';
  end if;

  if nullif(trim(p_request_sha256), '') is null then
    raise exception 'request_sha256 is required';
  end if;

  if p_max_attempts_per_task < 1 or p_max_attempts_per_task > 10 then
    raise exception 'max_attempts_per_task must be between 1 and 10';
  end if;

  if p_execution_topology not in ('fixture_fanout', 'round_batch') then
    raise exception 'invalid execution topology: %', p_execution_topology;
  end if;

  -- Serialize retries/replays of the same mobile idempotency key even if a
  -- caller accidentally attempts to reuse it across different rounds.
  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_idempotency_key, 0)
  );

  select r.*
    into v_existing_request
  from public.kapiloto_research_requests r
  where r.user_id = p_user_id
    and r.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_request.request_sha256 <> p_request_sha256 then
      raise exception 'idempotency key reused with a different request body'
        using errcode = '22023';
    end if;

    select s.*
      into v_state
    from public.kapiloto_round_research_state s
    where s.round_id = v_existing_request.round_id;

    return jsonb_build_object(
      'replayed', true,
      'request_id', v_existing_request.id,
      'outcome', v_existing_request.outcome,
      'run_id', v_existing_request.run_id,
      'round_id', v_existing_request.round_id,
      'active_run_id', v_state.active_run_id,
      'current_run_id', v_state.current_run_id,
      'runs_consumed', v_state.runs_consumed
    );
  end if;

  if not exists (
    select 1
    from public.rounds r
    where r.id = p_round_id
  ) then
    raise exception 'round not found';
  end if;

  if p_round_game_id is not null and not exists (
    select 1
    from public.round_games g
    where g.id = p_round_game_id
      and g.round_id = p_round_id
  ) then
    raise exception 'round_game_id does not belong to round';
  end if;

  insert into public.kapiloto_round_research_state (round_id)
  values (p_round_id)
  on conflict (round_id) do nothing;

  -- This row lock is the single-flight serialization boundary.
  select s.*
    into v_state
  from public.kapiloto_round_research_state s
  where s.round_id = p_round_id
  for update;

  -- based_on_run_id is an optimistic freshness token. A request based on an
  -- older snapshot never consumes another budget slot.
  if p_based_on_run_id is not null
     and v_state.current_run_id is not null
     and p_based_on_run_id <> v_state.current_run_id then
    v_outcome := 'served_newer';
    v_target_run_id := v_state.current_run_id;

  elsif v_state.research_closed_at is not null then
    v_outcome := 'round_closed';
    v_target_run_id := v_state.current_run_id;

  elsif v_state.active_run_id is not null then
    v_outcome := 'joined_run';
    v_target_run_id := v_state.active_run_id;

  elsif p_breaker_open then
    v_outcome := 'breaker_open';
    v_target_run_id := v_state.current_run_id;

  elsif v_state.current_run_id is not null
        and p_intent in ('consult', 'diego') then
    v_outcome := 'served_cache';
    v_target_run_id := v_state.current_run_id;

  elsif v_state.current_run_id is not null
        and p_intent = 'recheck'
        and not p_refresh_eligible then
    v_outcome := 'refresh_ineligible';
    v_target_run_id := v_state.current_run_id;

  elsif v_state.runs_consumed >= 3 then
    v_outcome := 'limit_reached';
    v_target_run_id := v_state.current_run_id;
  end if;

  if v_outcome is not null then
    insert into public.kapiloto_research_requests (
      user_id,
      round_id,
      round_game_id,
      intent,
      idempotency_key,
      request_sha256,
      based_on_run_id,
      outcome,
      run_id
    )
    values (
      p_user_id,
      p_round_id,
      p_round_game_id,
      p_intent,
      p_idempotency_key,
      p_request_sha256,
      p_based_on_run_id,
      v_outcome,
      v_target_run_id
    )
    returning id into v_request_id;

    return jsonb_build_object(
      'replayed', false,
      'request_id', v_request_id,
      'outcome', v_outcome,
      'run_id', v_target_run_id,
      'round_id', p_round_id,
      'active_run_id', v_state.active_run_id,
      'current_run_id', v_state.current_run_id,
      'runs_consumed', v_state.runs_consumed
    );
  end if;

  -- Phase 1 may intentionally omit the expensive prepared fixture snapshot.
  -- Return without recording a request; the server prepares inputs and retries
  -- with the SAME idempotency key. The second call re-locks/re-evaluates state.
  if p_fixture_set is null then
    return jsonb_build_object(
      'replayed', false,
      'outcome', 'prepare_required',
      'round_id', p_round_id,
      'active_run_id', v_state.active_run_id,
      'current_run_id', v_state.current_run_id,
      'runs_consumed', v_state.runs_consumed,
      'next_budget_slot', v_state.runs_consumed + 1
    );
  end if;

  if jsonb_typeof(p_fixture_set) <> 'array'
     or jsonb_array_length(p_fixture_set) <> 16 then
    raise exception 'fixture_set must contain exactly 16 rows';
  end if;

  if p_research_cutoff_at is null then
    raise exception 'research_cutoff_at is required when creating a run';
  end if;

  if nullif(trim(p_fixture_set_sha256), '') is null then
    raise exception 'fixture_set_sha256 is required when creating a run';
  end if;

  if p_execution_topology = 'fixture_fanout' then
    if coalesce(array_length(p_task_game_ids, 1), 0) < 1 then
      raise exception 'fixture_fanout requires at least one research task';
    end if;

    select count(*)
      into v_task_count
    from (
      select distinct x.round_game_id
      from unnest(p_task_game_ids) as x(round_game_id)
      join public.round_games g
        on g.id = x.round_game_id
       and g.round_id = p_round_id
    ) valid_tasks;

    if v_task_count <> coalesce(array_length(p_task_game_ids, 1), 0) then
      raise exception 'task_game_ids must be unique fixtures from the requested round';
    end if;
  end if;

  insert into public.kapiloto_research_requests (
    user_id,
    round_id,
    round_game_id,
    intent,
    idempotency_key,
    request_sha256,
    based_on_run_id
  )
  values (
    p_user_id,
    p_round_id,
    p_round_game_id,
    p_intent,
    p_idempotency_key,
    p_request_sha256,
    p_based_on_run_id
  )
  returning id into v_request_id;

  select coalesce(max(r.seq_no), 0) + 1
    into v_seq_no
  from public.kapiloto_research_runs r
  where r.round_id = p_round_id;

  v_budget_slot := v_state.runs_consumed + 1;

  v_trigger_type := case p_intent
    when 'consult' then 'fixture_consult'
    when 'recheck' then 'fixture_recheck'
    else 'diego'
  end;

  insert into public.kapiloto_research_runs (
    round_id,
    seq_no,
    budget_slot,
    status,
    trigger_type,
    origin_request_id,
    based_on_run_id,
    model_key,
    research_protocol_version,
    derivation_version,
    source_policy_version,
    recency_policy_version,
    reliability_formula_version,
    blend_policy_version,
    calibration_version,
    prompt_template_sha256,
    execution_topology,
    research_cutoff_at,
    fixture_set,
    fixture_set_sha256,
    input_snapshot,
    input_snapshot_at,
    max_attempts_per_task
  )
  values (
    p_round_id,
    v_seq_no,
    v_budget_slot,
    'queued',
    v_trigger_type,
    v_request_id,
    p_based_on_run_id,
    p_model_key,
    p_research_protocol_version,
    p_derivation_version,
    p_source_policy_version,
    p_recency_policy_version,
    p_reliability_formula_version,
    p_blend_policy_version,
    p_calibration_version,
    p_prompt_template_sha256,
    p_execution_topology,
    p_research_cutoff_at,
    p_fixture_set,
    p_fixture_set_sha256,
    p_input_snapshot,
    now(),
    p_max_attempts_per_task
  )
  returning id into v_run_id;

  if p_execution_topology = 'fixture_fanout' then
    insert into public.kapiloto_research_attempts (
      run_id,
      round_id,
      task_key,
      round_game_id,
      attempt_no,
      status
    )
    select
      v_run_id,
      p_round_id,
      'fixture:' || x.round_game_id::text,
      x.round_game_id,
      1,
      'queued'
    from unnest(p_task_game_ids) as x(round_game_id);

    v_task_count := coalesce(array_length(p_task_game_ids, 1), 0);
  else
    insert into public.kapiloto_research_attempts (
      run_id,
      round_id,
      task_key,
      round_game_id,
      attempt_no,
      status
    )
    values (
      v_run_id,
      p_round_id,
      'round:' || p_round_id::text,
      null,
      1,
      'queued'
    );

    v_task_count := 1;
  end if;

  update public.kapiloto_research_requests
  set outcome = 'created_run',
      run_id = v_run_id
  where id = v_request_id;

  update public.kapiloto_round_research_state
  set runs_consumed = v_budget_slot,
      active_run_id = v_run_id,
      attempts_total = attempts_total + v_task_count,
      version = version + 1,
      updated_at = now()
  where round_id = p_round_id;

  return jsonb_build_object(
    'replayed', false,
    'request_id', v_request_id,
    'outcome', 'created_run',
    'run_id', v_run_id,
    'round_id', p_round_id,
    'active_run_id', v_run_id,
    'current_run_id', v_state.current_run_id,
    'runs_consumed', v_budget_slot,
    'budget_slot', v_budget_slot,
    'task_count', v_task_count
  );
end;
$kapiloto$;

revoke all on function public.kapiloto_request_research(
  uuid, uuid, uuid, text, text, text, uuid, boolean, boolean,
  text, text, text, text, text, text, text, text, text,
  timestamptz, jsonb, text, jsonb, uuid[], smallint
) from public, anon, authenticated;

grant execute on function public.kapiloto_request_research(
  uuid, uuid, uuid, text, text, text, uuid, boolean, boolean,
  text, text, text, text, text, text, text, text, text,
  timestamptz, jsonb, text, jsonb, uuid[], smallint
) to service_role;
