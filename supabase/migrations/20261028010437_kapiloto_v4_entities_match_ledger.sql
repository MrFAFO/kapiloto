-- Kapiloto V4 foundation: canonical players and coaches, team-coach tenures
-- and the bitemporal Match Ledger.
--
-- Additive only. Nothing in V1/V2/V3 research, grounding, derivation,
-- materialization, publication or the UI reads these tables yet.
--
-- Time semantics (see docs/architecture/KAPILOTO-V4-FOUNDATION.md):
--   event time       what the source says happened and when (kickoff_at,
--                    minute, starts_on_*); written by the ingester.
--   retrieved_at     when the ingester fetched the source; informational,
--                    writer supplied, never used for as-of filtering.
--   first_seen_at    when Kapiloto first stored this version. Stamped by the
--                    database from private.kapiloto_information_clock() at the
--                    moment the header row is written (after the per-fixture
--                    locks are held); it cannot be supplied or backdated by a
--                    writer. Every as-of reconstruction filters on
--                    first_seen_at <= cutoff.
--
-- Observations are immutable versions. A provider correction or backfill is a
-- new version with a later first_seen_at; earlier versions stay readable, so a
-- reconstruction at an earlier cutoff never sees the later information.
--
-- Concurrency: every write that versions or claims an identity takes a
-- transaction-scoped advisory lock and requires READ COMMITTED, so its checks
-- run on a snapshot that includes every competing writer that committed first.
--
-- Canonical identity: ledger rows keep the canonical ids they were written
-- with. A later merge (A -> B) is a data-quality correction, not football
-- information, so model-facing reads resolve every stored id to its current
-- survivor and treat A and B as one person at every cutoff. Writes accept only
-- surviving ids, and a merge is refused if it would make one observation
-- version list the same person twice.

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- The single information-time clock for V4 observations: wall-clock time when
-- the stamping trigger runs. Not now() (transaction start: an early BEGIN would
-- backdate later knowledge) and not statement_timestamp() (receipt of the
-- client command: time spent waiting for the per-fixture lock would be
-- backdated, and two serialized versions could get inverted times). Only the
-- header row is stamped; its children copy that one value, so every row of one
-- observation shares it.
create or replace function private.kapiloto_information_clock()
returns timestamptz
language sql
volatile
set search_path = ''
as $$
  select clock_timestamp()
$$;

-- Lock-then-check is only sound when each check takes a fresh snapshot.
create or replace function private.kapiloto_require_read_committed(p_context text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception '% requires READ COMMITTED isolation', p_context;
  end if;
end;
$$;

-- One canonical-identity lock per entity table ('players', 'coaches'). Merges
-- and provider-mapping writes take it exclusively; ledger and tenure writes
-- that check identities take it shared, so they never block each other. Each
-- side runs its checks only after a competing transaction on the other side
-- has committed. Taken after any fixture/tenure lock (one global order).
create or replace function private.lock_canonical_identity(p_entity_table text, p_exclusive boolean)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform private.kapiloto_require_read_committed('canonical identity checks');
  if p_exclusive then
    perform pg_advisory_xact_lock(hashtextextended('kapiloto_identity:' || p_entity_table, 0));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('kapiloto_identity:' || p_entity_table, 0));
  end if;
end;
$$;


create or replace function private.kapiloto_v4_reject_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are immutable', tg_table_name;
end;
$$;

-- Alias normalization v1: Hebrew points/cantillation removed, geresh,
-- gershayim, maqaf, typographic quotes/dashes and NBSP unified, whitespace
-- collapsed, lower-cased. Mirrored by normalizeEntityAlias() in
-- lib/kapiloto-v4/aliases.ts. Transliteration variants are NOT unified here;
-- they are separate aliases.
create or replace function private.normalize_entity_alias(p_alias text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select lower(btrim(regexp_replace(
    regexp_replace(
      translate(
        p_alias,
        E'׳״’‘ʼ`־–— ',
        E'\'"\'\'\'\'--- '
      ),
      '[֑-ׇֽֿׁׂׅׄ]',
      '',
      'g'
    ),
    '[[:space:]]+',
    ' ',
    'g'
  )))
$$;

-- ---------------------------------------------------------------------------
-- Canonical players
-- ---------------------------------------------------------------------------

create table public.players (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null
    check (char_length(btrim(canonical_name)) between 1 and 160),
  date_of_birth date
    check (date_of_birth is null or date_of_birth >= date '1940-01-01'),
  nationality_code text
    check (nationality_code is null or nationality_code ~ '^[A-Z]{2,3}$'),
  height_cm smallint
    check (height_cm is null or height_cm between 140 and 230),
  -- 'merged' marks a duplicate identity. Ledger rows that reference it stay
  -- immutable; readers follow merged_into_player_id (one hop, enforced).
  identity_status text not null default 'active'
    check (identity_status in ('active', 'merged')),
  merged_into_player_id uuid references public.players(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((identity_status = 'merged') = (merged_into_player_id is not null)),
  check (merged_into_player_id is null or merged_into_player_id <> id)
);

create index players_merged_into_idx
  on public.players (merged_into_player_id)
  where merged_into_player_id is not null;

create table public.player_aliases (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete restrict,
  alias text not null check (char_length(btrim(alias)) between 1 and 160),
  normalized_alias text generated always as
    (private.normalize_entity_alias(alias)) stored,
  language_code text
    check (language_code is null or language_code ~ '^[a-z]{2,3}$'),
  alias_kind text not null
    check (alias_kind in (
      'canonical', 'official', 'transliteration', 'provider_spelling',
      'nickname', 'former_name'
    )),
  provider text
    check (provider is null or provider ~ '^[a-z0-9_]{1,40}$'),
  source text not null default 'manual'
    check (char_length(btrim(source)) between 1 and 80),
  created_at timestamptz not null default now(),
  -- Unique per player only. Two different players may share an alias; alias
  -- lookups must treat several candidates as ambiguous, never pick one.
  unique (player_id, normalized_alias),
  check (alias_kind <> 'provider_spelling' or provider is not null)
);

create index player_aliases_normalized_idx
  on public.player_aliases (normalized_alias);

create table public.provider_player_mappings (
  provider text not null
    check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_player_id text not null
    check (char_length(btrim(provider_player_id)) between 1 and 80),
  player_id uuid not null references public.players(id) on delete restrict,
  provider_name text,
  mapping_status text not null default 'unverified'
    check (mapping_status in ('unverified', 'confirmed', 'manual_override')),
  mapping_confidence numeric(5,4)
    check (mapping_confidence is null or mapping_confidence between 0 and 1),
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, provider_player_id),
  -- One provider identity per canonical player per provider. Two provider ids
  -- can never silently collapse into one canonical player; a provider-side
  -- duplicate becomes a second canonical player plus an explicit merge.
  unique (provider, player_id)
);

create index provider_player_mappings_player_idx
  on public.provider_player_mappings (player_id);

-- ---------------------------------------------------------------------------
-- Canonical coaches
-- ---------------------------------------------------------------------------

create table public.coaches (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null
    check (char_length(btrim(canonical_name)) between 1 and 160),
  date_of_birth date
    check (date_of_birth is null or date_of_birth >= date '1920-01-01'),
  nationality_code text
    check (nationality_code is null or nationality_code ~ '^[A-Z]{2,3}$'),
  identity_status text not null default 'active'
    check (identity_status in ('active', 'merged')),
  merged_into_coach_id uuid references public.coaches(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((identity_status = 'merged') = (merged_into_coach_id is not null)),
  check (merged_into_coach_id is null or merged_into_coach_id <> id)
);

create index coaches_merged_into_idx
  on public.coaches (merged_into_coach_id)
  where merged_into_coach_id is not null;

create table public.coach_aliases (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.coaches(id) on delete restrict,
  alias text not null check (char_length(btrim(alias)) between 1 and 160),
  normalized_alias text generated always as
    (private.normalize_entity_alias(alias)) stored,
  language_code text
    check (language_code is null or language_code ~ '^[a-z]{2,3}$'),
  alias_kind text not null
    check (alias_kind in (
      'canonical', 'official', 'transliteration', 'provider_spelling',
      'nickname', 'former_name'
    )),
  provider text
    check (provider is null or provider ~ '^[a-z0-9_]{1,40}$'),
  source text not null default 'manual'
    check (char_length(btrim(source)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (coach_id, normalized_alias),
  check (alias_kind <> 'provider_spelling' or provider is not null)
);

create index coach_aliases_normalized_idx
  on public.coach_aliases (normalized_alias);

create table public.provider_coach_mappings (
  provider text not null
    check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_coach_id text not null
    check (char_length(btrim(provider_coach_id)) between 1 and 80),
  coach_id uuid not null references public.coaches(id) on delete restrict,
  provider_name text,
  mapping_status text not null default 'unverified'
    check (mapping_status in ('unverified', 'confirmed', 'manual_override')),
  mapping_confidence numeric(5,4)
    check (mapping_confidence is null or mapping_confidence between 0 and 1),
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, provider_coach_id),
  unique (provider, coach_id)
);

create index provider_coach_mappings_coach_idx
  on public.provider_coach_mappings (coach_id);

-- One-hop merge resolution (merges are kept one hop deep by trigger).
create or replace function private.surviving_player_id(p_player_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select p.merged_into_player_id from public.players p where p.id = p_player_id),
    p_player_id
  )
$$;

create or replace function private.surviving_coach_id(p_coach_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select c.merged_into_coach_id from public.coaches c where c.id = p_coach_id),
    p_coach_id
  )
$$;

-- Merge targets must be active and one hop deep; updated_at is maintained.
-- Identity changes (merge, un-merge) take the canonical-identity lock
-- exclusively, so two concurrent merges (A -> B with B -> A, or merging an
-- entity while another transaction makes it a merge target) cannot both pass
-- their checks, and no ledger write that checked the old identities is in
-- flight while the co-occurrence check below runs.
--
-- Co-occurrence: a merge is refused when the two identities would become one
-- person appearing twice in one stored observation version (two squad rows;
-- a coach on both benches). Superseded and withdrawn versions count, because
-- as-of reads at earlier cutoffs still return them; a corrected version does
-- not repair them. Same-side coach appearances (a head coach and a staff card
-- of the same team) are not refused.
create or replace function private.guard_canonical_entity_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_identity_change boolean := false;
  v_shared_observation uuid;
begin
  -- Nested ifs: plpgsql does not short-circuit record field access, and each
  -- table only has its own merge column.
  if tg_op = 'INSERT' then
    v_identity_change := new.identity_status <> 'active';
  elsif tg_table_name = 'players' then
    v_identity_change := new.merged_into_player_id is distinct from old.merged_into_player_id
      or new.identity_status is distinct from old.identity_status;
  elsif tg_table_name = 'coaches' then
    v_identity_change := new.merged_into_coach_id is distinct from old.merged_into_coach_id
      or new.identity_status is distinct from old.identity_status;
  end if;

  if v_identity_change then
    perform private.lock_canonical_identity(tg_table_name, true);
  end if;

  if tg_table_name = 'players' then
    if new.merged_into_player_id is not null then
      if not exists (
        select 1 from public.players p
        where p.id = new.merged_into_player_id and p.identity_status = 'active'
      ) then
        raise exception 'a player can only be merged into an active player';
      end if;
      if exists (
        select 1 from public.players p where p.merged_into_player_id = new.id
      ) then
        raise exception 'player % is a merge target; re-point its duplicates first', new.id;
      end if;
      if v_identity_change then
        -- Against the target's whole identity class (target + its duplicates).
        select a.observation_id
          into v_shared_observation
        from public.match_ledger_players a
        join public.match_ledger_players b on b.observation_id = a.observation_id
        join public.players bp on bp.id = b.player_id
        where a.player_id = new.id
          and new.merged_into_player_id in (bp.id, bp.merged_into_player_id)
        limit 1;
        if v_shared_observation is not null then
          raise exception 'players % and % both appear in match ledger observation %; merging them would list one person twice',
            new.id, new.merged_into_player_id, v_shared_observation;
        end if;
      end if;
    end if;
  elsif tg_table_name = 'coaches' then
    if new.merged_into_coach_id is not null then
      if not exists (
        select 1 from public.coaches c
        where c.id = new.merged_into_coach_id and c.identity_status = 'active'
      ) then
        raise exception 'a coach can only be merged into an active coach';
      end if;
      if exists (
        select 1 from public.coaches c where c.merged_into_coach_id = new.id
      ) then
        raise exception 'coach % is a merge target; re-point its duplicates first', new.id;
      end if;
      if v_identity_change then
        -- A coach is linked to a team in an observation by its team record
        -- (head coach) or a staff card; links to opposite teams conflict.
        select a.observation_id
          into v_shared_observation
        from (
          select tr.observation_id, tr.team_id
          from public.match_ledger_team_records tr
          where tr.coach_id = new.id
          union all
          select e.observation_id, e.team_id
          from public.match_ledger_events e
          where e.coach_id = new.id
        ) a
        join (
          select tr.observation_id, tr.team_id, tr.coach_id
          from public.match_ledger_team_records tr
          where tr.coach_id is not null
          union all
          select e.observation_id, e.team_id, e.coach_id
          from public.match_ledger_events e
          where e.coach_id is not null
        ) b on b.observation_id = a.observation_id and b.team_id <> a.team_id
        join public.coaches bc on bc.id = b.coach_id
        where new.merged_into_coach_id in (bc.id, bc.merged_into_coach_id)
        limit 1;
        if v_shared_observation is not null then
          raise exception 'coaches % and % are on opposite sides of match ledger observation %; merging them would put one person on both benches',
            new.id, new.merged_into_coach_id, v_shared_observation;
        end if;
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger players_guard_identity
before insert or update on public.players
for each row execute function private.guard_canonical_entity_identity();

create trigger coaches_guard_identity
before insert or update on public.coaches
for each row execute function private.guard_canonical_entity_identity();

-- New or re-pointed provider mappings must target an active canonical entity.
-- A mapping that predates a merge may keep pointing at the merged id (its
-- metadata and status stay editable): every automatic resolution follows the
-- survivor. Mapping writes take the canonical-identity lock exclusively, so a
-- ledger write never checks a mapping that is being written concurrently.
create or replace function private.guard_provider_entity_mapping()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_retargeted boolean;
begin
  if tg_table_name = 'provider_player_mappings' then
    perform private.lock_canonical_identity('players', true);
    if tg_op = 'INSERT' then
      v_retargeted := true;
    else
      v_retargeted := new.player_id is distinct from old.player_id;
    end if;
    if v_retargeted and not exists (
      select 1 from public.players p
      where p.id = new.player_id and p.identity_status = 'active'
    ) then
      raise exception 'provider player mappings must target an active canonical player';
    end if;
  elsif tg_table_name = 'provider_coach_mappings' then
    perform private.lock_canonical_identity('coaches', true);
    if tg_op = 'INSERT' then
      v_retargeted := true;
    else
      v_retargeted := new.coach_id is distinct from old.coach_id;
    end if;
    if v_retargeted and not exists (
      select 1 from public.coaches c
      where c.id = new.coach_id and c.identity_status = 'active'
    ) then
      raise exception 'provider coach mappings must target an active canonical coach';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger provider_player_mappings_guard
before insert or update on public.provider_player_mappings
for each row execute function private.guard_provider_entity_mapping();

create trigger provider_coach_mappings_guard
before insert or update on public.provider_coach_mappings
for each row execute function private.guard_provider_entity_mapping();

-- ---------------------------------------------------------------------------
-- Team-coach tenures (immutable, versioned assertions)
-- ---------------------------------------------------------------------------

create table public.team_coach_tenures (
  id uuid primary key default gen_random_uuid(),
  -- Stable identity of one tenure across versions. A later version (end date
  -- learned, start corrected, retraction) reuses the key.
  tenure_key uuid not null,
  tenure_version integer not null check (tenure_version >= 1),
  team_id uuid not null references public.teams(id) on delete restrict,
  coach_id uuid not null references public.coaches(id) on delete restrict,
  role text not null default 'head_coach'
    check (role in ('head_coach', 'interim_head_coach', 'caretaker')),
  -- Date uncertainty is an interval. Exactly known dates use equal bounds.
  starts_on_earliest date not null,
  starts_on_latest date not null,
  ends_on_earliest date,
  ends_on_latest date,
  assertion_status text not null default 'asserted'
    check (assertion_status in ('asserted', 'retracted')),
  source_kind text not null
    check (source_kind in (
      'provider', 'official_club', 'federation', 'news_report', 'manual'
    )),
  provider text check (provider is null or provider ~ '^[a-z0-9_]{1,40}$'),
  provider_record_id text
    check (provider_record_id is null
      or char_length(btrim(provider_record_id)) between 1 and 80),
  source_reference text
    check (source_reference is null or char_length(source_reference) <= 500),
  source_fingerprint text
    check (source_fingerprint is null or source_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Future pointer into the V4 raw-observation archive (no FK yet).
  raw_observation_id uuid,
  retrieved_at timestamptz,
  first_seen_at timestamptz not null default now(),
  ingest_version text not null
    check (char_length(btrim(ingest_version)) between 1 and 80),
  unique (tenure_key, tenure_version),
  check (starts_on_latest >= starts_on_earliest),
  check ((ends_on_earliest is null) = (ends_on_latest is null)),
  check (ends_on_latest is null or ends_on_latest >= ends_on_earliest),
  check (ends_on_earliest is null or ends_on_earliest >= starts_on_earliest),
  check (source_kind <> 'provider' or provider is not null),
  check (retrieved_at is null or retrieved_at <= first_seen_at + interval '5 minutes')
);

create index team_coach_tenures_team_seen_idx
  on public.team_coach_tenures (team_id, first_seen_at);

create index team_coach_tenures_coach_seen_idx
  on public.team_coach_tenures (coach_id, first_seen_at);

create or replace function private.stamp_team_coach_tenure()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_latest_version integer;
  v_first public.team_coach_tenures%rowtype;
begin
  -- Serialize versions of one tenure so max() + 1 is deterministic.
  perform private.kapiloto_require_read_committed('team coach tenure writes');
  perform pg_advisory_xact_lock(hashtextextended('kapiloto_tenure:' || new.tenure_key::text, 0));
  new.first_seen_at := private.kapiloto_information_clock();

  -- New assertions name the surviving coach; a later version of a tenure
  -- first asserted for a since-merged coach names that coach's survivor.
  perform private.lock_canonical_identity('coaches', false);
  if exists (
    select 1 from public.coaches c
    where c.id = new.coach_id and c.identity_status = 'merged'
  ) then
    raise exception 'coach % is merged into %; record the surviving canonical id',
      new.coach_id, private.surviving_coach_id(new.coach_id);
  end if;

  select max(t.tenure_version)
    into v_latest_version
  from public.team_coach_tenures t
  where t.tenure_key = new.tenure_key;

  if v_latest_version is not null then
    select t.*
      into v_first
    from public.team_coach_tenures t
    where t.tenure_key = new.tenure_key
      and t.tenure_version = 1;

    if v_first.team_id <> new.team_id
      or private.surviving_coach_id(v_first.coach_id) <> new.coach_id then
      raise exception 'a tenure version cannot change its team or coach';
    end if;
  end if;

  new.tenure_version := coalesce(v_latest_version, 0) + 1;
  return new;
end;
$$;

create trigger team_coach_tenures_stamp
before insert on public.team_coach_tenures
for each row execute function private.stamp_team_coach_tenure();

create trigger team_coach_tenures_immutable
before update or delete on public.team_coach_tenures
for each row execute function private.kapiloto_v4_reject_change();

create trigger team_coach_tenures_no_truncate
before truncate on public.team_coach_tenures
for each statement execute function private.kapiloto_v4_reject_change();

-- ---------------------------------------------------------------------------
-- Match Ledger: one immutable provider observation version per fixture
-- ---------------------------------------------------------------------------

create table public.match_ledger_observations (
  id uuid primary key default gen_random_uuid(),
  -- Payload contract the version was written under; a future contract can
  -- coexist and historical rows stay interpretable. Part of content_sha256.
  contract_version text not null
    check (contract_version in ('kapiloto-match-ledger-observation-v1')),
  fixture_id uuid not null references public.fixtures(id) on delete restrict,
  provider text not null
    check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_fixture_id text not null
    check (char_length(btrim(provider_fixture_id)) between 1 and 80),
  provider_endpoint text
    check (provider_endpoint is null or char_length(provider_endpoint) <= 200),
  -- Assigned by trigger: 1, 2, 3 ... per (fixture, provider).
  observation_version integer not null check (observation_version >= 1),
  capture_mode text not null
    check (capture_mode in ('scheduled_sync', 'backfill', 'manual_import')),
  ingest_version text not null
    check (char_length(btrim(ingest_version)) between 1 and 80),
  source_version text
    check (source_version is null or char_length(source_version) <= 80),
  -- SHA-256 of the canonical normalized observation (computed by
  -- match_ledger_record_observation); drives change detection.
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- SHA-256 of the provider's raw response bytes, when the ingester has them.
  raw_payload_sha256 text
    check (raw_payload_sha256 is null or raw_payload_sha256 ~ '^[0-9a-f]{64}$'),
  -- Future pointer into the V4 raw-observation archive (no FK yet).
  raw_observation_id uuid,
  retrieved_at timestamptz not null,
  source_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  -- Sealing key, not information time: statement_timestamp() of the statement
  -- that wrote the header. Children must be written by that same statement.
  ingest_statement_at timestamptz not null default statement_timestamp(),
  -- 'withdrawal' is a header-only version that retracts this provider's data
  -- for this fixture from later cutoffs (e.g. it was attached to the wrong
  -- fixture or the provider removed it). Earlier versions stay visible to
  -- earlier cutoffs.
  observation_kind text not null default 'observation'
    check (observation_kind in ('observation', 'withdrawal')),
  withdrawal_reason text
    check (withdrawal_reason is null or char_length(btrim(withdrawal_reason)) between 1 and 300),
  -- What the source said at this version (null only for withdrawals).
  kickoff_at timestamptz,
  match_status text
    check (match_status is null or match_status in (
      'upcoming', 'live', 'halftime', 'finished', 'postponed',
      'cancelled', 'suspended', 'under_review'
    )),
  neutral_venue boolean,
  home_goals_90 smallint check (home_goals_90 is null or home_goals_90 >= 0),
  away_goals_90 smallint check (away_goals_90 is null or away_goals_90 >= 0),
  home_goals_aet smallint check (home_goals_aet is null or home_goals_aet >= 0),
  away_goals_aet smallint check (away_goals_aet is null or away_goals_aet >= 0),
  home_penalties smallint check (home_penalties is null or home_penalties >= 0),
  away_penalties smallint check (away_penalties is null or away_penalties >= 0),
  unique (fixture_id, provider, observation_version),
  check ((observation_kind = 'withdrawal') = (withdrawal_reason is not null)),
  check (observation_kind = 'withdrawal' or (kickoff_at is not null and match_status is not null)),
  check (observation_kind = 'observation' or num_nonnulls(
    kickoff_at, match_status, neutral_venue, home_goals_90, away_goals_90,
    home_goals_aet, away_goals_aet, home_penalties, away_penalties
  ) = 0),
  check ((home_goals_90 is null) = (away_goals_90 is null)),
  check (match_status is distinct from 'finished' or home_goals_90 is not null),
  check ((home_goals_aet is null) = (away_goals_aet is null)),
  check ((home_penalties is null) = (away_penalties is null)),
  check (retrieved_at <= first_seen_at + interval '5 minutes'),
  -- A finished version cannot be first seen before the match could end.
  check (match_status <> 'finished' or first_seen_at >= kickoff_at + interval '105 minutes')
);

create index match_ledger_observations_provider_fixture_idx
  on public.match_ledger_observations (provider, provider_fixture_id);

create index match_ledger_observations_seen_idx
  on public.match_ledger_observations (first_seen_at);

-- Locks every ledger write takes, always in this order (no deadlock between
-- writers): the provider fixture identity first, then (fixture, provider).
-- Held until commit. The first lock serializes two writers that try to attach
-- one provider fixture id to two different canonical fixtures; the second
-- serializes versioning of one fixture/provider history.
create or replace function private.lock_match_ledger_fixture(
  p_provider text,
  p_provider_fixture_id text,
  p_fixture_id uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform private.kapiloto_require_read_committed('match ledger writes');
  perform pg_advisory_xact_lock(hashtextextended(
    'kapiloto_match_ledger_provider_fixture:' || p_provider || ':' || p_provider_fixture_id, 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'kapiloto_match_ledger_fixture:' || p_fixture_id::text || ':' || p_provider, 0
  ));
end;
$$;

create or replace function private.stamp_match_ledger_observation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_latest public.match_ledger_observations%rowtype;
  v_mapped_fixture uuid;
begin
  -- Re-entrant when the RPC already holds the locks; mandatory for direct
  -- inserts. Every check below runs after the locks, on a fresh snapshot.
  perform private.lock_match_ledger_fixture(new.provider, new.provider_fixture_id, new.fixture_id);
  new.first_seen_at := private.kapiloto_information_clock();
  new.ingest_statement_at := statement_timestamp();

  select o.*
    into v_latest
  from public.match_ledger_observations o
  where o.fixture_id = new.fixture_id
    and o.provider = new.provider
  order by o.observation_version desc
  limit 1;

  if found then
    if v_latest.content_sha256 = new.content_sha256 then
      raise exception 'match ledger observation is unchanged from version %',
        v_latest.observation_version;
    end if;
    -- After a withdrawal the fixture may be re-recorded under the correct
    -- provider fixture id; otherwise the provider identity is fixed.
    if v_latest.observation_kind = 'observation'
      and v_latest.provider_fixture_id <> new.provider_fixture_id then
      raise exception 'provider fixture id changed for this fixture and provider';
    end if;
    if v_latest.observation_kind = 'withdrawal' and new.observation_kind = 'withdrawal' then
      raise exception 'this provider observation is already withdrawn';
    end if;
    -- Information time never runs backwards within one history.
    if new.first_seen_at < v_latest.first_seen_at then
      raise exception 'match ledger information time would precede version %',
        v_latest.observation_version;
    end if;
    new.observation_version := v_latest.observation_version + 1;
  else
    if new.observation_kind = 'withdrawal' then
      raise exception 'there is no provider observation to withdraw';
    end if;
    new.observation_version := 1;
  end if;

  -- Attachment checks apply to observations only: a withdrawal retracts an
  -- attachment and must stay possible after the mapping moved elsewhere.
  if new.observation_kind = 'observation' then
    -- A provider fixture id is actively attached to at most one canonical
    -- fixture: refuse it while another fixture's latest version carrying this
    -- id is a (non-withdrawn) observation. Sound because of the
    -- provider-fixture lock above, not merely because of this query.
    if exists (
      select 1
      from (
        select distinct on (o.fixture_id) o.fixture_id, o.observation_kind
        from public.match_ledger_observations o
        where o.provider = new.provider
          and o.provider_fixture_id = new.provider_fixture_id
          and o.fixture_id <> new.fixture_id
        order by o.fixture_id, o.observation_version desc
      ) other
      where other.observation_kind = 'observation'
    ) then
      raise exception 'provider fixture id is already recorded for a different canonical fixture';
    end if;

    -- Point-in-time agreement with the V3 mapping table. V3 writes to
    -- provider_fixture_mappings do not take the ledger lock, so this is not a
    -- cross-table invariant; match_ledger_mapping_conflicts() detects drift.
    select m.fixture_id
      into v_mapped_fixture
    from public.provider_fixture_mappings m
    where m.provider = new.provider
      and m.provider_fixture_id = new.provider_fixture_id;

    if v_mapped_fixture is not null and v_mapped_fixture <> new.fixture_id then
      raise exception 'provider fixture id is mapped to a different canonical fixture';
    end if;
  end if;

  return new;
end;
$$;

create trigger match_ledger_observations_stamp
before insert on public.match_ledger_observations
for each row execute function private.stamp_match_ledger_observation();

-- ---------------------------------------------------------------------------
-- Match Ledger children. Each child row belongs to exactly one observation
-- version and must be written in the same transaction as its header (the
-- observation is sealed afterwards), so its information time is the header's.
-- ---------------------------------------------------------------------------

create table public.match_ledger_team_records (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null
    references public.match_ledger_observations(id) on delete restrict,
  -- Copied from the header/fixture by trigger, never by the writer.
  fixture_id uuid not null references public.fixtures(id) on delete restrict,
  kickoff_at timestamptz not null,
  first_seen_at timestamptz not null,
  team_id uuid not null references public.teams(id) on delete restrict,
  opponent_team_id uuid not null references public.teams(id) on delete restrict,
  side text not null check (side in ('home', 'away')),
  coach_id uuid references public.coaches(id) on delete restrict,
  provider_coach_id text
    check (provider_coach_id is null or char_length(btrim(provider_coach_id)) between 1 and 80),
  provider_coach_name text
    check (provider_coach_name is null or char_length(provider_coach_name) <= 160),
  -- Provider label as reported (e.g. 4-2-3-1). Formation families are a
  -- versioned derivation and are not stored in provider observations.
  formation_nominal text
    check (formation_nominal is null or formation_nominal ~ '^[1-6](-[1-6]){1,5}$'),
  lineup_status text not null
    check (lineup_status in ('complete', 'partial', 'not_provided')),
  substitutions_status text not null
    check (substitutions_status in ('complete', 'partial', 'not_provided')),
  events_status text not null
    check (events_status in ('complete', 'partial', 'not_provided')),
  statistics_status text not null
    check (statistics_status in ('complete', 'partial', 'not_provided')),
  unique (observation_id, team_id),
  unique (observation_id, side),
  check (team_id <> opponent_team_id)
);

create index match_ledger_team_records_team_seen_idx
  on public.match_ledger_team_records (team_id, first_seen_at)
  include (observation_id, fixture_id);

create index match_ledger_team_records_team_kickoff_idx
  on public.match_ledger_team_records (team_id, kickoff_at desc)
  include (first_seen_at, observation_id);

create index match_ledger_team_records_coach_kickoff_idx
  on public.match_ledger_team_records (coach_id, kickoff_at desc)
  where coach_id is not null;

create table public.match_ledger_players (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null,
  team_id uuid not null,
  -- Copied from the header by trigger for player-history as-of queries.
  kickoff_at timestamptz not null,
  first_seen_at timestamptz not null,
  player_id uuid not null references public.players(id) on delete restrict,
  provider_player_id text
    check (provider_player_id is null or char_length(btrim(provider_player_id)) between 1 and 80),
  provider_player_name text
    check (provider_player_name is null or char_length(provider_player_name) <= 160),
  lineup_role text not null
    check (lineup_role in ('starter', 'bench', 'unknown')),
  appeared boolean,
  position_code text
    check (position_code is null or position_code in ('GK', 'DF', 'MF', 'FW')),
  provider_position text
    check (provider_position is null or char_length(provider_position) <= 40),
  formation_position smallint
    check (formation_position is null or formation_position between 1 and 11),
  formation_field text
    check (formation_field is null or formation_field ~ '^[0-9]{1,2}:[0-9]{1,2}$'),
  shirt_number smallint
    check (shirt_number is null or shirt_number between 0 and 99),
  is_captain boolean,
  minutes_played smallint
    check (minutes_played is null or minutes_played between 0 and 150),
  entered_minute smallint
    check (entered_minute is null or entered_minute between 0 and 150),
  exited_minute smallint
    check (exited_minute is null or exited_minute between 0 and 150),
  data_completeness text not null
    check (data_completeness in ('complete', 'partial')),
  foreign key (observation_id, team_id)
    references public.match_ledger_team_records(observation_id, team_id)
    on delete restrict,
  unique (observation_id, player_id),
  unique (observation_id, team_id, player_id),
  check (lineup_role <> 'starter' or appeared is distinct from false),
  check (formation_position is null or lineup_role = 'starter'),
  check (exited_minute is null or entered_minute is null or exited_minute >= entered_minute)
);

create unique index match_ledger_players_formation_position_uq
  on public.match_ledger_players (observation_id, team_id, formation_position)
  where formation_position is not null;

create unique index match_ledger_players_shirt_number_uq
  on public.match_ledger_players (observation_id, team_id, shirt_number)
  where shirt_number is not null;

create index match_ledger_players_player_kickoff_idx
  on public.match_ledger_players (player_id, kickoff_at desc)
  include (first_seen_at, observation_id);

create table public.match_ledger_substitutions (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null,
  team_id uuid not null,
  sequence_no smallint not null check (sequence_no between 1 and 20),
  player_off_id uuid not null,
  player_on_id uuid not null,
  minute smallint check (minute is null or minute between 0 and 130),
  stoppage_minute smallint
    check (stoppage_minute is null or stoppage_minute between 0 and 30),
  period text
    check (period is null or period in (
      'first_half', 'second_half', 'extra_time_first_half', 'extra_time_second_half'
    )),
  reason text check (reason is null or reason in ('tactical', 'injury', 'unknown')),
  provider_event_id text
    check (provider_event_id is null or char_length(btrim(provider_event_id)) between 1 and 80),
  foreign key (observation_id, team_id)
    references public.match_ledger_team_records(observation_id, team_id)
    on delete restrict,
  foreign key (observation_id, team_id, player_off_id)
    references public.match_ledger_players(observation_id, team_id, player_id)
    on delete restrict,
  foreign key (observation_id, team_id, player_on_id)
    references public.match_ledger_players(observation_id, team_id, player_id)
    on delete restrict,
  unique (observation_id, team_id, sequence_no),
  unique (observation_id, player_on_id),
  unique (observation_id, player_off_id),
  check (player_off_id <> player_on_id)
);

create unique index match_ledger_substitutions_provider_event_uq
  on public.match_ledger_substitutions (observation_id, provider_event_id)
  where provider_event_id is not null;

create table public.match_ledger_events (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null,
  -- The team of the acting player or coach. For an own goal this is the team
  -- that conceded; the benefiting team is its opponent.
  team_id uuid not null,
  sequence_no smallint not null check (sequence_no between 1 and 500),
  event_type text not null
    check (event_type in (
      'goal', 'own_goal', 'penalty_goal', 'penalty_missed',
      'yellow_card', 'second_yellow_card', 'red_card'
    )),
  player_id uuid,
  coach_id uuid references public.coaches(id) on delete restrict,
  -- Required with coach_id: whose card it is relative to the team record's
  -- head coach ('unknown' when the source does not say).
  staff_role text
    check (staff_role is null or staff_role in ('head_coach', 'assistant_coach', 'other_staff', 'unknown')),
  -- Assisting player for goals; goalkeeper for a penalty. Must be in this
  -- observation's matchday squad (either team).
  related_player_id uuid,
  minute smallint check (minute is null or minute between 0 and 130),
  stoppage_minute smallint
    check (stoppage_minute is null or stoppage_minute between 0 and 30),
  second smallint check (second is null or second between 0 and 59),
  period text
    check (period is null or period in (
      'first_half', 'second_half', 'extra_time_first_half', 'extra_time_second_half'
    )),
  provider_event_id text
    check (provider_event_id is null or char_length(btrim(provider_event_id)) between 1 and 80),
  provider_event_type text
    check (provider_event_type is null or char_length(provider_event_type) <= 60),
  detail jsonb not null default '{}'::jsonb,
  foreign key (observation_id, team_id)
    references public.match_ledger_team_records(observation_id, team_id)
    on delete restrict,
  foreign key (observation_id, team_id, player_id)
    references public.match_ledger_players(observation_id, team_id, player_id)
    on delete restrict,
  foreign key (observation_id, related_player_id)
    references public.match_ledger_players(observation_id, player_id)
    on delete restrict,
  unique (observation_id, sequence_no),
  check (num_nonnulls(player_id, coach_id) <= 1),
  check (coach_id is null or event_type in ('yellow_card', 'second_yellow_card', 'red_card')),
  check ((coach_id is null) = (staff_role is null)),
  check (related_player_id is null or event_type in ('goal', 'penalty_goal', 'penalty_missed')),
  check (related_player_id is null or related_player_id is distinct from player_id),
  check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 2000)
);

create index match_ledger_events_player_idx
  on public.match_ledger_events (player_id)
  where player_id is not null;

create index match_ledger_events_coach_idx
  on public.match_ledger_events (coach_id)
  where coach_id is not null;

create unique index match_ledger_events_provider_event_uq
  on public.match_ledger_events (observation_id, provider_event_id)
  where provider_event_id is not null;

-- Provider statistic identities. Kapiloto's stat_key names the meaning; a
-- changed provider definition is a new definition_version, never an update.
create table public.match_ledger_stat_definitions (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_stat_type text not null
    check (char_length(btrim(provider_stat_type)) between 1 and 80),
  provider_stat_name text
    check (provider_stat_name is null or char_length(provider_stat_name) <= 160),
  definition_version text not null
    check (char_length(btrim(definition_version)) between 1 and 80),
  stat_key text not null check (stat_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  unit text not null
    check (unit in ('count', 'percent', 'ratio', 'expected_goals', 'meters', 'seconds', 'index')),
  description text check (description is null or char_length(description) <= 500),
  created_at timestamptz not null default now(),
  unique (provider, provider_stat_type, definition_version),
  unique (provider, stat_key, definition_version)
);

create index match_ledger_stat_definitions_key_idx
  on public.match_ledger_stat_definitions (stat_key);

create table public.match_ledger_team_stats (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null,
  team_id uuid not null,
  stat_definition_id uuid not null
    references public.match_ledger_stat_definitions(id) on delete restrict,
  period text not null default 'full_time'
    check (period in ('full_time', 'first_half', 'second_half', 'extra_time')),
  value_numeric numeric not null
    check (value_numeric > '-Infinity'::numeric and value_numeric < 'Infinity'::numeric),
  foreign key (observation_id, team_id)
    references public.match_ledger_team_records(observation_id, team_id)
    on delete restrict,
  unique (observation_id, team_id, stat_definition_id, period)
);

create index match_ledger_team_stats_definition_idx
  on public.match_ledger_team_stats (stat_definition_id, team_id);

-- Derived game-state segments (contract only; not populated by this
-- migration). One row per segment from the team's perspective. Segments split
-- at goals, red cards and period boundaries. Derived rows carry no information
-- beyond their observation, so they are not sealed.
create table public.match_ledger_game_state_segments (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null,
  team_id uuid not null,
  derivation_version text not null
    check (char_length(btrim(derivation_version)) between 1 and 80),
  segment_index smallint not null check (segment_index >= 0),
  period text not null
    check (period in (
      'first_half', 'second_half', 'extra_time_first_half', 'extra_time_second_half'
    )),
  from_minute smallint not null check (from_minute between 0 and 130),
  from_stoppage_minute smallint not null default 0
    check (from_stoppage_minute between 0 and 30),
  to_minute smallint not null check (to_minute between 0 and 130),
  to_stoppage_minute smallint not null default 0
    check (to_stoppage_minute between 0 and 30),
  goals_for smallint not null check (goals_for >= 0),
  goals_against smallint not null check (goals_against >= 0),
  score_diff smallint generated always as ((goals_for - goals_against)::smallint) stored,
  men_for smallint not null check (men_for between 6 and 11),
  men_against smallint not null check (men_against between 6 and 11),
  men_diff smallint generated always as ((men_for - men_against)::smallint) stored,
  derived_at timestamptz not null default now(),
  foreign key (observation_id, team_id)
    references public.match_ledger_team_records(observation_id, team_id)
    on delete restrict,
  unique (observation_id, team_id, derivation_version, segment_index),
  check ((to_minute, to_stoppage_minute) >= (from_minute, from_stoppage_minute))
);

-- Header/fixture checks and copies for team records.
create or replace function private.prepare_match_ledger_team_record()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_observation public.match_ledger_observations%rowtype;
  v_home uuid;
  v_away uuid;
begin
  select o.*
    into v_observation
  from public.match_ledger_observations o
  where o.id = new.observation_id;

  if not found then
    raise exception 'match ledger observation not found';
  end if;
  if v_observation.ingest_statement_at <> statement_timestamp() then
    raise exception 'match ledger observation % is sealed', new.observation_id;
  end if;
  if v_observation.observation_kind <> 'observation' then
    raise exception 'a withdrawal version has no team records';
  end if;

  if new.coach_id is not null then
    -- Shared identity lock: no coach merge or coach-mapping write is in
    -- flight while these checks run.
    perform private.lock_canonical_identity('coaches', false);
    if exists (
      select 1 from public.coaches c
      where c.id = new.coach_id and c.identity_status = 'merged'
    ) then
      raise exception 'coach % is merged into %; record the surviving canonical id',
        new.coach_id, private.surviving_coach_id(new.coach_id);
    end if;
    if exists (
      select 1 from public.match_ledger_team_records tr
      where tr.observation_id = new.observation_id and tr.coach_id = new.coach_id
    ) then
      raise exception 'the same coach cannot lead both teams';
    end if;

    -- A supplied provider coach id must not contradict an authoritative
    -- mapping in either direction (merge-aware; unverified bootstrap mappings
    -- never resolve, so they are ignored).
    if new.provider_coach_id is not null then
      if exists (
        select 1
        from public.provider_coach_mappings m
        where m.provider = v_observation.provider
          and m.provider_coach_id = new.provider_coach_id
          and m.mapping_status in ('confirmed', 'manual_override')
          and private.surviving_coach_id(m.coach_id) <> new.coach_id
      ) then
        raise exception 'provider coach id % is mapped to a different canonical coach', new.provider_coach_id;
      end if;
      if not exists (
        select 1 from public.provider_coach_mappings m
        where m.provider = v_observation.provider
          and m.provider_coach_id = new.provider_coach_id
      ) and exists (
        select 1 from public.provider_coach_mappings m
        where m.provider = v_observation.provider
          and m.coach_id in (
            select new.coach_id
            union all
            select c.id from public.coaches c where c.merged_into_coach_id = new.coach_id
          )
          and m.mapping_status in ('confirmed', 'manual_override')
      ) then
        raise exception 'canonical coach is mapped to a different provider coach id';
      end if;
    end if;
  end if;

  select f.home_team_id, f.away_team_id
    into v_home, v_away
  from public.fixtures f
  where f.id = v_observation.fixture_id;

  if new.side = 'home' then
    if new.team_id is distinct from v_home then
      raise exception 'home team record does not match the fixture home team';
    end if;
    new.opponent_team_id := v_away;
  else
    if new.team_id is distinct from v_away then
      raise exception 'away team record does not match the fixture away team';
    end if;
    new.opponent_team_id := v_home;
  end if;

  new.fixture_id := v_observation.fixture_id;
  new.kickoff_at := v_observation.kickoff_at;
  new.first_seen_at := v_observation.first_seen_at;
  return new;
end;
$$;

create or replace function private.prepare_match_ledger_player()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_observation public.match_ledger_observations%rowtype;
begin
  select o.*
    into v_observation
  from public.match_ledger_observations o
  where o.id = new.observation_id;

  if not found then
    raise exception 'match ledger observation not found';
  end if;
  if v_observation.ingest_statement_at <> statement_timestamp() then
    raise exception 'match ledger observation % is sealed', new.observation_id;
  end if;

  -- Shared identity lock: no player merge or player-mapping write is in
  -- flight while these checks run. Substitutions and event players/related
  -- players reference this observation's squad rows, so checking the squad
  -- covers every player position.
  perform private.lock_canonical_identity('players', false);
  if exists (
    select 1 from public.players p
    where p.id = new.player_id and p.identity_status = 'merged'
  ) then
    raise exception 'player % is merged into %; record the surviving canonical id',
      new.player_id, private.surviving_player_id(new.player_id);
  end if;

  -- A supplied provider player id must not contradict an authoritative
  -- mapping in either direction (merge-aware). No provider id = nothing to
  -- contradict.
  if new.provider_player_id is not null then
    if exists (
      select 1
      from public.provider_player_mappings m
      where m.provider = v_observation.provider
        and m.provider_player_id = new.provider_player_id
        and m.mapping_status in ('confirmed', 'manual_override')
        and private.surviving_player_id(m.player_id) <> new.player_id
    ) then
      raise exception 'provider player id % is mapped to a different canonical player', new.provider_player_id;
    end if;
    if not exists (
      select 1 from public.provider_player_mappings m
      where m.provider = v_observation.provider
        and m.provider_player_id = new.provider_player_id
    ) and exists (
      select 1 from public.provider_player_mappings m
      where m.provider = v_observation.provider
        and m.player_id in (
          select new.player_id
          union all
          select p.id from public.players p where p.merged_into_player_id = new.player_id
        )
        and m.mapping_status in ('confirmed', 'manual_override')
    ) then
      raise exception 'canonical player is mapped to a different provider player id';
    end if;
  end if;

  if new.lineup_role = 'starter' and (
    select count(*)
    from public.match_ledger_players p
    where p.observation_id = new.observation_id
      and p.team_id = new.team_id
      and p.lineup_role = 'starter'
  ) >= 11 then
    raise exception 'a team cannot have more than 11 starters';
  end if;

  new.kickoff_at := v_observation.kickoff_at;
  new.first_seen_at := v_observation.first_seen_at;
  return new;
end;
$$;

create or replace function private.seal_match_ledger_child()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_observation public.match_ledger_observations%rowtype;
  v_own_coach uuid;
  v_opponent_coach uuid;
begin
  select o.*
    into v_observation
  from public.match_ledger_observations o
  where o.id = new.observation_id;

  if not found then
    raise exception 'match ledger observation not found';
  end if;
  if v_observation.ingest_statement_at <> statement_timestamp() then
    raise exception 'match ledger observation % is sealed', new.observation_id;
  end if;

  -- Nested ifs: plpgsql does not short-circuit record field access.
  if tg_table_name = 'match_ledger_team_stats' then
    if not exists (
      select 1
      from public.match_ledger_stat_definitions d
      where d.id = new.stat_definition_id
        and d.provider = v_observation.provider
    ) then
      raise exception 'stat definition % does not belong to provider %',
        new.stat_definition_id, v_observation.provider;
    end if;
  end if;

  -- Staff cards: unknown is allowed, contradiction is not. A coach shown a
  -- card can never be the opponent's head coach; a head-coach card must name
  -- the team's head coach when that is known; an assistant/staff card cannot
  -- name the team's own head coach.
  if tg_table_name = 'match_ledger_events' then
    if new.coach_id is not null then
      perform private.lock_canonical_identity('coaches', false);
      if exists (
        select 1 from public.coaches c
        where c.id = new.coach_id and c.identity_status = 'merged'
      ) then
        raise exception 'coach % is merged into %; record the surviving canonical id',
          new.coach_id, private.surviving_coach_id(new.coach_id);
      end if;

      select private.surviving_coach_id(tr.coach_id)
        into v_own_coach
      from public.match_ledger_team_records tr
      where tr.observation_id = new.observation_id and tr.team_id = new.team_id;
      select private.surviving_coach_id(tr.coach_id)
        into v_opponent_coach
      from public.match_ledger_team_records tr
      where tr.observation_id = new.observation_id and tr.team_id <> new.team_id;

      if v_opponent_coach = private.surviving_coach_id(new.coach_id) then
        raise exception 'event % names the opponent''s head coach', new.sequence_no;
      end if;
      if new.staff_role = 'head_coach' and v_own_coach is not null
        and v_own_coach <> private.surviving_coach_id(new.coach_id) then
        raise exception 'event % names a head coach other than the team''s head coach', new.sequence_no;
      end if;
      if new.staff_role in ('assistant_coach', 'other_staff')
        and v_own_coach = private.surviving_coach_id(new.coach_id) then
        raise exception 'event % names the head coach as non-head-coach staff', new.sequence_no;
      end if;
    end if;
  end if;

  if tg_table_name = 'match_ledger_substitutions' then
    if exists (
      select 1
      from public.match_ledger_players p
      where p.observation_id = new.observation_id
        and p.player_id = new.player_on_id
        and p.lineup_role = 'starter'
    ) then
      raise exception 'a starter cannot be substituted on';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.stamp_match_ledger_derivation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.derived_at := private.kapiloto_information_clock();
  return new;
end;
$$;

create trigger match_ledger_team_records_prepare
before insert on public.match_ledger_team_records
for each row execute function private.prepare_match_ledger_team_record();

create trigger match_ledger_players_prepare
before insert on public.match_ledger_players
for each row execute function private.prepare_match_ledger_player();

create trigger match_ledger_substitutions_seal
before insert on public.match_ledger_substitutions
for each row execute function private.seal_match_ledger_child();

create trigger match_ledger_events_seal
before insert on public.match_ledger_events
for each row execute function private.seal_match_ledger_child();

create trigger match_ledger_team_stats_seal
before insert on public.match_ledger_team_stats
for each row execute function private.seal_match_ledger_child();

create trigger match_ledger_game_state_segments_stamp
before insert on public.match_ledger_game_state_segments
for each row execute function private.stamp_match_ledger_derivation();

-- Completeness rules over a team's children. Deferred so they see every child
-- the writing statement inserts; the RPC forces them before it returns, any
-- other writer meets them at commit. "complete" means the source claims the
-- family is fully represented (zero substitutions or cards is valid); only
-- "not_provided" forbids rows, and a complete lineup needs exactly 11 starters.
create or replace function private.check_match_ledger_team_completeness()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_starters integer;
  v_players integer;
begin
  select count(*) filter (where p.lineup_role = 'starter'), count(*)
    into v_starters, v_players
  from public.match_ledger_players p
  where p.observation_id = new.observation_id
    and p.team_id = new.team_id;

  if new.lineup_status = 'complete' and v_starters <> 11 then
    raise exception 'team % lineup is complete but has % starters', new.team_id, v_starters;
  end if;
  if new.lineup_status = 'not_provided' and v_players > 0 then
    raise exception 'team % lineup is not_provided but has matchday players', new.team_id;
  end if;
  if new.substitutions_status = 'not_provided' and exists (
    select 1 from public.match_ledger_substitutions s
    where s.observation_id = new.observation_id and s.team_id = new.team_id
  ) then
    raise exception 'team % substitutions are not_provided but substitutions exist', new.team_id;
  end if;
  if new.events_status = 'not_provided' and exists (
    select 1 from public.match_ledger_events e
    where e.observation_id = new.observation_id and e.team_id = new.team_id
  ) then
    raise exception 'team % events are not_provided but events exist', new.team_id;
  end if;
  if new.statistics_status = 'not_provided' and exists (
    select 1 from public.match_ledger_team_stats st
    where st.observation_id = new.observation_id and st.team_id = new.team_id
  ) then
    raise exception 'team % statistics are not_provided but statistics exist', new.team_id;
  end if;
  return null;
end;
$$;

create or replace function private.check_match_ledger_observation_teams()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.observation_kind = 'observation' and (
    select count(*) from public.match_ledger_team_records tr where tr.observation_id = new.id
  ) <> 2 then
    raise exception 'match ledger observation % must have exactly two team records', new.id;
  end if;
  return null;
end;
$$;

create constraint trigger match_ledger_team_records_complete
after insert on public.match_ledger_team_records
deferrable initially deferred
for each row execute function private.check_match_ledger_team_completeness();

create constraint trigger match_ledger_observations_two_teams
after insert on public.match_ledger_observations
deferrable initially deferred
for each row execute function private.check_match_ledger_observation_teams();

-- Immutability for every ledger table.
create trigger match_ledger_observations_immutable
before update or delete on public.match_ledger_observations
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_observations_no_truncate
before truncate on public.match_ledger_observations
for each statement execute function private.kapiloto_v4_reject_change();

create trigger match_ledger_team_records_immutable
before update or delete on public.match_ledger_team_records
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_team_records_no_truncate
before truncate on public.match_ledger_team_records
for each statement execute function private.kapiloto_v4_reject_change();

create trigger match_ledger_players_immutable
before update or delete on public.match_ledger_players
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_players_no_truncate
before truncate on public.match_ledger_players
for each statement execute function private.kapiloto_v4_reject_change();

create trigger match_ledger_substitutions_immutable
before update or delete on public.match_ledger_substitutions
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_substitutions_no_truncate
before truncate on public.match_ledger_substitutions
for each statement execute function private.kapiloto_v4_reject_change();

create trigger match_ledger_events_immutable
before update or delete on public.match_ledger_events
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_events_no_truncate
before truncate on public.match_ledger_events
for each statement execute function private.kapiloto_v4_reject_change();

create trigger match_ledger_stat_definitions_immutable
before update or delete on public.match_ledger_stat_definitions
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_stat_definitions_no_truncate
before truncate on public.match_ledger_stat_definitions
for each statement execute function private.kapiloto_v4_reject_change();

create trigger match_ledger_team_stats_immutable
before update or delete on public.match_ledger_team_stats
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_team_stats_no_truncate
before truncate on public.match_ledger_team_stats
for each statement execute function private.kapiloto_v4_reject_change();

create trigger match_ledger_game_state_segments_immutable
before update or delete on public.match_ledger_game_state_segments
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_game_state_segments_no_truncate
before truncate on public.match_ledger_game_state_segments
for each statement execute function private.kapiloto_v4_reject_change();

-- ---------------------------------------------------------------------------
-- Ingestion RPC: one atomic, canonicalized observation version
-- ---------------------------------------------------------------------------

create or replace function private.match_ledger_assert_keys(
  p_items jsonb,
  p_allowed text[],
  p_label text
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_unknown text;
begin
  if p_items is null then
    return;
  end if;
  if jsonb_typeof(p_items) = 'object' then
    select k into v_unknown
    from jsonb_object_keys(p_items) k
    where k <> all (p_allowed)
    limit 1;
  elsif jsonb_typeof(p_items) = 'array' then
    if exists (
      select 1 from jsonb_array_elements(p_items) e
      where jsonb_typeof(e) <> 'object'
    ) then
      raise exception 'match ledger % entries must be objects', p_label;
    end if;
    select k into v_unknown
    from jsonb_array_elements(p_items) e,
      lateral jsonb_object_keys(e) k
    where k <> all (p_allowed)
    limit 1;
  else
    raise exception 'match ledger % must be an object or array', p_label;
  end if;

  if v_unknown is not null then
    raise exception 'unknown match ledger % field: %', p_label, v_unknown;
  end if;
end;
$$;

-- Ingestion accepts surviving canonical ids only. The RPC refuses a merged id
-- in any position before it compares content hashes, so a payload resolved
-- with a stale identity is an error, never an "unchanged" no-op; the child
-- triggers repeat the check for direct inserts. There is deliberately no
-- silent canonicalization: the stored ids, the content hash and the caller's
-- payload stay identical, and raw provider ids/names remain the provenance.
create or replace function private.match_ledger_assert_surviving_ids(
  p_teams jsonb,
  p_players jsonb,
  p_substitutions jsonb,
  p_events jsonb
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_position text;
  v_id uuid;
  v_survivor uuid;
begin
  perform private.lock_canonical_identity('players', false);
  perform private.lock_canonical_identity('coaches', false);

  select r.position, r.id, p.merged_into_player_id
    into v_position, v_id, v_survivor
  from (
    select 'players.player_id' as position, (x->>'player_id')::uuid as id, 1 as ord
    from jsonb_array_elements(p_players) x
    union all
    select 'substitutions.player_off_id', (s->>'player_off_id')::uuid, 2
    from jsonb_array_elements(p_substitutions) s
    union all
    select 'substitutions.player_on_id', (s->>'player_on_id')::uuid, 3
    from jsonb_array_elements(p_substitutions) s
    union all
    select 'events.player_id', (e->>'player_id')::uuid, 4
    from jsonb_array_elements(p_events) e
    union all
    select 'events.related_player_id', (e->>'related_player_id')::uuid, 5
    from jsonb_array_elements(p_events) e
  ) r
  join public.players p on p.id = r.id
  where p.identity_status = 'merged'
  order by r.ord
  limit 1;
  if v_id is not null then
    raise exception 'match ledger % % is a merged player; record its surviving canonical id %',
      v_position, v_id, v_survivor;
  end if;

  select r.position, r.id, c.merged_into_coach_id
    into v_position, v_id, v_survivor
  from (
    select 'teams.coach_id' as position, (t->>'coach_id')::uuid as id, 1 as ord
    from jsonb_array_elements(p_teams) t
    union all
    select 'events.coach_id', (e->>'coach_id')::uuid, 2
    from jsonb_array_elements(p_events) e
  ) r
  join public.coaches c on c.id = r.id
  where c.identity_status = 'merged'
  order by r.ord
  limit 1;
  if v_id is not null then
    raise exception 'match ledger % % is a merged coach; record its surviving canonical id %',
      v_position, v_id, v_survivor;
  end if;
end;
$$;

-- Header-only withdrawal version; called by match_ledger_record_observation.
create or replace function private.match_ledger_record_withdrawal(p_observation jsonb)
returns jsonb
language plpgsql
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_header record;
  v_sha text;
  v_latest public.match_ledger_observations%rowtype;
  v_id uuid;
  v_version integer;
  v_first_seen timestamptz;
begin
  perform private.match_ledger_assert_keys(p_observation, array[
    'contract_version', 'observation_kind', 'fixture_id', 'provider',
    'provider_fixture_id', 'provider_endpoint', 'capture_mode',
    'ingest_version', 'source_version', 'raw_payload_sha256',
    'raw_observation_id', 'retrieved_at', 'source_updated_at',
    'withdrawal_reason'
  ], 'withdrawal');

  select *
    into v_header
  from jsonb_to_record(p_observation) as h(
    fixture_id uuid,
    provider text,
    provider_fixture_id text,
    provider_endpoint text,
    capture_mode text,
    ingest_version text,
    source_version text,
    raw_payload_sha256 text,
    raw_observation_id uuid,
    retrieved_at timestamptz,
    source_updated_at timestamptz,
    withdrawal_reason text
  );

  if v_header.fixture_id is null or v_header.provider is null or v_header.provider_fixture_id is null then
    raise exception 'match ledger withdrawal requires fixture_id, provider and provider_fixture_id';
  end if;

  v_sha := encode(sha256(convert_to(jsonb_build_object(
    'contract_version', 'kapiloto-match-ledger-observation-v1',
    'observation_kind', 'withdrawal',
    'fixture_id', v_header.fixture_id,
    'provider', v_header.provider,
    'provider_fixture_id', v_header.provider_fixture_id,
    'withdrawal_reason', v_header.withdrawal_reason
  )::text, 'UTF8')), 'hex');

  perform private.lock_match_ledger_fixture(
    v_header.provider, v_header.provider_fixture_id, v_header.fixture_id
  );

  select o.*
    into v_latest
  from public.match_ledger_observations o
  where o.fixture_id = v_header.fixture_id
    and o.provider = v_header.provider
  order by o.observation_version desc
  limit 1;

  if found and v_latest.observation_kind = 'withdrawal' then
    return jsonb_build_object(
      'status', 'unchanged',
      'observation_id', v_latest.id,
      'observation_version', v_latest.observation_version,
      'first_seen_at', v_latest.first_seen_at,
      'content_sha256', v_latest.content_sha256
    );
  end if;

  insert into public.match_ledger_observations (
    contract_version, fixture_id, provider, provider_fixture_id, provider_endpoint,
    capture_mode, ingest_version, source_version, content_sha256,
    raw_payload_sha256, raw_observation_id, retrieved_at, source_updated_at,
    observation_kind, withdrawal_reason
  )
  values (
    'kapiloto-match-ledger-observation-v1',
    v_header.fixture_id, v_header.provider, v_header.provider_fixture_id,
    v_header.provider_endpoint, v_header.capture_mode,
    v_header.ingest_version, v_header.source_version, v_sha,
    v_header.raw_payload_sha256, v_header.raw_observation_id,
    v_header.retrieved_at, v_header.source_updated_at, 'withdrawal',
    v_header.withdrawal_reason
  )
  returning id, observation_version, first_seen_at
    into v_id, v_version, v_first_seen;

  return jsonb_build_object(
    'status', 'recorded',
    'observation_id', v_id,
    'observation_version', v_version,
    'first_seen_at', v_first_seen,
    'content_sha256', v_sha
  );
end;
$$;

create or replace function public.match_ledger_record_observation(p_observation jsonb)
returns jsonb
language plpgsql
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_header record;
  v_teams jsonb;
  v_players jsonb;
  v_substitutions jsonb;
  v_events jsonb;
  v_team_stats jsonb;
  v_content jsonb;
  v_sha text;
  v_latest public.match_ledger_observations%rowtype;
  v_id uuid;
  v_version integer;
  v_first_seen timestamptz;
begin
  if p_observation is null or jsonb_typeof(p_observation) <> 'object' then
    raise exception 'match ledger observation must be a JSON object';
  end if;
  if p_observation->>'contract_version' is distinct from 'kapiloto-match-ledger-observation-v1' then
    raise exception 'unsupported match ledger contract version';
  end if;

  if coalesce(p_observation->>'observation_kind', 'observation') = 'withdrawal' then
    return private.match_ledger_record_withdrawal(p_observation);
  end if;

  perform private.match_ledger_assert_keys(p_observation, array[
    'contract_version', 'observation_kind', 'fixture_id', 'provider',
    'provider_fixture_id', 'provider_endpoint', 'capture_mode',
    'ingest_version', 'source_version', 'raw_payload_sha256',
    'raw_observation_id', 'retrieved_at', 'source_updated_at', 'kickoff_at',
    'match_status', 'neutral_venue', 'home_goals_90', 'away_goals_90',
    'home_goals_aet', 'away_goals_aet', 'home_penalties', 'away_penalties',
    'teams', 'players', 'substitutions', 'events', 'team_stats'
  ], 'observation');
  if p_observation->>'observation_kind' is distinct from 'observation'
    and p_observation ? 'observation_kind' then
    raise exception 'unsupported match ledger observation kind';
  end if;

  if jsonb_typeof(p_observation->'teams') is distinct from 'array'
    or jsonb_array_length(p_observation->'teams') <> 2 then
    raise exception 'a match ledger observation must describe exactly two teams';
  end if;

  perform private.match_ledger_assert_keys(p_observation->'teams', array[
    'team_id', 'side', 'coach_id', 'provider_coach_id', 'provider_coach_name',
    'formation_nominal', 'lineup_status', 'substitutions_status',
    'events_status', 'statistics_status'
  ], 'team');
  perform private.match_ledger_assert_keys(coalesce(p_observation->'players', '[]'::jsonb), array[
    'team_id', 'player_id', 'provider_player_id', 'provider_player_name',
    'lineup_role', 'appeared', 'position_code', 'provider_position',
    'formation_position', 'formation_field', 'shirt_number', 'is_captain',
    'minutes_played', 'entered_minute', 'exited_minute', 'data_completeness'
  ], 'player');
  perform private.match_ledger_assert_keys(coalesce(p_observation->'substitutions', '[]'::jsonb), array[
    'team_id', 'sequence_no', 'player_off_id', 'player_on_id', 'minute',
    'stoppage_minute', 'period', 'reason', 'provider_event_id'
  ], 'substitution');
  perform private.match_ledger_assert_keys(coalesce(p_observation->'events', '[]'::jsonb), array[
    'team_id', 'sequence_no', 'event_type', 'player_id', 'coach_id',
    'staff_role', 'related_player_id', 'minute', 'stoppage_minute', 'second', 'period',
    'provider_event_id', 'provider_event_type', 'detail'
  ], 'event');
  perform private.match_ledger_assert_keys(coalesce(p_observation->'team_stats', '[]'::jsonb), array[
    'team_id', 'stat_definition_id', 'period', 'value'
  ], 'team stat');

  select *
    into v_header
  from jsonb_to_record(p_observation) as h(
    fixture_id uuid,
    provider text,
    provider_fixture_id text,
    provider_endpoint text,
    capture_mode text,
    ingest_version text,
    source_version text,
    raw_payload_sha256 text,
    raw_observation_id uuid,
    retrieved_at timestamptz,
    source_updated_at timestamptz,
    kickoff_at timestamptz,
    match_status text,
    neutral_venue boolean,
    home_goals_90 smallint,
    away_goals_90 smallint,
    home_goals_aet smallint,
    away_goals_aet smallint,
    home_penalties smallint,
    away_penalties smallint
  );

  if v_header.fixture_id is null or v_header.provider is null or v_header.provider_fixture_id is null then
    raise exception 'match ledger observation requires fixture_id, provider and provider_fixture_id';
  end if;

  -- Canonical, typed, ordered children: omitted keys become null, ids and
  -- numbers get one textual form, so equal content always hashes equally.
  select coalesce(jsonb_agg(to_jsonb(t) order by t.side), '[]'::jsonb)
    into v_teams
  from jsonb_to_recordset(p_observation->'teams') as t(
    team_id uuid, side text, coach_id uuid, provider_coach_id text,
    provider_coach_name text, formation_nominal text, lineup_status text,
    substitutions_status text, events_status text, statistics_status text
  );

  select coalesce(jsonb_agg(to_jsonb(x) order by x.team_id, x.player_id), '[]'::jsonb)
    into v_players
  from jsonb_to_recordset(coalesce(p_observation->'players', '[]'::jsonb)) as x(
    team_id uuid, player_id uuid, provider_player_id text,
    provider_player_name text, lineup_role text, appeared boolean,
    position_code text, provider_position text, formation_position smallint,
    formation_field text, shirt_number smallint, is_captain boolean,
    minutes_played smallint, entered_minute smallint, exited_minute smallint,
    data_completeness text
  );

  select coalesce(jsonb_agg(to_jsonb(s) order by s.team_id, s.sequence_no), '[]'::jsonb)
    into v_substitutions
  from jsonb_to_recordset(coalesce(p_observation->'substitutions', '[]'::jsonb)) as s(
    team_id uuid, sequence_no smallint, player_off_id uuid, player_on_id uuid,
    minute smallint, stoppage_minute smallint, period text, reason text,
    provider_event_id text
  );

  select coalesce(jsonb_agg(to_jsonb(e) order by e.sequence_no), '[]'::jsonb)
    into v_events
  from jsonb_to_recordset(coalesce(p_observation->'events', '[]'::jsonb)) as e(
    team_id uuid, sequence_no smallint, event_type text, player_id uuid,
    coach_id uuid, staff_role text, related_player_id uuid, minute smallint,
    stoppage_minute smallint, second smallint, period text,
    provider_event_id text, provider_event_type text, detail jsonb
  );

  select coalesce(
      jsonb_agg(to_jsonb(st) order by st.team_id, st.stat_definition_id, st.period),
      '[]'::jsonb
    )
    into v_team_stats
  from jsonb_to_recordset(coalesce(p_observation->'team_stats', '[]'::jsonb)) as st(
    team_id uuid, stat_definition_id uuid, period text, value numeric
  );

  -- Retrieval metadata (retrieved_at, source_updated_at, endpoint, versions,
  -- raw hashes, capture mode) is excluded: re-fetching identical football
  -- content is not a new version.
  v_content := jsonb_build_object(
    'contract_version', 'kapiloto-match-ledger-observation-v1',
    'fixture_id', v_header.fixture_id,
    'provider', v_header.provider,
    'provider_fixture_id', v_header.provider_fixture_id,
    'kickoff_at', v_header.kickoff_at,
    'match_status', v_header.match_status,
    'neutral_venue', v_header.neutral_venue,
    'home_goals_90', v_header.home_goals_90,
    'away_goals_90', v_header.away_goals_90,
    'home_goals_aet', v_header.home_goals_aet,
    'away_goals_aet', v_header.away_goals_aet,
    'home_penalties', v_header.home_penalties,
    'away_penalties', v_header.away_penalties,
    'teams', v_teams,
    'players', v_players,
    'substitutions', v_substitutions,
    'events', v_events,
    'team_stats', v_team_stats
  );
  v_sha := encode(sha256(convert_to(v_content::text, 'UTF8')), 'hex');

  -- Serialize writers per fixture/provider so versioning is race-free.
  perform private.lock_match_ledger_fixture(
    v_header.provider, v_header.provider_fixture_id, v_header.fixture_id
  );
  -- After the fixture locks (global lock order), before the hash comparison.
  perform private.match_ledger_assert_surviving_ids(v_teams, v_players, v_substitutions, v_events);

  select o.*
    into v_latest
  from public.match_ledger_observations o
  where o.fixture_id = v_header.fixture_id
    and o.provider = v_header.provider
  order by o.observation_version desc
  limit 1;

  if found and v_latest.content_sha256 = v_sha then
    return jsonb_build_object(
      'status', 'unchanged',
      'observation_id', v_latest.id,
      'observation_version', v_latest.observation_version,
      'first_seen_at', v_latest.first_seen_at,
      'content_sha256', v_sha
    );
  end if;

  -- Cross-row completeness checks run when this statement has written every
  -- child (forced immediate below), not row by row.
  set constraints
    public.match_ledger_team_records_complete,
    public.match_ledger_observations_two_teams
    deferred;

  -- observation_version, first_seen_at and ingest_statement_at are assigned
  -- by the stamp trigger.
  insert into public.match_ledger_observations (
    contract_version, fixture_id, provider, provider_fixture_id, provider_endpoint,
    capture_mode, ingest_version, source_version,
    content_sha256, raw_payload_sha256, raw_observation_id, retrieved_at,
    source_updated_at, kickoff_at, match_status, neutral_venue,
    home_goals_90, away_goals_90, home_goals_aet, away_goals_aet,
    home_penalties, away_penalties
  )
  values (
    'kapiloto-match-ledger-observation-v1',
    v_header.fixture_id, v_header.provider, v_header.provider_fixture_id,
    v_header.provider_endpoint, v_header.capture_mode,
    v_header.ingest_version, v_header.source_version, v_sha,
    v_header.raw_payload_sha256, v_header.raw_observation_id,
    v_header.retrieved_at, v_header.source_updated_at, v_header.kickoff_at,
    v_header.match_status, v_header.neutral_venue, v_header.home_goals_90,
    v_header.away_goals_90, v_header.home_goals_aet, v_header.away_goals_aet,
    v_header.home_penalties, v_header.away_penalties
  )
  returning id, observation_version, first_seen_at
    into v_id, v_version, v_first_seen;

  -- fixture_id, kickoff_at, first_seen_at and opponent_team_id are copied
  -- from the header and fixture by the prepare trigger.
  insert into public.match_ledger_team_records (
    observation_id, team_id, side, coach_id, provider_coach_id,
    provider_coach_name, formation_nominal, lineup_status,
    substitutions_status, events_status, statistics_status
  )
  select
    v_id, t.team_id, t.side, t.coach_id, t.provider_coach_id,
    t.provider_coach_name, t.formation_nominal, t.lineup_status,
    t.substitutions_status, t.events_status, t.statistics_status
  from jsonb_to_recordset(v_teams) as t(
    team_id uuid, side text, coach_id uuid, provider_coach_id text,
    provider_coach_name text, formation_nominal text, lineup_status text,
    substitutions_status text, events_status text, statistics_status text
  );

  insert into public.match_ledger_players (
    observation_id, team_id, player_id,
    provider_player_id, provider_player_name, lineup_role, appeared,
    position_code, provider_position, formation_position, formation_field,
    shirt_number, is_captain, minutes_played, entered_minute, exited_minute,
    data_completeness
  )
  select
    v_id, x.team_id, x.player_id,
    x.provider_player_id, x.provider_player_name, x.lineup_role, x.appeared,
    x.position_code, x.provider_position, x.formation_position,
    x.formation_field, x.shirt_number, x.is_captain, x.minutes_played,
    x.entered_minute, x.exited_minute, x.data_completeness
  from jsonb_to_recordset(v_players) as x(
    team_id uuid, player_id uuid, provider_player_id text,
    provider_player_name text, lineup_role text, appeared boolean,
    position_code text, provider_position text, formation_position smallint,
    formation_field text, shirt_number smallint, is_captain boolean,
    minutes_played smallint, entered_minute smallint, exited_minute smallint,
    data_completeness text
  );

  insert into public.match_ledger_substitutions (
    observation_id, team_id, sequence_no, player_off_id, player_on_id,
    minute, stoppage_minute, period, reason, provider_event_id
  )
  select
    v_id, s.team_id, s.sequence_no, s.player_off_id, s.player_on_id,
    s.minute, s.stoppage_minute, s.period, s.reason, s.provider_event_id
  from jsonb_to_recordset(v_substitutions) as s(
    team_id uuid, sequence_no smallint, player_off_id uuid, player_on_id uuid,
    minute smallint, stoppage_minute smallint, period text, reason text,
    provider_event_id text
  );

  insert into public.match_ledger_events (
    observation_id, team_id, sequence_no, event_type, player_id, coach_id,
    staff_role, related_player_id, minute, stoppage_minute, second, period,
    provider_event_id, provider_event_type, detail
  )
  select
    v_id, e.team_id, e.sequence_no, e.event_type, e.player_id, e.coach_id,
    e.staff_role, e.related_player_id, e.minute, e.stoppage_minute, e.second, e.period,
    e.provider_event_id, e.provider_event_type, coalesce(e.detail, '{}'::jsonb)
  from jsonb_to_recordset(v_events) as e(
    team_id uuid, sequence_no smallint, event_type text, player_id uuid,
    coach_id uuid, staff_role text, related_player_id uuid, minute smallint,
    stoppage_minute smallint, second smallint, period text,
    provider_event_id text, provider_event_type text, detail jsonb
  );

  insert into public.match_ledger_team_stats (
    observation_id, team_id, stat_definition_id, period, value_numeric
  )
  select
    v_id, st.team_id, st.stat_definition_id, coalesce(st.period, 'full_time'), st.value
  from jsonb_to_recordset(v_team_stats) as st(
    team_id uuid, stat_definition_id uuid, period text, value numeric
  );

  -- Enforce completeness now so this statement fails atomically.
  set constraints
    public.match_ledger_team_records_complete,
    public.match_ledger_observations_two_teams
    immediate;

  return jsonb_build_object(
    'status', 'recorded',
    'observation_id', v_id,
    'observation_version', v_version,
    'first_seen_at', v_first_seen,
    'content_sha256', v_sha
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- As-of reads. Every function filters on first_seen_at <= p_cutoff before it
-- picks the latest version, so later corrections and backfills are invisible.
-- ---------------------------------------------------------------------------

create or replace function public.match_ledger_observation_as_of(
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
  select case when latest.observation_kind = 'observation' then latest.id end
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

-- Provider-scoped by contract: one provider's view, so a canonical fixture
-- appears at most once. There is deliberately no all-providers variant; a
-- fused canonical history (provider precedence) is a later, separate API.
-- Coach identity is explicit: observed_coach_id is the id stored in the
-- immutable version; canonical_coach_id is its current survivor. Coach models
-- group by canonical_coach_id.
create or replace function public.match_ledger_provider_team_matches_as_of(
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
  where l.match_rank <= least(greatest(coalesce(p_limit, 10), 0), 50)
  order by l.kickoff_at desc;
end;
$$;

-- A player's matchday records as of a cutoff, from one provider, taken only
-- from the latest version of each fixture known at the cutoff (a correction
-- that drops the player from a squad removes the match from his history).
--
-- Merge-aware: the history is the canonical person's. Rows stored under any
-- member of the identity class (the survivor and every id merged into it)
-- are included, and a merged p_player_id redirects to its survivor's history
-- (canonical_player_id says which). The merge guard keeps at most one class
-- member per observation version, so a fixture still appears at most once.
create or replace function public.match_ledger_provider_player_matches_as_of(
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
  where l.match_rank <= least(greatest(coalesce(p_limit, 10), 0), 50)
  order by l.kickoff_at desc;
end;
$$;

-- Raw assertion history: the latest version of each tenure known at the
-- cutoff, exactly as asserted (coach_id is the asserted id). canonical_coach_id
-- is its current survivor; coach models group by it. Two tenures asserted for
-- two since-merged coach ids stay two assertions; they are not deduplicated.
create or replace function public.team_coach_tenures_as_of(
  p_team_id uuid,
  p_cutoff timestamptz
)
returns table (
  id uuid,
  tenure_key uuid,
  tenure_version integer,
  team_id uuid,
  coach_id uuid,
  canonical_coach_id uuid,
  role text,
  starts_on_earliest date,
  starts_on_latest date,
  ends_on_earliest date,
  ends_on_latest date,
  assertion_status text,
  source_kind text,
  provider text,
  provider_record_id text,
  source_reference text,
  source_fingerprint text,
  raw_observation_id uuid,
  retrieved_at timestamptz,
  first_seen_at timestamptz,
  ingest_version text
)
language sql
stable
set search_path = ''
as $$
  select
    t.id, t.tenure_key, t.tenure_version, t.team_id, t.coach_id,
    coalesce(c.merged_into_coach_id, t.coach_id), t.role,
    t.starts_on_earliest, t.starts_on_latest, t.ends_on_earliest,
    t.ends_on_latest, t.assertion_status, t.source_kind, t.provider,
    t.provider_record_id, t.source_reference, t.source_fingerprint,
    t.raw_observation_id, t.retrieved_at, t.first_seen_at, t.ingest_version
  from (
    select
      t0.*,
      row_number() over (
        partition by t0.tenure_key
        order by t0.tenure_version desc
      ) as version_rank
    from public.team_coach_tenures t0
    where t0.team_id = p_team_id
      and t0.first_seen_at <= p_cutoff
  ) t
  join public.coaches c on c.id = t.coach_id
  where t.version_rank = 1
    and t.assertion_status = 'asserted'
$$;

-- ---------------------------------------------------------------------------
-- Identity resolution. Every automatic resolution returns surviving canonical
-- ids; raw matched ids are returned alongside for provenance.
-- ---------------------------------------------------------------------------

-- Alias candidates, one row per matching entity. Callers classify them with
-- resolveAliasCandidates(): candidates that share a canonical id are one
-- person (a merged duplicate's aliases stay valid); two canonical ids are
-- ambiguous and must not be resolved automatically.
create or replace function public.player_alias_candidates(p_alias text)
returns table (player_id uuid, canonical_player_id uuid)
language sql
stable
set search_path = ''
as $$
  select distinct a.player_id, coalesce(p.merged_into_player_id, p.id)
  from public.player_aliases a
  join public.players p on p.id = a.player_id
  where a.normalized_alias = private.normalize_entity_alias(p_alias)
  order by 2, 1
$$;

create or replace function public.coach_alias_candidates(p_alias text)
returns table (coach_id uuid, canonical_coach_id uuid)
language sql
stable
set search_path = ''
as $$
  select distinct a.coach_id, coalesce(c.merged_into_coach_id, c.id)
  from public.coach_aliases a
  join public.coaches c on c.id = a.coach_id
  where a.normalized_alias = private.normalize_entity_alias(p_alias)
  order by 2, 1
$$;

-- Authoritative (confirmed/manual_override) provider mappings resolved to the
-- survivor. A mapping that predates a merge still points at the merged id;
-- it resolves to the survivor here. Unverified or unknown ids return no row.
create or replace function public.resolve_provider_player_ids(
  p_provider text,
  p_provider_player_ids text[]
)
returns table (provider_player_id text, mapped_player_id uuid, canonical_player_id uuid)
language sql
stable
set search_path = ''
as $$
  select m.provider_player_id, m.player_id, coalesce(p.merged_into_player_id, p.id)
  from public.provider_player_mappings m
  join public.players p on p.id = m.player_id
  where m.provider = p_provider
    and m.provider_player_id = any (p_provider_player_ids)
    and m.mapping_status in ('confirmed', 'manual_override')
  order by 1
$$;

create or replace function public.resolve_provider_coach_ids(
  p_provider text,
  p_provider_coach_ids text[]
)
returns table (provider_coach_id text, mapped_coach_id uuid, canonical_coach_id uuid)
language sql
stable
set search_path = ''
as $$
  select m.provider_coach_id, m.coach_id, coalesce(c.merged_into_coach_id, c.id)
  from public.provider_coach_mappings m
  join public.coaches c on c.id = m.coach_id
  where m.provider = p_provider
    and m.provider_coach_id = any (p_provider_coach_ids)
    and m.mapping_status in ('confirmed', 'manual_override')
  order by 1
$$;

-- Reconciliation input, not an invariant: current (latest, non-withdrawn)
-- observation versions whose stored canonical assignment disagrees with the
-- current authoritative mappings, matched through the raw provider ids kept
-- in the ledger. Disagreement arises from a mapping corrected after ingest
-- (allowed by design) or, for fixtures, from a provider_fixture_mappings
-- write that the ledger cannot serialize against (see
-- docs/architecture/KAPILOTO-V4-FOUNDATION.md). The repair is a corrected
-- observation version or a withdrawal; ledger rows are never rewritten.
create or replace function public.match_ledger_mapping_conflicts(p_provider text)
returns table (
  conflict_kind text,
  observation_id uuid,
  fixture_id uuid,
  provider_entity_id text,
  stored_canonical_id uuid,
  mapped_canonical_id uuid
)
language sql
stable
set search_path = ''
as $$
  with latest as (
    select distinct on (o.fixture_id) o.id, o.fixture_id, o.provider, o.provider_fixture_id, o.observation_kind
    from public.match_ledger_observations o
    where o.provider = p_provider
    order by o.fixture_id, o.observation_version desc
  ),
  current_versions as (
    select * from latest where observation_kind = 'observation'
  )
  select 'fixture', l.id, l.fixture_id, l.provider_fixture_id, l.fixture_id, m.fixture_id
  from current_versions l
  join public.provider_fixture_mappings m
    on m.provider = l.provider and m.provider_fixture_id = l.provider_fixture_id
  where m.fixture_id is distinct from l.fixture_id
  union all
  select 'player', l.id, l.fixture_id, mp.provider_player_id,
    coalesce(sp.merged_into_player_id, sp.id), coalesce(tp.merged_into_player_id, tp.id)
  from current_versions l
  join public.match_ledger_players mp on mp.observation_id = l.id
  join public.players sp on sp.id = mp.player_id
  join public.provider_player_mappings m
    on m.provider = l.provider and m.provider_player_id = mp.provider_player_id
    and m.mapping_status in ('confirmed', 'manual_override')
  join public.players tp on tp.id = m.player_id
  where coalesce(sp.merged_into_player_id, sp.id) <> coalesce(tp.merged_into_player_id, tp.id)
  union all
  select 'coach', l.id, l.fixture_id, tr.provider_coach_id,
    coalesce(sc.merged_into_coach_id, sc.id), coalesce(tc.merged_into_coach_id, tc.id)
  from current_versions l
  join public.match_ledger_team_records tr on tr.observation_id = l.id
  join public.coaches sc on sc.id = tr.coach_id
  join public.provider_coach_mappings m
    on m.provider = l.provider and m.provider_coach_id = tr.provider_coach_id
    and m.mapping_status in ('confirmed', 'manual_override')
  join public.coaches tc on tc.id = m.coach_id
  where coalesce(sc.merged_into_coach_id, sc.id) <> coalesce(tc.merged_into_coach_id, tc.id)
  order by 1, 3, 4
$$;

-- ---------------------------------------------------------------------------
-- Security: server/service_role only
-- ---------------------------------------------------------------------------

alter table public.players enable row level security;
alter table public.player_aliases enable row level security;
alter table public.provider_player_mappings enable row level security;
alter table public.coaches enable row level security;
alter table public.coach_aliases enable row level security;
alter table public.provider_coach_mappings enable row level security;
alter table public.team_coach_tenures enable row level security;
alter table public.match_ledger_observations enable row level security;
alter table public.match_ledger_team_records enable row level security;
alter table public.match_ledger_players enable row level security;
alter table public.match_ledger_substitutions enable row level security;
alter table public.match_ledger_events enable row level security;
alter table public.match_ledger_stat_definitions enable row level security;
alter table public.match_ledger_team_stats enable row level security;
alter table public.match_ledger_game_state_segments enable row level security;

revoke all on table public.players from public, anon, authenticated;
revoke all on table public.player_aliases from public, anon, authenticated;
revoke all on table public.provider_player_mappings from public, anon, authenticated;
revoke all on table public.coaches from public, anon, authenticated;
revoke all on table public.coach_aliases from public, anon, authenticated;
revoke all on table public.provider_coach_mappings from public, anon, authenticated;
revoke all on table public.team_coach_tenures from public, anon, authenticated;
revoke all on table public.match_ledger_observations from public, anon, authenticated;
revoke all on table public.match_ledger_team_records from public, anon, authenticated;
revoke all on table public.match_ledger_players from public, anon, authenticated;
revoke all on table public.match_ledger_substitutions from public, anon, authenticated;
revoke all on table public.match_ledger_events from public, anon, authenticated;
revoke all on table public.match_ledger_stat_definitions from public, anon, authenticated;
revoke all on table public.match_ledger_team_stats from public, anon, authenticated;
revoke all on table public.match_ledger_game_state_segments from public, anon, authenticated;

revoke all on function private.kapiloto_information_clock() from public, anon, authenticated;
revoke all on function private.kapiloto_v4_reject_change() from public, anon, authenticated;
revoke all on function private.normalize_entity_alias(text) from public, anon, authenticated;
revoke all on function private.guard_canonical_entity_identity() from public, anon, authenticated;
revoke all on function private.guard_provider_entity_mapping() from public, anon, authenticated;
revoke all on function private.stamp_team_coach_tenure() from public, anon, authenticated;
revoke all on function private.stamp_match_ledger_observation() from public, anon, authenticated;
revoke all on function private.prepare_match_ledger_team_record() from public, anon, authenticated;
revoke all on function private.prepare_match_ledger_player() from public, anon, authenticated;
revoke all on function private.seal_match_ledger_child() from public, anon, authenticated;
revoke all on function private.stamp_match_ledger_derivation() from public, anon, authenticated;
revoke all on function private.match_ledger_assert_keys(jsonb, text[], text) from public, anon, authenticated;
revoke all on function private.match_ledger_record_withdrawal(jsonb) from public, anon, authenticated;
revoke all on function private.kapiloto_require_read_committed(text) from public, anon, authenticated;
revoke all on function private.surviving_player_id(uuid) from public, anon, authenticated;
revoke all on function private.surviving_coach_id(uuid) from public, anon, authenticated;
revoke all on function private.lock_match_ledger_fixture(text, text, uuid) from public, anon, authenticated;
revoke all on function private.check_match_ledger_team_completeness() from public, anon, authenticated;
revoke all on function private.check_match_ledger_observation_teams() from public, anon, authenticated;
revoke all on function private.lock_canonical_identity(text, boolean) from public, anon, authenticated;
revoke all on function private.match_ledger_assert_surviving_ids(jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;

revoke all on function public.match_ledger_record_observation(jsonb)
from public, anon, authenticated;
revoke all on function public.match_ledger_provider_player_matches_as_of(text, uuid, timestamptz, integer)
from public, anon, authenticated;
revoke all on function public.match_ledger_observation_as_of(uuid, text, timestamptz)
from public, anon, authenticated;
revoke all on function public.match_ledger_provider_team_matches_as_of(text, uuid, timestamptz, integer)
from public, anon, authenticated;
revoke all on function public.team_coach_tenures_as_of(uuid, timestamptz)
from public, anon, authenticated;
revoke all on function public.player_alias_candidates(text)
from public, anon, authenticated;
revoke all on function public.coach_alias_candidates(text)
from public, anon, authenticated;
revoke all on function public.resolve_provider_player_ids(text, text[])
from public, anon, authenticated;
revoke all on function public.resolve_provider_coach_ids(text, text[])
from public, anon, authenticated;
revoke all on function public.match_ledger_mapping_conflicts(text)
from public, anon, authenticated;

-- Triggers, the alias generated columns and the ingestion RPC run as the
-- invoking service_role and call these helpers by name.
grant usage on schema private to service_role;
grant execute on function private.kapiloto_information_clock() to service_role;
grant execute on function private.normalize_entity_alias(text) to service_role;
grant execute on function private.match_ledger_assert_keys(jsonb, text[], text) to service_role;
grant execute on function private.match_ledger_record_withdrawal(jsonb) to service_role;
grant execute on function private.kapiloto_require_read_committed(text) to service_role;
grant execute on function private.surviving_player_id(uuid) to service_role;
grant execute on function private.surviving_coach_id(uuid) to service_role;
grant execute on function private.lock_match_ledger_fixture(text, text, uuid) to service_role;
grant execute on function private.lock_canonical_identity(text, boolean) to service_role;
grant execute on function private.match_ledger_assert_surviving_ids(jsonb, jsonb, jsonb, jsonb) to service_role;

grant execute on function public.match_ledger_record_observation(jsonb) to service_role;
grant execute on function public.match_ledger_provider_player_matches_as_of(text, uuid, timestamptz, integer) to service_role;
grant execute on function public.match_ledger_observation_as_of(uuid, text, timestamptz) to service_role;
grant execute on function public.match_ledger_provider_team_matches_as_of(text, uuid, timestamptz, integer) to service_role;
grant execute on function public.team_coach_tenures_as_of(uuid, timestamptz) to service_role;
grant execute on function public.player_alias_candidates(text) to service_role;
grant execute on function public.coach_alias_candidates(text) to service_role;
grant execute on function public.resolve_provider_player_ids(text, text[]) to service_role;
grant execute on function public.resolve_provider_coach_ids(text, text[]) to service_role;
grant execute on function public.match_ledger_mapping_conflicts(text) to service_role;

comment on table public.players is
  'Canonical player identity (V4). Provider ids are mappings, never identity; duplicates are merged explicitly via merged_into_player_id.';
comment on table public.player_aliases is
  'Hebrew/English/transliterated/provider spellings of a player. Not globally unique: several candidates for one alias are ambiguous.';
comment on table public.provider_player_mappings is
  'Provider player id to canonical player. One provider id per canonical player per provider; only confirmed/manual_override mappings resolve automatically.';
comment on table public.coaches is
  'Canonical coach identity (V4).';
comment on table public.coach_aliases is
  'Hebrew/English/transliterated/provider spellings of a coach.';
comment on table public.provider_coach_mappings is
  'Provider coach id to canonical coach.';
comment on table public.team_coach_tenures is
  'Immutable, versioned team-coach tenure assertions with date-uncertainty bounds and database-stamped first_seen_at.';
comment on table public.match_ledger_observations is
  'One immutable provider observation version of a canonical fixture. Corrections and backfills are new versions; as-of reads filter on first_seen_at.';
comment on table public.match_ledger_team_records is
  'Per-team match context inside one observation version: side, opponent, coach, nominal formation and data completeness.';
comment on table public.match_ledger_players is
  'Matchday squad inside one observation version: starters, bench, positions and minutes.';
comment on table public.match_ledger_substitutions is
  'Paired substitutions inside one observation version.';
comment on table public.match_ledger_events is
  'Typed match events (goals, own goals, penalties, cards) inside one observation version.';
comment on table public.match_ledger_stat_definitions is
  'Provider statistic identities mapped to Kapiloto stat keys, versioned by definition.';
comment on table public.match_ledger_team_stats is
  'Numeric team statistics inside one observation version, keyed by stat definition and period.';
comment on table public.match_ledger_game_state_segments is
  'Derived game-state segments (score and men difference) per team perspective. Contract only; populated by a later V4 derivation.';
comment on column public.team_coach_tenures.ends_on_latest is
  'Bounds of the last day in charge (inclusive). Both end bounds are null while the tenure is open as far as this version knows.';
comment on column public.match_ledger_observations.first_seen_at is
  'Information time: clock_timestamp() when the header row was written (after the fixture locks). The only column as-of reconstruction may filter on.';
comment on column public.match_ledger_observations.ingest_statement_at is
  'Sealing key (statement_timestamp of the writing statement). Not information time; never filter on it.';
comment on column public.match_ledger_observations.contract_version is
  'Payload contract this immutable version was written under.';
comment on column public.match_ledger_observations.retrieved_at is
  'When the ingester fetched the source. Informational; never used for as-of filtering.';
comment on column public.match_ledger_observations.kickoff_at is
  'Event time as reported by the source in this version (not the mutable fixtures.kickoff_at).';
