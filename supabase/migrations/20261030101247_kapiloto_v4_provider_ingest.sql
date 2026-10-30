-- Kapiloto V4 Foundation 1E-A2-A: provider-native Match Ledger ingest (D-056).
--
-- Additive. The applied 1A/1B/1C/1D/1E-A1 migrations are not modified.
-- public.match_ledger_record_observation, the 1A as-of reads, the 1A content
-- hash and first_seen_at are untouched: the ingest RPC below resolves
-- provider identities and then calls the 1A RPC with a canonical payload.
--
-- Identity rules:
--   * canonical teams and competitions are NEVER created here (operator
--     reconciliation, A2-B); only confirmed/manual_override mappings resolve;
--   * a canonical fixture is reused through an authoritative mapping, attached
--     through a unique, unmapped canonical-key match, or minted under an
--     explicit caller mint policy only when no plausible canonical fixture
--     exists (including one already identified with another provider fixture
--     id); anything ambiguous is quarantined;
--   * players are bootstrapped from the provider id (confirmed mapping,
--     mapping_basis = 'provider_native_bootstrap'); unverified mappings
--     quarantine; duplicates are repaired by D-050 merges.
-- No V3 table gains a trigger, constraint or index.

-- ---------------------------------------------------------------------------
-- Player mapping basis
-- ---------------------------------------------------------------------------

alter table public.provider_player_mappings
  add column mapping_basis text
    check (mapping_basis is null or mapping_basis in ('provider_native_bootstrap', 'operator', 'name_resolution'));

comment on column public.provider_player_mappings.mapping_basis is
  'Why the mapping exists: provider_native_bootstrap (the canonical player was created from this provider id, true by construction), operator, or name_resolution. Null for mappings created before D-056.';

-- ---------------------------------------------------------------------------
-- Seeded Sportmonks stat definitions (verified against the Sportmonks v3
-- fixture-statistics and expected-value type references). The three xG
-- concepts are separate keys and never collapse into expected_goals.
-- ---------------------------------------------------------------------------

insert into public.match_ledger_stat_definitions
  (provider, provider_stat_type, provider_stat_name, definition_version, stat_key, unit, description)
values
  ('sportmonks', '5304', 'EXPECTED_GOALS', 'sm-2024-08', 'expected_goals', 'expected_goals',
   'Sportmonks expected goals (xG) for the team, full match. Type 5304.'),
  ('sportmonks', '5305', 'EXPECTED_GOALS_ON_TARGET', 'sm-2024-08', 'expected_goals_on_target', 'expected_goals',
   'Sportmonks expected goals on target (xGoT) for the team, full match. Type 5305.'),
  ('sportmonks', '7943', 'EXPECTED_NON_PENALTY_GOALS', 'sm-2024-08', 'expected_non_penalty_goals', 'expected_goals',
   'Sportmonks expected non-penalty goals (npxG) for the team, full match. Type 7943.'),
  ('sportmonks', '42', 'SHOTS_TOTAL', 'sm-2024-08', 'shots_total', 'count',
   'Sportmonks total shots for the team, full match. Type 42.'),
  ('sportmonks', '86', 'SHOTS_ON_TARGET', 'sm-2024-08', 'shots_on_target', 'count',
   'Sportmonks shots on target for the team, full match. Type 86.'),
  ('sportmonks', '45', 'BALL_POSSESSION', 'sm-2024-08', 'possession_pct', 'percent',
   'Sportmonks ball possession percentage for the team, full match. Type 45.'),
  ('sportmonks', '34', 'CORNERS', 'sm-2024-08', 'corners', 'count',
   'Sportmonks corners for the team, full match. Type 34.');

-- ---------------------------------------------------------------------------
-- Ingest audit: immutable runs and append-only attempts
-- ---------------------------------------------------------------------------

create table public.provider_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  purpose text not null check (purpose in ('backfill', 'test')),
  ingest_version text not null check (char_length(btrim(ingest_version)) between 1 and 80),
  entitlement_snapshot_sha256 text
    check (entitlement_snapshot_sha256 is null or entitlement_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  scope jsonb not null default '{}'::jsonb
    check (jsonb_typeof(scope) = 'object' and octet_length(scope::text) <= 65536),
  fixture_mint_kickoff_before timestamptz,
  created_at timestamptz not null default now()
);

create table public.provider_ingest_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.provider_ingest_runs(id) on delete restrict,
  provider text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_fixture_id text not null check (char_length(btrim(provider_fixture_id)) between 1 and 80),
  attempt_no integer not null check (attempt_no >= 1),
  status text not null check (status in ('recorded', 'unchanged', 'quarantined', 'failed')),
  reason_code text check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_]{1,62}$'),
  observation_id uuid references public.match_ledger_observations(id) on delete restrict,
  -- Soft reference: an immutable audit row must never block V3 from deleting a fixture.
  fixture_id uuid,
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 16384),
  created_at timestamptz not null default now(),
  unique (run_id, provider, provider_fixture_id, attempt_no),
  check ((status in ('quarantined', 'failed')) = (reason_code is not null)),
  check (status not in ('recorded', 'unchanged') or observation_id is not null)
);

create index provider_ingest_items_fixture_idx
  on public.provider_ingest_items (run_id, provider_fixture_id, attempt_no desc);

-- ---------------------------------------------------------------------------
-- Observation annotations: identity-critical provider refs and family fetch
-- status. Sealed to the statement that wrote the observation version and
-- immutable, so they can never drift from the version they describe.
-- ---------------------------------------------------------------------------

create table public.match_ledger_observation_provider_refs (
  observation_id uuid not null references public.match_ledger_observations(id) on delete restrict,
  ref_kind text not null check (ref_kind in ('league', 'season', 'team_home', 'team_away')),
  provider_ref text not null check (char_length(btrim(provider_ref)) between 1 and 80),
  primary key (observation_id, ref_kind)
);

create index match_ledger_observation_provider_refs_ref_idx
  on public.match_ledger_observation_provider_refs (ref_kind, provider_ref);

-- A failed fetch is never persisted (the ingest RPC quarantines it).
create table public.match_ledger_observation_family_fetches (
  observation_id uuid not null references public.match_ledger_observations(id) on delete restrict,
  family text not null check (family in ('lineups', 'formations', 'statistics', 'xg')),
  fetch_status text not null check (fetch_status in ('fetched', 'not_requested')),
  primary key (observation_id, family)
);

create or replace function private.seal_match_ledger_observation_annotation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_observation public.match_ledger_observations%rowtype;
begin
  select o.* into v_observation from public.match_ledger_observations o where o.id = new.observation_id;
  if not found then
    raise exception 'match ledger observation % not found', new.observation_id;
  end if;
  if v_observation.observation_kind <> 'observation' then
    raise exception '% rows describe observations only', tg_table_name;
  end if;
  if v_observation.ingest_statement_at <> statement_timestamp() then
    raise exception 'match ledger observation % is sealed', new.observation_id;
  end if;
  return new;
end;
$$;

create trigger match_ledger_observation_provider_refs_seal
before insert on public.match_ledger_observation_provider_refs
for each row execute function private.seal_match_ledger_observation_annotation();

create trigger match_ledger_observation_family_fetches_seal
before insert on public.match_ledger_observation_family_fetches
for each row execute function private.seal_match_ledger_observation_annotation();

-- ---------------------------------------------------------------------------
-- Minted fixtures: which canonical fixtures the ingest RPC created, under
-- which caller mint policy (V4-side provenance; V3's fixtures table is not
-- altered).
-- ---------------------------------------------------------------------------

create table public.match_ledger_fixture_mints (
  fixture_id uuid primary key references public.fixtures(id) on delete restrict,
  provider text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_fixture_id text not null check (char_length(btrim(provider_fixture_id)) between 1 and 80),
  run_id uuid references public.provider_ingest_runs(id) on delete restrict,
  kickoff_before timestamptz not null,
  minted_at timestamptz not null,
  unique (provider, provider_fixture_id)
);

create or replace function private.stamp_match_ledger_fixture_mint()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.minted_at := private.kapiloto_information_clock();
  if not exists (
    select 1 from public.provider_fixture_mappings m
    where m.provider = new.provider
      and m.provider_fixture_id = new.provider_fixture_id
      and m.fixture_id = new.fixture_id
  ) then
    raise exception 'a minted fixture needs its provider fixture mapping';
  end if;
  return new;
end;
$$;

create trigger match_ledger_fixture_mints_stamp
before insert on public.match_ledger_fixture_mints
for each row execute function private.stamp_match_ledger_fixture_mint();

-- Immutability.
create trigger provider_ingest_runs_immutable
before update or delete on public.provider_ingest_runs
for each row execute function private.kapiloto_v4_reject_change();
create trigger provider_ingest_runs_no_truncate
before truncate on public.provider_ingest_runs
for each statement execute function private.kapiloto_v4_reject_change();
create trigger provider_ingest_items_immutable
before update or delete on public.provider_ingest_items
for each row execute function private.kapiloto_v4_reject_change();
create trigger provider_ingest_items_no_truncate
before truncate on public.provider_ingest_items
for each statement execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_observation_provider_refs_immutable
before update or delete on public.match_ledger_observation_provider_refs
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_observation_provider_refs_no_truncate
before truncate on public.match_ledger_observation_provider_refs
for each statement execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_observation_family_fetches_immutable
before update or delete on public.match_ledger_observation_family_fetches
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_observation_family_fetches_no_truncate
before truncate on public.match_ledger_observation_family_fetches
for each statement execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_fixture_mints_immutable
before update or delete on public.match_ledger_fixture_mints
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_fixture_mints_no_truncate
before truncate on public.match_ledger_fixture_mints
for each statement execute function private.kapiloto_v4_reject_change();

create index match_ledger_observations_provider_capture_idx
  on public.match_ledger_observations (provider, capture_mode, fixture_id, observation_version);

-- ---------------------------------------------------------------------------
-- Ingest result + optional audit item (caller holds the provider-fixture lock)
-- ---------------------------------------------------------------------------

create or replace function private.provider_ingest_result(
  p_run_id uuid,
  p_provider text,
  p_provider_fixture_id text,
  p_status text,
  p_reason_code text,
  p_fixture_id uuid,
  p_observation_id uuid,
  p_detail jsonb,
  p_extra jsonb,
  p_capture_quality_flags jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_run public.provider_ingest_runs%rowtype;
  v_attempt integer;
begin
  -- Capture quality flags are per-attempt audit metadata, never ledger content.
  if p_run_id is not null then
    select r.* into v_run from public.provider_ingest_runs r where r.id = p_run_id;
    if not found then
      raise exception 'provider ingest run % not found', p_run_id;
    end if;
    if v_run.provider <> p_provider then
      raise exception 'provider ingest run % belongs to provider %', p_run_id, v_run.provider;
    end if;
    select coalesce(max(i.attempt_no), 0) + 1 into v_attempt
    from public.provider_ingest_items i
    where i.run_id = p_run_id and i.provider = p_provider and i.provider_fixture_id = p_provider_fixture_id;
    insert into public.provider_ingest_items
      (run_id, provider, provider_fixture_id, attempt_no, status, reason_code, observation_id, fixture_id, detail)
    values
      (p_run_id, p_provider, p_provider_fixture_id, v_attempt, p_status, p_reason_code, p_observation_id, p_fixture_id,
       coalesce(p_detail, '{}'::jsonb)
         || case when p_capture_quality_flags is null then '{}'::jsonb
                 else jsonb_build_object('capture_quality_flags', p_capture_quality_flags) end);
  end if;
  return jsonb_build_object(
    'status', p_status,
    'reason_code', p_reason_code,
    'fixture_id', p_fixture_id,
    'observation_id', p_observation_id,
    'attempt_no', v_attempt
  ) || coalesce(p_extra, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- public.match_ledger_ingest_provider_fixture (kapiloto-provider-match-observation-v1)
--
-- Phase 1 decides read-only and quarantines without writing anything but the
-- optional audit item. Phase 2 writes (attach/mint, players, the 1A ledger
-- write, annotations). Any exception aborts the whole call.
--
-- Global lock order (every ingest, every path):
--   1. 1A provider-fixture advisory lock (exclusive);
--   2. the competition mapping row, FOR SHARE;
--   3. both team mapping rows in ONE statement, ordered by provider_team_id
--      COLLATE "C" (independent of home/away), FOR SHARE;
--   4. the incoming provider fixture mapping row, if it exists, FOR SHARE;
--   5. only without that mapping: the unordered canonical team-pair advisory
--      lock (exclusive), then every existing mapping row of this provider on a
--      candidate fixture, ordered by provider_fixture_id COLLATE "C", FOR SHARE;
--      (attach/mint writes follow; their foreign-key checks take the standard
--      FOR KEY SHARE on the referenced competition, team and fixture rows)
--   6. 1A fixture/provider advisory lock (exclusive);
--   7. players identity advisory lock (exclusive).
-- FOR SHARE is the weakest row lock that conflicts with FOR NO KEY UPDATE and
-- FOR UPDATE, i.e. with every UPDATE (including INSERT ... ON CONFLICT DO
-- UPDATE) and DELETE of the row, so V3 cannot repoint or re-status a mapping
-- this call resolved until it commits. FOR KEY SHARE would not do: team_id,
-- competition_id and mapping_status are not key columns, and an UPDATE of
-- non-key columns takes only FOR NO KEY UPDATE, which FOR KEY SHARE allows.
-- FOR SHARE locks never conflict with each other, so concurrent ingests never
-- wait on mapping rows.
-- ---------------------------------------------------------------------------

create or replace function public.match_ledger_ingest_provider_fixture(p_observation jsonb)
returns jsonb
language plpgsql
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v record;
  v_fam jsonb;
  v_mint jsonb;
  v_now timestamptz := private.kapiloto_information_clock();
  v_competition uuid;
  v_home uuid;
  v_away uuid;
  v_fixture public.fixtures%rowtype;
  v_fixture_id uuid;
  v_resolution text;
  v_map_fixture uuid;
  v_map_status text;
  v_n integer;
  v_w integer;
  v_p integer;
  v_u integer;
  v_r integer;
  v_x integer;
  v_same integer;
  v_conflict integer;
  v_conflict_ids jsonb;
  v_candidates jsonb;
  v_candidate uuid;
  v_flags jsonb;
  v_latest public.match_ledger_observations%rowtype;
  v_prior_refs jsonb;
  v_prior_families jsonb;
  v_payload_refs jsonb;
  v_family_upgrade boolean := false;
  v_refs_status text := 'recorded';
  v_players jsonb := '[]'::jsonb;
  v_stats jsonb;
  v_teams jsonb;
  v_minted integer := 0;
  v_ledger jsonb;
  v_result jsonb;
  v_quarantine text;
  v_player uuid;
  v_player_status text;
  v_name text;
  v_competition_status text;
  v_team record;
  r record;
begin
  if p_observation is null or jsonb_typeof(p_observation) <> 'object' then
    raise exception 'provider match observation must be a JSON object';
  end if;
  if p_observation->>'contract_version' is distinct from 'kapiloto-provider-match-observation-v1' then
    raise exception 'unsupported provider match observation contract';
  end if;
  perform private.kapiloto_v4_assert_keys(p_observation, array[
    'contract_version', 'provider', 'provider_fixture_id', 'provider_league_id', 'provider_season_id',
    'provider_home_team_id', 'provider_away_team_id', 'capture_mode', 'ingest_version',
    'provider_endpoint', 'raw_payload_sha256', 'retrieved_at', 'kickoff_at', 'match_status',
    'neutral_venue', 'home_goals_90', 'away_goals_90', 'home_goals_aet', 'away_goals_aet',
    'home_penalties', 'away_penalties', 'teams', 'players', 'team_stats', 'family_fetches',
    'family_response_sha256', 'fixture_mint', 'run_id', 'capture_quality_flags'
  ], 'provider match observation');
  perform private.kapiloto_v4_assert_keys(p_observation->'teams',
    array['side', 'formation_nominal', 'lineup_status', 'statistics_status'], 'provider observation team');
  perform private.kapiloto_v4_assert_keys(coalesce(p_observation->'players', '[]'::jsonb), array[
    'side', 'provider_player_id', 'provider_player_name', 'lineup_role', 'appeared', 'position_code',
    'formation_position', 'formation_field', 'shirt_number'
  ], 'provider observation player');
  perform private.kapiloto_v4_assert_keys(coalesce(p_observation->'team_stats', '[]'::jsonb),
    array['side', 'family', 'provider_stat_type', 'definition_version', 'value'], 'provider observation stat');
  perform private.kapiloto_v4_assert_keys(p_observation->'family_fetches',
    array['lineups', 'formations', 'statistics', 'xg'], 'family fetches');
  perform private.kapiloto_v4_assert_keys(coalesce(p_observation->'family_response_sha256', '{}'::jsonb),
    array['lineups', 'formations', 'statistics', 'xg'], 'family response hashes');
  perform private.kapiloto_v4_assert_keys(coalesce(p_observation->'fixture_mint', '{}'::jsonb),
    array['allowed', 'kickoff_before'], 'fixture mint policy');

  select * into v
  from jsonb_to_record(p_observation) as h(
    provider text, provider_fixture_id text, provider_league_id text, provider_season_id text,
    provider_home_team_id text, provider_away_team_id text, capture_mode text, ingest_version text,
    provider_endpoint text, raw_payload_sha256 text, retrieved_at timestamptz, kickoff_at timestamptz,
    match_status text, neutral_venue boolean, home_goals_90 smallint, away_goals_90 smallint,
    home_goals_aet smallint, away_goals_aet smallint, home_penalties smallint, away_penalties smallint,
    run_id uuid
  );
  if v.provider is null or v.provider_fixture_id is null or v.provider_league_id is null
    or v.provider_season_id is null or v.provider_home_team_id is null or v.provider_away_team_id is null
    or v.kickoff_at is null or v.match_status is null or v.capture_mode is null
    or v.ingest_version is null or v.retrieved_at is null then
    raise exception 'provider match observation is missing required header fields';
  end if;
  if v.provider_home_team_id = v.provider_away_team_id then
    raise exception 'provider home and away team ids must differ';
  end if;
  if jsonb_typeof(p_observation->'teams') is distinct from 'array'
    or jsonb_array_length(p_observation->'teams') <> 2
    or (select count(distinct t->>'side') from jsonb_array_elements(p_observation->'teams') t
        where t->>'side' in ('home', 'away')) <> 2 then
    raise exception 'a provider match observation describes exactly one home and one away team';
  end if;
  v_fam := p_observation->'family_fetches';
  if jsonb_typeof(v_fam) is distinct from 'object'
    or (select count(*) from jsonb_each_text(v_fam) f where f.value in ('fetched', 'not_requested', 'failed')) <> 4 then
    raise exception 'family_fetches must give lineups, formations, statistics and xg a fetch status';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(coalesce(p_observation->'team_stats', '[]'::jsonb)) as s(family text)
    where s.family is null or s.family not in ('statistics', 'xg') or v_fam->>s.family <> 'fetched'
  ) then
    raise exception 'team stats must come from a fetched statistics or xg family';
  end if;
  -- Recoverable capture issues the parser normalized away. Audit only: they
  -- never reach the 1A payload, the content hash or a new version.
  v_flags := p_observation->'capture_quality_flags';
  if jsonb_typeof(v_flags) is distinct from 'array' or jsonb_array_length(v_flags) > 32
    or exists (
      select 1 from jsonb_array_elements(v_flags) e(flag)
      where jsonb_typeof(e.flag) <> 'string'
        or (e.flag #>> '{}') not in ('duplicate_formation_position', 'duplicate_shirt_number', 'formation_invalid', 'lineup_role_unknown', 'stat_type_outside_family', 'stat_value_null', 'stats_not_separable_extra_time')
    ) then
    raise exception 'capture_quality_flags must be an array of at most 32 known capture quality flags';
  end if;
  select coalesce(jsonb_agg(distinct e.flag order by e.flag), '[]'::jsonb) into v_flags
  from jsonb_array_elements_text(v_flags) e(flag);
  v_payload_refs := jsonb_build_object(
    'league', v.provider_league_id, 'season', v.provider_season_id,
    'team_home', v.provider_home_team_id, 'team_away', v.provider_away_team_id
  );

  perform private.kapiloto_require_read_committed('provider ingest');
  perform pg_advisory_xact_lock(hashtextextended(
    'kapiloto_match_ledger_provider_fixture:' || v.provider || ':' || v.provider_fixture_id, 0
  ));

  -- ---------------------------------------------------------------- phase 1
  -- A failed fetch is retried or re-captured as not_requested, never frozen.
  if exists (select 1 from jsonb_each_text(v_fam) f where f.value = 'failed') then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'family_fetch_failed', null, null, jsonb_build_object('family_fetches', v_fam), null, v_flags);
  end if;
  if v.match_status <> 'finished' then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'not_finished', null, null, jsonb_build_object('match_status', v.match_status), null, v_flags);
  end if;
  -- The 1A ledger refuses a finished observation first seen within 105
  -- minutes of kickoff; a provider claiming that is data, not a crash.
  if v.kickoff_at + interval '105 minutes' > v_now then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'finished_too_early', null, null, jsonb_build_object('kickoff_at', v.kickoff_at), null, v_flags);
  end if;

  -- Identity mappings are V3 rows that V3 may upsert at any time: each row
  -- used to resolve identity is locked FOR SHARE until commit (see the
  -- global lock order above), then its state is checked.
  select m.competition_id, m.mapping_status into v_competition, v_competition_status
  from public.provider_competition_mappings m
  where m.provider = v.provider and m.provider_competition_id = v.provider_league_id
  for share;
  if v_competition is null or v_competition_status not in ('confirmed', 'manual_override') then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'competition_unmapped', null, null, jsonb_build_object('provider_league_id', v.provider_league_id), null, v_flags);
  end if;
  -- Both team rows in one statement, locked in provider_team_id order, so
  -- home=A/away=B and home=B/away=A acquire them identically (LockRows runs
  -- above the Sort). Home and away are derived from the locked rows.
  for v_team in
    select m.provider_team_id, m.team_id, m.mapping_status
    from public.provider_team_mappings m
    where m.provider = v.provider
      and m.provider_team_id in (v.provider_home_team_id, v.provider_away_team_id)
    order by m.provider_team_id collate "C"
    for share
  loop
    if v_team.mapping_status in ('confirmed', 'manual_override') then
      if v_team.provider_team_id = v.provider_home_team_id then
        v_home := v_team.team_id;
      else
        v_away := v_team.team_id;
      end if;
    end if;
  end loop;
  if v_home is null or v_away is null then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'team_unmapped', null, null,
      jsonb_build_object('home_mapped', v_home is not null, 'away_mapped', v_away is not null), null, v_flags);
  end if;
  if v_home = v_away then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'team_identity_conflict', null, null, '{}'::jsonb, null, v_flags);
  end if;

  -- Unverified player mappings are never trusted, promoted or bypassed.
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_observation->'players', '[]'::jsonb)) as x(provider_player_id text)
    join public.provider_player_mappings m
      on m.provider = v.provider and m.provider_player_id = x.provider_player_id
    where m.mapping_status = 'unverified'
  ) then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'player_mapping_unverified', null, null, '{}'::jsonb, null, v_flags);
  end if;

  -- Fixture: an existing mapping of THIS provider fixture id wins when it is
  -- authoritative and consistent. Otherwise every canonical fixture of the
  -- same two teams is a candidate, including fixtures already identified with
  -- another provider fixture id: those never disappear from the decision.
  select m.fixture_id, m.mapping_status into v_map_fixture, v_map_status
  from public.provider_fixture_mappings m
  where m.provider = v.provider and m.provider_fixture_id = v.provider_fixture_id
  for share;
  if v_map_fixture is not null then
    if v_map_status = 'unverified' then
      return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
        'fixture_mapping_unverified', v_map_fixture, null, '{}'::jsonb, null, v_flags);
    end if;
    select f.* into v_fixture from public.fixtures f where f.id = v_map_fixture;
    if v_fixture.home_team_id <> v_home or v_fixture.away_team_id <> v_away
      or (v_fixture.competition_id is not null and v_fixture.competition_id <> v_competition) then
      return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
        'fixture_mapping_conflict', v_map_fixture, null, '{}'::jsonb, null, v_flags);
    end if;
    v_fixture_id := v_map_fixture;
    v_resolution := 'existing_mapping';
  else
    -- One lock per UNORDERED canonical team pair, taken before the candidate
    -- query and held to commit: every attach or mint for these two teams, in
    -- any competition or orientation, happens under it. Under READ COMMITTED
    -- the query below is a new statement, so it sees every mapping or minted
    -- fixture committed by an earlier holder.
    perform pg_advisory_xact_lock(hashtextextended(
      'kapiloto_canonical_fixture_pair:' || least(v_home, v_away)::text || ':' || greatest(v_home, v_away)::text, 0
    ));
    -- Existing mapping rows of this provider on candidate fixtures are the
    -- identity-conflict evidence: stabilize them (deterministic order). A
    -- mapping row inserted later by a non-ingest writer has nothing to lock;
    -- see the residual-concurrency notes in KAPILOTO-V4-PROVIDER-INGEST.md.
    perform 1
    from public.provider_fixture_mappings m
    join public.fixtures f on f.id = m.fixture_id
    where m.provider = v.provider
      and ((f.home_team_id = v_home and f.away_team_id = v_away)
          or (f.home_team_id = v_away and f.away_team_id = v_home))
      and f.kickoff_at between v.kickoff_at - interval '180 days' and v.kickoff_at + interval '180 days'
    order by m.provider_fixture_id collate "C"
    for share of m;
    with pair as (
      select
        f.id,
        f.competition_id,
        f.status,
        f.home_team_id = v_home as same_orientation,
        abs(extract(epoch from (f.kickoff_at - v.kickoff_at))) as gap,
        m.provider_fixture_id as mapped_id,
        -- Identified with another provider fixture id: mapped to it (any
        -- mapping status), or its latest ledger version for this provider
        -- is an observation of it.
        case
          when m.provider_fixture_id is not null and m.provider_fixture_id <> v.provider_fixture_id then m.provider_fixture_id
          when lo.observation_kind = 'observation' and lo.provider_fixture_id <> v.provider_fixture_id then lo.provider_fixture_id
        end as other_id
      from public.fixtures f
      left join public.provider_fixture_mappings m
        on m.fixture_id = f.id and m.provider = v.provider
      left join lateral (
        select o.provider_fixture_id, o.observation_kind
        from public.match_ledger_observations o
        where o.fixture_id = f.id and o.provider = v.provider
        order by o.observation_version desc
        limit 1
      ) lo on true
      where ((f.home_team_id = v_home and f.away_team_id = v_away)
          or (f.home_team_id = v_away and f.away_team_id = v_home))
        and f.kickoff_at between v.kickoff_at - interval '180 days' and v.kickoff_at + interval '180 days'
    ),
    guarded as (
      -- N: attach window. R: reversed orientation within 48 h (teams never
      -- meet twice in 48 h; two-legged ties are further apart). X: another
      -- known competition within 48 h. U: unknown competition within 14 days.
      -- P: postponed-like within 180 days. W: same competition within 14 days.
      select pr.*,
        case
          when not pr.same_orientation then case when pr.gap <= 48 * 3600 then 'R' end
          when pr.competition_id = v_competition and pr.gap <= 48 * 3600 then 'N'
          when pr.competition_id is null then case when pr.gap <= 14 * 86400 then 'U' end
          when pr.competition_id <> v_competition then case when pr.gap <= 48 * 3600 then 'X' end
          when pr.status in ('postponed', 'suspended', 'cancelled', 'under_review') then 'P'
          when pr.gap <= 14 * 86400 then 'W'
        end as guard
      from pair pr
    )
    select
      count(*) filter (where g.mapped_id = v.provider_fixture_id),
      count(*) filter (where g.guard is not null and g.other_id is not null),
      count(*) filter (where g.guard = 'N'),
      count(*) filter (where g.guard = 'W'),
      count(*) filter (where g.guard = 'P'),
      count(*) filter (where g.guard = 'U'),
      count(*) filter (where g.guard = 'R'),
      count(*) filter (where g.guard = 'X'),
      (array_agg(g.id) filter (where g.guard = 'N'))[1],
      coalesce(jsonb_agg(distinct g.other_id) filter (where g.guard is not null and g.other_id is not null), '[]'::jsonb)
    into v_same, v_conflict, v_n, v_w, v_p, v_u, v_r, v_x, v_candidate, v_conflict_ids
    from guarded g;
    v_candidates := jsonb_build_object(
      'attach_window', v_n, 'reschedule_window', v_w, 'postponement_window', v_p,
      'unknown_competition', v_u, 'reversed_orientation', v_r, 'other_competition', v_x,
      'provider_identity_conflicts', v_conflict, 'conflicting_provider_fixture_ids', v_conflict_ids
    );

    if v_same > 0 then
      -- The primary lookup found no mapping but a candidate carries one for
      -- this very provider fixture id (a concurrent non-ingest writer).
      return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
        'fixture_mapping_conflict', null, null, v_candidates, null, v_flags);
    elsif v_conflict > 0 or v_n > 1 or v_r > 0 or v_x > 0 or v_u > 0 or v_p > 0 or v_w > 0 then
      return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
        case
          when v_conflict > 0 then 'fixture_provider_identity_conflict'
          when v_n > 1 then 'fixture_candidate_ambiguous'
          when v_r > 0 then 'fixture_orientation_conflict'
          when v_x > 0 then 'fixture_competition_conflict'
          when v_u > 0 then 'fixture_competition_unknown'
          when v_p > 0 then 'fixture_possible_postponement'
          else 'fixture_possible_reschedule'
        end,
        null, null, v_candidates, null, v_flags);
    elsif v_n = 1 then
      -- The single candidate carries no identity of this provider (v_conflict = 0, v_same = 0).
      v_fixture_id := v_candidate;
      v_resolution := 'attached';
    else
      v_mint := coalesce(p_observation->'fixture_mint', '{}'::jsonb);
      -- A run that records a mint bound caps every item's bound.
      if v.run_id is not null and v_mint->>'kickoff_before' is not null and exists (
        select 1 from public.provider_ingest_runs run
        where run.id = v.run_id
          and run.fixture_mint_kickoff_before is not null
          and (v_mint->>'kickoff_before')::timestamptz > run.fixture_mint_kickoff_before
      ) then
        raise exception 'fixture mint bound exceeds the bound recorded on ingest run %', v.run_id;
      end if;
      if jsonb_typeof(v_mint->'allowed') is distinct from 'boolean'
        or not (v_mint->>'allowed')::boolean
        or v_mint->>'kickoff_before' is null
        or v.kickoff_at >= (v_mint->>'kickoff_before')::timestamptz then
        return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
          'fixture_mint_not_permitted', null, null, jsonb_build_object('fixture_mint', v_mint), null, v_flags);
      end if;
      v_resolution := 'minted';
    end if;
  end if;

  -- Provider-ref and family-status drift against the latest version (a
  -- withdrawal resets: the next observation is a new attachment).
  if v_fixture_id is not null then
    select o.* into v_latest
    from public.match_ledger_observations o
    where o.fixture_id = v_fixture_id and o.provider = v.provider
    order by o.observation_version desc
    limit 1;
    if found and v_latest.observation_kind = 'observation' then
      -- A mapping re-pointed to this provider fixture id (e.g. by a V3 upsert)
      -- must not silently continue another provider fixture's version chain.
      if v_latest.provider_fixture_id <> v.provider_fixture_id then
        return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
          'provider_fixture_id_drift', v_fixture_id, v_latest.id,
          jsonb_build_object('recorded_provider_fixture_id', v_latest.provider_fixture_id), null, v_flags);
      end if;
      select jsonb_object_agg(pr.ref_kind, pr.provider_ref) into v_prior_refs
      from public.match_ledger_observation_provider_refs pr where pr.observation_id = v_latest.id;
      select jsonb_object_agg(ff.family, ff.fetch_status) into v_prior_families
      from public.match_ledger_observation_family_fetches ff where ff.observation_id = v_latest.id;
      if v_prior_refs is null or v_prior_families is null then
        return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
          'provider_refs_unrecorded', v_fixture_id, v_latest.id, '{}'::jsonb,
          jsonb_build_object('provider_refs_status', 'unrecorded'), v_flags);
      end if;
      if v_prior_refs <> v_payload_refs then
        return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
          'provider_ref_drift', v_fixture_id, v_latest.id,
          jsonb_build_object('recorded', v_prior_refs, 'payload', v_payload_refs),
          jsonb_build_object('provider_refs_status', 'drift'), v_flags);
      end if;
      if exists (
        select 1 from jsonb_each_text(v_prior_families) pf
        where pf.value = 'fetched' and v_fam->>pf.key = 'not_requested'
      ) then
        return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
          'family_status_downgrade', v_fixture_id, v_latest.id,
          jsonb_build_object('recorded', v_prior_families, 'payload', v_fam), null, v_flags);
      end if;
      v_family_upgrade := v_prior_families <> v_fam;
      v_refs_status := 'matched';
    end if;
  end if;

  -- ---------------------------------------------------------------- phase 2
  begin
    if v_resolution = 'attached' then
      insert into public.provider_fixture_mappings
        (fixture_id, round_game_id, provider, provider_fixture_id, mapping_status, mapping_confidence, mapped_at)
      values (v_fixture_id, null, v.provider, v.provider_fixture_id, 'confirmed', 1, v_now);
    elsif v_resolution = 'minted' then
      insert into public.fixtures
        (competition_id, home_team_id, away_team_id, neutral_venue, kickoff_at, status, home_score, away_score)
      values (v_competition, v_home, v_away, coalesce(v.neutral_venue, false), v.kickoff_at, 'finished',
              v.home_goals_90, v.away_goals_90)
      returning id into v_fixture_id;
      insert into public.provider_fixture_mappings
        (fixture_id, round_game_id, provider, provider_fixture_id, mapping_status, mapping_confidence, mapped_at)
      values (v_fixture_id, null, v.provider, v.provider_fixture_id, 'confirmed', 1, v_now);
      insert into public.match_ledger_fixture_mints (fixture_id, provider, provider_fixture_id, run_id, kickoff_before)
      values (v_fixture_id, v.provider, v.provider_fixture_id, v.run_id, (v_mint->>'kickoff_before')::timestamptz);
    end if;

    perform private.lock_match_ledger_fixture(v.provider, v.provider_fixture_id, v_fixture_id);
    perform private.lock_canonical_identity('players', true);

    for r in
      select *
      from jsonb_to_recordset(coalesce(p_observation->'players', '[]'::jsonb)) as x(
        side text, provider_player_id text, provider_player_name text, lineup_role text, appeared boolean,
        position_code text, formation_position smallint, formation_field text, shirt_number smallint
      )
    loop
      if r.provider_player_id is null or r.side not in ('home', 'away') then
        raise exception 'provider observation players need a side and a provider player id';
      end if;
      v_player := null;
      select m.player_id, m.mapping_status into v_player, v_player_status
      from public.provider_player_mappings m
      where m.provider = v.provider and m.provider_player_id = r.provider_player_id;
      if v_player is not null then
        if v_player_status = 'unverified' then
          raise exception 'provider player mapping % is unverified', r.provider_player_id;
        end if;
        v_player := private.surviving_player_id(v_player);
      else
        v_name := nullif(btrim(coalesce(r.provider_player_name, '')), '');
        insert into public.players (canonical_name)
        values (coalesce(left(v_name, 160), 'Sportmonks player ' || r.provider_player_id))
        returning id into v_player;
        insert into public.provider_player_mappings
          (provider, provider_player_id, player_id, provider_name, mapping_status, mapping_confidence, mapping_basis)
        values (v.provider, r.provider_player_id, v_player, v_name, 'confirmed', 1, 'provider_native_bootstrap');
        if v_name is not null then
          insert into public.player_aliases (player_id, alias, alias_kind, provider, source)
          values (v_player, left(v_name, 160), 'provider_spelling', v.provider, v.provider || '_bootstrap')
          on conflict do nothing;
        end if;
        v_minted := v_minted + 1;
      end if;
      v_players := v_players || jsonb_build_array(jsonb_build_object(
        'team_id', case when r.side = 'home' then v_home else v_away end,
        'player_id', v_player,
        'provider_player_id', r.provider_player_id,
        'provider_player_name', r.provider_player_name,
        'lineup_role', r.lineup_role,
        'appeared', r.appeared,
        'position_code', r.position_code,
        'provider_position', null,
        'formation_position', r.formation_position,
        'formation_field', r.formation_field,
        'shirt_number', r.shirt_number,
        'is_captain', null,
        'minutes_played', null,
        'entered_minute', null,
        'exited_minute', null,
        'data_completeness', 'partial'
      ));
    end loop;

    if exists (
      select 1
      from jsonb_to_recordset(coalesce(p_observation->'team_stats', '[]'::jsonb)) as s(provider_stat_type text, definition_version text)
      where not exists (
        select 1 from public.match_ledger_stat_definitions d
        where d.provider = v.provider and d.provider_stat_type = s.provider_stat_type
          and d.definition_version = s.definition_version
      )
    ) then
      raise exception 'provider observation references an unknown stat definition';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'team_id', case when s.side = 'home' then v_home else v_away end,
      'stat_definition_id', d.id,
      'period', 'full_time',
      'value', s.value
    ) order by s.side, d.stat_key), '[]'::jsonb)
    into v_stats
    from jsonb_to_recordset(coalesce(p_observation->'team_stats', '[]'::jsonb)) as s(
      side text, provider_stat_type text, definition_version text, value numeric
    )
    join public.match_ledger_stat_definitions d
      on d.provider = v.provider and d.provider_stat_type = s.provider_stat_type
     and d.definition_version = s.definition_version;

    select jsonb_agg(jsonb_build_object(
      'team_id', case when t.side = 'home' then v_home else v_away end,
      'side', t.side,
      'coach_id', null,
      'provider_coach_id', null,
      'provider_coach_name', null,
      'formation_nominal', t.formation_nominal,
      'lineup_status', t.lineup_status,
      'substitutions_status', 'not_provided',
      'events_status', 'not_provided',
      'statistics_status', t.statistics_status
    ))
    into v_teams
    from jsonb_to_recordset(p_observation->'teams') as t(
      side text, formation_nominal text, lineup_status text, statistics_status text
    );

    v_ledger := jsonb_build_object(
      'contract_version', 'kapiloto-match-ledger-observation-v1',
      'observation_kind', 'observation',
      'fixture_id', v_fixture_id,
      'provider', v.provider,
      'provider_fixture_id', v.provider_fixture_id,
      'provider_endpoint', v.provider_endpoint,
      'capture_mode', v.capture_mode,
      'ingest_version', v.ingest_version,
      'source_version', null,
      'raw_payload_sha256', v.raw_payload_sha256,
      'raw_observation_id', null,
      'retrieved_at', v.retrieved_at,
      'source_updated_at', null,
      'kickoff_at', v.kickoff_at,
      'match_status', v.match_status,
      'neutral_venue', v.neutral_venue,
      'home_goals_90', v.home_goals_90,
      'away_goals_90', v.away_goals_90,
      'home_goals_aet', v.home_goals_aet,
      'away_goals_aet', v.away_goals_aet,
      'home_penalties', v.home_penalties,
      'away_penalties', v.away_penalties,
      'teams', v_teams,
      'players', v_players,
      'substitutions', '[]'::jsonb,
      'events', '[]'::jsonb,
      'team_stats', v_stats
    );
    v_result := public.match_ledger_record_observation(v_ledger);

    -- Defense in depth: the identity this call wrote under must still be the
    -- mapped identity. The FOR SHARE row locks make this hold against every
    -- concurrent writer; the check turns any bypass (a same-transaction
    -- writer, a future refactor dropping a lock) into a full rollback.
    if not exists (
        select 1 from public.provider_competition_mappings m
        where m.provider = v.provider and m.provider_competition_id = v.provider_league_id
          and m.competition_id = v_competition and m.mapping_status in ('confirmed', 'manual_override'))
      or (select count(*) from public.provider_team_mappings m
          where m.provider = v.provider and m.mapping_status in ('confirmed', 'manual_override')
            and ((m.provider_team_id = v.provider_home_team_id and m.team_id = v_home)
              or (m.provider_team_id = v.provider_away_team_id and m.team_id = v_away))) <> 2
      or not exists (
        select 1 from public.provider_fixture_mappings m
        where m.provider = v.provider and m.provider_fixture_id = v.provider_fixture_id
          and m.fixture_id = v_fixture_id and m.mapping_status in ('confirmed', 'manual_override')) then
      raise exception 'provider identity mappings changed during ingest of % fixture %; nothing was written',
        v.provider, v.provider_fixture_id;
    end if;

    if v_result->>'status' = 'recorded' then
      insert into public.match_ledger_observation_provider_refs (observation_id, ref_kind, provider_ref)
      select (v_result->>'observation_id')::uuid, e.key, e.value
      from jsonb_each_text(v_payload_refs) e;
      insert into public.match_ledger_observation_family_fetches (observation_id, family, fetch_status)
      select (v_result->>'observation_id')::uuid, e.key, e.value
      from jsonb_each_text(v_fam) e;
    elsif v_family_upgrade then
      -- Identical canonical content cannot carry the new family status (the
      -- 1A content hash would call it unchanged): roll phase 2 back.
      raise exception using errcode = 'KQ001', message = 'family_status_drift';
    end if;
  exception when sqlstate 'KQ001' then
    v_quarantine := sqlerrm;
  end;

  if v_quarantine is not null then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      v_quarantine, v_fixture_id, null, jsonb_build_object('recorded', v_prior_families, 'payload', v_fam), null, v_flags);
  end if;

  return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, v_result->>'status', null,
    v_fixture_id, (v_result->>'observation_id')::uuid,
    jsonb_build_object(
      'fixture_resolution', v_resolution,
      'players_minted', v_minted,
      'family_response_sha256', coalesce(p_observation->'family_response_sha256', '{}'::jsonb)
    ),
    jsonb_build_object(
      'fixture_resolution', v_resolution,
      'observation_version', (v_result->>'observation_version')::integer,
      'provider_refs_status', v_refs_status,
      'players_minted', v_minted
    ), v_flags);
end;
$$;

create or replace function public.provider_ingest_record_failure(
  p_run_id uuid,
  p_provider text,
  p_provider_fixture_id text,
  p_reason_code text,
  p_detail jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  if p_run_id is null or p_provider is null or p_provider_fixture_id is null or p_reason_code is null then
    raise exception 'an ingest failure needs a run, provider, provider fixture id and reason code';
  end if;
  perform private.kapiloto_require_read_committed('provider ingest');
  perform pg_advisory_xact_lock(hashtextextended(
    'kapiloto_match_ledger_provider_fixture:' || p_provider || ':' || p_provider_fixture_id, 0
  ));
  return private.provider_ingest_result(p_run_id, p_provider, p_provider_fixture_id, 'failed', p_reason_code,
    null, null, coalesce(p_detail, '{}'::jsonb), null, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Version selection: strict actual knowledge, or the retrospective training
-- approximation (kapiloto-retrospective-training-availability-v1).
--
-- Only version 1 of a (fixture, provider) pair, captured as backfill, of kind
-- observation, with status finished, may become available before its actual
-- first_seen_at: at min(first_seen_at, kickoff_at + 24h). Every later version
-- and every withdrawal keeps its actual time, so effective times never
-- decrease across versions and a later correction never reaches an earlier
-- cutoff. This is a training approximation, never a reconstruction of what
-- Kapiloto or the provider knew live.
-- ---------------------------------------------------------------------------

create or replace function private.match_ledger_effective_versions(
  p_provider text,
  p_cutoff timestamptz,
  p_mode text,
  p_policy text
)
returns table (
  fixture_id uuid,
  observation_id uuid,
  observation_version integer,
  first_seen_at timestamptz,
  effective_available_at timestamptz,
  availability_basis text
)
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_provider is null or p_cutoff is null then
    raise exception 'effective versions need a provider and a cutoff';
  end if;
  if p_mode = 'actual' then
    if p_policy is not null then
      raise exception 'the actual mode takes no availability policy';
    end if;
  elsif p_mode = 'retrospective_training' then
    if p_policy is distinct from 'kapiloto-retrospective-training-availability-v1' then
      raise exception 'unsupported availability policy %', p_policy;
    end if;
  else
    raise exception 'unsupported availability mode %', p_mode;
  end if;

  return query
  with versions as (
    select
      o.id as v_observation_id,
      o.fixture_id as v_fixture_id,
      o.observation_version as v_version,
      o.observation_kind as v_kind,
      o.first_seen_at as v_first_seen,
      case
        when p_mode = 'retrospective_training'
          and o.capture_mode = 'backfill'
          and o.observation_kind = 'observation'
          and o.match_status = 'finished'
          and o.observation_version = 1
          and o.kickoff_at + interval '24 hours' < o.first_seen_at
        then o.kickoff_at + interval '24 hours'
        else o.first_seen_at
      end as v_effective
    from public.match_ledger_observations o
    where o.provider = p_provider
  ),
  ranked as (
    select vv.*, row_number() over (partition by vv.v_fixture_id order by vv.v_version desc) as v_rank
    from versions vv
    where vv.v_effective <= p_cutoff
  )
  select rk.v_fixture_id, rk.v_observation_id, rk.v_version, rk.v_first_seen, rk.v_effective,
         case when rk.v_effective < rk.v_first_seen then 'retrospective_backfill' else 'actual' end
  from ranked rk
  where rk.v_rank = 1 and rk.v_kind = 'observation';
end;
$$;

-- ---------------------------------------------------------------------------
-- kapiloto-team-match-stats-v1: one row per team per selected finished
-- fixture, one provider per call, never zero for missing.
-- ---------------------------------------------------------------------------

create or replace function private.match_ledger_team_match_stats(
  p_provider text,
  p_competition_ids uuid[],
  p_from timestamptz,
  p_cutoff timestamptz,
  p_mode text,
  p_policy text
)
returns table (
  fixture_id uuid,
  team_id uuid,
  opponent_team_id uuid,
  side text,
  neutral_venue boolean,
  competition_id uuid,
  season_key text,
  provider_league_ref text,
  provider_season_ref text,
  provider text,
  observation_id uuid,
  observation_version integer,
  capture_mode text,
  ingest_version text,
  kickoff_at timestamptz,
  first_seen_at timestamptz,
  effective_available_at timestamptz,
  availability_basis text,
  availability_policy text,
  evaluation_class text,
  match_status text,
  goals_for_90 smallint,
  goals_against_90 smallint,
  went_to_extra_time boolean,
  penalties_for smallint,
  penalties_against smallint,
  stats_for jsonb,
  stats_against jsonb,
  lineup_status text,
  statistics_status text,
  quality_flags text[]
)
language plpgsql
stable
set search_path = ''
as $$
begin
  return query
  with selected as (
    select ev.* from private.match_ledger_effective_versions(p_provider, p_cutoff, p_mode, p_policy) ev
  ),
  keys(stat_key, family) as (
    values
      ('expected_goals', 'xg'), ('expected_goals_on_target', 'xg'), ('expected_non_penalty_goals', 'xg'),
      ('shots_total', 'statistics'), ('shots_on_target', 'statistics'),
      ('possession_pct', 'statistics'), ('corners', 'statistics')
  ),
  base as (
    select
      s.fixture_id as b_fixture_id, s.observation_id as b_observation_id, s.observation_version as b_version,
      s.first_seen_at as b_first_seen, s.effective_available_at as b_effective, s.availability_basis as b_basis,
      o.provider as b_provider, o.capture_mode as b_capture_mode, o.ingest_version as b_ingest_version,
      o.kickoff_at as b_kickoff, o.match_status as b_status, o.neutral_venue as b_neutral,
      (o.home_goals_aet is not null or o.home_penalties is not null) as b_extra_time,
      o.home_goals_90, o.away_goals_90, o.home_penalties, o.away_penalties,
      tr.team_id as b_team, tr.opponent_team_id as b_opponent, tr.side as b_side,
      tr.lineup_status as b_lineup_status, tr.statistics_status as b_statistics_status,
      f.competition_id as b_competition, f.season_key as b_season_key
    from selected s
    join public.match_ledger_observations o on o.id = s.observation_id
    join public.match_ledger_team_records tr on tr.observation_id = o.id
    join public.fixtures f on f.id = o.fixture_id
    where o.match_status = 'finished'
      and o.kickoff_at < p_cutoff
      and (p_from is null or o.kickoff_at >= p_from)
      and (p_competition_ids is null or f.competition_id = any (p_competition_ids))
  )
  select
    b.b_fixture_id, b.b_team, b.b_opponent, b.b_side, b.b_neutral, b.b_competition, b.b_season_key,
    (select pr.provider_ref from public.match_ledger_observation_provider_refs pr
      where pr.observation_id = b.b_observation_id and pr.ref_kind = 'league'),
    (select pr.provider_ref from public.match_ledger_observation_provider_refs pr
      where pr.observation_id = b.b_observation_id and pr.ref_kind = 'season'),
    b.b_provider, b.b_observation_id, b.b_version, b.b_capture_mode, b.b_ingest_version, b.b_kickoff,
    b.b_first_seen, b.b_effective, b.b_basis,
    case when p_mode = 'retrospective_training' then p_policy else null end,
    case when p_mode = 'retrospective_training' then 'retrospective' else 'actual' end,
    b.b_status,
    case when b.b_side = 'home' then b.home_goals_90 else b.away_goals_90 end,
    case when b.b_side = 'home' then b.away_goals_90 else b.home_goals_90 end,
    b.b_extra_time,
    case when b.b_side = 'home' then b.home_penalties else b.away_penalties end,
    case when b.b_side = 'home' then b.away_penalties else b.home_penalties end,
    (select jsonb_object_agg(k.stat_key, private.match_ledger_team_stat_entry(
        b.b_observation_id, b.b_team, k.stat_key, k.family, b.b_extra_time)) from keys k),
    (select jsonb_object_agg(k.stat_key, private.match_ledger_team_stat_entry(
        b.b_observation_id, b.b_opponent, k.stat_key, k.family, b.b_extra_time)) from keys k),
    b.b_lineup_status,
    b.b_statistics_status,
    array_remove(array[
      case when b.b_extra_time then 'went_to_extra_time' end,
      case when not exists (select 1 from public.match_ledger_observation_family_fetches ff
                            where ff.observation_id = b.b_observation_id) then 'family_fetches_unrecorded' end,
      case when exists (select 1 from public.match_ledger_observation_family_fetches ff
                        where ff.observation_id = b.b_observation_id and ff.family = 'xg'
                          and ff.fetch_status = 'not_requested') then 'xg_not_requested' end,
      case when exists (select 1 from public.match_ledger_observation_family_fetches ff
                        where ff.observation_id = b.b_observation_id and ff.family = 'statistics'
                          and ff.fetch_status = 'not_requested') then 'statistics_not_requested' end
    ], null)
  from base b
  order by b.b_kickoff, b.b_fixture_id, b.b_side;
end;
$$;

-- One statistic of one team in one observation, with its missingness status:
-- not_separable (the match went to extra time) > observed > not_observed
-- (family fetched, key absent) > family_not_provided (family not requested,
-- or no recorded family status). Never zero for missing.
create or replace function private.match_ledger_team_stat_entry(
  p_observation_id uuid,
  p_team_id uuid,
  p_stat_key text,
  p_family text,
  p_extra_time boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_value numeric;
  v_definition_id uuid;
  v_stat_type text;
  v_definition_version text;
  v_fetch text;
begin
  if p_extra_time then
    return jsonb_build_object('value', null, 'status', 'not_separable', 'definition_id', null,
      'provider_stat_type', null, 'definition_version', null, 'period', null);
  end if;
  select ts.value_numeric, d.id, d.provider_stat_type, d.definition_version
    into v_value, v_definition_id, v_stat_type, v_definition_version
  from public.match_ledger_team_stats ts
  join public.match_ledger_stat_definitions d on d.id = ts.stat_definition_id
  where ts.observation_id = p_observation_id and ts.team_id = p_team_id
    and d.stat_key = p_stat_key and ts.period = 'full_time'
  order by d.definition_version desc
  limit 1;
  if found then
    return jsonb_build_object('value', v_value, 'status', 'observed', 'definition_id', v_definition_id,
      'provider_stat_type', v_stat_type, 'definition_version', v_definition_version, 'period', 'full_time');
  end if;
  select ff.fetch_status into v_fetch
  from public.match_ledger_observation_family_fetches ff
  where ff.observation_id = p_observation_id and ff.family = p_family;
  return jsonb_build_object('value', null,
    'status', case when v_fetch = 'fetched' then 'not_observed' else 'family_not_provided' end,
    'definition_id', null, 'provider_stat_type', null, 'definition_version', null, 'period', null);
end;
$$;

create or replace function public.match_ledger_team_match_stats_as_of(
  p_provider text,
  p_competition_ids uuid[],
  p_from timestamptz,
  p_cutoff timestamptz
)
returns setof jsonb
language sql
stable
set search_path = ''
as $$
  select to_jsonb(t) from private.match_ledger_team_match_stats(
    p_provider, p_competition_ids, p_from, p_cutoff, 'actual', null) t
$$;

create or replace function public.match_ledger_team_match_stats_for_training(
  p_provider text,
  p_competition_ids uuid[],
  p_from timestamptz,
  p_training_cutoff timestamptz,
  p_policy text
)
returns setof jsonb
language sql
stable
set search_path = ''
as $$
  select to_jsonb(t) from private.match_ledger_team_match_stats(
    p_provider, p_competition_ids, p_from, p_training_cutoff, 'retrospective_training', p_policy) t
$$;

-- ---------------------------------------------------------------------------
-- Security: server/service_role only
-- ---------------------------------------------------------------------------

alter table public.provider_ingest_runs enable row level security;
alter table public.provider_ingest_items enable row level security;
alter table public.match_ledger_observation_provider_refs enable row level security;
alter table public.match_ledger_observation_family_fetches enable row level security;
alter table public.match_ledger_fixture_mints enable row level security;

revoke all on table public.provider_ingest_runs from public, anon, authenticated;
revoke all on table public.provider_ingest_items from public, anon, authenticated;
revoke all on table public.match_ledger_observation_provider_refs from public, anon, authenticated;
revoke all on table public.match_ledger_observation_family_fetches from public, anon, authenticated;
revoke all on table public.match_ledger_fixture_mints from public, anon, authenticated;

revoke all on function private.seal_match_ledger_observation_annotation() from public, anon, authenticated;
revoke all on function private.stamp_match_ledger_fixture_mint() from public, anon, authenticated;
revoke all on function private.provider_ingest_result(uuid, text, text, text, text, uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.match_ledger_ingest_provider_fixture(jsonb) from public, anon, authenticated;
revoke all on function public.provider_ingest_record_failure(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function private.match_ledger_effective_versions(text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function private.match_ledger_team_match_stats(text, uuid[], timestamptz, timestamptz, text, text) from public, anon, authenticated;
revoke all on function private.match_ledger_team_stat_entry(uuid, uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.match_ledger_team_match_stats_as_of(text, uuid[], timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.match_ledger_team_match_stats_for_training(text, uuid[], timestamptz, timestamptz, text) from public, anon, authenticated;

grant execute on function public.match_ledger_ingest_provider_fixture(jsonb) to service_role;
grant execute on function public.provider_ingest_record_failure(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.match_ledger_team_match_stats_as_of(text, uuid[], timestamptz, timestamptz) to service_role;
grant execute on function public.match_ledger_team_match_stats_for_training(text, uuid[], timestamptz, timestamptz, text) to service_role;
-- Called by name from the invoker functions above.
grant execute on function private.provider_ingest_result(uuid, text, text, text, text, uuid, uuid, jsonb, jsonb, jsonb) to service_role;
grant execute on function private.match_ledger_effective_versions(text, timestamptz, text, text) to service_role;
grant execute on function private.match_ledger_team_match_stats(text, uuid[], timestamptz, timestamptz, text, text) to service_role;
grant execute on function private.match_ledger_team_stat_entry(uuid, uuid, text, text, boolean) to service_role;

comment on table public.provider_ingest_runs is
  'Immutable header of one provider ingest run (A2-B operator backfill or tests): versions, entitlement snapshot hash, scope, mint policy bound.';
comment on table public.provider_ingest_items is
  'Append-only ingest attempts: one row per attempt per provider fixture, with recorded/unchanged/quarantined/failed and a closed reason code. detail.capture_quality_flags carries the parser''s recoverable capture issues for every attempt that reached the ingest RPC.';
comment on table public.match_ledger_observation_provider_refs is
  'Identity-critical provider refs (league, season, home team, away team) of one observation version, sealed to its writing statement. A later payload with different refs is quarantined (provider_ref_drift), never attached.';
comment on table public.match_ledger_observation_family_fetches is
  'Fetch status (fetched / not_requested) of each provider data family for one observation version, sealed to its writing statement. Drives not_observed vs family_not_provided in kapiloto-team-match-stats-v1.';
comment on table public.match_ledger_fixture_mints is
  'Canonical fixtures created by the provider ingest RPC and the caller mint policy bound they were minted under.';
