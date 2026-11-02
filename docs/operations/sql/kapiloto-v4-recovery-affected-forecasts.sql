-- Kapiloto V4 recovery report: Prediction Registry snapshots whose frozen
-- inputs used Match Ledger observations touched by an identity revocation
-- (read-only; runbook §B and §J). Not a migration; never place it under
-- supabase/migrations.
--
-- Parameters, set in the SAME execution immediately before this query:
--   select set_config('kapiloto_recovery.entity_kind', 'team', true),   -- or 'competition'
--          set_config('kapiloto_recovery.provider_ref', '<sportmonks team or league id>', true);
--
-- Frozen snapshots stay valid immutable records and replay without re-reading
-- (D-060); this report only tells the operator which forecasts consumed
-- history that is no longer trusted, so their evaluation can be annotated or
-- excluded. It lists every observation in the revocation impact report
-- (sealed under any generation of the ref, or unattested) that a snapshot
-- recorded in prediction_ledger_inputs.

select
  s.id as snapshot_id,
  s.purpose,
  s.fixture_id as forecast_fixture_id,
  s.research_cutoff_at,
  s.first_seen_at as snapshot_first_seen_at,
  i.ledger_observation_id,
  i.input_role,
  imp.impact_kind,
  imp.fixture_id as ledger_fixture_id,
  imp.provider_fixture_id,
  imp.attestation_generation_id,
  imp.generation_state
from public.provider_identity_revocation_impact(
  'sportmonks',
  current_setting('kapiloto_recovery.entity_kind'),
  current_setting('kapiloto_recovery.provider_ref')
) imp
join public.prediction_ledger_inputs i on i.ledger_observation_id = imp.observation_id
join public.prediction_snapshots s on s.id = i.snapshot_id
order by s.first_seen_at, s.id, i.ledger_observation_id;
