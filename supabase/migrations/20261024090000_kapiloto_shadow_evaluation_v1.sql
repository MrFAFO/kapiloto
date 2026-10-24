-- Kapiloto Research v2, Phase 1: shadow evaluation foundations.
--
-- Shadow mode: nothing in this migration is read by research, grounding,
-- derivation, finalization, publication RPCs or the public UI. These tables
-- are server-only evaluation data (no anon/authenticated grants or policies).
--
-- 1. football_match_results   league-wide regular-time results for B2/B3
-- 2. fixture_market_quotes    raw per-bookmaker 1X2 prices for B4
-- 3. kapiloto_eval_predictions  append-only predictions of every arm
-- 4. kapiloto_eval_scores       append-only scored selections

create or replace function private.kapiloto_eval_reject_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are immutable', tg_table_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. League-wide historical results (provider-scoped identities)
-- ---------------------------------------------------------------------------

create table public.football_match_results (
  id uuid primary key default gen_random_uuid(),
  provider text not null
    check (char_length(trim(provider)) between 1 and 40),
  provider_fixture_id text not null
    check (char_length(trim(provider_fixture_id)) between 1 and 80),
  provider_competition_id text not null
    check (char_length(trim(provider_competition_id)) between 1 and 80),
  competition_name text,
  provider_season_id text,
  kickoff_at timestamptz not null,
  provider_home_team_id text not null
    check (char_length(trim(provider_home_team_id)) between 1 and 80),
  provider_home_team_name text,
  provider_away_team_id text not null
    check (char_length(trim(provider_away_team_id)) between 1 and 80),
  provider_away_team_name text,
  home_goals_90 smallint not null check (home_goals_90 >= 0),
  away_goals_90 smallint not null check (away_goals_90 >= 0),
  result_basis text not null default 'regular_time'
    check (result_basis = 'regular_time'),
  neutral_venue boolean not null default false,
  observed_at timestamptz not null default now(),
  ingest_version text not null
    check (char_length(trim(ingest_version)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (provider, provider_fixture_id),
  check (provider_home_team_id <> provider_away_team_id),
  check (observed_at >= kickoff_at)
);

create index football_match_results_competition_kickoff_idx
  on public.football_match_results (
    provider,
    provider_competition_id,
    kickoff_at
  );

create trigger football_match_results_immutable
before update or delete on public.football_match_results
for each row execute function private.kapiloto_eval_reject_change();

-- ---------------------------------------------------------------------------
-- 2. Raw per-bookmaker 1X2 quotes
-- ---------------------------------------------------------------------------

create table public.fixture_market_quotes (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.fixtures(id) on delete restrict,
  provider text not null
    check (char_length(trim(provider)) between 1 and 40),
  provider_fixture_id text not null,
  provider_home_team_id text,
  provider_away_team_id text,
  bookmaker_id text not null
    check (char_length(trim(bookmaker_id)) between 1 and 80),
  bookmaker_name text,
  market_type text not null default '1x2_90m'
    check (market_type = '1x2_90m'),
  odds_home numeric(12,6) not null check (odds_home > 1),
  odds_draw numeric(12,6) not null check (odds_draw > 1),
  odds_away numeric(12,6) not null check (odds_away > 1),
  overround numeric(12,8) not null,
  implied_home double precision not null check (implied_home between 0 and 1),
  implied_draw double precision not null check (implied_draw between 0 and 1),
  implied_away double precision not null check (implied_away between 0 and 1),
  devig_method_version text not null
    check (char_length(trim(devig_method_version)) between 1 and 80),
  source_updated_at timestamptz,
  capture_version text not null
    check (char_length(trim(capture_version)) between 1 and 80),
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (fixture_id, provider, bookmaker_id, captured_at),
  check (abs(implied_home + implied_draw + implied_away - 1) <= 0.000001),
  -- Capture time is server time: a quote cannot be inserted as if it had been
  -- observed earlier (or later) than it actually was.
  check (abs(extract(epoch from (captured_at - created_at))) <= 600)
);

create index fixture_market_quotes_fixture_time_idx
  on public.fixture_market_quotes (fixture_id, captured_at desc);

create trigger fixture_market_quotes_immutable
before update or delete on public.fixture_market_quotes
for each row execute function private.kapiloto_eval_reject_change();

-- ---------------------------------------------------------------------------
-- 3. Evaluation predictions (one row per arm/version/cutoff)
-- ---------------------------------------------------------------------------

create table public.kapiloto_eval_predictions (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.fixtures(id) on delete restrict,
  round_game_id uuid references public.round_games(id) on delete restrict,
  arm text not null check (arm ~ '^[a-z][a-z0-9_]{1,62}$'),
  arm_version text not null
    check (char_length(trim(arm_version)) between 1 and 160),
  evaluation_mode text not null
    check (evaluation_mode in ('forward', 'replay')),
  deterministic boolean not null,
  information_cutoff_at timestamptz not null,
  issued_at timestamptz not null,
  issued_at_source text not null
    check (issued_at_source in ('recorded', 'kapiloto_publication')),
  source_analysis_id uuid references public.kapiloto_analyses(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  kickoff_at_snapshot timestamptz not null,
  home_team_id uuid not null references public.teams(id) on delete restrict,
  away_team_id uuid not null references public.teams(id) on delete restrict,
  valid boolean not null,
  invalid_reason text,
  p_home double precision,
  p_draw double precision,
  p_away double precision,
  basis jsonb not null default '{}'::jsonb,
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  check (home_team_id <> away_team_id),
  check (jsonb_typeof(basis) = 'object'),
  -- Only pure functions of stored history may be recomputed after the fact.
  check (evaluation_mode = 'forward' or deterministic),
  check (
    issued_at_source <> 'kapiloto_publication'
    or (evaluation_mode = 'forward' and source_analysis_id is not null)
  ),
  check (
    (
      valid
      and invalid_reason is null
      and p_home is not null and p_draw is not null and p_away is not null
      and p_home between 0 and 1
      and p_draw between 0 and 1
      and p_away between 0 and 1
      and abs(p_home + p_draw + p_away - 1) <= 0.000001
    )
    or (
      not valid
      and invalid_reason is not null
      and p_home is null and p_draw is null and p_away is null
    )
  )
);

create unique index kapiloto_eval_predictions_identity_uq
  on public.kapiloto_eval_predictions (
    fixture_id,
    arm,
    arm_version,
    evaluation_mode,
    information_cutoff_at,
    coalesce(source_analysis_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create index kapiloto_eval_predictions_fixture_arm_idx
  on public.kapiloto_eval_predictions (fixture_id, arm, arm_version, issued_at desc);

-- Issue time is never trusted from the writer. `recorded` rows are stamped
-- with the insert time; Kapiloto projections take the immutable publication
-- timestamp of the referenced analysis.
create or replace function private.kapiloto_eval_stamp_prediction()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_published_at timestamptz;
  v_publication_fixture_id uuid;
begin
  new.recorded_at := now();

  if new.issued_at_source = 'recorded' then
    new.issued_at := new.recorded_at;
  elsif new.issued_at_source = 'kapiloto_publication' then
    select p.published_at, p.fixture_id
      into v_published_at, v_publication_fixture_id
    from public.kapiloto_fixture_publications p
    where p.analysis_id = new.source_analysis_id;

    if v_published_at is null then
      raise exception 'kapiloto_eval_publication_not_found';
    end if;
    if v_publication_fixture_id <> new.fixture_id then
      raise exception 'kapiloto_eval_publication_fixture_mismatch';
    end if;
    new.issued_at := v_published_at;
  end if;

  if new.evaluation_mode = 'forward'
     and new.information_cutoff_at > new.issued_at then
    raise exception 'kapiloto_eval_information_after_issue';
  end if;

  return new;
end;
$$;

create trigger kapiloto_eval_predictions_stamp
before insert on public.kapiloto_eval_predictions
for each row execute function private.kapiloto_eval_stamp_prediction();

create trigger kapiloto_eval_predictions_immutable
before update or delete on public.kapiloto_eval_predictions
for each row execute function private.kapiloto_eval_reject_change();

-- ---------------------------------------------------------------------------
-- 4. Scored selections
-- ---------------------------------------------------------------------------

create table public.kapiloto_eval_scores (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.fixtures(id) on delete restrict,
  arm text not null check (arm ~ '^[a-z][a-z0-9_]{1,62}$'),
  arm_version text not null,
  evaluation_mode text not null
    check (evaluation_mode in ('forward', 'replay')),
  selection_rule_version text not null,
  scoring_version text not null,
  status text not null
    check (status in ('scored', 'prediction_unavailable', 'no_eligible_prediction')),
  prediction_id uuid references public.kapiloto_eval_predictions(id) on delete restrict,
  outcome text not null check (outcome in ('1', 'X', '2')),
  home_goals_90 smallint not null check (home_goals_90 >= 0),
  away_goals_90 smallint not null check (away_goals_90 >= 0),
  outcome_source text not null,
  brier double precision check (brier is null or brier between 0 and 2),
  rps double precision check (rps is null or rps between 0 and 1),
  log_loss double precision check (log_loss is null or log_loss >= 0),
  top_pick text check (top_pick is null or top_pick in ('1', 'X', '2')),
  top_pick_score double precision
    check (top_pick_score is null or top_pick_score between 0 and 1),
  details jsonb not null default '{}'::jsonb,
  scored_at timestamptz not null default now(),
  unique (
    fixture_id,
    arm,
    arm_version,
    evaluation_mode,
    selection_rule_version,
    scoring_version
  ),
  check (jsonb_typeof(details) = 'object'),
  check (
    (status = 'no_eligible_prediction') = (prediction_id is null)
  ),
  check (
    (status = 'scored') = (
      brier is not null
      and rps is not null
      and log_loss is not null
      and top_pick is not null
      and top_pick_score is not null
    )
  )
);

create trigger kapiloto_eval_scores_immutable
before update or delete on public.kapiloto_eval_scores
for each row execute function private.kapiloto_eval_reject_change();

-- ---------------------------------------------------------------------------
-- Security: server-only evaluation data
-- ---------------------------------------------------------------------------

alter table public.football_match_results enable row level security;
alter table public.fixture_market_quotes enable row level security;
alter table public.kapiloto_eval_predictions enable row level security;
alter table public.kapiloto_eval_scores enable row level security;

revoke all on table public.football_match_results from public, anon, authenticated;
revoke all on table public.fixture_market_quotes from public, anon, authenticated;
revoke all on table public.kapiloto_eval_predictions from public, anon, authenticated;
revoke all on table public.kapiloto_eval_scores from public, anon, authenticated;

comment on table public.football_match_results is
  'Immutable league-wide regular-time results used by deterministic shadow baselines (B2 league_base, B3 p_stat).';

comment on table public.fixture_market_quotes is
  'Immutable per-bookmaker 1X2 prices captured by Kapiloto for the shadow market arm (B4). Not read by the production prior.';

comment on table public.kapiloto_eval_predictions is
  'Append-only shadow evaluation predictions per fixture/arm/version/cutoff. Never exposed to clients; never feeds production recommendations.';

comment on column public.kapiloto_eval_predictions.issued_at is
  'Database-derived availability time: insert time for recorded arms, publication time for Kapiloto projections.';

comment on table public.kapiloto_eval_scores is
  'Append-only scored selections under a versioned selection rule and scoring version.';
