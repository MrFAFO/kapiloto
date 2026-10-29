/**
 * Version constants for the V4 foundation contracts. A change in meaning gets
 * a new version string; stored rows keep the version they were written under.
 */

/** Canonical player/coach/tenure shapes in lib/kapiloto-v4/entities.ts. */
export const KAPILOTO_V4_ENTITY_CONTRACT_VERSION = "kapiloto-v4-entities-v1";

/** JSON payload accepted by public.match_ledger_record_observation. */
export const MATCH_LEDGER_OBSERVATION_CONTRACT_VERSION =
  "kapiloto-match-ledger-observation-v1";

/** private.normalize_entity_alias / normalizeEntityAlias. */
export const ENTITY_ALIAS_NORMALIZATION_VERSION = "entity-alias-normalization-v1";

/** Shape of match_ledger_game_state_segments rows (contract only for now). */
export const GAME_STATE_SEGMENT_CONTRACT_VERSION = "kapiloto-game-state-segments-v1";

/** The as-of rule implemented by the match_ledger_*_as_of SQL functions. */
export const AS_OF_RULE_VERSION = "kapiloto-as-of-first-seen-v1";

/**
 * Merge semantics: ledger rows keep their written ids, model-facing reads and
 * resolutions return current survivors, writes accept survivors only.
 */
export const CANONICAL_IDENTITY_RULE_VERSION = "kapiloto-canonical-identity-v1";

/** JSON payload accepted by public.knowledge_record_document_version. */
export const DOCUMENT_VERSION_CONTRACT_VERSION = "kapiloto-document-version-v1";

/** JSON payload accepted by public.knowledge_record_claim. */
export const CLAIM_CONTRACT_VERSION = "kapiloto-claim-v1";

/** Row contract of public.knowledge_claim_observations. */
export const CLAIM_OBSERVATION_CONTRACT_VERSION = "kapiloto-claim-observation-v1";

/** JSON payload accepted by public.knowledge_record_claim_resolution. */
export const CLAIM_RESOLUTION_CONTRACT_VERSION = "kapiloto-claim-resolution-v1";

/** JSON payload accepted by public.prediction_record_snapshot. */
export const PREDICTION_SNAPSHOT_CONTRACT_VERSION = "kapiloto-prediction-snapshot-v1";

/** Shape of prediction_snapshots.uncertainty. */
export const UNCERTAINTY_DECOMPOSITION_VERSION = "kapiloto-uncertainty-v1";

/** Merge-aware claim identity (knowledge_canonical_claims). */
export const CANONICAL_CLAIM_RULE_VERSION = "kapiloto-canonical-claim-v1";

/** Row contract of public.team_player_memberships. */
export const TEAM_PLAYER_MEMBERSHIP_CONTRACT_VERSION = "kapiloto-team-player-membership-v1";

/** JSON returned by public.squad_state_inputs_as_of. */
export const SQUAD_STATE_INPUTS_CONTRACT_VERSION = "kapiloto-squad-state-inputs-v1";

/** Derived, in-memory squad state built by buildFixtureSquadState. */
export const SQUAD_STATE_CONTRACT_VERSION = "kapiloto-squad-state-v1";

/** Implementation version of buildFixtureSquadState. */
export const SQUAD_STATE_BUILDER_VERSION = "kapiloto-squad-state-builder-v1";

/** One observation per historical fixture: complete over partial, then provider priority. */
export const HISTORY_SELECTION_POLICY_VERSION = "kapiloto-history-selection-v1";

/** Raw availability status -> small derived category (normalizeAvailabilityStatus). */
export const AVAILABILITY_NORMALIZATION_VERSION = "kapiloto-availability-normalization-v1";
