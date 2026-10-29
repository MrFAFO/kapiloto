import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256 } from "./canonical-json";
import {
  DEFAULT_LINEUP_PARAMETERS,
  allocateBasisPoints,
  buildLineupForecast,
  projectTeamStarts,
  validateLineupForecastOutput,
  validateLineupParameters,
  type LineupForecastOutput,
  type LineupParameters,
  type LineupPlayerOutput,
} from "./lineup-model";
import { buildLineupForecastSnapshot, lineupModelInput, recordLineupForecastSnapshot, squadStateSha256 } from "./lineup-snapshot";
import type { MembershipAsOfRow } from "./roster";
import {
  buildFixtureSquadState,
  historySelectionPolicy,
  type HistoryObservationInput,
  type HistoryPlayerInput,
  type SquadClaimInput,
  type SquadStateInputs,
} from "./squad-state";
import { SQUAD_STATE_INPUTS_CONTRACT_VERSION } from "./versions";

/**
 * kapiloto-lineup-model-v1 on synthetic 1C states: B0 Beta posteriors, M1
 * claim pseudo-counts, availability caps, conflicts, the team projection,
 * the exact 110000 bp invariant, the modal XI and regulation minutes.
 */

const TEAM = "a0000000-0000-4000-8000-000000000001";
const OPPONENT = "b0000000-0000-4000-8000-000000000001";
const COACH = "d0000000-0000-4000-8000-000000000001";
const P = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const POLICY = historySelectionPolicy(["sportmonks"]);

function row(id: string, role: "starter" | "bench", minutes: number | null, appeared: boolean | null = role === "starter" ? true : minutes !== null && minutes > 0): HistoryPlayerInput {
  return {
    observed_player_id: id,
    canonical_player_id: id,
    lineup_role: role,
    appeared,
    position_code: role === "starter" ? "MF" : null,
    formation_position: role === "starter" ? 6 : null,
    is_captain: false,
    minutes_played: minutes,
    entered_minute: role === "starter" ? 0 : null,
    exited_minute: null,
  };
}

function fixture(i: number, players: HistoryPlayerInput[], lineupStatus: HistoryObservationInput["lineup_status"] = "complete"): HistoryObservationInput {
  const d = String(i).padStart(2, "0");
  return {
    observation_id: `obs-${d}`,
    fixture_id: `fx-${d}`,
    provider: "sportmonks",
    observation_version: 1,
    first_seen_at: `2026-10-${d}T21:00:00+00:00`,
    kickoff_at: `2026-10-${d}T18:00:00+00:00`,
    side: "home",
    opponent_team_id: OPPONENT,
    observed_coach_id: COACH,
    canonical_coach_id: COACH,
    lineup_status: lineupStatus,
    substitutions_status: "complete",
    players,
    substitutions: [],
  };
}

function membership(player: string): MembershipAsOfRow {
  return {
    membership_id: `m-${player.slice(-4)}`,
    membership_key: `k-${player.slice(-4)}`,
    membership_version: 1,
    team_id: TEAM,
    observed_player_id: player,
    canonical_player_id: player,
    squad_group: "first_team",
    shirt_number: null,
    starts_on_earliest: "2026-07-01",
    starts_on_latest: "2026-07-01",
    ends_on_earliest: null,
    ends_on_latest: null,
    coverage: "certain",
    source_kind: "official_club",
    provider: null,
    provider_record_id: null,
    source_reference: null,
    document_version_id: null,
    first_seen_at: "2026-09-01T00:00:00+00:00",
  };
}

function claim(
  player: string,
  type: "player_availability" | "expected_lineup",
  value: string,
  resolution: SquadClaimInput["resolution_status"],
  overrides: Partial<SquadClaimInput> = {},
): SquadClaimInput {
  const id = `claim-${player.slice(-4)}-${value}-${resolution}${overrides.polarity === "negated" ? "-negated" : ""}`;
  const accepted = resolution !== "unresolved";
  return {
    claim_id: id,
    canonical_claim_id: id,
    member_claim_ids: [id],
    claim_kind: "reported_expectation",
    claim_type: type,
    predicate: type === "player_availability" ? "availability_status" : value,
    team_id: TEAM,
    observed_player_id: player,
    canonical_player_id: player,
    object_value: type === "player_availability" ? { status: value } : {},
    polarity: "affirmed",
    claim_first_seen_at: "2026-10-28T09:00:00+00:00",
    resolution_id: accepted ? `res-${id}` : null,
    resolution_claim_id: accepted ? id : null,
    resolution_status: resolution,
    resolution_first_seen_at: accepted ? "2026-10-29T09:00:00+00:00" : null,
    quality_flags: resolution === "verified_degraded" ? ["missing_author"] : [],
    ...overrides,
  };
}

/**
 * Ten complete fixtures (most recent = fx-10):
 *   P1-P8  start all ten (90'); P9 starts all ten (100' in fx-01, else 60');
 *   P10    starts all ten (60');
 *   P11    starts fx-01..07 (90'), comes on in fx-08..10 (30');
 *   P12    starts fx-08..10 (90'), comes on in fx-01..04 (20'), unused fx-05..07;
 *   P13    unused bench every match; P14 comes on fx-01..05 (15'), unused after;
 *   P15/P16 unused bench; P17 roster-only (never in a matchday squad).
 */
function squadHistory(): HistoryObservationInput[] {
  return Array.from({ length: 10 }, (_, k) => {
    const i = k + 1;
    const players: HistoryPlayerInput[] = [];
    for (let n = 1; n <= 8; n += 1) players.push(row(P(n), "starter", 90));
    players.push(row(P(9), "starter", i === 1 ? 100 : 60));
    players.push(row(P(10), "starter", 60));
    players.push(i <= 7 ? row(P(11), "starter", 90) : row(P(11), "bench", 30));
    players.push(i >= 8 ? row(P(12), "starter", 90) : i <= 4 ? row(P(12), "bench", 20) : row(P(12), "bench", 0, false));
    players.push(row(P(13), "bench", 0, false));
    players.push(i <= 5 ? row(P(14), "bench", 15) : row(P(14), "bench", 0, false));
    players.push(row(P(15), "bench", 0, false));
    players.push(row(P(16), "bench", 0, false));
    return fixture(i, players);
  });
}

function inputs(overrides: Partial<SquadStateInputs> = {}): SquadStateInputs {
  return {
    contract_version: SQUAD_STATE_INPUTS_CONTRACT_VERSION,
    fixture_id: "fx-target",
    team_id: TEAM,
    opponent_team_id: OPPONENT,
    side: "home",
    kickoff_at: "2026-11-02T18:00:00+00:00",
    cutoff: "2026-10-30T12:00:00+00:00",
    target_date: "2026-11-02",
    target_date_policy: "kapiloto-target-date-utc-v1",
    history: squadHistory(),
    memberships: Array.from({ length: 17 }, (_, k) => membership(P(k + 1))),
    claims: [],
    tenures: [],
    ...overrides,
  };
}

function forecast(inp: SquadStateInputs, parameters?: LineupParameters): LineupForecastOutput {
  const state = buildFixtureSquadState(inp, POLICY);
  return buildLineupForecast(lineupModelInput(inp, state), parameters);
}

const player = (output: LineupForecastOutput, n: number): LineupPlayerOutput => {
  const found = output.players.find((p) => p.canonical_player_id === P(n));
  assert.ok(found, `player ${n} is a candidate`);
  return found;
};
const bp = (numerator: number, denominator: number) => Math.round((numerator / denominator) * 10000);

test("B0: Beta(1,1) posteriors over last-10 known starts and appearances", () => {
  const output = forecast(inputs());
  assert.equal(output.status, "projected");
  assert.equal(output.parameters_version, "kapiloto-lineup-parameters-v1");
  assert.deepEqual(output.parameters, DEFAULT_LINEUP_PARAMETERS);

  // (successes + 1) / (known + 2).
  assert.deepEqual([player(output, 1).raw_start_probability_bp, player(output, 1).raw_appearance_probability_bp], [bp(11, 12), bp(11, 12)]);
  assert.deepEqual([player(output, 11).raw_start_probability_bp, player(output, 11).raw_appearance_probability_bp], [bp(8, 12), bp(11, 12)]);
  assert.deepEqual([player(output, 12).raw_start_probability_bp, player(output, 12).raw_appearance_probability_bp], [bp(4, 12), bp(8, 12)]);
  assert.deepEqual([player(output, 13).raw_start_probability_bp, player(output, 13).raw_appearance_probability_bp], [bp(1, 12), bp(1, 12)]);
  assert.deepEqual(player(output, 12).history, {
    start_successes: 3, start_trials: 10, appearance_successes: 7, appearance_trials: 10,
    starter_minutes_samples: 3, sub_minutes_samples: 4, start_prior_only: false,
  });
  // Roster-only: absence from a complete lineup is a known non-start, but its
  // appearance is unknown, so the appearance posterior is the prior alone.
  const rosterOnly = player(output, 17);
  assert.deepEqual([rosterOnly.raw_start_probability_bp, rosterOnly.raw_appearance_probability_bp], [bp(1, 12), 5000]);
  assert.ok(rosterOnly.quality_flags.includes("appearance_prior_only"));
  assert.equal(rosterOnly.quality_flags.includes("start_prior_only"), false);

  // Unknown is not zero: a partial lineup that omits a player adds no trial.
  const partial = inputs({ history: [fixture(11, [row(P(1), "starter", 90)], "partial"), ...squadHistory().slice(1)] });
  const withPartial = forecast(partial);
  assert.deepEqual([player(withPartial, 2).history.start_successes, player(withPartial, 2).history.start_trials], [9, 9]);
  // No history at all: every player is prior-only (0.5).
  const empty = forecast(inputs({ history: [] }));
  assert.ok(empty.players.every((p) => p.raw_start_probability_bp === 5000 && p.history.start_prior_only && p.quality_flags.includes("start_prior_only")));
  assert.equal(empty.quality.players_start_prior_only, 17);

  // Injectable, versioned parameters.
  const stronger = forecast(inputs(), { ...DEFAULT_LINEUP_PARAMETERS, start_prior: { alpha: 2, beta: 8 } });
  assert.equal(player(stronger, 13).raw_start_probability_bp, bp(2, 20));
});

test("availability: explicit category probabilities cap starts; conflicts and unknowns add no cap", () => {
  const output = forecast(inputs({
    claims: [
      claim(P(2), "player_availability", "doubtful", "verified"),
      claim(P(3), "player_availability", "out", "verified"),
      claim(P(4), "player_availability", "banned", "verified"),
      claim(P(5), "player_availability", "back in training", "verified"),
      claim(P(6), "player_availability", "fit", "verified"),
      claim(P(7), "player_availability", "fit", "verified"),
      claim(P(7), "player_availability", "out", "verified"),
      claim(P(8), "player_availability", "rotation risk", "verified"),
      claim(P(9), "player_availability", "out", "unresolved"),
      claim(P(10), "player_availability", "out", "verified_degraded"),
    ],
  }));
  assert.equal(output.status, "projected");
  const availability = (n: number) => [player(output, n).availability.status, player(output, n).availability.category, player(output, n).availability.probability_bp, player(output, n).start_cap_bp];
  assert.deepEqual(availability(2), ["quantified", "doubtful", 6000, 6000]);
  assert.deepEqual(availability(3), ["quantified", "unavailable", 200, 200]);
  assert.deepEqual(availability(4), ["quantified", "suspended", 0, 0]);
  assert.deepEqual(availability(5), ["quantified", "returning", 7500, 7500]);
  assert.deepEqual(availability(6), ["quantified", "available", 9800, 9800]);
  assert.deepEqual(availability(7), ["conflict", null, null, 10000]);
  assert.deepEqual(availability(8), ["unknown", null, null, 10000]);
  assert.deepEqual(availability(9), ["unknown", null, null, 10000]);
  assert.deepEqual(availability(10), ["quantified", "unavailable", 200, 200]);
  assert.ok(player(output, 10).quality_flags.includes("availability_verified_degraded"));
  assert.ok(player(output, 7).conflict_flags.includes("availability_conflict"));
  assert.ok(player(output, 2).adjustments.includes("availability_cap"));
  assert.equal(player(output, 7).adjustments.includes("availability_cap"), false);

  for (const p of output.players) {
    assert.ok(p.projected_start_probability_bp! <= p.start_cap_bp, `start within cap for ${p.canonical_player_id}`);
    assert.ok(p.appearance_probability_bp! <= Math.max(p.start_cap_bp, p.projected_start_probability_bp!));
  }
  // Suspended: never starts, never appears, no minutes.
  assert.deepEqual([player(output, 4).projected_start_probability_bp, player(output, 4).appearance_probability_bp, player(output, 4).expected_regulation_minutes_tenths], [0, 0, 0]);
  assert.equal(output.quality.availability_unknown, 17 - 7);
  assert.equal(output.quality.availability_conflicts, 1);
});

test("M1: accepted reported-lineup claims are transparent pseudo-observations; conflicts apply nothing", () => {
  const output = forecast(inputs({
    claims: [
      claim(P(12), "expected_lineup", "starts", "verified"),
      claim(P(13), "expected_lineup", "on_bench", "verified"),
      claim(P(11), "expected_lineup", "not_in_squad", "verified"),
      claim(P(14), "expected_lineup", "starts", "verified_degraded"),
      claim(P(15), "expected_lineup", "starts", "verified"),
      claim(P(15), "expected_lineup", "on_bench", "verified"),
      claim(P(16), "expected_lineup", "on_bench", "verified_degraded"),
      claim(P(16), "expected_lineup", "on_bench", "verified"),
      claim(P(17), "expected_lineup", "starts", "unresolved"),
    ],
  }));
  // starts (verified): +4 start successes, +4 appearance successes.
  assert.deepEqual([player(output, 12).raw_start_probability_bp, player(output, 12).raw_appearance_probability_bp], [bp(3 + 1 + 4, 10 + 2 + 4), bp(7 + 1 + 4, 10 + 2 + 4)]);
  assert.ok(player(output, 12).adjustments.includes("lineup_report_starts_verified"));
  // on_bench (verified): +4 start failures, +2 appearance successes.
  assert.deepEqual([player(output, 13).raw_start_probability_bp, player(output, 13).raw_appearance_probability_bp], [bp(1, 16), bp(1 + 2, 12 + 2)]);
  // not_in_squad (verified): +8 start failures, +8 appearance failures.
  assert.deepEqual([player(output, 11).raw_start_probability_bp, player(output, 11).raw_appearance_probability_bp], [bp(8, 20), bp(11, 20)]);
  // verified_degraded halves the counts.
  assert.deepEqual([player(output, 14).raw_start_probability_bp, player(output, 14).raw_appearance_probability_bp], [bp(0 + 1 + 2, 12 + 2), bp(5 + 1 + 2, 12 + 2)]);
  assert.deepEqual(player(output, 14).lineup_evidence.applied, { predicate: "starts", standing: "verified_degraded", counts: { start_successes: 2, start_failures: 0, appearance_successes: 2, appearance_failures: 0 } });
  // Conflicting predicates: no adjustment, flagged.
  assert.deepEqual([player(output, 15).raw_start_probability_bp, player(output, 15).lineup_evidence.applied], [bp(1, 12), null]);
  assert.deepEqual(player(output, 15).lineup_evidence.accepted_predicates, ["on_bench", "starts"]);
  assert.ok(player(output, 15).conflict_flags.includes("lineup_evidence_conflict"));
  // One predicate, mixed standings: the verified standing applies.
  assert.equal(player(output, 16).lineup_evidence.applied?.standing, "verified");
  // Unresolved claims are never applied.
  assert.equal(player(output, 17).lineup_evidence.applied, null);
  assert.equal(output.quality.lineup_evidence_conflicts, 1);
  // Starting reports do not bypass the team constraint.
  assert.equal(output.team_start_total_bp, 110000);
});

test("cross-family conflict is decided on the raw accepted evidence sets, even when a family is itself conflicted", () => {
  const output = forecast(inputs({
    claims: [
      // 1. unavailable + starts
      claim(P(1), "player_availability", "out", "verified"),
      claim(P(1), "expected_lineup", "starts", "verified"),
      // 2. unavailable + starts + not_in_squad (the lineup family is conflicted)
      claim(P(2), "player_availability", "out", "verified"),
      claim(P(2), "expected_lineup", "starts", "verified"),
      claim(P(2), "expected_lineup", "not_in_squad", "verified"),
      // 3. available + unavailable + starts (the availability family is conflicted)
      claim(P(3), "player_availability", "fit", "verified"),
      claim(P(3), "player_availability", "out", "verified"),
      claim(P(3), "expected_lineup", "starts", "verified"),
      // 4. suspended + starts + on_bench (lineup family conflicted)
      claim(P(4), "player_availability", "banned", "verified_degraded"),
      claim(P(4), "expected_lineup", "starts", "verified"),
      claim(P(4), "expected_lineup", "on_bench", "verified_degraded"),
      // both families conflicted at once
      claim(P(5), "player_availability", "fit", "verified"),
      claim(P(5), "player_availability", "banned", "verified"),
      claim(P(5), "expected_lineup", "starts", "verified"),
      claim(P(5), "expected_lineup", "on_bench", "verified"),
      // 5. unavailable + not_in_squad only: consistent, NOT a cross conflict
      claim(P(6), "player_availability", "out", "verified"),
      claim(P(6), "expected_lineup", "not_in_squad", "verified"),
      // suspended + on_bench (simple case); doubtful + starts is consistent
      claim(P(7), "player_availability", "banned", "verified"),
      claim(P(7), "expected_lineup", "on_bench", "verified"),
      claim(P(8), "player_availability", "doubtful", "verified"),
      claim(P(8), "expected_lineup", "starts", "verified"),
    ],
  }));
  for (const n of [1, 2, 3, 4, 5, 7]) {
    const p = player(output, n);
    assert.ok(p.conflict_flags.includes("cross_evidence_conflict"), `cross conflict for player ${n}`);
    assert.ok(p.adjustments.includes("claim_adjustments_suppressed_cross_conflict"));
    assert.equal(p.lineup_evidence.applied, null, `no pseudo-counts for player ${n}`);
    assert.equal(p.adjustments.some((a) => a.startsWith("lineup_report_") || a === "availability_cap"), false);
    assert.equal(p.start_cap_bp, 10000, `no cap for player ${n}`);
    assert.deepEqual([p.raw_start_probability_bp, p.raw_appearance_probability_bp], [bp(11, 12), bp(11, 12)], `B0 only for player ${n}`);
  }
  // Every per-family flag and every evidence item is preserved.
  assert.ok(player(output, 2).conflict_flags.includes("lineup_evidence_conflict"));
  assert.deepEqual(player(output, 2).lineup_evidence.accepted_predicates, ["not_in_squad", "starts"]);
  assert.ok(player(output, 3).conflict_flags.includes("availability_conflict"));
  assert.ok(player(output, 4).conflict_flags.includes("lineup_evidence_conflict"));
  assert.deepEqual(player(output, 5).conflict_flags.slice().sort(), ["availability_conflict", "cross_evidence_conflict", "lineup_evidence_conflict"]);
  // Availability is still displayed by its own family semantics, but never caps.
  assert.deepEqual([player(output, 1).availability.status, player(output, 1).availability.probability_bp], ["quantified", 200]);
  assert.deepEqual([player(output, 3).availability.status, player(output, 3).availability.probability_bp], ["conflict", null]);
  // Consistent evidence applies both families.
  assert.deepEqual([player(output, 6).conflict_flags, player(output, 6).start_cap_bp, player(output, 6).raw_start_probability_bp], [[], 200, bp(11, 20)]);
  assert.deepEqual([player(output, 8).start_cap_bp, player(output, 8).raw_start_probability_bp], [6000, bp(15, 16)]);
  assert.equal(output.quality.cross_evidence_conflicts, 6);
  assert.equal(output.status, "projected");
});

test("negated reported-lineup claims are never guessed into a predicate", () => {
  const output = forecast(inputs({
    claims: [
      claim(P(12), "expected_lineup", "starts", "verified", { polarity: "negated" }),
      claim(P(1), "player_availability", "out", "verified"),
      claim(P(1), "expected_lineup", "starts", "verified", { polarity: "negated" }),
    ],
  }));
  // "Will not start" adds no start pseudo-counts ...
  assert.deepEqual([player(output, 12).lineup_evidence.applied, player(output, 12).raw_start_probability_bp], [null, bp(4, 12)]);
  assert.ok(player(output, 12).quality_flags.includes("negated_lineup_report_ignored"));
  // ... and is not a squad-presence report, so out + "not starting" is no cross conflict.
  assert.deepEqual([player(output, 1).conflict_flags, player(output, 1).start_cap_bp], [[], 200]);
});

test("team projection: one intercept, caps respected, exactly 110000 bp, deterministic modal XI", () => {
  const output = forecast(inputs({ claims: [claim(P(2), "player_availability", "doubtful", "verified")] }));
  assert.equal(output.status, "projected");
  const starts = output.players.map((p) => p.projected_start_probability_bp!);
  assert.equal(starts.reduce((a, b) => a + b, 0), 110000);
  assert.equal(output.team_start_total_bp, 110000);
  assert.ok(output.players.every((p) => Number.isInteger(p.projected_start_probability_bp) && p.projected_start_probability_bp! <= p.start_cap_bp));
  // Monotone in the raw probability among uncapped players; equal raw values
  // differ by at most the one remainder point handed out by canonical id.
  const uncapped = output.players.filter((p) => p.start_cap_bp === 10000).sort((a, b) => a.raw_start_probability_bp - b.raw_start_probability_bp);
  for (let i = 1; i < uncapped.length; i += 1) {
    const [lower, higher] = [uncapped[i - 1], uncapped[i]];
    if (higher.raw_start_probability_bp > lower.raw_start_probability_bp) assert.ok(higher.projected_start_probability_bp! >= lower.projected_start_probability_bp!);
    else assert.ok(Math.abs(higher.projected_start_probability_bp! - lower.projected_start_probability_bp!) <= 1);
  }
  const tied = [1, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => player(output, n).projected_start_probability_bp!);
  assert.equal(tied[0], Math.max(...tied)); // the remainder point goes to the lowest canonical id
  // The doubtful regular is capped at 60%.
  assert.equal(player(output, 2).projected_start_probability_bp, 6000);
  // Modal XI: the 11 highest, ties by canonical id; a set, not a joint distribution.
  assert.equal(output.modal_xi.length, 11);
  assert.deepEqual(output.modal_xi, [...output.modal_xi].sort());
  assert.deepEqual(output.players.filter((p) => p.in_modal_xi).map((p) => p.canonical_player_id).sort(), output.modal_xi);
  assert.deepEqual(output.modal_xi, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(P).sort());
  assert.equal(typeof output.team_lambda_micro, "number");

  // Same input, same output (and same bytes).
  assert.equal(canonicalSha256(forecast(inputs({ claims: [claim(P(2), "player_availability", "doubtful", "verified")] }))), canonicalSha256(output));

  // Symmetric squad: 22 identical players share 5000 bp each; ties by id.
  const twins = Array.from({ length: 22 }, (_, k) => P(100 + k));
  const symmetric = forecast(inputs({ history: [], memberships: twins.map(membership) }));
  assert.ok(symmetric.players.every((p) => p.projected_start_probability_bp === 5000));
  assert.deepEqual(symmetric.modal_xi, twins.slice(0, 11));

  // Exactly 11 candidates: everyone starts with certainty.
  const eleven = forecast(inputs({ history: [], memberships: twins.slice(0, 11).map(membership) }));
  assert.ok(eleven.players.every((p) => p.projected_start_probability_bp === 10000 && p.in_modal_xi));
});

test("insufficient candidates or start capacity: no projection, raw values retained", () => {
  const ten = Array.from({ length: 10 }, (_, k) => P(200 + k));
  const few = forecast(inputs({ history: [], memberships: ten.map(membership) }));
  assert.equal(few.status, "insufficient_candidates");
  assert.deepEqual([few.team_lambda_micro, few.team_start_total_bp, few.modal_xi], [null, null, []]);
  assert.ok(few.players.every((p) => p.projected_start_probability_bp === null && p.appearance_probability_bp === null && p.expected_regulation_minutes_tenths === null && !p.in_modal_xi));
  assert.ok(few.players.every((p) => p.raw_start_probability_bp === 5000));

  // 12 candidates, two suspended: caps sum to 10 starts.
  const twelve = Array.from({ length: 12 }, (_, k) => P(300 + k));
  const capped = forecast(inputs({
    history: [],
    memberships: twelve.map(membership),
    claims: [claim(twelve[0], "player_availability", "banned", "verified"), claim(twelve[1], "player_availability", "banned", "verified")],
  }));
  assert.equal(capped.status, "insufficient_start_capacity");
  assert.ok(capped.players.every((p) => p.projected_start_probability_bp === null));
  // One suspended and one doubtful: capacity 10.6 < 11.
  const doubtful = forecast(inputs({
    history: [],
    memberships: twelve.map(membership),
    claims: [claim(twelve[0], "player_availability", "banned", "verified"), claim(twelve[1], "player_availability", "doubtful", "verified")],
  }));
  assert.equal(doubtful.status, "insufficient_start_capacity");
});

test("invalid input: wrong parameter version, malformed hash or a history set that is not the state's", () => {
  const inp = inputs();
  const state = buildFixtureSquadState(inp, POLICY);
  const model = lineupModelInput(inp, state);
  assert.equal(model.squad_state_sha256, squadStateSha256(state));
  assert.equal(buildLineupForecast(model).status, "projected");
  const invalid = [
    buildLineupForecast(model, { ...DEFAULT_LINEUP_PARAMETERS, version: "kapiloto-lineup-parameters-v0" as never }),
    buildLineupForecast({ ...model, squad_state_sha256: "not-a-hash" }),
    buildLineupForecast({ ...model, selected_history: model.selected_history.slice(1) }),
    buildLineupForecast({ ...model, selected_history: [...model.selected_history.slice(1), fixture(29, [])] }),
  ];
  for (const output of invalid) {
    assert.equal(output.status, "invalid_input");
    assert.ok(output.players.every((p) => p.projected_start_probability_bp === null));
    assert.deepEqual(output.modal_xi, []);
  }
});

test("appearance and regulation minutes: p_app >= p_start, explicit samples capped at 90, explicit fallbacks", () => {
  const output = forecast(inputs());
  for (const p of output.players) {
    assert.ok(p.appearance_probability_bp! >= p.projected_start_probability_bp!);
    const startP = p.projected_start_probability_bp! / 10000;
    const subP = Math.max(0, p.appearance_probability_bp! - p.projected_start_probability_bp!) / 10000;
    const expected = Math.round((startP * (p.starter_minutes_mean_tenths / 10) + subP * (p.sub_minutes_mean_tenths / 10)) * 10);
    assert.ok(Math.abs(p.expected_regulation_minutes_tenths! - expected) <= 1, `minutes formula for ${p.canonical_player_id}`);
    assert.ok(p.expected_regulation_minutes_tenths! >= 0 && p.expected_regulation_minutes_tenths! <= 900);
  }
  // Starter mean from explicit start rows; 100' is capped at 90 (regulation only).
  assert.equal(player(output, 9).starter_minutes_mean_tenths, (90 + 9 * 60) / 10 * 10);
  assert.equal(player(output, 10).starter_minutes_mean_tenths, 600);
  // Substitute mean from non-starters that appeared; unused bench rows are not samples.
  assert.deepEqual([player(output, 11).sub_minutes_mean_tenths, player(output, 11).history.sub_minutes_samples], [300, 3]);
  assert.deepEqual([player(output, 12).sub_minutes_mean_tenths, player(output, 12).history.sub_minutes_samples], [200, 4]);
  // Fallbacks (75' starter, 18' substitute) are flagged.
  const unused = player(output, 13);
  assert.deepEqual([unused.starter_minutes_mean_tenths, unused.used_starter_minutes_fallback, unused.sub_minutes_mean_tenths, unused.used_sub_minutes_fallback], [750, true, 180, true]);
  assert.deepEqual([player(output, 1).used_starter_minutes_fallback, player(output, 1).used_sub_minutes_fallback], [false, true]);
  assert.equal(output.quality.players_starter_minutes_fallback, output.players.filter((p) => p.used_starter_minutes_fallback).length);
  // lineup_role = unknown enters neither conditional family, even with
  // appeared = true and stated minutes.
  const unknownRole = inputs({
    history: squadHistory().map((o) => (o.fixture_id === "fx-01"
      ? { ...o, players: o.players.map((r) => (r.canonical_player_id === P(13) ? { ...r, lineup_role: "unknown" as const, appeared: true, minutes_played: 30 } : r)) }
      : o)),
  });
  const withUnknown = player(forecast(unknownRole), 13);
  assert.deepEqual(
    [withUnknown.history.starter_minutes_samples, withUnknown.history.sub_minutes_samples, withUnknown.used_starter_minutes_fallback, withUnknown.used_sub_minutes_fallback],
    [unused.history.starter_minutes_samples, unused.history.sub_minutes_samples, true, true],
  );
  assert.deepEqual([withUnknown.starter_minutes_mean_tenths, withUnknown.sub_minutes_mean_tenths], [750, 180]);
  // Unknown minutes are never treated as zero.
  const unknownMinutes = inputs({ history: squadHistory().map((o) => ({ ...o, players: o.players.map((r) => (r.canonical_player_id === P(10) ? { ...r, minutes_played: null } : r)) })) });
  assert.deepEqual([player(forecast(unknownMinutes), 10).used_starter_minutes_fallback, player(forecast(unknownMinutes), 10).starter_minutes_mean_tenths], [true, 750]);
});

test("quality summary counts candidates, samples, conflicts and fallbacks", () => {
  const output = forecast(inputs({ claims: [claim(P(15), "expected_lineup", "starts", "verified"), claim(P(15), "expected_lineup", "on_bench", "verified")] }));
  assert.equal(output.quality.candidate_count, 17);
  assert.equal(output.quality.start_known_samples, output.players.reduce((n, p) => n + p.history.start_trials, 0));
  assert.equal(output.quality.appearance_known_samples, output.players.reduce((n, p) => n + p.history.appearance_trials, 0));
  assert.equal(output.quality.lineup_evidence_conflicts, 1);
  assert.equal(output.quality.provider_fallback_count, 0);
  assert.equal(output.quality.coach_conflict, false);
  // The payload stays well inside the registry's 256 KiB payload bound.
  assert.ok(Buffer.byteLength(JSON.stringify({ lineup_estimate: output })) < 64 * 1024);
});

test("solver and integer allocation are deterministic and exact", () => {
  // Bisection finds the intercept; the sum is 11 within floating error.
  const players = Array.from({ length: 16 }, (_, k) => ({ raw: (k + 1) / 17, cap: k === 15 ? 0.6 : 1 }));
  const { lambda, probabilities } = projectTeamStarts(players, 11, DEFAULT_LINEUP_PARAMETERS);
  assert.ok(Math.abs(probabilities.reduce((a, b) => a + b, 0) - 11) < 1e-9);
  assert.ok(probabilities[15] <= 0.6);
  assert.deepEqual(projectTeamStarts(players, 11, DEFAULT_LINEUP_PARAMETERS).lambda, lambda);
  // Extreme raw probabilities are clamped for the logit only.
  const extreme = projectTeamStarts(Array.from({ length: 12 }, (_, k) => ({ raw: k < 6 ? 0 : 1, cap: 1 })), 11, DEFAULT_LINEUP_PARAMETERS);
  assert.ok(Math.abs(extreme.probabilities.reduce((a, b) => a + b, 0) - 11) < 1e-6);

  // Largest remainder: exact target, never above a cap, ties by id.
  assert.deepEqual(allocateBasisPoints([{ id: "b", value: 1.5, cap: 10 }, { id: "a", value: 1.5, cap: 10 }, { id: "c", value: 1, cap: 10 }], 5), [2, 2, 1]);
  assert.deepEqual(allocateBasisPoints([{ id: "a", value: 2.9, cap: 2 }, { id: "b", value: 2.1, cap: 10 }], 5), [2, 3]);
  // Floating overshoot gives points back from the smallest remainders.
  assert.deepEqual(allocateBasisPoints([{ id: "a", value: 3.0000000001, cap: 10 }, { id: "b", value: 2.4, cap: 10 }], 5), [3, 2]);
  assert.deepEqual(allocateBasisPoints([{ id: "a", value: 3, cap: 10 }, { id: "b", value: 3, cap: 10 }], 5), [3, 2]);
  assert.throws(() => allocateBasisPoints([{ id: "a", value: 1, cap: 1 }, { id: "b", value: 1, cap: 1 }], 5), /exceeds the caps/);
});

test("parameter validation fails closed: malformed same-version parameters make the forecast invalid_input", () => {
  assert.deepEqual(validateLineupParameters(DEFAULT_LINEUP_PARAMETERS), []);
  const p = DEFAULT_LINEUP_PARAMETERS;
  const bad: [string, unknown][] = [
    ["team_starters = 10", { ...p, team_starters: 10 }],
    ["negative prior", { ...p, start_prior: { alpha: -1, beta: 1 } }],
    ["zero prior", { ...p, appearance_prior: { alpha: 1, beta: 0 } }],
    ["probability > 1", { ...p, availability_probability: { ...p.availability_probability, doubtful: 1.2 } }],
    ["NaN probability", { ...p, availability_probability: { ...p.availability_probability, available: Number.NaN } }],
    ["Infinity prior", { ...p, start_prior: { alpha: Number.POSITIVE_INFINITY, beta: 1 } }],
    ["missing category", { ...p, availability_probability: { available: 0.98, doubtful: 0.6, unavailable: 0.02, suspended: 0 } }],
    ["negative pseudo-count", { ...p, lineup_pseudo_counts: { ...p.lineup_pseudo_counts, verified: { ...p.lineup_pseudo_counts.verified, starts: { ...p.lineup_pseudo_counts.verified.starts, start_successes: -4 } } } }],
    ["fractional pseudo-count", { ...p, lineup_pseudo_counts: { ...p.lineup_pseudo_counts, verified_degraded: { ...p.lineup_pseudo_counts.verified_degraded, on_bench: { ...p.lineup_pseudo_counts.verified_degraded.on_bench, start_failures: 1.5 } } } }],
    ["minutes fallback > 90", { ...p, starter_minutes_fallback: 95 }],
    ["negative minutes fallback", { ...p, sub_minutes_fallback: -1 }],
    ["epsilon = 0", { ...p, logit_epsilon: 0 }],
    ["epsilon = 0.5", { ...p, logit_epsilon: 0.5 }],
    ["lambda_min >= lambda_max", { ...p, solver: { lambda_min: 5, lambda_max: 5, iterations: 200 } }],
    ["infinite lambda bound", { ...p, solver: { lambda_min: Number.NEGATIVE_INFINITY, lambda_max: 60, iterations: 200 } }],
    ["zero iterations", { ...p, solver: { ...p.solver, iterations: 0 } }],
    ["too many iterations", { ...p, solver: { ...p.solver, iterations: 1_000_000 } }],
    ["unknown parameter", { ...p, decay: 0.9 }],
    ["wrong version", { ...p, version: "kapiloto-lineup-parameters-v0" }],
  ];
  for (const [label, parameters] of bad) {
    assert.ok(validateLineupParameters(parameters).length > 0, label);
    const output = forecast(inputs(), parameters as LineupParameters);
    assert.equal(output.status, "invalid_input", label);
    assert.ok(output.invalid_reasons.length > 0, label);
    assert.deepEqual([output.modal_xi, output.team_start_total_bp, output.team_lambda_micro, output.players], [[], null, null, []], label);
    assert.equal(output.quality.candidate_count, 17, label);
  }
  // A well-formed range that does not bracket the intercept is refused, not
  // silently projected.
  const narrow = forecast(inputs(), { ...p, solver: { lambda_min: -0.001, lambda_max: 0.001, iterations: 200 } });
  assert.deepEqual([narrow.status, narrow.invalid_reasons], ["invalid_input", ["solver range does not bracket the team intercept"]]);
  assert.ok(narrow.players.every((x) => x.projected_start_probability_bp === null));
  // Valid injected parameters still obey the V1 output contract.
  const custom = forecast(inputs(), { ...p, start_prior: { alpha: 2, beta: 3 }, starter_minutes_fallback: 80 });
  assert.equal(custom.status, "projected");
  assert.deepEqual(validateLineupForecastOutput(custom, { fixtureId: "fx-target", subjectTeamId: TEAM, squadStateSha256: custom.squad_state_sha256 }), []);
});

test("lineup output contract: every projected and non-projected invariant is validated, and recording refuses violations before the RPC", async () => {
  const inp = inputs({ claims: [claim(P(2), "player_availability", "doubtful", "verified")] });
  const state = buildFixtureSquadState(inp, POLICY);
  const output = buildLineupForecast(lineupModelInput(inp, state));
  const expected = { fixtureId: "fx-target", subjectTeamId: TEAM, squadStateSha256: output.squad_state_sha256 };
  assert.deepEqual(validateLineupForecastOutput(output, expected), []);
  const clone = (): LineupForecastOutput => JSON.parse(JSON.stringify(output));
  const modal = new Set(output.modal_xi);
  const idx = (pred: (p: LineupPlayerOutput) => boolean) => output.players.findIndex(pred);
  const modalIdx = idx((p) => modal.has(p.canonical_player_id) && p.start_cap_bp === 10000);
  const benchIdx = idx((p) => !modal.has(p.canonical_player_id));
  const cappedIdx = idx((p) => p.start_cap_bp === 6000);

  const cases: [string, (o: LineupForecastOutput) => void, RegExp][] = [
    ["wrong fixture", (o) => { o.fixture_id = "fx-other"; }, /fixture does not match/],
    ["wrong team", (o) => { o.subject_team_id = OPPONENT; }, /subject team does not match/],
    ["wrong hash", (o) => { o.squad_state_sha256 = "e".repeat(64); }, /squad-state hash/],
    ["wrong output contract", (o) => { (o as { contract_version: string }).contract_version = "kapiloto-lineup-output-v2"; }, /unsupported output contract/],
    ["team total", (o) => { o.team_start_total_bp = 109999; }, /team start total must be 110000/],
    ["duplicate player", (o) => { o.players.push(o.players[0]); }, /duplicate player ids/],
    ["duplicate modal id", (o) => { o.modal_xi[1] = o.modal_xi[0]; }, /exactly 11 unique/],
    ["modal XI of 10", (o) => { o.modal_xi.pop(); }, /exactly 11 unique/],
    ["modal XI of 12", (o) => { o.modal_xi.push(o.players[benchIdx].canonical_player_id); }, /exactly 11 unique/],
    ["modal id not a player", (o) => { o.modal_xi[0] = "c0000000-0000-4000-8000-999999999999"; }, /not exactly one output player/],
    ["flag disagrees", (o) => { o.players[benchIdx].in_modal_xi = true; }, /in_modal_xi disagrees/],
    ["start sum", (o) => { o.players[modalIdx].projected_start_probability_bp! -= 1; }, /sum to 110000/],
    ["start > cap", (o) => { o.players[cappedIdx].projected_start_probability_bp = 6001; }, /starts above the cap/],
    ["start > 10000", (o) => { o.players[modalIdx].projected_start_probability_bp = 10001; }, /projected start must be an integer/],
    ["fractional start", (o) => { o.players[benchIdx].projected_start_probability_bp! += 0.5; }, /projected start must be an integer/],
    ["appearance < start", (o) => { o.players[modalIdx].appearance_probability_bp = o.players[modalIdx].projected_start_probability_bp! - 1; }, /appearance is below start/],
    ["appearance > 10000", (o) => { o.players[modalIdx].appearance_probability_bp = 10001; }, /appearance must be an integer/],
    ["appearance > cap", (o) => { o.players[cappedIdx].appearance_probability_bp = 6001; }, /appearance exceeds the cap/],
    ["minutes > 900", (o) => { o.players[modalIdx].expected_regulation_minutes_tenths = 901; }, /expected minutes must be an integer in 0\.\.900/],
    ["non-projected keeps values", (o) => { o.status = "insufficient_candidates"; }, /only a projected forecast has a modal XI/],
    ["invalid_input without reasons", (o) => { o.status = "invalid_input"; o.modal_xi = []; o.team_start_total_bp = null; o.team_lambda_micro = null; for (const p of o.players) Object.assign(p, { projected_start_probability_bp: null, appearance_probability_bp: null, expected_regulation_minutes_tenths: null, in_modal_xi: false }); }, /invalid_reasons/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const o = clone();
    mutate(o);
    const issues = validateLineupForecastOutput(o, expected);
    assert.ok(issues.some((i) => pattern.test(i)), `${label}: ${issues.join("; ")}`);
  }

  // Recording validates the output contract before calling the RPC.
  const meta = { idempotencyKey: "contract", purpose: "shadow" as const, predictionProtocolVersion: "p", pipelineVersion: "p", codeRevision: "abcdef0", generatedAt: "2026-10-30T12:05:00+00:00" };
  const snapshot = buildLineupForecastSnapshot({ inputs: inp, state, policy: POLICY, output, meta });
  let calls = 0;
  const rpc = async () => { calls += 1; return { status: "recorded" }; };
  const broken = clone();
  broken.team_start_total_bp = 109999;
  await assert.rejects(recordLineupForecastSnapshot(rpc, { ...snapshot, payload: { lineup_estimate: broken } }), /team start total must be 110000/);
  const dropped = clone();
  dropped.players = dropped.players.slice(1).map((p) => ({ ...p }));
  await assert.rejects(recordLineupForecastSnapshot(rpc, { ...snapshot, payload: { lineup_estimate: dropped } }), /not exactly the frozen squad-state candidates|sum to 110000/);
  assert.equal(calls, 0);
  await recordLineupForecastSnapshot(rpc, snapshot);
  assert.equal(calls, 1);
});
