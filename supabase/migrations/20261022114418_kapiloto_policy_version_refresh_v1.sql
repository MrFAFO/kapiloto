-- A recheck must be eligible when the active research policy changed.
-- This keeps refresh semantics honest: a materially different source/grounding
-- policy invalidates the previous research snapshot without fabricating a
-- freshness signal.

do $do$
declare
  v_def text;
  v_old text := $old$
  if p_intent = 'recheck' and v_state.current_run_id is not null then
    select coalesce(r.completed_at, r.research_cutoff_at)
      into v_current_completed_at
    from public.kapiloto_research_runs r
    where r.id = v_state.current_run_id;

    select
      exists (
        select 1
        from public.kapiloto_analyses a
        where a.research_run_id = v_state.current_run_id
          and a.valid_until is not null
          and a.valid_until <= now()
      )
      or exists (
        select 1
        from public.kapiloto_freshness_signals fs
        join public.round_games g on g.id = fs.round_game_id
        where g.round_id = p_round_id
          and fs.severity >= 2
          and (
            v_current_completed_at is null
            or fs.observed_at > v_current_completed_at
          )
      )
      into v_refresh_eligible;
  end if;
$old$;
  v_new text := $new$
  if p_intent = 'recheck' and v_state.current_run_id is not null then
    select coalesce(r.completed_at, r.research_cutoff_at)
      into v_current_completed_at
    from public.kapiloto_research_runs r
    where r.id = v_state.current_run_id;

    select
      exists (
        select 1
        from public.kapiloto_research_runs r
        where r.id = v_state.current_run_id
          and r.source_policy_version is distinct from p_source_policy_version
      )
      or exists (
        select 1
        from public.kapiloto_analyses a
        where a.research_run_id = v_state.current_run_id
          and a.valid_until is not null
          and a.valid_until <= now()
      )
      or exists (
        select 1
        from public.kapiloto_freshness_signals fs
        join public.round_games g on g.id = fs.round_game_id
        where g.round_id = p_round_id
          and fs.severity >= 2
          and (
            v_current_completed_at is null
            or fs.observed_at > v_current_completed_at
          )
      )
      into v_refresh_eligible;
  end if;
$new$;
begin
  select pg_get_functiondef(p.oid)
    into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'kapiloto_request_research';

  if position(v_new in v_def) > 0 then
    return;
  end if;

  if position(v_old in v_def) = 0 then
    raise exception 'kapiloto_request_research refresh eligibility block not found';
  end if;

  execute replace(v_def, v_old, v_new);
end
$do$;
