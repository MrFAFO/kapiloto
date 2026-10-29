-- Kapiloto V4 Foundation 1D: Prediction Registry V2 (team-scoped lineup
-- forecasts with frozen 1C inputs).
--
-- Additive. The applied 1A/1B/1C migrations are not modified. V1 behavior is
-- preserved exactly:
--   * kapiloto-prediction-snapshot-v1 rows keep their meaning: every existing
--     row becomes prediction_kind = 'match_outcome' with no subject team, and
--     the 1/X/2 rule for match outcomes is unchanged;
--   * public.prediction_record_snapshot (V1 RPC), the V1 canonical input
--     bundle and the output hash function are not modified, so V1 input and
--     output hashes are byte-for-byte identical (golden tests);
--   * the commit-time bundle check keeps the V1 branch verbatim and adds a V2
--     branch.
--
-- V2 (kapiloto-prediction-snapshot-v2) adds:
--   * prediction_kind: 'match_outcome' (1/X/2 rule) or 'lineup_forecast'
--     (no 1/X/2, team-scoped by subject_team_id, lineup_estimate required);
--   * frozen 1C inputs: exact roster memberships, coach tenures and one
--     squad-state reconstruction context (versions, provider priority,
--     history window, SHA-256 of the derived squad state);
--   * version-specific canonicalization (V1 families + memberships + tenures +
--     squad_state_context) and public.prediction_record_snapshot_v2.

-- ---------------------------------------------------------------------------
-- prediction_snapshots: kind and subject team (backwards compatible)
-- ---------------------------------------------------------------------------

alter table public.prediction_snapshots
  add column prediction_kind text not null default 'match_outcome',
  add column subject_team_id uuid references public.teams(id) on delete restrict;

-- Widen the contract and replace the 1/X/2 rule with a kind-aware rule whose
-- match_outcome branch is the original rule verbatim.
alter table public.prediction_snapshots drop constraint prediction_snapshots_contract_version_check;
alter table public.prediction_snapshots drop constraint prediction_snapshots_check;

alter table public.prediction_snapshots
  add constraint prediction_snapshots_contract_version_check
    check (contract_version in ('kapiloto-prediction-snapshot-v1', 'kapiloto-prediction-snapshot-v2')),
  add constraint prediction_snapshots_prediction_kind_check
    check (prediction_kind in ('match_outcome', 'lineup_forecast')),
  add constraint prediction_snapshots_v1_kind_check
    check (contract_version <> 'kapiloto-prediction-snapshot-v1'
      or (prediction_kind = 'match_outcome' and subject_team_id is null)),
  add constraint prediction_snapshots_kind_outcome_check
    check (
      (prediction_kind = 'match_outcome' and subject_team_id is null and (
        (outcome = 'predicted'
          and p_1_bp is not null and p_x_bp is not null and p_2_bp is not null
          and p_1_bp + p_x_bp + p_2_bp = 10000
          and abstain_reason is null)
        or (outcome = 'abstained'
          and p_1_bp is null and p_x_bp is null and p_2_bp is null
          and abstain_reason is not null)))
      or (prediction_kind = 'lineup_forecast' and subject_team_id is not null
        and p_1_bp is null and p_x_bp is null and p_2_bp is null and (
        (outcome = 'predicted' and abstain_reason is null and payload ? 'lineup_estimate')
        or (outcome = 'abstained' and abstain_reason is not null)))
    );

comment on column public.prediction_snapshots.prediction_kind is
  'match_outcome (1/X/2; every V1 row) or lineup_forecast (V2 only, team-scoped, no 1/X/2).';
comment on column public.prediction_snapshots.subject_team_id is
  'The team a lineup_forecast is about (home or away of the fixture); null for match_outcome. Frozen forever.';

-- A subject team must play the fixture.
create or replace function private.validate_prediction_subject_team()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.subject_team_id is not null and not exists (
    select 1 from public.fixtures f
    where f.id = new.fixture_id
      and new.subject_team_id in (f.home_team_id, f.away_team_id)
  ) then
    raise exception 'subject team % does not play fixture %', new.subject_team_id, new.fixture_id;
  end if;
  return new;
end;
$$;

create trigger prediction_snapshots_subject_team
before insert on public.prediction_snapshots
for each row execute function private.validate_prediction_subject_team();

-- ---------------------------------------------------------------------------
-- Frozen 1C inputs
-- ---------------------------------------------------------------------------

create table public.prediction_membership_inputs (
  snapshot_id uuid not null references public.prediction_snapshots(id) on delete restrict,
  membership_id uuid not null references public.team_player_memberships(id) on delete restrict,
  input_role text not null check (input_role ~ '^[a-z][a-z0-9_]{1,62}$'),
  input_first_seen_at timestamptz not null,
  primary key (snapshot_id, membership_id)
);

create table public.prediction_tenure_inputs (
  snapshot_id uuid not null references public.prediction_snapshots(id) on delete restrict,
  tenure_id uuid not null references public.team_coach_tenures(id) on delete restrict,
  input_role text not null check (input_role ~ '^[a-z][a-z0-9_]{1,62}$'),
  input_first_seen_at timestamptz not null,
  primary key (snapshot_id, tenure_id)
);

-- Everything needed to reconstruct the exact 1C squad state a lineup forecast
-- consumed: contract/builder/policy versions, the explicit provider priority
-- and history window, and the SHA-256 of the derived state. The state itself
-- is reproducible from the frozen input links plus these values.
create table public.prediction_squad_state_context (
  snapshot_id uuid primary key references public.prediction_snapshots(id) on delete restrict,
  subject_team_id uuid not null references public.teams(id) on delete restrict,
  squad_state_inputs_contract text not null
    check (squad_state_inputs_contract in ('kapiloto-squad-state-inputs-v1')),
  squad_state_contract text not null check (squad_state_contract in ('kapiloto-squad-state-v1')),
  squad_state_builder_version text not null
    check (squad_state_builder_version in ('kapiloto-squad-state-builder-v1')),
  squad_features_version text not null check (squad_features_version in ('kapiloto-squad-features-v1')),
  history_selection_policy_version text not null
    check (history_selection_policy_version in ('kapiloto-history-selection-v1')),
  availability_normalization_version text not null
    check (availability_normalization_version in ('kapiloto-availability-normalization-v1')),
  target_date_policy text not null check (target_date_policy in ('kapiloto-target-date-utc-v1')),
  provider_priority text[] not null check (cardinality(provider_priority) between 1 and 20),
  history_max_fixtures smallint not null check (history_max_fixtures between 1 and 10),
  squad_state_sha256 text not null check (squad_state_sha256 ~ '^[0-9a-f]{64}$')
);

-- V2 input families: sealed to the snapshot's statement, V2 only, never first
-- seen after the cutoff, and scoped to the subject team (lineup forecasts) or
-- the fixture's teams (match outcomes).
create or replace function private.prepare_prediction_v2_input()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_snapshot public.prediction_snapshots%rowtype;
  v_team uuid;
  v_seen timestamptz;
  v_status text;
  v_superseded boolean;
  v_fixture_teams uuid[];
begin
  select s.* into v_snapshot from public.prediction_snapshots s where s.id = new.snapshot_id;
  if not found then
    raise exception 'prediction snapshot % not found', new.snapshot_id;
  end if;
  if v_snapshot.ingest_statement_at <> statement_timestamp() then
    raise exception 'prediction snapshot % is sealed', new.snapshot_id;
  end if;
  if v_snapshot.contract_version <> 'kapiloto-prediction-snapshot-v2' then
    raise exception '% rows belong to V2 snapshots only', tg_table_name;
  end if;
  select array[f.home_team_id, f.away_team_id] into v_fixture_teams
  from public.fixtures f where f.id = v_snapshot.fixture_id;

  if tg_table_name = 'prediction_squad_state_context' then
    if v_snapshot.prediction_kind <> 'lineup_forecast' then
      raise exception 'only lineup forecasts carry a squad-state context';
    end if;
    if new.subject_team_id is distinct from v_snapshot.subject_team_id then
      raise exception 'squad-state context team does not match the snapshot subject team';
    end if;
    if exists (select 1 from unnest(new.provider_priority) p where p !~ '^[a-z0-9_]{1,40}$')
      or cardinality(array(select distinct unnest(new.provider_priority))) <> cardinality(new.provider_priority) then
      raise exception 'provider priority must list distinct provider keys';
    end if;
    return new;
  end if;

  if tg_table_name = 'prediction_membership_inputs' then
    select m.team_id, m.first_seen_at, m.assertion_status into v_team, v_seen, v_status
    from public.team_player_memberships m where m.id = new.membership_id;
    v_superseded := exists (
      select 1 from public.team_player_memberships m
      join public.team_player_memberships n
        on n.membership_key = m.membership_key and n.membership_version > m.membership_version
      where m.id = new.membership_id and n.first_seen_at <= v_snapshot.research_cutoff_at
    );
  else
    select t.team_id, t.first_seen_at, t.assertion_status into v_team, v_seen, v_status
    from public.team_coach_tenures t where t.id = new.tenure_id;
    v_superseded := exists (
      select 1 from public.team_coach_tenures t
      join public.team_coach_tenures n
        on n.tenure_key = t.tenure_key and n.tenure_version > t.tenure_version
      where t.id = new.tenure_id and n.first_seen_at <= v_snapshot.research_cutoff_at
    );
  end if;
  if v_seen is null then
    raise exception '% input not found', tg_table_name;
  end if;
  if v_seen > v_snapshot.research_cutoff_at then
    raise exception '% input was first seen after the prediction cutoff', tg_table_name;
  end if;
  if v_snapshot.prediction_kind = 'lineup_forecast' then
    if v_team is distinct from v_snapshot.subject_team_id then
      raise exception '% input belongs to another team than the subject team', tg_table_name;
    end if;
    -- Only what the as-of read could return: the latest version visible at
    -- the cutoff, and not a retraction.
    if v_superseded then
      raise exception '% input was superseded before the prediction cutoff', tg_table_name;
    end if;
    if v_status <> 'asserted' then
      raise exception '% input is a retracted assertion', tg_table_name;
    end if;
    if tg_table_name = 'prediction_membership_inputs' and new.input_role <> 'squad_membership' then
      raise exception 'lineup forecast membership inputs use role squad_membership';
    end if;
    if tg_table_name = 'prediction_tenure_inputs' and new.input_role <> 'squad_coach_tenure' then
      raise exception 'lineup forecast tenure inputs use role squad_coach_tenure';
    end if;
  elsif not (v_team = any (v_fixture_teams)) then
    raise exception '% input belongs to a team outside the fixture', tg_table_name;
  end if;
  new.input_first_seen_at := v_seen;
  return new;
end;
$$;

create trigger prediction_membership_inputs_prepare
before insert on public.prediction_membership_inputs
for each row execute function private.prepare_prediction_v2_input();

create trigger prediction_tenure_inputs_prepare
before insert on public.prediction_tenure_inputs
for each row execute function private.prepare_prediction_v2_input();

create trigger prediction_squad_state_context_prepare
before insert on public.prediction_squad_state_context
for each row execute function private.prepare_prediction_v2_input();

-- Lineup forecasts consume 1C squad inputs only: ledger history of the
-- subject team (never the target fixture) and target-fixture claims about
-- this team, with explicit squad roles. Runs after the 1B leakage checks.
-- A history input must be what squad_state_inputs_as_of could return at the
-- cutoff: the latest visible version for its (fixture, provider), a finished
-- observation (not a withdrawal), kicking off before the target fixture.
create or replace function private.check_prediction_lineup_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_snapshot public.prediction_snapshots%rowtype;
  v_claim public.knowledge_claims%rowtype;
  v_observation public.match_ledger_observations%rowtype;
  v_fixture uuid;
  v_target_kickoff timestamptz;
begin
  select s.* into v_snapshot from public.prediction_snapshots s where s.id = new.snapshot_id;
  if not found or v_snapshot.prediction_kind <> 'lineup_forecast' then
    return new;
  end if;

  if tg_table_name = 'prediction_ledger_inputs' then
    if new.input_role not in ('squad_history_selected', 'squad_history_alternative') then
      raise exception 'lineup forecast ledger inputs use roles squad_history_selected or squad_history_alternative';
    end if;
    select o.* into v_observation
    from public.match_ledger_observations o where o.id = new.ledger_observation_id;
    v_fixture := v_observation.fixture_id;
    if v_fixture = v_snapshot.fixture_id then
      raise exception 'the target fixture''s own ledger data cannot be squad history';
    end if;
    if v_observation.observation_kind <> 'observation' or v_observation.match_status is distinct from 'finished' then
      raise exception 'squad history input % is not a finished match observation', new.ledger_observation_id;
    end if;
    select coalesce(f.actual_kickoff_at, f.kickoff_at) into v_target_kickoff
    from public.fixtures f where f.id = v_snapshot.fixture_id;
    if v_observation.kickoff_at >= v_target_kickoff then
      raise exception 'squad history input % does not precede the target fixture', new.ledger_observation_id;
    end if;
    if exists (
      select 1 from public.match_ledger_observations n
      where n.fixture_id = v_observation.fixture_id
        and n.provider = v_observation.provider
        and n.observation_version > v_observation.observation_version
        and n.first_seen_at <= v_snapshot.research_cutoff_at
    ) then
      raise exception 'squad history input % was superseded before the prediction cutoff', new.ledger_observation_id;
    end if;
    if not exists (
      select 1 from public.match_ledger_team_records tr
      where tr.observation_id = new.ledger_observation_id
        and tr.team_id = v_snapshot.subject_team_id
    ) then
      raise exception 'ledger input % does not involve the subject team', new.ledger_observation_id;
    end if;
  elsif tg_table_name = 'prediction_claim_inputs' then
    select c.* into v_claim from public.knowledge_claims c where c.id = new.claim_id;
    if v_claim.fixture_id is distinct from v_snapshot.fixture_id
      or (v_claim.team_id is not null and v_claim.team_id <> v_snapshot.subject_team_id) then
      raise exception 'lineup forecast claims must be target-fixture claims about the subject team';
    end if;
    if not (
      (v_claim.claim_type = 'player_availability' and new.input_role = 'squad_availability_claim')
      or (v_claim.claim_type = 'expected_lineup' and new.input_role = 'squad_lineup_claim')
    ) then
      raise exception 'lineup forecast claim inputs use squad_availability_claim or squad_lineup_claim by claim type';
    end if;
    -- The belief the as-of read returns: the latest resolution version first
    -- seen at the cutoff (or none only if the claim had none by then).
    if new.resolution_id is null then
      if exists (
        select 1 from public.knowledge_claim_resolutions r
        where r.claim_id = new.claim_id and r.first_seen_at <= v_snapshot.research_cutoff_at
      ) then
        raise exception 'claim % was resolved before the prediction cutoff; freeze that resolution', new.claim_id;
      end if;
    elsif exists (
      select 1 from public.knowledge_claim_resolutions cur
      join public.knowledge_claim_resolutions r
        on r.claim_id = cur.claim_id and r.resolution_version > cur.resolution_version
      where cur.id = new.resolution_id and r.first_seen_at <= v_snapshot.research_cutoff_at
    ) then
      raise exception 'claim % resolution was superseded before the prediction cutoff', new.claim_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger prediction_ledger_inputs_v2_scope
before insert on public.prediction_ledger_inputs
for each row execute function private.check_prediction_lineup_scope();

create trigger prediction_claim_inputs_v2_scope
before insert on public.prediction_claim_inputs
for each row execute function private.check_prediction_lineup_scope();

create trigger prediction_membership_inputs_immutable
before update or delete on public.prediction_membership_inputs
for each row execute function private.kapiloto_v4_reject_change();
create trigger prediction_membership_inputs_no_truncate
before truncate on public.prediction_membership_inputs
for each statement execute function private.kapiloto_v4_reject_change();

create trigger prediction_tenure_inputs_immutable
before update or delete on public.prediction_tenure_inputs
for each row execute function private.kapiloto_v4_reject_change();
create trigger prediction_tenure_inputs_no_truncate
before truncate on public.prediction_tenure_inputs
for each statement execute function private.kapiloto_v4_reject_change();

create trigger prediction_squad_state_context_immutable
before update or delete on public.prediction_squad_state_context
for each row execute function private.kapiloto_v4_reject_change();
create trigger prediction_squad_state_context_no_truncate
before truncate on public.prediction_squad_state_context
for each statement execute function private.kapiloto_v4_reject_change();

-- ---------------------------------------------------------------------------
-- V2 canonical input bundle: V1 families (V1 canonicalization, unchanged)
-- plus memberships, tenures and the squad-state context.
-- ---------------------------------------------------------------------------

create or replace function private.prediction_canonical_inputs_v2(p_inputs jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_inputs jsonb := coalesce(p_inputs, '{}'::jsonb);
  v_context jsonb := v_inputs->'squad_state_context';
begin
  perform private.kapiloto_v4_assert_keys(v_inputs, array[
    'ledger', 'documents', 'claims', 'claim_observations', 'references', 'identities',
    'memberships', 'tenures', 'squad_state_context'
  ], 'prediction inputs');
  perform private.kapiloto_v4_assert_keys(coalesce(v_inputs->'memberships', '[]'::jsonb),
    array['membership_id', 'input_role'], 'membership input');
  perform private.kapiloto_v4_assert_keys(coalesce(v_inputs->'tenures', '[]'::jsonb),
    array['tenure_id', 'input_role'], 'tenure input');
  if v_context is not null and jsonb_typeof(v_context) not in ('null', 'object') then
    raise exception 'squad-state context must be an object or null';
  end if;
  if v_context is not null and jsonb_typeof(v_context) <> 'null' then
    perform private.kapiloto_v4_assert_keys(v_context, array[
      'subject_team_id', 'squad_state_inputs_contract', 'squad_state_contract',
      'squad_state_builder_version', 'squad_features_version',
      'history_selection_policy_version', 'availability_normalization_version',
      'target_date_policy', 'provider_priority', 'history_max_fixtures', 'squad_state_sha256'
    ], 'squad-state context');
  end if;

  return private.prediction_canonical_inputs(v_inputs - array['memberships', 'tenures', 'squad_state_context'])
    || jsonb_build_object(
      'memberships', coalesce((
        select jsonb_agg(e order by e::text) from (
          select jsonb_build_object('membership_id', x.membership_id, 'input_role', coalesce(x.input_role, 'squad_membership')) as e
          from jsonb_to_recordset(coalesce(v_inputs->'memberships', '[]'::jsonb)) as x(membership_id uuid, input_role text)
        ) s), '[]'::jsonb),
      'tenures', coalesce((
        select jsonb_agg(e order by e::text) from (
          select jsonb_build_object('tenure_id', x.tenure_id, 'input_role', coalesce(x.input_role, 'squad_coach_tenure')) as e
          from jsonb_to_recordset(coalesce(v_inputs->'tenures', '[]'::jsonb)) as x(tenure_id uuid, input_role text)
        ) s), '[]'::jsonb),
      'squad_state_context', (
        select jsonb_build_object(
          'subject_team_id', c.subject_team_id,
          'squad_state_inputs_contract', c.squad_state_inputs_contract,
          'squad_state_contract', c.squad_state_contract,
          'squad_state_builder_version', c.squad_state_builder_version,
          'squad_features_version', c.squad_features_version,
          'history_selection_policy_version', c.history_selection_policy_version,
          'availability_normalization_version', c.availability_normalization_version,
          'target_date_policy', c.target_date_policy,
          'provider_priority', to_jsonb(c.provider_priority),
          'history_max_fixtures', c.history_max_fixtures,
          'squad_state_sha256', c.squad_state_sha256
        )
        from jsonb_to_record(v_context) as c(
          subject_team_id uuid, squad_state_inputs_contract text, squad_state_contract text,
          squad_state_builder_version text, squad_features_version text,
          history_selection_policy_version text, availability_normalization_version text,
          target_date_policy text, provider_priority text[], history_max_fixtures smallint,
          squad_state_sha256 text
        )
        where jsonb_typeof(v_context) = 'object'
      )
    );
end;
$$;

create or replace function private.prediction_input_bundle_sha256_v2(p_inputs jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(private.prediction_canonical_inputs_v2(p_inputs)::text, 'UTF8')), 'hex')
$$;

-- Commit-time bundle verification, dispatched by contract version. The V1
-- branch is the unchanged 1B logic; V2 adds the 1C families and verifies the
-- lineup payload against its frozen squad-state context.
create or replace function private.check_prediction_input_bundle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_inputs jsonb;
  v_hash text;
  v_context public.prediction_squad_state_context%rowtype;
  v_missing uuid;
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

  if new.contract_version = 'kapiloto-prediction-snapshot-v1' then
    -- Exactly the 1B canonicalization: V1 hashes never change.
    v_hash := private.prediction_input_bundle_sha256(v_inputs);
  else
    v_inputs := v_inputs || jsonb_build_object(
      'memberships', coalesce((
        select jsonb_agg(jsonb_build_object('membership_id', i.membership_id, 'input_role', i.input_role))
        from public.prediction_membership_inputs i where i.snapshot_id = new.id), '[]'::jsonb),
      'tenures', coalesce((
        select jsonb_agg(jsonb_build_object('tenure_id', i.tenure_id, 'input_role', i.input_role))
        from public.prediction_tenure_inputs i where i.snapshot_id = new.id), '[]'::jsonb),
      'squad_state_context', (
        select to_jsonb(c) - 'snapshot_id'
        from public.prediction_squad_state_context c where c.snapshot_id = new.id)
    );
    v_hash := private.prediction_input_bundle_sha256_v2(v_inputs);

    select c.* into v_context from public.prediction_squad_state_context c where c.snapshot_id = new.id;
    if new.prediction_kind = 'lineup_forecast' then
      if v_context.snapshot_id is null then
        raise exception 'lineup forecast % has no squad-state context', new.id;
      end if;
      -- Any stored lineup estimate (predicted, or kept on an abstention) must
      -- describe this fixture, this team and the frozen squad state.
      if new.payload ? 'lineup_estimate' then
        if new.payload->'lineup_estimate'->>'fixture_id' is distinct from new.fixture_id::text then
          raise exception 'lineup estimate fixture does not match the snapshot';
        end if;
        if new.payload->'lineup_estimate'->>'subject_team_id' is distinct from new.subject_team_id::text then
          raise exception 'lineup estimate subject team does not match the snapshot';
        end if;
        if new.payload->'lineup_estimate'->>'squad_state_sha256' is distinct from v_context.squad_state_sha256 then
          raise exception 'lineup estimate squad-state hash does not match its frozen context';
        end if;
        if new.outcome = 'predicted' and new.payload->'lineup_estimate'->>'status' is distinct from 'projected' then
          raise exception 'a predicted lineup forecast must carry a projected lineup estimate';
        end if;
        if jsonb_typeof(new.payload->'lineup_estimate'->'players') is distinct from 'array' then
          raise exception 'lineup estimate players must be an array';
        end if;
        -- Every player in the output is bound to the canonical id the model used.
        select (p->>'canonical_player_id')::uuid into v_missing
        from jsonb_array_elements(new.payload->'lineup_estimate'->'players') p
        where p->>'canonical_player_id' is null or not exists (
          select 1 from public.prediction_identity_bindings b
          where b.snapshot_id = new.id and b.player_id = (p->>'canonical_player_id')::uuid
        )
        limit 1;
        if found then
          raise exception 'lineup estimate player % has no identity binding', coalesce(v_missing::text, '(missing id)');
        end if;
      end if;
    elsif v_context.snapshot_id is not null then
      raise exception 'only lineup forecasts carry a squad-state context';
    end if;
  end if;

  if v_hash <> new.input_bundle_sha256 then
    raise exception 'prediction % input links do not match its input bundle hash', new.id;
  end if;
  return null;
end;
$$;

-- Records a kapiloto-prediction-snapshot-v2: V1's atomic, fail-closed recording
-- plus prediction_kind, subject_team_id and the frozen 1C input families.
-- The V1 RPC above is unchanged and keeps accepting only V1.
create or replace function public.prediction_record_snapshot_v2(p_snapshot jsonb)
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
  if p_snapshot->>'contract_version' is distinct from 'kapiloto-prediction-snapshot-v2' then
    raise exception 'unsupported prediction snapshot contract';
  end if;
  perform private.kapiloto_v4_assert_keys(p_snapshot, array[
    'contract_version', 'idempotency_key', 'fixture_id', 'round_game_id',
    'prediction_kind', 'subject_team_id',
    'purpose', 'prediction_protocol_version', 'pipeline_version',
    'code_revision', 'model_identifiers', 'prompt_hashes', 'feature_versions',
    'derivation_version', 'calibration_version', 'settlement_rule',
    'research_cutoff_at', 'kickoff_at_snapshot', 'generated_at', 'outcome',
    'abstain_reason', 'p_1_bp', 'p_x_bp', 'p_2_bp', 'reliability',
    'uncertainty', 'payload_schema_version', 'payload', 'inputs'
  ], 'prediction snapshot');

  select * into v
  from jsonb_to_record(p_snapshot) as s(
    idempotency_key text, fixture_id uuid, round_game_id uuid,
    prediction_kind text, subject_team_id uuid, purpose text,
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

  v_inputs := private.prediction_canonical_inputs_v2(p_snapshot->'inputs');
  if exists (
    select 1 from jsonb_array_elements(v_inputs->'identities') b
    where b->>'entity_type' = 'team' and b->>'observed_entity_id' is not null
  ) then
    raise exception 'team identity bindings have no observed id';
  end if;
  v_bundle_sha := private.prediction_input_bundle_sha256_v2(v_inputs);
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
        v_existing.prediction_kind, v_existing.subject_team_id,
        v_existing.prediction_protocol_version, v_existing.pipeline_version,
        v_existing.code_revision, v_existing.model_identifiers,
        v_existing.prompt_hashes, v_existing.feature_versions,
        v_existing.derivation_version, v_existing.calibration_version,
        v_existing.settlement_rule, v_existing.research_cutoff_at,
        v_existing.kickoff_at_snapshot, v_existing.generated_at
      ) is not distinct from (
        v.fixture_id, v.round_game_id, v.purpose,
        v.prediction_kind, v.subject_team_id,
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
    contract_version, idempotency_key, fixture_id, round_game_id,
    prediction_kind, subject_team_id, purpose,
    prediction_protocol_version, pipeline_version, code_revision,
    model_identifiers, prompt_hashes, feature_versions, derivation_version,
    calibration_version, settlement_rule, research_cutoff_at,
    kickoff_at_snapshot, generated_at, outcome, abstain_reason, p_1_bp,
    p_x_bp, p_2_bp, reliability, uncertainty, payload_schema_version, payload,
    input_bundle_sha256, output_bundle_sha256
  )
  values (
    'kapiloto-prediction-snapshot-v2', v.idempotency_key, v.fixture_id,
    v.round_game_id, v.prediction_kind, v.subject_team_id, v.purpose, v.prediction_protocol_version,
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

  insert into public.prediction_membership_inputs (snapshot_id, membership_id, input_role, input_first_seen_at)
  select v_id, x.membership_id, x.input_role, v_first_seen
  from jsonb_to_recordset(v_inputs->'memberships') as x(membership_id uuid, input_role text);

  insert into public.prediction_tenure_inputs (snapshot_id, tenure_id, input_role, input_first_seen_at)
  select v_id, x.tenure_id, x.input_role, v_first_seen
  from jsonb_to_recordset(v_inputs->'tenures') as x(tenure_id uuid, input_role text);

  insert into public.prediction_squad_state_context (
    snapshot_id, subject_team_id, squad_state_inputs_contract, squad_state_contract,
    squad_state_builder_version, squad_features_version,
    history_selection_policy_version, availability_normalization_version,
    target_date_policy, provider_priority, history_max_fixtures, squad_state_sha256
  )
  select
    v_id, c.subject_team_id, c.squad_state_inputs_contract, c.squad_state_contract,
    c.squad_state_builder_version, c.squad_features_version,
    c.history_selection_policy_version, c.availability_normalization_version,
    c.target_date_policy, c.provider_priority, c.history_max_fixtures, c.squad_state_sha256
  from jsonb_to_record(v_inputs->'squad_state_context') as c(
    subject_team_id uuid, squad_state_inputs_contract text, squad_state_contract text,
    squad_state_builder_version text, squad_features_version text,
    history_selection_policy_version text, availability_normalization_version text,
    target_date_policy text, provider_priority text[], history_max_fixtures smallint,
    squad_state_sha256 text
  )
  where jsonb_typeof(v_inputs->'squad_state_context') = 'object';

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
-- Security: server/service_role only
-- ---------------------------------------------------------------------------

alter table public.prediction_membership_inputs enable row level security;
alter table public.prediction_tenure_inputs enable row level security;
alter table public.prediction_squad_state_context enable row level security;

revoke all on table public.prediction_membership_inputs from public, anon, authenticated;
revoke all on table public.prediction_tenure_inputs from public, anon, authenticated;
revoke all on table public.prediction_squad_state_context from public, anon, authenticated;

revoke all on function private.validate_prediction_subject_team() from public, anon, authenticated;
revoke all on function private.prepare_prediction_v2_input() from public, anon, authenticated;
revoke all on function private.check_prediction_lineup_scope() from public, anon, authenticated;
revoke all on function private.prediction_canonical_inputs_v2(jsonb) from public, anon, authenticated;
revoke all on function private.prediction_input_bundle_sha256_v2(jsonb) from public, anon, authenticated;
revoke all on function public.prediction_record_snapshot_v2(jsonb) from public, anon, authenticated;

-- The V2 RPC and the commit-time check run as the invoking service_role and
-- call these helpers by name.
grant execute on function private.prediction_canonical_inputs_v2(jsonb) to service_role;
grant execute on function private.prediction_input_bundle_sha256_v2(jsonb) to service_role;
grant execute on function public.prediction_record_snapshot_v2(jsonb) to service_role;

comment on table public.prediction_membership_inputs is
  'Exact roster-membership assertion versions a V2 prediction used (frozen; never first seen after the cutoff).';
comment on table public.prediction_tenure_inputs is
  'Exact coach-tenure assertion versions a V2 prediction used (frozen; never first seen after the cutoff).';
comment on table public.prediction_squad_state_context is
  'Versions, provider priority, history window and SHA-256 needed to reconstruct the exact 1C squad state a lineup forecast consumed.';
