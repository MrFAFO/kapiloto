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
