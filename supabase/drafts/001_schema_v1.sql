-- Kapiloto Schema v1 DRAFT
-- This file is intentionally NOT a migration history entry.
-- It has not been applied to a Supabase project yet.
-- When the project exists, iterate with execute_sql, run advisors/tests,
-- then generate the real migration through the Supabase CLI workflow.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (char_length(trim(username)) between 3 and 40),
  normalized_username text generated always as (lower(trim(username))) stored,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index profiles_normalized_username_uq
  on public.profiles (normalized_username);

create table private.auth_username_aliases (
  normalized_username text primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  preferred_auth_identifier text not null,
  identifier_type text not null check (identifier_type in ('email', 'phone')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Groups
-- ---------------------------------------------------------------------------

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 80),
  owner_user_id uuid not null references auth.users(id),
  join_code text not null unique,
  join_code_rotated_at timestamptz,
  default_max_doubles smallint not null default 7
    check (default_max_doubles between 0 and 16),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  status text not null default 'active'
    check (status in ('active', 'left', 'removed', 'suspended')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (group_id, user_id)
);

create index group_members_user_active_idx
  on public.group_members (user_id, group_id)
  where status = 'active';

create table public.join_requests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id),
  unique (group_id, user_id, status)
);

create index join_requests_group_pending_idx
  on public.join_requests (group_id, requested_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- Canonical football data
-- ---------------------------------------------------------------------------

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  country_code text,
  created_at timestamptz not null default now()
);

create table public.provider_team_mappings (
  provider text not null,
  provider_team_id text not null,
  team_id uuid not null references public.teams(id) on delete cascade,
  provider_name text,
  mapping_status text not null default 'confirmed'
    check (mapping_status in ('unverified', 'confirmed', 'manual_override')),
  mapping_confidence numeric(5,4)
    check (mapping_confidence is null or mapping_confidence between 0 and 1),
  last_verified_at timestamptz,
  primary key (provider, provider_team_id)
);

create index provider_team_mappings_team_idx
  on public.provider_team_mappings (team_id);

create table public.competitions (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  country_code text,
  competition_type text,
  created_at timestamptz not null default now()
);

create table public.provider_competition_mappings (
  provider text not null,
  provider_competition_id text not null,
  competition_id uuid not null references public.competitions(id) on delete cascade,
  provider_name text,
  mapping_status text not null default 'confirmed'
    check (mapping_status in ('unverified', 'confirmed', 'manual_override')),
  last_verified_at timestamptz,
  primary key (provider, provider_competition_id)
);

-- ---------------------------------------------------------------------------
-- Toto rounds and fixtures
-- ---------------------------------------------------------------------------

create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  external_round_number text not null,
  starts_at timestamptz,
  lock_at timestamptz not null,
  status text not null default 'upcoming'
    check (status in (
      'upcoming', 'open', 'locked', 'live', 'finished', 'settled', 'under_review'
    )),
  source text not null,
  source_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_round_number)
);

create index rounds_lock_at_idx on public.rounds (lock_at);
create index rounds_status_idx on public.rounds (status);

create table public.round_games (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  game_number smallint not null check (game_number between 1 and 16),
  home_team_id uuid not null references public.teams(id),
  away_team_id uuid not null references public.teams(id),
  competition_id uuid references public.competitions(id),
  competition_name_snapshot text not null,
  kickoff_at timestamptz not null,
  status text not null default 'upcoming'
    check (status in (
      'upcoming', 'live', 'halftime', 'finished', 'postponed',
      'cancelled', 'suspended', 'under_review'
    )),
  field_home_score smallint check (field_home_score is null or field_home_score >= 0),
  field_away_score smallint check (field_away_score is null or field_away_score >= 0),
  field_outcome text check (field_outcome is null or field_outcome in ('1', 'X', '2')),
  pool_settlement_outcome text
    check (pool_settlement_outcome is null or pool_settlement_outcome in ('1', 'X', '2')),
  settlement_status text not null default 'pending'
    check (settlement_status in ('pending', 'under_review', 'settled', 'void')),
  settlement_rule text,
  settlement_source text,
  settlement_confirmed_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (round_id, game_number),
  check (home_team_id <> away_team_id)
);

create index round_games_round_kickoff_idx
  on public.round_games (round_id, kickoff_at);

create table public.provider_fixture_mappings (
  round_game_id uuid not null references public.round_games(id) on delete cascade,
  provider text not null,
  provider_fixture_id text not null,
  mapping_status text not null default 'confirmed'
    check (mapping_status in ('unverified', 'confirmed', 'manual_override')),
  mapping_confidence numeric(5,4)
    check (mapping_confidence is null or mapping_confidence between 0 and 1),
  mapped_at timestamptz not null default now(),
  mapped_by uuid references auth.users(id),
  primary key (provider, provider_fixture_id),
  unique (round_game_id, provider)
);

-- ---------------------------------------------------------------------------
-- Group round settings
-- ---------------------------------------------------------------------------

create table public.group_round_settings (
  group_id uuid not null references public.groups(id) on delete cascade,
  round_id uuid not null references public.rounds(id) on delete cascade,
  max_doubles smallint not null check (max_doubles between 0 and 16),
  consensus_double_policy text not null default 'up_to_max'
    check (consensus_double_policy in ('up_to_max', 'exact_max')),
  visibility_policy text not null default 'after_own_submission'
    check (visibility_policy in ('after_own_submission', 'after_round_lock', 'immediate')),
  created_from_group_defaults_at timestamptz not null default now(),
  locked_at timestamptz,
  primary key (group_id, round_id)
);

-- ---------------------------------------------------------------------------
-- Current editable tickets + immutable submission snapshots
-- ---------------------------------------------------------------------------

create table public.user_tickets (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  round_id uuid not null references public.rounds(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  state text not null default 'draft'
    check (state in ('draft', 'submitted', 'locked')),
  revision bigint not null default 0 check (revision >= 0),
  submitted_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, round_id, user_id)
);

create index user_tickets_user_round_idx
  on public.user_tickets (user_id, round_id);

create index user_tickets_group_round_state_idx
  on public.user_tickets (group_id, round_id, state);

create table public.user_ticket_picks (
  user_ticket_id uuid not null references public.user_tickets(id) on delete cascade,
  round_game_id uuid not null references public.round_games(id) on delete cascade,
  pick text not null check (pick in ('1', 'X', '2', '1X', 'X2', '12')),
  updated_at timestamptz not null default now(),
  primary key (user_ticket_id, round_game_id)
);

create table public.ticket_versions (
  id uuid primary key default gen_random_uuid(),
  user_ticket_id uuid not null references public.user_tickets(id) on delete cascade,
  version_no integer not null check (version_no > 0),
  state_at_snapshot text not null
    check (state_at_snapshot in ('submitted', 'locked')),
  submitted_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_ticket_id, version_no)
);

create index ticket_versions_ticket_latest_idx
  on public.ticket_versions (user_ticket_id, version_no desc);

create table public.ticket_version_picks (
  ticket_version_id uuid not null references public.ticket_versions(id) on delete cascade,
  round_game_id uuid not null references public.round_games(id) on delete cascade,
  pick text not null check (pick in ('1', 'X', '2', '1X', 'X2', '12')),
  primary key (ticket_version_id, round_game_id)
);

-- ---------------------------------------------------------------------------
-- Consensus
-- ---------------------------------------------------------------------------

create table public.consensus_versions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  round_id uuid not null references public.rounds(id) on delete cascade,
  generated_by uuid not null references auth.users(id),
  algorithm_version text not null,
  source_submission_count integer not null check (source_submission_count >= 0),
  generated_at timestamptz not null default now(),
  is_current boolean not null default true,
  stale_at timestamptz,
  stale_reason text
);

create unique index consensus_one_current_uq
  on public.consensus_versions (group_id, round_id)
  where is_current;

create table public.consensus_source_submissions (
  consensus_version_id uuid not null references public.consensus_versions(id) on delete cascade,
  ticket_version_id uuid not null references public.ticket_versions(id) on delete restrict,
  primary key (consensus_version_id, ticket_version_id)
);

create table public.consensus_picks (
  consensus_version_id uuid not null references public.consensus_versions(id) on delete cascade,
  round_game_id uuid not null references public.round_games(id) on delete cascade,
  pick text not null check (pick in ('1', 'X', '2', '1X', 'X2', '12')),
  support_1 numeric(7,6) not null check (support_1 between 0 and 1),
  support_x numeric(7,6) not null check (support_x between 0 and 1),
  support_2 numeric(7,6) not null check (support_2 between 0 and 1),
  chosen_coverage numeric(7,6)
    check (chosen_coverage is null or chosen_coverage between 0 and 1),
  double_gain_score double precision,
  primary key (consensus_version_id, round_game_id),
  check (abs((support_1 + support_x + support_2) - 1.0) < 0.00001)
);

-- ---------------------------------------------------------------------------
-- Scoring
-- ---------------------------------------------------------------------------

create table public.ticket_pick_results (
  ticket_version_id uuid not null references public.ticket_versions(id) on delete cascade,
  round_game_id uuid not null references public.round_games(id) on delete cascade,
  evaluation_state text not null
    check (evaluation_state in (
      'pending', 'currently_hit', 'currently_miss',
      'hit', 'miss', 'void', 'under_review'
    )),
  is_hit boolean,
  evaluated_outcome text check (evaluated_outcome is null or evaluated_outcome in ('1', 'X', '2')),
  evaluated_at timestamptz not null default now(),
  primary key (ticket_version_id, round_game_id)
);

create table public.consensus_pick_results (
  consensus_version_id uuid not null references public.consensus_versions(id) on delete cascade,
  round_game_id uuid not null references public.round_games(id) on delete cascade,
  evaluation_state text not null
    check (evaluation_state in (
      'pending', 'currently_hit', 'currently_miss',
      'hit', 'miss', 'void', 'under_review'
    )),
  is_hit boolean,
  evaluated_outcome text check (evaluated_outcome is null or evaluated_outcome in ('1', 'X', '2')),
  evaluated_at timestamptz not null default now(),
  primary key (consensus_version_id, round_game_id)
);

-- ---------------------------------------------------------------------------
-- Kapiloto fixture research
-- ---------------------------------------------------------------------------

create table public.kapiloto_analyses (
  id uuid primary key default gen_random_uuid(),
  round_game_id uuid not null references public.round_games(id) on delete cascade,
  analysis_version integer not null check (analysis_version > 0),
  is_current boolean not null default true,
  status text not null default 'fresh'
    check (status in ('researching', 'fresh', 'stale', 'failed')),
  primary_pick text check (primary_pick is null or primary_pick in ('1', 'X', '2')),
  suggested_double text
    check (suggested_double is null or suggested_double in ('1X', 'X2', '12')),
  double_recommended boolean,
  double_priority_rank smallint
    check (double_priority_rank is null or double_priority_rank between 1 and 16),
  double_priority_budget smallint
    check (double_priority_budget is null or double_priority_budget between 0 and 16),
  confidence text check (confidence is null or confidence in ('low', 'medium', 'medium_high', 'high')),
  score_1 numeric(10,6) check (score_1 is null or score_1 >= 0),
  score_x numeric(10,6) check (score_x is null or score_x >= 0),
  score_2 numeric(10,6) check (score_2 is null or score_2 >= 0),
  summary text,
  main_risk text,
  generated_at timestamptz not null default now(),
  valid_until timestamptz,
  stale_at timestamptz,
  stale_reason text,
  model_key text,
  research_protocol_version text not null,
  unique (round_game_id, analysis_version)
);

create unique index kapiloto_one_current_analysis_uq
  on public.kapiloto_analyses (round_game_id)
  where is_current;

create index kapiloto_analyses_freshness_idx
  on public.kapiloto_analyses (round_game_id, status, valid_until);

create table public.kapiloto_factors (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.kapiloto_analyses(id) on delete cascade,
  factor_type text not null,
  text text not null,
  direction text check (direction is null or direction in ('home', 'draw', 'away', 'neutral', 'risk')),
  importance smallint check (importance is null or importance between 1 and 5)
);

create table public.kapiloto_sources (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.kapiloto_analyses(id) on delete cascade,
  title text not null,
  url text not null,
  publisher text,
  source_type text,
  published_at timestamptz,
  accessed_at timestamptz not null default now(),
  trust_tier smallint check (trust_tier is null or trust_tier between 1 and 5)
);

create table public.kapiloto_analysis_inputs (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.kapiloto_analyses(id) on delete cascade,
  input_type text not null,
  input_version text,
  metadata jsonb not null default '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Diego proposals
-- ---------------------------------------------------------------------------

create table public.diego_ticket_proposals (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  round_id uuid not null references public.rounds(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_ticket_id uuid references public.user_tickets(id) on delete set null,
  max_doubles smallint not null check (max_doubles between 0 and 16),
  generated_at timestamptz not null default now(),
  model_key text,
  optimizer_version text not null,
  status text not null default 'ready'
    check (status in ('generating', 'ready', 'applied', 'discarded', 'stale', 'failed'))
);

create index diego_proposals_user_round_idx
  on public.diego_ticket_proposals (user_id, round_id, generated_at desc);

create table public.diego_ticket_proposal_inputs (
  proposal_id uuid not null references public.diego_ticket_proposals(id) on delete cascade,
  round_game_id uuid not null references public.round_games(id) on delete cascade,
  analysis_id uuid not null references public.kapiloto_analyses(id) on delete restrict,
  analysis_version integer not null,
  primary key (proposal_id, round_game_id)
);

create table public.diego_ticket_proposal_picks (
  proposal_id uuid not null references public.diego_ticket_proposals(id) on delete cascade,
  round_game_id uuid not null references public.round_games(id) on delete cascade,
  current_pick text check (current_pick is null or current_pick in ('1', 'X', '2', '1X', 'X2', '12')),
  proposed_pick text not null check (proposed_pick in ('1', 'X', '2', '1X', 'X2', '12')),
  change_reason text,
  rank smallint,
  marginal_coverage_value double precision,
  primary key (proposal_id, round_game_id)
);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

create table public.admin_audit_log (
  id bigint generated always as identity primary key,
  group_id uuid references public.groups(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index admin_audit_log_group_time_idx
  on public.admin_audit_log (group_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Cross-table invariant triggers
-- ---------------------------------------------------------------------------

create or replace function private.validate_current_ticket_pick()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ticket_round uuid;
  game_round uuid;
  ticket_group uuid;
  max_allowed integer;
  existing_doubles integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_ticket_id::text, 0));

  select t.round_id, t.group_id
    into ticket_round, ticket_group
  from public.user_tickets t
  where t.id = new.user_ticket_id;

  select g.round_id
    into game_round
  from public.round_games g
  where g.id = new.round_game_id;

  if ticket_round is null or game_round is null or ticket_round <> game_round then
    raise exception 'ticket and fixture must belong to the same round';
  end if;

  select s.max_doubles
    into max_allowed
  from public.group_round_settings s
  where s.group_id = ticket_group
    and s.round_id = ticket_round;

  if max_allowed is null then
    raise exception 'group round settings are missing';
  end if;

  select count(*)
    into existing_doubles
  from public.user_ticket_picks p
  where p.user_ticket_id = new.user_ticket_id
    and p.round_game_id <> new.round_game_id
    and p.pick in ('1X', 'X2', '12');

  if new.pick in ('1X', 'X2', '12') then
    existing_doubles := existing_doubles + 1;
  end if;

  if existing_doubles > max_allowed then
    raise exception 'maximum doubles exceeded';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger user_ticket_picks_validate_before_write
before insert or update on public.user_ticket_picks
for each row execute function private.validate_current_ticket_pick();

create or replace function private.validate_version_pick_round()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ticket_round uuid;
  game_round uuid;
begin
  select t.round_id
    into ticket_round
  from public.ticket_versions v
  join public.user_tickets t on t.id = v.user_ticket_id
  where v.id = new.ticket_version_id;

  select g.round_id
    into game_round
  from public.round_games g
  where g.id = new.round_game_id;

  if ticket_round is null or game_round is null or ticket_round <> game_round then
    raise exception 'ticket version and fixture must belong to the same round';
  end if;

  return new;
end;
$$;

create trigger ticket_version_picks_validate_before_write
before insert or update on public.ticket_version_picks
for each row execute function private.validate_version_pick_round();

-- Submission snapshots are created through a transaction-safe application/RPC
-- operation that:
-- 1) checks ownership and expected revision;
-- 2) verifies the round is still before lock_at;
-- 3) requires exactly 16 picks;
-- 4) creates ticket_versions + ticket_version_picks;
-- 5) updates user_tickets.state/submitted_at/revision;
-- 6) marks an existing consensus stale if its source set is now outdated.
