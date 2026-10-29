import assert from "node:assert/strict";
import test from "node:test";

import type { MembershipAsOfRow } from "./roster";
import {
  AVAILABILITY_NORMALIZATION_TABLE,
  buildCoachState,
  buildFixtureSquadState,
  buildReplacementPatterns,
  historySelectionPolicy,
  normalizeAvailabilityStatus,
  playerHistoryFeatures,
  selectHistoricalObservations,
  summarizeAvailability,
  type HistoryObservationInput,
  type HistoryPlayerInput,
  type SquadClaimInput,
  type SquadStateInputs,
  type SquadTenureInput,
} from "./squad-state";
import { SQUAD_STATE_INPUTS_CONTRACT_VERSION } from "./versions";

const TEAM = "a0000000-0000-4000-8000-000000000001";
const OPPONENT = "b0000000-0000-4000-8000-000000000001";
const P = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COACH = "d0000000-0000-4000-8000-000000000001";
const OTHER_COACH = "d0000000-0000-4000-8000-000000000002";

function playerRow(id: string, overrides: Partial<HistoryPlayerInput> = {}): HistoryPlayerInput {
  return {
    observed_player_id: id,
    canonical_player_id: id,
    lineup_role: "starter",
    appeared: true,
    position_code: "MF",
    formation_position: 6,
    is_captain: false,
    minutes_played: 90,
    entered_minute: 0,
    exited_minute: null,
    ...overrides,
  };
}

function observation(fixture: number, provider: string, overrides: Partial<HistoryObservationInput> = {}): HistoryObservationInput {
  return {
    observation_id: `obs-${fixture}-${provider}`,
    fixture_id: `fx-${String(fixture).padStart(2, "0")}`,
    provider,
    observation_version: 1,
    first_seen_at: `2026-10-${String(fixture).padStart(2, "0")}T21:00:00+00:00`,
    kickoff_at: `2026-10-${String(fixture).padStart(2, "0")}T18:00:00+00:00`,
    side: "home",
    opponent_team_id: OPPONENT,
    observed_coach_id: COACH,
    canonical_coach_id: COACH,
    lineup_status: "complete",
    substitutions_status: "complete",
    players: [playerRow(P(1))],
    substitutions: [],
    ...overrides,
  };
}

const POLICY = historySelectionPolicy(["sportmonks", "api_football"]);

test("history selection: one observation per fixture, complete over partial, then explicit priority", () => {
  const { selected, excluded } = selectHistoricalObservations(
    [
      observation(1, "sportmonks"),
      observation(1, "api_football"),
      observation(2, "sportmonks", { lineup_status: "partial" }),
      observation(2, "api_football"),
      observation(3, "sportmonks", { lineup_status: "partial" }),
      observation(3, "api_football", { lineup_status: "partial" }),
      observation(4, "sportmonks", { lineup_status: "not_provided", players: [] }),
      observation(4, "unlisted_provider"),
      observation(5, "api_football", { players: [] }),
    ],
    POLICY,
  );
  assert.deepEqual(selected.map((s) => [s.fixture_id, s.provider, s.lineup_status, s.reason, s.provider_fallback]), [
    ["fx-03", "sportmonks", "partial", "provider_priority", false],
    ["fx-02", "api_football", "complete", "complete_over_partial", true],
    ["fx-01", "sportmonks", "complete", "provider_priority", false],
  ]);
  assert.deepEqual(selected.find((s) => s.fixture_id === "fx-02")!.alternatives.map((a) => a.excluded_because), ["lower_completeness"]);
  assert.deepEqual(excluded.map((e) => [e.fixture_id, e.observations.map((o) => o.excluded_because).sort()]), [
    ["fx-05", ["no_player_rows"]],
    ["fx-04", ["player_data_not_provided", "provider_not_in_priority"]],
  ]);
  // Most recent first, capped at the policy's window.
  const many = Array.from({ length: 14 }, (_, i) => observation(i + 1, "sportmonks"));
  const capped = selectHistoricalObservations(many, POLICY).selected;
  assert.deepEqual([capped.length, capped[0].fixture_id, capped[9].fixture_id], [10, "fx-14", "fx-05"]);
  assert.throws(() => historySelectionPolicy([]));
  assert.throws(() => historySelectionPolicy(["a", "a"]));
  assert.throws(() => historySelectionPolicy(["a"], 11));
});

test("player history features are raw counts with honest denominators", () => {
  const p = P(1);
  // Four selected fixtures, most recent first: start, start, bench used, unused bench.
  const history = [
    observation(4, "sportmonks", { players: [playerRow(p, { is_captain: true, formation_position: 9, position_code: "FW" })] }),
    observation(3, "sportmonks", { players: [playerRow(p, { exited_minute: 55, minutes_played: 55 })] }),
    observation(2, "sportmonks", {
      players: [playerRow(p, { lineup_role: "bench", entered_minute: 70, minutes_played: 20, formation_position: null }), playerRow(P(2))],
      substitutions: [{ sequence_no: 1, observed_player_off_id: P(2), canonical_player_off_id: P(2), observed_player_on_id: p, canonical_player_on_id: p, minute: 70, stoppage_minute: null }],
    }),
    observation(1, "sportmonks", { players: [playerRow(p, { lineup_role: "bench", appeared: false, minutes_played: 0, entered_minute: null, formation_position: null, position_code: null })] }),
  ];
  const f = playerHistoryFeatures(p, history);
  assert.equal(f.matches_available, 4);
  assert.deepEqual([f.squad_appearances, f.starts, f.appearances, f.bench_unused, f.bench_appearance_unknown], [4, 2, 3, 1, 0]);
  assert.deepEqual([f.minutes_total, f.minutes_known_matches], [165, 4]);
  // Windows never pretend to hold more matches than exist.
  assert.deepEqual(f.starts_last, { last_3: { value: 2, available_matches: 3 }, last_5: { value: 2, available_matches: 4 }, last_10: { value: 2, available_matches: 4 } });
  assert.deepEqual(f.minutes_last.last_3, { value: 165, available_matches: 3 });
  assert.deepEqual(f.appearances_last.last_10, { value: 3, available_matches: 4 });
  assert.deepEqual([f.full_regulation_starts, f.starts_with_known_minutes, f.sub_on, f.sub_off, f.early_exits_before_60, f.captain_starts], [1, 2, 1, 0, 1, 1]);
  assert.deepEqual([f.start_known_matches, f.appearance_known_matches], [4, 4]);
  assert.equal(f.consecutive_starts, 2);
  assert.deepEqual([f.last_squad_kickoff, f.last_start_kickoff, f.last_appearance_kickoff], [history[0].kickoff_at, history[0].kickoff_at, history[0].kickoff_at]);
  assert.deepEqual(f.position_histogram, { FW: 1, MF: 2 });
  assert.deepEqual(f.formation_slot_histogram, [{ slot: 6, count: 1 }, { slot: 9, count: 1 }]);
  // A player absent from the latest match has no current start streak.
  const absent = playerHistoryFeatures(P(2), history);
  assert.deepEqual([absent.consecutive_starts, absent.squad_appearances, absent.sub_off], [0, 1, 1]);
});

test("replacement patterns are observed pairs with exact provenance and median minutes", () => {
  const sub = (off: string, on: string, minute: number | null, observedOff = off) => ({
    sequence_no: 1,
    observed_player_off_id: observedOff,
    canonical_player_off_id: off,
    observed_player_on_id: on,
    canonical_player_on_id: on,
    minute,
    stoppage_minute: null,
  });
  const patterns = buildReplacementPatterns([
    observation(3, "sportmonks", { substitutions: [sub(P(1), P(2), 60)] }),
    // A merged duplicate's raw id resolves to the same canonical pair.
    observation(2, "sportmonks", { substitutions: [sub(P(1), P(2), 70, P(9))] }),
    observation(1, "sportmonks", { substitutions: [sub(P(1), P(2), 80), sub(P(3), P(4), null)] }),
  ]);
  assert.deepEqual(patterns.map((p) => [p.player_off_id, p.player_on_id, p.count, p.minutes, p.median_minute]), [
    [P(1), P(2), 3, [60, 70, 80], 70],
    [P(3), P(4), 1, [], null],
  ]);
  assert.deepEqual(patterns[0].occurrences.map((o) => [o.observation_id, o.observed_player_off_id]), [["obs-3-sportmonks", P(1)], ["obs-2-sportmonks", P(9)], ["obs-1-sportmonks", P(1)]]);
  const even = buildReplacementPatterns([observation(2, "sportmonks", { substitutions: [sub(P(1), P(2), 60)] }), observation(1, "sportmonks", { substitutions: [sub(P(1), P(2), 75)] })]);
  assert.equal(even[0].median_minute, 67.5);
});

function claim(player: string, status: string, resolution: SquadClaimInput["resolution_status"], overrides: Partial<SquadClaimInput> = {}): SquadClaimInput {
  const id = `claim-${player.slice(-4)}-${status}-${resolution}`;
  return {
    claim_id: id,
    canonical_claim_id: id,
    member_claim_ids: [id],
    claim_kind: "reported_expectation",
    claim_type: "player_availability",
    predicate: "availability_status",
    team_id: TEAM,
    observed_player_id: player,
    canonical_player_id: player,
    object_value: { status },
    polarity: "affirmed",
    claim_first_seen_at: "2026-10-28T09:00:00+00:00",
    resolution_id: resolution === "unresolved" ? null : `res-${id}`,
    resolution_claim_id: resolution === "unresolved" ? null : id,
    resolution_status: resolution,
    resolution_first_seen_at: resolution === "unresolved" ? null : "2026-10-29T09:00:00+00:00",
    quality_flags: resolution === "verified_degraded" ? ["missing_author"] : [],
    ...overrides,
  };
}

test("availability normalization is an explicit table; unknown values are kept, never guessed", () => {
  assert.equal(normalizeAvailabilityStatus("Fully Fit"), "available");
  assert.equal(normalizeAvailabilityStatus("late-fitness test"), "doubtful");
  assert.equal(normalizeAvailabilityStatus("RULED OUT"), "unavailable");
  assert.equal(normalizeAvailabilityStatus("banned"), "suspended");
  assert.equal(normalizeAvailabilityStatus("back in training"), "returning");
  assert.equal(normalizeAvailabilityStatus("rotation risk"), "unknown");
  assert.equal(normalizeAvailabilityStatus("knock"), "unknown");
  assert.equal(normalizeAvailabilityStatus(null), "unknown");
  assert.ok(!("rotation_risk" in AVAILABILITY_NORMALIZATION_TABLE));

  const p = P(1);
  const summary = summarizeAvailability([
    claim(p, "doubtful", "verified"),
    claim(p, "out", "verified_degraded"),
    claim(p, "injured", "unresolved"),
    claim(p, "out", "quarantined"),
    claim(p, "fit", "contradicted"),
    claim(p, "out", "fabricated"),
    claim(p, "knock", "verified"),
    claim(p, "injured", "verified", { polarity: "negated", claim_id: "neg", canonical_claim_id: "neg" }),
  ]);
  assert.deepEqual(summary.accepted.map((e) => [e.raw_status, e.category]), [["doubtful", "doubtful"], ["out", "unavailable"], ["knock", "unknown"], ["injured", "unknown"]]);
  assert.deepEqual(summary.accepted[1].quality_flags, ["missing_author"]);
  assert.deepEqual(summary.unresolved.map((e) => e.category), ["unavailable"]);
  assert.deepEqual(summary.audit_only.map((e) => e.resolution_status), ["quarantined", "contradicted", "fabricated"]);
  // doubtful vs unavailable among accepted evidence: a conflict, nothing picked.
  assert.deepEqual([summary.availability_conflict, summary.accepted_category], [true, null]);
  // Unresolved evidence alone is never a hard conclusion; audit-only never drives state.
  assert.deepEqual(summarizeAvailability([claim(p, "out", "unresolved"), claim(p, "fit", "contradicted")]).accepted_category, null);
  assert.deepEqual(summarizeAvailability([claim(p, "out", "verified"), claim(p, "injured", "verified_degraded")]).accepted_category, "unavailable");
});

function tenure(coach: string, overrides: Partial<SquadTenureInput> = {}): SquadTenureInput {
  return {
    tenure_id: `tenure-${coach.slice(-1)}`,
    tenure_key: `key-${coach.slice(-1)}`,
    tenure_version: 1,
    observed_coach_id: coach,
    canonical_coach_id: coach,
    role: "head_coach",
    starts_on_earliest: "2026-07-01",
    starts_on_latest: "2026-07-01",
    ends_on_earliest: null,
    ends_on_latest: null,
    first_seen_at: "2026-09-01T00:00:00+00:00",
    ...overrides,
  };
}

test("coach state reports agreement, single-family provenance and conflicts without inventing a coach", () => {
  const date = { target_date: "2026-11-02" };
  const ledger = [observation(2, "sportmonks"), observation(1, "sportmonks")];
  const state = (tenures: SquadTenureInput[], history: HistoryObservationInput[]) => buildCoachState({ ...date, tenures }, history);
  assert.deepEqual([state([tenure(COACH)], ledger).provenance, state([tenure(COACH)], ledger).current_coach_id], ["ledger_and_tenure", COACH]);
  assert.deepEqual([state([], ledger).provenance, state([], ledger).current_coach_id], ["ledger_only", COACH]);
  assert.deepEqual([state([tenure(COACH)], []).provenance, state([tenure(COACH)], []).current_coach_id], ["tenure_only", COACH]);
  const disagree = state([tenure(OTHER_COACH)], ledger);
  assert.deepEqual([disagree.provenance, disagree.coach_conflict, disagree.current_coach_id, disagree.candidate_coach_ids], ["conflict", true, null, [COACH, OTHER_COACH]]);
  assert.deepEqual([state([tenure(COACH), tenure(OTHER_COACH)], []).provenance, state([], []).provenance], ["conflict", "unknown"]);
  // An ended tenure is not active evidence.
  assert.equal(state([tenure(OTHER_COACH, { ends_on_earliest: "2026-09-30", ends_on_latest: "2026-09-30" })], ledger).provenance, "ledger_only");
  // A merged coach: tenure asserted for the duplicate resolves to the same canonical coach.
  assert.equal(state([tenure("dup", { observed_coach_id: "dup", canonical_coach_id: COACH })], ledger).provenance, "ledger_and_tenure");
  // A coach change inside the history is reported, not interpreted.
  const change = state([], [observation(2, "sportmonks", { canonical_coach_id: OTHER_COACH, observed_coach_id: OTHER_COACH }), observation(1, "sportmonks")]);
  assert.deepEqual(change.history_coaches.map((c) => [c.canonical_coach_id, c.matches]), [[OTHER_COACH, 1], [COACH, 1]]);
  assert.equal(change.latest_ledger_coach_id, OTHER_COACH);
});

function membership(player: string, observed = player, coverage: MembershipAsOfRow["coverage"] = "certain"): MembershipAsOfRow {
  return {
    membership_id: `m-${observed.slice(-4)}`,
    membership_key: `k-${observed.slice(-4)}`,
    membership_version: 1,
    team_id: TEAM,
    observed_player_id: observed,
    canonical_player_id: player,
    squad_group: "first_team",
    shirt_number: null,
    starts_on_earliest: "2026-07-01",
    starts_on_latest: "2026-07-01",
    ends_on_earliest: null,
    ends_on_latest: null,
    coverage,
    source_kind: "official_club",
    provider: null,
    provider_record_id: null,
    source_reference: null,
    document_version_id: null,
    first_seen_at: "2026-09-01T00:00:00+00:00",
  };
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
    history: [],
    memberships: [],
    claims: [],
    tenures: [],
    ...overrides,
  };
}

test("candidate universe is the union of roster, history and attributable claims, one entry per canonical player", () => {
  const merged = P(9);
  const state = buildFixtureSquadState(
    inputs({
      history: [observation(1, "sportmonks", { players: [playerRow(P(1)), playerRow(P(2), { observed_player_id: merged })] })],
      memberships: [membership(P(2)), membership(P(3)), membership(P(4), P(4), "outside")],
      claims: [
        claim(P(5), "returning", "verified"),
        claim(P(6), "out", "verified", { team_id: null }), // unattributable
        claim(P(1), "fit", "verified", { team_id: null }), // attributable via history
      ],
    }),
    POLICY,
  );
  assert.deepEqual(state.candidates.map((c) => [c.canonical_player_id, c.presence, c.sources]), [
    [P(1), "historical_only", ["history", "availability_claim"]],
    [P(2), "roster_and_history", ["roster", "history"]],
    [P(3), "roster_only", ["roster"]],
    [P(5), "claim_only", ["availability_claim"]],
  ]);
  assert.deepEqual(state.candidates.find((c) => c.canonical_player_id === P(2))!.observed_player_ids, [P(2), merged].sort());
  assert.deepEqual(state.quality.unattributed_claim_ids, [`claim-${P(6).slice(-4)}-out-verified`]);
  // Every family can be missing independently; nothing collapses the state.
  const empty = buildFixtureSquadState(inputs(), POLICY);
  assert.deepEqual([empty.candidates.length, empty.quality.usable_history_matches, empty.coach.provenance], [0, 0, "unknown"]);
  // Deterministic, and never pruned to a squad size.
  const many = buildFixtureSquadState(inputs({ memberships: Array.from({ length: 30 }, (_, i) => membership(P(100 + i))) }), POLICY);
  assert.equal(many.candidates.length, 30);
  assert.deepEqual(buildFixtureSquadState(inputs({ memberships: [membership(P(3))] }), POLICY), buildFixtureSquadState(inputs({ memberships: [membership(P(3))] }), POLICY));
  assert.throws(() => buildFixtureSquadState(inputs({ cutoff: "2026-11-02T18:00:01+00:00" }), POLICY), /after the fixture kickoff/);
});

test("each feature has its own knownness: unknown is never a zero and never a denominator", () => {
  const p = P(1);
  const only = (row: HistoryPlayerInput, overrides: Partial<HistoryObservationInput> = {}) =>
    playerHistoryFeatures(p, [observation(1, "sportmonks", { players: [row], ...overrides })]);

  // 1. Bench row, appeared = null: squad and start (not a starter) known,
  //    appearance and minutes unknown.
  const benchUnknown = only(playerRow(p, { lineup_role: "bench", appeared: null, minutes_played: null, entered_minute: null, formation_position: null }));
  assert.deepEqual(
    [benchUnknown.squad_appearances, benchUnknown.starts_last.last_3, benchUnknown.appearances_last.last_3, benchUnknown.minutes_last.last_3, benchUnknown.bench_appearance_unknown],
    [1, { value: 0, available_matches: 1 }, { value: 0, available_matches: 0 }, { value: 0, available_matches: 0 }, 1],
  );

  // 2. lineup_role = unknown: start is unknown; an explicit appeared flag
  //    still settles appearance.
  const roleUnknown = only(playerRow(p, { lineup_role: "unknown", appeared: true, minutes_played: 30, formation_position: null }));
  assert.deepEqual([roleUnknown.starts_last.last_3, roleUnknown.start_known_matches], [{ value: 0, available_matches: 0 }, 0]);
  assert.deepEqual([roleUnknown.appearances_last.last_3, roleUnknown.minutes_last.last_3], [{ value: 1, available_matches: 1 }, { value: 30, available_matches: 1 }]);
  assert.equal(only(playerRow(p, { lineup_role: "unknown", appeared: null, minutes_played: null, formation_position: null })).appearance_known_matches, 0);

  // 3. Absent from a partial lineup: every feature unknown.
  const partialAbsent = playerHistoryFeatures(p, [observation(1, "sportmonks", { lineup_status: "partial", players: [playerRow(P(2))] })]);
  assert.deepEqual(
    [partialAbsent.start_known_matches, partialAbsent.appearance_known_matches, partialAbsent.minutes_known_matches, partialAbsent.matches_with_known_status],
    [0, 0, 0, 0],
  );

  // 4. Absent from a complete lineup: the database proves its 11 starters are
  //    all listed, so "did not start" is known; squad selection, appearance and
  //    minutes are NOT (bench enumeration is not guaranteed).
  const completeAbsent = playerHistoryFeatures(p, [observation(1, "sportmonks", { players: [playerRow(P(2))] })]);
  assert.deepEqual(completeAbsent.starts_last.last_3, { value: 0, available_matches: 1 });
  assert.deepEqual(
    [completeAbsent.appearance_known_matches, completeAbsent.minutes_known_matches, completeAbsent.matches_with_known_status, completeAbsent.squad_appearances],
    [0, 0, 0, 0],
  );

  // Minutes: stated values count, appeared = false is a known zero, a
  // missing value on a starter is unknown.
  assert.deepEqual(only(playerRow(p, { lineup_role: "bench", appeared: false, minutes_played: null, entered_minute: null, formation_position: null })).minutes_last.last_3, { value: 0, available_matches: 1 });
  assert.deepEqual(only(playerRow(p, { minutes_played: null })).minutes_last.last_3, { value: 0, available_matches: 0 });

  // The streak stops at an unknown start rather than assuming either way.
  const streak = playerHistoryFeatures(p, [
    observation(3, "sportmonks", { players: [playerRow(p)] }),
    observation(2, "sportmonks", { players: [playerRow(p, { lineup_role: "unknown", formation_position: null })] }),
    observation(1, "sportmonks", { players: [playerRow(p)] }),
  ]);
  assert.deepEqual([streak.consecutive_starts, streak.starts, streak.start_known_matches], [1, 2, 2]);
  // Captaincy unknown is not "not captain"; the count is a lower bound.
  assert.equal(only(playerRow(p, { is_captain: null })).captain_starts, 0);
});

test("full regulation starts need explicit minutes; a missing exit is never a full match", () => {
  const p = P(1);
  const only = (row: HistoryPlayerInput) => playerHistoryFeatures(p, [observation(1, "sportmonks", { players: [row] })]);
  const counts = (f: ReturnType<typeof only>) => [f.full_regulation_starts, f.starts_with_known_minutes];
  assert.deepEqual(counts(only(playerRow(p, { minutes_played: 90 }))), [1, 1]);
  assert.deepEqual(counts(only(playerRow(p, { minutes_played: null, exited_minute: null }))), [0, 0]);
  assert.deepEqual(counts(only(playerRow(p, { minutes_played: 55, exited_minute: 55 }))), [0, 1]);
  assert.deepEqual(counts(only(playerRow(p, { lineup_role: "bench", appeared: true, minutes_played: 95, entered_minute: 1, formation_position: null }))), [0, 0]);
  // Contradictory data (90 minutes but an earlier stated exit) does not count.
  assert.deepEqual(counts(only(playerRow(p, { minutes_played: 90, exited_minute: 80 }))), [0, 1]);
  // Extra time: on for all of regulation counts, whether or not he lasted to
  // 120; completion of extra time is deliberately not derived.
  assert.deepEqual(counts(only(playerRow(p, { minutes_played: 105, exited_minute: 105 }))), [1, 1]);
  assert.deepEqual(counts(only(playerRow(p, { minutes_played: 120 }))), [1, 1]);
});
