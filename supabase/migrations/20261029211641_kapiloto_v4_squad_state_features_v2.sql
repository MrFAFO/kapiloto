-- Kapiloto V4 Foundation 1E-A1: membership-aware squad features V2 (D-055).
--
-- Additive. The applied 1A/1B/1C/1D migrations are not modified.
--
-- Lets Prediction Registry V2 freeze lineup forecasts built with
-- kapiloto-squad-state-builder-v2 / kapiloto-squad-features-v2 next to the
-- original kapiloto-squad-state-builder-v1 / kapiloto-squad-features-v1 pair.
-- Nothing else changes:
--   * the state contract stays kapiloto-squad-state-v1: V2 states have the
--     same shape and field meanings; the features version names the
--     historical start-knownness rule;
--   * the raw inputs contract stays kapiloto-squad-state-inputs-v1: the
--     membership assertions V2 needs are already in the frozen inputs, so
--     complete capture (squad_state_inputs_as_of re-run at commit) is
--     unchanged;
--   * the snapshot contract stays kapiloto-prediction-snapshot-v2:
--     canonicalization and hashing already carry the builder and features
--     versions and the exact state bytes, and the artifact trigger already
--     requires the artifact to state the same versions as its context row.
-- Existing (builder-v1, features-v1) rows satisfy the new constraints.

-- Generated 1D names (truncated to 63 bytes by Postgres). Dropped by exact
-- name, so a mismatch fails the migration instead of leaving V1-only checks.
alter table public.prediction_squad_state_context
  drop constraint prediction_squad_state_contex_squad_state_builder_version_check,
  drop constraint prediction_squad_state_context_squad_features_version_check;

alter table public.prediction_squad_state_context
  add constraint prediction_squad_state_context_builder_version_check
    check (squad_state_builder_version in (
      'kapiloto-squad-state-builder-v1', 'kapiloto-squad-state-builder-v2'
    )),
  add constraint prediction_squad_state_context_features_version_check
    check (squad_features_version in ('kapiloto-squad-features-v1', 'kapiloto-squad-features-v2')),
  -- A builder produces exactly one feature contract; no mixed pairs.
  add constraint prediction_squad_state_context_builder_features_check
    check (
      (squad_state_builder_version = 'kapiloto-squad-state-builder-v1'
        and squad_features_version = 'kapiloto-squad-features-v1')
      or (squad_state_builder_version = 'kapiloto-squad-state-builder-v2'
        and squad_features_version = 'kapiloto-squad-features-v2')
    );

comment on column public.prediction_squad_state_context.squad_state_builder_version is
  'kapiloto-squad-state-builder-v1 (1D: complete-lineup absence is a known non-start) or kapiloto-squad-state-builder-v2 (D-055: only while membership is certain on the historical date). Must match the frozen artifact.';
comment on column public.prediction_squad_state_context.squad_features_version is
  'kapiloto-squad-features-v1 with builder-v1, kapiloto-squad-features-v2 with builder-v2. Must match the frozen artifact.';
