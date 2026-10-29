import {
  REPORTED_LINEUP_PREDICATES,
  type AvailabilityCategory,
  type CandidatePresence,
  type FixtureSquadState,
  type HistoryObservationInput,
  type SquadCandidate,
} from "./squad-state";
import { LINEUP_MODEL_VERSION, LINEUP_OUTPUT_CONTRACT_VERSION, LINEUP_PARAMETERS_VERSION } from "./versions";

/**
 * Lineup forecast baseline (V4 Foundation 1D, kapiloto-lineup-model-v1).
 *
 * For one fixture and one team, from a deterministic 1C FixtureSquadState:
 * probabilities that each candidate starts and appears, expected
 * REGULATION-time minutes, and a deterministic modal XI. No database access,
 * no randomness, no model calls: same state + same parameters = same output.
 *
 *   B0  historical Beta-Binomial posterior per player (no fitted coefficient)
 *   M1  accepted reported-lineup claims as transparent pseudo-observations
 *   cap accepted availability probability as an upper bound on starting
 *   team one intercept lambda so the team's start marginals sum to exactly 11
 *
 * A benchmark/challenger baseline: the parameters are uncalibrated, and the
 * modal XI is a modal 11-player set, not a joint XI distribution. There is no
 * bench or squad-selection probability, because 1C has no reliable negative
 * squad observations.
 */

export type BetaPrior = { alpha: number; beta: number };

export type PseudoCounts = {
  start_successes: number;
  start_failures: number;
  appearance_successes: number;
  appearance_failures: number;
};

export type LineupPredicate = (typeof REPORTED_LINEUP_PREDICATES)[number];
type AcceptedStanding = "verified" | "verified_degraded";
type QuantifiedCategory = Exclude<AvailabilityCategory, "unknown">;

export type LineupParameters = {
  version: typeof LINEUP_PARAMETERS_VERSION;
  start_prior: BetaPrior;
  appearance_prior: BetaPrior;
  /** Uncalibrated baseline values, to be benchmarked and replaced. */
  availability_probability: Record<QuantifiedCategory, number>;
  lineup_pseudo_counts: Record<AcceptedStanding, Record<LineupPredicate, PseudoCounts>>;
  starter_minutes_fallback: number;
  sub_minutes_fallback: number;
  /** Probabilities are clamped to [epsilon, 1 - epsilon] only for logit stability. */
  logit_epsilon: number;
  solver: { lambda_min: number; lambda_max: number; iterations: number };
  /** Fixed at 11 by the V1 contract. */
  team_starters: number;
};

/** kapiloto-lineup-parameters-v1 defaults (uncalibrated). */
export const DEFAULT_LINEUP_PARAMETERS: LineupParameters = {
  version: LINEUP_PARAMETERS_VERSION,
  start_prior: { alpha: 1, beta: 1 },
  appearance_prior: { alpha: 1, beta: 1 },
  availability_probability: { available: 0.98, doubtful: 0.6, unavailable: 0.02, suspended: 0, returning: 0.75 },
  lineup_pseudo_counts: {
    verified: {
      starts: { start_successes: 4, start_failures: 0, appearance_successes: 4, appearance_failures: 0 },
      on_bench: { start_successes: 0, start_failures: 4, appearance_successes: 2, appearance_failures: 0 },
      not_in_squad: { start_successes: 0, start_failures: 8, appearance_successes: 0, appearance_failures: 8 },
    },
    verified_degraded: {
      starts: { start_successes: 2, start_failures: 0, appearance_successes: 2, appearance_failures: 0 },
      on_bench: { start_successes: 0, start_failures: 2, appearance_successes: 1, appearance_failures: 0 },
      not_in_squad: { start_successes: 0, start_failures: 4, appearance_successes: 0, appearance_failures: 4 },
    },
  },
  starter_minutes_fallback: 75,
  sub_minutes_fallback: 18,
  logit_epsilon: 1e-6,
  solver: { lambda_min: -60, lambda_max: 60, iterations: 200 },
  team_starters: 11,
};

export const LINEUP_TEAM_STARTERS = 11;
export const LINEUP_SOLVER_MAX_ITERATIONS = 1000;
/** |sum of start marginals - 11| above this means the solver range did not bracket the root. */
export const LINEUP_SOLVER_TOLERANCE = 1e-6;

const QUANTIFIED_CATEGORIES: readonly QuantifiedCategory[] = ["available", "doubtful", "unavailable", "suspended", "returning"];
const STANDINGS: readonly AcceptedStanding[] = ["verified", "verified_degraded"];
const COUNT_FIELDS: readonly (keyof PseudoCounts)[] = ["start_successes", "start_failures", "appearance_successes", "appearance_failures"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((k) => k in value);
}

/**
 * Fail-closed validation of a complete parameter object. Nothing is clamped:
 * a malformed scientific parameter makes the forecast invalid_input.
 */
export function validateLineupParameters(parameters: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(parameters)) return ["parameters must be an object"];
  const p = parameters as Partial<Record<keyof LineupParameters, unknown>>;
  if (p.version !== LINEUP_PARAMETERS_VERSION) issues.push("unsupported parameters version");
  if (p.team_starters !== LINEUP_TEAM_STARTERS) issues.push("team_starters must be 11");
  for (const name of ["start_prior", "appearance_prior"] as const) {
    const prior = p[name];
    if (!exactKeys(prior, ["alpha", "beta"]) || !finite(prior.alpha) || !finite(prior.beta) || prior.alpha <= 0 || prior.beta <= 0) {
      issues.push(`${name} alpha and beta must be finite and > 0`);
    }
  }
  const availability = p.availability_probability;
  if (!exactKeys(availability, QUANTIFIED_CATEGORIES)) issues.push("availability_probability must list exactly the five quantified categories");
  else for (const category of QUANTIFIED_CATEGORIES) {
    const v = availability[category];
    if (!finite(v) || v < 0 || v > 1) issues.push(`availability_probability.${category} must be in [0, 1]`);
  }
  const counts = p.lineup_pseudo_counts;
  if (!exactKeys(counts, STANDINGS)) issues.push("lineup_pseudo_counts must list verified and verified_degraded");
  else for (const standing of STANDINGS) {
    const byPredicate = counts[standing];
    if (!exactKeys(byPredicate, REPORTED_LINEUP_PREDICATES)) {
      issues.push(`lineup_pseudo_counts.${standing} must list starts, on_bench and not_in_squad`);
      continue;
    }
    for (const predicate of REPORTED_LINEUP_PREDICATES) {
      const c = byPredicate[predicate];
      if (!exactKeys(c, COUNT_FIELDS) || COUNT_FIELDS.some((f) => !Number.isInteger(c[f]) || (c[f] as number) < 0)) {
        issues.push(`lineup_pseudo_counts.${standing}.${predicate} must be non-negative integers`);
      }
    }
  }
  for (const name of ["starter_minutes_fallback", "sub_minutes_fallback"] as const) {
    const v = p[name];
    if (!finite(v) || v < 0 || v > 90) issues.push(`${name} must be in [0, 90]`);
  }
  if (!finite(p.logit_epsilon) || p.logit_epsilon <= 0 || p.logit_epsilon >= 0.5) issues.push("logit_epsilon must be in (0, 0.5)");
  const solver = p.solver;
  if (
    !exactKeys(solver, ["lambda_min", "lambda_max", "iterations"]) ||
    !finite(solver.lambda_min) || !finite(solver.lambda_max) || solver.lambda_min >= solver.lambda_max ||
    !Number.isInteger(solver.iterations) || (solver.iterations as number) < 1 || (solver.iterations as number) > LINEUP_SOLVER_MAX_ITERATIONS
  ) {
    issues.push(`solver needs finite lambda_min < lambda_max and 1..${LINEUP_SOLVER_MAX_ITERATIONS} iterations`);
  }
  const known = new Set(Object.keys(DEFAULT_LINEUP_PARAMETERS));
  for (const key of Object.keys(parameters)) if (!known.has(key)) issues.push(`unknown parameter ${key}`);
  return issues;
}

export const LINEUP_MODEL_STATUSES = ["projected", "insufficient_candidates", "insufficient_start_capacity", "invalid_input"] as const;
export type LineupModelStatus = (typeof LINEUP_MODEL_STATUSES)[number];

export type LineupPlayerOutput = {
  canonical_player_id: string;
  observed_player_ids: string[];
  presence: CandidatePresence;
  history: {
    start_successes: number;
    start_trials: number;
    appearance_successes: number;
    appearance_trials: number;
    starter_minutes_samples: number;
    sub_minutes_samples: number;
    start_prior_only: boolean;
  };
  availability: {
    status: "quantified" | "unknown" | "conflict";
    category: QuantifiedCategory | null;
    probability_bp: number | null;
  };
  lineup_evidence: {
    /** Recognized and unrecognized predicates of affirmed accepted reports. */
    accepted_predicates: string[];
    /** The pseudo-counts actually applied (null when none, conflicting or suppressed). */
    applied: { predicate: LineupPredicate; standing: AcceptedStanding; counts: PseudoCounts } | null;
  };
  raw_start_probability_bp: number;
  raw_appearance_probability_bp: number;
  start_cap_bp: number;
  projected_start_probability_bp: number | null;
  appearance_probability_bp: number | null;
  expected_regulation_minutes_tenths: number | null;
  starter_minutes_mean_tenths: number;
  used_starter_minutes_fallback: boolean;
  sub_minutes_mean_tenths: number;
  used_sub_minutes_fallback: boolean;
  in_modal_xi: boolean;
  /** Short auditable reason codes; never free-text reasoning. */
  adjustments: string[];
  conflict_flags: ("availability_conflict" | "lineup_evidence_conflict" | "cross_evidence_conflict")[];
  quality_flags: string[];
};

export type LineupForecastOutput = {
  contract_version: typeof LINEUP_OUTPUT_CONTRACT_VERSION;
  model_version: typeof LINEUP_MODEL_VERSION;
  parameters_version: string;
  parameters: LineupParameters;
  fixture_id: string;
  subject_team_id: string;
  squad_state_sha256: string;
  status: LineupModelStatus;
  /** Why the status is invalid_input (empty otherwise). */
  invalid_reasons: string[];
  /** Team intercept in micro-units (lambda * 1e6, rounded); null unless projected. */
  team_lambda_micro: number | null;
  /** 110000 when projected; null otherwise. */
  team_start_total_bp: number | null;
  /** Exactly 11 canonical ids when projected; empty otherwise. A modal set, not a joint distribution. */
  modal_xi: string[];
  /** Empty when the parameters are invalid (no per-player output is trustworthy then). */
  players: LineupPlayerOutput[];
  quality: {
    candidate_count: number;
    start_known_samples: number;
    appearance_known_samples: number;
    players_start_prior_only: number;
    players_starter_minutes_fallback: number;
    players_sub_minutes_fallback: number;
    availability_unknown: number;
    availability_conflicts: number;
    lineup_evidence_conflicts: number;
    cross_evidence_conflicts: number;
    provider_fallback_count: number;
    coach_conflict: boolean;
  };
};

export type LineupModelInput = {
  state: FixtureSquadState;
  /** SHA-256 of the exact canonical state bytes, frozen with the forecast. */
  squad_state_sha256: string;
  /** The state's selected ledger observations (minutes samples are read from them). */
  selected_history: readonly HistoryObservationInput[];
};

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const toBp = (p: number) => Math.round(clamp(p, 0, 1) * 10000);

type Working = {
  candidate: SquadCandidate;
  raw_start: number;
  raw_appearance: number;
  cap: number;
  cap_bp: number;
  output: LineupPlayerOutput;
  starter_minutes: number;
  sub_minutes: number;
};

/** Pure and deterministic. */
export function buildLineupForecast(input: LineupModelInput, parameters: LineupParameters = DEFAULT_LINEUP_PARAMETERS): LineupForecastOutput {
  const { state } = input;
  const base = {
    contract_version: LINEUP_OUTPUT_CONTRACT_VERSION,
    model_version: LINEUP_MODEL_VERSION,
    parameters_version: isRecord(parameters) && typeof parameters.version === "string" ? parameters.version : "invalid",
    parameters,
    fixture_id: state.fixture.fixture_id,
    subject_team_id: state.fixture.team_id,
    squad_state_sha256: input.squad_state_sha256,
  } as const;
  const notProjected = { team_lambda_micro: null, team_start_total_bp: null, modal_xi: [] as string[] };

  const parameterIssues = validateLineupParameters(parameters);
  if (parameterIssues.length > 0) {
    return { ...base, status: "invalid_input", invalid_reasons: parameterIssues, ...notProjected, players: [], quality: summarizeQuality([], state) };
  }

  const invalid: string[] = [];
  if (!/^[0-9a-f]{64}$/.test(input.squad_state_sha256)) invalid.push("malformed squad-state hash");
  const selectedIds = [...input.selected_history.map((o) => o.observation_id)].sort();
  const expectedIds = [...state.provenance.ledger_observation_ids].sort();
  if (selectedIds.length !== expectedIds.length || selectedIds.some((id, i) => id !== expectedIds[i])) invalid.push("selected history is not the state's selection");

  const working = state.candidates.map((candidate) => assessPlayer(candidate, input.selected_history, parameters));
  const quality = summarizeQuality(working, state);
  const players = () => working.map((w) => w.output);
  if (invalid.length > 0) return { ...base, status: "invalid_input", invalid_reasons: invalid, ...notProjected, players: players(), quality };

  const n = LINEUP_TEAM_STARTERS;
  let status: LineupModelStatus = "projected";
  if (working.length < n) status = "insufficient_candidates";
  else if (working.reduce((sum, w) => sum + w.cap_bp, 0) < n * 10000) status = "insufficient_start_capacity";
  if (status !== "projected") return { ...base, status, invalid_reasons: [], ...notProjected, players: players(), quality };

  const { lambda, probabilities } = projectTeamStarts(working.map((w) => ({ raw: w.raw_start, cap: w.cap })), n, parameters);
  if (Math.abs(probabilities.reduce((a, b) => a + b, 0) - n) > LINEUP_SOLVER_TOLERANCE) {
    return { ...base, status: "invalid_input", invalid_reasons: ["solver range does not bracket the team intercept"], ...notProjected, players: players(), quality };
  }
  const startBp = allocateBasisPoints(
    working.map((w, i) => ({ id: w.candidate.canonical_player_id, value: probabilities[i] * 10000, cap: w.cap_bp })),
    n * 10000,
  );
  const ranked = working
    .map((w, i) => ({ id: w.candidate.canonical_player_id, bp: startBp[i] }))
    .sort((a, b) => b.bp - a.bp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const modal = new Set(ranked.slice(0, n).map((r) => r.id));

  const projected = working.map((w, i) => {
    const start = startBp[i];
    const appearance = Math.max(start, Math.min(w.cap_bp, toBp(w.raw_appearance)));
    const minutes = (start / 10000) * w.starter_minutes + (Math.max(0, appearance - start) / 10000) * w.sub_minutes;
    return {
      ...w.output,
      projected_start_probability_bp: start,
      appearance_probability_bp: appearance,
      expected_regulation_minutes_tenths: clamp(Math.round(minutes * 10), 0, 900),
      in_modal_xi: modal.has(w.candidate.canonical_player_id),
    };
  });
  return {
    ...base,
    status,
    invalid_reasons: [],
    team_lambda_micro: Math.round(lambda * 1e6),
    team_start_total_bp: startBp.reduce((a, b) => a + b, 0),
    modal_xi: [...modal].sort(),
    players: projected,
    quality,
  };
}

function assessPlayer(candidate: SquadCandidate, history: readonly HistoryObservationInput[], parameters: LineupParameters): Working {
  const adjustments: string[] = [];
  const conflict_flags: LineupPlayerOutput["conflict_flags"] = [];
  const quality_flags: string[] = [];

  // Availability family (accepted 1C evidence only).
  const availability = candidate.availability;
  let availabilityStatus: LineupPlayerOutput["availability"]["status"] = "unknown";
  let availabilityProbability: number | null = null;
  if (availability.availability_conflict) {
    availabilityStatus = "conflict";
    conflict_flags.push("availability_conflict");
  } else if (availability.accepted_category !== null) {
    availabilityStatus = "quantified";
    availabilityProbability = parameters.availability_probability[availability.accepted_category];
    if (availability.accepted.some((e) => e.resolution_status === "verified_degraded")) quality_flags.push("availability_verified_degraded");
  }

  // Reported-lineup family: affirmed accepted reports only. A negated report
  // ("X will not start") is never guessed into a predicate, exactly as 1C
  // keeps negated availability claims unknown.
  const acceptedReports = candidate.reported_lineup.accepted;
  const affirmed = acceptedReports.filter((e) => e.polarity === "affirmed");
  if (affirmed.length !== acceptedReports.length) quality_flags.push("negated_lineup_report_ignored");
  const predicates = [...new Set(affirmed.map((e) => e.predicate))].sort();
  const known = predicates.filter((p): p is LineupPredicate => (REPORTED_LINEUP_PREDICATES as readonly string[]).includes(p));
  if (known.length !== predicates.length) quality_flags.push("unrecognized_lineup_predicate");
  let candidateCounts: LineupPlayerOutput["lineup_evidence"]["applied"] = null;
  if (known.length > 1) {
    conflict_flags.push("lineup_evidence_conflict");
  } else if (known.length === 1) {
    const standing: AcceptedStanding = affirmed.some((e) => e.predicate === known[0] && e.resolution_status === "verified") ? "verified" : "verified_degraded";
    candidateCounts = { predicate: known[0], standing, counts: parameters.lineup_pseudo_counts[standing][known[0]] };
  }

  // Cross-family contradiction, decided on the RAW accepted evidence sets (not
  // on what survived each family's summarization): any accepted
  // unavailable/suspended claim together with any affirmed accepted
  // starts/on_bench report. It holds even when a family is itself conflicted.
  const hasUnavailableLikeAccepted = availability.accepted.some((e) => e.category === "unavailable" || e.category === "suspended");
  const hasSquadPresenceReportAccepted = affirmed.some((e) => e.predicate === "starts" || e.predicate === "on_bench");
  const cross = hasUnavailableLikeAccepted && hasSquadPresenceReportAccepted;
  if (cross) {
    conflict_flags.push("cross_evidence_conflict");
    adjustments.push("claim_adjustments_suppressed_cross_conflict");
  }
  const applied = cross ? null : candidateCounts;
  const counts = applied?.counts ?? null;
  if (applied) adjustments.push(`lineup_report_${applied.predicate}_${applied.standing}`);

  // B0 posteriors (+ M1 pseudo-counts).
  const f = candidate.history;
  const startSuccesses = f.starts_last.last_10.value;
  const startTrials = f.starts_last.last_10.available_matches;
  const appearanceSuccesses = f.appearances_last.last_10.value;
  const appearanceTrials = f.appearances_last.last_10.available_matches;
  const sp = parameters.start_prior;
  const ap = parameters.appearance_prior;
  const rawStart =
    (startSuccesses + sp.alpha + (counts?.start_successes ?? 0)) /
    (startTrials + sp.alpha + sp.beta + (counts ? counts.start_successes + counts.start_failures : 0));
  const rawAppearance =
    (appearanceSuccesses + ap.alpha + (counts?.appearance_successes ?? 0)) /
    (appearanceTrials + ap.alpha + ap.beta + (counts ? counts.appearance_successes + counts.appearance_failures : 0));
  if (startTrials === 0) quality_flags.push("start_prior_only");
  if (appearanceTrials === 0) quality_flags.push("appearance_prior_only");

  // The availability cap applies only when quantified and not cross-conflicting.
  const cap = availabilityStatus === "quantified" && !cross ? availabilityProbability! : 1;
  if (cap < 1) adjustments.push("availability_cap");
  const capBp = Math.floor(cap * 10000 + 1e-9);

  // Conditional regulation minutes from role-known rows only (capped at 90):
  // starter rows with explicit minutes; bench rows with appeared = true and
  // explicit minutes. lineup_role = unknown enters neither family.
  const starterSamples: number[] = [];
  const subSamples: number[] = [];
  for (const observation of history) {
    const row = observation.players.find((p) => p.canonical_player_id === candidate.canonical_player_id);
    if (!row || row.minutes_played === null) continue;
    if (row.lineup_role === "starter") starterSamples.push(Math.min(row.minutes_played, 90));
    else if (row.lineup_role === "bench" && row.appeared === true) subSamples.push(Math.min(row.minutes_played, 90));
  }
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const starterMinutes = starterSamples.length > 0 ? mean(starterSamples) : parameters.starter_minutes_fallback;
  const subMinutes = subSamples.length > 0 ? mean(subSamples) : parameters.sub_minutes_fallback;

  const output: LineupPlayerOutput = {
    canonical_player_id: candidate.canonical_player_id,
    observed_player_ids: [...candidate.observed_player_ids],
    presence: candidate.presence,
    history: {
      start_successes: startSuccesses,
      start_trials: startTrials,
      appearance_successes: appearanceSuccesses,
      appearance_trials: appearanceTrials,
      starter_minutes_samples: starterSamples.length,
      sub_minutes_samples: subSamples.length,
      start_prior_only: startTrials === 0,
    },
    availability: {
      status: availabilityStatus,
      category: availabilityStatus === "quantified" ? availability.accepted_category : null,
      probability_bp: availabilityProbability === null ? null : toBp(availabilityProbability),
    },
    lineup_evidence: { accepted_predicates: predicates, applied },
    raw_start_probability_bp: toBp(rawStart),
    raw_appearance_probability_bp: toBp(rawAppearance),
    start_cap_bp: capBp,
    projected_start_probability_bp: null,
    appearance_probability_bp: null,
    expected_regulation_minutes_tenths: null,
    starter_minutes_mean_tenths: Math.round(starterMinutes * 10),
    used_starter_minutes_fallback: starterSamples.length === 0,
    sub_minutes_mean_tenths: Math.round(subMinutes * 10),
    used_sub_minutes_fallback: subSamples.length === 0,
    in_modal_xi: false,
    adjustments,
    conflict_flags,
    quality_flags,
  };
  return { candidate, raw_start: rawStart, raw_appearance: rawAppearance, cap, cap_bp: capBp, output, starter_minutes: starterMinutes, sub_minutes: subMinutes };
}

/**
 * One intercept lambda for the team: p_i = min(cap_i, sigmoid(logit(raw_i) +
 * lambda)), with sum p_i = n. The sum is monotone in lambda, so bisection is
 * deterministic. Caller guarantees n candidates and sum(caps) >= n, and checks
 * that the returned marginals actually sum to n (the range brackets the root).
 */
export function projectTeamStarts(
  players: readonly { raw: number; cap: number }[],
  n: number,
  parameters: Pick<LineupParameters, "logit_epsilon" | "solver">,
): { lambda: number; probabilities: number[] } {
  const eps = parameters.logit_epsilon;
  const logits = players.map((p) => logit(clamp(p.raw, eps, 1 - eps)));
  const at = (lambda: number) => players.map((p, i) => Math.min(p.cap, sigmoid(logits[i] + lambda)));
  const total = (lambda: number) => at(lambda).reduce((a, b) => a + b, 0);
  let lo = parameters.solver.lambda_min;
  let hi = parameters.solver.lambda_max;
  for (let i = 0; i < parameters.solver.iterations; i += 1) {
    const mid = (lo + hi) / 2;
    if (total(mid) < n) lo = mid;
    else hi = mid;
  }
  return { lambda: hi, probabilities: at(hi) };
}

/**
 * Integer basis points summing to exactly `target`: floor each value (never
 * above its integer cap), then hand out the remaining points one at a time to
 * the largest remainders among players below their cap, ties by id.
 */
export function allocateBasisPoints(players: readonly { id: string; value: number; cap: number }[], target: number): number[] {
  const result = players.map((p) => Math.min(Math.floor(p.value + 1e-9), p.cap));
  let remaining = target - result.reduce((a, b) => a + b, 0);
  // Floating-point overshoot: take points back from the smallest remainders.
  while (remaining < 0) {
    const donors = players
      .map((p, i) => ({ i, id: p.id, remainder: p.value - result[i] }))
      .filter((e) => result[e.i] > 0)
      .sort((a, b) => a.remainder - b.remainder || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    for (const e of donors) {
      if (remaining === 0) break;
      result[e.i] -= 1;
      remaining += 1;
    }
  }
  while (remaining > 0) {
    const eligible = players
      .map((p, i) => ({ i, id: p.id, remainder: p.value - result[i] }))
      .filter((e) => result[e.i] < players[e.i].cap)
      .sort((a, b) => b.remainder - a.remainder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (eligible.length === 0) throw new Error("basis-point allocation exceeds the caps");
    for (const e of eligible) {
      if (remaining === 0) break;
      result[e.i] += 1;
      remaining -= 1;
    }
  }
  return result;
}

function summarizeQuality(working: readonly Working[], state: FixtureSquadState): LineupForecastOutput["quality"] {
  const has = (w: Working, flag: LineupPlayerOutput["conflict_flags"][number]) => w.output.conflict_flags.includes(flag);
  return {
    candidate_count: state.candidates.length,
    start_known_samples: working.reduce((n, w) => n + w.output.history.start_trials, 0),
    appearance_known_samples: working.reduce((n, w) => n + w.output.history.appearance_trials, 0),
    players_start_prior_only: working.filter((w) => w.output.history.start_prior_only).length,
    players_starter_minutes_fallback: working.filter((w) => w.output.used_starter_minutes_fallback).length,
    players_sub_minutes_fallback: working.filter((w) => w.output.used_sub_minutes_fallback).length,
    availability_unknown: working.filter((w) => w.output.availability.status === "unknown").length,
    availability_conflicts: working.filter((w) => has(w, "availability_conflict")).length,
    lineup_evidence_conflicts: working.filter((w) => has(w, "lineup_evidence_conflict")).length,
    cross_evidence_conflicts: working.filter((w) => has(w, "cross_evidence_conflict")).length,
    provider_fallback_count: state.quality.provider_fallback_count,
    coach_conflict: state.quality.coach_conflict,
  };
}

// ---------------------------------------------------------------------------
// Output contract validation (kapiloto-lineup-output-v1)
// ---------------------------------------------------------------------------

const isBp = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10000;

/**
 * Validates a stored lineup estimate against the V1 output contract (not the
 * formula). `expected` pins it to the snapshot it is recorded with.
 */
export function validateLineupForecastOutput(
  output: LineupForecastOutput,
  expected: { fixtureId: string; subjectTeamId: string; squadStateSha256: string },
): string[] {
  const issues: string[] = [];
  if (output.contract_version !== LINEUP_OUTPUT_CONTRACT_VERSION) issues.push("unsupported output contract");
  if (output.model_version !== LINEUP_MODEL_VERSION) issues.push("unsupported model version");
  if (output.parameters_version !== LINEUP_PARAMETERS_VERSION && output.status !== "invalid_input") issues.push("unsupported parameters version");
  if (!(LINEUP_MODEL_STATUSES as readonly string[]).includes(output.status)) issues.push("unknown status");
  if (output.fixture_id !== expected.fixtureId.toLowerCase()) issues.push("fixture does not match the snapshot");
  if (output.subject_team_id !== expected.subjectTeamId.toLowerCase()) issues.push("subject team does not match the snapshot");
  if (output.squad_state_sha256 !== expected.squadStateSha256) issues.push("squad-state hash does not match the frozen context");
  if (!Array.isArray(output.players) || !Array.isArray(output.modal_xi)) return [...issues, "players and modal_xi must be arrays"];

  const ids = output.players.map((p) => p.canonical_player_id);
  if (new Set(ids).size !== ids.length) issues.push("duplicate player ids");
  for (const p of output.players) {
    if (!isBp(p.raw_start_probability_bp) || !isBp(p.raw_appearance_probability_bp) || !isBp(p.start_cap_bp)) issues.push(`player ${p.canonical_player_id} has out-of-range raw values or cap`);
  }

  if (output.status === "projected") {
    if (output.team_start_total_bp !== LINEUP_TEAM_STARTERS * 10000) issues.push("team start total must be 110000");
    const modal = new Set(output.modal_xi);
    if (output.modal_xi.length !== LINEUP_TEAM_STARTERS || modal.size !== LINEUP_TEAM_STARTERS) issues.push("modal XI must hold exactly 11 unique players");
    for (const id of modal) if (ids.filter((x) => x === id).length !== 1) issues.push(`modal XI player ${id} is not exactly one output player`);
    let sum = 0;
    for (const p of output.players) {
      const start = p.projected_start_probability_bp;
      const appearance = p.appearance_probability_bp;
      const minutes = p.expected_regulation_minutes_tenths;
      if (p.in_modal_xi !== modal.has(p.canonical_player_id)) issues.push(`player ${p.canonical_player_id} in_modal_xi disagrees with modal_xi`);
      if (!isBp(start)) { issues.push(`player ${p.canonical_player_id} projected start must be an integer in 0..10000`); continue; }
      sum += start;
      if (start > p.start_cap_bp) issues.push(`player ${p.canonical_player_id} starts above the cap`);
      if (!isBp(appearance)) issues.push(`player ${p.canonical_player_id} appearance must be an integer in 0..10000`);
      else {
        if (appearance < start) issues.push(`player ${p.canonical_player_id} appearance is below start`);
        if (appearance > p.start_cap_bp) issues.push(`player ${p.canonical_player_id} appearance exceeds the cap`);
      }
      if (!Number.isInteger(minutes) || (minutes as number) < 0 || (minutes as number) > 900) issues.push(`player ${p.canonical_player_id} expected minutes must be an integer in 0..900 tenths`);
    }
    if (sum !== LINEUP_TEAM_STARTERS * 10000) issues.push("player projected starts must sum to 110000");
    if (!Number.isInteger(output.team_lambda_micro)) issues.push("team intercept must be an integer");
  } else {
    if (output.modal_xi.length !== 0) issues.push("only a projected forecast has a modal XI");
    if (output.team_start_total_bp !== null || output.team_lambda_micro !== null) issues.push("only a projected forecast has team totals");
    for (const p of output.players) {
      if (p.projected_start_probability_bp !== null || p.appearance_probability_bp !== null || p.expected_regulation_minutes_tenths !== null || p.in_modal_xi) {
        issues.push(`player ${p.canonical_player_id} has projected values on a ${output.status} forecast`);
      }
    }
  }
  if (output.status === "invalid_input" ? output.invalid_reasons.length === 0 : output.invalid_reasons.length !== 0) issues.push("invalid_reasons must be given exactly for invalid_input");
  return issues;
}
