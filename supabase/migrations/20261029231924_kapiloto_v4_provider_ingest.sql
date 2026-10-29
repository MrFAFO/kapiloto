-- Kapiloto V4 Foundation 1E-A2-A: provider-native Match Ledger ingest contracts (D-056).
-- Additive only. Applied V4 migrations are not modified.
-- No provider network execution occurs in this migration.

-- ---------------------------------------------------------------------------
-- Provider-native player mapping provenance
-- ---------------------------------------------------------------------------

alter table public.provider_player_mappings
  add column mapping_basis text
    check (mapping_basis is null or mapping_basis in (
      'provider_native_bootstrap', 'operator', 'name_resolution'
    ));

comment on column public.provider_player_mappings.mapping_basis is
  'How this provider/player mapping was established. provider_native_bootstrap means the canonical player was minted from this provider id; null preserves pre-D-056 rows.';

-- ---------------------------------------------------------------------------
-- Provider ingest audit and immutable sidecars
-- ---------------------------------------------------------------------------

create table public.provider_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  purpose text not null check (purpose in ('backfill', 'test')),
  ingest_version text not null check (char_length(btrim(ingest_version)) between 1 and 80),
  entitlement_snapshot_sha256 text
    check (entitlement_snapshot_sha256 is null or entitlement_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  scope jsonb not null default '{}'::jsonb,
  fixture_mint_kickoff_before timestamptz,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(scope) = 'object' and octet_length(scope::text) <= 65536)
);

create table public.provider_ingest_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.provider_ingest_runs(id) on delete restrict,
  provider text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_fixture_id text not null check (char_length(btrim(provider_fixture_id)) between 1 and 80),
  attempt_no integer not null check (attempt_no >= 1),
  status text not null check (status in ('recorded', 'unchanged', 'quarantined', 'failed')),
  reason_code text check (reason_code is null or reason_code ~ '^[a-z0-9_]{1,80}$'),
  observation_id uuid references public.match_ledger_observations(id) on delete restrict,
  fixture_id uuid references public.fixtures(id) on delete restrict,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, provider, provider_fixture_id, attempt_no),
  check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 8192),
  check ((status in ('recorded', 'unchanged')) = (reason_code is null)),
  check (status <> 'recorded' or observation_id is not null),
  check (status <> 'unchanged' or observation_id is not null),
  check (status <> 'quarantined' or reason_code in (
    'competition_unmapped', 'team_unmapped', 'team_identity_conflict',
    'fixture_mapping_conflict', 'fixture_mapping_unverified',
    'fixture_candidate_ambiguous', 'fixture_possible_reschedule',
    'fixture_possible_postponement', 'fixture_competition_unknown',
    'fixture_mint_not_permitted', 'provider_ref_drift',
    'provider_refs_unrecorded', 'not_finished'
  ))
);

create index provider_ingest_items_run_fixture_attempt_idx
  on public.provider_ingest_items (run_id, provider_fixture_id, attempt_no desc);

create table public.match_ledger_fixture_mints (
  fixture_id uuid primary key references public.fixtures(id) on delete restrict,
  provider text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_fixture_id text not null check (char_length(btrim(provider_fixture_id)) between 1 and 80),
  run_id uuid references public.provider_ingest_runs(id) on delete restrict,
  kickoff_before timestamptz not null,
  minted_at timestamptz not null default private.kapiloto_information_clock(),
  unique (provider, provider_fixture_id)
);

create table public.match_ledger_observation_provider_refs (
  observation_id uuid not null references public.match_ledger_observations(id) on delete restrict,
  ref_kind text not null check (ref_kind in ('league', 'season', 'team_home', 'team_away')),
  provider_ref text not null check (char_length(btrim(provider_ref)) between 1 and 80),
  primary key (observation_id, ref_kind)
);

create index match_ledger_observation_provider_refs_lookup_idx
  on public.match_ledger_observation_provider_refs (ref_kind, provider_ref);

create index match_ledger_observations_provider_capture_version_idx
  on public.match_ledger_observations (provider, capture_mode, fixture_id, observation_version);

create or replace function private.prepare_match_ledger_observation_provider_ref()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_statement timestamptz;
begin
  select o.ingest_statement_at into v_statement
  from public.match_ledger_observations o
  where o.id = new.observation_id;
  if v_statement is null then
    raise exception 'match ledger observation not found';
  end if;
  if v_statement <> statement_timestamp() then
    raise exception 'match ledger observation % is sealed', new.observation_id;
  end if;
  return new;
end;
$$;

create trigger match_ledger_observation_provider_refs_prepare
before insert on public.match_ledger_observation_provider_refs
for each row execute function private.prepare_match_ledger_observation_provider_ref();

create trigger match_ledger_observation_provider_refs_immutable
before update or delete on public.match_ledger_observation_provider_refs
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_observation_provider_refs_no_truncate
before truncate on public.match_ledger_observation_provider_refs
for each statement execute function private.kapiloto_v4_reject_change();

create trigger match_ledger_fixture_mints_immutable
before update or delete on public.match_ledger_fixture_mints
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_fixture_mints_no_truncate
before truncate on public.match_ledger_fixture_mints
for each statement execute function private.kapiloto_v4_reject_change();

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

-- ---------------------------------------------------------------------------
-- Reviewed Sportmonks model-critical statistic definitions.
-- Runtime parsing still verifies provider_stat_name; unknown/drifted types are
-- never auto-created. Non-xG ids are re-verified against real payloads in A2-B.
-- ---------------------------------------------------------------------------

insert into public.match_ledger_stat_definitions
  (provider, provider_stat_type, provider_stat_name, definition_version, stat_key, unit, description)
values
  ('sportmonks', '5304', 'EXPECTED_GOALS', 'sm-2024-08', 'expected_goals', 'expected_goals', 'Sportmonks team expected goals, kept separate from xGoT and npxG.'),
  ('sportmonks', '5305', 'EXPECTED_GOALS_ON_TARGET', 'sm-2024-08', 'expected_goals_on_target', 'expected_goals', 'Sportmonks expected goals on target.'),
  ('sportmonks', '7943', 'EXPECTED_NON_PENALTY_GOALS', 'sm-2024-08', 'expected_non_penalty_goals', 'expected_goals', 'Sportmonks expected non-penalty goals.'),
  ('sportmonks', '42', 'SHOTS_TOTAL', 'sm-2024-08', 'shots_total', 'count', 'Sportmonks total shots.'),
  ('sportmonks', '86', 'SHOTS_ON_TARGET', 'sm-2024-08', 'shots_on_target', 'count', 'Sportmonks shots on target.'),
  ('sportmonks', '45', 'BALL_POSSESSION', 'sm-2024-08', 'possession_pct', 'percent', 'Sportmonks ball possession percentage.'),
  ('sportmonks', '34', 'CORNERS', 'sm-2024-08', 'corners', 'count', 'Sportmonks corners.')
on conflict (provider, provider_stat_type, definition_version) do nothing;

-- ---------------------------------------------------------------------------
-- Audit helper. Same provider-fixture lock serializes attempt numbers with the
-- ingest RPC and failure recorder. It is private and service-role only.
-- ---------------------------------------------------------------------------

create or replace function private.provider_ingest_append_item(
  p_run_id uuid,
  p_provider text,
  p_provider_fixture_id text,
  p_status text,
  p_reason_code text,
  p_observation_id uuid,
  p_fixture_id uuid,
  p_detail jsonb
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_attempt integer;
  v_run public.provider_ingest_runs%rowtype;
begin
  if p_run_id is null then
    return null;
  end if;
  select * into v_run from public.provider_ingest_runs where id = p_run_id;
  if not found then raise exception 'provider ingest run not found'; end if;
  if v_run.provider <> p_provider then raise exception 'provider ingest run provider mismatch'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'kapiloto_match_ledger_provider_fixture:' || p_provider || ':' || p_provider_fixture_id, 0
  ));
  select coalesce(max(i.attempt_no), 0) + 1 into v_attempt
  from public.provider_ingest_items i
  where i.run_id = p_run_id and i.provider = p_provider and i.provider_fixture_id = p_provider_fixture_id;
  insert into public.provider_ingest_items
    (run_id, provider, provider_fixture_id, attempt_no, status, reason_code, observation_id, fixture_id, detail)
  values
    (p_run_id, p_provider, p_provider_fixture_id, v_attempt, p_status, p_reason_code,
     p_observation_id, p_fixture_id, coalesce(p_detail, '{}'::jsonb));
  return v_attempt;
end;
$$;

create or replace function private.match_ledger_ingest_quarantine(
  p_run_id uuid,
  p_provider text,
  p_provider_fixture_id text,
  p_reason_code text,
  p_fixture_id uuid,
  p_provider_refs_status text,
  p_detail jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  perform private.provider_ingest_append_item(
    p_run_id, p_provider, p_provider_fixture_id, 'quarantined', p_reason_code,
    null, p_fixture_id, coalesce(p_detail, '{}'::jsonb)
  );
  return jsonb_build_object(
    'status', 'quarantined',
    'reason_code', p_reason_code,
    'fixture_id', p_fixture_id,
    'fixture_resolution', null,
    'observation_id', null,
    'observation_version', null,
    'provider_refs_status', p_provider_refs_status,
    'players_minted', 0
  );
end;
$$;

create or replace function public.provider_ingest_record_failure(
  p_run_id uuid,
  p_provider text,
  p_provider_fixture_id text,
  p_reason_code text,
  p_detail jsonb default '{}'::jsonb
)
returns integer
language plpgsql
set search_path = ''
as $$
begin
  if p_run_id is null or p_provider is null or p_provider_fixture_id is null or p_reason_code is null then
    raise exception 'run, provider, provider fixture and reason are required';
  end if;
  return private.provider_ingest_append_item(
    p_run_id, p_provider, p_provider_fixture_id, 'failed', p_reason_code,
    null, null, coalesce(p_detail, '{}'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic provider-native ingest. This V1 provider-native contract is currently
-- Sportmonks-specific by field mapping, while the inner Match Ledger contract
-- remains kapiloto-match-ledger-observation-v1 unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.match_ledger_ingest_provider_fixture(p_observation jsonb)
returns jsonb
language plpgsql
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_contract text;
  v_provider text;
  v_provider_fixture_id text;
  v_provider_endpoint text;
  v_provider_league_id text;
  v_provider_season_id text;
  v_provider_home_team_id text;
  v_provider_away_team_id text;
  v_capture_mode text;
  v_ingest_version text;
  v_source_version text;
  v_raw_payload_sha256 text;
  v_retrieved_at timestamptz;
  v_source_updated_at timestamptz;
  v_kickoff_at timestamptz;
  v_match_status text;
  v_neutral_venue boolean;
  v_home_goals_90 smallint;
  v_away_goals_90 smallint;
  v_home_goals_aet smallint;
  v_away_goals_aet smallint;
  v_home_penalties smallint;
  v_away_penalties smallint;
  v_run_id uuid;
  v_mint_allowed boolean;
  v_mint_before timestamptz;
  v_competition_id uuid;
  v_home_team_id uuid;
  v_away_team_id uuid;
  v_fixture_id uuid;
  v_fixture_resolution text;
  v_mapping_status text;
  v_mapping_fixture uuid;
  v_candidate_count integer;
  v_candidate uuid;
  v_mapped_candidate_count integer;
  v_w_count integer;
  v_p_count integer;
  v_u_count integer;
  v_latest_observation uuid;
  v_latest_refs_count integer;
  v_ref_mismatch boolean;
  v_players jsonb := '[]'::jsonb;
  v_teams jsonb := '[]'::jsonb;
  v_stats jsonb := '[]'::jsonb;
  v_player jsonb;
  v_player_id uuid;
  v_player_name text;
  v_players_minted integer := 0;
  v_stat jsonb;
  v_stat_definition uuid;
  v_ledger_payload jsonb;
  v_ledger_result jsonb;
  v_observation_id uuid;
  v_observation_version integer;
  v_provider_refs_status text;
  v_run public.provider_ingest_runs%rowtype;
begin
  perform private.kapiloto_require_read_committed('provider fixture ingest');
  perform private.kapiloto_v4_assert_keys(p_observation, array[
    'contract_version','provider','provider_fixture_id','provider_endpoint',
    'provider_league_id','provider_season_id','provider_home_team_id','provider_away_team_id',
    'capture_mode','ingest_version','source_version','raw_payload_sha256','retrieved_at','source_updated_at',
    'kickoff_at','match_status','neutral_venue','home_goals_90','away_goals_90',
    'home_goals_aet','away_goals_aet','home_penalties','away_penalties',
    'fixture_mint','run_id','teams','players','team_stats','quality_flags'
  ], 'provider match observation');
  perform private.kapiloto_v4_assert_keys(coalesce(p_observation->'fixture_mint','{}'::jsonb), array['allowed','kickoff_before'], 'fixture mint');
  perform private.kapiloto_v4_assert_keys(coalesce(p_observation->'teams','[]'::jsonb), array[
    'side','provider_team_id','formation_nominal','lineup_status','substitutions_status','events_status','statistics_status'
  ], 'provider team');
  perform private.kapiloto_v4_assert_keys(coalesce(p_observation->'players','[]'::jsonb), array[
    'provider_team_id','provider_player_id','provider_player_name','lineup_role','appeared','position_code',
    'provider_position','formation_position','formation_field','shirt_number','is_captain','minutes_played',
    'entered_minute','exited_minute','data_completeness'
  ], 'provider player');
  perform private.kapiloto_v4_assert_keys(coalesce(p_observation->'team_stats','[]'::jsonb), array[
    'provider_team_id','provider_stat_type','period','value'
  ], 'provider team stat');

  select
    p_observation->>'contract_version', p_observation->>'provider', p_observation->>'provider_fixture_id',
    p_observation->>'provider_endpoint', p_observation->>'provider_league_id', p_observation->>'provider_season_id',
    p_observation->>'provider_home_team_id', p_observation->>'provider_away_team_id',
    p_observation->>'capture_mode', p_observation->>'ingest_version', p_observation->>'source_version',
    p_observation->>'raw_payload_sha256', (p_observation->>'retrieved_at')::timestamptz,
    nullif(p_observation->>'source_updated_at','')::timestamptz,
    (p_observation->>'kickoff_at')::timestamptz, p_observation->>'match_status',
    (p_observation->>'neutral_venue')::boolean, (p_observation->>'home_goals_90')::smallint,
    (p_observation->>'away_goals_90')::smallint, nullif(p_observation->>'home_goals_aet','')::smallint,
    nullif(p_observation->>'away_goals_aet','')::smallint, nullif(p_observation->>'home_penalties','')::smallint,
    nullif(p_observation->>'away_penalties','')::smallint, nullif(p_observation->>'run_id','')::uuid,
    coalesce((p_observation->'fixture_mint'->>'allowed')::boolean, false),
    nullif(p_observation->'fixture_mint'->>'kickoff_before','')::timestamptz
  into
    v_contract, v_provider, v_provider_fixture_id, v_provider_endpoint, v_provider_league_id, v_provider_season_id,
    v_provider_home_team_id, v_provider_away_team_id, v_capture_mode, v_ingest_version, v_source_version,
    v_raw_payload_sha256, v_retrieved_at, v_source_updated_at, v_kickoff_at, v_match_status, v_neutral_venue,
    v_home_goals_90, v_away_goals_90, v_home_goals_aet, v_away_goals_aet, v_home_penalties, v_away_penalties,
    v_run_id, v_mint_allowed, v_mint_before;

  if v_contract <> 'kapiloto-provider-match-observation-v1' then raise exception 'unsupported provider match observation contract'; end if;
  if v_provider <> 'sportmonks' then raise exception 'provider match observation v1 supports sportmonks only'; end if;
  if v_ingest_version <> 'kapiloto-sportmonks-ledger-mapping-v1' then raise exception 'unsupported sportmonks ledger mapping version'; end if;
  if v_provider_fixture_id is null or v_provider_league_id is null or v_provider_season_id is null
     or v_provider_home_team_id is null or v_provider_away_team_id is null or v_kickoff_at is null
     or v_retrieved_at is null or v_ingest_version is null or v_capture_mode is null then
    raise exception 'provider match observation is missing required identity/provenance fields';
  end if;
  if v_match_status = 'finished' and (v_home_goals_90 is null or v_away_goals_90 is null) then
    raise exception 'finished provider observation requires a 90-minute score';
  end if;
  if jsonb_typeof(coalesce(p_observation->'teams','[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_observation->'teams','[]'::jsonb)) <> 2
     or (select count(*) from jsonb_array_elements(p_observation->'teams') t
         where t->>'side'='home' and t->>'provider_team_id'=v_provider_home_team_id) <> 1
     or (select count(*) from jsonb_array_elements(p_observation->'teams') t
         where t->>'side'='away' and t->>'provider_team_id'=v_provider_away_team_id) <> 1 then
    raise exception 'provider match observation requires exactly the declared home and away team rows';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_observation->'players','[]'::jsonb)) p
    where nullif(btrim(p->>'provider_player_id'),'') is null
       or p->>'provider_team_id' not in (v_provider_home_team_id, v_provider_away_team_id)
  ) then
    raise exception 'provider player identity/team is invalid for this fixture';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_observation->'team_stats','[]'::jsonb)) st
    where st->>'provider_team_id' not in (v_provider_home_team_id, v_provider_away_team_id)
       or nullif(btrim(st->>'provider_stat_type'),'') is null
       or nullif(btrim(st->>'value'),'') is null
  ) then
    raise exception 'provider team statistic identity/value is invalid for this fixture';
  end if;

  if v_run_id is not null then
    select * into v_run from public.provider_ingest_runs where id = v_run_id;
    if not found then raise exception 'provider ingest run not found'; end if;
    if v_run.provider <> v_provider then raise exception 'provider ingest run provider mismatch'; end if;
    if v_run.ingest_version <> v_ingest_version then raise exception 'provider ingest run version mismatch'; end if;
    if v_run.fixture_mint_kickoff_before is distinct from v_mint_before then
      raise exception 'provider ingest run mint cutoff mismatch';
    end if;
  end if;

  -- First lock in the global order: provider fixture identity.
  perform pg_advisory_xact_lock(hashtextextended(
    'kapiloto_match_ledger_provider_fixture:' || v_provider || ':' || v_provider_fixture_id, 0
  ));

  select m.competition_id into v_competition_id
  from public.provider_competition_mappings m
  where m.provider = v_provider and m.provider_competition_id = v_provider_league_id
    and m.mapping_status in ('confirmed','manual_override');
  if v_competition_id is null then
    return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
      'competition_unmapped', null, null, '{}'::jsonb);
  end if;

  select m.team_id into v_home_team_id
  from public.provider_team_mappings m
  where m.provider = v_provider and m.provider_team_id = v_provider_home_team_id
    and m.mapping_status in ('confirmed','manual_override');
  select m.team_id into v_away_team_id
  from public.provider_team_mappings m
  where m.provider = v_provider and m.provider_team_id = v_provider_away_team_id
    and m.mapping_status in ('confirmed','manual_override');
  if v_home_team_id is null or v_away_team_id is null then
    return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
      'team_unmapped', null, null, jsonb_build_object('home_mapped',v_home_team_id is not null,'away_mapped',v_away_team_id is not null));
  end if;
  if v_home_team_id = v_away_team_id then
    return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
      'team_identity_conflict', null, null, '{}'::jsonb);
  end if;

  -- Pairing lock is second. It serializes candidate search / attach / mint for
  -- one canonical competition + oriented team pair.
  perform pg_advisory_xact_lock(hashtextextended(
    'kapiloto_canonical_fixture_key:' || v_competition_id::text || ':' || v_home_team_id::text || ':' || v_away_team_id::text, 0
  ));

  select m.fixture_id, m.mapping_status into v_mapping_fixture, v_mapping_status
  from public.provider_fixture_mappings m
  where m.provider = v_provider and m.provider_fixture_id = v_provider_fixture_id;

  if v_mapping_fixture is not null then
    if v_mapping_status = 'unverified' then
      return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
        'fixture_mapping_unverified', v_mapping_fixture, null, '{}'::jsonb);
    end if;
    if v_mapping_status not in ('confirmed','manual_override') or not exists (
      select 1 from public.fixtures f
      where f.id = v_mapping_fixture and f.home_team_id = v_home_team_id and f.away_team_id = v_away_team_id
        and (f.competition_id = v_competition_id or f.competition_id is null)
    ) then
      return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
        'fixture_mapping_conflict', v_mapping_fixture, null, '{}'::jsonb);
    end if;
    v_fixture_id := v_mapping_fixture;
    v_fixture_resolution := 'existing_mapping';
  else
    -- A different provider fixture id already mapped to the same canonical
    -- match window is a provider-identity collision, never a reason to mint a
    -- duplicate canonical fixture. The pairing lock serializes two A2 writers.
    select count(*) into v_mapped_candidate_count
    from public.fixtures f
    join public.provider_fixture_mappings m
      on m.fixture_id = f.id and m.provider = v_provider
    where f.competition_id = v_competition_id
      and f.home_team_id = v_home_team_id and f.away_team_id = v_away_team_id
      and abs(extract(epoch from (f.kickoff_at - v_kickoff_at))) <= 48*3600
      and m.provider_fixture_id <> v_provider_fixture_id;
    if v_mapped_candidate_count > 0 then
      return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
        'fixture_candidate_ambiguous', null, null, jsonb_build_object('mapped_candidate_count',v_mapped_candidate_count));
    end if;

    select count(*), min(f.id) into v_candidate_count, v_candidate
    from public.fixtures f
    where f.competition_id = v_competition_id and f.home_team_id = v_home_team_id and f.away_team_id = v_away_team_id
      and abs(extract(epoch from (f.kickoff_at - v_kickoff_at))) <= 48*3600
      and not exists (select 1 from public.provider_fixture_mappings m where m.provider = v_provider and m.fixture_id = f.id);

    select count(*) into v_w_count
    from public.fixtures f
    where f.competition_id = v_competition_id and f.home_team_id = v_home_team_id and f.away_team_id = v_away_team_id
      and abs(extract(epoch from (f.kickoff_at - v_kickoff_at))) <= 14*86400
      and abs(extract(epoch from (f.kickoff_at - v_kickoff_at))) > 48*3600
      and not exists (select 1 from public.provider_fixture_mappings m where m.provider = v_provider and m.fixture_id = f.id);

    select count(*) into v_p_count
    from public.fixtures f
    where f.competition_id = v_competition_id and f.home_team_id = v_home_team_id and f.away_team_id = v_away_team_id
      and abs(extract(epoch from (f.kickoff_at - v_kickoff_at))) <= 180*86400
      and abs(extract(epoch from (f.kickoff_at - v_kickoff_at))) > 48*3600
      and f.status in ('postponed','suspended','cancelled','under_review')
      and not exists (select 1 from public.provider_fixture_mappings m where m.provider = v_provider and m.fixture_id = f.id);

    select count(*) into v_u_count
    from public.fixtures f
    where f.competition_id is null and f.home_team_id = v_home_team_id and f.away_team_id = v_away_team_id
      and abs(extract(epoch from (f.kickoff_at - v_kickoff_at))) <= 14*86400
      and not exists (select 1 from public.provider_fixture_mappings m where m.provider = v_provider and m.fixture_id = f.id);

    if v_candidate_count = 1 and v_w_count = 0 and v_p_count = 0 and v_u_count = 0 then
      v_fixture_id := v_candidate;
      v_fixture_resolution := 'attached';
    elsif v_candidate_count > 1 then
      return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
        'fixture_candidate_ambiguous', null, null, jsonb_build_object('candidate_count',v_candidate_count));
    elsif v_p_count > 0 then
      return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
        'fixture_possible_postponement', null, null, jsonb_build_object('candidate_count',v_p_count));
    elsif v_w_count > 0 then
      return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
        'fixture_possible_reschedule', null, null, jsonb_build_object('candidate_count',v_w_count));
    elsif v_u_count > 0 then
      return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
        'fixture_competition_unknown', null, null, jsonb_build_object('candidate_count',v_u_count));
    else
      if not v_mint_allowed or v_mint_before is null or v_kickoff_at >= v_mint_before
         or v_match_status <> 'finished' or v_kickoff_at + interval '105 minutes' > clock_timestamp() then
        return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
          'fixture_mint_not_permitted', null, null, '{}'::jsonb);
      end if;
      v_fixture_resolution := 'minted';
    end if;
  end if;

  -- For an existing/attached fixture, acquire the full 1A fixture/provider
  -- lock before reading the latest observation/refs. This serializes the drift
  -- check against raw 1A writers while preserving the global lock order. A
  -- minted fixture has no prior history and gets this lock after insertion.
  if v_fixture_id is not null then
    perform private.lock_match_ledger_fixture(v_provider, v_provider_fixture_id, v_fixture_id);
  end if;

  -- Provider refs are part of the outer ingest contract, not the 1A content
  -- hash. They are immutable sidecars; drift is fail-closed before any write.
  if v_fixture_id is not null then
    select o.id into v_latest_observation
    from public.match_ledger_observations o
    where o.fixture_id = v_fixture_id and o.provider = v_provider
    order by o.observation_version desc limit 1;
    if v_latest_observation is not null then
      select count(*) into v_latest_refs_count
      from public.match_ledger_observation_provider_refs r
      where r.observation_id = v_latest_observation;
      if v_latest_refs_count <> 4 then
        return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
          'provider_refs_unrecorded', v_fixture_id, 'unrecorded', '{}'::jsonb);
      end if;
      select exists (
        select 1 from (values
          ('league'::text, v_provider_league_id), ('season', v_provider_season_id),
          ('team_home', v_provider_home_team_id), ('team_away', v_provider_away_team_id)
        ) expected(ref_kind, provider_ref)
        left join public.match_ledger_observation_provider_refs r
          on r.observation_id = v_latest_observation and r.ref_kind = expected.ref_kind
        where r.provider_ref is distinct from expected.provider_ref
      ) into v_ref_mismatch;
      if v_ref_mismatch then
        return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
          'provider_ref_drift', v_fixture_id, 'drift', '{}'::jsonb);
      end if;
      v_provider_refs_status := 'matched';
    else
      v_provider_refs_status := 'recorded';
    end if;
  else
    v_provider_refs_status := 'recorded';
  end if;

  if v_match_status <> 'finished' then
    return private.match_ledger_ingest_quarantine(v_run_id, v_provider, v_provider_fixture_id,
      'not_finished', v_fixture_id, v_provider_refs_status, '{}'::jsonb);
  end if;

  -- Phase 2 starts here: attach or mint canonical fixture, then player bootstrap
  -- and ledger write. All of this is one top-level statement / transaction.
  if v_fixture_resolution = 'minted' then
    insert into public.fixtures
      (competition_id, home_team_id, away_team_id, neutral_venue, kickoff_at, status, home_score, away_score)
    values
      (v_competition_id, v_home_team_id, v_away_team_id, coalesce(v_neutral_venue,false),
       v_kickoff_at, 'finished', v_home_goals_90, v_away_goals_90)
    returning id into v_fixture_id;
  end if;

  -- Third lock: re-enter 1A's fixed provider-fixture -> fixture/provider order.
  perform private.lock_match_ledger_fixture(v_provider, v_provider_fixture_id, v_fixture_id);

  if v_fixture_resolution in ('attached','minted') then
    insert into public.provider_fixture_mappings
      (fixture_id, round_game_id, provider, provider_fixture_id, mapping_status, mapping_confidence, mapped_at)
    values
      (v_fixture_id, null, v_provider, v_provider_fixture_id, 'confirmed', 1, clock_timestamp());
  end if;

  if v_fixture_resolution = 'minted' then
    insert into public.match_ledger_fixture_mints
      (fixture_id, provider, provider_fixture_id, run_id, kickoff_before)
    values
      (v_fixture_id, v_provider, v_provider_fixture_id, v_run_id, v_mint_before);
  end if;

  -- Fourth lock: exclusive player identity lock. Mapping trigger re-enters it.
  perform private.lock_canonical_identity('players', true);

  for v_player in select value from jsonb_array_elements(coalesce(p_observation->'players','[]'::jsonb))
  loop
    select private.surviving_player_id(m.player_id) into v_player_id
    from public.provider_player_mappings m
    where m.provider = v_provider and m.provider_player_id = v_player->>'provider_player_id';
    if v_player_id is null then
      v_player_name := nullif(btrim(v_player->>'provider_player_name'),'');
      insert into public.players (canonical_name)
      values (coalesce(v_player_name, 'Sportmonks player ' || (v_player->>'provider_player_id')))
      returning id into v_player_id;
      insert into public.provider_player_mappings
        (provider, provider_player_id, player_id, provider_name, mapping_status, mapping_confidence, mapping_basis)
      values
        (v_provider, v_player->>'provider_player_id', v_player_id, v_player_name, 'confirmed', 1, 'provider_native_bootstrap');
      if v_player_name is not null then
        insert into public.player_aliases (player_id, alias, alias_kind, provider, source)
        values (v_player_id, v_player_name, 'provider_spelling', v_provider, 'sportmonks_bootstrap')
        on conflict (player_id, normalized_alias) do nothing;
      end if;
      v_players_minted := v_players_minted + 1;
    end if;
    v_players := v_players || jsonb_build_array(jsonb_build_object(
      'team_id', case when v_player->>'provider_team_id' = v_provider_home_team_id then v_home_team_id else v_away_team_id end,
      'player_id', v_player_id,
      'provider_player_id', v_player->>'provider_player_id',
      'provider_player_name', v_player->>'provider_player_name',
      'lineup_role', v_player->>'lineup_role',
      'appeared', case when v_player ? 'appeared' and v_player->'appeared' <> 'null'::jsonb then (v_player->>'appeared')::boolean else null end,
      'position_code', v_player->>'position_code', 'provider_position', v_player->>'provider_position',
      'formation_position', nullif(v_player->>'formation_position','')::smallint,
      'formation_field', v_player->>'formation_field', 'shirt_number', nullif(v_player->>'shirt_number','')::smallint,
      'is_captain', case when v_player ? 'is_captain' and v_player->'is_captain' <> 'null'::jsonb then (v_player->>'is_captain')::boolean else null end,
      'minutes_played', nullif(v_player->>'minutes_played','')::smallint,
      'entered_minute', nullif(v_player->>'entered_minute','')::smallint,
      'exited_minute', nullif(v_player->>'exited_minute','')::smallint,
      'data_completeness', coalesce(v_player->>'data_completeness','partial')
    ));
  end loop;

  v_teams := jsonb_build_array(
    jsonb_build_object(
      'team_id', v_home_team_id, 'side','home','coach_id',null,'provider_coach_id',null,'provider_coach_name',null,
      'formation_nominal', (select t->>'formation_nominal' from jsonb_array_elements(p_observation->'teams') t where t->>'side'='home' limit 1),
      'lineup_status', coalesce((select t->>'lineup_status' from jsonb_array_elements(p_observation->'teams') t where t->>'side'='home' limit 1),'not_provided'),
      'substitutions_status','not_provided','events_status','not_provided',
      'statistics_status', coalesce((select t->>'statistics_status' from jsonb_array_elements(p_observation->'teams') t where t->>'side'='home' limit 1),'not_provided')
    ),
    jsonb_build_object(
      'team_id', v_away_team_id, 'side','away','coach_id',null,'provider_coach_id',null,'provider_coach_name',null,
      'formation_nominal', (select t->>'formation_nominal' from jsonb_array_elements(p_observation->'teams') t where t->>'side'='away' limit 1),
      'lineup_status', coalesce((select t->>'lineup_status' from jsonb_array_elements(p_observation->'teams') t where t->>'side'='away' limit 1),'not_provided'),
      'substitutions_status','not_provided','events_status','not_provided',
      'statistics_status', coalesce((select t->>'statistics_status' from jsonb_array_elements(p_observation->'teams') t where t->>'side'='away' limit 1),'not_provided')
    )
  );

  for v_stat in select value from jsonb_array_elements(coalesce(p_observation->'team_stats','[]'::jsonb))
  loop
    select d.id into v_stat_definition
    from public.match_ledger_stat_definitions d
    where d.provider = v_provider and d.provider_stat_type = v_stat->>'provider_stat_type'
      and d.definition_version = 'sm-2024-08';
    if v_stat_definition is null then
      raise exception 'missing stat definition for provider type %', v_stat->>'provider_stat_type';
    end if;
    v_stats := v_stats || jsonb_build_array(jsonb_build_object(
      'team_id', case when v_stat->>'provider_team_id' = v_provider_home_team_id then v_home_team_id else v_away_team_id end,
      'stat_definition_id', v_stat_definition,
      'period', coalesce(v_stat->>'period','full_time'),
      'value', (v_stat->>'value')::numeric
    ));
  end loop;

  v_ledger_payload := jsonb_build_object(
    'contract_version','kapiloto-match-ledger-observation-v1',
    'fixture_id',v_fixture_id,'provider',v_provider,'provider_fixture_id',v_provider_fixture_id,
    'provider_endpoint',v_provider_endpoint,'capture_mode',v_capture_mode,'ingest_version',v_ingest_version,
    'source_version',v_source_version,'raw_payload_sha256',v_raw_payload_sha256,'raw_observation_id',null,
    'retrieved_at',v_retrieved_at,'source_updated_at',v_source_updated_at,'kickoff_at',v_kickoff_at,
    'match_status',v_match_status,'neutral_venue',v_neutral_venue,'home_goals_90',v_home_goals_90,
    'away_goals_90',v_away_goals_90,'home_goals_aet',v_home_goals_aet,'away_goals_aet',v_away_goals_aet,
    'home_penalties',v_home_penalties,'away_penalties',v_away_penalties,
    'teams',v_teams,'players',v_players,'substitutions','[]'::jsonb,'events','[]'::jsonb,'team_stats',v_stats
  );

  select public.match_ledger_record_observation(v_ledger_payload) into v_ledger_result;
  v_observation_id := (v_ledger_result->>'observation_id')::uuid;
  v_observation_version := (v_ledger_result->>'observation_version')::integer;

  if v_ledger_result->>'status' = 'recorded' then
    insert into public.match_ledger_observation_provider_refs (observation_id, ref_kind, provider_ref)
    values
      (v_observation_id,'league',v_provider_league_id),
      (v_observation_id,'season',v_provider_season_id),
      (v_observation_id,'team_home',v_provider_home_team_id),
      (v_observation_id,'team_away',v_provider_away_team_id);
    v_provider_refs_status := 'recorded';
  end if;

  perform private.provider_ingest_append_item(
    v_run_id, v_provider, v_provider_fixture_id, v_ledger_result->>'status', null,
    v_observation_id, v_fixture_id,
    jsonb_build_object('fixture_resolution',v_fixture_resolution,'provider_refs_status',v_provider_refs_status,'players_minted',v_players_minted)
  );

  return jsonb_build_object(
    'status',v_ledger_result->>'status','reason_code',null,'fixture_id',v_fixture_id,
    'fixture_resolution',v_fixture_resolution,'observation_id',v_observation_id,
    'observation_version',v_observation_version,'provider_refs_status',v_provider_refs_status,
    'players_minted',v_players_minted
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Version selection: actual information time versus explicitly retrospective
-- training availability. The latter is never a claim about historical live
-- knowledge and is kept behind a separate public read.
-- ---------------------------------------------------------------------------

create or replace function private.match_ledger_effective_versions(
  p_provider text,
  p_cutoff timestamptz,
  p_mode text,
  p_policy text
)
returns table (
  observation_id uuid,
  fixture_id uuid,
  provider text,
  observation_version integer,
  observation_kind text,
  first_seen_at timestamptz,
  effective_available_at timestamptz,
  availability_basis text
)
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_provider is null or p_cutoff is null then raise exception 'provider and cutoff are required'; end if;
  if p_mode not in ('actual','retrospective_training') then raise exception 'unsupported availability mode'; end if;
  if p_mode = 'retrospective_training' and p_policy <> 'kapiloto-retrospective-training-availability-v1' then
    raise exception 'unsupported retrospective training availability policy';
  end if;
  if p_mode = 'actual' and p_policy is not null then raise exception 'actual mode does not accept an availability policy'; end if;

  return query
  with timed as (
    select o.*,
      case when p_mode = 'retrospective_training'
             and o.capture_mode = 'backfill' and o.observation_kind = 'observation'
             and o.match_status = 'finished' and o.observation_version = 1
           then least(o.first_seen_at, o.kickoff_at + interval '24 hours')
           else o.first_seen_at end as effective_at,
      case when p_mode = 'retrospective_training'
             and o.capture_mode = 'backfill' and o.observation_kind = 'observation'
             and o.match_status = 'finished' and o.observation_version = 1
             and o.kickoff_at + interval '24 hours' < o.first_seen_at
           then 'retrospective_backfill' else 'actual' end as basis
    from public.match_ledger_observations o
    where o.provider = p_provider
  ), ranked as (
    select t.*, row_number() over (partition by t.fixture_id, t.provider order by t.observation_version desc) as rn
    from timed t where t.effective_at <= p_cutoff
  )
  select r.id, r.fixture_id, r.provider, r.observation_version, r.observation_kind,
         r.first_seen_at, r.effective_at, r.basis
  from ranked r where r.rn = 1;
end;
$$;

create or replace function private.match_ledger_team_match_stats_read(
  p_provider text,
  p_competition_ids uuid[],
  p_from timestamptz,
  p_cutoff timestamptz,
  p_mode text,
  p_policy text
)
returns table (
  contract_version text,
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
language sql
stable
set search_path = ''
as $$
  with selected as (
    select * from private.match_ledger_effective_versions(p_provider,p_cutoff,p_mode,p_policy)
    where observation_kind = 'observation'
  ), base as (
    select s.*, o.capture_mode, o.ingest_version, o.kickoff_at, o.match_status, o.neutral_venue,
      o.home_goals_90, o.away_goals_90, o.home_goals_aet, o.away_goals_aet, o.home_penalties, o.away_penalties,
      f.competition_id, f.season_key,
      tr.team_id, tr.opponent_team_id, tr.side, tr.lineup_status, tr.statistics_status,
      (o.home_goals_aet is not null or o.home_penalties is not null) as went_extra
    from selected s
    join public.match_ledger_observations o on o.id=s.observation_id
    join public.fixtures f on f.id=o.fixture_id
    join public.match_ledger_team_records tr on tr.observation_id=o.id
    where o.match_status='finished' and o.kickoff_at >= p_from and o.kickoff_at < p_cutoff
      and (p_competition_ids is null or cardinality(p_competition_ids)=0 or f.competition_id = any(p_competition_ids))
  ), keys as (
    select * from (values
      ('expected_goals'::text),('expected_goals_on_target'),('expected_non_penalty_goals'),
      ('shots_total'),('shots_on_target'),('possession_pct'),('corners')
    ) k(stat_key)
  )
  select
    'kapiloto-team-match-stats-v1'::text,
    b.fixture_id,b.team_id,b.opponent_team_id,b.side,b.neutral_venue,b.competition_id,b.season_key,
    (select r.provider_ref from public.match_ledger_observation_provider_refs r where r.observation_id=b.observation_id and r.ref_kind='league'),
    (select r.provider_ref from public.match_ledger_observation_provider_refs r where r.observation_id=b.observation_id and r.ref_kind='season'),
    b.provider,b.observation_id,b.observation_version,b.capture_mode,b.ingest_version,b.kickoff_at,b.first_seen_at,b.effective_available_at,
    b.availability_basis,case when p_mode='actual' then null else p_policy end,
    case when p_mode='actual' then 'actual' else 'retrospective' end,
    b.match_status,
    case when b.side='home' then b.home_goals_90 else b.away_goals_90 end,
    case when b.side='home' then b.away_goals_90 else b.home_goals_90 end,
    b.went_extra,
    case when b.side='home' then b.home_penalties else b.away_penalties end,
    case when b.side='home' then b.away_penalties else b.home_penalties end,
    (select jsonb_object_agg(k.stat_key, jsonb_build_object(
      'value', case when status='observed' then value_numeric else null end,
      'status',status,'definition_id',definition_id,'provider_stat_type',provider_stat_type,
      'definition_version',definition_version,'period',period
    ) order by k.stat_key)
     from keys k
     left join lateral (
       select ts.value_numeric, d.id as definition_id, d.provider_stat_type, d.definition_version, ts.period,
         case when b.went_extra then 'not_separable'
              when b.statistics_status='not_provided' then 'family_not_provided'
              when ts.id is null then 'not_observed' else 'observed' end as status
       from public.match_ledger_stat_definitions d
       left join public.match_ledger_team_stats ts on ts.stat_definition_id=d.id and ts.observation_id=b.observation_id and ts.team_id=b.team_id and ts.period='full_time'
       where d.provider=b.provider and d.definition_version='sm-2024-08' and d.stat_key=k.stat_key
       limit 1
     ) own on true),
    (select jsonb_object_agg(k.stat_key, jsonb_build_object(
      'value', case when status='observed' then value_numeric else null end,
      'status',status,'definition_id',definition_id,'provider_stat_type',provider_stat_type,
      'definition_version',definition_version,'period',period
    ) order by k.stat_key)
     from keys k
     left join lateral (
       select ts.value_numeric, d.id as definition_id, d.provider_stat_type, d.definition_version, ts.period,
         case when b.went_extra then 'not_separable'
              when otr.statistics_status='not_provided' then 'family_not_provided'
              when ts.id is null then 'not_observed' else 'observed' end as status
       from public.match_ledger_stat_definitions d
       left join public.match_ledger_team_stats ts on ts.stat_definition_id=d.id and ts.observation_id=b.observation_id and ts.team_id=b.opponent_team_id and ts.period='full_time'
       join public.match_ledger_team_records otr on otr.observation_id=b.observation_id and otr.team_id=b.opponent_team_id
       where d.provider=b.provider and d.definition_version='sm-2024-08' and d.stat_key=k.stat_key
       limit 1
     ) opp on true),
    b.lineup_status,b.statistics_status,
    case when b.went_extra then array['stats_not_separable_extra_time']::text[] else '{}'::text[] end
  from base b
  order by b.kickoff_at, b.fixture_id, b.side;
$$;

create or replace function public.match_ledger_team_match_stats_as_of(
  p_provider text,
  p_competition_ids uuid[],
  p_from timestamptz,
  p_cutoff timestamptz
)
returns table (
  contract_version text, fixture_id uuid, team_id uuid, opponent_team_id uuid, side text, neutral_venue boolean,
  competition_id uuid, season_key text, provider_league_ref text, provider_season_ref text, provider text,
  observation_id uuid, observation_version integer, capture_mode text, ingest_version text, kickoff_at timestamptz,
  first_seen_at timestamptz, effective_available_at timestamptz, availability_basis text, availability_policy text,
  evaluation_class text, match_status text, goals_for_90 smallint, goals_against_90 smallint, went_to_extra_time boolean,
  penalties_for smallint, penalties_against smallint, stats_for jsonb, stats_against jsonb, lineup_status text,
  statistics_status text, quality_flags text[]
)
language sql
stable
set search_path = ''
as $$
  select * from private.match_ledger_team_match_stats_read(p_provider,p_competition_ids,p_from,p_cutoff,'actual',null)
$$;

create or replace function public.match_ledger_team_match_stats_for_training(
  p_provider text,
  p_competition_ids uuid[],
  p_from timestamptz,
  p_training_cutoff timestamptz,
  p_policy text
)
returns table (
  contract_version text, fixture_id uuid, team_id uuid, opponent_team_id uuid, side text, neutral_venue boolean,
  competition_id uuid, season_key text, provider_league_ref text, provider_season_ref text, provider text,
  observation_id uuid, observation_version integer, capture_mode text, ingest_version text, kickoff_at timestamptz,
  first_seen_at timestamptz, effective_available_at timestamptz, availability_basis text, availability_policy text,
  evaluation_class text, match_status text, goals_for_90 smallint, goals_against_90 smallint, went_to_extra_time boolean,
  penalties_for smallint, penalties_against smallint, stats_for jsonb, stats_against jsonb, lineup_status text,
  statistics_status text, quality_flags text[]
)
language sql
stable
set search_path = ''
as $$
  select * from private.match_ledger_team_match_stats_read(p_provider,p_competition_ids,p_from,p_training_cutoff,'retrospective_training',p_policy)
$$;

-- ---------------------------------------------------------------------------
-- Security: V4 service-only boundary
-- ---------------------------------------------------------------------------

alter table public.provider_ingest_runs enable row level security;
alter table public.provider_ingest_items enable row level security;
alter table public.match_ledger_fixture_mints enable row level security;
alter table public.match_ledger_observation_provider_refs enable row level security;

revoke all on table public.provider_ingest_runs from public, anon, authenticated;
revoke all on table public.provider_ingest_items from public, anon, authenticated;
revoke all on table public.match_ledger_fixture_mints from public, anon, authenticated;
revoke all on table public.match_ledger_observation_provider_refs from public, anon, authenticated;

grant select, insert on table public.provider_ingest_runs to service_role;
grant select, insert on table public.provider_ingest_items to service_role;
grant select, insert on table public.match_ledger_fixture_mints to service_role;
grant select, insert on table public.match_ledger_observation_provider_refs to service_role;

revoke all on function private.prepare_match_ledger_observation_provider_ref() from public, anon, authenticated;
revoke all on function private.provider_ingest_append_item(uuid,text,text,text,text,uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function private.match_ledger_ingest_quarantine(uuid,text,text,text,uuid,text,jsonb) from public, anon, authenticated;
revoke all on function private.match_ledger_effective_versions(text,timestamptz,text,text) from public, anon, authenticated;
revoke all on function private.match_ledger_team_match_stats_read(text,uuid[],timestamptz,timestamptz,text,text) from public, anon, authenticated;
revoke all on function public.provider_ingest_record_failure(uuid,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.match_ledger_ingest_provider_fixture(jsonb) from public, anon, authenticated;
revoke all on function public.match_ledger_team_match_stats_as_of(text,uuid[],timestamptz,timestamptz) from public, anon, authenticated;
revoke all on function public.match_ledger_team_match_stats_for_training(text,uuid[],timestamptz,timestamptz,text) from public, anon, authenticated;

grant execute on function private.prepare_match_ledger_observation_provider_ref() to service_role;
grant execute on function private.provider_ingest_append_item(uuid,text,text,text,text,uuid,uuid,jsonb) to service_role;
grant execute on function private.match_ledger_ingest_quarantine(uuid,text,text,text,uuid,text,jsonb) to service_role;
grant execute on function private.match_ledger_effective_versions(text,timestamptz,text,text) to service_role;
grant execute on function private.match_ledger_team_match_stats_read(text,uuid[],timestamptz,timestamptz,text,text) to service_role;
grant execute on function public.provider_ingest_record_failure(uuid,text,text,text,jsonb) to service_role;
grant execute on function public.match_ledger_ingest_provider_fixture(jsonb) to service_role;
grant execute on function public.match_ledger_team_match_stats_as_of(text,uuid[],timestamptz,timestamptz) to service_role;
grant execute on function public.match_ledger_team_match_stats_for_training(text,uuid[],timestamptz,timestamptz,text) to service_role;

comment on table public.match_ledger_observation_provider_refs is
  'Immutable identity-critical provider refs sealed to one Match Ledger observation version. Drift is quarantined by D-056 instead of mutating or silently versioning outside the V1 content hash.';
comment on table public.match_ledger_fixture_mints is
  'Audit of canonical fixtures minted by the provider-native ingest RPC under an explicit operator cutoff policy.';
comment on function public.match_ledger_team_match_stats_for_training(text,uuid[],timestamptz,timestamptz,text) is
  'RETROSPECTIVE TRAINING ONLY. Backfill availability is an approximation over finalized data, not a reconstruction of what Kapiloto/provider knew live.';
