-- Kapiloto V4 M2B prerequisite: attestation-aware consumer reads.
-- Additive V2 successors preserve the frozen 1A/1C read contracts while
-- preventing current model-facing paths from consuming observations whose
-- provider identity attestation is absent, revoked, stale or disagrees with
-- the current manual_override mapping.
--
-- Ordering rules (identical in every V2 read):
--   1. the latest visible provider version is selected exactly as V1 does,
--      withdrawals included, so an invalid latest version never resurrects an
--      older observation;
--   2. a last-N window is the exact window V1 would select (conservative
--      window): an untrusted fixture inside it shrinks the trusted history and
--      is never replaced by an older fixture from outside it;
--   3. only then is the Stage 1 trust gate applied, at current state.
--
-- The Prediction Registry records which squad-state read assembled a lineup
-- forecast (kapiloto-squad-state-read-v1 for every frozen snapshot, -v2 for
-- trusted forecasts) and re-runs exactly that read at commit. The canonical
-- input bundle of a read-v1 snapshot is byte-identical to before.

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
  -- The V1 window first, then the trust gate: never reach further back.
  where l.match_rank <= least(greatest(coalesce(p_limit, 10), 0), 50)
    and private.match_ledger_observation_attestation_issue(l.observation_id) is null
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
  -- The V1 window first, then the trust gate: never reach further back.
  where l.match_rank <= least(greatest(coalesce(p_limit, 10), 0), 50)
    and private.match_ledger_observation_attestation_issue(l.observation_id) is null
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
      and vi.match_status = 'finished'
      and vi.kickoff_at < v_kickoff
  ),
  recent as (
    -- The exact V1 window of canonical fixtures, chosen before the trust
    -- gate: an untrusted fixture inside it shrinks the history and is never
    -- replaced by an older fixture from outside it.
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
  left join public.coaches co on co.id = tr.coach_id
  where private.match_ledger_observation_attestation_issue(l.id) is null;

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

  -- Same kapiloto-squad-state-inputs-v1 shape as the V1 read; read_version
  -- names the read policy that assembled it (the V1 read returns none).
  return jsonb_build_object(
    'contract_version', 'kapiloto-squad-state-inputs-v1',
    'read_version', 'kapiloto-squad-state-read-v2',
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
-- Security: the V2 reads are available only to service_role.
--
-- Provider ingest privileges are deliberately NOT touched here: M2A leaves
-- both ingest RPCs revoked from service_role, and only the separate,
-- grant-only M2B migration may change that. Re-revoking them here would
-- silently undo an M2B grant if migrations were ever applied out of order.
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

-- The V1 consumer reads would now mislead (they ignore Stage 1 trust), as
-- the V1 team-stat reads did in M2A: present for contract/history inspection,
-- not executable by service_role. No frozen path needs them as service_role:
-- an idempotent replay of a frozen snapshot returns before any read, and
-- offline replay uses the frozen artifact. The only SQL caller of the V1
-- squad read is the registry's read-v1 branch, which therefore cannot be used
-- by service_role to record NEW read-v1 lineup forecasts.
revoke all on function public.match_ledger_observation_as_of(uuid, text, timestamptz) from service_role;
revoke all on function public.match_ledger_provider_team_matches_as_of(text, uuid, timestamptz, integer) from service_role;
revoke all on function public.match_ledger_provider_player_matches_as_of(text, uuid, timestamptz, integer) from service_role;
revoke all on function public.squad_state_inputs_as_of(uuid, uuid, timestamptz, integer) from service_role;

comment on function public.match_ledger_observation_as_of_v2(uuid, text, timestamptz) is
  'Stage 1 attestation-aware successor of match_ledger_observation_as_of. The latest visible version is selected before the trust gate; an untrusted latest version returns null (as nothing known or a withdrawal does) and never falls back to an older version.';
comment on function public.match_ledger_provider_team_matches_as_of_v2(text, uuid, timestamptz, integer) is
  'Stage 1 attestation-aware successor of match_ledger_provider_team_matches_as_of. The exact V1 window of latest visible finished observations, then only those whose sealed identity attestations are currently valid; an untrusted fixture shrinks the window and is never replaced by an older one.';
comment on function public.match_ledger_provider_player_matches_as_of_v2(text, uuid, timestamptz, integer) is
  'Stage 1 attestation-aware successor of match_ledger_provider_player_matches_as_of. The exact V1 window of latest visible finished observations, then only those whose sealed identity attestations are currently valid; an untrusted fixture shrinks the window and is never replaced by an older one.';
comment on function public.squad_state_inputs_as_of_v2(uuid, uuid, timestamptz, integer) is
  'Stage 1 attestation-aware successor of squad_state_inputs_as_of (read kapiloto-squad-state-read-v2). Membership, claim and tenure semantics are unchanged; Match Ledger history is the exact V1 fixture window, limited to currently trusted attested observations.';


-- ---------------------------------------------------------------------------
-- Prediction Registry read-version binding.
--
-- squad_state_read_version names the database read that assembled a lineup
-- forecast's raw squad inputs. It is separate from
-- squad_state_inputs_contract (the JSON shape, shared by both reads), so no
-- existing contract version changes meaning. Every context row written
-- before this migration was built by the V1 read and is backfilled as
-- read-v1; new trusted forecasts declare read-v2. The deferred registry
-- check re-runs exactly the declared read.
--
-- Canonical form: read-v1 is the implicit legacy value and is OMITTED from
-- the canonical squad-state context (explicit or absent, same bytes), so
-- every frozen bundle hash, and every idempotent replay of a frozen payload,
-- is unchanged. read-v2 is included, so the hash commits to it.
-- ---------------------------------------------------------------------------

alter table public.prediction_squad_state_context
  add column squad_state_read_version text not null
    default 'kapiloto-squad-state-read-v1'
    constraint prediction_squad_state_context_read_version_check
    check (squad_state_read_version in ('kapiloto-squad-state-read-v1', 'kapiloto-squad-state-read-v2'));

create or replace function private.prediction_canonical_inputs_v2(p_inputs jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_inputs jsonb := coalesce(p_inputs, '{}'::jsonb);
  v_context jsonb := v_inputs->'squad_state_context';
begin
  perform private.kapiloto_v4_assert_keys(v_inputs, array[
    'ledger', 'documents', 'claims', 'claim_observations', 'references', 'identities',
    'memberships', 'tenures', 'squad_state_context'
  ], 'prediction inputs');
  perform private.kapiloto_v4_assert_keys(coalesce(v_inputs->'memberships', '[]'::jsonb),
    array['membership_id', 'input_role'], 'membership input');
  perform private.kapiloto_v4_assert_keys(coalesce(v_inputs->'tenures', '[]'::jsonb),
    array['tenure_id', 'input_role'], 'tenure input');
  if v_context is not null and jsonb_typeof(v_context) not in ('null', 'object') then
    raise exception 'squad-state context must be an object or null';
  end if;
  if v_context is not null and jsonb_typeof(v_context) <> 'null' then
    perform private.kapiloto_v4_assert_keys(v_context, array[
      'subject_team_id', 'squad_state_read_version', 'squad_state_inputs_contract', 'squad_state_contract',
      'squad_state_builder_version', 'squad_features_version',
      'history_selection_policy_version', 'availability_normalization_version',
      'target_date_policy', 'provider_priority', 'history_max_fixtures', 'squad_state_sha256',
      'squad_state_canonical_json'
    ], 'squad-state context');
    -- Absent means read-v1 (every frozen payload); anything present must be a
    -- known read, spelled as a string, never silently mapped to read-v1.
    if v_context ? 'squad_state_read_version' and (
      jsonb_typeof(v_context->'squad_state_read_version') <> 'string'
      or v_context->>'squad_state_read_version' not in ('kapiloto-squad-state-read-v1', 'kapiloto-squad-state-read-v2')
    ) then
      raise exception 'unsupported squad-state read version %', v_context->'squad_state_read_version';
    end if;
  end if;

  return private.prediction_canonical_inputs(v_inputs - array['memberships', 'tenures', 'squad_state_context'])
    || jsonb_build_object(
      'memberships', coalesce((
        select jsonb_agg(e order by e::text) from (
          select jsonb_build_object('membership_id', x.membership_id, 'input_role', coalesce(x.input_role, 'squad_membership')) as e
          from jsonb_to_recordset(coalesce(v_inputs->'memberships', '[]'::jsonb)) as x(membership_id uuid, input_role text)
        ) s), '[]'::jsonb),
      'tenures', coalesce((
        select jsonb_agg(e order by e::text) from (
          select jsonb_build_object('tenure_id', x.tenure_id, 'input_role', coalesce(x.input_role, 'squad_coach_tenure')) as e
          from jsonb_to_recordset(coalesce(v_inputs->'tenures', '[]'::jsonb)) as x(tenure_id uuid, input_role text)
        ) s), '[]'::jsonb),
      'squad_state_context', (
        select jsonb_build_object(
          'subject_team_id', c.subject_team_id,
          'squad_state_inputs_contract', c.squad_state_inputs_contract,
          'squad_state_contract', c.squad_state_contract,
          'squad_state_builder_version', c.squad_state_builder_version,
          'squad_features_version', c.squad_features_version,
          'history_selection_policy_version', c.history_selection_policy_version,
          'availability_normalization_version', c.availability_normalization_version,
          'target_date_policy', c.target_date_policy,
          'provider_priority', to_jsonb(c.provider_priority),
          'history_max_fixtures', c.history_max_fixtures,
          'squad_state_sha256', c.squad_state_sha256,
          'squad_state_canonical_json', c.squad_state_canonical_json
        ) || case
          -- read-v1 stays implicit: frozen hashes are byte-identical.
          when c.squad_state_read_version = 'kapiloto-squad-state-read-v2'
            then jsonb_build_object('squad_state_read_version', c.squad_state_read_version)
          else '{}'::jsonb
        end
        from jsonb_to_record(v_context) as c(
          subject_team_id uuid, squad_state_read_version text, squad_state_inputs_contract text, squad_state_contract text,
          squad_state_builder_version text, squad_features_version text,
          history_selection_policy_version text, availability_normalization_version text,
          target_date_policy text, provider_priority text[], history_max_fixtures smallint,
          squad_state_sha256 text, squad_state_canonical_json text
        )
        where jsonb_typeof(v_context) = 'object'
      )
    );
end;
$$;

create or replace function public.prediction_record_snapshot_v2(p_snapshot jsonb)
returns jsonb
language plpgsql
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v record;
  v_inputs jsonb;
  v_bundle_sha text;
  v_output_sha text;
  v_existing public.prediction_snapshots%rowtype;
  v_id uuid;
  v_first_seen timestamptz;
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'prediction snapshot must be a JSON object';
  end if;
  if p_snapshot->>'contract_version' is distinct from 'kapiloto-prediction-snapshot-v2' then
    raise exception 'unsupported prediction snapshot contract';
  end if;
  perform private.kapiloto_v4_assert_keys(p_snapshot, array[
    'contract_version', 'idempotency_key', 'fixture_id', 'round_game_id',
    'prediction_kind', 'subject_team_id',
    'purpose', 'prediction_protocol_version', 'pipeline_version',
    'code_revision', 'model_identifiers', 'prompt_hashes', 'feature_versions',
    'derivation_version', 'calibration_version', 'settlement_rule',
    'research_cutoff_at', 'kickoff_at_snapshot', 'generated_at', 'outcome',
    'abstain_reason', 'p_1_bp', 'p_x_bp', 'p_2_bp', 'reliability',
    'uncertainty', 'payload_schema_version', 'payload', 'inputs'
  ], 'prediction snapshot');

  select * into v
  from jsonb_to_record(p_snapshot) as s(
    idempotency_key text, fixture_id uuid, round_game_id uuid,
    prediction_kind text, subject_team_id uuid, purpose text,
    prediction_protocol_version text, pipeline_version text,
    code_revision text, model_identifiers jsonb, prompt_hashes jsonb,
    feature_versions jsonb, derivation_version text,
    calibration_version text, settlement_rule text,
    research_cutoff_at timestamptz, kickoff_at_snapshot timestamptz,
    generated_at timestamptz, outcome text, abstain_reason text,
    p_1_bp smallint, p_x_bp smallint, p_2_bp smallint, reliability numeric,
    uncertainty jsonb, payload_schema_version text, payload jsonb
  );
  if v.idempotency_key is null or v.fixture_id is null or v.research_cutoff_at is null then
    raise exception 'prediction snapshot requires idempotency_key, fixture_id and research_cutoff_at';
  end if;

  v_inputs := private.prediction_canonical_inputs_v2(p_snapshot->'inputs');
  if exists (
    select 1 from jsonb_array_elements(v_inputs->'identities') b
    where b->>'entity_type' = 'team' and b->>'observed_entity_id' is not null
  ) then
    raise exception 'team identity bindings have no observed id';
  end if;
  v_bundle_sha := private.prediction_input_bundle_sha256_v2(v_inputs);
  v_output_sha := private.prediction_output_sha256(
    v.outcome, v.abstain_reason, v.p_1_bp, v.p_x_bp, v.p_2_bp, v.reliability,
    coalesce(v.uncertainty, '{}'::jsonb), v.payload_schema_version,
    coalesce(v.payload, '{}'::jsonb)
  );

  perform private.kapiloto_require_read_committed('prediction registry writes');
  perform pg_advisory_xact_lock(hashtextextended('kapiloto_prediction:' || v.idempotency_key, 0));

  -- Idempotent replay of the same intended write only.
  select s.* into v_existing
  from public.prediction_snapshots s where s.idempotency_key = v.idempotency_key;
  if found then
    if v_existing.input_bundle_sha256 = v_bundle_sha
      and v_existing.output_bundle_sha256 = v_output_sha
      and (
        v_existing.fixture_id, v_existing.round_game_id, v_existing.purpose,
        v_existing.prediction_kind, v_existing.subject_team_id,
        v_existing.prediction_protocol_version, v_existing.pipeline_version,
        v_existing.code_revision, v_existing.model_identifiers,
        v_existing.prompt_hashes, v_existing.feature_versions,
        v_existing.derivation_version, v_existing.calibration_version,
        v_existing.settlement_rule, v_existing.research_cutoff_at,
        v_existing.kickoff_at_snapshot, v_existing.generated_at
      ) is not distinct from (
        v.fixture_id, v.round_game_id, v.purpose,
        v.prediction_kind, v.subject_team_id,
        v.prediction_protocol_version, v.pipeline_version, v.code_revision,
        coalesce(v.model_identifiers, '{}'::jsonb),
        coalesce(v.prompt_hashes, '{}'::jsonb),
        coalesce(v.feature_versions, '{}'::jsonb), v.derivation_version,
        v.calibration_version, v.settlement_rule, v.research_cutoff_at,
        v.kickoff_at_snapshot, v.generated_at
      ) then
      return jsonb_build_object(
        'status', 'unchanged',
        'snapshot_id', v_existing.id,
        'first_seen_at', v_existing.first_seen_at,
        'input_bundle_sha256', v_existing.input_bundle_sha256,
        'output_bundle_sha256', v_existing.output_bundle_sha256
      );
    end if;
    raise exception 'prediction idempotency key % was already used for a different snapshot', v.idempotency_key;
  end if;

  set constraints public.prediction_snapshots_input_bundle deferred;

  -- first_seen_at, ingest_statement_at and the output hash are assigned by
  -- the stamp trigger.
  insert into public.prediction_snapshots (
    contract_version, idempotency_key, fixture_id, round_game_id,
    prediction_kind, subject_team_id, purpose,
    prediction_protocol_version, pipeline_version, code_revision,
    model_identifiers, prompt_hashes, feature_versions, derivation_version,
    calibration_version, settlement_rule, research_cutoff_at,
    kickoff_at_snapshot, generated_at, outcome, abstain_reason, p_1_bp,
    p_x_bp, p_2_bp, reliability, uncertainty, payload_schema_version, payload,
    input_bundle_sha256, output_bundle_sha256
  )
  values (
    'kapiloto-prediction-snapshot-v2', v.idempotency_key, v.fixture_id,
    v.round_game_id, v.prediction_kind, v.subject_team_id, v.purpose, v.prediction_protocol_version,
    v.pipeline_version, v.code_revision,
    coalesce(v.model_identifiers, '{}'::jsonb),
    coalesce(v.prompt_hashes, '{}'::jsonb),
    coalesce(v.feature_versions, '{}'::jsonb), v.derivation_version,
    v.calibration_version, v.settlement_rule, v.research_cutoff_at,
    v.kickoff_at_snapshot, v.generated_at, v.outcome, v.abstain_reason,
    v.p_1_bp, v.p_x_bp, v.p_2_bp, v.reliability,
    coalesce(v.uncertainty, '{}'::jsonb), v.payload_schema_version,
    coalesce(v.payload, '{}'::jsonb), v_bundle_sha, v_output_sha
  )
  returning id, first_seen_at into v_id, v_first_seen;

  insert into public.prediction_ledger_inputs (snapshot_id, ledger_observation_id, input_role, input_first_seen_at)
  select v_id, x.ledger_observation_id, x.input_role, v_first_seen
  from jsonb_to_recordset(v_inputs->'ledger') as x(ledger_observation_id uuid, input_role text);

  insert into public.prediction_document_inputs (snapshot_id, document_version_id, input_role, input_first_seen_at)
  select v_id, x.document_version_id, x.input_role, v_first_seen
  from jsonb_to_recordset(v_inputs->'documents') as x(document_version_id uuid, input_role text);

  insert into public.prediction_claim_inputs (
    snapshot_id, claim_id, resolution_id, resolution_status, input_role, input_first_seen_at
  )
  select v_id, x.claim_id, x.resolution_id, 'unresolved', x.input_role, v_first_seen
  from jsonb_to_recordset(v_inputs->'claims') as x(claim_id uuid, resolution_id uuid, input_role text);

  insert into public.prediction_claim_observation_inputs (snapshot_id, claim_observation_id, input_role, input_first_seen_at)
  select v_id, x.claim_observation_id, x.input_role, v_first_seen
  from jsonb_to_recordset(v_inputs->'claim_observations') as x(claim_observation_id uuid, input_role text);

  insert into public.prediction_reference_inputs (
    snapshot_id, reference_kind, market_quote_id, market_snapshot_id,
    structured_snapshot_id, fact_snapshot_id, legacy_v3_id, input_role
  )
  select
    v_id, x.reference_kind,
    case when x.reference_kind = 'market_quote' then x.reference_id end,
    case when x.reference_kind = 'market_snapshot' then x.reference_id end,
    case when x.reference_kind = 'structured_snapshot' then x.reference_id end,
    case when x.reference_kind = 'fact_snapshot' then x.reference_id end,
    case when x.reference_kind in ('v3_research_run', 'v3_analysis', 'v3_evidence') then x.reference_id end,
    x.input_role
  from jsonb_to_recordset(v_inputs->'references') as x(reference_kind text, reference_id uuid, input_role text);

  insert into public.prediction_identity_bindings (
    snapshot_id, entity_type, player_id, coach_id, team_id,
    observed_player_id, observed_coach_id, binding_role, context_team_id,
    provider, provider_entity_id
  )
  select
    v_id, x.entity_type,
    case when x.entity_type = 'player' then x.entity_id end,
    case when x.entity_type = 'coach' then x.entity_id end,
    case when x.entity_type = 'team' then x.entity_id end,
    case when x.entity_type = 'player' then x.observed_entity_id end,
    case when x.entity_type = 'coach' then x.observed_entity_id end,
    x.binding_role, x.context_team_id, x.provider, x.provider_entity_id
  from jsonb_to_recordset(v_inputs->'identities') as x(
    entity_type text, entity_id uuid, observed_entity_id uuid,
    binding_role text, context_team_id uuid, provider text,
    provider_entity_id text
  );

  insert into public.prediction_membership_inputs (snapshot_id, membership_id, input_role, input_first_seen_at)
  select v_id, x.membership_id, x.input_role, v_first_seen
  from jsonb_to_recordset(v_inputs->'memberships') as x(membership_id uuid, input_role text);

  insert into public.prediction_tenure_inputs (snapshot_id, tenure_id, input_role, input_first_seen_at)
  select v_id, x.tenure_id, x.input_role, v_first_seen
  from jsonb_to_recordset(v_inputs->'tenures') as x(tenure_id uuid, input_role text);

  insert into public.prediction_squad_state_context (
    snapshot_id, subject_team_id, squad_state_read_version, squad_state_inputs_contract, squad_state_contract,
    squad_state_builder_version, squad_features_version,
    history_selection_policy_version, availability_normalization_version,
    target_date_policy, provider_priority, history_max_fixtures, squad_state_sha256,
    squad_state_canonical_json
  )
  select
    v_id, c.subject_team_id, coalesce(c.squad_state_read_version, 'kapiloto-squad-state-read-v1'), c.squad_state_inputs_contract, c.squad_state_contract,
    c.squad_state_builder_version, c.squad_features_version,
    c.history_selection_policy_version, c.availability_normalization_version,
    c.target_date_policy, c.provider_priority, c.history_max_fixtures, c.squad_state_sha256,
    c.squad_state_canonical_json
  from jsonb_to_record(v_inputs->'squad_state_context') as c(
    subject_team_id uuid, squad_state_read_version text, squad_state_inputs_contract text, squad_state_contract text,
    squad_state_builder_version text, squad_features_version text,
    history_selection_policy_version text, availability_normalization_version text,
    target_date_policy text, provider_priority text[], history_max_fixtures smallint,
    squad_state_sha256 text, squad_state_canonical_json text
  )
  where jsonb_typeof(v_inputs->'squad_state_context') = 'object';

  set constraints public.prediction_snapshots_input_bundle immediate;

  return jsonb_build_object(
    'status', 'recorded',
    'snapshot_id', v_id,
    'first_seen_at', v_first_seen,
    'input_bundle_sha256', v_bundle_sha,
    'output_bundle_sha256', v_output_sha
  );
end;
$$;

create or replace function private.check_prediction_input_bundle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_inputs jsonb;
  v_hash text;
  v_context public.prediction_squad_state_context%rowtype;
  v_missing uuid;
  v_expected jsonb;
  v_state jsonb;
  v_issue text;
begin
  select jsonb_build_object(
    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ledger_observation_id', i.ledger_observation_id, 'input_role', i.input_role))
      from public.prediction_ledger_inputs i where i.snapshot_id = new.id), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'document_version_id', i.document_version_id, 'input_role', i.input_role))
      from public.prediction_document_inputs i where i.snapshot_id = new.id), '[]'::jsonb),
    'claims', coalesce((
      select jsonb_agg(jsonb_build_object(
        'claim_id', i.claim_id, 'resolution_id', i.resolution_id, 'input_role', i.input_role))
      from public.prediction_claim_inputs i where i.snapshot_id = new.id), '[]'::jsonb),
    'claim_observations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'claim_observation_id', i.claim_observation_id, 'input_role', i.input_role))
      from public.prediction_claim_observation_inputs i where i.snapshot_id = new.id), '[]'::jsonb),
    'references', coalesce((
      select jsonb_agg(jsonb_build_object(
        'reference_kind', i.reference_kind,
        'reference_id', coalesce(i.market_quote_id, i.market_snapshot_id,
          i.structured_snapshot_id, i.fact_snapshot_id, i.legacy_v3_id),
        'input_role', i.input_role))
      from public.prediction_reference_inputs i where i.snapshot_id = new.id), '[]'::jsonb),
    'identities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entity_type', b.entity_type,
        'entity_id', coalesce(b.player_id, b.coach_id, b.team_id),
        'observed_entity_id', coalesce(b.observed_player_id, b.observed_coach_id),
        'binding_role', b.binding_role,
        'context_team_id', b.context_team_id,
        'provider', b.provider,
        'provider_entity_id', b.provider_entity_id))
      from public.prediction_identity_bindings b where b.snapshot_id = new.id), '[]'::jsonb)
  ) into v_inputs;

  if new.contract_version = 'kapiloto-prediction-snapshot-v1' then
    -- Exactly the 1B canonicalization: V1 hashes never change.
    v_hash := private.prediction_input_bundle_sha256(v_inputs);
  else
    v_inputs := v_inputs || jsonb_build_object(
      'memberships', coalesce((
        select jsonb_agg(jsonb_build_object('membership_id', i.membership_id, 'input_role', i.input_role))
        from public.prediction_membership_inputs i where i.snapshot_id = new.id), '[]'::jsonb),
      'tenures', coalesce((
        select jsonb_agg(jsonb_build_object('tenure_id', i.tenure_id, 'input_role', i.input_role))
        from public.prediction_tenure_inputs i where i.snapshot_id = new.id), '[]'::jsonb),
      'squad_state_context', (
        -- Hashed through prediction_canonical_inputs_v2, the single owner of
        -- the canonical form: read-v1 (every frozen row) stays implicit.
        select to_jsonb(c) - 'snapshot_id'
        from public.prediction_squad_state_context c where c.snapshot_id = new.id)
    );
    v_hash := private.prediction_input_bundle_sha256_v2(v_inputs);

    select c.* into v_context from public.prediction_squad_state_context c where c.snapshot_id = new.id;
    if new.prediction_kind = 'lineup_forecast' then
      if v_context.snapshot_id is null then
        raise exception 'lineup forecast % has no squad-state context', new.id;
      end if;

      -- Complete 1C capture: the frozen links are exactly what the DECLARED
      -- squad-state read returns for this fixture, team, cutoff and history
      -- window - no omitted provider alternative, membership, tenure, claim
      -- or resolution, and nothing it would not return. A read-v2 forecast
      -- that froze an untrusted observation is therefore refused here.
      if v_context.squad_state_read_version = 'kapiloto-squad-state-read-v2' then
        v_expected := public.squad_state_inputs_as_of_v2(
          new.fixture_id, new.subject_team_id, new.research_cutoff_at, v_context.history_max_fixtures::integer);
      elsif v_context.squad_state_read_version = 'kapiloto-squad-state-read-v1' then
        -- The frozen V1 read ignores Stage 1 trust. service_role may no
        -- longer execute it, so it cannot record new read-v1 forecasts.
        if not has_function_privilege('public.squad_state_inputs_as_of(uuid, uuid, timestamptz, integer)', 'execute') then
          raise exception 'lineup forecast % declares kapiloto-squad-state-read-v1, which this role may no longer record; new lineup forecasts use kapiloto-squad-state-read-v2', new.id;
        end if;
        v_expected := public.squad_state_inputs_as_of(
          new.fixture_id, new.subject_team_id, new.research_cutoff_at, v_context.history_max_fixtures::integer);
      else
        raise exception 'lineup forecast % has unsupported squad-state read version %', new.id, v_context.squad_state_read_version;
      end if;
      if array(select h->>'observation_id' from jsonb_array_elements(v_expected->'history') h order by 1)
        is distinct from array(select i.ledger_observation_id::text from public.prediction_ledger_inputs i
                               where i.snapshot_id = new.id order by 1) then
        raise exception 'lineup forecast % does not freeze exactly the squad history the 1C as-of read returns', new.id;
      end if;
      if array(select m->>'membership_id' from jsonb_array_elements(v_expected->'memberships') m order by 1)
        is distinct from array(select i.membership_id::text from public.prediction_membership_inputs i
                               where i.snapshot_id = new.id order by 1) then
        raise exception 'lineup forecast % does not freeze exactly the memberships the 1C as-of read returns', new.id;
      end if;
      if array(select t->>'tenure_id' from jsonb_array_elements(v_expected->'tenures') t order by 1)
        is distinct from array(select i.tenure_id::text from public.prediction_tenure_inputs i
                               where i.snapshot_id = new.id order by 1) then
        raise exception 'lineup forecast % does not freeze exactly the coach tenures the 1C as-of read returns', new.id;
      end if;
      if array(select coalesce(c->>'resolution_claim_id', c->>'claim_id') || ':' || coalesce(c->>'resolution_id', '')
               from jsonb_array_elements(v_expected->'claims') c order by 1)
        is distinct from array(select i.claim_id::text || ':' || coalesce(i.resolution_id::text, '')
                               from public.prediction_claim_inputs i where i.snapshot_id = new.id order by 1) then
        raise exception 'lineup forecast % does not freeze exactly the target claims and resolutions the 1C as-of read returns', new.id;
      end if;

      -- The frozen squad-state artifact was derived from exactly these links.
      v_state := v_context.squad_state_canonical_json::jsonb;
      if array(select x from jsonb_array_elements_text(v_state->'provenance'->'ledger_observation_ids') x order by 1)
        is distinct from array(select i.ledger_observation_id::text from public.prediction_ledger_inputs i
                               where i.snapshot_id = new.id and i.input_role = 'squad_history_selected' order by 1)
        or array(select x from jsonb_array_elements_text(v_state->'provenance'->'considered_observation_ids') x order by 1)
        is distinct from array(select i.ledger_observation_id::text from public.prediction_ledger_inputs i
                               where i.snapshot_id = new.id order by 1)
        or array(select x from jsonb_array_elements_text(v_state->'provenance'->'membership_ids') x order by 1)
        is distinct from array(select i.membership_id::text from public.prediction_membership_inputs i
                               where i.snapshot_id = new.id order by 1)
        or array(select x from jsonb_array_elements_text(v_state->'provenance'->'tenure_ids') x order by 1)
        is distinct from array(select i.tenure_id::text from public.prediction_tenure_inputs i
                               where i.snapshot_id = new.id order by 1) then
        raise exception 'lineup forecast % input links do not match the provenance of its frozen squad state', new.id;
      end if;

      -- Any stored lineup estimate (predicted, or kept on an abstention) must
      -- describe this fixture, this team and the frozen squad state, and obey
      -- the kapiloto-lineup-output-v1 contract.
      if new.payload ? 'lineup_estimate' then
        if new.payload->'lineup_estimate'->>'fixture_id' is distinct from new.fixture_id::text then
          raise exception 'lineup estimate fixture does not match the snapshot';
        end if;
        if new.payload->'lineup_estimate'->>'subject_team_id' is distinct from new.subject_team_id::text then
          raise exception 'lineup estimate subject team does not match the snapshot';
        end if;
        if new.payload->'lineup_estimate'->>'squad_state_sha256' is distinct from v_context.squad_state_sha256 then
          raise exception 'lineup estimate squad-state hash does not match its frozen context';
        end if;
        if new.outcome = 'predicted' and new.payload->'lineup_estimate'->>'status' is distinct from 'projected' then
          raise exception 'a predicted lineup forecast must carry a projected lineup estimate';
        end if;
        v_issue := private.prediction_lineup_estimate_issue(new.payload->'lineup_estimate');
        if v_issue is not null then
          raise exception 'lineup estimate violates its output contract: %', v_issue;
        end if;
        -- One output player per frozen candidate (none only when the model
        -- refused its parameters).
        if jsonb_array_length(new.payload->'lineup_estimate'->'players') > 0
          and array(select e->>'canonical_player_id' from jsonb_array_elements(new.payload->'lineup_estimate'->'players') e order by 1)
          is distinct from array(select x from jsonb_array_elements_text(v_state->'provenance'->'canonical_player_ids') x order by 1) then
          raise exception 'lineup estimate players are not exactly the frozen squad-state candidates';
        end if;
        -- Every player in the output is bound to the canonical id the model used.
        select (p->>'canonical_player_id')::uuid into v_missing
        from jsonb_array_elements(new.payload->'lineup_estimate'->'players') p
        where p->>'canonical_player_id' is null or not exists (
          select 1 from public.prediction_identity_bindings b
          where b.snapshot_id = new.id and b.player_id = (p->>'canonical_player_id')::uuid
        )
        limit 1;
        if found then
          raise exception 'lineup estimate player % has no identity binding', coalesce(v_missing::text, '(missing id)');
        end if;
      end if;
    elsif v_context.snapshot_id is not null then
      raise exception 'only lineup forecasts carry a squad-state context';
    end if;
  end if;

  if v_hash <> new.input_bundle_sha256 then
    raise exception 'prediction % input links do not match its input bundle hash', new.id;
  end if;
  return null;
end;
$$;

comment on column public.prediction_squad_state_context.squad_state_read_version is
  'Database read that assembled the frozen squad inputs and that the registry re-runs at commit: kapiloto-squad-state-read-v1 (squad_state_inputs_as_of; every pre-existing row, implicit in the canonical bundle) or kapiloto-squad-state-read-v2 (squad_state_inputs_as_of_v2; Stage 1 trusted history, hashed).';
