-- Research v3 publication fields: grounded predicted lineups, compact
-- tactical facts, descriptive matchups and dated regime changes.
-- V1/V2 rows remain null/empty and all published rows remain immutable.

alter table public.kapiloto_analyses
  add column if not exists expected_lineups jsonb,
  add column if not exists tactical_facts jsonb,
  add column if not exists matchup_analysis jsonb,
  add column if not exists regime_changes jsonb;

alter table public.kapiloto_factors
  add column if not exists matchup_ids jsonb not null default '[]'::jsonb;

update public.kapiloto_source_registry
set tier_by_claim_type =
  tier_by_claim_type ||
  jsonb_build_object(
    'lineup', coalesce(tier_by_claim_type -> 'availability', tier_by_claim_type -> 'default', '4'::jsonb),
    'formation', coalesce(tier_by_claim_type -> 'tactical', tier_by_claim_type -> 'default', '4'::jsonb),
    'tactical_setup', coalesce(tier_by_claim_type -> 'tactical', tier_by_claim_type -> 'default', '4'::jsonb),
    'coach_regime', coalesce(tier_by_claim_type -> 'club_coach_news', tier_by_claim_type -> 'default', '4'::jsonb)
  );

-- Atomic materialization of one fully validated Kapiloto run.
-- The application performs schema validation, grounding and deterministic
-- derivation first; this RPC persists the complete immutable graph and then
-- flips round/fixture publication pointers in one transaction.

create or replace function public.kapiloto_materialize_and_complete_run(
  p_run_id uuid,
  p_analyses jsonb,
  p_round_synthesis jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.kapiloto_research_runs%rowtype;
  v_item jsonb;
  v_evidence jsonb;
  v_factor jsonb;
  v_input jsonb;
  v_model_evidence_id text;
  v_analysis_id uuid;
  v_factor_id uuid;
  v_evidence_id uuid;
  v_outcome text;
  v_count integer;
  v_completion jsonb;
begin
  select r.*
    into v_run
  from public.kapiloto_research_runs r
  where r.id = p_run_id
  for update;

  if not found then
    raise exception 'Kapiloto research run not found';
  end if;

  if v_run.status = 'completed' then
    return public.kapiloto_complete_research_run(
      p_run_id,
      coalesce(p_round_synthesis, '{}'::jsonb)
    );
  end if;

  if jsonb_typeof(p_analyses) is distinct from 'array'
     or jsonb_array_length(p_analyses) <> 16 then
    raise exception 'Kapiloto materialization requires exactly 16 analysis payloads';
  end if;

  if jsonb_typeof(v_run.fixture_set) is distinct from 'array'
     or jsonb_array_length(v_run.fixture_set) <> 16 then
    raise exception 'Kapiloto run fixture_set must contain exactly 16 fixtures';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_run.fixture_set) f
    left join public.round_games rg
      on rg.id = (f ->> 'roundGameId')::uuid
     and rg.fixture_id = (f ->> 'fixtureId')::uuid
     and rg.round_id = v_run.round_id
    where rg.id is null
  ) then
    raise exception 'Kapiloto run fixture_set does not match canonical round fixtures';
  end if;

  if (
    select count(distinct ((f ->> 'roundGameId')::uuid, (f ->> 'fixtureId')::uuid))
    from jsonb_array_elements(v_run.fixture_set) f
  ) <> 16 then
    raise exception 'Kapiloto run fixture_set contains duplicate fixture identities';
  end if;

  if (
    select count(distinct ((a ->> 'round_game_id')::uuid, (a ->> 'fixture_id')::uuid))
    from jsonb_array_elements(p_analyses) a
  ) <> 16 then
    raise exception 'Kapiloto analysis payload contains duplicate fixture identities';
  end if;

  if exists (
    select 1
    from (
      select
        (f ->> 'roundGameId')::uuid as round_game_id,
        (f ->> 'fixtureId')::uuid as fixture_id
      from jsonb_array_elements(v_run.fixture_set) f
      except
      select
        (a ->> 'round_game_id')::uuid,
        (a ->> 'fixture_id')::uuid
      from jsonb_array_elements(p_analyses) a
    ) missing
  ) or exists (
    select 1
    from (
      select
        (a ->> 'round_game_id')::uuid as round_game_id,
        (a ->> 'fixture_id')::uuid as fixture_id
      from jsonb_array_elements(p_analyses) a
      except
      select
        (f ->> 'roundGameId')::uuid,
        (f ->> 'fixtureId')::uuid
      from jsonb_array_elements(v_run.fixture_set) f
    ) extra
  ) then
    raise exception 'Kapiloto analysis payload does not match frozen fixture_set';
  end if;

  select count(*)
    into v_count
  from public.kapiloto_analyses a
  where a.research_run_id = p_run_id;

  if v_count <> 0 then
    raise exception 'Kapiloto run already has partially materialized analyses';
  end if;

  for v_item in
    select value from jsonb_array_elements(p_analyses)
  loop
    v_outcome := v_item ->> 'outcome';

    if v_outcome not in (
      'analyzed',
      'insufficient_data',
      'void',
      'carried_forward',
      'research_unavailable'
    ) then
      raise exception 'Invalid Kapiloto analysis outcome: %', v_outcome;
    end if;

    if v_outcome = 'analyzed' and not exists (
      select 1
      from jsonb_array_elements(coalesce(v_item -> 'evidence', '[]'::jsonb)) e
      where coalesce(e ->> 'status', 'accepted') = 'accepted'
        and coalesce((e ->> 'quote_verified')::boolean, false)
    ) then
      raise exception 'Analyzed fixture requires at least one accepted grounded evidence row';
    end if;

    insert into public.kapiloto_analyses (
      research_run_id,
      round_id,
      round_game_id,
      fixture_id,
      outcome,
      carried_from_analysis_id,
      research_cutoff_at,
      kickoff_at_snapshot,
      settlement_rule_snapshot,
      neutral_venue_snapshot,
      orientation_verified,
      prior_type,
      market_snapshot_id,
      p_prior_1_bp,
      p_prior_x_bp,
      p_prior_2_bp,
      p_sol_1_bp,
      p_sol_x_bp,
      p_sol_2_bp,
      p_final_1_bp,
      p_final_x_bp,
      p_final_2_bp,
      reliability,
      reliability_band,
      reliability_reasons,
      model_self_confidence,
      primary_pick,
      suggested_double,
      double_priority_rank,
      double_gain_score,
      blend_weight,
      deviation_cap_applied,
      summary,
      main_risk,
      availability,
      expected_lineups,
      tactical_facts,
      matchup_analysis,
      regime_changes,
      dimension_coverage,
      conflicts,
      watch_items,
      key_assumptions,
      data_quality,
      suspicious_content,
      valid_until,
      generated_at
    )
    values (
      p_run_id,
      v_run.round_id,
      (v_item ->> 'round_game_id')::uuid,
      (v_item ->> 'fixture_id')::uuid,
      v_outcome,
      nullif(v_item ->> 'carried_from_analysis_id', '')::uuid,
      coalesce(
        nullif(v_item ->> 'research_cutoff_at', '')::timestamptz,
        v_run.research_cutoff_at
      ),
      (v_item ->> 'kickoff_at_snapshot')::timestamptz,
      v_item ->> 'settlement_rule_snapshot',
      coalesce((v_item ->> 'neutral_venue_snapshot')::boolean, false),
      coalesce((v_item ->> 'orientation_verified')::boolean, false),
      nullif(v_item ->> 'prior_type', ''),
      nullif(v_item ->> 'market_snapshot_id', '')::uuid,
      nullif(v_item ->> 'p_prior_1_bp', '')::smallint,
      nullif(v_item ->> 'p_prior_x_bp', '')::smallint,
      nullif(v_item ->> 'p_prior_2_bp', '')::smallint,
      nullif(v_item ->> 'p_sol_1_bp', '')::smallint,
      nullif(v_item ->> 'p_sol_x_bp', '')::smallint,
      nullif(v_item ->> 'p_sol_2_bp', '')::smallint,
      nullif(v_item ->> 'p_final_1_bp', '')::smallint,
      nullif(v_item ->> 'p_final_x_bp', '')::smallint,
      nullif(v_item ->> 'p_final_2_bp', '')::smallint,
      nullif(v_item ->> 'reliability', '')::numeric,
      nullif(v_item ->> 'reliability_band', ''),
      coalesce(v_item -> 'reliability_reasons', '[]'::jsonb),
      nullif(v_item ->> 'model_self_confidence', ''),
      nullif(v_item ->> 'primary_pick', ''),
      nullif(v_item ->> 'suggested_double', ''),
      nullif(v_item ->> 'double_priority_rank', '')::smallint,
      nullif(v_item ->> 'double_gain_score', '')::numeric,
      nullif(v_item ->> 'blend_weight', '')::numeric,
      coalesce((v_item ->> 'deviation_cap_applied')::boolean, false),
      nullif(v_item ->> 'summary', ''),
      nullif(v_item ->> 'main_risk', ''),
      coalesce(v_item -> 'availability', '[]'::jsonb),
      nullif(v_item -> 'expected_lineups', 'null'::jsonb),
      nullif(v_item -> 'tactical_facts', 'null'::jsonb),
      nullif(v_item -> 'matchup_analysis', 'null'::jsonb),
      nullif(v_item -> 'regime_changes', 'null'::jsonb),
      coalesce(v_item -> 'dimension_coverage', '[]'::jsonb),
      coalesce(v_item -> 'conflicts', '[]'::jsonb),
      coalesce(v_item -> 'watch_items', '[]'::jsonb),
      coalesce(v_item -> 'key_assumptions', '[]'::jsonb),
      coalesce(v_item -> 'data_quality', '{}'::jsonb),
      coalesce(v_item -> 'suspicious_content', '[]'::jsonb),
      nullif(v_item ->> 'valid_until', '')::timestamptz,
      coalesce(
        nullif(v_item ->> 'generated_at', '')::timestamptz,
        now()
      )
    )
    returning id into v_analysis_id;

    for v_evidence in
      select value
      from jsonb_array_elements(coalesce(v_item -> 'evidence', '[]'::jsonb))
    loop
      insert into public.kapiloto_evidence (
        analysis_id,
        model_evidence_id,
        url_canonical,
        domain,
        claim_type,
        about_team,
        quote,
        claim,
        source_event_time,
        published_at,
        retrieved_at,
        trust_tier,
        quote_verified,
        entailment,
        syndication_cluster_id,
        content_sha256,
        status,
        rejected_reason
      )
      values (
        v_analysis_id,
        v_evidence ->> 'model_evidence_id',
        v_evidence ->> 'url_canonical',
        v_evidence ->> 'domain',
        v_evidence ->> 'claim_type',
        v_evidence ->> 'about_team',
        v_evidence ->> 'quote',
        v_evidence ->> 'claim',
        nullif(v_evidence ->> 'source_event_time', ''),
        nullif(v_evidence ->> 'published_at', '')::timestamptz,
        (v_evidence ->> 'retrieved_at')::timestamptz,
        nullif(v_evidence ->> 'trust_tier', '')::smallint,
        coalesce((v_evidence ->> 'quote_verified')::boolean, false),
        coalesce(nullif(v_evidence ->> 'entailment', ''), 'not_checked'),
        nullif(v_evidence ->> 'syndication_cluster_id', ''),
        nullif(v_evidence ->> 'content_sha256', ''),
        coalesce(nullif(v_evidence ->> 'status', ''), 'accepted'),
        nullif(v_evidence ->> 'rejected_reason', '')
      );
    end loop;

    for v_factor in
      select value
      from jsonb_array_elements(coalesce(v_item -> 'factors', '[]'::jsonb))
    loop
      insert into public.kapiloto_factors (
        analysis_id,
        dimension,
        favors,
        magnitude,
        rationale,
        matchup_ids
      )
      values (
        v_analysis_id,
        v_factor ->> 'dimension',
        v_factor ->> 'favors',
        v_factor ->> 'magnitude',
        v_factor ->> 'rationale',
        coalesce(v_factor -> 'matchup_ids', '[]'::jsonb)
      )
      returning id into v_factor_id;

      for v_model_evidence_id in
        select value
        from jsonb_array_elements_text(
          coalesce(v_factor -> 'evidence_model_ids', '[]'::jsonb)
        )
      loop
        select e.id
          into v_evidence_id
        from public.kapiloto_evidence e
        where e.analysis_id = v_analysis_id
          and e.model_evidence_id = v_model_evidence_id
          and e.status = 'accepted';

        if v_evidence_id is null then
          raise exception 'Factor references missing/unaccepted evidence id %',
            v_model_evidence_id;
        end if;

        insert into public.kapiloto_factor_evidence (
          factor_id,
          evidence_id,
          analysis_id
        )
        values (
          v_factor_id,
          v_evidence_id,
          v_analysis_id
        );
      end loop;
    end loop;

    for v_input in
      select value
      from jsonb_array_elements(coalesce(v_item -> 'inputs', '[]'::jsonb))
    loop
      insert into public.kapiloto_analysis_inputs (
        analysis_id,
        input_type,
        input_version,
        metadata
      )
      values (
        v_analysis_id,
        v_input ->> 'input_type',
        nullif(v_input ->> 'input_version', ''),
        coalesce(v_input -> 'metadata', '{}'::jsonb)
      );
    end loop;
  end loop;

  v_completion := public.kapiloto_complete_research_run(
    p_run_id,
    coalesce(p_round_synthesis, '{}'::jsonb)
  );

  return v_completion;
end;
$$;

revoke all on function public.kapiloto_materialize_and_complete_run(uuid, jsonb, jsonb)
from public, anon, authenticated;

grant execute on function public.kapiloto_materialize_and_complete_run(uuid, jsonb, jsonb)
to service_role;
