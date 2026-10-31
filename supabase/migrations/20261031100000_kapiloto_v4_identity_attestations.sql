-- Kapiloto V4 Stage 1 M2A: provider identity attestations, V2 provider
-- ingest, attestation-aware historical reads and reports (D-058).
--
-- Additive. The applied migrations (1A, 1B, 1C, 1D, 1E-A1, 1E-A2-A and the
-- D-057 guard) are not modified, and no V1 function is redefined: the V1
-- ingest, team-match-stat reads, exclusions report and provider-ref report
-- stay present for contract and history inspection. Where their trust
-- semantics would now mislead, service_role loses EXECUTE on them.
--
-- Trust rule (Stage 1, Sportmonks first): a team or competition identity is
-- trusted for historical ingest only when the current V3 mapping is
-- manual_override AND agrees with the active V4 attestation. Neither alone is
-- sufficient, and mapping confidence is never consulted. D-057 makes
-- manual_override stable against automated V3 writes; V3 inserts are always
-- confirmed, so a V3-created row can never satisfy the rule by itself.
--
-- This migration does NOT enable provider ingest. Supabase default
-- privileges grant every new public function to service_role, so V2 ingest is
-- revoked explicitly from public, anon, authenticated AND service_role. Only
-- the separate grant-only M2B migration may give it back to service_role.
--
-- The guards below stop accidental writes by application code. They do not
-- make it impossible for a deliberately malicious service_role (which bypasses
-- RLS and can call any helper it is granted) to manufacture rows; the Stage 1
-- guarantee is the typed foreign keys, integrity triggers, guarded inserts and
-- the V2 read semantics.

-- ---------------------------------------------------------------------------
-- Evidence contract (kapiloto-provider-identity-attestation-evidence-v1).
-- Audit data only: validated for shape and size, never interpreted as policy,
-- and never an authorization input.
-- ---------------------------------------------------------------------------

create or replace function private.provider_identity_evidence_issue(p_evidence jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    return 'evidence must be a JSON object';
  end if;
  if octet_length(p_evidence::text) > 65536 then
    return 'evidence exceeds 64 KiB';
  end if;
  if p_evidence->>'contract_version' is distinct from 'kapiloto-provider-identity-attestation-evidence-v1' then
    return 'evidence contract_version must be kapiloto-provider-identity-attestation-evidence-v1';
  end if;
  if jsonb_typeof(p_evidence->'sources') is distinct from 'array' or jsonb_array_length(p_evidence->'sources') = 0 then
    return 'evidence sources must be a non-empty array';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_evidence->'sources') s
    where not (jsonb_typeof(s) = 'object' or (jsonb_typeof(s) = 'string' and btrim(s #>> '{}') <> ''))
  ) then
    return 'evidence sources must be non-empty strings or objects';
  end if;
  if jsonb_typeof(p_evidence->'reviewed_by') is distinct from 'string'
    or char_length(btrim(p_evidence->>'reviewed_by')) not between 1 and 200 then
    return 'evidence reviewed_by must be a non-empty string of at most 200 characters';
  end if;
  if jsonb_typeof(p_evidence->'duplicate_audit_sha256') is distinct from 'string'
    or p_evidence->>'duplicate_audit_sha256' !~ '^[0-9a-f]{64}$' then
    return 'evidence duplicate_audit_sha256 must be 64 lowercase hex characters';
  end if;
  return null;
end;
$$;

-- SHA-256 of the evidence in jsonb's normalized text form (key order and
-- whitespace do not change it).
create or replace function private.provider_identity_evidence_sha256(p_evidence jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_evidence::text, 'UTF8')), 'hex')
$$;

-- ---------------------------------------------------------------------------
-- Provider identity lock: kapiloto_v4_provider_identity:<provider>.
-- Attest/revoke take it exclusive; V2 ingest takes it shared.
-- ---------------------------------------------------------------------------

create or replace function private.lock_provider_identity(p_provider text, p_exclusive boolean)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform private.kapiloto_require_read_committed('provider identity locks');
  if p_exclusive then
    perform pg_advisory_xact_lock(hashtextextended('kapiloto_v4_provider_identity:' || p_provider, 0));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('kapiloto_v4_provider_identity:' || p_provider, 0));
  end if;
end;
$$;

-- Whether THIS backend holds the provider identity lock in the given mode.
create or replace function private.holds_provider_identity_lock(p_provider text, p_exclusive boolean)
returns boolean
language sql
volatile
set search_path = ''
as $$
  select exists (
    select 1
    from pg_catalog.pg_locks l
    where l.locktype = 'advisory'
      and l.pid = pg_catalog.pg_backend_pid()
      and l.granted
      and l.objsubid = 1
      and ((l.classid::bigint << 32) | l.objid::bigint)
          = pg_catalog.hashtextextended('kapiloto_v4_provider_identity:' || p_provider, 0)
      and l.mode = case when p_exclusive then 'ExclusiveLock' else 'ShareLock' end
  )
$$;

-- Projection DML and event INSERT need the RPC's transaction-local flag AND
-- the exclusive provider identity lock held by this backend.
create or replace function private.assert_provider_identity_attestation_write(p_provider text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if coalesce(current_setting('kapiloto.identity_attestation_rpc', true), '') <> 'on'
    or not private.holds_provider_identity_lock(p_provider, true) then
    raise exception 'provider identity attestations change only through the attest/revoke RPCs (internal flag and exclusive provider identity lock required)';
  end if;
end;
$$;

-- Stage 1 attest/revoke requests: Sportmonks only, exact provider refs.
create or replace function private.provider_identity_assert_request(p_provider text, p_provider_ref text, p_label text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_provider is distinct from 'sportmonks' then
    raise exception 'Stage 1 provider identity attestations are enabled for sportmonks only';
  end if;
  if p_provider_ref is null or p_provider_ref <> btrim(p_provider_ref) or char_length(p_provider_ref) not between 1 and 80 then
    raise exception 'invalid provider % id', p_label;
  end if;
end;
$$;

-- Transaction entry rule: attest/revoke must be the first write-capable
-- operation of their transaction (no transaction id assigned yet, so no row
-- lock or write is held), which rules out the mapping UPDATE -> attest
-- deadlock against an in-flight ingest and means one identity change per
-- transaction. Then the exclusive provider identity lock.
create or replace function private.provider_identity_begin_change(p_provider text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform private.kapiloto_require_read_committed('provider identity attestation');
  if pg_catalog.pg_current_xact_id_if_assigned() is not null then
    raise exception 'a provider identity attest/revoke must be the first write of its transaction: one identity per transaction, and mapping corrections in a separate transaction';
  end if;
  perform private.lock_provider_identity(p_provider, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Immutable attestation events (generations) and current projections.
-- ---------------------------------------------------------------------------

create table private.provider_team_identity_attestation_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_team_id text not null
    check (provider_team_id = btrim(provider_team_id) and char_length(provider_team_id) between 1 and 80),
  -- No foreign key: the audit history survives later canonical cleanup.
  team_id uuid not null,
  attestation_generation_id uuid not null,
  attestation_version integer not null check (attestation_version >= 1),
  event_kind text not null check (event_kind in ('attest', 'evidence_refresh', 'revoke')),
  attestation_basis text not null
    check (attestation_basis in ('operator_manual', 'cross_provider_verified', 'provider_official_reference', 'fixture_identity_crosscheck', 'multi_source_verified')),
  evidence jsonb not null check (private.provider_identity_evidence_issue(evidence) is null),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  mapping_status_snapshot text,
  mapping_confidence_snapshot numeric(5,4),
  provider_name_snapshot text,
  recorded_at timestamptz not null,
  actor_current_user text not null,
  attested_by text not null check (char_length(btrim(attested_by)) between 1 and 200),
  revoke_reason text check (revoke_reason is null or char_length(btrim(revoke_reason)) between 1 and 500),
  unique (provider, provider_team_id, attestation_version),
  check ((event_kind = 'revoke') = (revoke_reason is not null))
);

create unique index provider_team_identity_attestation_events_attest_uq
  on private.provider_team_identity_attestation_events (attestation_generation_id) where event_kind = 'attest';
create unique index provider_team_identity_attestation_events_revoke_uq
  on private.provider_team_identity_attestation_events (attestation_generation_id) where event_kind = 'revoke';
create index provider_team_identity_attestation_events_generation_idx
  on private.provider_team_identity_attestation_events (attestation_generation_id);

create table private.provider_competition_identity_attestation_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_competition_id text not null
    check (provider_competition_id = btrim(provider_competition_id) and char_length(provider_competition_id) between 1 and 80),
  competition_id uuid not null,
  attestation_generation_id uuid not null,
  attestation_version integer not null check (attestation_version >= 1),
  event_kind text not null check (event_kind in ('attest', 'evidence_refresh', 'revoke')),
  attestation_basis text not null
    check (attestation_basis in ('operator_manual', 'cross_provider_verified', 'provider_official_reference', 'fixture_identity_crosscheck', 'multi_source_verified')),
  evidence jsonb not null check (private.provider_identity_evidence_issue(evidence) is null),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  mapping_status_snapshot text,
  provider_name_snapshot text,
  recorded_at timestamptz not null,
  actor_current_user text not null,
  attested_by text not null check (char_length(btrim(attested_by)) between 1 and 200),
  revoke_reason text check (revoke_reason is null or char_length(btrim(revoke_reason)) between 1 and 500),
  unique (provider, provider_competition_id, attestation_version),
  check ((event_kind = 'revoke') = (revoke_reason is not null))
);

create unique index provider_competition_identity_attestation_events_attest_uq
  on private.provider_competition_identity_attestation_events (attestation_generation_id) where event_kind = 'attest';
create unique index provider_competition_identity_attestation_events_revoke_uq
  on private.provider_competition_identity_attestation_events (attestation_generation_id) where event_kind = 'revoke';
create index provider_competition_identity_attestation_events_generation_idx
  on private.provider_competition_identity_attestation_events (attestation_generation_id);

-- Current projections: one active attestation per provider ref and per
-- canonical entity (both directions). A canonical row cannot be deleted while
-- it is actively attested (ON DELETE NO ACTION).
create table private.provider_team_identity_attestations (
  provider text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_team_id text not null
    check (provider_team_id = btrim(provider_team_id) and char_length(provider_team_id) between 1 and 80),
  team_id uuid not null references public.teams(id) on delete no action,
  attestation_generation_id uuid not null unique,
  attestation_version integer not null check (attestation_version >= 1),
  latest_event_id uuid not null unique
    references private.provider_team_identity_attestation_events(id) on delete no action,
  attestation_basis text not null
    check (attestation_basis in ('operator_manual', 'cross_provider_verified', 'provider_official_reference', 'fixture_identity_crosscheck', 'multi_source_verified')),
  evidence jsonb not null check (private.provider_identity_evidence_issue(evidence) is null),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  first_attested_at timestamptz not null,
  attested_at timestamptz not null,
  attested_by text not null check (char_length(btrim(attested_by)) between 1 and 200),
  primary key (provider, provider_team_id),
  unique (provider, team_id),
  check (attested_at >= first_attested_at)
);

create table private.provider_competition_identity_attestations (
  provider text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_competition_id text not null
    check (provider_competition_id = btrim(provider_competition_id) and char_length(provider_competition_id) between 1 and 80),
  competition_id uuid not null references public.competitions(id) on delete no action,
  attestation_generation_id uuid not null unique,
  attestation_version integer not null check (attestation_version >= 1),
  latest_event_id uuid not null unique
    references private.provider_competition_identity_attestation_events(id) on delete no action,
  attestation_basis text not null
    check (attestation_basis in ('operator_manual', 'cross_provider_verified', 'provider_official_reference', 'fixture_identity_crosscheck', 'multi_source_verified')),
  evidence jsonb not null check (private.provider_identity_evidence_issue(evidence) is null),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  first_attested_at timestamptz not null,
  attested_at timestamptz not null,
  attested_by text not null check (char_length(btrim(attested_by)) between 1 and 200),
  primary key (provider, provider_competition_id),
  -- Fail closed: several provider league ids for one canonical competition
  -- need an explicit later design, not a weaker constraint.
  unique (provider, competition_id),
  check (attested_at >= first_attested_at)
);

-- Event INSERT: guarded, database-stamped, and consistent with the generation
-- rules (attest opens a new generation only when none is open; refresh and
-- revoke continue the open generation; the version is monotonic per provider
-- ref across revoke/re-attest cycles).
create or replace function private.stamp_provider_team_identity_attestation_event()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_last private.provider_team_identity_attestation_events%rowtype;
begin
  perform private.assert_provider_identity_attestation_write(new.provider);
  new.recorded_at := private.kapiloto_information_clock();
  new.actor_current_user := current_user;
  select e.* into v_last
  from private.provider_team_identity_attestation_events e
  where e.provider = new.provider and e.provider_team_id = new.provider_team_id
  order by e.attestation_version desc
  limit 1;
  if new.attestation_version <> coalesce(v_last.attestation_version, 0) + 1 then
    raise exception 'attestation versions of provider team % are monotonic', new.provider_team_id;
  end if;
  if new.event_kind = 'attest' then
    if v_last.id is not null and v_last.event_kind <> 'revoke' then
      raise exception 'provider team % already has an open attestation generation; revoke it first', new.provider_team_id;
    end if;
    if exists (select 1 from private.provider_team_identity_attestation_events e
               where e.attestation_generation_id = new.attestation_generation_id) then
      raise exception 'an attest event opens a new attestation generation';
    end if;
  elsif v_last.id is null or v_last.event_kind = 'revoke'
    or v_last.attestation_generation_id <> new.attestation_generation_id or v_last.team_id <> new.team_id then
    raise exception '% of provider team % must continue its open attestation generation', new.event_kind, new.provider_team_id;
  end if;
  return new;
end;
$$;

create or replace function private.stamp_provider_competition_identity_attestation_event()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_last private.provider_competition_identity_attestation_events%rowtype;
begin
  perform private.assert_provider_identity_attestation_write(new.provider);
  new.recorded_at := private.kapiloto_information_clock();
  new.actor_current_user := current_user;
  select e.* into v_last
  from private.provider_competition_identity_attestation_events e
  where e.provider = new.provider and e.provider_competition_id = new.provider_competition_id
  order by e.attestation_version desc
  limit 1;
  if new.attestation_version <> coalesce(v_last.attestation_version, 0) + 1 then
    raise exception 'attestation versions of provider competition % are monotonic', new.provider_competition_id;
  end if;
  if new.event_kind = 'attest' then
    if v_last.id is not null and v_last.event_kind <> 'revoke' then
      raise exception 'provider competition % already has an open attestation generation; revoke it first', new.provider_competition_id;
    end if;
    if exists (select 1 from private.provider_competition_identity_attestation_events e
               where e.attestation_generation_id = new.attestation_generation_id) then
      raise exception 'an attest event opens a new attestation generation';
    end if;
  elsif v_last.id is null or v_last.event_kind = 'revoke'
    or v_last.attestation_generation_id <> new.attestation_generation_id or v_last.competition_id <> new.competition_id then
    raise exception '% of provider competition % must continue its open attestation generation', new.event_kind, new.provider_competition_id;
  end if;
  return new;
end;
$$;

-- Projection DML: guarded; the projection always equals its latest
-- non-revoke event; provider ref, canonical id and generation never change in
-- place; a row disappears only after its generation's revoke event.
create or replace function private.guard_provider_team_identity_attestation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.assert_provider_identity_attestation_write(case when tg_op = 'DELETE' then old.provider else new.provider end);
  if tg_op = 'DELETE' then
    if not exists (select 1 from private.provider_team_identity_attestation_events e
                   where e.attestation_generation_id = old.attestation_generation_id and e.event_kind = 'revoke') then
      raise exception 'an active team attestation is removed only by a revoke event';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.provider, new.provider_team_id, new.team_id, new.attestation_generation_id, new.first_attested_at)
      is distinct from (old.provider, old.provider_team_id, old.team_id, old.attestation_generation_id, old.first_attested_at) then
    raise exception 'an attestation keeps its provider ref, canonical team and generation; revoke and re-attest instead';
  end if;
  -- A revoked generation is closed for good: it is never reactivated, not
  -- even by re-inserting its old attest event as the current projection.
  if exists (
    select 1 from private.provider_team_identity_attestation_events e
    where e.attestation_generation_id = new.attestation_generation_id and e.event_kind = 'revoke'
  ) then
    raise exception 'attestation generation % of provider team % is revoked and cannot be reactivated', new.attestation_generation_id, new.provider_team_id;
  end if;
  if not exists (
    select 1 from private.provider_team_identity_attestation_events e
    where e.id = new.latest_event_id and e.event_kind <> 'revoke'
      and e.provider = new.provider and e.provider_team_id = new.provider_team_id and e.team_id = new.team_id
      and e.attestation_generation_id = new.attestation_generation_id and e.attestation_version = new.attestation_version
      and e.attestation_basis = new.attestation_basis and e.evidence_sha256 = new.evidence_sha256
  ) then
    raise exception 'a team attestation projection must equal its latest event';
  end if;
  return new;
end;
$$;

create or replace function private.guard_provider_competition_identity_attestation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.assert_provider_identity_attestation_write(case when tg_op = 'DELETE' then old.provider else new.provider end);
  if tg_op = 'DELETE' then
    if not exists (select 1 from private.provider_competition_identity_attestation_events e
                   where e.attestation_generation_id = old.attestation_generation_id and e.event_kind = 'revoke') then
      raise exception 'an active competition attestation is removed only by a revoke event';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.provider, new.provider_competition_id, new.competition_id, new.attestation_generation_id, new.first_attested_at)
      is distinct from (old.provider, old.provider_competition_id, old.competition_id, old.attestation_generation_id, old.first_attested_at) then
    raise exception 'an attestation keeps its provider ref, canonical competition and generation; revoke and re-attest instead';
  end if;
  if exists (
    select 1 from private.provider_competition_identity_attestation_events e
    where e.attestation_generation_id = new.attestation_generation_id and e.event_kind = 'revoke'
  ) then
    raise exception 'attestation generation % of provider competition % is revoked and cannot be reactivated', new.attestation_generation_id, new.provider_competition_id;
  end if;
  if not exists (
    select 1 from private.provider_competition_identity_attestation_events e
    where e.id = new.latest_event_id and e.event_kind <> 'revoke'
      and e.provider = new.provider and e.provider_competition_id = new.provider_competition_id
      and e.competition_id = new.competition_id
      and e.attestation_generation_id = new.attestation_generation_id and e.attestation_version = new.attestation_version
      and e.attestation_basis = new.attestation_basis and e.evidence_sha256 = new.evidence_sha256
  ) then
    raise exception 'a competition attestation projection must equal its latest event';
  end if;
  return new;
end;
$$;

create trigger provider_team_identity_attestation_events_stamp
before insert on private.provider_team_identity_attestation_events
for each row execute function private.stamp_provider_team_identity_attestation_event();
create trigger provider_team_identity_attestation_events_immutable
before update or delete on private.provider_team_identity_attestation_events
for each row execute function private.kapiloto_v4_reject_change();
create trigger provider_team_identity_attestation_events_no_truncate
before truncate on private.provider_team_identity_attestation_events
for each statement execute function private.kapiloto_v4_reject_change();

create trigger provider_competition_identity_attestation_events_stamp
before insert on private.provider_competition_identity_attestation_events
for each row execute function private.stamp_provider_competition_identity_attestation_event();
create trigger provider_competition_identity_attestation_events_immutable
before update or delete on private.provider_competition_identity_attestation_events
for each row execute function private.kapiloto_v4_reject_change();
create trigger provider_competition_identity_attestation_events_no_truncate
before truncate on private.provider_competition_identity_attestation_events
for each statement execute function private.kapiloto_v4_reject_change();

create trigger provider_team_identity_attestations_guard
before insert or update or delete on private.provider_team_identity_attestations
for each row execute function private.guard_provider_team_identity_attestation();
create trigger provider_team_identity_attestations_no_truncate
before truncate on private.provider_team_identity_attestations
for each statement execute function private.kapiloto_v4_reject_change();

create trigger provider_competition_identity_attestations_guard
before insert or update or delete on private.provider_competition_identity_attestations
for each row execute function private.guard_provider_competition_identity_attestation();
create trigger provider_competition_identity_attestations_no_truncate
before truncate on private.provider_competition_identity_attestations
for each statement execute function private.kapiloto_v4_reject_change();

-- ---------------------------------------------------------------------------
-- Observation attestation provenance: which attestation event/generation each
-- V2-ingested observation version was written under, per identity ref.
-- Typed foreign keys to the immutable event tables; sealed to the writing
-- statement; inserted only by V2 ingest; immutable.
-- ---------------------------------------------------------------------------

create table public.match_ledger_observation_identity_attestations (
  observation_id uuid not null references public.match_ledger_observations(id) on delete restrict,
  ref_kind text not null check (ref_kind in ('league', 'team_home', 'team_away')),
  team_attestation_event_id uuid
    references private.provider_team_identity_attestation_events(id) on delete restrict,
  competition_attestation_event_id uuid
    references private.provider_competition_identity_attestation_events(id) on delete restrict,
  attestation_generation_id uuid not null,
  provider_ref text not null check (char_length(btrim(provider_ref)) between 1 and 80),
  canonical_id uuid not null,
  primary key (observation_id, ref_kind),
  check ((ref_kind = 'league') = (competition_attestation_event_id is not null)),
  check ((ref_kind = 'league') = (team_attestation_event_id is null))
);

create index match_ledger_observation_identity_attestations_generation_idx
  on public.match_ledger_observation_identity_attestations (attestation_generation_id);

create or replace function private.check_match_ledger_observation_identity_attestation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_provider text;
  v_ref record;
begin
  select o.provider into v_provider from public.match_ledger_observations o where o.id = new.observation_id;
  if not found then
    raise exception 'match ledger observation % not found', new.observation_id;
  end if;
  if coalesce(current_setting('kapiloto.provider_ingest_v2', true), '') <> 'on'
    or not private.holds_provider_identity_lock(v_provider, false) then
    raise exception 'observation identity attestations are written only by the V2 provider ingest (internal flag and shared provider identity lock required)';
  end if;
  select pr.provider_ref, pr.canonical_id into v_ref
  from public.match_ledger_observation_provider_refs pr
  where pr.observation_id = new.observation_id and pr.ref_kind = new.ref_kind;
  if not found or v_ref.provider_ref <> new.provider_ref or v_ref.canonical_id is distinct from new.canonical_id then
    raise exception 'identity attestation % of observation % does not match its sealed provider ref', new.ref_kind, new.observation_id;
  end if;
  if new.ref_kind = 'league' then
    if new.competition_attestation_event_id is null or new.team_attestation_event_id is not null then
      raise exception 'a league identity attestation names a competition attestation event';
    end if;
    if not exists (
      select 1
      from private.provider_competition_identity_attestation_events e
      join private.provider_competition_identity_attestations a on a.latest_event_id = e.id
      where e.id = new.competition_attestation_event_id
        and e.provider = v_provider and e.provider_competition_id = new.provider_ref
        and e.competition_id = new.canonical_id and e.attestation_generation_id = new.attestation_generation_id
        and a.provider = v_provider and a.provider_competition_id = new.provider_ref
        and a.competition_id = new.canonical_id and a.attestation_generation_id = new.attestation_generation_id
    ) then
      raise exception 'league identity attestation of observation % does not name the current competition attestation event', new.observation_id;
    end if;
  else
    if new.team_attestation_event_id is null or new.competition_attestation_event_id is not null then
      raise exception 'a team identity attestation names a team attestation event';
    end if;
    if not exists (
      select 1
      from private.provider_team_identity_attestation_events e
      join private.provider_team_identity_attestations a on a.latest_event_id = e.id
      where e.id = new.team_attestation_event_id
        and e.provider = v_provider and e.provider_team_id = new.provider_ref
        and e.team_id = new.canonical_id and e.attestation_generation_id = new.attestation_generation_id
        and a.provider = v_provider and a.provider_team_id = new.provider_ref
        and a.team_id = new.canonical_id and a.attestation_generation_id = new.attestation_generation_id
    ) then
      raise exception '% identity attestation of observation % does not name the current team attestation event', new.ref_kind, new.observation_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger match_ledger_observation_identity_attestations_identity
before insert on public.match_ledger_observation_identity_attestations
for each row execute function private.check_match_ledger_observation_identity_attestation();
create trigger match_ledger_observation_identity_attestations_seal
before insert on public.match_ledger_observation_identity_attestations
for each row execute function private.seal_match_ledger_observation_annotation();
create trigger match_ledger_observation_identity_attestations_immutable
before update or delete on public.match_ledger_observation_identity_attestations
for each row execute function private.kapiloto_v4_reject_change();
create trigger match_ledger_observation_identity_attestations_no_truncate
before truncate on public.match_ledger_observation_identity_attestations
for each statement execute function private.kapiloto_v4_reject_change();

-- ---------------------------------------------------------------------------
-- Stage 1 trust helpers. Trusted only when ALL hold: the mapping exists, is
-- manual_override, an active attestation exists, mapping and attestation name
-- the requested canonical id, and (when given) the attestation is still the
-- expected generation. private.provider_mapping_trusted (V1) is unchanged and
-- is not used by V2; player bootstrap does not call these helpers.
-- ---------------------------------------------------------------------------

create or replace function private.provider_team_attestation_matches(
  p_provider text,
  p_provider_team_id text,
  p_team_id uuid,
  p_generation uuid default null
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select m.mapping_status = 'manual_override' and m.team_id = p_team_id and a.team_id = p_team_id
      and (p_generation is null or a.attestation_generation_id = p_generation)
    from public.provider_team_mappings m
    join private.provider_team_identity_attestations a
      on a.provider = m.provider and a.provider_team_id = m.provider_team_id
    where m.provider = p_provider and m.provider_team_id = p_provider_team_id
  ), false)
$$;

create or replace function private.provider_competition_attestation_matches(
  p_provider text,
  p_provider_competition_id text,
  p_competition_id uuid,
  p_generation uuid default null
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select m.mapping_status = 'manual_override' and m.competition_id = p_competition_id and a.competition_id = p_competition_id
      and (p_generation is null or a.attestation_generation_id = p_generation)
    from public.provider_competition_mappings m
    join private.provider_competition_identity_attestations a
      on a.provider = m.provider and a.provider_competition_id = m.provider_competition_id
    where m.provider = p_provider and m.provider_competition_id = p_provider_competition_id
  ), false)
$$;

-- Why an observation version is NOT trusted for V2 model-facing reads, or
-- null when it is. Every provider is treated the same: an observation needs
-- sealed league/home/away provider refs and attestation sidecars whose typed
-- event belongs to the sealed generation, that generation must still be the
-- current projection (not revoked, not replaced), and the current mapping
-- must be manual_override and agree. Worst issue wins:
--   attestation_missing > generation_revoked > attestation_generation_stale
--   > mapping_missing > mapping_not_manual_override > mapping_disagrees.
-- generation_revoked: the sealed generation was revoked and no attestation is
-- active now. attestation_generation_stale: it was revoked and a different
-- generation is active now (re-attested; recovery/re-ingest needed).
-- mapping_missing: the V3 mapping row no longer exists.
create or replace function private.match_ledger_observation_attestation_issue(p_observation_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_provider text;
  v_kind text;
  v_ref record;
  v_event_ok boolean;
  v_revoked boolean;
  v_projection_generation uuid;
  v_projection_canonical uuid;
  v_mapping_status text;
  v_mapping_canonical uuid;
  v_issue text;
  v_rank integer;
  v_worst integer := 0;
  v_result text;
begin
  select o.provider into v_provider
  from public.match_ledger_observations o
  where o.id = p_observation_id and o.observation_kind = 'observation';
  if not found then
    return 'attestation_missing';
  end if;
  foreach v_kind in array array['league', 'team_home', 'team_away'] loop
    v_issue := null;
    select pr.provider_ref, pr.canonical_id,
           sa.attestation_generation_id, sa.team_attestation_event_id, sa.competition_attestation_event_id,
           sa.provider_ref as sidecar_ref, sa.canonical_id as sidecar_canonical
      into v_ref
    from public.match_ledger_observation_provider_refs pr
    left join public.match_ledger_observation_identity_attestations sa
      on sa.observation_id = pr.observation_id and sa.ref_kind = pr.ref_kind
    where pr.observation_id = p_observation_id and pr.ref_kind = v_kind;
    if not found or v_ref.attestation_generation_id is null
      or v_ref.sidecar_ref is distinct from v_ref.provider_ref
      or v_ref.sidecar_canonical is distinct from v_ref.canonical_id then
      v_issue := 'attestation_missing';
    elsif v_kind = 'league' then
      v_event_ok := exists (
        select 1 from private.provider_competition_identity_attestation_events e
        where e.id = v_ref.competition_attestation_event_id and e.event_kind <> 'revoke'
          and e.provider = v_provider and e.provider_competition_id = v_ref.provider_ref
          and e.competition_id = v_ref.canonical_id and e.attestation_generation_id = v_ref.attestation_generation_id);
      v_revoked := exists (
        select 1 from private.provider_competition_identity_attestation_events e
        where e.attestation_generation_id = v_ref.attestation_generation_id and e.event_kind = 'revoke');
      select a.attestation_generation_id, a.competition_id into v_projection_generation, v_projection_canonical
      from private.provider_competition_identity_attestations a
      where a.provider = v_provider and a.provider_competition_id = v_ref.provider_ref;
      select m.mapping_status, m.competition_id into v_mapping_status, v_mapping_canonical
      from public.provider_competition_mappings m
      where m.provider = v_provider and m.provider_competition_id = v_ref.provider_ref;
    else
      v_event_ok := exists (
        select 1 from private.provider_team_identity_attestation_events e
        where e.id = v_ref.team_attestation_event_id and e.event_kind <> 'revoke'
          and e.provider = v_provider and e.provider_team_id = v_ref.provider_ref
          and e.team_id = v_ref.canonical_id and e.attestation_generation_id = v_ref.attestation_generation_id);
      v_revoked := exists (
        select 1 from private.provider_team_identity_attestation_events e
        where e.attestation_generation_id = v_ref.attestation_generation_id and e.event_kind = 'revoke');
      select a.attestation_generation_id, a.team_id into v_projection_generation, v_projection_canonical
      from private.provider_team_identity_attestations a
      where a.provider = v_provider and a.provider_team_id = v_ref.provider_ref;
      select m.mapping_status, m.team_id into v_mapping_status, v_mapping_canonical
      from public.provider_team_mappings m
      where m.provider = v_provider and m.provider_team_id = v_ref.provider_ref;
    end if;
    if v_issue is null then
      v_issue := case
        when not v_event_ok then 'attestation_missing'
        when v_projection_generation is null then 'generation_revoked'
        when v_revoked or v_projection_generation <> v_ref.attestation_generation_id
          or v_projection_canonical <> v_ref.canonical_id then 'attestation_generation_stale'
        when v_mapping_status is null then 'mapping_missing'
        when v_mapping_status <> 'manual_override' then 'mapping_not_manual_override'
        when v_mapping_canonical <> v_ref.canonical_id then 'mapping_disagrees'
      end;
    end if;
    v_rank := case v_issue
      when 'attestation_missing' then 6
      when 'generation_revoked' then 5
      when 'attestation_generation_stale' then 4
      when 'mapping_missing' then 3
      when 'mapping_not_manual_override' then 2
      when 'mapping_disagrees' then 1
      else 0
    end;
    if v_rank > v_worst then
      v_worst := v_rank;
      v_result := v_issue;
    end if;
  end loop;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Attest / revoke RPCs (service_role; SECURITY INVOKER; Sportmonks only).
-- Function-level lock_timeout: it cannot leak into the caller's transaction.
-- ---------------------------------------------------------------------------

create or replace function public.provider_identity_attest_team(p_attestation jsonb)
returns jsonb
language plpgsql
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v record;
  v_issue text;
  v_mapping public.provider_team_mappings%rowtype;
  v_current private.provider_team_identity_attestations%rowtype;
  v_other text;
  v_hash text;
  v_kind text;
  v_version integer;
  v_generation uuid;
  v_event_id uuid;
  v_recorded timestamptz;
begin
  if p_attestation is null or jsonb_typeof(p_attestation) <> 'object' then
    raise exception 'a team attestation must be a JSON object';
  end if;
  perform private.kapiloto_v4_assert_keys(p_attestation,
    array['provider', 'provider_team_id', 'team_id', 'attestation_basis', 'evidence', 'attested_by'], 'team attestation');
  select * into v from jsonb_to_record(p_attestation) as x(
    provider text, provider_team_id text, team_id uuid, attestation_basis text, attested_by text);
  if v.team_id is null or v.attestation_basis is null or v.attested_by is null or p_attestation->'evidence' is null then
    raise exception 'a team attestation needs provider, provider_team_id, team_id, attestation_basis, evidence and attested_by';
  end if;
  perform private.provider_identity_assert_request(v.provider, v.provider_team_id, 'team');
  if v.attestation_basis not in ('operator_manual', 'cross_provider_verified', 'provider_official_reference', 'fixture_identity_crosscheck', 'multi_source_verified') then
    raise exception 'unknown attestation basis %', v.attestation_basis;
  end if;
  if char_length(btrim(v.attested_by)) not between 1 and 200 then
    raise exception 'attested_by must be a non-empty audit label of at most 200 characters';
  end if;
  v_issue := private.provider_identity_evidence_issue(p_attestation->'evidence');
  if v_issue is not null then
    raise exception 'invalid attestation evidence: %', v_issue;
  end if;

  perform private.provider_identity_begin_change(v.provider);

  select m.* into v_mapping
  from public.provider_team_mappings m
  where m.provider = v.provider and m.provider_team_id = v.provider_team_id
  for share;
  if not found then
    raise exception 'no % mapping exists for provider team %', v.provider, v.provider_team_id;
  end if;
  if v_mapping.mapping_status <> 'manual_override' then
    raise exception 'provider team % is mapped as %, not manual_override', v.provider_team_id, v_mapping.mapping_status;
  end if;
  if v_mapping.team_id <> v.team_id then
    raise exception 'provider team % is mapped to canonical team %, not %', v.provider_team_id, v_mapping.team_id, v.team_id;
  end if;

  select a.* into v_current
  from private.provider_team_identity_attestations a
  where a.provider = v.provider and a.provider_team_id = v.provider_team_id
  for update;
  if v_current.provider is not null and v_current.team_id <> v.team_id then
    raise exception 'provider team % is actively attested to canonical team %; revoke it first', v.provider_team_id, v_current.team_id;
  end if;
  select a.provider_team_id into v_other
  from private.provider_team_identity_attestations a
  where a.provider = v.provider and a.team_id = v.team_id and a.provider_team_id <> v.provider_team_id
  for update;
  if v_other is not null then
    raise exception 'canonical team % is already actively attested to provider team %', v.team_id, v_other;
  end if;

  v_hash := private.provider_identity_evidence_sha256(p_attestation->'evidence');
  if v_current.provider is not null and v_current.evidence_sha256 = v_hash and v_current.attestation_basis = v.attestation_basis then
    return jsonb_build_object(
      'status', 'unchanged', 'provider', v.provider, 'provider_team_id', v.provider_team_id, 'team_id', v.team_id,
      'attestation_generation_id', v_current.attestation_generation_id,
      'attestation_version', v_current.attestation_version, 'event_id', v_current.latest_event_id);
  end if;

  select coalesce(max(e.attestation_version), 0) + 1 into v_version
  from private.provider_team_identity_attestation_events e
  where e.provider = v.provider and e.provider_team_id = v.provider_team_id;
  v_kind := case when v_current.provider is null then 'attest' else 'evidence_refresh' end;
  v_generation := coalesce(v_current.attestation_generation_id, gen_random_uuid());

  begin
    perform set_config('kapiloto.identity_attestation_rpc', 'on', true);
    insert into private.provider_team_identity_attestation_events (
      provider, provider_team_id, team_id, attestation_generation_id, attestation_version, event_kind,
      attestation_basis, evidence, evidence_sha256, mapping_status_snapshot, mapping_confidence_snapshot,
      provider_name_snapshot, attested_by)
    values (
      v.provider, v.provider_team_id, v.team_id, v_generation, v_version, v_kind,
      v.attestation_basis, p_attestation->'evidence', v_hash, v_mapping.mapping_status, v_mapping.mapping_confidence,
      v_mapping.provider_name, btrim(v.attested_by))
    returning id, recorded_at into v_event_id, v_recorded;
    if v_kind = 'attest' then
      insert into private.provider_team_identity_attestations (
        provider, provider_team_id, team_id, attestation_generation_id, attestation_version, latest_event_id,
        attestation_basis, evidence, evidence_sha256, first_attested_at, attested_at, attested_by)
      values (
        v.provider, v.provider_team_id, v.team_id, v_generation, v_version, v_event_id,
        v.attestation_basis, p_attestation->'evidence', v_hash, v_recorded, v_recorded, btrim(v.attested_by));
    else
      update private.provider_team_identity_attestations
      set attestation_version = v_version, latest_event_id = v_event_id, attestation_basis = v.attestation_basis,
          evidence = p_attestation->'evidence', evidence_sha256 = v_hash, attested_at = v_recorded,
          attested_by = btrim(v.attested_by)
      where provider = v.provider and provider_team_id = v.provider_team_id;
    end if;
    perform set_config('kapiloto.identity_attestation_rpc', 'off', true);
  exception when others then
    perform set_config('kapiloto.identity_attestation_rpc', 'off', true);
    raise;
  end;

  return jsonb_build_object(
    'status', case when v_kind = 'attest' then 'attested' else 'refreshed' end,
    'provider', v.provider, 'provider_team_id', v.provider_team_id, 'team_id', v.team_id,
    'attestation_generation_id', v_generation, 'attestation_version', v_version, 'event_id', v_event_id);
end;
$$;

create or replace function public.provider_identity_revoke_team(p_revocation jsonb)
returns jsonb
language plpgsql
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v record;
  v_mapping public.provider_team_mappings%rowtype;
  v_current private.provider_team_identity_attestations%rowtype;
  v_version integer;
  v_event_id uuid;
begin
  if p_revocation is null or jsonb_typeof(p_revocation) <> 'object' then
    raise exception 'a team revocation must be a JSON object';
  end if;
  perform private.kapiloto_v4_assert_keys(p_revocation,
    array['provider', 'provider_team_id', 'expected_team_id', 'reason', 'revoked_by'], 'team revocation');
  select * into v from jsonb_to_record(p_revocation) as x(
    provider text, provider_team_id text, expected_team_id uuid, reason text, revoked_by text);
  if v.expected_team_id is null or v.reason is null or v.revoked_by is null then
    raise exception 'a team revocation needs provider, provider_team_id, expected_team_id, reason and revoked_by';
  end if;
  perform private.provider_identity_assert_request(v.provider, v.provider_team_id, 'team');
  if char_length(btrim(v.reason)) not between 1 and 500 then
    raise exception 'a revocation needs a non-empty reason of at most 500 characters';
  end if;
  if char_length(btrim(v.revoked_by)) not between 1 and 200 then
    raise exception 'revoked_by must be a non-empty audit label of at most 200 characters';
  end if;

  perform private.provider_identity_begin_change(v.provider);

  select m.* into v_mapping
  from public.provider_team_mappings m
  where m.provider = v.provider and m.provider_team_id = v.provider_team_id
  for share;
  select a.* into v_current
  from private.provider_team_identity_attestations a
  where a.provider = v.provider and a.provider_team_id = v.provider_team_id
  for update;
  if v_current.provider is null then
    raise exception 'provider team % has no active attestation', v.provider_team_id;
  end if;
  if v_current.team_id <> v.expected_team_id then
    raise exception 'provider team % is attested to canonical team %, not the expected %', v.provider_team_id, v_current.team_id, v.expected_team_id;
  end if;

  select coalesce(max(e.attestation_version), 0) + 1 into v_version
  from private.provider_team_identity_attestation_events e
  where e.provider = v.provider and e.provider_team_id = v.provider_team_id;

  begin
    perform set_config('kapiloto.identity_attestation_rpc', 'on', true);
    insert into private.provider_team_identity_attestation_events (
      provider, provider_team_id, team_id, attestation_generation_id, attestation_version, event_kind,
      attestation_basis, evidence, evidence_sha256, mapping_status_snapshot, mapping_confidence_snapshot,
      provider_name_snapshot, attested_by, revoke_reason)
    values (
      v.provider, v.provider_team_id, v_current.team_id, v_current.attestation_generation_id, v_version, 'revoke',
      v_current.attestation_basis, v_current.evidence, v_current.evidence_sha256, v_mapping.mapping_status,
      v_mapping.mapping_confidence, v_mapping.provider_name, btrim(v.revoked_by), btrim(v.reason))
    returning id into v_event_id;
    delete from private.provider_team_identity_attestations
    where provider = v.provider and provider_team_id = v.provider_team_id;
    perform set_config('kapiloto.identity_attestation_rpc', 'off', true);
  exception when others then
    perform set_config('kapiloto.identity_attestation_rpc', 'off', true);
    raise;
  end;

  return jsonb_build_object(
    'status', 'revoked', 'provider', v.provider, 'provider_team_id', v.provider_team_id, 'team_id', v_current.team_id,
    'attestation_generation_id', v_current.attestation_generation_id, 'attestation_version', v_version, 'event_id', v_event_id);
end;
$$;

create or replace function public.provider_identity_attest_competition(p_attestation jsonb)
returns jsonb
language plpgsql
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v record;
  v_issue text;
  v_mapping public.provider_competition_mappings%rowtype;
  v_current private.provider_competition_identity_attestations%rowtype;
  v_other text;
  v_hash text;
  v_kind text;
  v_version integer;
  v_generation uuid;
  v_event_id uuid;
  v_recorded timestamptz;
begin
  if p_attestation is null or jsonb_typeof(p_attestation) <> 'object' then
    raise exception 'a competition attestation must be a JSON object';
  end if;
  perform private.kapiloto_v4_assert_keys(p_attestation,
    array['provider', 'provider_competition_id', 'competition_id', 'attestation_basis', 'evidence', 'attested_by'], 'competition attestation');
  select * into v from jsonb_to_record(p_attestation) as x(
    provider text, provider_competition_id text, competition_id uuid, attestation_basis text, attested_by text);
  if v.competition_id is null or v.attestation_basis is null or v.attested_by is null or p_attestation->'evidence' is null then
    raise exception 'a competition attestation needs provider, provider_competition_id, competition_id, attestation_basis, evidence and attested_by';
  end if;
  perform private.provider_identity_assert_request(v.provider, v.provider_competition_id, 'competition');
  if v.attestation_basis not in ('operator_manual', 'cross_provider_verified', 'provider_official_reference', 'fixture_identity_crosscheck', 'multi_source_verified') then
    raise exception 'unknown attestation basis %', v.attestation_basis;
  end if;
  if char_length(btrim(v.attested_by)) not between 1 and 200 then
    raise exception 'attested_by must be a non-empty audit label of at most 200 characters';
  end if;
  v_issue := private.provider_identity_evidence_issue(p_attestation->'evidence');
  if v_issue is not null then
    raise exception 'invalid attestation evidence: %', v_issue;
  end if;

  perform private.provider_identity_begin_change(v.provider);

  select m.* into v_mapping
  from public.provider_competition_mappings m
  where m.provider = v.provider and m.provider_competition_id = v.provider_competition_id
  for share;
  if not found then
    raise exception 'no % mapping exists for provider competition %', v.provider, v.provider_competition_id;
  end if;
  if v_mapping.mapping_status <> 'manual_override' then
    raise exception 'provider competition % is mapped as %, not manual_override', v.provider_competition_id, v_mapping.mapping_status;
  end if;
  if v_mapping.competition_id <> v.competition_id then
    raise exception 'provider competition % is mapped to canonical competition %, not %', v.provider_competition_id, v_mapping.competition_id, v.competition_id;
  end if;

  select a.* into v_current
  from private.provider_competition_identity_attestations a
  where a.provider = v.provider and a.provider_competition_id = v.provider_competition_id
  for update;
  if v_current.provider is not null and v_current.competition_id <> v.competition_id then
    raise exception 'provider competition % is actively attested to canonical competition %; revoke it first', v.provider_competition_id, v_current.competition_id;
  end if;
  select a.provider_competition_id into v_other
  from private.provider_competition_identity_attestations a
  where a.provider = v.provider and a.competition_id = v.competition_id and a.provider_competition_id <> v.provider_competition_id
  for update;
  if v_other is not null then
    raise exception 'canonical competition % is already actively attested to provider competition %', v.competition_id, v_other;
  end if;

  v_hash := private.provider_identity_evidence_sha256(p_attestation->'evidence');
  if v_current.provider is not null and v_current.evidence_sha256 = v_hash and v_current.attestation_basis = v.attestation_basis then
    return jsonb_build_object(
      'status', 'unchanged', 'provider', v.provider, 'provider_competition_id', v.provider_competition_id,
      'competition_id', v.competition_id, 'attestation_generation_id', v_current.attestation_generation_id,
      'attestation_version', v_current.attestation_version, 'event_id', v_current.latest_event_id);
  end if;

  select coalesce(max(e.attestation_version), 0) + 1 into v_version
  from private.provider_competition_identity_attestation_events e
  where e.provider = v.provider and e.provider_competition_id = v.provider_competition_id;
  v_kind := case when v_current.provider is null then 'attest' else 'evidence_refresh' end;
  v_generation := coalesce(v_current.attestation_generation_id, gen_random_uuid());

  begin
    perform set_config('kapiloto.identity_attestation_rpc', 'on', true);
    insert into private.provider_competition_identity_attestation_events (
      provider, provider_competition_id, competition_id, attestation_generation_id, attestation_version, event_kind,
      attestation_basis, evidence, evidence_sha256, mapping_status_snapshot, provider_name_snapshot, attested_by)
    values (
      v.provider, v.provider_competition_id, v.competition_id, v_generation, v_version, v_kind,
      v.attestation_basis, p_attestation->'evidence', v_hash, v_mapping.mapping_status, v_mapping.provider_name,
      btrim(v.attested_by))
    returning id, recorded_at into v_event_id, v_recorded;
    if v_kind = 'attest' then
      insert into private.provider_competition_identity_attestations (
        provider, provider_competition_id, competition_id, attestation_generation_id, attestation_version, latest_event_id,
        attestation_basis, evidence, evidence_sha256, first_attested_at, attested_at, attested_by)
      values (
        v.provider, v.provider_competition_id, v.competition_id, v_generation, v_version, v_event_id,
        v.attestation_basis, p_attestation->'evidence', v_hash, v_recorded, v_recorded, btrim(v.attested_by));
    else
      update private.provider_competition_identity_attestations
      set attestation_version = v_version, latest_event_id = v_event_id, attestation_basis = v.attestation_basis,
          evidence = p_attestation->'evidence', evidence_sha256 = v_hash, attested_at = v_recorded,
          attested_by = btrim(v.attested_by)
      where provider = v.provider and provider_competition_id = v.provider_competition_id;
    end if;
    perform set_config('kapiloto.identity_attestation_rpc', 'off', true);
  exception when others then
    perform set_config('kapiloto.identity_attestation_rpc', 'off', true);
    raise;
  end;

  return jsonb_build_object(
    'status', case when v_kind = 'attest' then 'attested' else 'refreshed' end,
    'provider', v.provider, 'provider_competition_id', v.provider_competition_id, 'competition_id', v.competition_id,
    'attestation_generation_id', v_generation, 'attestation_version', v_version, 'event_id', v_event_id);
end;
$$;

create or replace function public.provider_identity_revoke_competition(p_revocation jsonb)
returns jsonb
language plpgsql
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v record;
  v_mapping public.provider_competition_mappings%rowtype;
  v_current private.provider_competition_identity_attestations%rowtype;
  v_version integer;
  v_event_id uuid;
begin
  if p_revocation is null or jsonb_typeof(p_revocation) <> 'object' then
    raise exception 'a competition revocation must be a JSON object';
  end if;
  perform private.kapiloto_v4_assert_keys(p_revocation,
    array['provider', 'provider_competition_id', 'expected_competition_id', 'reason', 'revoked_by'], 'competition revocation');
  select * into v from jsonb_to_record(p_revocation) as x(
    provider text, provider_competition_id text, expected_competition_id uuid, reason text, revoked_by text);
  if v.expected_competition_id is null or v.reason is null or v.revoked_by is null then
    raise exception 'a competition revocation needs provider, provider_competition_id, expected_competition_id, reason and revoked_by';
  end if;
  perform private.provider_identity_assert_request(v.provider, v.provider_competition_id, 'competition');
  if char_length(btrim(v.reason)) not between 1 and 500 then
    raise exception 'a revocation needs a non-empty reason of at most 500 characters';
  end if;
  if char_length(btrim(v.revoked_by)) not between 1 and 200 then
    raise exception 'revoked_by must be a non-empty audit label of at most 200 characters';
  end if;

  perform private.provider_identity_begin_change(v.provider);

  select m.* into v_mapping
  from public.provider_competition_mappings m
  where m.provider = v.provider and m.provider_competition_id = v.provider_competition_id
  for share;
  select a.* into v_current
  from private.provider_competition_identity_attestations a
  where a.provider = v.provider and a.provider_competition_id = v.provider_competition_id
  for update;
  if v_current.provider is null then
    raise exception 'provider competition % has no active attestation', v.provider_competition_id;
  end if;
  if v_current.competition_id <> v.expected_competition_id then
    raise exception 'provider competition % is attested to canonical competition %, not the expected %', v.provider_competition_id, v_current.competition_id, v.expected_competition_id;
  end if;

  select coalesce(max(e.attestation_version), 0) + 1 into v_version
  from private.provider_competition_identity_attestation_events e
  where e.provider = v.provider and e.provider_competition_id = v.provider_competition_id;

  begin
    perform set_config('kapiloto.identity_attestation_rpc', 'on', true);
    insert into private.provider_competition_identity_attestation_events (
      provider, provider_competition_id, competition_id, attestation_generation_id, attestation_version, event_kind,
      attestation_basis, evidence, evidence_sha256, mapping_status_snapshot, provider_name_snapshot, attested_by, revoke_reason)
    values (
      v.provider, v.provider_competition_id, v_current.competition_id, v_current.attestation_generation_id, v_version, 'revoke',
      v_current.attestation_basis, v_current.evidence, v_current.evidence_sha256, v_mapping.mapping_status,
      v_mapping.provider_name, btrim(v.revoked_by), btrim(v.reason))
    returning id into v_event_id;
    delete from private.provider_competition_identity_attestations
    where provider = v.provider and provider_competition_id = v.provider_competition_id;
    perform set_config('kapiloto.identity_attestation_rpc', 'off', true);
  exception when others then
    perform set_config('kapiloto.identity_attestation_rpc', 'off', true);
    raise;
  end;

  return jsonb_build_object(
    'status', 'revoked', 'provider', v.provider, 'provider_competition_id', v.provider_competition_id,
    'competition_id', v_current.competition_id, 'attestation_generation_id', v_current.attestation_generation_id,
    'attestation_version', v_version, 'event_id', v_event_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Canonical fixture candidates for V2 ingest: the A2-A team-pair window and
-- guard classification, one row per candidate.
--   N: same orientation and competition within 48 h. R: reversed orientation
--   within 48 h. X: another known competition within 48 h. U: unknown
--   competition within 14 days. P: postponed-like within 180 days. W: same
--   competition within 14 days.
-- mapped_id: this provider's mapping on the candidate (any status). other_id:
-- the candidate is identified with another provider fixture id (mapped to it,
-- or its latest ledger version for this provider is an observation of it).
-- ---------------------------------------------------------------------------

create or replace function private.provider_ingest_fixture_candidates_v2(
  p_provider text,
  p_provider_fixture_id text,
  p_home uuid,
  p_away uuid,
  p_competition uuid,
  p_kickoff timestamptz
)
returns table (
  fixture_id uuid,
  competition_id uuid,
  status text,
  same_orientation boolean,
  gap numeric,
  mapped_id text,
  other_id text,
  guard text
)
language sql
stable
set search_path = ''
as $$
  with pair as (
    select
      f.id,
      f.competition_id,
      f.status,
      f.home_team_id = p_home as same_orientation,
      abs(extract(epoch from (f.kickoff_at - p_kickoff))) as gap,
      m.provider_fixture_id as mapped_id,
      case
        when m.provider_fixture_id is not null and m.provider_fixture_id <> p_provider_fixture_id then m.provider_fixture_id
        when lo.observation_kind = 'observation' and lo.provider_fixture_id <> p_provider_fixture_id then lo.provider_fixture_id
      end as other_id
    from public.fixtures f
    left join public.provider_fixture_mappings m
      on m.fixture_id = f.id and m.provider = p_provider
    left join lateral (
      select o.provider_fixture_id, o.observation_kind
      from public.match_ledger_observations o
      where o.fixture_id = f.id and o.provider = p_provider
      order by o.observation_version desc
      limit 1
    ) lo on true
    where ((f.home_team_id = p_home and f.away_team_id = p_away)
        or (f.home_team_id = p_away and f.away_team_id = p_home))
      and f.kickoff_at between p_kickoff - interval '180 days' and p_kickoff + interval '180 days'
  )
  select
    pr.id, pr.competition_id, pr.status, pr.same_orientation, pr.gap, pr.mapped_id, pr.other_id,
    case
      when not pr.same_orientation then case when pr.gap <= 48 * 3600 then 'R' end
      when pr.competition_id = p_competition and pr.gap <= 48 * 3600 then 'N'
      when pr.competition_id is null then case when pr.gap <= 14 * 86400 then 'U' end
      when pr.competition_id <> p_competition then case when pr.gap <= 48 * 3600 then 'X' end
      when pr.status in ('postponed', 'suspended', 'cancelled', 'under_review') then 'P'
      when pr.gap <= 14 * 86400 then 'W'
    end
  from pair pr
$$;

-- ---------------------------------------------------------------------------
-- public.match_ledger_ingest_provider_fixture_v2 (kapiloto-provider-match-observation-v1)
--
-- The A2-A ingest with the Stage 1 trust model. Same payload contract, phases
-- and player semantics; differences:
--   * a run is mandatory and its scope.provider_fixture_ids must list the
--     incoming provider fixture id (accident containment for the bounded
--     pilot, not a boundary against a deliberately malicious service_role);
--   * teams and the competition are trusted only through manual_override
--     mappings that agree with the active V4 attestations;
--   * an existing provider fixture mapping is an operational pointer: it is
--     accepted only when full team-pair classification independently selects
--     its fixture as the unique valid N candidate, and it never falls back to
--     another candidate;
--   * unchanged football content under a stale attestation generation is a
--     quarantine (attestation_generation_stale), never a silent "unchanged";
--   * each recorded version seals the exact attestation event/generation of
--     its league/home/away identities.
--
-- Global lock order (every V2 ingest, every path):
--   1. 1A provider-fixture advisory lock (exclusive);
--   2. provider identity advisory lock (shared);
--   3. competition mapping row FOR SHARE;
--   4. competition attestation projection row FOR SHARE;
--   5. both team mapping rows, one statement, provider_team_id COLLATE "C", FOR SHARE;
--   6. both team attestation projection rows, same order, FOR SHARE;
--   7. the incoming provider fixture mapping row, if it exists, FOR SHARE;
--   8. the unordered canonical team-pair advisory lock (exclusive), on BOTH
--      the existing-mapping and the no-mapping path;
--   9. every mapping row of this provider on a candidate fixture, ordered by
--      provider_fixture_id COLLATE "C", FOR SHARE;
--  10. the selected canonical fixture row FOR SHARE (existing mapping or
--      attach target) before its facts are validated;
--  11. attach/mint writes;
--  12. 1A fixture/provider advisory lock (exclusive);
--  13. players identity advisory lock (exclusive).
-- Attest/revoke take the provider identity lock exclusive as their first lock
-- and never take 1, 8, 12 or 13, so the two cannot form a cycle.
--
-- Residual (accepted, D-058): Toto import does not take the team-pair lock,
-- so it can insert a brand-new duplicate fixture while an existing-mapping
-- ingest is in flight (there is no row to lock yet). That is equivalent to
-- "ingest first, import second": the current ingest may commit, and the next
-- ingest attempt sees the duplicate and quarantines.
-- ---------------------------------------------------------------------------

create or replace function public.match_ledger_ingest_provider_fixture_v2(p_observation jsonb)
returns jsonb
language plpgsql
set search_path = ''
set timezone = 'UTC'
set lock_timeout = '5s'
as $$
declare
  v record;
  v_fam jsonb;
  v_mint jsonb;
  v_now timestamptz := private.kapiloto_information_clock();
  v_run public.provider_ingest_runs%rowtype;
  v_scope jsonb;
  v_competition uuid;
  v_competition_status text;
  v_competition_attested uuid;
  v_competition_generation uuid;
  v_competition_event uuid;
  v_home uuid;
  v_away uuid;
  v_home_found boolean := false;
  v_away_found boolean := false;
  v_home_status text;
  v_away_status text;
  v_home_mapped uuid;
  v_away_mapped uuid;
  v_home_attested uuid;
  v_away_attested uuid;
  v_home_generation uuid;
  v_away_generation uuid;
  v_home_event uuid;
  v_away_event uuid;
  v_team record;
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
  v_same_fixture uuid;
  v_conflict integer;
  v_conflict_ids jsonb;
  v_candidates jsonb;
  v_candidate uuid;
  v_fixture_issue text;
  v_flags jsonb;
  v_latest public.match_ledger_observations%rowtype;
  v_prior_refs jsonb;
  v_prior_families jsonb;
  v_payload_refs jsonb;
  v_family_upgrade boolean := false;
  v_generation_stale boolean := false;
  v_generations jsonb;
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

  -- Run scope (D-058). The run row is immutable, so its allowlist cannot be
  -- widened after review; a misconfigured run is an error, an unlisted
  -- fixture an audited quarantine (below, under the provider-fixture lock).
  if v.run_id is null then
    raise exception 'V2 provider ingest requires a run_id';
  end if;
  select r0.* into v_run from public.provider_ingest_runs r0 where r0.id = v.run_id;
  if not found then
    raise exception 'provider ingest run % not found', v.run_id;
  end if;
  if v_run.provider <> v.provider then
    raise exception 'provider ingest run % belongs to provider %', v.run_id, v_run.provider;
  end if;
  v_scope := v_run.scope->'provider_fixture_ids';
  if jsonb_typeof(v_scope) is distinct from 'array' or jsonb_array_length(v_scope) = 0
    or exists (select 1 from jsonb_array_elements(v_scope) e where jsonb_typeof(e) <> 'string' or btrim(e #>> '{}') = '') then
    raise exception 'provider ingest run % needs scope.provider_fixture_ids: a non-empty array of provider fixture ids', v.run_id;
  end if;

  perform private.kapiloto_require_read_committed('provider ingest');
  -- 1.
  perform pg_advisory_xact_lock(hashtextextended(
    'kapiloto_match_ledger_provider_fixture:' || v.provider || ':' || v.provider_fixture_id, 0
  ));
  -- 2.
  perform private.lock_provider_identity(v.provider, false);

  -- ---------------------------------------------------------------- phase 1
  if not (v_scope ? v.provider_fixture_id) then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'fixture_outside_run_scope', null, null, jsonb_build_object('run_id', v.run_id), null, v_flags);
  end if;
  if exists (select 1 from jsonb_each_text(v_fam) f where f.value = 'failed') then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'family_fetch_failed', null, null, jsonb_build_object('family_fetches', v_fam), null, v_flags);
  end if;
  if v.match_status <> 'finished' then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'not_finished', null, null, jsonb_build_object('match_status', v.match_status), null, v_flags);
  end if;
  if v.kickoff_at + interval '105 minutes' > v_now then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'finished_too_early', null, null, jsonb_build_object('kickoff_at', v.kickoff_at), null, v_flags);
  end if;

  -- 3, 4. Competition: manual_override mapping AND agreeing active attestation.
  select m.competition_id, m.mapping_status into v_competition, v_competition_status
  from public.provider_competition_mappings m
  where m.provider = v.provider and m.provider_competition_id = v.provider_league_id
  for share;
  select a.competition_id, a.attestation_generation_id, a.latest_event_id
    into v_competition_attested, v_competition_generation, v_competition_event
  from private.provider_competition_identity_attestations a
  where a.provider = v.provider and a.provider_competition_id = v.provider_league_id
  for share;
  if v_competition is null then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'competition_unmapped', null, null, jsonb_build_object('provider_league_id', v.provider_league_id), null, v_flags);
  end if;
  if v_competition_status <> 'manual_override' then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'competition_mapping_not_manual_override', null, null,
      jsonb_build_object('provider_league_id', v.provider_league_id, 'mapping_status', v_competition_status), null, v_flags);
  end if;
  if v_competition_attested is null then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'competition_attestation_missing', null, null, jsonb_build_object('provider_league_id', v.provider_league_id), null, v_flags);
  end if;
  if v_competition_attested <> v_competition then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'competition_attestation_mismatch', null, null,
      jsonb_build_object('provider_league_id', v.provider_league_id, 'mapped_competition_id', v_competition,
                         'attested_competition_id', v_competition_attested), null, v_flags);
  end if;

  -- 5, 6. Teams: both mapping rows, then both projection rows, each in ONE
  -- statement ordered by provider_team_id COLLATE "C" (independent of side).
  for v_team in
    select m.provider_team_id, m.team_id, m.mapping_status
    from public.provider_team_mappings m
    where m.provider = v.provider
      and m.provider_team_id in (v.provider_home_team_id, v.provider_away_team_id)
    order by m.provider_team_id collate "C"
    for share
  loop
    if v_team.provider_team_id = v.provider_home_team_id then
      v_home_found := true;
      v_home_mapped := v_team.team_id;
      v_home_status := v_team.mapping_status;
    else
      v_away_found := true;
      v_away_mapped := v_team.team_id;
      v_away_status := v_team.mapping_status;
    end if;
  end loop;
  for v_team in
    select a.provider_team_id, a.team_id, a.attestation_generation_id, a.latest_event_id
    from private.provider_team_identity_attestations a
    where a.provider = v.provider
      and a.provider_team_id in (v.provider_home_team_id, v.provider_away_team_id)
    order by a.provider_team_id collate "C"
    for share
  loop
    if v_team.provider_team_id = v.provider_home_team_id then
      v_home_attested := v_team.team_id;
      v_home_generation := v_team.attestation_generation_id;
      v_home_event := v_team.latest_event_id;
    else
      v_away_attested := v_team.team_id;
      v_away_generation := v_team.attestation_generation_id;
      v_away_event := v_team.latest_event_id;
    end if;
  end loop;
  if not v_home_found or not v_away_found then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'team_unmapped', null, null,
      jsonb_build_object('home_mapped', v_home_found, 'away_mapped', v_away_found), null, v_flags);
  end if;
  if v_home_status <> 'manual_override' or v_away_status <> 'manual_override' then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'team_mapping_not_manual_override', null, null,
      jsonb_build_object('home_mapping_status', v_home_status, 'away_mapping_status', v_away_status), null, v_flags);
  end if;
  if v_home_attested is null or v_away_attested is null then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'team_attestation_missing', null, null,
      jsonb_build_object('home_attested', v_home_attested is not null, 'away_attested', v_away_attested is not null), null, v_flags);
  end if;
  if v_home_attested <> v_home_mapped or v_away_attested <> v_away_mapped then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'team_attestation_mismatch', null, null,
      jsonb_build_object('home_agrees', v_home_attested = v_home_mapped, 'away_agrees', v_away_attested = v_away_mapped), null, v_flags);
  end if;
  v_home := v_home_mapped;
  v_away := v_away_mapped;
  if v_home = v_away then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'team_identity_conflict', null, null, '{}'::jsonb, null, v_flags);
  end if;

  -- Players: unchanged A2-A semantics. Unverified mappings are never trusted,
  -- promoted or bypassed.
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

  -- 7. The incoming provider fixture mapping. Its status and confidence are
  -- not trust; only 'unverified' fails closed outright.
  select m.fixture_id, m.mapping_status into v_map_fixture, v_map_status
  from public.provider_fixture_mappings m
  where m.provider = v.provider and m.provider_fixture_id = v.provider_fixture_id
  for share;
  if v_map_fixture is not null and v_map_status = 'unverified' then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      'fixture_mapping_unverified', v_map_fixture, null, '{}'::jsonb, null, v_flags);
  end if;

  -- 8. One lock per UNORDERED canonical team pair, on both paths.
  perform pg_advisory_xact_lock(hashtextextended(
    'kapiloto_canonical_fixture_pair:' || least(v_home, v_away)::text || ':' || greatest(v_home, v_away)::text, 0
  ));
  -- 9. Existing mapping rows of this provider on candidate fixtures.
  perform 1
  from public.provider_fixture_mappings m
  join public.fixtures f on f.id = m.fixture_id
  where m.provider = v.provider
    and ((f.home_team_id = v_home and f.away_team_id = v_away)
        or (f.home_team_id = v_away and f.away_team_id = v_home))
    and f.kickoff_at between v.kickoff_at - interval '180 days' and v.kickoff_at + interval '180 days'
  order by m.provider_fixture_id collate "C"
  for share of m;

  -- Classification. The candidate carrying the incoming id (the existing
  -- mapping being validated) is never counted as a conflict against itself.
  select
    count(*) filter (where c.mapped_id = v.provider_fixture_id),
    (array_agg(c.fixture_id) filter (where c.mapped_id = v.provider_fixture_id))[1],
    count(*) filter (where c.guard is not null and c.other_id is not null and c.fixture_id is distinct from v_map_fixture),
    count(*) filter (where c.guard = 'N' and c.fixture_id is distinct from v_map_fixture),
    count(*) filter (where c.guard = 'W' and c.fixture_id is distinct from v_map_fixture),
    count(*) filter (where c.guard = 'P' and c.fixture_id is distinct from v_map_fixture),
    count(*) filter (where c.guard = 'U' and c.fixture_id is distinct from v_map_fixture),
    count(*) filter (where c.guard = 'R' and c.fixture_id is distinct from v_map_fixture),
    count(*) filter (where c.guard = 'X' and c.fixture_id is distinct from v_map_fixture),
    (array_agg(c.fixture_id) filter (where c.guard = 'N' and c.fixture_id is distinct from v_map_fixture))[1],
    coalesce(jsonb_agg(distinct c.other_id) filter (
      where c.guard is not null and c.other_id is not null and c.fixture_id is distinct from v_map_fixture), '[]'::jsonb)
  into v_same, v_same_fixture, v_conflict, v_n, v_w, v_p, v_u, v_r, v_x, v_candidate, v_conflict_ids
  from private.provider_ingest_fixture_candidates_v2(
    v.provider, v.provider_fixture_id, v_home, v_away, v_competition, v.kickoff_at) c;
  v_candidates := jsonb_build_object(
    'attach_window', v_n, 'reschedule_window', v_w, 'postponement_window', v_p,
    'unknown_competition', v_u, 'reversed_orientation', v_r, 'other_competition', v_x,
    'provider_identity_conflicts', v_conflict, 'conflicting_provider_fixture_ids', v_conflict_ids,
    'incoming_id_candidates', v_same
  );

  if v_map_fixture is not null then
    -- 10. The mapped fixture row, then its facts, then uniqueness. Never a
    -- fallback to another candidate.
    select f.* into v_fixture from public.fixtures f where f.id = v_map_fixture for share;
    v_fixture_issue := case
      when v_fixture.id is null then 'fixture_mapping_team_conflict'
      when v_fixture.home_team_id = v_away and v_fixture.away_team_id = v_home then 'fixture_mapping_orientation_conflict'
      when v_fixture.home_team_id <> v_home or v_fixture.away_team_id <> v_away then 'fixture_mapping_team_conflict'
      when v_fixture.competition_id is distinct from v_competition then 'fixture_mapping_competition_conflict'
      when abs(extract(epoch from (v_fixture.kickoff_at - v.kickoff_at))) > 48 * 3600 then 'fixture_mapping_kickoff_conflict'
      when v_fixture.status in ('postponed', 'suspended', 'cancelled', 'under_review') then 'fixture_mapping_status_conflict'
      when v_same <> 1 or v_same_fixture is distinct from v_map_fixture then 'fixture_mapping_conflict'
      when v_conflict > 0 then 'fixture_mapping_provider_identity_conflict'
      when v_n > 0 then 'fixture_mapping_candidate_ambiguous'
      when v_r > 0 then 'fixture_mapping_orientation_conflict'
      when v_x > 0 then 'fixture_mapping_competition_conflict'
      when v_u > 0 then 'fixture_mapping_competition_unknown'
      when v_p > 0 then 'fixture_mapping_possible_postponement'
      when v_w > 0 then 'fixture_mapping_reschedule_conflict'
    end;
    if v_fixture_issue is not null then
      return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
        v_fixture_issue, v_map_fixture, null, v_candidates, null, v_flags);
    end if;
    v_fixture_id := v_map_fixture;
    v_resolution := 'existing_mapping';
  elsif v_same > 0 then
    -- No mapping at the primary lookup, yet a candidate carries this id (a
    -- concurrent non-ingest writer).
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
    -- 10. The single candidate row, its attach-window facts re-read under
    -- the lock (A2-A attach rules otherwise unchanged).
    select f.* into v_fixture from public.fixtures f where f.id = v_candidate for share;
    if v_fixture.id is null or v_fixture.home_team_id <> v_home or v_fixture.away_team_id <> v_away
      or v_fixture.competition_id is distinct from v_competition
      or abs(extract(epoch from (v_fixture.kickoff_at - v.kickoff_at))) > 48 * 3600 then
      return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
        'fixture_candidate_changed', v_candidate, null, v_candidates, null, v_flags);
    end if;
    v_fixture_id := v_candidate;
    v_resolution := 'attached';
  else
    -- A2-A mint provenance allows one mint per provider fixture id. A chain
    -- that was withdrawn and whose mapping was removed (recovery) cannot be
    -- minted again: the operator attaches it to a reviewed canonical fixture
    -- instead. An audited quarantine, not an exception.
    if exists (
      select 1 from public.match_ledger_fixture_mints mi
      where mi.provider = v.provider and mi.provider_fixture_id = v.provider_fixture_id
    ) then
      return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
        'fixture_mint_exists', null, null,
        jsonb_build_object('minted_fixture_id', (select mi.fixture_id from public.match_ledger_fixture_mints mi
                                                 where mi.provider = v.provider and mi.provider_fixture_id = v.provider_fixture_id)),
        null, v_flags);
    end if;
    v_mint := coalesce(p_observation->'fixture_mint', '{}'::jsonb);
    if v_mint->>'kickoff_before' is not null and v_run.fixture_mint_kickoff_before is not null
      and (v_mint->>'kickoff_before')::timestamptz > v_run.fixture_mint_kickoff_before then
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

  v_generations := jsonb_build_object(
    'league', v_competition_generation, 'team_home', v_home_generation, 'team_away', v_away_generation);

  -- Drift against the latest version of (fixture, provider), as in A2-A, plus
  -- generation continuity: the latest version's sealed attestation
  -- generations must be the current ones, or unchanged content is quarantined
  -- below instead of being reported as "unchanged".
  if v_fixture_id is not null then
    select o.* into v_latest
    from public.match_ledger_observations o
    where o.fixture_id = v_fixture_id and o.provider = v.provider
    order by o.observation_version desc
    limit 1;
    if found and v_latest.observation_kind = 'observation' then
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
      v_generation_stale := (
        select count(*)
        from public.match_ledger_observation_identity_attestations sa
        where sa.observation_id = v_latest.id
          and ((sa.ref_kind = 'league' and sa.attestation_generation_id = v_competition_generation and sa.canonical_id = v_competition)
            or (sa.ref_kind = 'team_home' and sa.attestation_generation_id = v_home_generation and sa.canonical_id = v_home)
            or (sa.ref_kind = 'team_away' and sa.attestation_generation_id = v_away_generation and sa.canonical_id = v_away))
      ) <> 3;
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

    -- 12, 13.
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
    -- trusted identity, in the same attestation generations, and the fixture
    -- decision must still hold. The shared provider identity lock and the
    -- FOR SHARE row locks make this hold against concurrent writers; the
    -- check turns any bypass into a full rollback.
    if not private.provider_competition_attestation_matches(v.provider, v.provider_league_id, v_competition, v_competition_generation)
      or not private.provider_team_attestation_matches(v.provider, v.provider_home_team_id, v_home, v_home_generation)
      or not private.provider_team_attestation_matches(v.provider, v.provider_away_team_id, v_away, v_away_generation)
      or not exists (
        select 1 from public.provider_fixture_mappings m
        where m.provider = v.provider and m.provider_fixture_id = v.provider_fixture_id
          and m.fixture_id = v_fixture_id and m.mapping_status <> 'unverified')
      or not exists (
        select 1 from public.fixtures f
        where f.id = v_fixture_id and f.home_team_id = v_home and f.away_team_id = v_away
          and f.competition_id = v_competition
          and abs(extract(epoch from (f.kickoff_at - v.kickoff_at))) <= 48 * 3600
          and (v_resolution <> 'existing_mapping' or f.status not in ('postponed', 'suspended', 'cancelled', 'under_review')))
      or exists (
        select 1 from private.provider_ingest_fixture_candidates_v2(
          v.provider, v.provider_fixture_id, v_home, v_away, v_competition, v.kickoff_at) c
        where c.fixture_id <> v_fixture_id and c.guard is not null) then
      raise exception 'provider identity changed during V2 ingest of % fixture %; nothing was written',
        v.provider, v.provider_fixture_id;
    end if;

    if v_result->>'status' = 'recorded' then
      insert into public.match_ledger_observation_provider_refs (observation_id, ref_kind, provider_ref, canonical_id)
      values
        ((v_result->>'observation_id')::uuid, 'league', v.provider_league_id, v_competition),
        ((v_result->>'observation_id')::uuid, 'season', v.provider_season_id, null),
        ((v_result->>'observation_id')::uuid, 'team_home', v.provider_home_team_id, v_home),
        ((v_result->>'observation_id')::uuid, 'team_away', v.provider_away_team_id, v_away);
      insert into public.match_ledger_observation_family_fetches (observation_id, family, fetch_status)
      select (v_result->>'observation_id')::uuid, e.key, e.value
      from jsonb_each_text(v_fam) e;
      perform set_config('kapiloto.provider_ingest_v2', 'on', true);
      insert into public.match_ledger_observation_identity_attestations (
        observation_id, ref_kind, team_attestation_event_id, competition_attestation_event_id,
        attestation_generation_id, provider_ref, canonical_id)
      values
        ((v_result->>'observation_id')::uuid, 'league', null, v_competition_event, v_competition_generation, v.provider_league_id, v_competition),
        ((v_result->>'observation_id')::uuid, 'team_home', v_home_event, null, v_home_generation, v.provider_home_team_id, v_home),
        ((v_result->>'observation_id')::uuid, 'team_away', v_away_event, null, v_away_generation, v.provider_away_team_id, v_away);
      perform set_config('kapiloto.provider_ingest_v2', 'off', true);
    elsif v_family_upgrade then
      raise exception using errcode = 'KQ001', message = 'family_status_drift';
    elsif v_generation_stale then
      raise exception using errcode = 'KQ001', message = 'attestation_generation_stale';
    end if;
  exception when sqlstate 'KQ001' then
    v_quarantine := sqlerrm;
  end;

  if v_quarantine is not null then
    return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, 'quarantined',
      v_quarantine, v_fixture_id, null,
      case when v_quarantine = 'attestation_generation_stale'
        then jsonb_build_object('latest_observation_id', v_latest.id, 'current_generations', v_generations)
        else jsonb_build_object('recorded', v_prior_families, 'payload', v_fam) end,
      null, v_flags);
  end if;

  return private.provider_ingest_result(v.run_id, v.provider, v.provider_fixture_id, v_result->>'status', null,
    v_fixture_id, (v_result->>'observation_id')::uuid,
    jsonb_build_object(
      'fixture_resolution', v_resolution,
      'players_minted', v_minted,
      'family_response_sha256', coalesce(p_observation->'family_response_sha256', '{}'::jsonb),
      'attestation_generations', v_generations
    ),
    jsonb_build_object(
      'fixture_resolution', v_resolution,
      'observation_version', (v_result->>'observation_version')::integer,
      'provider_refs_status', v_refs_status,
      'players_minted', v_minted,
      'attestation_generations', v_generations
    ), v_flags);
end;
$$;

-- ---------------------------------------------------------------------------
-- V2 model-facing reads (kapiloto-team-match-stats-v1 rows, attestation-gated
-- row set). The V1 selection, availability and supersession rules run first;
-- a selected version that is not trusted drops the fixture (never a fallback
-- to an earlier version). Every provider is gated the same way, so a provider
-- without Stage 1 attestations, and every plain 1A observation, yields zero
-- rows here.
-- ---------------------------------------------------------------------------

create or replace function private.match_ledger_team_match_stats_v2(
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
language sql
stable
set search_path = ''
as $$
  select t.*
  from private.match_ledger_team_match_stats(p_provider, p_competition_ids, p_from, p_cutoff, p_mode, p_policy) t
  where private.match_ledger_observation_attestation_issue(t.observation_id) is null
  order by t.kickoff_at, t.fixture_id, t.side
$$;

create or replace function public.match_ledger_team_match_stats_as_of_v2(
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
  select to_jsonb(t) from private.match_ledger_team_match_stats_v2(
    p_provider, p_competition_ids, p_from, p_cutoff, 'actual', null) t
$$;

create or replace function public.match_ledger_team_match_stats_for_training_v2(
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
  select to_jsonb(t) from private.match_ledger_team_match_stats_v2(
    p_provider, p_competition_ids, p_from, p_training_cutoff, 'retrospective_training', p_policy) t
$$;

-- Trust-aware retrospective exclusions: the V1 reasons (later_correction,
-- later_withdrawal) plus the trust reasons of the version the training read
-- would otherwise select (attestation_missing, generation_revoked,
-- attestation_generation_stale, mapping_missing, mapping_not_manual_override,
-- mapping_disagrees). Same filters as the V2 training read.
create or replace function private.match_ledger_retrospective_exclusions_v2(
  p_provider text,
  p_competition_ids uuid[],
  p_from timestamptz,
  p_training_cutoff timestamptz,
  p_policy text
)
returns table (
  fixture_id uuid,
  provider text,
  competition_id uuid,
  kickoff_at timestamptz,
  selected_observation_id uuid,
  selected_observation_version integer,
  effective_available_at timestamptz,
  availability_basis text,
  latest_observation_id uuid,
  latest_observation_version integer,
  latest_observation_kind text,
  latest_first_seen_at timestamptz,
  exclusion_reason text,
  availability_policy text
)
language sql
stable
set search_path = ''
as $$
  with ev as (
    select ev.*, private.match_ledger_observation_attestation_issue(ev.observation_id) as trust_issue
    from private.match_ledger_effective_versions(p_provider, p_training_cutoff, 'retrospective_training', p_policy) ev
  )
  select ev.fixture_id, o.provider, f.competition_id, o.kickoff_at, ev.observation_id, ev.observation_version,
         ev.effective_available_at, ev.availability_basis, lo.id, lo.observation_version, lo.observation_kind,
         lo.first_seen_at, coalesce(ev.superseded_reason, ev.trust_issue), p_policy
  from ev
  join public.match_ledger_observations o on o.id = ev.observation_id
  join public.fixtures f on f.id = ev.fixture_id
  join public.match_ledger_observations lo
    on lo.fixture_id = ev.fixture_id and lo.provider = o.provider and lo.observation_version = ev.latest_observation_version
  where (ev.superseded_reason is not null or ev.trust_issue is not null)
    and o.match_status = 'finished'
    and o.kickoff_at < p_training_cutoff
    and (p_from is null or o.kickoff_at >= p_from)
    and (p_competition_ids is null or f.competition_id = any (p_competition_ids))
  order by o.kickoff_at, ev.fixture_id
$$;

create or replace function public.match_ledger_retrospective_training_exclusions_v2(
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
  select to_jsonb(t) from private.match_ledger_retrospective_exclusions_v2(
    p_provider, p_competition_ids, p_from, p_training_cutoff, p_policy) t
$$;

-- ---------------------------------------------------------------------------
-- Entity-level readiness report (read only). Works with zero observations.
--   attested_mapping_missing / attested_mapping_disagrees /
--   attested_mapping_not_manual_override            blocking
--   shadow_mapping_for_attested_canonical           blocking, warning when the
--                                                   shadow row is unverified
--   mapping_unattested                              info (reconciliation worklist)
--   mint_without_mapping                            warning: a fixture this
--     provider's ingest minted no longer has its provider fixture mapping
--     (a withdrawn chain under recovery; entity_kind 'fixture', provider_ref
--     is the provider fixture id, mapping_canonical_id the minted fixture)
-- ---------------------------------------------------------------------------

create or replace function public.provider_identity_attestation_conflicts(p_provider text)
returns table (
  issue_code text,
  severity text,
  entity_kind text,
  provider_ref text,
  attested_canonical_id uuid,
  attestation_generation_id uuid,
  mapping_canonical_id uuid,
  mapping_status text,
  related_provider_ref text
)
language sql
stable
set search_path = ''
as $$
  with att as (
    select 'team'::text as kind, a.provider_team_id as ref, a.team_id as canonical, a.attestation_generation_id as generation
    from private.provider_team_identity_attestations a where a.provider = p_provider
    union all
    select 'competition', a.provider_competition_id, a.competition_id, a.attestation_generation_id
    from private.provider_competition_identity_attestations a where a.provider = p_provider
  ),
  map as (
    select 'team'::text as kind, m.provider_team_id as ref, m.team_id as canonical, m.mapping_status as status
    from public.provider_team_mappings m where m.provider = p_provider
    union all
    select 'competition', m.provider_competition_id, m.competition_id, m.mapping_status
    from public.provider_competition_mappings m where m.provider = p_provider
  ),
  issues as (
    select 'attested_mapping_missing'::text as code, 'blocking'::text as sev, a.kind, a.ref, a.canonical, a.generation,
           null::uuid as map_canonical, null::text as map_status, null::text as related
    from att a
    left join map m on m.kind = a.kind and m.ref = a.ref
    where m.ref is null
    union all
    select 'attested_mapping_disagrees', 'blocking', a.kind, a.ref, a.canonical, a.generation, m.canonical, m.status, null
    from att a
    join map m on m.kind = a.kind and m.ref = a.ref
    where m.canonical <> a.canonical
    union all
    select 'attested_mapping_not_manual_override', 'blocking', a.kind, a.ref, a.canonical, a.generation, m.canonical, m.status, null
    from att a
    join map m on m.kind = a.kind and m.ref = a.ref
    where m.status <> 'manual_override'
    union all
    select 'shadow_mapping_for_attested_canonical',
           case when m.status = 'unverified' then 'warning' else 'blocking' end,
           a.kind, a.ref, a.canonical, a.generation, m.canonical, m.status, m.ref
    from att a
    join map m on m.kind = a.kind and m.canonical = a.canonical and m.ref <> a.ref
    union all
    select 'mapping_unattested', 'info', m.kind, m.ref, null, null, m.canonical, m.status, null
    from map m
    left join att a on a.kind = m.kind and a.ref = m.ref
    where a.ref is null
    union all
    select 'mint_without_mapping', 'warning', 'fixture', mi.provider_fixture_id, null, null, mi.fixture_id, null, null
    from public.match_ledger_fixture_mints mi
    where mi.provider = p_provider
      and not exists (
        select 1 from public.provider_fixture_mappings pm
        where pm.provider = mi.provider and pm.provider_fixture_id = mi.provider_fixture_id and pm.fixture_id = mi.fixture_id)
  )
  select i.code, i.sev, i.kind, i.ref, i.canonical, i.generation, i.map_canonical, i.map_status, i.related
  from issues i
  order by i.kind, i.ref collate "C", i.code, i.related collate "C"
$$;

-- ---------------------------------------------------------------------------
-- Observation-level provider-ref reconciliation V2 (read only). Compares the
-- sealed refs, canonical ids and attestation generations of every observation
-- version with today's mappings and attestations. The V1 report
-- (match_ledger_provider_ref_conflicts) keeps its confidence-based rule and
-- loses service_role EXECUTE below.
--   *_mapping_missing / *_mapping_not_manual_override
--   *_attestation_missing (no sealed sidecar, or no active attestation now)
--   *_mapping_attestation_mismatch (current mapping vs current attestation)
--   *_attested_canonical_drift (current attestation vs sealed canonical)
--   *_attestation_generation_stale (sealed generation is no longer current)
--   fixture_competition_drift
-- ---------------------------------------------------------------------------

create or replace function public.match_ledger_provider_ref_conflicts_v2(p_provider text)
returns table (
  issue_code text,
  observation_id uuid,
  observation_version integer,
  is_current_version boolean,
  fixture_id uuid,
  provider_fixture_id text,
  ref_kind text,
  provider_ref text,
  recorded_canonical_id uuid,
  sealed_attestation_generation_id uuid,
  current_mapping_canonical_id uuid,
  current_mapping_status text,
  current_attested_canonical_id uuid,
  current_attestation_generation_id uuid
)
language sql
stable
set search_path = ''
as $$
  with versions as (
    select o.id, o.fixture_id, o.provider, o.provider_fixture_id, o.observation_version, o.observation_kind,
           o.observation_version = max(o.observation_version) over (partition by o.fixture_id) as is_current
    from public.match_ledger_observations o
    where o.provider = p_provider
  ),
  refs as (
    select ve.id, ve.fixture_id, ve.provider, ve.provider_fixture_id, ve.observation_version, ve.is_current,
           pr.ref_kind, pr.provider_ref, pr.canonical_id, sa.attestation_generation_id as sealed_generation,
           case when pr.ref_kind = 'league' then 'competition' else 'team' end as prefix
    from versions ve
    join public.match_ledger_observation_provider_refs pr on pr.observation_id = ve.id
    left join public.match_ledger_observation_identity_attestations sa
      on sa.observation_id = ve.id and sa.ref_kind = pr.ref_kind
    where ve.observation_kind = 'observation' and pr.ref_kind <> 'season'
  ),
  resolved as (
    select r.*,
           case when r.ref_kind = 'league' then cm.provider_competition_id is not null else tm.provider_team_id is not null end as has_mapping,
           coalesce(tm.team_id, cm.competition_id) as map_canonical,
           coalesce(tm.mapping_status, cm.mapping_status) as map_status,
           coalesce(ta.team_id, ca.competition_id) as att_canonical,
           coalesce(ta.attestation_generation_id, ca.attestation_generation_id) as att_generation
    from refs r
    left join public.provider_team_mappings tm
      on r.ref_kind in ('team_home', 'team_away') and tm.provider = r.provider and tm.provider_team_id = r.provider_ref
    left join public.provider_competition_mappings cm
      on r.ref_kind = 'league' and cm.provider = r.provider and cm.provider_competition_id = r.provider_ref
    left join private.provider_team_identity_attestations ta
      on r.ref_kind in ('team_home', 'team_away') and ta.provider = r.provider and ta.provider_team_id = r.provider_ref
    left join private.provider_competition_identity_attestations ca
      on r.ref_kind = 'league' and ca.provider = r.provider and ca.provider_competition_id = r.provider_ref
  ),
  issues as (
    select rs.prefix || '_mapping_missing' as code, rs.* from resolved rs where not rs.has_mapping
    union all
    select rs.prefix || '_mapping_not_manual_override', rs.* from resolved rs
    where rs.has_mapping and rs.map_status <> 'manual_override'
    union all
    select rs.prefix || '_attestation_missing', rs.* from resolved rs
    where rs.sealed_generation is null or rs.att_generation is null
    union all
    select rs.prefix || '_mapping_attestation_mismatch', rs.* from resolved rs
    where rs.has_mapping and rs.att_generation is not null and rs.map_canonical <> rs.att_canonical
    union all
    select rs.prefix || '_attested_canonical_drift', rs.* from resolved rs
    where rs.att_generation is not null and rs.att_canonical is distinct from rs.canonical_id
    union all
    select rs.prefix || '_attestation_generation_stale', rs.* from resolved rs
    where rs.sealed_generation is not null and rs.att_generation is not null and rs.att_generation <> rs.sealed_generation
    union all
    select 'fixture_competition_drift', rs.* from resolved rs
    join public.fixtures f on f.id = rs.fixture_id
    where rs.ref_kind = 'league' and f.competition_id is distinct from rs.canonical_id
  )
  select i.code, i.id, i.observation_version, i.is_current, i.fixture_id, i.provider_fixture_id, i.ref_kind,
         i.provider_ref, i.canonical_id, i.sealed_generation, i.map_canonical, i.map_status, i.att_canonical,
         i.att_generation
  from issues i
  order by i.fixture_id, i.observation_version, i.ref_kind, i.code
$$;

-- ---------------------------------------------------------------------------
-- Revocation impact (read only): what a (planned or done) revocation of one
-- provider team/competition ref touches, for the recovery runbook.
--   observation_under_generation  observation versions sealed under any
--                                 generation of the ref (state active/revoked),
--                                 with whether each is its chain's latest version
--   fixture_mapping               the provider fixture mappings of those chains
--   fixture_mint                  A2 fixture mints of those chains
--   unattested_observation        observations of the provider without a full
--                                 attestation sidecar that name the ref or one
--                                 of its attested canonical ids (refs-less and
--                                 direct 1A writes); V2 reads already exclude them
-- ---------------------------------------------------------------------------

create or replace function public.provider_identity_revocation_impact(
  p_provider text,
  p_entity_kind text,
  p_provider_ref text
)
returns table (
  impact_kind text,
  observation_id uuid,
  observation_version integer,
  is_latest_version boolean,
  latest_observation_kind text,
  fixture_id uuid,
  provider_fixture_id text,
  attestation_generation_id uuid,
  generation_state text,
  canonical_id uuid,
  detail jsonb
)
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_provider is null or p_provider_ref is null or p_entity_kind is null or p_entity_kind not in ('team', 'competition') then
    raise exception 'revocation impact needs a provider, an entity kind (team or competition) and a provider ref';
  end if;
  return query
  with generations as (
    select e.attestation_generation_id as generation, e.team_id as canonical, bool_or(e.event_kind = 'revoke') as revoked
    from private.provider_team_identity_attestation_events e
    where p_entity_kind = 'team' and e.provider = p_provider and e.provider_team_id = p_provider_ref
    group by e.attestation_generation_id, e.team_id
    union all
    select e.attestation_generation_id, e.competition_id, bool_or(e.event_kind = 'revoke')
    from private.provider_competition_identity_attestation_events e
    where p_entity_kind = 'competition' and e.provider = p_provider and e.provider_competition_id = p_provider_ref
    group by e.attestation_generation_id, e.competition_id
  ),
  kinds as (
    select unnest(case when p_entity_kind = 'team' then array['team_home', 'team_away'] else array['league'] end) as ref_kind
  ),
  latest as (
    select distinct on (o.fixture_id) o.fixture_id, o.observation_version, o.observation_kind
    from public.match_ledger_observations o
    where o.provider = p_provider
    order by o.fixture_id, o.observation_version desc
  ),
  sealed as (
    select distinct o.id, o.observation_version, o.fixture_id, o.provider_fixture_id, sa.attestation_generation_id as generation,
           l.observation_version = o.observation_version as is_latest, l.observation_kind as latest_kind
    from public.match_ledger_observation_identity_attestations sa
    join kinds k on k.ref_kind = sa.ref_kind
    join generations g on g.generation = sa.attestation_generation_id
    join public.match_ledger_observations o on o.id = sa.observation_id
    join latest l on l.fixture_id = o.fixture_id
  ),
  unattested as (
    select o.id, o.observation_version, o.fixture_id, o.provider_fixture_id,
           l.observation_version = o.observation_version as is_latest, l.observation_kind as latest_kind
    from public.match_ledger_observations o
    join latest l on l.fixture_id = o.fixture_id
    join public.fixtures f on f.id = o.fixture_id
    where o.provider = p_provider and o.observation_kind = 'observation'
      and (select count(*) from public.match_ledger_observation_identity_attestations sa where sa.observation_id = o.id) < 3
      and (
        exists (select 1 from public.match_ledger_observation_provider_refs pr join kinds k on k.ref_kind = pr.ref_kind
                where pr.observation_id = o.id and pr.provider_ref = p_provider_ref)
        or (p_entity_kind = 'team' and exists (
              select 1 from public.match_ledger_team_records tr join generations g on g.canonical = tr.team_id
              where tr.observation_id = o.id))
        or (p_entity_kind = 'competition' and exists (select 1 from generations g where g.canonical = f.competition_id))
      )
  )
  select 'observation_under_generation'::text, s.id, s.observation_version, s.is_latest, s.latest_kind, s.fixture_id,
         s.provider_fixture_id, s.generation, case when g.revoked then 'revoked' else 'active' end, g.canonical, '{}'::jsonb
  from sealed s
  join generations g on g.generation = s.generation
  union all
  select 'fixture_mapping', null::uuid, null::integer, null::boolean, null::text, m.fixture_id, m.provider_fixture_id,
         null::uuid, null::text, null::uuid,
         jsonb_build_object('mapping_status', m.mapping_status, 'mapping_confidence', m.mapping_confidence)
  from public.provider_fixture_mappings m
  where m.provider = p_provider and m.provider_fixture_id in (select s.provider_fixture_id from sealed s)
  union all
  select 'fixture_mint', null::uuid, null::integer, null::boolean, null::text, mi.fixture_id, mi.provider_fixture_id,
         null::uuid, null::text, null::uuid,
         jsonb_build_object('run_id', mi.run_id, 'minted_at', mi.minted_at)
  from public.match_ledger_fixture_mints mi
  where mi.provider = p_provider
    and (mi.provider_fixture_id in (select s.provider_fixture_id from sealed s) or mi.fixture_id in (select s.fixture_id from sealed s))
  union all
  select 'unattested_observation', u.id, u.observation_version, u.is_latest, u.latest_kind, u.fixture_id, u.provider_fixture_id,
         null::uuid, null::text, null::uuid, jsonb_build_object('excluded_by_v2_reads', true)
  from unattested u
  order by 1, 6, 3;
end;
$$;

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------

alter table private.provider_team_identity_attestation_events enable row level security;
alter table private.provider_competition_identity_attestation_events enable row level security;
alter table private.provider_team_identity_attestations enable row level security;
alter table private.provider_competition_identity_attestations enable row level security;
alter table public.match_ledger_observation_identity_attestations enable row level security;

-- Minimal table privileges. RLS is enabled but is NOT a control against
-- service_role (BYPASSRLS); the controls are these grants, the guard
-- triggers and immutability.
revoke all on table private.provider_team_identity_attestation_events from public, anon, authenticated, service_role;
revoke all on table private.provider_competition_identity_attestation_events from public, anon, authenticated, service_role;
revoke all on table private.provider_team_identity_attestations from public, anon, authenticated, service_role;
revoke all on table private.provider_competition_identity_attestations from public, anon, authenticated, service_role;
revoke all on table public.match_ledger_observation_identity_attestations from public, anon, authenticated, service_role;
grant select, insert on table private.provider_team_identity_attestation_events to service_role;
grant select, insert on table private.provider_competition_identity_attestation_events to service_role;
grant select, insert, update, delete on table private.provider_team_identity_attestations to service_role;
grant select, insert, update, delete on table private.provider_competition_identity_attestations to service_role;
grant select, insert on table public.match_ledger_observation_identity_attestations to service_role;

revoke all on function private.provider_identity_evidence_issue(jsonb) from public, anon, authenticated;
revoke all on function private.provider_identity_evidence_sha256(jsonb) from public, anon, authenticated;
revoke all on function private.lock_provider_identity(text, boolean) from public, anon, authenticated;
revoke all on function private.holds_provider_identity_lock(text, boolean) from public, anon, authenticated;
revoke all on function private.assert_provider_identity_attestation_write(text) from public, anon, authenticated;
revoke all on function private.provider_identity_assert_request(text, text, text) from public, anon, authenticated;
revoke all on function private.provider_identity_begin_change(text) from public, anon, authenticated;
revoke all on function private.stamp_provider_team_identity_attestation_event() from public, anon, authenticated;
revoke all on function private.stamp_provider_competition_identity_attestation_event() from public, anon, authenticated;
revoke all on function private.guard_provider_team_identity_attestation() from public, anon, authenticated;
revoke all on function private.guard_provider_competition_identity_attestation() from public, anon, authenticated;
revoke all on function private.check_match_ledger_observation_identity_attestation() from public, anon, authenticated;
revoke all on function private.provider_team_attestation_matches(text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function private.provider_competition_attestation_matches(text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function private.match_ledger_observation_attestation_issue(uuid) from public, anon, authenticated;
revoke all on function private.provider_ingest_fixture_candidates_v2(text, text, uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.match_ledger_team_match_stats_v2(text, uuid[], timestamptz, timestamptz, text, text) from public, anon, authenticated;
revoke all on function private.match_ledger_retrospective_exclusions_v2(text, uuid[], timestamptz, timestamptz, text) from public, anon, authenticated;

revoke all on function public.provider_identity_attest_team(jsonb) from public, anon, authenticated;
revoke all on function public.provider_identity_revoke_team(jsonb) from public, anon, authenticated;
revoke all on function public.provider_identity_attest_competition(jsonb) from public, anon, authenticated;
revoke all on function public.provider_identity_revoke_competition(jsonb) from public, anon, authenticated;
revoke all on function public.match_ledger_team_match_stats_as_of_v2(text, uuid[], timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.match_ledger_team_match_stats_for_training_v2(text, uuid[], timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.match_ledger_retrospective_training_exclusions_v2(text, uuid[], timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.provider_identity_attestation_conflicts(text) from public, anon, authenticated;
revoke all on function public.match_ledger_provider_ref_conflicts_v2(text) from public, anon, authenticated;
revoke all on function public.provider_identity_revocation_impact(text, text, text) from public, anon, authenticated;

-- V2 ingest is NOT enabled by M2A: revoked from every role, service_role
-- included (Supabase default privileges would otherwise grant it). Only the
-- separate grant-only M2B migration may grant it to service_role.
revoke all on function public.match_ledger_ingest_provider_fixture_v2(jsonb) from public, anon, authenticated, service_role;
-- V1 ingest stays permanently revoked (D-057, D-058).
revoke all on function public.match_ledger_ingest_provider_fixture(jsonb) from service_role;

-- V1 reads and reports whose trust semantics would now mislead: present for
-- contract/history inspection, not executable by service_role. The Stage 1
-- historical path is the V2 functions.
revoke all on function public.match_ledger_provider_ref_conflicts(text) from service_role;
revoke all on function public.match_ledger_team_match_stats_as_of(text, uuid[], timestamptz, timestamptz) from service_role;
revoke all on function public.match_ledger_team_match_stats_for_training(text, uuid[], timestamptz, timestamptz, text) from service_role;
revoke all on function public.match_ledger_retrospective_training_exclusions(text, uuid[], timestamptz, timestamptz, text) from service_role;

grant execute on function public.provider_identity_attest_team(jsonb) to service_role;
grant execute on function public.provider_identity_revoke_team(jsonb) to service_role;
grant execute on function public.provider_identity_attest_competition(jsonb) to service_role;
grant execute on function public.provider_identity_revoke_competition(jsonb) to service_role;
grant execute on function public.match_ledger_team_match_stats_as_of_v2(text, uuid[], timestamptz, timestamptz) to service_role;
grant execute on function public.match_ledger_team_match_stats_for_training_v2(text, uuid[], timestamptz, timestamptz, text) to service_role;
grant execute on function public.match_ledger_retrospective_training_exclusions_v2(text, uuid[], timestamptz, timestamptz, text) to service_role;
grant execute on function public.provider_identity_attestation_conflicts(text) to service_role;
grant execute on function public.match_ledger_provider_ref_conflicts_v2(text) to service_role;
grant execute on function public.provider_identity_revocation_impact(text, text, text) to service_role;
-- Called by name from the invoker functions and triggers above.
grant execute on function private.provider_identity_evidence_issue(jsonb) to service_role;
grant execute on function private.provider_identity_evidence_sha256(jsonb) to service_role;
grant execute on function private.lock_provider_identity(text, boolean) to service_role;
grant execute on function private.holds_provider_identity_lock(text, boolean) to service_role;
grant execute on function private.assert_provider_identity_attestation_write(text) to service_role;
grant execute on function private.provider_identity_assert_request(text, text, text) to service_role;
grant execute on function private.provider_identity_begin_change(text) to service_role;
grant execute on function private.provider_team_attestation_matches(text, text, uuid, uuid) to service_role;
grant execute on function private.provider_competition_attestation_matches(text, text, uuid, uuid) to service_role;
grant execute on function private.match_ledger_observation_attestation_issue(uuid) to service_role;
grant execute on function private.provider_ingest_fixture_candidates_v2(text, text, uuid, uuid, uuid, timestamptz) to service_role;
grant execute on function private.match_ledger_team_match_stats_v2(text, uuid[], timestamptz, timestamptz, text, text) to service_role;
grant execute on function private.match_ledger_retrospective_exclusions_v2(text, uuid[], timestamptz, timestamptz, text) to service_role;

comment on table private.provider_team_identity_attestations is
  'Current V4 team identity attestations (D-058): one active attestation per provider team id and per canonical team. Changed only by the attest/revoke RPCs; equals its latest event.';
comment on table private.provider_competition_identity_attestations is
  'Current V4 competition identity attestations (D-058): one active attestation per provider league id and per canonical competition. Changed only by the attest/revoke RPCs; equals its latest event.';
comment on table private.provider_team_identity_attestation_events is
  'Immutable team attestation history: attest opens a generation, evidence_refresh continues it, revoke closes it; versions are monotonic per provider team id. Canonical ids are kept without a foreign key.';
comment on table private.provider_competition_identity_attestation_events is
  'Immutable competition attestation history: attest opens a generation, evidence_refresh continues it, revoke closes it; versions are monotonic per provider league id.';
comment on table public.match_ledger_observation_identity_attestations is
  'The exact attestation event and generation each V2-ingested observation version used for its league/home/away identity. Typed foreign keys, integrity-checked, sealed to the writing statement, inserted only by V2 ingest, immutable. Plain 1A writes have none and are excluded by the V2 reads.';
comment on function public.match_ledger_ingest_provider_fixture_v2(jsonb) is
  'V2 provider-native ingest (D-058): attestation trust, mandatory run allowlist, full fixture classification for existing mappings, sealed attestation provenance. Not executable by service_role until M2B.';
