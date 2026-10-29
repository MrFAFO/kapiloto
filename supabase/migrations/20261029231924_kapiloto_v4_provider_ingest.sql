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
