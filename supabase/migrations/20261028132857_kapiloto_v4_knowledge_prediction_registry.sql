-- Kapiloto V4 Foundation 1B: document archive, canonical claims, claim
-- resolutions and the prediction registry.
--
-- Additive only. Nothing in V1/V2/V3 research, grounding, derivation,
-- materialization, publication or the UI reads these tables yet, and no
-- existing table is altered. Legacy V3 research rows are referenced only by
-- soft provenance ids (no foreign keys, no validation), so V3 rows keep their
-- current lifecycle.
--
-- Layers (see docs/architecture/KAPILOTO-V4-KNOWLEDGE-REGISTRY.md):
--   document           source material Kapiloto actually observed (identity)
--   document version   one immutable observation of that material
--   claim              a structured proposition, deduplicated by fingerprint
--   claim observation  what one document version appears to say about a claim
--   claim relation     typed claim-to-claim provenance (derived_from, ...)
--   claim resolution   Kapiloto's versioned adjudication of a claim
--   prediction         an immutable snapshot of one prediction, its exact
--                      inputs and the canonical identities it used
--
-- Information time follows Foundation 1A: every first_seen_at is stamped by
-- private.kapiloto_information_clock() when the row is written (never by the
-- writer), every as-of read filters on first_seen_at <= cutoff, and
-- corrections are new immutable rows. Every write that versions or checks
-- something takes a transaction-scoped advisory lock under READ COMMITTED.

-- ---------------------------------------------------------------------------
-- Shared helper
-- ---------------------------------------------------------------------------

-- Refuses unknown JSON keys in an object or in every object of an array, so a
-- misspelled field is an error instead of a silently dropped value.
create or replace function private.kapiloto_v4_assert_keys(
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
    if exists (select 1 from jsonb_array_elements(p_items) e where jsonb_typeof(e) <> 'object') then
      raise exception '% entries must be objects', p_label;
    end if;
    select k into v_unknown
    from jsonb_array_elements(p_items) e, lateral jsonb_object_keys(e) k
    where k <> all (p_allowed)
    limit 1;
  else
    raise exception '% must be an object or array', p_label;
  end if;
  if v_unknown is not null then
    raise exception 'unknown % field: %', p_label, v_unknown;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Document archive
-- ---------------------------------------------------------------------------

create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null
    check (source_kind in (
      'news_article', 'official_announcement', 'federation_page',
      'provider_response', 'social_post', 'podcast_transcript',
      'video_transcript', 'press_conference_transcript', 'other'
    )),
  -- Identity inputs. A stable external id (provider object, social post id)
  -- wins over a URL, because URLs change; see identity_key.
  canonical_url text
    check (canonical_url is null or (canonical_url ~ '^https?://' and char_length(canonical_url) <= 2000)),
  provider text check (provider is null or provider ~ '^[a-z0-9_]{1,40}$'),
  platform text check (platform is null or platform ~ '^[a-z0-9_]{1,40}$'),
  external_id text
    check (external_id is null or char_length(btrim(external_id)) between 1 and 200),
  identity_key text generated always as (
    case
      when external_id is not null and coalesce(provider, platform) is not null
        then 'ext:' || coalesce(provider, platform) || ':' || external_id
      else 'url:' || canonical_url
    end
  ) stored,
  -- Source identity kept for future reliability statistics.
  domain text check (domain is null or domain ~ '^[a-z0-9][a-z0-9.-]{0,252}$'),
  publisher text check (publisher is null or char_length(btrim(publisher)) between 1 and 160),
  source_account text
    check (source_account is null or char_length(btrim(source_account)) between 1 and 200),
  first_seen_at timestamptz not null default now(),
  check (canonical_url is not null or (external_id is not null and coalesce(provider, platform) is not null)),
  unique (identity_key)
);

create table public.knowledge_document_versions (
  id uuid primary key default gen_random_uuid(),
  contract_version text not null
    check (contract_version in ('kapiloto-document-version-v1')),
  document_id uuid not null references public.knowledge_documents(id) on delete restrict,
  -- Assigned by trigger: 1, 2, 3 ... per document.
  version_no integer not null check (version_no >= 1),
  -- URL as observed by this fetch (may differ from the identity URL after a
  -- redirect or slug change).
  canonical_url text
    check (canonical_url is null or (canonical_url ~ '^https?://' and char_length(canonical_url) <= 2000)),
  title text check (title is null or char_length(title) <= 500),
  author text check (author is null or char_length(btrim(author)) between 1 and 200),
  language_code text check (language_code is null or language_code ~ '^[a-z]{2,3}$'),
  published_at timestamptz,
  source_updated_at timestamptz,
  retrieved_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  -- SHA-256 of the UTF-8 extracted text (the normalized textual
  -- representation), whether or not the text is retained. When the text is
  -- retained the trigger verifies it.
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  raw_content_sha256 text
    check (raw_content_sha256 is null or raw_content_sha256 ~ '^[0-9a-f]{64}$'),
  -- Raw bytes (HTML, audio, video) live in external object storage, never
  -- in Postgres.
  raw_content_uri text
    check (raw_content_uri is null or (raw_content_uri ~ '^[a-z][a-z0-9+.-]*://' and char_length(raw_content_uri) <= 1000)),
  -- Bounded inline text; longer material is stored externally and only its
  -- hash is kept here.
  extracted_text text
    check (extracted_text is null or char_length(extracted_text) <= 200000),
  extraction_version text not null
    check (char_length(btrim(extraction_version)) between 1 and 80),
  -- Syndication/wire cluster. Inherited by trigger from an earlier version
  -- with identical content when not supplied.
  syndication_cluster text
    check (syndication_cluster is null or char_length(btrim(syndication_cluster)) between 1 and 200),
  -- Rights provenance (representable, not a legal-policy engine).
  access_basis text not null
    check (access_basis in (
      'public_web', 'licensed', 'provider_contract', 'user_supplied',
      'internal_only', 'transcript_authorized', 'unknown', 'restricted'
    )),
  may_retain_raw boolean not null default false,
  may_retain_text boolean not null default false,
  may_expose_excerpts boolean not null default false,
  rights_note text check (rights_note is null or char_length(rights_note) <= 500),
  -- Optional research-discovery hook (no planner yet).
  discovery_channel text
    check (discovery_channel is null or discovery_channel in (
      'search', 'feed', 'provider_api', 'crawl', 'link_follow', 'manual',
      'user_submitted', 'unknown'
    )),
  discovery_query_sha256 text
    check (discovery_query_sha256 is null or discovery_query_sha256 ~ '^[0-9a-f]{64}$'),
  discovery_rank smallint check (discovery_rank is null or discovery_rank between 1 and 1000),
  discovered_at timestamptz,
  ingest_version text not null
    check (char_length(btrim(ingest_version)) between 1 and 80),
  metadata jsonb not null default '{}'::jsonb,
  -- Dedupe key computed by trigger from content and rights-relevant
  -- metadata (not retrieval time, raw bytes or discovery data).
  version_fingerprint text not null check (version_fingerprint ~ '^[0-9a-f]{64}$'),
  unique (document_id, version_no),
  unique (id, document_id),
  check (may_retain_raw or raw_content_uri is null),
  check (may_retain_text or extracted_text is null),
  check (access_basis not in ('unknown', 'restricted') or not may_expose_excerpts),
  check (retrieved_at <= first_seen_at + interval '5 minutes'),
  check ((discovery_query_sha256 is null and discovery_rank is null) or discovery_channel = 'search'),
  check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 8000)
);

create index knowledge_document_versions_seen_idx
  on public.knowledge_document_versions (first_seen_at);

create index knowledge_document_versions_content_idx
  on public.knowledge_document_versions (content_sha256);

create or replace function private.stamp_knowledge_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.first_seen_at := private.kapiloto_information_clock();
  return new;
end;
$$;

create or replace function private.knowledge_document_version_fingerprint(
  p_content_sha256 text,
  p_canonical_url text,
  p_title text,
  p_author text,
  p_language_code text,
  p_published_at timestamptz,
  p_access_basis text,
  p_may_retain_raw boolean,
  p_may_retain_text boolean,
  p_may_expose_excerpts boolean
)
returns text
language sql
stable
set search_path = ''
set timezone = 'UTC'
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'content_sha256', p_content_sha256,
    'canonical_url', p_canonical_url,
    'title', p_title,
    'author', p_author,
    'language_code', p_language_code,
    'published_at', p_published_at,
    'access_basis', p_access_basis,
    'may_retain_raw', p_may_retain_raw,
    'may_retain_text', p_may_retain_text,
    'may_expose_excerpts', p_may_expose_excerpts
  )::text, 'UTF8')), 'hex')
$$;

create or replace function private.stamp_knowledge_document_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_latest public.knowledge_document_versions%rowtype;
  v_cluster text;
begin
  -- Serialize versions of one document so version_no and dedupe are sound.
  perform private.kapiloto_require_read_committed('document archive writes');
  perform pg_advisory_xact_lock(hashtextextended('kapiloto_document_version:' || new.document_id::text, 0));
  new.first_seen_at := private.kapiloto_information_clock();

  if new.extracted_text is not null
    and new.content_sha256 <> encode(sha256(convert_to(new.extracted_text, 'UTF8')), 'hex') then
    raise exception 'content_sha256 does not match the retained extracted text';
  end if;

  -- An exact copy of already-clustered content joins that cluster, so a
  -- republished wire story is never an independent source.
  if new.syndication_cluster is null then
    select v.syndication_cluster
      into v_cluster
    from public.knowledge_document_versions v
    where v.content_sha256 = new.content_sha256
      and v.syndication_cluster is not null
    order by v.first_seen_at, v.id
    limit 1;
    new.syndication_cluster := v_cluster;
  end if;

  new.version_fingerprint := private.knowledge_document_version_fingerprint(
    new.content_sha256, new.canonical_url, new.title, new.author,
    new.language_code, new.published_at, new.access_basis,
    new.may_retain_raw, new.may_retain_text, new.may_expose_excerpts
  );

  select v.*
    into v_latest
  from public.knowledge_document_versions v
  where v.document_id = new.document_id
  order by v.version_no desc
  limit 1;

  if found then
    if v_latest.version_fingerprint = new.version_fingerprint then
      raise exception 'document version is unchanged from version %', v_latest.version_no;
    end if;
    if new.first_seen_at < v_latest.first_seen_at then
      raise exception 'document information time would precede version %', v_latest.version_no;
    end if;
    new.version_no := v_latest.version_no + 1;
  else
    new.version_no := 1;
  end if;
  return new;
end;
$$;

create trigger knowledge_documents_stamp
before insert on public.knowledge_documents
for each row execute function private.stamp_knowledge_document();

create trigger knowledge_document_versions_stamp
before insert on public.knowledge_document_versions
for each row execute function private.stamp_knowledge_document_version();

-- ---------------------------------------------------------------------------
-- Canonical claims
-- ---------------------------------------------------------------------------

create table public.knowledge_claims (
  id uuid primary key default gen_random_uuid(),
  contract_version text not null check (contract_version in ('kapiloto-claim-v1')),
  -- Epistemic level. Only observed_fact and reported_expectation come from
  -- sources; the others are derived and must cite derived_from premises.
  claim_kind text not null
    check (claim_kind in (
      'observed_fact', 'reported_expectation', 'derived_inference',
      'matchup_hypothesis', 'scenario', 'probability_adjustment'
    )),
  -- Open, versioned vocabularies (e.g. player_availability / status).
  claim_type text not null check (claim_type ~ '^[a-z][a-z0-9_]{1,62}$'),
  predicate text not null check (predicate ~ '^[a-z][a-z0-9_]{1,62}$'),
  -- Subjects: any combination, at least one.
  fixture_id uuid references public.fixtures(id) on delete restrict,
  team_id uuid references public.teams(id) on delete restrict,
  player_id uuid references public.players(id) on delete restrict,
  coach_id uuid references public.coaches(id) on delete restrict,
  -- Structured object/value of the proposition, e.g. {"status":"doubtful"}.
  object_value jsonb not null default '{}'::jsonb,
  polarity text not null default 'affirmed' check (polarity in ('affirmed', 'negated')),
  temporal_scope text not null
    check (temporal_scope in ('fixture', 'date_range', 'season', 'ongoing', 'instant')),
  scope_starts_on date,
  scope_ends_on date,
  -- Human-readable label of the first writer. Never identity.
  statement_text text check (statement_text is null or char_length(statement_text) <= 500),
  -- SHA-256 of the structured proposition, computed by trigger. Two claims
  -- are the same claim only when every structured dimension matches.
  claim_fingerprint text not null check (claim_fingerprint ~ '^[0-9a-f]{64}$'),
  first_seen_at timestamptz not null default now(),
  unique (claim_fingerprint),
  check (num_nonnulls(fixture_id, team_id, player_id, coach_id) >= 1),
  check (jsonb_typeof(object_value) = 'object' and octet_length(object_value::text) <= 4000),
  check (temporal_scope <> 'fixture' or fixture_id is not null),
  check (temporal_scope <> 'date_range' or (scope_starts_on is not null and scope_ends_on is not null)),
  check (scope_ends_on is null or (scope_starts_on is not null and scope_ends_on >= scope_starts_on))
);

create index knowledge_claims_fixture_idx on public.knowledge_claims (fixture_id) where fixture_id is not null;
create index knowledge_claims_team_idx on public.knowledge_claims (team_id) where team_id is not null;
create index knowledge_claims_player_idx on public.knowledge_claims (player_id) where player_id is not null;
create index knowledge_claims_coach_idx on public.knowledge_claims (coach_id) where coach_id is not null;

create or replace function private.knowledge_claim_fingerprint(
  p_contract_version text,
  p_claim_kind text,
  p_claim_type text,
  p_predicate text,
  p_fixture_id uuid,
  p_team_id uuid,
  p_player_id uuid,
  p_coach_id uuid,
  p_object_value jsonb,
  p_polarity text,
  p_temporal_scope text,
  p_scope_starts_on date,
  p_scope_ends_on date
)
returns text
language sql
stable
set search_path = ''
set timezone = 'UTC'
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'contract_version', p_contract_version,
    'claim_kind', p_claim_kind,
    'claim_type', p_claim_type,
    'predicate', p_predicate,
    'fixture_id', p_fixture_id,
    'team_id', p_team_id,
    'player_id', p_player_id,
    'coach_id', p_coach_id,
    'object_value', p_object_value,
    'polarity', p_polarity,
    'temporal_scope', p_temporal_scope,
    'scope_starts_on', p_scope_starts_on,
    'scope_ends_on', p_scope_ends_on
  )::text, 'UTF8')), 'hex')
$$;

-- Claims name surviving canonical players/coaches (D-050): a claim about a
-- since-merged id is found through survivor resolution, never re-created.
create or replace function private.stamp_knowledge_claim()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.first_seen_at := private.kapiloto_information_clock();
  new.claim_fingerprint := private.knowledge_claim_fingerprint(
    new.contract_version, new.claim_kind, new.claim_type, new.predicate,
    new.fixture_id, new.team_id, new.player_id, new.coach_id,
    new.object_value, new.polarity, new.temporal_scope,
    new.scope_starts_on, new.scope_ends_on
  );
  if new.player_id is not null then
    perform private.lock_canonical_identity('players', false);
    if exists (
      select 1 from public.players p
      where p.id = new.player_id and p.identity_status = 'merged'
    ) then
      raise exception 'player % is merged into %; claims reference surviving canonical ids',
        new.player_id, private.surviving_player_id(new.player_id);
    end if;
  end if;
  if new.coach_id is not null then
    perform private.lock_canonical_identity('coaches', false);
    if exists (
      select 1 from public.coaches c
      where c.id = new.coach_id and c.identity_status = 'merged'
    ) then
      raise exception 'coach % is merged into %; claims reference surviving canonical ids',
        new.coach_id, private.surviving_coach_id(new.coach_id);
    end if;
  end if;
  return new;
end;
$$;

create trigger knowledge_claims_stamp
before insert on public.knowledge_claims
for each row execute function private.stamp_knowledge_claim();

-- ---------------------------------------------------------------------------
-- Claim observations: what one document version appears to say
-- ---------------------------------------------------------------------------

create table public.knowledge_claim_observations (
  id uuid primary key default gen_random_uuid(),
  contract_version text not null
    check (contract_version in ('kapiloto-claim-observation-v1')),
  claim_id uuid not null references public.knowledge_claims(id) on delete restrict,
  document_version_id uuid not null,
  -- Copied from the version by trigger (per-source statistics).
  document_id uuid not null,
  relationship text not null check (relationship in ('supports', 'contradicts', 'mentions')),
  -- Verbatim excerpt; only when the version's rights permit retaining text.
  quote text check (quote is null or char_length(quote) between 1 and 1000),
  -- Extractor's short paraphrase in Kapiloto's words (not verbatim).
  observed_wording text check (observed_wording is null or char_length(observed_wording) <= 500),
  span_start integer check (span_start is null or span_start >= 0),
  span_end integer,
  -- Trigger: whether the quote occurs in the retained text (null when the
  -- text is not retained). A signal for fabrication review, not a gate.
  quote_found boolean,
  source_event_at timestamptz,
  source_event_text text check (source_event_text is null or char_length(source_event_text) <= 200),
  extracted_at timestamptz not null,
  extractor_kind text not null check (extractor_kind in ('model', 'rule', 'manual')),
  extractor_version text not null check (char_length(btrim(extractor_version)) between 1 and 80),
  extractor_model text check (extractor_model is null or char_length(extractor_model) <= 120),
  prompt_sha256 text check (prompt_sha256 is null or prompt_sha256 ~ '^[0-9a-f]{64}$'),
  extraction_confidence numeric(5,4)
    check (extraction_confidence is null or extraction_confidence between 0 and 1),
  -- Trigger: syndication cluster, else the exact content hash. Observations
  -- sharing it are one source, never independent corroboration.
  independence_key text not null,
  -- Soft provenance id of the V3 evidence row this came from (not a foreign
  -- key, not validated).
  v3_evidence_id uuid,
  first_seen_at timestamptz not null default now(),
  foreign key (document_version_id, document_id)
    references public.knowledge_document_versions(id, document_id) on delete restrict,
  unique (claim_id, document_version_id, relationship, extractor_version),
  check ((span_start is null) = (span_end is null)),
  check (span_end is null or span_end > span_start),
  check (extracted_at <= first_seen_at + interval '5 minutes')
);

create index knowledge_claim_observations_claim_idx
  on public.knowledge_claim_observations (claim_id, first_seen_at);

create index knowledge_claim_observations_document_idx
  on public.knowledge_claim_observations (document_id);

create or replace function private.stamp_knowledge_claim_observation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_version public.knowledge_document_versions%rowtype;
  v_claim_kind text;
begin
  select v.*
    into v_version
  from public.knowledge_document_versions v
  where v.id = new.document_version_id;
  if not found then
    raise exception 'document version % not found', new.document_version_id;
  end if;

  -- Sources report facts and expectations; derived claims are Kapiloto's own
  -- and cite premises instead, so the two layers never blur.
  select c.claim_kind into v_claim_kind
  from public.knowledge_claims c where c.id = new.claim_id;
  if v_claim_kind not in ('observed_fact', 'reported_expectation') then
    raise exception 'documents can only be observed reporting source claims, not % claims', v_claim_kind;
  end if;

  new.first_seen_at := private.kapiloto_information_clock();
  new.document_id := v_version.document_id;
  new.independence_key := coalesce(v_version.syndication_cluster, 'sha256:' || v_version.content_sha256);

  if new.quote is not null and not v_version.may_retain_text then
    raise exception 'document version % does not permit retaining excerpts', new.document_version_id;
  end if;
  if new.quote is not null and v_version.extracted_text is not null then
    new.quote_found := strpos(v_version.extracted_text, new.quote) > 0;
  else
    new.quote_found := null;
  end if;
  if new.span_end is not null and v_version.extracted_text is not null
    and new.span_end > char_length(v_version.extracted_text) then
    raise exception 'observation span lies outside the retained text';
  end if;
  return new;
end;
$$;

create trigger knowledge_claim_observations_stamp
before insert on public.knowledge_claim_observations
for each row execute function private.stamp_knowledge_claim_observation();

-- ---------------------------------------------------------------------------
-- Claim relations: the provenance graph contract
-- ---------------------------------------------------------------------------

create table public.knowledge_claim_relations (
  id uuid primary key default gen_random_uuid(),
  -- "from relation_type to": a derived claim is derived_from its premise; a
  -- newer claim supersedes or refines an older one.
  from_claim_id uuid not null references public.knowledge_claims(id) on delete restrict,
  to_claim_id uuid not null references public.knowledge_claims(id) on delete restrict,
  relation_type text not null
    check (relation_type in ('derived_from', 'supports', 'contradicts', 'supersedes', 'refines')),
  asserted_by_kind text not null
    check (asserted_by_kind in ('derivation', 'extraction', 'resolution', 'manual')),
  asserted_by_version text not null
    check (char_length(btrim(asserted_by_version)) between 1 and 80),
  note text check (note is null or char_length(note) <= 500),
  first_seen_at timestamptz not null default now(),
  unique (from_claim_id, to_claim_id, relation_type),
  check (from_claim_id <> to_claim_id)
);

create index knowledge_claim_relations_to_idx
  on public.knowledge_claim_relations (to_claim_id, relation_type);

-- derived_from, supersedes and refines are acyclic. Each is serialized by
-- one graph lock per relation type and checked by reachability, so no
-- cycle can be formed by one insert or by two concurrent ones.
create or replace function private.stamp_knowledge_claim_relation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_from_kind text;
  v_cycle boolean;
begin
  new.first_seen_at := private.kapiloto_information_clock();
  if new.relation_type in ('derived_from', 'supersedes', 'refines') then
    perform private.kapiloto_require_read_committed('claim graph writes');
    perform pg_advisory_xact_lock(hashtextextended('kapiloto_claim_graph:' || new.relation_type, 0));

    if new.relation_type = 'derived_from' then
      select c.claim_kind into v_from_kind
      from public.knowledge_claims c
      where c.id = new.from_claim_id;
      if v_from_kind not in ('derived_inference', 'matchup_hypothesis', 'scenario', 'probability_adjustment') then
        raise exception 'only derived claims can have derived_from premises (claim kind %)', v_from_kind;
      end if;
    end if;

    with recursive reach(claim_id) as (
      select r.to_claim_id
      from public.knowledge_claim_relations r
      where r.from_claim_id = new.to_claim_id
        and r.relation_type = new.relation_type
      union
      select r.to_claim_id
      from public.knowledge_claim_relations r
      join reach on r.from_claim_id = reach.claim_id
      where r.relation_type = new.relation_type
    )
    select exists (select 1 from reach where reach.claim_id = new.from_claim_id)
      into v_cycle;
    if v_cycle then
      raise exception '% relation from % to % would create a cycle',
        new.relation_type, new.from_claim_id, new.to_claim_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger knowledge_claim_relations_stamp
before insert on public.knowledge_claim_relations
for each row execute function private.stamp_knowledge_claim_relation();

-- Every derived claim cites at least one premise by the end of the writing
-- transaction (knowledge_record_claim forces the check before returning).
create or replace function private.check_knowledge_claim_premises()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.claim_kind in ('derived_inference', 'matchup_hypothesis', 'scenario', 'probability_adjustment')
    and not exists (
      select 1 from public.knowledge_claim_relations r
      where r.from_claim_id = new.id and r.relation_type = 'derived_from'
    ) then
    raise exception 'derived claim % must cite at least one derived_from premise', new.id;
  end if;
  return null;
end;
$$;

create constraint trigger knowledge_claims_premises
after insert on public.knowledge_claims
deferrable initially deferred
for each row execute function private.check_knowledge_claim_premises();

-- ---------------------------------------------------------------------------
-- Claim resolutions: versioned adjudication (not V3's accepted/rejected)
-- ---------------------------------------------------------------------------

create table public.knowledge_claim_resolutions (
  id uuid primary key default gen_random_uuid(),
  contract_version text not null
    check (contract_version in ('kapiloto-claim-resolution-v1')),
  claim_id uuid not null references public.knowledge_claims(id) on delete restrict,
  -- Assigned by trigger: 1, 2, 3 ... per claim.
  resolution_version integer not null check (resolution_version >= 1),
  status text not null
    check (status in (
      'unresolved', 'verified', 'verified_degraded', 'quarantined',
      'contradicted', 'fabricated'
    )),
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  resolver_kind text not null
    check (resolver_kind in (
      'grounding', 'ledger_truth', 'provider_truth', 'post_match',
      'manual_review', 'model_verifier'
    )),
  resolver_version text not null check (char_length(btrim(resolver_version)) between 1 and 80),
  resolver_id text check (resolver_id is null or char_length(btrim(resolver_id)) between 1 and 120),
  reason_code text not null check (reason_code ~ '^[a-z][a-z0-9_]{1,62}$'),
  -- Metadata/provenance gaps (e.g. missing_published_at). They describe
  -- incompleteness, never falsity.
  quality_flags text[] not null default '{}'::text[],
  note text check (note is null or char_length(note) <= 1000),
  idempotency_key text
    check (idempotency_key is null or char_length(btrim(idempotency_key)) between 1 and 200),
  first_seen_at timestamptz not null default now(),
  -- Sealing key: evidence must be written by the statement that wrote the
  -- resolution, so nothing can be cited into an old resolution later.
  ingest_statement_at timestamptz not null default statement_timestamp(),
  unique (claim_id, resolution_version),
  unique (id, claim_id),
  unique (claim_id, idempotency_key),
  check (cardinality(quality_flags) <= 20),
  -- verified_degraded exists for true information with incomplete metadata,
  -- so it must say what is incomplete.
  check (status <> 'verified_degraded' or cardinality(quality_flags) >= 1),
  -- Fabrication is a positive finding about the source, never a metadata gap.
  check (status <> 'fabricated' or reason_code in (
    'source_not_found', 'document_not_found', 'quote_not_in_source',
    'fact_invented', 'identity_invented'
  ))
);

create index knowledge_claim_resolutions_claim_seen_idx
  on public.knowledge_claim_resolutions (claim_id, first_seen_at);

create or replace function private.stamp_knowledge_claim_resolution()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_latest_version integer;
  v_latest_seen timestamptz;
begin
  perform private.kapiloto_require_read_committed('claim resolution writes');
  perform pg_advisory_xact_lock(hashtextextended('kapiloto_claim_resolution:' || new.claim_id::text, 0));
  new.first_seen_at := private.kapiloto_information_clock();
  new.ingest_statement_at := statement_timestamp();

  if exists (select 1 from unnest(new.quality_flags) f where f !~ '^[a-z][a-z0-9_]{1,62}$') then
    raise exception 'quality flags must be lower-case keys';
  end if;

  select r.resolution_version, r.first_seen_at
    into v_latest_version, v_latest_seen
  from public.knowledge_claim_resolutions r
  where r.claim_id = new.claim_id
  order by r.resolution_version desc
  limit 1;

  if v_latest_version is not null then
    if new.first_seen_at < v_latest_seen then
      raise exception 'claim resolution information time would precede version %', v_latest_version;
    end if;
    new.resolution_version := v_latest_version + 1;
  else
    new.resolution_version := 1;
  end if;
  return new;
end;
$$;

create trigger knowledge_claim_resolutions_stamp
before insert on public.knowledge_claim_resolutions
for each row execute function private.stamp_knowledge_claim_resolution();

-- Typed evidence: each row cites exactly one real row through a real foreign
-- key (no generic polymorphic id, no opaque JSON array).
create table public.knowledge_resolution_evidence (
  id uuid primary key default gen_random_uuid(),
  resolution_id uuid not null references public.knowledge_claim_resolutions(id) on delete restrict,
  evidence_role text not null
    check (evidence_role in ('supporting', 'contradicting', 'context', 'absence')),
  claim_observation_id uuid references public.knowledge_claim_observations(id) on delete restrict,
  document_version_id uuid references public.knowledge_document_versions(id) on delete restrict,
  ledger_observation_id uuid references public.match_ledger_observations(id) on delete restrict,
  ledger_player_id uuid references public.match_ledger_players(id) on delete restrict,
  ledger_event_id uuid references public.match_ledger_events(id) on delete restrict,
  -- Copied by trigger: when Kapiloto first knew the cited row.
  evidence_first_seen_at timestamptz not null,
  note text check (note is null or char_length(note) <= 500),
  check (num_nonnulls(
    claim_observation_id, document_version_id, ledger_observation_id,
    ledger_player_id, ledger_event_id
  ) = 1),
  unique nulls not distinct (
    resolution_id, claim_observation_id, document_version_id,
    ledger_observation_id, ledger_player_id, ledger_event_id
  )
);

create or replace function private.prepare_knowledge_resolution_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_resolution public.knowledge_claim_resolutions%rowtype;
  v_seen timestamptz;
begin
  select r.*
    into v_resolution
  from public.knowledge_claim_resolutions r
  where r.id = new.resolution_id;
  if not found then
    raise exception 'claim resolution % not found', new.resolution_id;
  end if;
  if v_resolution.ingest_statement_at <> statement_timestamp() then
    raise exception 'claim resolution % is sealed', new.resolution_id;
  end if;

  if new.claim_observation_id is not null then
    select o.first_seen_at into v_seen
    from public.knowledge_claim_observations o where o.id = new.claim_observation_id;
  elsif new.document_version_id is not null then
    select v.first_seen_at into v_seen
    from public.knowledge_document_versions v where v.id = new.document_version_id;
  elsif new.ledger_observation_id is not null then
    select o.first_seen_at into v_seen
    from public.match_ledger_observations o where o.id = new.ledger_observation_id;
  elsif new.ledger_player_id is not null then
    select p.first_seen_at into v_seen
    from public.match_ledger_players p where p.id = new.ledger_player_id;
  elsif new.ledger_event_id is not null then
    select o.first_seen_at into v_seen
    from public.match_ledger_events e
    join public.match_ledger_observations o on o.id = e.observation_id
    where e.id = new.ledger_event_id;
  end if;

  if v_seen is null then
    raise exception 'resolution evidence row not found';
  end if;
  -- A resolution cannot cite information Kapiloto did not yet have.
  if v_seen > v_resolution.first_seen_at then
    raise exception 'resolution evidence was first seen after the resolution';
  end if;
  new.evidence_first_seen_at := v_seen;
  return new;
end;
$$;

create trigger knowledge_resolution_evidence_prepare
before insert on public.knowledge_resolution_evidence
for each row execute function private.prepare_knowledge_resolution_evidence();

-- Adjudications other than unresolved/quarantined must be auditable.
create or replace function private.check_knowledge_resolution_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('verified', 'verified_degraded', 'contradicted', 'fabricated')
    and not exists (
      select 1 from public.knowledge_resolution_evidence e where e.resolution_id = new.id
    ) then
    raise exception 'a % claim resolution must cite evidence', new.status;
  end if;
  return null;
end;
$$;

create constraint trigger knowledge_claim_resolutions_evidence
after insert on public.knowledge_claim_resolutions
deferrable initially deferred
for each row execute function private.check_knowledge_resolution_evidence();

-- ---------------------------------------------------------------------------
-- Prediction registry
-- ---------------------------------------------------------------------------

create table public.prediction_snapshots (
  id uuid primary key default gen_random_uuid(),
  contract_version text not null
    check (contract_version in ('kapiloto-prediction-snapshot-v1')),
  -- Replay key of ONE intended write. Never derived from content: two
  -- distinct predictions with identical probabilities are two snapshots.
  idempotency_key text not null
    check (char_length(btrim(idempotency_key)) between 1 and 200),
  fixture_id uuid not null references public.fixtures(id) on delete restrict,
  round_game_id uuid references public.round_games(id) on delete restrict,
  purpose text not null
    check (purpose in ('production', 'shadow', 'benchmark', 'backtest', 'challenger')),
  prediction_protocol_version text not null
    check (char_length(btrim(prediction_protocol_version)) between 1 and 80),
  pipeline_version text not null check (char_length(btrim(pipeline_version)) between 1 and 80),
  code_revision text not null check (code_revision ~ '^[0-9a-f]{7,40}$'),
  model_identifiers jsonb not null default '{}'::jsonb,
  prompt_hashes jsonb not null default '{}'::jsonb,
  feature_versions jsonb not null default '{}'::jsonb,
  derivation_version text check (derivation_version is null or char_length(btrim(derivation_version)) between 1 and 80),
  calibration_version text check (calibration_version is null or char_length(btrim(calibration_version)) between 1 and 80),
  settlement_rule text check (settlement_rule is null or char_length(btrim(settlement_rule)) between 1 and 80),
  -- Information cutoff: every linked input was first seen at or before it.
  research_cutoff_at timestamptz not null,
  kickoff_at_snapshot timestamptz not null,
  -- When the pipeline produced the output (writer supplied, informational).
  generated_at timestamptz not null,
  -- When Kapiloto recorded the snapshot (database clock).
  first_seen_at timestamptz not null default now(),
  -- Sealing key: inputs and bindings must be written by the same statement.
  ingest_statement_at timestamptz not null default statement_timestamp(),
  outcome text not null check (outcome in ('predicted', 'abstained')),
  abstain_reason text check (abstain_reason is null or char_length(btrim(abstain_reason)) between 1 and 300),
  p_1_bp smallint check (p_1_bp is null or p_1_bp between 0 and 10000),
  p_x_bp smallint check (p_x_bp is null or p_x_bp between 0 and 10000),
  p_2_bp smallint check (p_2_bp is null or p_2_bp between 0 and 10000),
  reliability numeric(5,4) check (reliability is null or reliability between 0 and 1),
  uncertainty jsonb not null default '{}'::jsonb,
  payload_schema_version text not null
    check (char_length(btrim(payload_schema_version)) between 1 and 80),
  -- Versioned, bounded model sections. Auditable rationale artifacts only;
  -- hidden reasoning traces are never stored.
  payload jsonb not null default '{}'::jsonb,
  -- SHA-256 of the canonical input bundle (verified against the link rows
  -- at the end of the writing transaction).
  input_bundle_sha256 text not null check (input_bundle_sha256 ~ '^[0-9a-f]{64}$'),
  -- SHA-256 of the outputs, computed by trigger.
  output_bundle_sha256 text not null check (output_bundle_sha256 ~ '^[0-9a-f]{64}$'),
  unique (idempotency_key),
  check (
    (outcome = 'predicted'
      and p_1_bp is not null and p_x_bp is not null and p_2_bp is not null
      and p_1_bp + p_x_bp + p_2_bp = 10000
      and abstain_reason is null)
    or (outcome = 'abstained'
      and p_1_bp is null and p_x_bp is null and p_2_bp is null
      and abstain_reason is not null)
  ),
  check (research_cutoff_at <= kickoff_at_snapshot),
  check (research_cutoff_at <= first_seen_at),
  check (generated_at >= research_cutoff_at and generated_at <= first_seen_at + interval '5 minutes'),
  check (jsonb_typeof(model_identifiers) = 'object' and octet_length(model_identifiers::text) <= 4000),
  check (jsonb_typeof(prompt_hashes) = 'object' and octet_length(prompt_hashes::text) <= 4000),
  check (jsonb_typeof(feature_versions) = 'object' and octet_length(feature_versions::text) <= 4000),
  check (jsonb_typeof(uncertainty) = 'object' and octet_length(uncertainty::text) <= 8000),
  check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  check ((payload - array[
    'formation_estimate', 'lineup_estimate', 'scenarios', 'tactical_state',
    'matchup_hypotheses', 'recommendation', 'rationale'
  ]::text[]) = '{}'::jsonb)
);

create index prediction_snapshots_fixture_idx
  on public.prediction_snapshots (fixture_id, research_cutoff_at);

create table public.prediction_ledger_inputs (
  snapshot_id uuid not null references public.prediction_snapshots(id) on delete restrict,
  ledger_observation_id uuid not null references public.match_ledger_observations(id) on delete restrict,
  input_role text not null check (input_role ~ '^[a-z][a-z0-9_]{1,62}$'),
  input_first_seen_at timestamptz not null,
  primary key (snapshot_id, ledger_observation_id)
);

create table public.prediction_document_inputs (
  snapshot_id uuid not null references public.prediction_snapshots(id) on delete restrict,
  document_version_id uuid not null references public.knowledge_document_versions(id) on delete restrict,
  input_role text not null check (input_role ~ '^[a-z][a-z0-9_]{1,62}$'),
  input_first_seen_at timestamptz not null,
  primary key (snapshot_id, document_version_id)
);

-- The belief a prediction used: the claim and the exact resolution version
-- it saw (null: used without any adjudication). Later resolution versions do
-- not change this row.
create table public.prediction_claim_inputs (
  snapshot_id uuid not null references public.prediction_snapshots(id) on delete restrict,
  claim_id uuid not null references public.knowledge_claims(id) on delete restrict,
  resolution_id uuid,
  -- Copied by trigger from the linked resolution ('unresolved' when none).
  resolution_status text not null
    check (resolution_status in (
      'unresolved', 'verified', 'verified_degraded', 'quarantined',
      'contradicted', 'fabricated'
    )),
  input_role text not null check (input_role ~ '^[a-z][a-z0-9_]{1,62}$'),
  input_first_seen_at timestamptz not null,
  primary key (snapshot_id, claim_id),
  foreign key (resolution_id, claim_id)
    references public.knowledge_claim_resolutions(id, claim_id) on delete restrict
);

create table public.prediction_claim_observation_inputs (
  snapshot_id uuid not null references public.prediction_snapshots(id) on delete restrict,
  claim_observation_id uuid not null references public.knowledge_claim_observations(id) on delete restrict,
  input_role text not null check (input_role ~ '^[a-z][a-z0-9_]{1,62}$'),
  input_first_seen_at timestamptz not null,
  primary key (snapshot_id, claim_observation_id)
);

-- Existing snapshot/market tables (typed foreign keys) and legacy V3
-- research rows (soft provenance ids: v3_research_run, v3_analysis,
-- v3_evidence; not validated, never used for leakage decisions).
-- market_quote_id points at a shadow-evaluation table, which stays out of
-- the shared generated types: it has no foreign key, and the trigger checks
-- that the quote exists (quotes are immutable, so it cannot disappear).
create table public.prediction_reference_inputs (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.prediction_snapshots(id) on delete restrict,
  reference_kind text not null
    check (reference_kind in (
      'market_quote', 'market_snapshot', 'structured_snapshot', 'fact_snapshot',
      'v3_research_run', 'v3_analysis', 'v3_evidence'
    )),
  market_quote_id uuid,
  market_snapshot_id uuid references public.fixture_market_snapshots(id) on delete restrict,
  structured_snapshot_id uuid references public.fixture_structured_snapshots(id) on delete restrict,
  fact_snapshot_id uuid references public.fixture_fact_snapshots(id) on delete restrict,
  legacy_v3_id uuid,
  input_role text not null check (input_role ~ '^[a-z][a-z0-9_]{1,62}$'),
  -- Copied by trigger: capture/cutoff time of the referenced row, when known.
  input_time_at timestamptz,
  -- Trigger: SHA-256 of the referenced row as it was when linked, so a later
  -- change to a mutable source table is detectable (null for soft V3 ids).
  referenced_row_sha256 text
    check (referenced_row_sha256 is null or referenced_row_sha256 ~ '^[0-9a-f]{64}$'),
  check ((reference_kind = 'market_quote') = (market_quote_id is not null)),
  check ((reference_kind = 'market_snapshot') = (market_snapshot_id is not null)),
  check ((reference_kind = 'structured_snapshot') = (structured_snapshot_id is not null)),
  check ((reference_kind = 'fact_snapshot') = (fact_snapshot_id is not null)),
  check ((reference_kind in ('v3_research_run', 'v3_analysis', 'v3_evidence')) = (legacy_v3_id is not null)),
  unique nulls not distinct (
    snapshot_id, reference_kind, market_quote_id, market_snapshot_id,
    structured_snapshot_id, fact_snapshot_id, legacy_v3_id
  )
);

-- Canonical identity as the prediction used it (immutable). The bound id was
-- an active canonical entity at recording time; a later merge does not touch
-- this row, so a replay can prove which ids the live model kept separate.
create table public.prediction_identity_bindings (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.prediction_snapshots(id) on delete restrict,
  entity_type text not null check (entity_type in ('player', 'coach', 'team')),
  player_id uuid references public.players(id) on delete restrict,
  coach_id uuid references public.coaches(id) on delete restrict,
  team_id uuid references public.teams(id) on delete restrict,
  -- Raw id as stored in an input (e.g. a ledger row written before a merge).
  observed_player_id uuid references public.players(id) on delete restrict,
  observed_coach_id uuid references public.coaches(id) on delete restrict,
  binding_role text not null check (binding_role ~ '^[a-z][a-z0-9_]{1,62}$'),
  context_team_id uuid references public.teams(id) on delete restrict,
  provider text check (provider is null or provider ~ '^[a-z0-9_]{1,40}$'),
  provider_entity_id text
    check (provider_entity_id is null or char_length(btrim(provider_entity_id)) between 1 and 80),
  check ((entity_type = 'player') = (player_id is not null)),
  check ((entity_type = 'coach') = (coach_id is not null)),
  check ((entity_type = 'team') = (team_id is not null)),
  check (observed_player_id is null or entity_type = 'player'),
  check (observed_coach_id is null or entity_type = 'coach'),
  check ((provider is null) = (provider_entity_id is null)),
  unique nulls not distinct (snapshot_id, entity_type, player_id, coach_id, team_id, binding_role)
);

create index prediction_identity_bindings_player_idx
  on public.prediction_identity_bindings (player_id) where player_id is not null;

create index prediction_identity_bindings_coach_idx
  on public.prediction_identity_bindings (coach_id) where coach_id is not null;

create or replace function private.prediction_output_sha256(
  p_outcome text,
  p_abstain_reason text,
  p_1_bp smallint,
  p_x_bp smallint,
  p_2_bp smallint,
  p_reliability numeric,
  p_uncertainty jsonb,
  p_payload_schema_version text,
  p_payload jsonb
)
returns text
language sql
stable
set search_path = ''
set timezone = 'UTC'
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'outcome', p_outcome,
    'abstain_reason', p_abstain_reason,
    'p_1_bp', p_1_bp,
    'p_x_bp', p_x_bp,
    'p_2_bp', p_2_bp,
    'reliability', round(p_reliability, 4),
    'uncertainty', p_uncertainty,
    'payload_schema_version', p_payload_schema_version,
    'payload', p_payload
  )::text, 'UTF8')), 'hex')
$$;

-- Canonical input bundle: typed, defaulted, each list sorted. Used by the
-- RPC (from the payload) and by the commit-time check (from the link rows),
-- so equal inputs always hash equally.
create or replace function private.prediction_canonical_inputs(p_inputs jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_inputs jsonb := coalesce(p_inputs, '{}'::jsonb);
  v_result jsonb;
begin
  perform private.kapiloto_v4_assert_keys(v_inputs, array[
    'ledger', 'documents', 'claims', 'claim_observations', 'references', 'identities'
  ], 'prediction inputs');
  perform private.kapiloto_v4_assert_keys(coalesce(v_inputs->'ledger', '[]'::jsonb),
    array['ledger_observation_id', 'input_role'], 'ledger input');
  perform private.kapiloto_v4_assert_keys(coalesce(v_inputs->'documents', '[]'::jsonb),
    array['document_version_id', 'input_role'], 'document input');
  perform private.kapiloto_v4_assert_keys(coalesce(v_inputs->'claims', '[]'::jsonb),
    array['claim_id', 'resolution_id', 'input_role'], 'claim input');
  perform private.kapiloto_v4_assert_keys(coalesce(v_inputs->'claim_observations', '[]'::jsonb),
    array['claim_observation_id', 'input_role'], 'claim observation input');
  perform private.kapiloto_v4_assert_keys(coalesce(v_inputs->'references', '[]'::jsonb),
    array['reference_kind', 'reference_id', 'input_role'], 'reference input');
  perform private.kapiloto_v4_assert_keys(coalesce(v_inputs->'identities', '[]'::jsonb),
    array['entity_type', 'entity_id', 'observed_entity_id', 'binding_role',
      'context_team_id', 'provider', 'provider_entity_id'], 'identity binding');

  select jsonb_build_object(
    'ledger', coalesce((
      select jsonb_agg(e order by e::text) from (
        select jsonb_build_object(
          'ledger_observation_id', x.ledger_observation_id,
          'input_role', coalesce(x.input_role, 'history')
        ) as e
        from jsonb_to_recordset(coalesce(v_inputs->'ledger', '[]'::jsonb))
          as x(ledger_observation_id uuid, input_role text)
      ) s), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(e order by e::text) from (
        select jsonb_build_object(
          'document_version_id', x.document_version_id,
          'input_role', coalesce(x.input_role, 'source')
        ) as e
        from jsonb_to_recordset(coalesce(v_inputs->'documents', '[]'::jsonb))
          as x(document_version_id uuid, input_role text)
      ) s), '[]'::jsonb),
    'claims', coalesce((
      select jsonb_agg(e order by e::text) from (
        select jsonb_build_object(
          'claim_id', x.claim_id,
          'resolution_id', x.resolution_id,
          'input_role', coalesce(x.input_role, 'belief')
        ) as e
        from jsonb_to_recordset(coalesce(v_inputs->'claims', '[]'::jsonb))
          as x(claim_id uuid, resolution_id uuid, input_role text)
      ) s), '[]'::jsonb),
    'claim_observations', coalesce((
      select jsonb_agg(e order by e::text) from (
        select jsonb_build_object(
          'claim_observation_id', x.claim_observation_id,
          'input_role', coalesce(x.input_role, 'evidence')
        ) as e
        from jsonb_to_recordset(coalesce(v_inputs->'claim_observations', '[]'::jsonb))
          as x(claim_observation_id uuid, input_role text)
      ) s), '[]'::jsonb),
    'references', coalesce((
      select jsonb_agg(e order by e::text) from (
        select jsonb_build_object(
          'reference_kind', x.reference_kind,
          'reference_id', x.reference_id,
          'input_role', coalesce(x.input_role, 'context')
        ) as e
        from jsonb_to_recordset(coalesce(v_inputs->'references', '[]'::jsonb))
          as x(reference_kind text, reference_id uuid, input_role text)
      ) s), '[]'::jsonb),
    'identities', coalesce((
      select jsonb_agg(e order by e::text) from (
        select jsonb_build_object(
          'entity_type', x.entity_type,
          'entity_id', x.entity_id,
          'observed_entity_id', x.observed_entity_id,
          'binding_role', x.binding_role,
          'context_team_id', x.context_team_id,
          'provider', x.provider,
          'provider_entity_id', x.provider_entity_id
        ) as e
        from jsonb_to_recordset(coalesce(v_inputs->'identities', '[]'::jsonb))
          as x(entity_type text, entity_id uuid, observed_entity_id uuid,
            binding_role text, context_team_id uuid, provider text,
            provider_entity_id text)
      ) s), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function private.prediction_input_bundle_sha256(p_inputs jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(private.prediction_canonical_inputs(p_inputs)::text, 'UTF8')), 'hex')
$$;

create or replace function private.stamp_prediction_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_round_fixture uuid;
begin
  perform private.kapiloto_require_read_committed('prediction registry writes');
  perform pg_advisory_xact_lock(hashtextextended('kapiloto_prediction:' || new.idempotency_key, 0));
  new.first_seen_at := private.kapiloto_information_clock();
  new.ingest_statement_at := statement_timestamp();

  if new.research_cutoff_at > new.first_seen_at then
    raise exception 'prediction cutoff % is after its recording time %', new.research_cutoff_at, new.first_seen_at;
  end if;
  if new.round_game_id is not null then
    select rg.fixture_id into v_round_fixture
    from public.round_games rg where rg.id = new.round_game_id;
    if v_round_fixture is distinct from new.fixture_id then
      raise exception 'round game % does not belong to fixture %', new.round_game_id, new.fixture_id;
    end if;
  end if;

  new.output_bundle_sha256 := private.prediction_output_sha256(
    new.outcome, new.abstain_reason, new.p_1_bp, new.p_x_bp, new.p_2_bp,
    new.reliability, new.uncertainty, new.payload_schema_version, new.payload
  );
  return new;
end;
$$;

create trigger prediction_snapshots_stamp
before insert on public.prediction_snapshots
for each row execute function private.stamp_prediction_snapshot();

-- Fail-closed anti-leakage boundary: every input must have been known at the
-- prediction's cutoff, fixture-scoped references must belong to the
-- predicted fixture, and identity bindings must name active canonical ids.
create or replace function private.prepare_prediction_input()
returns trigger
language plpgsql
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_snapshot public.prediction_snapshots%rowtype;
  v_seen timestamptz;
  v_resolution_seen timestamptz;
  v_status text;
  v_fixture uuid;
  v_row jsonb;
begin
  select s.*
    into v_snapshot
  from public.prediction_snapshots s
  where s.id = new.snapshot_id;
  if not found then
    raise exception 'prediction snapshot % not found', new.snapshot_id;
  end if;
  if v_snapshot.ingest_statement_at <> statement_timestamp() then
    raise exception 'prediction snapshot % is sealed', new.snapshot_id;
  end if;

  -- Nested ifs: plpgsql does not short-circuit record field access.
  if tg_table_name = 'prediction_ledger_inputs' then
    select o.first_seen_at into v_seen
    from public.match_ledger_observations o where o.id = new.ledger_observation_id;
    if not found then
      raise exception 'match ledger observation % not found', new.ledger_observation_id;
    end if;
    if v_seen > v_snapshot.research_cutoff_at then
      raise exception 'match ledger observation % was first seen after the prediction cutoff', new.ledger_observation_id;
    end if;
    new.input_first_seen_at := v_seen;

  elsif tg_table_name = 'prediction_document_inputs' then
    select v.first_seen_at into v_seen
    from public.knowledge_document_versions v where v.id = new.document_version_id;
    if not found then
      raise exception 'document version % not found', new.document_version_id;
    end if;
    if v_seen > v_snapshot.research_cutoff_at then
      raise exception 'document version % was first seen after the prediction cutoff', new.document_version_id;
    end if;
    new.input_first_seen_at := v_seen;

  elsif tg_table_name = 'prediction_claim_inputs' then
    select c.first_seen_at into v_seen
    from public.knowledge_claims c where c.id = new.claim_id;
    if not found then
      raise exception 'claim % not found', new.claim_id;
    end if;
    v_status := 'unresolved';
    if new.resolution_id is not null then
      select r.first_seen_at, r.status into v_resolution_seen, v_status
      from public.knowledge_claim_resolutions r
      where r.id = new.resolution_id and r.claim_id = new.claim_id;
      if not found then
        raise exception 'resolution % does not belong to claim %', new.resolution_id, new.claim_id;
      end if;
      v_seen := greatest(v_seen, v_resolution_seen);
    end if;
    if v_seen > v_snapshot.research_cutoff_at then
      raise exception 'claim % or its resolution was first seen after the prediction cutoff', new.claim_id;
    end if;
    new.resolution_status := v_status;
    new.input_first_seen_at := v_seen;

  elsif tg_table_name = 'prediction_claim_observation_inputs' then
    select o.first_seen_at into v_seen
    from public.knowledge_claim_observations o where o.id = new.claim_observation_id;
    if not found then
      raise exception 'claim observation % not found', new.claim_observation_id;
    end if;
    if v_seen > v_snapshot.research_cutoff_at then
      raise exception 'claim observation % was first seen after the prediction cutoff', new.claim_observation_id;
    end if;
    new.input_first_seen_at := v_seen;

  elsif tg_table_name = 'prediction_reference_inputs' then
    if new.market_quote_id is not null then
      -- captured_at is database-stamped (shadow evaluation tables).
      select q.captured_at, q.fixture_id, to_jsonb(q) into v_seen, v_fixture, v_row
      from public.fixture_market_quotes q where q.id = new.market_quote_id;
      if not found then
        raise exception 'market quote % not found', new.market_quote_id;
      end if;
      if v_fixture is distinct from v_snapshot.fixture_id then
        raise exception 'market quote % belongs to another fixture', new.market_quote_id;
      end if;
    elsif new.market_snapshot_id is not null then
      -- captured_at is writer supplied in this V1 table: enforced as given.
      select m.captured_at, m.fixture_id, to_jsonb(m) into v_seen, v_fixture, v_row
      from public.fixture_market_snapshots m where m.id = new.market_snapshot_id;
      if v_fixture is distinct from v_snapshot.fixture_id then
        raise exception 'market snapshot % belongs to another fixture', new.market_snapshot_id;
      end if;
    elsif new.structured_snapshot_id is not null then
      select greatest(s.research_cutoff_at, s.computed_at), s.fixture_id, to_jsonb(s) into v_seen, v_fixture, v_row
      from public.fixture_structured_snapshots s where s.id = new.structured_snapshot_id;
      if v_fixture is distinct from v_snapshot.fixture_id then
        raise exception 'structured snapshot % belongs to another fixture', new.structured_snapshot_id;
      end if;
    elsif new.fact_snapshot_id is not null then
      select greatest(f.captured_at, coalesce(f.source_observed_at, f.captured_at)), f.fixture_id, to_jsonb(f)
        into v_seen, v_fixture, v_row
      from public.fixture_fact_snapshots f where f.id = new.fact_snapshot_id;
      if v_fixture is distinct from v_snapshot.fixture_id then
        raise exception 'fact snapshot % belongs to another fixture', new.fact_snapshot_id;
      end if;
    end if;
    if v_seen > v_snapshot.research_cutoff_at then
      raise exception '% reference was captured after the prediction cutoff', new.reference_kind;
    end if;
    new.input_time_at := v_seen;
    new.referenced_row_sha256 := case
      when v_row is null then null
      else encode(sha256(convert_to(v_row::text, 'UTF8')), 'hex')
    end;

  elsif tg_table_name = 'prediction_identity_bindings' then
    if new.player_id is not null then
      perform private.lock_canonical_identity('players', false);
      if exists (
        select 1 from public.players p
        where p.id = new.player_id and p.identity_status = 'merged'
      ) then
        raise exception 'player % is merged into %; bind the surviving id the prediction used',
          new.player_id, private.surviving_player_id(new.player_id);
      end if;
    elsif new.coach_id is not null then
      perform private.lock_canonical_identity('coaches', false);
      if exists (
        select 1 from public.coaches c
        where c.id = new.coach_id and c.identity_status = 'merged'
      ) then
        raise exception 'coach % is merged into %; bind the surviving id the prediction used',
          new.coach_id, private.surviving_coach_id(new.coach_id);
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger prediction_ledger_inputs_prepare
before insert on public.prediction_ledger_inputs
for each row execute function private.prepare_prediction_input();

create trigger prediction_document_inputs_prepare
before insert on public.prediction_document_inputs
for each row execute function private.prepare_prediction_input();

create trigger prediction_claim_inputs_prepare
before insert on public.prediction_claim_inputs
for each row execute function private.prepare_prediction_input();

create trigger prediction_claim_observation_inputs_prepare
before insert on public.prediction_claim_observation_inputs
for each row execute function private.prepare_prediction_input();

create trigger prediction_reference_inputs_prepare
before insert on public.prediction_reference_inputs
for each row execute function private.prepare_prediction_input();

create trigger prediction_identity_bindings_prepare
before insert on public.prediction_identity_bindings
for each row execute function private.prepare_prediction_input();

-- The stored bundle hash must describe exactly the link rows (checked at the
-- end of the writing transaction; the RPC forces it before returning).
create or replace function private.check_prediction_input_bundle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_inputs jsonb;
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

  if private.prediction_input_bundle_sha256(v_inputs) <> new.input_bundle_sha256 then
    raise exception 'prediction % input links do not match its input bundle hash', new.id;
  end if;
  return null;
end;
$$;

create constraint trigger prediction_snapshots_input_bundle
after insert on public.prediction_snapshots
deferrable initially deferred
for each row execute function private.check_prediction_input_bundle();

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------

create trigger knowledge_documents_immutable
before update or delete on public.knowledge_documents
for each row execute function private.kapiloto_v4_reject_change();
create trigger knowledge_documents_no_truncate
before truncate on public.knowledge_documents
for each statement execute function private.kapiloto_v4_reject_change();

create trigger knowledge_document_versions_immutable
before update or delete on public.knowledge_document_versions
for each row execute function private.kapiloto_v4_reject_change();
create trigger knowledge_document_versions_no_truncate
before truncate on public.knowledge_document_versions
for each statement execute function private.kapiloto_v4_reject_change();

create trigger knowledge_claims_immutable
before update or delete on public.knowledge_claims
for each row execute function private.kapiloto_v4_reject_change();
create trigger knowledge_claims_no_truncate
before truncate on public.knowledge_claims
for each statement execute function private.kapiloto_v4_reject_change();

create trigger knowledge_claim_observations_immutable
before update or delete on public.knowledge_claim_observations
for each row execute function private.kapiloto_v4_reject_change();
create trigger knowledge_claim_observations_no_truncate
before truncate on public.knowledge_claim_observations
for each statement execute function private.kapiloto_v4_reject_change();

create trigger knowledge_claim_relations_immutable
before update or delete on public.knowledge_claim_relations
for each row execute function private.kapiloto_v4_reject_change();
create trigger knowledge_claim_relations_no_truncate
before truncate on public.knowledge_claim_relations
for each statement execute function private.kapiloto_v4_reject_change();

create trigger knowledge_claim_resolutions_immutable
before update or delete on public.knowledge_claim_resolutions
for each row execute function private.kapiloto_v4_reject_change();
create trigger knowledge_claim_resolutions_no_truncate
before truncate on public.knowledge_claim_resolutions
for each statement execute function private.kapiloto_v4_reject_change();

create trigger knowledge_resolution_evidence_immutable
before update or delete on public.knowledge_resolution_evidence
for each row execute function private.kapiloto_v4_reject_change();
create trigger knowledge_resolution_evidence_no_truncate
before truncate on public.knowledge_resolution_evidence
for each statement execute function private.kapiloto_v4_reject_change();

create trigger prediction_snapshots_immutable
before update or delete on public.prediction_snapshots
for each row execute function private.kapiloto_v4_reject_change();
create trigger prediction_snapshots_no_truncate
before truncate on public.prediction_snapshots
for each statement execute function private.kapiloto_v4_reject_change();

create trigger prediction_ledger_inputs_immutable
before update or delete on public.prediction_ledger_inputs
for each row execute function private.kapiloto_v4_reject_change();
create trigger prediction_ledger_inputs_no_truncate
before truncate on public.prediction_ledger_inputs
for each statement execute function private.kapiloto_v4_reject_change();

create trigger prediction_document_inputs_immutable
before update or delete on public.prediction_document_inputs
for each row execute function private.kapiloto_v4_reject_change();
create trigger prediction_document_inputs_no_truncate
before truncate on public.prediction_document_inputs
for each statement execute function private.kapiloto_v4_reject_change();

create trigger prediction_claim_inputs_immutable
before update or delete on public.prediction_claim_inputs
for each row execute function private.kapiloto_v4_reject_change();
create trigger prediction_claim_inputs_no_truncate
before truncate on public.prediction_claim_inputs
for each statement execute function private.kapiloto_v4_reject_change();

create trigger prediction_claim_observation_inputs_immutable
before update or delete on public.prediction_claim_observation_inputs
for each row execute function private.kapiloto_v4_reject_change();
create trigger prediction_claim_observation_inputs_no_truncate
before truncate on public.prediction_claim_observation_inputs
for each statement execute function private.kapiloto_v4_reject_change();

create trigger prediction_reference_inputs_immutable
before update or delete on public.prediction_reference_inputs
for each row execute function private.kapiloto_v4_reject_change();
create trigger prediction_reference_inputs_no_truncate
before truncate on public.prediction_reference_inputs
for each statement execute function private.kapiloto_v4_reject_change();

create trigger prediction_identity_bindings_immutable
before update or delete on public.prediction_identity_bindings
for each row execute function private.kapiloto_v4_reject_change();
create trigger prediction_identity_bindings_no_truncate
before truncate on public.prediction_identity_bindings
for each statement execute function private.kapiloto_v4_reject_change();

-- ---------------------------------------------------------------------------
-- Write RPCs (atomic, canonicalized, service_role only)
-- ---------------------------------------------------------------------------

create or replace function public.knowledge_record_document_version(p_document jsonb)
returns jsonb
language plpgsql
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v record;
  v_identity text;
  v_document public.knowledge_documents%rowtype;
  v_latest public.knowledge_document_versions%rowtype;
  v_fingerprint text;
  v_id uuid;
  v_version integer;
  v_first_seen timestamptz;
begin
  if p_document is null or jsonb_typeof(p_document) <> 'object' then
    raise exception 'document version must be a JSON object';
  end if;
  if p_document->>'contract_version' is distinct from 'kapiloto-document-version-v1' then
    raise exception 'unsupported document version contract';
  end if;
  perform private.kapiloto_v4_assert_keys(p_document, array[
    'contract_version', 'source_kind', 'canonical_url', 'provider', 'platform',
    'external_id', 'domain', 'publisher', 'source_account', 'title', 'author',
    'language_code', 'published_at', 'source_updated_at', 'retrieved_at',
    'content_sha256', 'raw_content_sha256', 'raw_content_uri', 'extracted_text',
    'extraction_version', 'syndication_cluster', 'access_basis',
    'may_retain_raw', 'may_retain_text', 'may_expose_excerpts', 'rights_note',
    'discovery_channel', 'discovery_query_sha256', 'discovery_rank',
    'discovered_at', 'ingest_version', 'metadata'
  ], 'document version');

  select * into v
  from jsonb_to_record(p_document) as d(
    source_kind text, canonical_url text, provider text, platform text,
    external_id text, domain text, publisher text, source_account text,
    title text, author text, language_code text, published_at timestamptz,
    source_updated_at timestamptz, retrieved_at timestamptz,
    content_sha256 text, raw_content_sha256 text, raw_content_uri text,
    extracted_text text, extraction_version text, syndication_cluster text,
    access_basis text, may_retain_raw boolean, may_retain_text boolean,
    may_expose_excerpts boolean, rights_note text, discovery_channel text,
    discovery_query_sha256 text, discovery_rank smallint,
    discovered_at timestamptz, ingest_version text, metadata jsonb
  );

  v_identity := case
    when v.external_id is not null and coalesce(v.provider, v.platform) is not null
      then 'ext:' || coalesce(v.provider, v.platform) || ':' || v.external_id
    else 'url:' || v.canonical_url
  end;
  if v_identity is null then
    raise exception 'a document needs a canonical URL or a provider/platform external id';
  end if;

  perform private.kapiloto_require_read_committed('document archive writes');
  perform pg_advisory_xact_lock(hashtextextended('kapiloto_document_identity:' || v_identity, 0));
  insert into public.knowledge_documents (
    source_kind, canonical_url, provider, platform, external_id, domain,
    publisher, source_account
  )
  values (
    v.source_kind, v.canonical_url, v.provider, v.platform, v.external_id,
    v.domain, v.publisher, v.source_account
  )
  on conflict (identity_key) do nothing;

  select d.* into v_document
  from public.knowledge_documents d where d.identity_key = v_identity;

  -- Document identity is immutable: a different source kind or source
  -- attribution for the same identity is a conflict, not an update.
  if v.source_kind is distinct from v_document.source_kind
    or (v.domain is not null and v.domain is distinct from v_document.domain)
    or (v.publisher is not null and v.publisher is distinct from v_document.publisher)
    or (v.source_account is not null and v.source_account is distinct from v_document.source_account) then
    raise exception 'document % already exists with a different identity', v_identity;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('kapiloto_document_version:' || v_document.id::text, 0));
  v_fingerprint := private.knowledge_document_version_fingerprint(
    v.content_sha256, v.canonical_url, v.title, v.author, v.language_code,
    v.published_at, v.access_basis, coalesce(v.may_retain_raw, false),
    coalesce(v.may_retain_text, false), coalesce(v.may_expose_excerpts, false)
  );

  select dv.* into v_latest
  from public.knowledge_document_versions dv
  where dv.document_id = v_document.id
  order by dv.version_no desc
  limit 1;

  if found and v_latest.version_fingerprint = v_fingerprint then
    return jsonb_build_object(
      'status', 'unchanged',
      'document_id', v_document.id,
      'document_version_id', v_latest.id,
      'version_no', v_latest.version_no,
      'first_seen_at', v_latest.first_seen_at
    );
  end if;

  -- version_no, first_seen_at, syndication inheritance and the fingerprint
  -- are assigned by the stamp trigger.
  insert into public.knowledge_document_versions (
    contract_version, document_id, version_no, canonical_url, title, author,
    language_code, published_at, source_updated_at, retrieved_at,
    content_sha256, raw_content_sha256, raw_content_uri, extracted_text,
    extraction_version, syndication_cluster, access_basis, may_retain_raw,
    may_retain_text, may_expose_excerpts, rights_note, discovery_channel,
    discovery_query_sha256, discovery_rank, discovered_at, ingest_version,
    metadata, version_fingerprint
  )
  values (
    'kapiloto-document-version-v1', v_document.id, 1, v.canonical_url, v.title,
    v.author, v.language_code, v.published_at, v.source_updated_at,
    v.retrieved_at, v.content_sha256, v.raw_content_sha256, v.raw_content_uri,
    v.extracted_text, v.extraction_version, v.syndication_cluster,
    v.access_basis, coalesce(v.may_retain_raw, false),
    coalesce(v.may_retain_text, false), coalesce(v.may_expose_excerpts, false),
    v.rights_note, v.discovery_channel, v.discovery_query_sha256,
    v.discovery_rank, v.discovered_at, v.ingest_version,
    coalesce(v.metadata, '{}'::jsonb), v_fingerprint
  )
  returning id, version_no, first_seen_at into v_id, v_version, v_first_seen;

  return jsonb_build_object(
    'status', 'recorded',
    'document_id', v_document.id,
    'document_version_id', v_id,
    'version_no', v_version,
    'first_seen_at', v_first_seen
  );
end;
$$;

-- A claim is created once per structured proposition; recording an existing
-- proposition returns it ("existing"). Derived claims carry their premises
-- in the same call.
create or replace function public.knowledge_record_claim(p_claim jsonb)
returns jsonb
language plpgsql
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v record;
  v_fingerprint text;
  v_id uuid;
  v_first_seen timestamptz;
  v_status text := 'recorded';
begin
  if p_claim is null or jsonb_typeof(p_claim) <> 'object' then
    raise exception 'claim must be a JSON object';
  end if;
  if p_claim->>'contract_version' is distinct from 'kapiloto-claim-v1' then
    raise exception 'unsupported claim contract';
  end if;
  perform private.kapiloto_v4_assert_keys(p_claim, array[
    'contract_version', 'claim_kind', 'claim_type', 'predicate', 'fixture_id',
    'team_id', 'player_id', 'coach_id', 'object_value', 'polarity',
    'temporal_scope', 'scope_starts_on', 'scope_ends_on', 'statement_text',
    'premises', 'asserted_by_version'
  ], 'claim');
  perform private.kapiloto_v4_assert_keys(coalesce(p_claim->'premises', '[]'::jsonb),
    array['claim_id'], 'claim premise');

  select * into v
  from jsonb_to_record(p_claim) as c(
    claim_kind text, claim_type text, predicate text, fixture_id uuid,
    team_id uuid, player_id uuid, coach_id uuid, object_value jsonb,
    polarity text, temporal_scope text, scope_starts_on date,
    scope_ends_on date, statement_text text, asserted_by_version text
  );

  if jsonb_array_length(coalesce(p_claim->'premises', '[]'::jsonb)) > 0 and v.asserted_by_version is null then
    raise exception 'claim premises require asserted_by_version';
  end if;

  set constraints public.knowledge_claims_premises deferred;

  -- claim_fingerprint and first_seen_at are assigned by the stamp trigger.
  insert into public.knowledge_claims (
    contract_version, claim_kind, claim_type, predicate, fixture_id, team_id,
    player_id, coach_id, object_value, polarity, temporal_scope,
    scope_starts_on, scope_ends_on, statement_text, claim_fingerprint
  )
  values (
    'kapiloto-claim-v1', v.claim_kind, v.claim_type, v.predicate, v.fixture_id,
    v.team_id, v.player_id, v.coach_id, coalesce(v.object_value, '{}'::jsonb),
    coalesce(v.polarity, 'affirmed'), v.temporal_scope, v.scope_starts_on,
    v.scope_ends_on, v.statement_text, repeat('0', 64)
  )
  on conflict (claim_fingerprint) do nothing
  returning id, first_seen_at into v_id, v_first_seen;

  if v_id is null then
    v_fingerprint := private.knowledge_claim_fingerprint(
      'kapiloto-claim-v1', v.claim_kind, v.claim_type, v.predicate,
      v.fixture_id, v.team_id, v.player_id, v.coach_id,
      coalesce(v.object_value, '{}'::jsonb), coalesce(v.polarity, 'affirmed'),
      v.temporal_scope, v.scope_starts_on, v.scope_ends_on
    );
    select c.id, c.first_seen_at into v_id, v_first_seen
    from public.knowledge_claims c where c.claim_fingerprint = v_fingerprint;
    v_status := 'existing';
  end if;

  insert into public.knowledge_claim_relations (
    from_claim_id, to_claim_id, relation_type, asserted_by_kind, asserted_by_version
  )
  select v_id, x.claim_id, 'derived_from', 'derivation', v.asserted_by_version
  from jsonb_to_recordset(coalesce(p_claim->'premises', '[]'::jsonb)) as x(claim_id uuid)
  on conflict (from_claim_id, to_claim_id, relation_type) do nothing;

  set constraints public.knowledge_claims_premises immediate;

  return jsonb_build_object(
    'status', v_status,
    'claim_id', v_id,
    'first_seen_at', v_first_seen
  );
end;
$$;

create or replace function public.knowledge_record_claim_resolution(p_resolution jsonb)
returns jsonb
language plpgsql
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v record;
  v_existing public.knowledge_claim_resolutions%rowtype;
  v_id uuid;
  v_version integer;
  v_first_seen timestamptz;
begin
  if p_resolution is null or jsonb_typeof(p_resolution) <> 'object' then
    raise exception 'claim resolution must be a JSON object';
  end if;
  if p_resolution->>'contract_version' is distinct from 'kapiloto-claim-resolution-v1' then
    raise exception 'unsupported claim resolution contract';
  end if;
  perform private.kapiloto_v4_assert_keys(p_resolution, array[
    'contract_version', 'claim_id', 'status', 'confidence', 'resolver_kind',
    'resolver_version', 'resolver_id', 'reason_code', 'quality_flags', 'note',
    'idempotency_key', 'evidence'
  ], 'claim resolution');
  perform private.kapiloto_v4_assert_keys(coalesce(p_resolution->'evidence', '[]'::jsonb), array[
    'evidence_role', 'claim_observation_id', 'document_version_id',
    'ledger_observation_id', 'ledger_player_id', 'ledger_event_id', 'note'
  ], 'resolution evidence');

  select * into v
  from jsonb_to_record(p_resolution) as r(
    claim_id uuid, status text, confidence numeric, resolver_kind text,
    resolver_version text, resolver_id text, reason_code text,
    quality_flags text[], note text, idempotency_key text
  );
  if v.claim_id is null then
    raise exception 'claim resolution requires claim_id';
  end if;

  perform private.kapiloto_require_read_committed('claim resolution writes');
  perform pg_advisory_xact_lock(hashtextextended('kapiloto_claim_resolution:' || v.claim_id::text, 0));

  if v.idempotency_key is not null then
    select r.* into v_existing
    from public.knowledge_claim_resolutions r
    where r.claim_id = v.claim_id and r.idempotency_key = v.idempotency_key;
    if found then
      if (v_existing.status, v_existing.resolver_kind, v_existing.resolver_version, v_existing.reason_code)
        is not distinct from (v.status, v.resolver_kind, v.resolver_version, v.reason_code) then
        return jsonb_build_object(
          'status', 'unchanged',
          'resolution_id', v_existing.id,
          'resolution_version', v_existing.resolution_version,
          'first_seen_at', v_existing.first_seen_at
        );
      end if;
      raise exception 'resolution idempotency key % was already used for a different resolution', v.idempotency_key;
    end if;
  end if;

  set constraints public.knowledge_claim_resolutions_evidence deferred;

  insert into public.knowledge_claim_resolutions (
    contract_version, claim_id, resolution_version, status, confidence,
    resolver_kind, resolver_version, resolver_id, reason_code, quality_flags,
    note, idempotency_key
  )
  values (
    'kapiloto-claim-resolution-v1', v.claim_id, 1, v.status, v.confidence,
    v.resolver_kind, v.resolver_version, v.resolver_id, v.reason_code,
    coalesce(v.quality_flags, '{}'::text[]), v.note, v.idempotency_key
  )
  returning id, resolution_version, first_seen_at into v_id, v_version, v_first_seen;

  insert into public.knowledge_resolution_evidence (
    resolution_id, evidence_role, claim_observation_id, document_version_id,
    ledger_observation_id, ledger_player_id, ledger_event_id,
    evidence_first_seen_at, note
  )
  select
    v_id, e.evidence_role, e.claim_observation_id, e.document_version_id,
    e.ledger_observation_id, e.ledger_player_id, e.ledger_event_id,
    v_first_seen, e.note
  from jsonb_to_recordset(coalesce(p_resolution->'evidence', '[]'::jsonb)) as e(
    evidence_role text, claim_observation_id uuid, document_version_id uuid,
    ledger_observation_id uuid, ledger_player_id uuid, ledger_event_id uuid,
    note text
  );

  set constraints public.knowledge_claim_resolutions_evidence immediate;

  return jsonb_build_object(
    'status', 'recorded',
    'resolution_id', v_id,
    'resolution_version', v_version,
    'first_seen_at', v_first_seen
  );
end;
$$;

create or replace function public.prediction_record_snapshot(p_snapshot jsonb)
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
  if p_snapshot->>'contract_version' is distinct from 'kapiloto-prediction-snapshot-v1' then
    raise exception 'unsupported prediction snapshot contract';
  end if;
  perform private.kapiloto_v4_assert_keys(p_snapshot, array[
    'contract_version', 'idempotency_key', 'fixture_id', 'round_game_id',
    'purpose', 'prediction_protocol_version', 'pipeline_version',
    'code_revision', 'model_identifiers', 'prompt_hashes', 'feature_versions',
    'derivation_version', 'calibration_version', 'settlement_rule',
    'research_cutoff_at', 'kickoff_at_snapshot', 'generated_at', 'outcome',
    'abstain_reason', 'p_1_bp', 'p_x_bp', 'p_2_bp', 'reliability',
    'uncertainty', 'payload_schema_version', 'payload', 'inputs'
  ], 'prediction snapshot');

  select * into v
  from jsonb_to_record(p_snapshot) as s(
    idempotency_key text, fixture_id uuid, round_game_id uuid, purpose text,
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

  v_inputs := private.prediction_canonical_inputs(p_snapshot->'inputs');
  if exists (
    select 1 from jsonb_array_elements(v_inputs->'identities') b
    where b->>'entity_type' = 'team' and b->>'observed_entity_id' is not null
  ) then
    raise exception 'team identity bindings have no observed id';
  end if;
  v_bundle_sha := private.prediction_input_bundle_sha256(v_inputs);
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
        v_existing.prediction_protocol_version, v_existing.pipeline_version,
        v_existing.code_revision, v_existing.model_identifiers,
        v_existing.prompt_hashes, v_existing.feature_versions,
        v_existing.derivation_version, v_existing.calibration_version,
        v_existing.settlement_rule, v_existing.research_cutoff_at,
        v_existing.kickoff_at_snapshot, v_existing.generated_at
      ) is not distinct from (
        v.fixture_id, v.round_game_id, v.purpose,
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
    contract_version, idempotency_key, fixture_id, round_game_id, purpose,
    prediction_protocol_version, pipeline_version, code_revision,
    model_identifiers, prompt_hashes, feature_versions, derivation_version,
    calibration_version, settlement_rule, research_cutoff_at,
    kickoff_at_snapshot, generated_at, outcome, abstain_reason, p_1_bp,
    p_x_bp, p_2_bp, reliability, uncertainty, payload_schema_version, payload,
    input_bundle_sha256, output_bundle_sha256
  )
  values (
    'kapiloto-prediction-snapshot-v1', v.idempotency_key, v.fixture_id,
    v.round_game_id, v.purpose, v.prediction_protocol_version,
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

-- ---------------------------------------------------------------------------
-- As-of reads: first_seen_at <= cutoff first, then the latest version
-- ---------------------------------------------------------------------------

create or replace function public.knowledge_document_version_as_of(
  p_document_id uuid,
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
  if p_document_id is null or p_cutoff is null then
    raise exception 'document and cutoff are required';
  end if;
  select dv.id into v_result
  from public.knowledge_document_versions dv
  where dv.document_id = p_document_id
    and dv.first_seen_at <= p_cutoff
  order by dv.version_no desc
  limit 1;
  return v_result;
end;
$$;

-- What Kapiloto believed about each claim at the cutoff. A claim not yet
-- known at the cutoff is omitted; a known claim without a visible resolution
-- is "unresolved". Later resolutions (post-match truth included) are
-- invisible to earlier cutoffs.
create or replace function public.knowledge_claim_resolutions_as_of(
  p_claim_ids uuid[],
  p_cutoff timestamptz
)
returns table (
  claim_id uuid,
  resolution_id uuid,
  resolution_version integer,
  status text,
  confidence numeric,
  resolver_kind text,
  reason_code text,
  quality_flags text[],
  first_seen_at timestamptz
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_claim_ids is null or p_cutoff is null then
    raise exception 'claims and cutoff are required';
  end if;
  return query
  select
    c.id,
    r.id,
    r.resolution_version,
    coalesce(r.status, 'unresolved'),
    r.confidence,
    r.resolver_kind,
    r.reason_code,
    coalesce(r.quality_flags, '{}'::text[]),
    r.first_seen_at
  from public.knowledge_claims c
  left join lateral (
    select kr.*
    from public.knowledge_claim_resolutions kr
    where kr.claim_id = c.id
      and kr.first_seen_at <= p_cutoff
    order by kr.resolution_version desc
    limit 1
  ) r on true
  where c.id = any (p_claim_ids)
    and c.first_seen_at <= p_cutoff
  order by c.id;
end;
$$;

-- Support and contradiction for one claim as of a cutoff. Each document
-- counts once (its latest visible observation per relationship), and
-- documents sharing a syndication cluster or identical content count as one
-- independent source, whichever of them was labeled first.
create or replace function public.knowledge_claim_support_as_of(
  p_claim_id uuid,
  p_cutoff timestamptz
)
returns table (
  relationship text,
  observation_count integer,
  document_count integer,
  independent_source_count integer
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_claim_id is null or p_cutoff is null then
    raise exception 'claim and cutoff are required';
  end if;
  return query
  with visible as (
    select
      o.relationship,
      o.document_id,
      -- Independence as known at the cutoff: the version's cluster, else a
      -- cluster any identical-content version had by then, else the content.
      coalesce(
        dv.syndication_cluster,
        (select min(same.syndication_cluster)
         from public.knowledge_document_versions same
         where same.content_sha256 = dv.content_sha256
           and same.syndication_cluster is not null
           and same.first_seen_at <= p_cutoff),
        'sha256:' || dv.content_sha256
      ) as independence_key,
      dv.version_no,
      o.first_seen_at
    from public.knowledge_claim_observations o
    join public.knowledge_document_versions dv on dv.id = o.document_version_id
    where o.claim_id = p_claim_id
      and o.first_seen_at <= p_cutoff
  ),
  per_document as (
    select distinct on (vi.relationship, vi.document_id)
      vi.relationship, vi.document_id, vi.independence_key
    from visible vi
    order by vi.relationship, vi.document_id, vi.version_no desc, vi.first_seen_at desc
  )
  select
    vi.relationship,
    count(*)::integer,
    count(distinct vi.document_id)::integer,
    (select count(distinct pd.independence_key)::integer
     from per_document pd where pd.relationship = vi.relationship)
  from visible vi
  group by vi.relationship
  order by vi.relationship;
end;
$$;

-- ---------------------------------------------------------------------------
-- Security: server/service_role only
-- ---------------------------------------------------------------------------

alter table public.knowledge_documents enable row level security;
alter table public.knowledge_document_versions enable row level security;
alter table public.knowledge_claims enable row level security;
alter table public.knowledge_claim_observations enable row level security;
alter table public.knowledge_claim_relations enable row level security;
alter table public.knowledge_claim_resolutions enable row level security;
alter table public.knowledge_resolution_evidence enable row level security;
alter table public.prediction_snapshots enable row level security;
alter table public.prediction_ledger_inputs enable row level security;
alter table public.prediction_document_inputs enable row level security;
alter table public.prediction_claim_inputs enable row level security;
alter table public.prediction_claim_observation_inputs enable row level security;
alter table public.prediction_reference_inputs enable row level security;
alter table public.prediction_identity_bindings enable row level security;

revoke all on table public.knowledge_documents from public, anon, authenticated;
revoke all on table public.knowledge_document_versions from public, anon, authenticated;
revoke all on table public.knowledge_claims from public, anon, authenticated;
revoke all on table public.knowledge_claim_observations from public, anon, authenticated;
revoke all on table public.knowledge_claim_relations from public, anon, authenticated;
revoke all on table public.knowledge_claim_resolutions from public, anon, authenticated;
revoke all on table public.knowledge_resolution_evidence from public, anon, authenticated;
revoke all on table public.prediction_snapshots from public, anon, authenticated;
revoke all on table public.prediction_ledger_inputs from public, anon, authenticated;
revoke all on table public.prediction_document_inputs from public, anon, authenticated;
revoke all on table public.prediction_claim_inputs from public, anon, authenticated;
revoke all on table public.prediction_claim_observation_inputs from public, anon, authenticated;
revoke all on table public.prediction_reference_inputs from public, anon, authenticated;
revoke all on table public.prediction_identity_bindings from public, anon, authenticated;

revoke all on function private.kapiloto_v4_assert_keys(jsonb, text[], text) from public, anon, authenticated;
revoke all on function private.stamp_knowledge_document() from public, anon, authenticated;
revoke all on function private.knowledge_document_version_fingerprint(text, text, text, text, text, timestamptz, text, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function private.stamp_knowledge_document_version() from public, anon, authenticated;
revoke all on function private.knowledge_claim_fingerprint(text, text, text, text, uuid, uuid, uuid, uuid, jsonb, text, text, date, date) from public, anon, authenticated;
revoke all on function private.stamp_knowledge_claim() from public, anon, authenticated;
revoke all on function private.stamp_knowledge_claim_observation() from public, anon, authenticated;
revoke all on function private.stamp_knowledge_claim_relation() from public, anon, authenticated;
revoke all on function private.check_knowledge_claim_premises() from public, anon, authenticated;
revoke all on function private.stamp_knowledge_claim_resolution() from public, anon, authenticated;
revoke all on function private.prepare_knowledge_resolution_evidence() from public, anon, authenticated;
revoke all on function private.check_knowledge_resolution_evidence() from public, anon, authenticated;
revoke all on function private.prediction_output_sha256(text, text, smallint, smallint, smallint, numeric, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function private.prediction_canonical_inputs(jsonb) from public, anon, authenticated;
revoke all on function private.prediction_input_bundle_sha256(jsonb) from public, anon, authenticated;
revoke all on function private.stamp_prediction_snapshot() from public, anon, authenticated;
revoke all on function private.prepare_prediction_input() from public, anon, authenticated;
revoke all on function private.check_prediction_input_bundle() from public, anon, authenticated;

revoke all on function public.knowledge_record_document_version(jsonb) from public, anon, authenticated;
revoke all on function public.knowledge_record_claim(jsonb) from public, anon, authenticated;
revoke all on function public.knowledge_record_claim_resolution(jsonb) from public, anon, authenticated;
revoke all on function public.prediction_record_snapshot(jsonb) from public, anon, authenticated;
revoke all on function public.knowledge_document_version_as_of(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.knowledge_claim_resolutions_as_of(uuid[], timestamptz) from public, anon, authenticated;
revoke all on function public.knowledge_claim_support_as_of(uuid, timestamptz) from public, anon, authenticated;

-- Triggers and RPCs run as the invoking service_role and call these helpers
-- by name.
grant execute on function private.kapiloto_v4_assert_keys(jsonb, text[], text) to service_role;
grant execute on function private.knowledge_document_version_fingerprint(text, text, text, text, text, timestamptz, text, boolean, boolean, boolean) to service_role;
grant execute on function private.knowledge_claim_fingerprint(text, text, text, text, uuid, uuid, uuid, uuid, jsonb, text, text, date, date) to service_role;
grant execute on function private.prediction_output_sha256(text, text, smallint, smallint, smallint, numeric, jsonb, text, jsonb) to service_role;
grant execute on function private.prediction_canonical_inputs(jsonb) to service_role;
grant execute on function private.prediction_input_bundle_sha256(jsonb) to service_role;

grant execute on function public.knowledge_record_document_version(jsonb) to service_role;
grant execute on function public.knowledge_record_claim(jsonb) to service_role;
grant execute on function public.knowledge_record_claim_resolution(jsonb) to service_role;
grant execute on function public.prediction_record_snapshot(jsonb) to service_role;
grant execute on function public.knowledge_document_version_as_of(uuid, timestamptz) to service_role;
grant execute on function public.knowledge_claim_resolutions_as_of(uuid[], timestamptz) to service_role;
grant execute on function public.knowledge_claim_support_as_of(uuid, timestamptz) to service_role;

comment on table public.knowledge_documents is
  'Identity of source material Kapiloto observed (V4). Immutable; content lives in versions.';
comment on table public.knowledge_document_versions is
  'Immutable observations of a document: content hash, bounded text, rights provenance and database-stamped first_seen_at. Raw media live in external storage.';
comment on table public.knowledge_claims is
  'Canonical structured propositions, deduplicated by a fingerprint of every structured dimension; prose is a label, never identity.';
comment on table public.knowledge_claim_observations is
  'What one document version appears to say about a claim (supports/contradicts/mentions), with rights-gated quotes and a syndication-aware independence key.';
comment on table public.knowledge_claim_relations is
  'Typed claim-to-claim provenance; derived_from, supersedes and refines are acyclic.';
comment on table public.knowledge_claim_resolutions is
  'Append-only adjudications of a claim on the lattice unresolved/verified/verified_degraded/quarantined/contradicted/fabricated.';
comment on table public.knowledge_resolution_evidence is
  'Typed citations of the rows a resolution used (claim observations, document versions, Match Ledger rows).';
comment on table public.prediction_snapshots is
  'Immutable scientific record of one prediction: versions, hashes, cutoff, outputs. Never updated by later truth, merges or model changes.';
comment on table public.prediction_identity_bindings is
  'Canonical ids a prediction used, frozen at recording time; later merges do not change them.';
comment on column public.knowledge_document_versions.first_seen_at is
  'Information time: clock_timestamp() when the version was written. The only column as-of reconstruction may filter on.';
comment on column public.knowledge_claim_resolutions.first_seen_at is
  'Information time of this adjudication. As-of reads never see resolutions first seen after the cutoff.';
comment on column public.prediction_snapshots.first_seen_at is
  'When Kapiloto recorded the prediction (database clock); research_cutoff_at <= first_seen_at.';
