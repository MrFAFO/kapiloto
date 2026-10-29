-- Kapiloto V4 Foundation 1C: team-player roster membership and the
-- pre-match squad-state input read.
--
-- Additive only. The applied 1A/1B migrations are not modified, no existing
-- table is altered, and nothing in V1/V2/V3 reads these objects.
--
-- Layers kept apart (docs/architecture/KAPILOTO-V4-SQUAD-STATE.md):
--   roster membership   a source asserts player P belongs to team T in an
--                       uncertain date interval (this migration);
--   participation       Match Ledger rows (1A);
--   availability and    target-fixture claims with as-of resolutions (1B);
--   reported lineups
--   squad state         a deterministic, in-memory derivation in
--                       lib/kapiloto-v4/squad-state.ts. Not persisted, and
--                       never an expected-lineup probability.
--
-- Information time follows 1A: first_seen_at is stamped by
-- private.kapiloto_information_clock(), every as-of read filters on it
-- before choosing the latest version, and corrections and retractions are
-- new immutable versions.

-- ---------------------------------------------------------------------------
-- Team-player memberships (immutable, versioned assertions)
-- ---------------------------------------------------------------------------

create table public.team_player_memberships (
  id uuid primary key default gen_random_uuid(),
  contract_version text not null
    check (contract_version in ('kapiloto-team-player-membership-v1')),
  -- Stable identity of one membership across versions. A later version
  -- (end date learned, start corrected, retraction) reuses the key.
  membership_key uuid not null,
  -- Assigned by trigger: 1, 2, 3 ... per membership key.
  membership_version integer not null check (membership_version >= 1),
  team_id uuid not null references public.teams(id) on delete restrict,
  player_id uuid not null references public.players(id) on delete restrict,
  squad_group text not null default 'unknown'
    check (squad_group in ('first_team', 'reserve', 'youth', 'unknown')),
  shirt_number smallint check (shirt_number is null or shirt_number between 0 and 99),
  -- Date uncertainty is an interval; exactly known dates use equal bounds.
  -- Both end bounds are the last day of membership (inclusive) and are null
  -- while the membership is open as far as this version knows.
  starts_on_earliest date not null,
  starts_on_latest date not null,
  ends_on_earliest date,
  ends_on_latest date,
  assertion_status text not null default 'asserted'
    check (assertion_status in ('asserted', 'retracted')),
  source_kind text not null
    check (source_kind in ('provider', 'official_club', 'federation', 'news_report', 'manual')),
  provider text check (provider is null or provider ~ '^[a-z0-9_]{1,40}$'),
  provider_record_id text
    check (provider_record_id is null or char_length(btrim(provider_record_id)) between 1 and 80),
  source_reference text
    check (source_reference is null or char_length(source_reference) <= 500),
  source_fingerprint text
    check (source_fingerprint is null or source_fingerprint ~ '^[0-9a-f]{64}$'),
  document_version_id uuid references public.knowledge_document_versions(id) on delete restrict,
  retrieved_at timestamptz,
  first_seen_at timestamptz not null default now(),
  ingest_version text not null check (char_length(btrim(ingest_version)) between 1 and 80),
  unique (membership_key, membership_version),
  check (starts_on_latest >= starts_on_earliest),
  check ((ends_on_earliest is null) = (ends_on_latest is null)),
  check (ends_on_latest is null or ends_on_latest >= ends_on_earliest),
  check (ends_on_earliest is null or ends_on_earliest >= starts_on_earliest),
  check (source_kind <> 'provider' or provider is not null),
  check (retrieved_at is null or retrieved_at <= first_seen_at + interval '5 minutes')
);

create index team_player_memberships_team_seen_idx
  on public.team_player_memberships (team_id, first_seen_at);

create index team_player_memberships_player_idx
  on public.team_player_memberships (player_id);

-- Versions of one membership are serialized by a per-key lock (READ
-- COMMITTED), so max() + 1 is deterministic. New versions name the
-- surviving canonical player (D-050, shared identity lock), and a key can
-- never move to another team or another person: a later version of a
-- membership first asserted for a since-merged player names its survivor.
create or replace function private.stamp_team_player_membership()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_latest_version integer;
  v_latest_seen timestamptz;
  v_first public.team_player_memberships%rowtype;
  v_document_seen timestamptz;
begin
  perform private.kapiloto_require_read_committed('team player membership writes');
  perform pg_advisory_xact_lock(hashtextextended('kapiloto_membership:' || new.membership_key::text, 0));
  new.first_seen_at := private.kapiloto_information_clock();

  perform private.lock_canonical_identity('players', false);
  if exists (
    select 1 from public.players p
    where p.id = new.player_id and p.identity_status = 'merged'
  ) then
    raise exception 'player % is merged into %; record the surviving canonical id',
      new.player_id, private.surviving_player_id(new.player_id);
  end if;

  if new.document_version_id is not null then
    select v.first_seen_at into v_document_seen
    from public.knowledge_document_versions v where v.id = new.document_version_id;
    if v_document_seen > new.first_seen_at then
      raise exception 'membership information time would precede its source document version';
    end if;
  end if;

  select m.membership_version, m.first_seen_at
    into v_latest_version, v_latest_seen
  from public.team_player_memberships m
  where m.membership_key = new.membership_key
  order by m.membership_version desc
  limit 1;

  if v_latest_version is not null then
    select m.* into v_first
    from public.team_player_memberships m
    where m.membership_key = new.membership_key and m.membership_version = 1;
    if v_first.team_id <> new.team_id
      or private.surviving_player_id(v_first.player_id) <> new.player_id then
      raise exception 'a membership version cannot change its team or player identity';
    end if;
    if new.first_seen_at < v_latest_seen then
      raise exception 'membership information time would precede version %', v_latest_version;
    end if;
    new.membership_version := v_latest_version + 1;
  else
    new.membership_version := 1;
  end if;
  return new;
end;
$$;

create trigger team_player_memberships_stamp
before insert on public.team_player_memberships
for each row execute function private.stamp_team_player_membership();

create trigger team_player_memberships_immutable
before update or delete on public.team_player_memberships
for each row execute function private.kapiloto_v4_reject_change();

create trigger team_player_memberships_no_truncate
before truncate on public.team_player_memberships
for each statement execute function private.kapiloto_v4_reject_change();

-- ---------------------------------------------------------------------------
-- As-of reads
-- ---------------------------------------------------------------------------

-- Memberships of a team as Kapiloto knew them at the cutoff, evaluated for
-- one calendar date:
--   1. versions first seen at or before the cutoff;
--   2. the latest of them per membership key;
--   3. a retracted latest version removes the membership;
--   4. only then the date bounds: 'outside' when the date is before the
--      earliest start or after the latest end; 'certain' when it is on or
--      after the latest start and (open or) on or before the earliest end;
--      otherwise 'possible'. Uncertain dates are never made exact;
--   5. identity is current: observed_player_id is the stored id,
--      canonical_player_id its D-050 survivor.
create or replace function public.team_player_memberships_as_of(
  p_team_id uuid,
  p_cutoff timestamptz,
  p_on_date date
)
returns table (
  membership_id uuid,
  membership_key uuid,
  membership_version integer,
  team_id uuid,
  observed_player_id uuid,
  canonical_player_id uuid,
  squad_group text,
  shirt_number smallint,
  starts_on_earliest date,
  starts_on_latest date,
  ends_on_earliest date,
  ends_on_latest date,
  coverage text,
  source_kind text,
  provider text,
  provider_record_id text,
  source_reference text,
  document_version_id uuid,
  first_seen_at timestamptz
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_team_id is null or p_cutoff is null or p_on_date is null then
    raise exception 'team, cutoff and date are required';
  end if;
  return query
  with ranked as (
    select
      m.*,
      row_number() over (partition by m.membership_key order by m.membership_version desc) as version_rank
    from public.team_player_memberships m
    where m.team_id = p_team_id
      and m.first_seen_at <= p_cutoff
  )
  select
    r.id,
    r.membership_key,
    r.membership_version,
    r.team_id,
    r.player_id,
    coalesce(pl.merged_into_player_id, r.player_id),
    r.squad_group,
    r.shirt_number,
    r.starts_on_earliest,
    r.starts_on_latest,
    r.ends_on_earliest,
    r.ends_on_latest,
    case
      when p_on_date < r.starts_on_earliest
        or (r.ends_on_latest is not null and p_on_date > r.ends_on_latest) then 'outside'
      when p_on_date >= r.starts_on_latest
        and (r.ends_on_earliest is null or p_on_date <= r.ends_on_earliest) then 'certain'
      else 'possible'
    end,
    r.source_kind,
    r.provider,
    r.provider_record_id,
    r.source_reference,
    r.document_version_id,
    r.first_seen_at
  from ranked r
  join public.players pl on pl.id = r.player_id
  where r.version_rank = 1
    and r.assertion_status = 'asserted'
  order by coalesce(pl.merged_into_player_id, r.player_id), r.membership_key;
end;
$$;

-- Raw, cutoff-filtered inputs for one team before one fixture
-- (kapiloto-squad-state-inputs-v1). The pure builder in
-- lib/kapiloto-v4/squad-state.ts derives the squad state from it. Fails
-- closed when the fixture cannot be resolved, the team does not play it, or
-- the cutoff is after the canonical kickoff (actual when known).
--
--   history      every provider's latest visible version (first_seen_at <=
--                cutoff) of the team's finished fixtures that kicked off
--                before the target, withdrawals hidden, the target fixture
--                excluded, limited to the most recent fixtures. One entry
--                per (fixture, provider); the builder selects ONE per
--                fixture. Player ids: observed + current survivor;
--   memberships  team_player_memberships_as_of(team, cutoff, target date);
--   target date  kapiloto-target-date-utc-v1: the UTC calendar date of the
--                canonical kickoff. Deterministic, NOT necessarily the
--                competition-local football date; local time zones are a
--                future schema concern;
--   claims       target-fixture player_availability / expected_lineup claim
--                groups (D-052) known at the cutoff, about a player, for
--                this team or with no team, with the as-of belief;
--   tenures      team_coach_tenures_as_of(team, cutoff).
create or replace function public.squad_state_inputs_as_of(
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
-- Security: server/service_role only
-- ---------------------------------------------------------------------------

alter table public.team_player_memberships enable row level security;
revoke all on table public.team_player_memberships from public, anon, authenticated;

revoke all on function private.stamp_team_player_membership() from public, anon, authenticated;
revoke all on function public.team_player_memberships_as_of(uuid, timestamptz, date) from public, anon, authenticated;
revoke all on function public.squad_state_inputs_as_of(uuid, uuid, timestamptz, integer) from public, anon, authenticated;

grant execute on function public.team_player_memberships_as_of(uuid, timestamptz, date) to service_role;
grant execute on function public.squad_state_inputs_as_of(uuid, uuid, timestamptz, integer) to service_role;

comment on table public.team_player_memberships is
  'Immutable, versioned roster membership assertions (V4 1C): a source says a player belongs to a team within uncertain date bounds. Not squad state, availability or a lineup.';
comment on column public.team_player_memberships.first_seen_at is
  'Information time: clock_timestamp() when the version was written. As-of reads filter on it before choosing the latest version.';
comment on column public.team_player_memberships.ends_on_latest is
  'Bounds of the last day of membership (inclusive). Both end bounds are null while the membership is open as far as this version knows.';
