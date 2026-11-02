-- Kapiloto V4 M2B prerequisite: attestation-aware consumer reads.
-- Additive V2 successors preserve the frozen 1A/1C read contracts while
-- preventing current model-facing paths from consuming observations whose
-- provider identity attestation is absent, revoked, stale or disagrees with
-- the current manual_override mapping.
--
-- Important ordering rule: every V2 function first selects the latest visible
-- provider version exactly as V1 does, then applies the attestation gate.
-- An invalid latest version never resurrects an older observation.

create or replace function public.match_ledger_observation_as_of_v2(
  p_fixture_id uuid,
  p_provider text,
  p_cutoff timestamptz
)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_result uuid;
begin
  if p_fixture_id is null or p_provider is null or p_cutoff is null then
    raise exception 'fixture, provider and cutoff are required';
  end if;
  -- Null when nothing was known yet or the latest known version is a withdrawal.
  select case when latest.observation_kind = 'observation' and private.match_ledger_observation_attestation_issue(latest.id) is null then latest.id end
    into v_result
  from (
    select o.id, o.observation_kind
    from public.match_ledger_observations o
    where o.fixture_id = p_fixture_id
      and o.provider = p_provider
      and o.first_seen_at <= p_cutoff
    order by o.observation_version desc
    limit 1
  ) latest;
  return v_result;
end;
$$;

create or replace function public.match_ledger_provider_team_matches_as_of_v2(
  p_provider text,
  p_team_id uuid,
  p_cutoff timestamptz,
  p_limit integer default 10
)
returns table (
  observation_id uuid,
  fixture_id uuid,
  provider text,
  observation_version integer,
  first_seen_at timestamptz,
  kickoff_at timestamptz,
  side text,
  opponent_team_id uuid,
  neutral_venue boolean,
  observed_coach_id uuid,
  canonical_coach_id uuid,
  formation_nominal text,
  goals_for_90 smallint,
  goals_against_90 smallint,
  lineup_status text,
  substitutions_status text,
  events_status text,
  statistics_status text
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_provider is null or p_team_id is null or p_cutoff is null then
    raise exception 'provider, team and cutoff are required';
  end if;
  return query
  with candidates as (
    select distinct tr.fixture_id
    from public.match_ledger_team_records tr
    where tr.team_id = p_team_id
      and tr.first_seen_at <= p_cutoff
  ),
  -- Rank every known version, withdrawals included, before filtering.
  visible as (
    select
      o.id as observation_id,
      o.observation_kind,
      row_number() over (
        partition by o.fixture_id, o.provider
        order by o.observation_version desc
      ) as version_rank
    from candidates c
    join public.match_ledger_observations o on o.fixture_id = c.fixture_id
    where o.first_seen_at <= p_cutoff
      and o.provider = p_provider
  ),
  latest as (
    select
      o.id as observation_id,
      o.fixture_id,
      o.provider,
      o.observation_version,
      o.first_seen_at,
      o.kickoff_at,
      tr.side,
      tr.opponent_team_id,
      o.neutral_venue,
      tr.coach_id as observed_coach_id,
      coalesce(c.merged_into_coach_id, tr.coach_id) as canonical_coach_id,
      tr.formation_nominal,
      case when tr.side = 'home' then o.home_goals_90 else o.away_goals_90 end as goals_for_90,
      case when tr.side = 'home' then o.away_goals_90 else o.home_goals_90 end as goals_against_90,
      tr.lineup_status,
      tr.substitutions_status,
      tr.events_status,
      tr.statistics_status,
      dense_rank() over (order by o.kickoff_at desc, o.fixture_id) as match_rank
    from visible v
    join public.match_ledger_observations o on o.id = v.observation_id
    join public.match_ledger_team_records tr
      on tr.observation_id = o.id and tr.team_id = p_team_id
    left join public.coaches c on c.id = tr.coach_id
    where v.version_rank = 1
      and v.observation_kind = 'observation'
      and private.match_ledger_observation_attestation_issue(o.id) is null
      and o.match_status = 'finished'
      and o.kickoff_at < p_cutoff
  )
  select
    l.observation_id, l.fixture_id, l.provider, l.observation_version,
    l.first_seen_at, l.kickoff_at, l.side, l.opponent_team_id, l.neutral_venue,
    l.observed_coach_id, l.canonical_coach_id, l.formation_nominal,
    l.goals_for_90, l.goals_against_90,
    l.lineup_status, l.substitutions_status, l.events_status,
    l.statistics_status
  from latest l
  where l.match_rank <= least(greatest(coalesce(p_limit, 10), 0), 50)
  order by l.kickoff_at desc;
end;
$$;

create or replace function public.match_ledger_provider_player_matches_as_of_v2(
  p_provider text,
  p_player_id uuid,
  p_cutoff timestamptz,
  p_limit integer default 10
)
returns table (
  observation_id uuid,
  fixture_id uuid,
  provider text,
  observation_version integer,
  first_seen_at timestamptz,
  kickoff_at timestamptz,
  canonical_player_id uuid,
  observed_player_id uuid,
  team_id uuid,
  lineup_role text,
  appeared boolean,
  position_code text,
  formation_position smallint,
  is_captain boolean,
  minutes_played smallint,
  entered_minute smallint,
  exited_minute smallint,
  data_completeness text
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_canonical uuid;
  v_identities uuid[];
begin
  if p_provider is null or p_player_id is null or p_cutoff is null then
    raise exception 'provider, player and cutoff are required';
  end if;
  v_canonical := private.surviving_player_id(p_player_id);
  select array_append(coalesce(array_agg(pl.id), '{}'::uuid[]), v_canonical)
    into v_identities
  from public.players pl
  where pl.merged_into_player_id = v_canonical;

  return query
  with candidates as (
    select distinct o.fixture_id
    from public.match_ledger_players p
    join public.match_ledger_observations o on o.id = p.observation_id
    where p.player_id = any (v_identities)
      and p.first_seen_at <= p_cutoff
  ),
  visible as (
    select
      o.id as observation_id,
      o.observation_kind,
      row_number() over (
        partition by o.fixture_id, o.provider
        order by o.observation_version desc
      ) as version_rank
    from candidates c
    join public.match_ledger_observations o on o.fixture_id = c.fixture_id
    where o.first_seen_at <= p_cutoff
      and o.provider = p_provider
  ),
  latest as (
    select
      o.id as observation_id,
      o.fixture_id,
      o.provider,
      o.observation_version,
      o.first_seen_at,
      o.kickoff_at,
      v_canonical as canonical_player_id,
      p.player_id as observed_player_id,
      p.team_id,
      p.lineup_role,
      p.appeared,
      p.position_code,
      p.formation_position,
      p.is_captain,
      p.minutes_played,
      p.entered_minute,
      p.exited_minute,
      p.data_completeness,
      dense_rank() over (order by o.kickoff_at desc, o.fixture_id) as match_rank
    from visible v
    join public.match_ledger_observations o on o.id = v.observation_id
    join public.match_ledger_players p
      on p.observation_id = o.id and p.player_id = any (v_identities)
    where v.version_rank = 1
      and v.observation_kind = 'observation'
      and private.match_ledger_observation_attestation_issue(o.id) is null
      and o.match_status = 'finished'
      and o.kickoff_at < p_cutoff
  )
  select
    l.observation_id, l.fixture_id, l.provider, l.observation_version,
    l.first_seen_at, l.kickoff_at, l.canonical_player_id, l.observed_player_id,
    l.team_id, l.lineup_role, l.appeared,
    l.position_code, l.formation_position, l.is_captain, l.minutes_played,
    l.entered_minute, l.exited_minute, l.data_completeness
  from latest l
  where l.match_rank <= least(greatest(coalesce(p_limit, 10), 0), 50)
  order by l.kickoff_at desc;
end;
$$;

create or replace function public.squad_state_inputs_as_of_v2(
  p_fixture_id uuid,
  p_team_id uuid,
  p_cutoff timestamptz,
  p_history_fixture_limit integer default 30
)
returns jsonb
language plpgsql
stable
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_fixture public.fixtures%rowtype;
  v_kickoff timestamptz;
  v_side text;
  v_opponent uuid;
  v_target_date date;
  v_limit integer := least(greatest(coalesce(p_history_fixture_limit, 30), 1), 60);
  v_history jsonb;
  v_memberships jsonb;
  v_claims jsonb;
  v_tenures jsonb;
begin
  if p_fixture_id is null or p_team_id is null or p_cutoff is null then
    raise exception 'fixture, team and cutoff are required';
  end if;
  select f.* into v_fixture from public.fixtures f where f.id = p_fixture_id;
  if not found then
    raise exception 'fixture % not found', p_fixture_id;
  end if;
  if v_fixture.home_team_id = p_team_id then
    v_side := 'home';
    v_opponent := v_fixture.away_team_id;
  elsif v_fixture.away_team_id = p_team_id then
    v_side := 'away';
    v_opponent := v_fixture.home_team_id;
  else
    raise exception 'team % does not play fixture %', p_team_id, p_fixture_id;
  end if;
  v_kickoff := coalesce(v_fixture.actual_kickoff_at, v_fixture.kickoff_at);
  if p_cutoff > v_kickoff then
    raise exception 'squad-state cutoff % is after the fixture kickoff %', p_cutoff, v_kickoff;
  end if;
  v_target_date := (v_kickoff at time zone 'UTC')::date;

  with team_fixtures as (
    select distinct tr.fixture_id
    from public.match_ledger_team_records tr
    where tr.team_id = p_team_id
      and tr.first_seen_at <= p_cutoff
      and tr.fixture_id <> p_fixture_id
  ),
  visible as (
    select
      o.*,
      row_number() over (partition by o.fixture_id, o.provider order by o.observation_version desc) as version_rank
    from public.match_ledger_observations o
    join team_fixtures tf on tf.fixture_id = o.fixture_id
    where o.first_seen_at <= p_cutoff
  ),
  latest as (
    select vi.*
    from visible vi
    where vi.version_rank = 1
      and vi.observation_kind = 'observation'
      and private.match_ledger_observation_attestation_issue(vi.id) is null
      and vi.match_status = 'finished'
      and vi.kickoff_at < v_kickoff
  ),
  recent as (
    select l.fixture_id
    from latest l
    group by l.fixture_id
    order by max(l.kickoff_at) desc, l.fixture_id
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'observation_id', l.id,
      'fixture_id', l.fixture_id,
      'provider', l.provider,
      'observation_version', l.observation_version,
      'first_seen_at', l.first_seen_at,
      'kickoff_at', l.kickoff_at,
      'side', tr.side,
      'opponent_team_id', tr.opponent_team_id,
      'observed_coach_id', tr.coach_id,
      'canonical_coach_id', coalesce(co.merged_into_coach_id, tr.coach_id),
      'lineup_status', tr.lineup_status,
      'substitutions_status', tr.substitutions_status,
      'players', (
        select coalesce(jsonb_agg(jsonb_build_object(
            'observed_player_id', p.player_id,
            'canonical_player_id', coalesce(pl.merged_into_player_id, p.player_id),
            'lineup_role', p.lineup_role,
            'appeared', p.appeared,
            'position_code', p.position_code,
            'formation_position', p.formation_position,
            'is_captain', p.is_captain,
            'minutes_played', p.minutes_played,
            'entered_minute', p.entered_minute,
            'exited_minute', p.exited_minute
          ) order by p.player_id), '[]'::jsonb)
        from public.match_ledger_players p
        join public.players pl on pl.id = p.player_id
        where p.observation_id = l.id and p.team_id = p_team_id
      ),
      'substitutions', (
        select coalesce(jsonb_agg(jsonb_build_object(
            'sequence_no', s.sequence_no,
            'observed_player_off_id', s.player_off_id,
            'canonical_player_off_id', coalesce(poff.merged_into_player_id, s.player_off_id),
            'observed_player_on_id', s.player_on_id,
            'canonical_player_on_id', coalesce(pon.merged_into_player_id, s.player_on_id),
            'minute', s.minute,
            'stoppage_minute', s.stoppage_minute
          ) order by s.sequence_no), '[]'::jsonb)
        from public.match_ledger_substitutions s
        join public.players poff on poff.id = s.player_off_id
        join public.players pon on pon.id = s.player_on_id
        where s.observation_id = l.id and s.team_id = p_team_id
      )
    ) order by l.kickoff_at desc, l.fixture_id, l.provider), '[]'::jsonb)
    into v_history
  from latest l
  join recent rc on rc.fixture_id = l.fixture_id
  join public.match_ledger_team_records tr on tr.observation_id = l.id and tr.team_id = p_team_id
  left join public.coaches co on co.id = tr.coach_id;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.canonical_player_id, m.membership_key), '[]'::jsonb)
    into v_memberships
  from public.team_player_memberships_as_of(p_team_id, p_cutoff, v_target_date) m;

  with target_claims as (
    select c.id
    from public.knowledge_claims c
    where c.fixture_id = p_fixture_id
      and c.claim_type in ('player_availability', 'expected_lineup')
      and c.player_id is not null
      and (c.team_id = p_team_id or c.team_id is null)
      and c.first_seen_at <= p_cutoff
  ),
  beliefs as (
    select distinct on (b.canonical_claim_id) b.*
    from public.knowledge_claim_resolutions_as_of(
      (select coalesce(array_agg(tc.id), '{}'::uuid[]) from target_claims tc), p_cutoff
    ) b
    order by b.canonical_claim_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'claim_id', rep.id,
      'canonical_claim_id', b.canonical_claim_id,
      'member_claim_ids', to_jsonb(b.member_claim_ids),
      'claim_kind', rep.claim_kind,
      'claim_type', rep.claim_type,
      'predicate', rep.predicate,
      'team_id', rep.team_id,
      'observed_player_id', rep.player_id,
      'canonical_player_id', coalesce(pl.merged_into_player_id, rep.player_id),
      'object_value', rep.object_value,
      'polarity', rep.polarity,
      'claim_first_seen_at', rep.first_seen_at,
      'resolution_id', b.resolution_id,
      'resolution_claim_id', b.resolution_claim_id,
      'resolution_status', b.status,
      'resolution_first_seen_at', b.first_seen_at,
      'quality_flags', to_jsonb(b.quality_flags)
    ) order by b.canonical_claim_id), '[]'::jsonb)
    into v_claims
  from beliefs b
  join public.knowledge_claims rep on rep.id = b.canonical_claim_id
  join public.players pl on pl.id = rep.player_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'tenure_id', t.id,
      'tenure_key', t.tenure_key,
      'tenure_version', t.tenure_version,
      'observed_coach_id', t.coach_id,
      'canonical_coach_id', t.canonical_coach_id,
      'role', t.role,
      'starts_on_earliest', t.starts_on_earliest,
      'starts_on_latest', t.starts_on_latest,
      'ends_on_earliest', t.ends_on_earliest,
      'ends_on_latest', t.ends_on_latest,
      'first_seen_at', t.first_seen_at
    ) order by t.tenure_key), '[]'::jsonb)
    into v_tenures
  from public.team_coach_tenures_as_of(p_team_id, p_cutoff) t;

  return jsonb_build_object(
    'contract_version', 'kapiloto-squad-state-inputs-v1',
    'fixture_id', p_fixture_id,
    'team_id', p_team_id,
    'opponent_team_id', v_opponent,
    'side', v_side,
    'kickoff_at', v_kickoff,
    'cutoff', p_cutoff,
    'target_date', v_target_date,
    'target_date_policy', 'kapiloto-target-date-utc-v1',
    'history', v_history,
    'memberships', v_memberships,
    'claims', v_claims,
    'tenures', v_tenures
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Security: reads are available only to service_role. V2 ingest remains
-- revoked; the separate M2B grant migration is still required.
-- ---------------------------------------------------------------------------

revoke all on function public.match_ledger_observation_as_of_v2(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.match_ledger_provider_team_matches_as_of_v2(text, uuid, timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.match_ledger_provider_player_matches_as_of_v2(text, uuid, timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.squad_state_inputs_as_of_v2(uuid, uuid, timestamptz, integer)
  from public, anon, authenticated;

grant execute on function public.match_ledger_observation_as_of_v2(uuid, text, timestamptz) to service_role;
grant execute on function public.match_ledger_provider_team_matches_as_of_v2(text, uuid, timestamptz, integer) to service_role;
grant execute on function public.match_ledger_provider_player_matches_as_of_v2(text, uuid, timestamptz, integer) to service_role;
grant execute on function public.squad_state_inputs_as_of_v2(uuid, uuid, timestamptz, integer) to service_role;

-- This migration must not activate provider ingest.
revoke all on function public.match_ledger_ingest_provider_fixture_v2(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.match_ledger_ingest_provider_fixture(jsonb)
  from public, anon, authenticated, service_role;

comment on function public.match_ledger_observation_as_of_v2(uuid, text, timestamptz) is
  'Stage 1 attestation-aware successor of match_ledger_observation_as_of. Latest visible version is selected before trust filtering; invalid identity provenance returns null and never falls back to an older version.';
comment on function public.match_ledger_provider_team_matches_as_of_v2(text, uuid, timestamptz, integer) is
  'Stage 1 attestation-aware successor of match_ledger_provider_team_matches_as_of. Only latest visible finished observations with currently valid sealed identity attestations are returned.';
comment on function public.match_ledger_provider_player_matches_as_of_v2(text, uuid, timestamptz, integer) is
  'Stage 1 attestation-aware successor of match_ledger_provider_player_matches_as_of. Only latest visible finished observations with currently valid sealed identity attestations are returned.';
comment on function public.squad_state_inputs_as_of_v2(uuid, uuid, timestamptz, integer) is
  'Stage 1 attestation-aware successor of squad_state_inputs_as_of. Membership, claims and tenure semantics are unchanged; Match Ledger history is limited to currently trusted attested observations.';
