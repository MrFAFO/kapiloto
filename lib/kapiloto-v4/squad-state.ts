import type { ClaimKind, ClaimPolarity, ResolutionStatus } from "./claims";
import { tenureCoversDate, type TenureRole } from "./entities";
import type { DataStatus, LineupRole, PositionCode, TeamSide } from "./match-ledger";
import type { MembershipAsOfRow, MembershipCoverage, SquadGroup } from "./roster";
import {
  AVAILABILITY_NORMALIZATION_VERSION,
  HISTORY_SELECTION_POLICY_VERSION,
  SQUAD_FEATURES_VERSION,
  SQUAD_STATE_BUILDER_VERSION,
  SQUAD_STATE_CONTRACT_VERSION,
  SQUAD_STATE_INPUTS_CONTRACT_VERSION,
  SQUAD_TARGET_DATE_POLICY_VERSION,
} from "./versions";

/**
 * Fixture squad state (V4 Foundation 1C, kapiloto-squad-state-v1).
 *
 * "Immediately before fixture F, what squad state could Kapiloto construct
 * for team T from information it had at cutoff C?" The database read
 * public.squad_state_inputs_as_of returns cutoff-filtered RAW inputs;
 * buildFixtureSquadState is a pure, deterministic derivation over them.
 *
 * Layers stay distinct: roster assertions, historical participation,
 * availability evidence, reported-lineup evidence, and derived features.
 * This module never outputs a lineup, a starting or minutes probability, a
 * form rating or any learned score. That is the future lineup model's job.
 */

// ---------------------------------------------------------------------------
// Inputs (JSON returned by public.squad_state_inputs_as_of)
// ---------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ClaimObjectValue = { readonly [key: string]: JsonValue };

export type HistoryPlayerInput = {
  observed_player_id: string;
  canonical_player_id: string;
  lineup_role: LineupRole;
  appeared: boolean | null;
  position_code: PositionCode | null;
  formation_position: number | null;
  is_captain: boolean | null;
  minutes_played: number | null;
  entered_minute: number | null;
  exited_minute: number | null;
};

export type HistorySubstitutionInput = {
  sequence_no: number;
  observed_player_off_id: string;
  canonical_player_off_id: string;
  observed_player_on_id: string;
  canonical_player_on_id: string;
  minute: number | null;
  stoppage_minute: number | null;
};

/** One provider's latest visible version of one historical fixture. */
export type HistoryObservationInput = {
  observation_id: string;
  fixture_id: string;
  provider: string;
  observation_version: number;
  first_seen_at: string;
  kickoff_at: string;
  side: TeamSide;
  opponent_team_id: string;
  observed_coach_id: string | null;
  canonical_coach_id: string | null;
  lineup_status: DataStatus;
  substitutions_status: DataStatus;
  players: HistoryPlayerInput[];
  substitutions: HistorySubstitutionInput[];
};

export const SQUAD_CLAIM_TYPES = ["player_availability", "expected_lineup"] as const;
export type SquadClaimType = (typeof SQUAD_CLAIM_TYPES)[number];

/** One target-fixture canonical claim group with its as-of belief. */
export type SquadClaimInput = {
  claim_id: string;
  canonical_claim_id: string;
  member_claim_ids: string[];
  claim_kind: ClaimKind;
  claim_type: SquadClaimType;
  predicate: string;
  team_id: string | null;
  observed_player_id: string;
  canonical_player_id: string;
  object_value: ClaimObjectValue;
  polarity: ClaimPolarity;
  claim_first_seen_at: string;
  resolution_id: string | null;
  resolution_claim_id: string | null;
  resolution_status: ResolutionStatus;
  resolution_first_seen_at: string | null;
  quality_flags: string[];
};

export type SquadTenureInput = {
  tenure_id: string;
  tenure_key: string;
  tenure_version: number;
  observed_coach_id: string;
  canonical_coach_id: string;
  role: TenureRole;
  starts_on_earliest: string;
  starts_on_latest: string;
  ends_on_earliest: string | null;
  ends_on_latest: string | null;
  first_seen_at: string;
};

export type SquadStateInputs = {
  contract_version: typeof SQUAD_STATE_INPUTS_CONTRACT_VERSION;
  fixture_id: string;
  team_id: string;
  opponent_team_id: string;
  side: TeamSide;
  kickoff_at: string;
  cutoff: string;
  /** UTC calendar date of the canonical kickoff (target_date_policy). */
  target_date: string;
  target_date_policy: typeof SQUAD_TARGET_DATE_POLICY_VERSION;
  history: HistoryObservationInput[];
  memberships: MembershipAsOfRow[];
  claims: SquadClaimInput[];
  tenures: SquadTenureInput[];
};

// ---------------------------------------------------------------------------
// History selection (kapiloto-history-selection-v1)
// ---------------------------------------------------------------------------

export const SQUAD_HISTORY_WINDOW_MAX = 10;

export type HistorySelectionPolicy = {
  version: typeof HISTORY_SELECTION_POLICY_VERSION;
  /** Explicit provider priority; providers not listed are not used. */
  providerPriority: readonly string[];
  /** At most SQUAD_HISTORY_WINDOW_MAX selected fixtures. */
  maxFixtures: number;
};

export function historySelectionPolicy(providerPriority: readonly string[], maxFixtures = SQUAD_HISTORY_WINDOW_MAX): HistorySelectionPolicy {
  if (providerPriority.length === 0) throw new Error("history selection needs an explicit provider priority");
  if (new Set(providerPriority).size !== providerPriority.length) throw new Error("provider priority repeats a provider");
  if (!Number.isInteger(maxFixtures) || maxFixtures < 1 || maxFixtures > SQUAD_HISTORY_WINDOW_MAX) {
    throw new Error(`maxFixtures must be an integer in 1..${SQUAD_HISTORY_WINDOW_MAX}`);
  }
  return { version: HISTORY_SELECTION_POLICY_VERSION, providerPriority: [...providerPriority], maxFixtures };
}

export const SELECTION_REASONS = ["only_usable_observation", "complete_over_partial", "provider_priority"] as const;
export type SelectionReason = (typeof SELECTION_REASONS)[number];

export const EXCLUSION_REASONS = [
  "player_data_not_provided",
  "no_player_rows",
  "provider_not_in_priority",
  "lower_completeness",
  "lower_provider_priority",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export type SelectedHistoryFixture = {
  fixture_id: string;
  kickoff_at: string;
  observation_id: string;
  provider: string;
  observation_version: number;
  lineup_status: "complete" | "partial";
  reason: SelectionReason;
  /** True when a higher-priority provider existed but was not usable or lost on completeness. */
  provider_fallback: boolean;
  alternatives: { observation_id: string; provider: string; lineup_status: DataStatus; excluded_because: ExclusionReason }[];
};

export type ExcludedHistoryFixture = {
  fixture_id: string;
  kickoff_at: string;
  observations: { observation_id: string; provider: string; lineup_status: DataStatus; excluded_because: ExclusionReason }[];
};

/**
 * Exactly one observation per historical fixture, never a blend:
 * 1. usable = player family complete or partial, with player rows, from a
 *    listed provider; 2. complete beats partial; 3. then provider priority.
 * The latest maxFixtures selected fixtures (by kickoff) are kept.
 */
export function selectHistoricalObservations(
  history: readonly HistoryObservationInput[],
  policy: HistorySelectionPolicy,
): { selected: SelectedHistoryFixture[]; excluded: ExcludedHistoryFixture[] } {
  const byFixture = new Map<string, HistoryObservationInput[]>();
  for (const observation of history) {
    const list = byFixture.get(observation.fixture_id) ?? [];
    list.push(observation);
    byFixture.set(observation.fixture_id, list);
  }
  const priority = (provider: string) => policy.providerPriority.indexOf(provider);
  const selected: SelectedHistoryFixture[] = [];
  const excluded: ExcludedHistoryFixture[] = [];
  for (const [fixtureId, observations] of byFixture) {
    const kickoff = observations.map((o) => o.kickoff_at).sort().at(-1)!;
    const unusable = new Map<string, ExclusionReason>();
    for (const o of observations) {
      if (priority(o.provider) < 0) unusable.set(o.observation_id, "provider_not_in_priority");
      else if (o.lineup_status === "not_provided") unusable.set(o.observation_id, "player_data_not_provided");
      else if (o.players.length === 0) unusable.set(o.observation_id, "no_player_rows");
    }
    const usable = observations
      .filter((o) => !unusable.has(o.observation_id))
      .sort((a, b) => completenessRank(a.lineup_status) - completenessRank(b.lineup_status) || priority(a.provider) - priority(b.provider));
    if (usable.length === 0) {
      excluded.push({
        fixture_id: fixtureId,
        kickoff_at: kickoff,
        observations: observations.map((o) => ({ observation_id: o.observation_id, provider: o.provider, lineup_status: o.lineup_status, excluded_because: unusable.get(o.observation_id)! })),
      });
      continue;
    }
    const winner = usable[0];
    const runnerUp = usable[1];
    const reason: SelectionReason = !runnerUp
      ? "only_usable_observation"
      : completenessRank(runnerUp.lineup_status) > completenessRank(winner.lineup_status)
        ? "complete_over_partial"
        : "provider_priority";
    const alternatives = observations
      .filter((o) => o.observation_id !== winner.observation_id)
      .map((o) => ({
        observation_id: o.observation_id,
        provider: o.provider,
        lineup_status: o.lineup_status,
        excluded_because:
          unusable.get(o.observation_id) ??
          (completenessRank(o.lineup_status) > completenessRank(winner.lineup_status) ? ("lower_completeness" as const) : ("lower_provider_priority" as const)),
      }))
      .sort((a, b) => a.observation_id.localeCompare(b.observation_id));
    const listedProviders = observations.filter((o) => priority(o.provider) >= 0).map((o) => priority(o.provider));
    selected.push({
      fixture_id: fixtureId,
      kickoff_at: winner.kickoff_at,
      observation_id: winner.observation_id,
      provider: winner.provider,
      observation_version: winner.observation_version,
      lineup_status: winner.lineup_status as "complete" | "partial",
      reason,
      provider_fallback: Math.min(...listedProviders) < priority(winner.provider),
      alternatives,
    });
  }
  selected.sort((a, b) => b.kickoff_at.localeCompare(a.kickoff_at) || a.fixture_id.localeCompare(b.fixture_id));
  excluded.sort((a, b) => b.kickoff_at.localeCompare(a.kickoff_at) || a.fixture_id.localeCompare(b.fixture_id));
  return { selected: selected.slice(0, policy.maxFixtures), excluded };
}

function completenessRank(status: DataStatus): number {
  return status === "complete" ? 0 : status === "partial" ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Availability normalization (kapiloto-availability-normalization-v1)
// ---------------------------------------------------------------------------

export const AVAILABILITY_CATEGORIES = ["available", "doubtful", "unavailable", "suspended", "returning", "unknown"] as const;
export type AvailabilityCategory = (typeof AVAILABILITY_CATEGORIES)[number];

/**
 * Exact normalization table. Keys are compared after trimming, lower-casing
 * and turning spaces/hyphens into underscores. Anything else is "unknown"
 * (the raw value is always kept). "rotation risk" and similar selection
 * talk are NOT availability and stay unknown.
 */
export const AVAILABILITY_NORMALIZATION_TABLE: Readonly<Record<string, Exclude<AvailabilityCategory, "unknown">>> = {
  available: "available",
  fit: "available",
  fully_fit: "available",
  cleared: "available",
  doubtful: "doubtful",
  doubt: "doubtful",
  questionable: "doubtful",
  fitness_test: "doubtful",
  late_fitness_test: "doubtful",
  out: "unavailable",
  unavailable: "unavailable",
  injured: "unavailable",
  ruled_out: "unavailable",
  ill: "unavailable",
  illness: "unavailable",
  suspended: "suspended",
  suspension: "suspended",
  banned: "suspended",
  returning: "returning",
  returned_to_training: "returning",
  back_in_training: "returning",
  nearing_return: "returning",
};

export function normalizeAvailabilityStatus(raw: string | null): AvailabilityCategory {
  if (raw === null) return "unknown";
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return AVAILABILITY_NORMALIZATION_TABLE[key] ?? "unknown";
}

/** Resolution statuses that may drive accepted evidence. */
export const ACCEPTED_RESOLUTION_STATUSES: readonly ResolutionStatus[] = ["verified", "verified_degraded"];
/** Never drive active state; kept for audit. */
export const AUDIT_ONLY_RESOLUTION_STATUSES: readonly ResolutionStatus[] = ["quarantined", "contradicted", "fabricated"];

type EvidenceStanding = "accepted" | "unresolved" | "audit_only";

function standingOf(status: ResolutionStatus): EvidenceStanding {
  if (ACCEPTED_RESOLUTION_STATUSES.includes(status)) return "accepted";
  if (AUDIT_ONLY_RESOLUTION_STATUSES.includes(status)) return "audit_only";
  return "unresolved";
}

type EvidenceProvenance = {
  claim_id: string;
  canonical_claim_id: string;
  member_claim_ids: string[];
  claim_kind: ClaimKind;
  observed_player_id: string;
  polarity: ClaimPolarity;
  raw_value: ClaimObjectValue;
  resolution_id: string | null;
  resolution_claim_id: string | null;
  resolution_status: ResolutionStatus;
  resolution_first_seen_at: string | null;
  quality_flags: string[];
};

export type AvailabilityEvidence = EvidenceProvenance & {
  raw_status: string | null;
  /** Negated claims are never guessed into a category: they stay unknown. */
  category: AvailabilityCategory;
};

export type AvailabilitySummary = {
  accepted: AvailabilityEvidence[];
  unresolved: AvailabilityEvidence[];
  audit_only: AvailabilityEvidence[];
  /** The single category all accepted (known) evidence agrees on, else null. */
  accepted_category: Exclude<AvailabilityCategory, "unknown"> | null;
  /** Accepted evidence implies different categories: nothing is picked. */
  availability_conflict: boolean;
};

export const REPORTED_LINEUP_PREDICATES = ["starts", "on_bench", "not_in_squad"] as const;

export type ReportedLineupEvidence = EvidenceProvenance & { predicate: string };

/** Evidence only. There is deliberately no selected or final lineup field. */
export type ReportedLineupSummary = {
  accepted: ReportedLineupEvidence[];
  unresolved: ReportedLineupEvidence[];
  audit_only: ReportedLineupEvidence[];
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * value over the window's matches where THIS feature is known for the player;
 * available_matches is that denominator (never padded to the window size).
 */
export type WindowCount = { value: number; available_matches: number };
export type RollingWindows = { last_3: WindowCount; last_5: WindowCount; last_10: WindowCount };

/**
 * Per-feature knownness (kapiloto-squad-features-v1). Unknown is never
 * turned into a zero and never enters a denominator. Matchday-squad
 * completeness is NOT assumed: 1A structurally proves only that a "complete"
 * lineup lists exactly 11 starters, so absence from it proves "did not start"
 * and nothing else (see docs/architecture/KAPILOTO-V4-SQUAD-STATE.md).
 *
 *   start      known for a starter or bench row, or absence from a complete
 *              lineup (known 0); unknown for lineup_role = unknown or absence
 *              from a partial lineup.
 *   appearance known for a starter (1) or a row with appeared true/false;
 *              unknown for appeared = null on a non-starter, and for any
 *              absence.
 *   minutes    known when minutes_played is stated, or 0 when the row says
 *              appeared = false; unknown otherwise, including any absence.
 *   squad      known (positive) only when the player has a row; a squad
 *              negative is never inferred in V1.
 */
export type PlayerHistoryFeatures = {
  /** Selected historical fixtures. */
  matches_available: number;
  /** Squad-status coverage: matches where he has a row (no inferred negatives in V1). */
  matches_with_known_status: number;
  /** Positive count: matches where he has a matchday row. */
  squad_appearances: number;
  /** Positive count; rate denominator start_known_matches. */
  starts: number;
  start_known_matches: number;
  /** Explicit known negatives: bench rows with appeared = false. */
  bench_unused: number;
  /** Bench rows whose appearance the source does not state. */
  bench_appearance_unknown: number;
  /** Positive count; rate denominator appearance_known_matches. */
  appearances: number;
  appearance_known_matches: number;
  /** Sum over minutes-known matches only; denominator minutes_known_matches. */
  minutes_total: number;
  minutes_known_matches: number;
  starts_last: RollingWindows;
  appearances_last: RollingWindows;
  minutes_last: RollingWindows;
  /**
   * Starts with explicit minutes_played >= 90 and no earlier stated exit:
   * on the pitch for all of regulation time. Not "full match": whether an
   * extra-time match was played to 120 is not derived. Denominator
   * starts_with_known_minutes; a start without stated minutes never counts.
   */
  full_regulation_starts: number;
  starts_with_known_minutes: number;
  /** Lower bounds from listed substitutions (missing substitution data is not zero). */
  sub_on: number;
  sub_off: number;
  /** Lower bound: explicit exited_minute < 60 only; a missing exit is never assumed. */
  early_exits_before_60: number;
  last_squad_kickoff: string | null;
  last_appearance_kickoff: string | null;
  last_start_kickoff: string | null;
  /**
   * Starts in a row entering the fixture, from the most recent selected
   * match; stops at the first known non-start or the first unknown start.
   */
  consecutive_starts: number;
  position_histogram: Partial<Record<PositionCode, number>>;
  formation_slot_histogram: { slot: number; count: number }[];
  /** Lower bound: starts with is_captain = true (null is not "not captain"). */
  captain_starts: number;
  observation_ids: string[];
};

export const CANDIDATE_SOURCES = ["roster", "history", "availability_claim", "lineup_claim"] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];
export const CANDIDATE_PRESENCE = ["roster_and_history", "roster_only", "historical_only", "claim_only"] as const;
export type CandidatePresence = (typeof CANDIDATE_PRESENCE)[number];

export type SquadCandidate = {
  canonical_player_id: string;
  observed_player_ids: string[];
  presence: CandidatePresence;
  sources: CandidateSource[];
  roster: {
    coverage: Exclude<MembershipCoverage, "outside"> | null;
    membership_ids: string[];
    squad_groups: SquadGroup[];
    shirt_numbers: number[];
  };
  history: PlayerHistoryFeatures;
  availability: AvailabilitySummary;
  reported_lineup: ReportedLineupSummary;
};

export type ReplacementPattern = {
  player_off_id: string;
  player_on_id: string;
  count: number;
  minutes: number[];
  median_minute: number | null;
  occurrences: { fixture_id: string; observation_id: string; minute: number | null; observed_player_off_id: string; observed_player_on_id: string }[];
};

export const COACH_PROVENANCES = ["ledger_and_tenure", "ledger_only", "tenure_only", "conflict", "unknown"] as const;
export type CoachProvenance = (typeof COACH_PROVENANCES)[number];

export type CoachState = {
  provenance: CoachProvenance;
  coach_conflict: boolean;
  /** Set only when the evidence agrees (or only one family exists). */
  current_coach_id: string | null;
  candidate_coach_ids: string[];
  latest_ledger_coach_id: string | null;
  latest_ledger_observation_id: string | null;
  active_tenure_coach_ids: string[];
  history_coaches: { canonical_coach_id: string; matches: number; last_kickoff: string }[];
  tenures: {
    tenure_id: string;
    tenure_key: string;
    tenure_version: number;
    observed_coach_id: string;
    canonical_coach_id: string;
    role: TenureRole;
    coverage: "certain" | "possible" | "no";
    starts_on_earliest: string;
    starts_on_latest: string;
    ends_on_earliest: string | null;
    ends_on_latest: string | null;
  }[];
};

export type SquadQuality = {
  usable_history_matches: number;
  complete_history_matches: number;
  partial_history_matches: number;
  excluded_history_fixtures: number;
  provider_fallback_count: number;
  active_roster_assertions: number;
  candidates_total: number;
  candidates_with_roster: number;
  candidates_without_recent_history: number;
  unresolved_availability_claims: number;
  availability_conflicts: number;
  coach_conflict: boolean;
  /** Target-fixture claims with no team about players outside the universe. */
  unattributed_claim_ids: string[];
};

export type FixtureSquadState = {
  contract_version: typeof SQUAD_STATE_CONTRACT_VERSION;
  builder_version: typeof SQUAD_STATE_BUILDER_VERSION;
  inputs_contract_version: typeof SQUAD_STATE_INPUTS_CONTRACT_VERSION;
  history_selection_policy: HistorySelectionPolicy;
  availability_normalization_version: typeof AVAILABILITY_NORMALIZATION_VERSION;
  features_version: typeof SQUAD_FEATURES_VERSION;
  fixture: {
    fixture_id: string;
    team_id: string;
    opponent_team_id: string;
    side: TeamSide;
    kickoff_at: string;
    cutoff: string;
    target_date: string;
    target_date_policy: typeof SQUAD_TARGET_DATE_POLICY_VERSION;
  };
  history_selection: SelectedHistoryFixture[];
  history_excluded: ExcludedHistoryFixture[];
  candidates: SquadCandidate[];
  replacement_patterns: ReplacementPattern[];
  coach: CoachState;
  quality: SquadQuality;
  /** Exact ids a future prediction layer must freeze. */
  provenance: {
    ledger_observation_ids: string[];
    considered_observation_ids: string[];
    membership_ids: string[];
    canonical_claim_ids: string[];
    member_claim_ids: string[];
    resolution_ids: string[];
    tenure_ids: string[];
    canonical_player_ids: string[];
    canonical_coach_ids: string[];
  };
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const WINDOWS = [3, 5, 10] as const;

/** Pure and deterministic: same inputs and policy, same state. */
export function buildFixtureSquadState(inputs: SquadStateInputs, policy: HistorySelectionPolicy): FixtureSquadState {
  if (inputs.contract_version !== SQUAD_STATE_INPUTS_CONTRACT_VERSION) throw new Error("unsupported squad-state inputs contract");
  if (Date.parse(inputs.cutoff) > Date.parse(inputs.kickoff_at)) throw new Error("squad-state cutoff is after the fixture kickoff");

  const { selected, excluded } = selectHistoricalObservations(inputs.history, policy);
  const observationsById = new Map(inputs.history.map((o) => [o.observation_id, o]));
  const selectedObservations = selected.map((s) => observationsById.get(s.observation_id)!);

  const activeMemberships = inputs.memberships.filter((m) => m.coverage !== "outside");
  const historyPlayers = new Set(selectedObservations.flatMap((o) => o.players.map((p) => p.canonical_player_id)));
  const rosterPlayers = new Set(activeMemberships.map((m) => m.canonical_player_id));

  // Claims about this team's players: explicit team, or no team but the
  // player is already in the roster/history universe.
  const attributable = (claim: SquadClaimInput) =>
    claim.team_id === inputs.team_id ||
    (claim.team_id === null && (rosterPlayers.has(claim.canonical_player_id) || historyPlayers.has(claim.canonical_player_id)));
  const claims = inputs.claims.filter(attributable);
  const unattributed = inputs.claims.filter((c) => !attributable(c)).map((c) => c.canonical_claim_id).sort();

  const universe = new Set<string>([...rosterPlayers, ...historyPlayers, ...claims.map((c) => c.canonical_player_id)]);
  const candidates = [...universe].sort().map((playerId) =>
    buildCandidate(playerId, inputs, activeMemberships, selectedObservations, claims, rosterPlayers.has(playerId), historyPlayers.has(playerId)),
  );

  const replacement_patterns = buildReplacementPatterns(selectedObservations);
  const coach = buildCoachState(inputs, selectedObservations);

  const quality: SquadQuality = {
    usable_history_matches: selected.length,
    complete_history_matches: selected.filter((s) => s.lineup_status === "complete").length,
    partial_history_matches: selected.filter((s) => s.lineup_status === "partial").length,
    excluded_history_fixtures: excluded.length,
    provider_fallback_count: selected.filter((s) => s.provider_fallback).length,
    active_roster_assertions: activeMemberships.length,
    candidates_total: candidates.length,
    candidates_with_roster: candidates.filter((c) => c.roster.coverage !== null).length,
    candidates_without_recent_history: candidates.filter((c) => c.history.squad_appearances === 0).length,
    unresolved_availability_claims: candidates.reduce((n, c) => n + c.availability.unresolved.length, 0),
    availability_conflicts: candidates.filter((c) => c.availability.availability_conflict).length,
    coach_conflict: coach.coach_conflict,
    unattributed_claim_ids: unattributed,
  };

  return {
    contract_version: SQUAD_STATE_CONTRACT_VERSION,
    builder_version: SQUAD_STATE_BUILDER_VERSION,
    inputs_contract_version: SQUAD_STATE_INPUTS_CONTRACT_VERSION,
    history_selection_policy: policy,
    availability_normalization_version: AVAILABILITY_NORMALIZATION_VERSION,
    features_version: SQUAD_FEATURES_VERSION,
    fixture: {
      fixture_id: inputs.fixture_id,
      team_id: inputs.team_id,
      opponent_team_id: inputs.opponent_team_id,
      side: inputs.side,
      kickoff_at: inputs.kickoff_at,
      cutoff: inputs.cutoff,
      target_date: inputs.target_date,
      target_date_policy: inputs.target_date_policy,
    },
    history_selection: selected,
    history_excluded: excluded,
    candidates,
    replacement_patterns,
    coach,
    quality,
    provenance: {
      ledger_observation_ids: selected.map((s) => s.observation_id),
      considered_observation_ids: inputs.history.map((o) => o.observation_id).sort(),
      membership_ids: inputs.memberships.map((m) => m.membership_id).sort(),
      canonical_claim_ids: claims.map((c) => c.canonical_claim_id).sort(),
      member_claim_ids: [...new Set(claims.flatMap((c) => c.member_claim_ids))].sort(),
      resolution_ids: claims.flatMap((c) => (c.resolution_id ? [c.resolution_id] : [])).sort(),
      tenure_ids: inputs.tenures.map((t) => t.tenure_id).sort(),
      canonical_player_ids: candidates.map((c) => c.canonical_player_id),
      canonical_coach_ids: coach.candidate_coach_ids,
    },
  };
}

function buildCandidate(
  playerId: string,
  inputs: SquadStateInputs,
  memberships: readonly MembershipAsOfRow[],
  history: readonly HistoryObservationInput[],
  claims: readonly SquadClaimInput[],
  hasRoster: boolean,
  hasHistory: boolean,
): SquadCandidate {
  const own = memberships.filter((m) => m.canonical_player_id === playerId);
  const playerClaims = claims.filter((c) => c.canonical_player_id === playerId);
  const availabilityClaims = playerClaims.filter((c) => c.claim_type === "player_availability");
  const lineupClaims = playerClaims.filter((c) => c.claim_type === "expected_lineup");
  const sources: CandidateSource[] = [];
  if (hasRoster) sources.push("roster");
  if (hasHistory) sources.push("history");
  if (availabilityClaims.length > 0) sources.push("availability_claim");
  if (lineupClaims.length > 0) sources.push("lineup_claim");
  const presence: CandidatePresence = hasRoster && hasHistory ? "roster_and_history" : hasRoster ? "roster_only" : hasHistory ? "historical_only" : "claim_only";

  const observed = new Set<string>([
    ...own.map((m) => m.observed_player_id),
    ...history.flatMap((o) => o.players.filter((p) => p.canonical_player_id === playerId).map((p) => p.observed_player_id)),
    ...playerClaims.map((c) => c.observed_player_id),
  ]);
  return {
    canonical_player_id: playerId,
    observed_player_ids: [...observed].sort(),
    presence,
    sources,
    roster: {
      coverage: own.some((m) => m.coverage === "certain") ? "certain" : own.length > 0 ? "possible" : null,
      membership_ids: own.map((m) => m.membership_id).sort(),
      squad_groups: [...new Set(own.map((m) => m.squad_group))].sort(),
      shirt_numbers: [...new Set(own.flatMap((m) => (m.shirt_number === null ? [] : [m.shirt_number])))].sort((a, b) => a - b),
    },
    history: playerHistoryFeatures(playerId, history),
    availability: summarizeAvailability(availabilityClaims),
    reported_lineup: summarizeReportedLineup(lineupClaims),
  };
}

/** Raw counts over the selected fixtures (most recent first); no weights. */
export function playerHistoryFeatures(playerId: string, history: readonly HistoryObservationInput[]): PlayerHistoryFeatures {
  const rows = history.map((observation) => {
    const player = observation.players.find((p) => p.canonical_player_id === playerId) ?? null;
    // Start: a starter/bench row, or absence from a lineup whose 11 starters
    // the database proves are all listed.
    const startKnown = player !== null ? player.lineup_role !== "unknown" : observation.lineup_status === "complete";
    // Appearance: a starter appeared; otherwise only an explicit flag counts.
    const appearanceKnown = player !== null && (player.lineup_role === "starter" || player.appeared !== null);
    // Minutes: stated, or zero when the row says he did not appear.
    const minutesKnown = player !== null && (player.minutes_played !== null || player.appeared === false);
    return { observation, player, startKnown, appearanceKnown, minutesKnown };
  });
  type Row = (typeof rows)[number];
  const started = (r: Row) => r.player?.lineup_role === "starter";
  const played = (r: Row) => r.player !== null && (r.player.lineup_role === "starter" || r.player.appeared === true);
  const minutes = (r: Row) => (r.minutesKnown ? (r.player!.minutes_played ?? 0) : 0);
  const windows = (count: (r: Row) => number, known: (r: Row) => boolean): RollingWindows => {
    const [w3, w5, w10] = WINDOWS.map((w) => {
      const slice = rows.slice(0, w).filter(known);
      return { value: slice.reduce((n, r) => n + count(r), 0), available_matches: slice.length };
    });
    return { last_3: w3, last_5: w5, last_10: w10 };
  };
  const subsOn = rows.filter((r) => r.observation.substitutions.some((s) => s.canonical_player_on_id === playerId)).length;
  const subsOff = rows.filter((r) => r.observation.substitutions.some((s) => s.canonical_player_off_id === playerId)).length;
  let consecutive = 0;
  for (const r of rows) {
    if (!r.startKnown || !started(r)) break;
    consecutive += 1;
  }
  const startsWithMinutes = rows.filter((r) => started(r) && r.player!.minutes_played !== null);
  const positions: Partial<Record<PositionCode, number>> = {};
  const slots = new Map<number, number>();
  for (const r of rows) {
    if (!r.player) continue;
    if (r.player.position_code) positions[r.player.position_code] = (positions[r.player.position_code] ?? 0) + 1;
    if (r.player.formation_position !== null && r.player.lineup_role === "starter") {
      slots.set(r.player.formation_position, (slots.get(r.player.formation_position) ?? 0) + 1);
    }
  }
  const firstKickoff = (predicate: (r: (typeof rows)[number]) => boolean) => rows.find(predicate)?.observation.kickoff_at ?? null;
  const inSquad = rows.filter((r) => r.player !== null);
  return {
    matches_available: rows.length,
    matches_with_known_status: inSquad.length,
    squad_appearances: inSquad.length,
    starts: rows.filter(started).length,
    start_known_matches: rows.filter((r) => r.startKnown).length,
    bench_unused: inSquad.filter((r) => r.player!.lineup_role === "bench" && r.player!.appeared === false).length,
    bench_appearance_unknown: inSquad.filter((r) => r.player!.lineup_role === "bench" && r.player!.appeared === null).length,
    appearances: rows.filter(played).length,
    appearance_known_matches: rows.filter((r) => r.appearanceKnown).length,
    minutes_total: rows.reduce((n, r) => n + minutes(r), 0),
    minutes_known_matches: rows.filter((r) => r.minutesKnown).length,
    starts_last: windows((r) => (started(r) ? 1 : 0), (r) => r.startKnown),
    appearances_last: windows((r) => (played(r) ? 1 : 0), (r) => r.appearanceKnown),
    minutes_last: windows(minutes, (r) => r.minutesKnown),
    full_regulation_starts: startsWithMinutes.filter(
      (r) => r.player!.minutes_played! >= 90 && (r.player!.exited_minute === null || r.player!.exited_minute >= 90),
    ).length,
    starts_with_known_minutes: startsWithMinutes.length,
    sub_on: subsOn,
    sub_off: subsOff,
    early_exits_before_60: inSquad.filter((r) => r.player!.exited_minute !== null && r.player!.exited_minute < 60).length,
    last_squad_kickoff: firstKickoff((r) => r.player !== null),
    last_appearance_kickoff: firstKickoff(played),
    last_start_kickoff: firstKickoff(started),
    consecutive_starts: consecutive,
    position_histogram: positions,
    formation_slot_histogram: [...slots].map(([slot, count]) => ({ slot, count })).sort((a, b) => a.slot - b.slot),
    captain_starts: rows.filter((r) => started(r) && r.player!.is_captain === true).length,
    observation_ids: inSquad.map((r) => r.observation.observation_id),
  };
}

function provenanceOf(claim: SquadClaimInput): EvidenceProvenance {
  return {
    claim_id: claim.claim_id,
    canonical_claim_id: claim.canonical_claim_id,
    member_claim_ids: [...claim.member_claim_ids],
    claim_kind: claim.claim_kind,
    observed_player_id: claim.observed_player_id,
    polarity: claim.polarity,
    raw_value: claim.object_value,
    resolution_id: claim.resolution_id,
    resolution_claim_id: claim.resolution_claim_id,
    resolution_status: claim.resolution_status,
    resolution_first_seen_at: claim.resolution_first_seen_at,
    quality_flags: [...claim.quality_flags],
  };
}

export function summarizeAvailability(claims: readonly SquadClaimInput[]): AvailabilitySummary {
  const evidence = claims.map((claim): AvailabilityEvidence & { standing: EvidenceStanding } => {
    const status = claim.object_value.status;
    const raw_status = typeof status === "string" ? status : null;
    return {
      ...provenanceOf(claim),
      raw_status,
      category: claim.polarity === "negated" ? "unknown" : normalizeAvailabilityStatus(raw_status),
      standing: standingOf(claim.resolution_status),
    };
  });
  const strip = ({ standing: _standing, ...rest }: AvailabilityEvidence & { standing: EvidenceStanding }): AvailabilityEvidence => rest;
  const accepted = evidence.filter((e) => e.standing === "accepted").map(strip);
  const known = [...new Set(accepted.map((e) => e.category).filter((c): c is Exclude<AvailabilityCategory, "unknown"> => c !== "unknown"))];
  return {
    accepted,
    unresolved: evidence.filter((e) => e.standing === "unresolved").map(strip),
    audit_only: evidence.filter((e) => e.standing === "audit_only").map(strip),
    accepted_category: known.length === 1 ? known[0] : null,
    availability_conflict: known.length > 1,
  };
}

export function summarizeReportedLineup(claims: readonly SquadClaimInput[]): ReportedLineupSummary {
  const evidence = claims.map((claim) => ({ ...provenanceOf(claim), predicate: claim.predicate, standing: standingOf(claim.resolution_status) }));
  const strip = ({ standing: _standing, ...rest }: (typeof evidence)[number]): ReportedLineupEvidence => rest;
  return {
    accepted: evidence.filter((e) => e.standing === "accepted").map(strip),
    unresolved: evidence.filter((e) => e.standing === "unresolved").map(strip),
    audit_only: evidence.filter((e) => e.standing === "audit_only").map(strip),
  };
}

/** Observed historical replacement pairs; never a tactical claim or probability. */
export function buildReplacementPatterns(history: readonly HistoryObservationInput[]): ReplacementPattern[] {
  const patterns = new Map<string, ReplacementPattern>();
  for (const observation of history) {
    for (const s of observation.substitutions) {
      const key = `${s.canonical_player_off_id}>${s.canonical_player_on_id}`;
      const pattern = patterns.get(key) ?? {
        player_off_id: s.canonical_player_off_id,
        player_on_id: s.canonical_player_on_id,
        count: 0,
        minutes: [],
        median_minute: null,
        occurrences: [],
      };
      pattern.count += 1;
      if (s.minute !== null) pattern.minutes.push(s.minute);
      pattern.occurrences.push({
        fixture_id: observation.fixture_id,
        observation_id: observation.observation_id,
        minute: s.minute,
        observed_player_off_id: s.observed_player_off_id,
        observed_player_on_id: s.observed_player_on_id,
      });
      patterns.set(key, pattern);
    }
  }
  return [...patterns.values()]
    .map((p) => ({ ...p, minutes: [...p.minutes].sort((a, b) => a - b), median_minute: median(p.minutes) }))
    .sort((a, b) => b.count - a.count || a.player_off_id.localeCompare(b.player_off_id) || a.player_on_id.localeCompare(b.player_on_id));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Coach state from visible tenures and the selected ledger history. A
 * conflict is reported, never resolved: current_coach_id stays null.
 */
export function buildCoachState(inputs: Pick<SquadStateInputs, "tenures" | "target_date">, history: readonly HistoryObservationInput[]): CoachState {
  const tenures = inputs.tenures.map((t) => ({
    tenure_id: t.tenure_id,
    tenure_key: t.tenure_key,
    tenure_version: t.tenure_version,
    observed_coach_id: t.observed_coach_id,
    canonical_coach_id: t.canonical_coach_id,
    role: t.role,
    coverage: tenureCoversDate(
      {
        startsOn: { earliest: t.starts_on_earliest, latest: t.starts_on_latest },
        endsOn: t.ends_on_earliest !== null && t.ends_on_latest !== null ? { earliest: t.ends_on_earliest, latest: t.ends_on_latest } : null,
        assertionStatus: "asserted",
      },
      inputs.target_date,
    ),
    starts_on_earliest: t.starts_on_earliest,
    starts_on_latest: t.starts_on_latest,
    ends_on_earliest: t.ends_on_earliest,
    ends_on_latest: t.ends_on_latest,
  }));
  const activeTenureCoaches = [...new Set(tenures.filter((t) => t.coverage !== "no").map((t) => t.canonical_coach_id))].sort();
  const latest = history.find((o) => o.canonical_coach_id !== null) ?? null;
  const ledgerCoach = latest?.canonical_coach_id ?? null;
  const counts = new Map<string, { matches: number; last_kickoff: string }>();
  for (const o of history) {
    if (!o.canonical_coach_id) continue;
    const entry = counts.get(o.canonical_coach_id) ?? { matches: 0, last_kickoff: o.kickoff_at };
    entry.matches += 1;
    if (o.kickoff_at > entry.last_kickoff) entry.last_kickoff = o.kickoff_at;
    counts.set(o.canonical_coach_id, entry);
  }
  let provenance: CoachProvenance;
  if (ledgerCoach && activeTenureCoaches.length > 0) {
    provenance = activeTenureCoaches.length === 1 && activeTenureCoaches[0] === ledgerCoach ? "ledger_and_tenure" : "conflict";
  } else if (ledgerCoach) {
    provenance = "ledger_only";
  } else if (activeTenureCoaches.length === 1) {
    provenance = "tenure_only";
  } else if (activeTenureCoaches.length > 1) {
    provenance = "conflict";
  } else {
    provenance = "unknown";
  }
  const current = provenance === "conflict" || provenance === "unknown" ? null : (ledgerCoach ?? activeTenureCoaches[0]);
  return {
    provenance,
    coach_conflict: provenance === "conflict",
    current_coach_id: current,
    candidate_coach_ids: [...new Set([...(ledgerCoach ? [ledgerCoach] : []), ...activeTenureCoaches])].sort(),
    latest_ledger_coach_id: ledgerCoach,
    latest_ledger_observation_id: latest?.observation_id ?? null,
    active_tenure_coach_ids: activeTenureCoaches,
    history_coaches: [...counts]
      .map(([canonical_coach_id, v]) => ({ canonical_coach_id, ...v }))
      .sort((a, b) => b.last_kickoff.localeCompare(a.last_kickoff) || a.canonical_coach_id.localeCompare(b.canonical_coach_id)),
    tenures,
  };
}

// ---------------------------------------------------------------------------
// Loader boundary
// ---------------------------------------------------------------------------

/** Minimal RPC caller (supabase-js .rpc, or a pg/PGlite wrapper in tests). */
export type SquadStateRpc = (
  fn: "squad_state_inputs_as_of",
  args: { p_fixture_id: string; p_team_id: string; p_cutoff: string; p_history_fixture_limit?: number },
) => Promise<unknown>;

/** Loads raw, cutoff-filtered inputs; all leakage filtering happens in the database. */
export async function loadSquadStateInputs(
  rpc: SquadStateRpc,
  params: { fixtureId: string; teamId: string; cutoff: string; historyFixtureLimit?: number },
): Promise<SquadStateInputs> {
  const value = await rpc("squad_state_inputs_as_of", {
    p_fixture_id: params.fixtureId,
    p_team_id: params.teamId,
    p_cutoff: params.cutoff,
    ...(params.historyFixtureLimit === undefined ? {} : { p_history_fixture_limit: params.historyFixtureLimit }),
  });
  return parseSquadStateInputs(value);
}

/** Structural check of the RPC result before it reaches the pure builder. */
export function parseSquadStateInputs(value: unknown): SquadStateInputs {
  if (typeof value !== "object" || value === null) throw new Error("squad-state inputs must be an object");
  const candidate = value as { [key: string]: unknown };
  if (candidate.contract_version !== SQUAD_STATE_INPUTS_CONTRACT_VERSION) throw new Error("unsupported squad-state inputs contract");
  if (candidate.target_date_policy !== SQUAD_TARGET_DATE_POLICY_VERSION) throw new Error("unsupported squad-state target date policy");
  for (const key of ["fixture_id", "team_id", "opponent_team_id", "side", "kickoff_at", "cutoff", "target_date"]) {
    if (typeof candidate[key] !== "string") throw new Error(`squad-state inputs field ${key} must be a string`);
  }
  for (const key of ["history", "memberships", "claims", "tenures"]) {
    if (!Array.isArray(candidate[key])) throw new Error(`squad-state inputs field ${key} must be an array`);
  }
  return value as SquadStateInputs;
}
