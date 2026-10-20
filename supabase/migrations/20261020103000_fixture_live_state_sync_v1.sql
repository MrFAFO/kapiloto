-- Keep canonical fixtures synchronized with live field state applied through toto_apply_game_state_v1.
-- Atomic field-state and pool-settlement application for one Winner 16 game.
-- Field scores are deliberately separate from official pool settlement so that
-- technical results, postponements and Toto rulings cannot silently rewrite picks.

create or replace function public.toto_apply_game_state_v1(
  p_update jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round_game_id uuid;
  v_round_id uuid;
  v_fixture_id uuid;
  v_provider text;
  v_provider_fixture_id text;
  v_status text;
  v_home_score smallint;
  v_away_score smallint;
  v_field_outcome text;
  v_observed_at timestamptz;
  v_pool_status text;
  v_pool_outcome text;
  v_settlement_source text;
  v_current_settlement_status text;
  v_current_pool_outcome text;
  v_round_status text;
  v_ticket_rows integer := 0;
  v_consensus_rows integer := 0;
begin
  if p_update is null or jsonb_typeof(p_update) <> 'object' then
    raise exception 'game_state_invalid';
  end if;

  begin
    v_round_game_id := (p_update ->> 'round_game_id')::uuid;
  exception when others then
    raise exception 'game_state_round_game_required';
  end;

  v_provider := nullif(trim(p_update ->> 'provider'), '');
  v_provider_fixture_id := nullif(trim(p_update ->> 'provider_fixture_id'), '');
  v_status := nullif(trim(p_update ->> 'status'), '');
  v_pool_status := nullif(trim(p_update ->> 'pool_settlement_status'), '');
  v_pool_outcome := nullif(trim(p_update ->> 'pool_outcome'), '');
  v_settlement_source := nullif(trim(p_update ->> 'settlement_source'), '');

  begin
    v_observed_at := coalesce(
      nullif(p_update ->> 'observed_at', '')::timestamptz,
      now()
    );
  exception when others then
    raise exception 'game_state_invalid_observed_at';
  end;

  if v_status not in (
    'upcoming', 'live', 'halftime', 'finished',
    'postponed', 'cancelled', 'suspended', 'under_review'
  ) then
    raise exception 'game_state_invalid_status';
  end if;

  if p_update ? 'home_score' and p_update ->> 'home_score' is not null then
    begin
      v_home_score := (p_update ->> 'home_score')::smallint;
    exception when others then
      raise exception 'game_state_invalid_score';
    end;
  end if;

  if p_update ? 'away_score' and p_update ->> 'away_score' is not null then
    begin
      v_away_score := (p_update ->> 'away_score')::smallint;
    exception when others then
      raise exception 'game_state_invalid_score';
    end;
  end if;

  if v_home_score is not null and v_home_score < 0
     or v_away_score is not null and v_away_score < 0 then
    raise exception 'game_state_invalid_score';
  end if;

  if (v_home_score is null) <> (v_away_score is null) then
    raise exception 'game_state_score_pair_required';
  end if;

  if v_status in ('live', 'halftime', 'finished')
     and v_home_score is null then
    raise exception 'game_state_score_required';
  end if;

  if v_home_score is not null then
    v_field_outcome := case
      when v_home_score > v_away_score then '1'
      when v_home_score < v_away_score then '2'
      else 'X'
    end;
  end if;

  if v_pool_status is not null
     and v_pool_status not in ('settled', 'void', 'under_review') then
    raise exception 'game_state_invalid_pool_status';
  end if;

  if v_pool_status = 'settled'
     and v_pool_outcome not in ('1', 'X', '2') then
    raise exception 'game_state_pool_outcome_required';
  end if;

  if v_pool_status in ('settled', 'void', 'under_review')
     and v_settlement_source is null then
    raise exception 'game_state_settlement_source_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_round_game_id::text, 0));

  select g.round_id, g.fixture_id, g.settlement_status, g.pool_settlement_outcome
    into v_round_id, v_fixture_id, v_current_settlement_status, v_current_pool_outcome
  from public.round_games g
  where g.id = v_round_game_id
  for update;

  if v_round_id is null then
    raise exception 'game_state_round_game_not_found';
  end if;

  perform 1
  from public.rounds r
  where r.id = v_round_id
  for update;

  if v_provider is not null or v_provider_fixture_id is not null then
    if v_provider is null or v_provider_fixture_id is null then
      raise exception 'game_state_provider_identity_incomplete';
    end if;

    if exists (
      select 1
      from public.provider_fixture_mappings m
      where m.provider = v_provider
        and m.provider_fixture_id = v_provider_fixture_id
        and m.fixture_id <> v_fixture_id
    ) then
      raise exception 'game_state_provider_fixture_conflict';
    end if;

    if exists (
      select 1
      from public.provider_fixture_mappings m
      where m.fixture_id = v_fixture_id
        and m.provider = v_provider
        and m.provider_fixture_id <> v_provider_fixture_id
    ) then
      raise exception 'game_state_fixture_provider_conflict';
    end if;

    insert into public.provider_fixture_mappings (
      fixture_id,
      round_game_id,
      provider,
      provider_fixture_id,
      mapping_status,
      mapping_confidence,
      mapped_at
    )
    values (
      v_fixture_id,
      v_round_game_id,
      v_provider,
      v_provider_fixture_id,
      'confirmed',
      1,
      v_observed_at
    )
    on conflict (provider, provider_fixture_id)
    do update set
      round_game_id = excluded.round_game_id,
      mapping_status = 'confirmed',
      mapping_confidence = greatest(
        coalesce(public.provider_fixture_mappings.mapping_confidence, 0),
        excluded.mapping_confidence
      ),
      mapped_at = excluded.mapped_at;
  end if;

  if v_current_settlement_status in ('settled', 'void')
     and v_pool_status is not null then
    if v_pool_status <> v_current_settlement_status
       or coalesce(v_pool_outcome, '') <> coalesce(v_current_pool_outcome, '') then
      raise exception 'game_state_settlement_immutable';
    end if;
  end if;

  if v_pool_status is null
     and v_status in ('postponed', 'cancelled', 'suspended', 'under_review')
     and v_current_settlement_status not in ('settled', 'void') then
    v_pool_status := 'under_review';
    v_settlement_source := coalesce(
      v_settlement_source,
      coalesce(v_provider, 'field_status') || ':automatic_review'
    );
  end if;

  update public.round_games
  set status = v_status,
      field_home_score = case
        when v_home_score is not null then v_home_score
        else field_home_score
      end,
      field_away_score = case
        when v_away_score is not null then v_away_score
        else field_away_score
      end,
      field_outcome = case
        when v_field_outcome is not null then v_field_outcome
        else field_outcome
      end,
      settlement_status = coalesce(v_pool_status, settlement_status),
      pool_settlement_outcome = case
        when v_pool_status = 'settled' then v_pool_outcome
        when v_pool_status = 'void' then null
        else pool_settlement_outcome
      end,
      settlement_source = case
        when v_pool_status is not null then v_settlement_source
        else settlement_source
      end,
      settlement_confirmed_at = case
        when v_pool_status in ('settled', 'void') then
          coalesce(settlement_confirmed_at, v_observed_at)
        else settlement_confirmed_at
      end,
      actual_kickoff_at = case
        when v_status in ('live', 'halftime', 'finished') then
          coalesce(actual_kickoff_at, least(v_observed_at, kickoff_at))
        else actual_kickoff_at
      end,
      last_synced_at = v_observed_at
  where id = v_round_game_id;

  update public.fixtures
  set status = v_status,
      home_score = case
        when v_home_score is not null then v_home_score
        else home_score
      end,
      away_score = case
        when v_away_score is not null then v_away_score
        else away_score
      end,
      actual_kickoff_at = case
        when v_status in ('live', 'halftime', 'finished') then
          coalesce(actual_kickoff_at, least(v_observed_at, kickoff_at))
        else actual_kickoff_at
      end,
      last_synced_at = v_observed_at,
      updated_at = now()
  where id = v_fixture_id;

  insert into public.ticket_pick_results (
    ticket_version_id,
    round_game_id,
    evaluation_state,
    is_hit,
    evaluated_outcome,
    evaluated_at
  )
  select
    p.ticket_version_id,
    p.round_game_id,
    case
      when g.settlement_status = 'settled' then
        case when
          p.pick = g.pool_settlement_outcome
          or (p.pick = '1X' and g.pool_settlement_outcome in ('1','X'))
          or (p.pick = 'X2' and g.pool_settlement_outcome in ('X','2'))
          or (p.pick = '12' and g.pool_settlement_outcome in ('1','2'))
        then 'hit' else 'miss' end
      when g.settlement_status = 'void' then 'void'
      when g.settlement_status = 'under_review' then 'under_review'
      when g.status in ('live', 'halftime', 'finished') and g.field_outcome is not null then
        case when
          p.pick = g.field_outcome
          or (p.pick = '1X' and g.field_outcome in ('1','X'))
          or (p.pick = 'X2' and g.field_outcome in ('X','2'))
          or (p.pick = '12' and g.field_outcome in ('1','2'))
        then 'currently_hit' else 'currently_miss' end
      else 'pending'
    end,
    case
      when g.settlement_status = 'settled' then
        p.pick = g.pool_settlement_outcome
        or (p.pick = '1X' and g.pool_settlement_outcome in ('1','X'))
        or (p.pick = 'X2' and g.pool_settlement_outcome in ('X','2'))
        or (p.pick = '12' and g.pool_settlement_outcome in ('1','2'))
      when g.settlement_status in ('void', 'under_review') then null
      when g.status in ('live', 'halftime', 'finished') and g.field_outcome is not null then
        p.pick = g.field_outcome
        or (p.pick = '1X' and g.field_outcome in ('1','X'))
        or (p.pick = 'X2' and g.field_outcome in ('X','2'))
        or (p.pick = '12' and g.field_outcome in ('1','2'))
      else null
    end,
    case
      when g.settlement_status = 'settled' then g.pool_settlement_outcome
      when g.settlement_status in ('void', 'under_review') then null
      when g.status in ('live', 'halftime', 'finished') then g.field_outcome
      else null
    end,
    v_observed_at
  from public.ticket_version_picks p
  join public.round_games g on g.id = p.round_game_id
  where p.round_game_id = v_round_game_id
  on conflict (ticket_version_id, round_game_id)
  do update set
    evaluation_state = excluded.evaluation_state,
    is_hit = excluded.is_hit,
    evaluated_outcome = excluded.evaluated_outcome,
    evaluated_at = excluded.evaluated_at;

  get diagnostics v_ticket_rows = row_count;

  insert into public.consensus_pick_results (
    consensus_version_id,
    round_game_id,
    evaluation_state,
    is_hit,
    evaluated_outcome,
    evaluated_at
  )
  select
    p.consensus_version_id,
    p.round_game_id,
    case
      when g.settlement_status = 'settled' then
        case when
          p.pick = g.pool_settlement_outcome
          or (p.pick = '1X' and g.pool_settlement_outcome in ('1','X'))
          or (p.pick = 'X2' and g.pool_settlement_outcome in ('X','2'))
          or (p.pick = '12' and g.pool_settlement_outcome in ('1','2'))
        then 'hit' else 'miss' end
      when g.settlement_status = 'void' then 'void'
      when g.settlement_status = 'under_review' then 'under_review'
      when g.status in ('live', 'halftime', 'finished') and g.field_outcome is not null then
        case when
          p.pick = g.field_outcome
          or (p.pick = '1X' and g.field_outcome in ('1','X'))
          or (p.pick = 'X2' and g.field_outcome in ('X','2'))
          or (p.pick = '12' and g.field_outcome in ('1','2'))
        then 'currently_hit' else 'currently_miss' end
      else 'pending'
    end,
    case
      when g.settlement_status = 'settled' then
        p.pick = g.pool_settlement_outcome
        or (p.pick = '1X' and g.pool_settlement_outcome in ('1','X'))
        or (p.pick = 'X2' and g.pool_settlement_outcome in ('X','2'))
        or (p.pick = '12' and g.pool_settlement_outcome in ('1','2'))
      when g.settlement_status in ('void', 'under_review') then null
      when g.status in ('live', 'halftime', 'finished') and g.field_outcome is not null then
        p.pick = g.field_outcome
        or (p.pick = '1X' and g.field_outcome in ('1','X'))
        or (p.pick = 'X2' and g.field_outcome in ('X','2'))
        or (p.pick = '12' and g.field_outcome in ('1','2'))
      else null
    end,
    case
      when g.settlement_status = 'settled' then g.pool_settlement_outcome
      when g.settlement_status in ('void', 'under_review') then null
      when g.status in ('live', 'halftime', 'finished') then g.field_outcome
      else null
    end,
    v_observed_at
  from public.consensus_picks p
  join public.round_games g on g.id = p.round_game_id
  where p.round_game_id = v_round_game_id
  on conflict (consensus_version_id, round_game_id)
  do update set
    evaluation_state = excluded.evaluation_state,
    is_hit = excluded.is_hit,
    evaluated_outcome = excluded.evaluated_outcome,
    evaluated_at = excluded.evaluated_at;

  get diagnostics v_consensus_rows = row_count;

  select case
    when bool_and(g.settlement_status in ('settled', 'void')) then 'settled'
    when bool_or(g.settlement_status = 'under_review' or g.status = 'under_review') then 'under_review'
    when bool_and(g.status = 'finished') then 'finished'
    when bool_or(g.status in ('live', 'halftime', 'finished')) then 'live'
    when now() >= r.lock_at then 'locked'
    else 'open'
  end
  into v_round_status
  from public.rounds r
  join public.round_games g on g.round_id = r.id
  where r.id = v_round_id
  group by r.id, r.lock_at;

  update public.rounds
  set status = v_round_status,
      updated_at = now()
  where id = v_round_id;

  return jsonb_build_object(
    'round_game_id', v_round_game_id,
    'round_id', v_round_id,
    'status', v_status,
    'field_outcome', v_field_outcome,
    'pool_settlement_status', coalesce(v_pool_status, v_current_settlement_status),
    'round_status', v_round_status,
    'ticket_results_touched', v_ticket_rows,
    'consensus_results_touched', v_consensus_rows,
    'observed_at', v_observed_at
  );
end;
$$;

revoke all on function public.toto_apply_game_state_v1(jsonb)
from public, anon, authenticated;

grant execute on function public.toto_apply_game_state_v1(jsonb)
to service_role;
