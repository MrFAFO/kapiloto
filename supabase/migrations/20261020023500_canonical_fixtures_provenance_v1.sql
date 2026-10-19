-- Canonical football fixture identity + structured fact provenance foundation.
-- This separates a football match from a Toto round row while preserving
-- round_games as the Toto-specific orientation/settlement record.

-- ---------------------------------------------------------------------------
-- Canonical fixtures
-- ---------------------------------------------------------------------------

create table public.fixtures (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid references public.competitions(id) on delete restrict,
  home_team_id uuid not null references public.teams(id) on delete restrict,
  away_team_id uuid not null references public.teams(id) on delete restrict,
  season_key text,
  stage_name text,
  round_name text,
  leg_number smallint check (leg_number is null or leg_number > 0),
  neutral_venue boolean not null default false,
  kickoff_at timestamptz not null,
  actual_kickoff_at timestamptz,
  status text not null default 'upcoming'
    check (status in (
      'upcoming', 'live', 'halftime', 'finished', 'postponed',
      'cancelled', 'suspended', 'under_review'
    )),
  home_score smallint check (home_score is null or home_score >= 0),
  away_score smallint check (away_score is null or away_score >= 0),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (home_team_id <> away_team_id)
);

create index fixtures_kickoff_idx
  on public.fixtures (kickoff_at);

create index fixtures_competition_kickoff_idx
  on public.fixtures (competition_id, kickoff_at);

create index fixtures_teams_kickoff_idx
  on public.fixtures (home_team_id, away_team_id, kickoff_at);

-- round_games remains the Toto row. Its football identity now points at the
-- canonical fixture. Existing football columns remain compatibility snapshots
-- until callers are migrated to fixtures.
alter table public.round_games
  add column fixture_id uuid references public.fixtures(id) on delete restrict;

-- Backfill safely for installations that already contain Toto rows. Reusing the
-- round_game UUID avoids a temporary mapping table while preserving identity.
insert into public.fixtures (
  id,
  competition_id,
  home_team_id,
  away_team_id,
  stage_name,
  leg_number,
  neutral_venue,
  kickoff_at,
  actual_kickoff_at,
  status,
  home_score,
  away_score,
  last_synced_at,
  created_at,
  updated_at
)
select
  rg.id,
  rg.competition_id,
  rg.home_team_id,
  rg.away_team_id,
  rg.competition_stage_snapshot,
  rg.leg_number,
  rg.neutral_venue,
  rg.kickoff_at,
  rg.actual_kickoff_at,
  rg.status,
  rg.field_home_score,
  rg.field_away_score,
  rg.last_synced_at,
  rg.created_at,
  rg.created_at
from public.round_games rg
where rg.fixture_id is null
on conflict (id) do nothing;

update public.round_games
set fixture_id = id
where fixture_id is null;

alter table public.round_games
  alter column fixture_id set not null;

create index round_games_fixture_idx
  on public.round_games (fixture_id);

-- ---------------------------------------------------------------------------
-- Move provider fixture identity to canonical fixtures
-- ---------------------------------------------------------------------------

alter table public.provider_fixture_mappings
  add column fixture_id uuid references public.fixtures(id) on delete cascade;

update public.provider_fixture_mappings pfm
set fixture_id = rg.fixture_id
from public.round_games rg
where pfm.round_game_id = rg.id
  and pfm.fixture_id is null;

alter table public.provider_fixture_mappings
  alter column fixture_id set not null;

alter table public.provider_fixture_mappings
  drop constraint if exists provider_fixture_mappings_round_game_id_provider_key;

alter table public.provider_fixture_mappings
  drop constraint if exists provider_fixture_mappings_round_game_id_fkey;

alter table public.provider_fixture_mappings
  alter column round_game_id drop not null;

alter table public.provider_fixture_mappings
  add constraint provider_fixture_mappings_round_game_id_fkey
  foreign key (round_game_id)
  references public.round_games(id)
  on delete set null;

alter table public.provider_fixture_mappings
  add constraint provider_fixture_mappings_fixture_provider_key
  unique (fixture_id, provider);

create index provider_fixture_mappings_fixture_idx
  on public.provider_fixture_mappings (fixture_id);

-- ---------------------------------------------------------------------------
-- Market snapshots are fixture-scoped, not Toto-scoped
-- ---------------------------------------------------------------------------

alter table public.fixture_market_snapshots
  add column fixture_id uuid references public.fixtures(id) on delete cascade;

update public.fixture_market_snapshots fms
set fixture_id = rg.fixture_id
from public.round_games rg
where fms.round_game_id = rg.id
  and fms.fixture_id is null;

alter table public.fixture_market_snapshots
  alter column fixture_id set not null;

alter table public.fixture_market_snapshots
  drop constraint if exists fixture_market_snapshots_round_game_id_fkey;

alter table public.fixture_market_snapshots
  alter column round_game_id drop not null;

alter table public.fixture_market_snapshots
  add constraint fixture_market_snapshots_round_game_id_fkey
  foreign key (round_game_id)
  references public.round_games(id)
  on delete set null;

-- Keep the existing (id, round_game_id) unique constraint because the current
-- round-scoped Kapiloto analysis FK still references it during this transition.

create index fixture_market_snapshots_fixture_time_idx
  on public.fixture_market_snapshots (fixture_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- Immutable structured fact provenance
-- ---------------------------------------------------------------------------

create table public.fixture_fact_snapshots (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.fixtures(id) on delete cascade,
  fact_key text not null check (char_length(trim(fact_key)) between 1 and 160),
  subject_type text not null
    check (subject_type in ('fixture', 'team', 'player')),
  subject_team_id uuid references public.teams(id) on delete restrict,
  subject_ref text,
  value_numeric numeric,
  value_text text,
  value_boolean boolean,
  value_json jsonb,
  unit text,
  provenance_type text not null
    check (provenance_type in ('provider_raw', 'deterministic_derived')),
  provider text,
  provider_endpoint text,
  provider_record_id text,
  calculation_version text,
  source_observed_at timestamptz,
  captured_at timestamptz not null default now(),
  source_version text,
  source_fingerprint text,
  metadata jsonb not null default '{}'::jsonb,
  check (
    num_nonnulls(value_numeric, value_text, value_boolean, value_json) = 1
  ),
  check (
    (provenance_type = 'provider_raw'
      and provider is not null
      and calculation_version is null)
    or
    (provenance_type = 'deterministic_derived'
      and calculation_version is not null)
  ),
  check (
    subject_type <> 'team' or subject_team_id is not null
  )
);

create index fixture_fact_snapshots_fixture_fact_time_idx
  on public.fixture_fact_snapshots (fixture_id, fact_key, captured_at desc);

create index fixture_fact_snapshots_team_fact_time_idx
  on public.fixture_fact_snapshots (subject_team_id, fact_key, captured_at desc)
  where subject_team_id is not null;

create unique index fixture_fact_snapshots_source_fingerprint_uq
  on public.fixture_fact_snapshots (
    fixture_id,
    provenance_type,
    source_fingerprint
  )
  where source_fingerprint is not null;

create table public.fixture_fact_inputs (
  derived_fact_id uuid not null
    references public.fixture_fact_snapshots(id) on delete cascade,
  input_fact_id uuid not null
    references public.fixture_fact_snapshots(id) on delete restrict,
  input_role text,
  primary key (derived_fact_id, input_fact_id),
  check (derived_fact_id <> input_fact_id)
);

create index fixture_fact_inputs_input_idx
  on public.fixture_fact_inputs (input_fact_id);

create or replace function private.reject_fixture_fact_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'fixture fact snapshots are immutable';
end;
$$;

create trigger fixture_fact_snapshots_immutable
before update or delete on public.fixture_fact_snapshots
for each row execute function private.reject_fixture_fact_change();

create trigger fixture_fact_inputs_immutable
before update or delete on public.fixture_fact_inputs
for each row execute function private.reject_fixture_fact_change();

-- Public-schema security: canonical fixtures are client-readable reference
-- data; raw/derived fact provenance stays server-side.
alter table public.fixtures enable row level security;
alter table public.fixture_fact_snapshots enable row level security;
alter table public.fixture_fact_inputs enable row level security;

grant select on public.fixtures to authenticated;

create policy fixtures_select_authenticated
on public.fixtures
for select
to authenticated
using (true);

comment on table public.fixtures is
  'Canonical football match identity shared by Toto, match intelligence and future products.';

comment on column public.round_games.fixture_id is
  'Canonical fixture. round_games is the Toto-specific row/orientation/settlement wrapper.';

comment on table public.fixture_fact_snapshots is
  'Immutable structured facts with explicit raw-provider or deterministic-derived provenance. AI inference is stored separately in Kapiloto analysis tables.';

comment on table public.fixture_fact_inputs is
  'Provenance edges from deterministic derived facts to the immutable fact snapshots used as inputs.';
