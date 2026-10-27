-- Atomically complete one fully materialized Kapiloto round run and publish
-- each canonical fixture analysis. Analysis/evidence materialization happens
-- before this RPC; this function owns only the final consistency boundary.

create or replace function public.kapiloto_complete_research_run(
  p_run_id uuid,
  p_round_synthesis jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.kapiloto_research_runs%rowtype;
  v_state public.kapiloto_round_research_state%rowtype;
  v_analysis public.kapiloto_analyses%rowtype;
  v_analysis_count integer;
  v_active_attempt_count integer;
  v_published integer := 0;
begin
  select r.*
    into v_run
  from public.kapiloto_research_runs r
  where r.id = p_run_id
  for update;

  if not found then
    raise exception 'Kapiloto research run not found';
  end if;

  if v_run.status = 'completed' then
    select count(*)
      into v_published
    from public.kapiloto_fixture_publications p
    where p.research_run_id = p_run_id;

    return jsonb_build_object(
      'run_id', p_run_id,
      'round_id', v_run.round_id,
      'status', 'completed',
      'analysis_count', 16,
      'published_fixture_count', v_published,
      'replayed', true
    );
  end if;

  if v_run.status not in ('queued', 'running') then
    raise exception 'Kapiloto run is not completable from status %', v_run.status;
  end if;

  select s.*
    into v_state
  from public.kapiloto_round_research_state s
  where s.round_id = v_run.round_id
  for update;

  if not found then
    raise exception 'Kapiloto round research state not found';
  end if;

  if v_state.active_run_id is distinct from p_run_id then
    raise exception 'Kapiloto run no longer owns active round state';
  end if;

  select count(*)
    into v_active_attempt_count
  from public.kapiloto_research_attempts a
  where a.run_id = p_run_id
    and a.status in ('queued', 'running');

  if v_active_attempt_count <> 0 then
    raise exception 'Kapiloto run still has % active attempts', v_active_attempt_count;
  end if;

  select count(*)
    into v_analysis_count
  from public.kapiloto_analyses a
  where a.research_run_id = p_run_id
    and a.round_id = v_run.round_id;

  if v_analysis_count <> 16 then
    raise exception 'Kapiloto run requires exactly 16 materialized analyses; got %',
      v_analysis_count;
  end if;

  if exists (
    select 1
    from public.kapiloto_analyses a
    left join public.round_games g
      on g.id = a.round_game_id
     and g.round_id = a.round_id
     and g.fixture_id = a.fixture_id
    where a.research_run_id = p_run_id
      and g.id is null
  ) then
    raise exception 'Kapiloto run contains an analysis with inconsistent fixture context';
  end if;

  if (
    select count(distinct a.round_game_id)
    from public.kapiloto_analyses a
    where a.research_run_id = p_run_id
  ) <> 16 then
    raise exception 'Kapiloto run does not cover 16 distinct Toto fixtures';
  end if;

  update public.kapiloto_research_runs
  set status = 'completed',
      completed_at = now(),
      round_synthesis = coalesce(p_round_synthesis, '{}'::jsonb),
      failure_class = null,
      failure_detail = null
  where id = p_run_id;

  for v_analysis in
    select a.*
    from public.kapiloto_analyses a
    where a.research_run_id = p_run_id
    order by a.round_game_id
  loop
    perform public.kapiloto_publish_fixture_analysis(v_analysis.id);
    v_published := v_published + 1;
  end loop;

  update public.kapiloto_round_research_state
  set active_run_id = null,
      current_run_id = p_run_id,
      version = version + 1,
      updated_at = now()
  where round_id = v_run.round_id
    and active_run_id = p_run_id;

  if not found then
    raise exception 'Kapiloto active-run ownership changed during completion';
  end if;

  return jsonb_build_object(
    'run_id', p_run_id,
    'round_id', v_run.round_id,
    'status', 'completed',
    'analysis_count', v_analysis_count,
    'published_fixture_count', v_published,
    'replayed', false
  );
end;
$$;

revoke all on function public.kapiloto_complete_research_run(uuid, jsonb)
from public, anon, authenticated;

grant execute on function public.kapiloto_complete_research_run(uuid, jsonb)
to service_role;
