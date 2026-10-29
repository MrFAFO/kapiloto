import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256 } from "./canonical-json";
import {
  DEFAULT_LINEUP_PARAMETERS,
  allocateBasisPoints,
  buildLineupForecast,
  projectTeamStarts,
  type LineupForecastOutput,
  type LineupParameters,
  type LineupPlayerOutput,
} from "./lineup-model";
import { lineupModelInput, squadStateSha256 } from "./lineup-snapshot";
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

function claim(player: string, type: "player_availability" | "expected_lineup", value: string, resolution: SquadClaimInput["resolution_status"]): SquadClaimInput {
  const id = `claim-${player.slice(-4)}-${value}-${resolution}`;
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

test("cross-family conflict: out/suspended plus a squad report suppresses claim adjustments and the cap", () => {
  const output = forecast(inputs({
    claims: [
      claim(P(1), "player_availability", "out", "verified"),
      claim(P(1), "expected_lineup", "starts", "verified"),
      claim(P(2), "player_availability", "banned", "verified"),
      claim(P(2), "expected_lineup", "on_bench", "verified"),
      claim(P(3), "player_availability", "banned", "verified"),
      claim(P(3), "expected_lineup", "not_in_squad", "verified"),
      claim(P(4), "player_availability", "doubtful", "verified"),
      claim(P(4), "expected_lineup", "starts", "verified"),
    ],
  }));
  for (const n of [1, 2]) {
    const p = player(output, n);
    assert.ok(p.conflict_flags.includes("cross_evidence_conflict"));
    assert.ok(p.adjustments.includes("claim_adjustments_suppressed_cross_conflict"));
    assert.equal(p.start_cap_bp, 10000);
    assert.equal(p.raw_start_probability_bp, bp(11, 12)); // B0 only
  }
  // Consistent evidence (suspended + not in squad) is not a conflict.
  assert.deepEqual([player(output, 3).conflict_flags, player(output, 3).start_cap_bp, player(output, 3).raw_start_probability_bp], [[], 0, bp(11, 20)]);
  // Doubtful + starts is not a cross conflict: both apply.
  assert.deepEqual([player(output, 4).start_cap_bp, player(output, 4).raw_start_probability_bp], [6000, bp(15, 16)]);
  assert.equal(output.quality.cross_evidence_conflicts, 2);
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
