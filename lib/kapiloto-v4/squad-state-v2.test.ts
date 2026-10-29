import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "./canonical-json";
import { buildLineupForecast } from "./lineup-model";
import { lineupModelInput, parseSquadStateArtifact, squadStateArtifact } from "./lineup-snapshot";
import type { MembershipAsOfRow } from "./roster";
import {
  buildFixtureSquadState,
  buildFixtureSquadStateFor,
  buildFixtureSquadStateV2,
  historicalFixtureDate,
  historicalMembershipCoverage,
  historySelectionPolicy,
  isSupportedSquadStateBuild,
  type FixtureSquadState,
  type HistoryObservationInput,
  type HistoryPlayerInput,
  type SquadStateInputs,
} from "./squad-state";
import { GOLDEN_INPUTS, GOLDEN_POLICY } from "./test-support/squad-golden-inputs";

/**
 * kapiloto-squad-features-v2 / kapiloto-squad-state-builder-v2: a player's
 * absence from a complete historical lineup is a known non-start only while
 * frozen membership evidence makes him CERTAINLY a member on that fixture's
 * UTC date. V1 behavior is untouched (squad-state-v1-golden.test.ts).
 */

const TEAM = "a2000000-0000-4000-8000-000000000001";
const OPPONENT = "b2000000-0000-4000-8000-000000000001";
const P = (n: number) => `c2000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NEW = P(99); // the player under test
const POLICY = historySelectionPolicy(["sportmonks"]);

function row(id: string, role: HistoryPlayerInput["lineup_role"], overrides: Partial<HistoryPlayerInput> = {}): HistoryPlayerInput {
  return {
    observed_player_id: id, canonical_player_id: id, lineup_role: role, appeared: role === "starter" ? true : null,
    position_code: null, formation_position: null, is_captain: false, minutes_played: role === "starter" ? 90 : null,
    entered_minute: null, exited_minute: null, ...overrides,
  };
}

/** One selected observation on 2026-10-DD; 11 regular starters plus `extra` rows. */
function fixture(day: number, extra: HistoryPlayerInput[] = [], lineupStatus: HistoryObservationInput["lineup_status"] = "complete", kickoff?: string): HistoryObservationInput {
  const d = String(day).padStart(2, "0");
  const starters = Array.from({ length: 11 }, (_, k) => row(P(k + 1), "starter"));
  const extraIds = new Set(extra.map((r) => r.canonical_player_id));
  return {
    observation_id: `obs-${d}`, fixture_id: `fx-${d}`, provider: "sportmonks", observation_version: 1,
    first_seen_at: `2026-10-${d}T21:00:00+00:00`, kickoff_at: kickoff ?? `2026-10-${d}T18:00:00+00:00`, side: "home",
    opponent_team_id: OPPONENT, observed_coach_id: null, canonical_coach_id: null, lineup_status: lineupStatus,
    substitutions_status: "complete",
    // An extra starter replaces regular #11 so the XI stays at 11.
    players: [...starters.filter((r) => !(extra.some((e) => e.lineup_role === "starter") && r.canonical_player_id === P(11)) && !extraIds.has(r.canonical_player_id)), ...extra],
    substitutions: [],
  };
}

function membership(player: string, bounds: { from: string; fromLatest?: string; to?: string | null; toLatest?: string | null }, key = `k-${player.slice(-4)}-${bounds.from}`, observed = player): MembershipAsOfRow {
  return {
    membership_id: `m-${key}`, membership_key: key, membership_version: 1, team_id: TEAM, observed_player_id: observed,
    canonical_player_id: player, squad_group: "first_team", shirt_number: null,
    starts_on_earliest: bounds.from, starts_on_latest: bounds.fromLatest ?? bounds.from,
    ends_on_earliest: bounds.to ?? null, ends_on_latest: bounds.toLatest ?? bounds.to ?? null,
    // Target-date coverage (2026-11-02); V2 must NOT use it for historical dates.
    coverage: "certain", source_kind: "official_club", provider: null, provider_record_id: null, source_reference: null,
    document_version_id: null, first_seen_at: "2026-09-01T00:00:00+00:00",
  };
}

function inputs(history: HistoryObservationInput[], memberships: MembershipAsOfRow[]): SquadStateInputs {
  return {
    contract_version: "kapiloto-squad-state-inputs-v1", fixture_id: "fx-target", team_id: TEAM, opponent_team_id: OPPONENT,
    side: "home", kickoff_at: "2026-11-02T18:00:00+00:00", cutoff: "2026-10-30T12:00:00+00:00", target_date: "2026-11-02",
    target_date_policy: "kapiloto-target-date-utc-v1", history, memberships, claims: [], tenures: [],
  };
}

const candidate = (state: FixtureSquadState, id = NEW) => {
  const found = state.candidates.find((c) => c.canonical_player_id === id);
  assert.ok(found, `candidate ${id}`);
  return found;
};
const startKnowledge = (state: FixtureSquadState, id = NEW) => {
  const h = candidate(state, id).history;
  return { starts: h.starts_last.last_10.value, known: h.starts_last.last_10.available_matches, start_known_matches: h.start_known_matches };
};

test("new signing: complete-lineup absences before he joined are unknown in V2, known non-starts in V1", () => {
  // P joins on Oct 20. Oct 5 and Oct 12: complete XI without him. Oct 25: he starts.
  const inp = inputs([fixture(25, [row(NEW, "starter")]), fixture(12), fixture(5)], [membership(NEW, { from: "2026-10-20" })]);
  const v1 = buildFixtureSquadState(inp, POLICY);
  const v2 = buildFixtureSquadStateV2(inp, POLICY);
  // V1 is preserved exactly for replay: both absences counted as non-starts.
  assert.deepEqual(startKnowledge(v1), { starts: 1, known: 3, start_known_matches: 3 });
  // V2: Oct 5 and Oct 12 are unknown; only Oct 25 is known.
  assert.deepEqual(startKnowledge(v2), { starts: 1, known: 1, start_known_matches: 1 });
  // The 1D Beta start denominator no longer includes Oct 5 or Oct 12.
  const raw = (state: FixtureSquadState) =>
    buildLineupForecast(lineupModelInput(inp, state)).players.find((p) => p.canonical_player_id === NEW)!.raw_start_probability_bp;
  assert.equal(raw(v1), Math.round(((1 + 1) / (3 + 2)) * 10000));
  assert.equal(raw(v2), Math.round(((1 + 1) / (1 + 2)) * 10000));
  // Appearance and minutes knownness never used absences; they are identical.
  assert.deepEqual(candidate(v2).history.appearances_last, candidate(v1).history.appearances_last);
  assert.deepEqual(candidate(v2).history.minutes_last, candidate(v1).history.minutes_last);
});

test("V2 historical membership rule: certain counts, possible and outside fail closed, rows always win", () => {
  const history = [fixture(25), fixture(12), fixture(5)]; // NEW absent everywhere unless a case adds a row
  const knownFor = (memberships: MembershipAsOfRow[], h = history) => startKnowledge(buildFixtureSquadStateV2(inputs(h, memberships), POLICY)).known;

  // Certainly a member for the whole window: all three absences are known non-starts.
  assert.equal(knownFor([membership(NEW, { from: "2026-07-01" })]), 3);
  // Open membership covering only the last fixture.
  assert.equal(knownFor([membership(NEW, { from: "2026-10-20" })]), 1);
  // Uncertain start (somewhere between Oct 1 and Oct 15): Oct 5 and Oct 12 are possible -> unknown.
  assert.equal(knownFor([membership(NEW, { from: "2026-10-01", fromLatest: "2026-10-15" })]), 1);
  // Membership ended before the fixtures: outside -> unknown.
  assert.equal(knownFor([membership(NEW, { from: "2026-07-01", to: "2026-09-30" })]), 0);
  // Uncertain end (Oct 10..Oct 20): Oct 5 certain, Oct 12 possible, Oct 25 outside.
  assert.equal(knownFor([membership(NEW, { from: "2026-07-01", to: "2026-10-10", toLatest: "2026-10-20" })]), 1);
  // No membership at all (a historical-only candidate): only his explicit row
  // is known; both absences are unknown.
  const oneRow = [fixture(25, [row(NEW, "bench", { appeared: false, minutes_played: 0 })]), fixture(12), fixture(5)];
  assert.equal(knownFor([], oneRow), 1);
  // A membership of ANOTHER player never counts.
  assert.equal(knownFor([membership(P(98), { from: "2026-07-01" })], oneRow), 1);
  // ... while his own certain membership makes both absences known.
  assert.equal(knownFor([membership(NEW, { from: "2026-07-01" })], oneRow), 3);

  // Explicit rows are direct evidence and override missing or uncertain membership.
  const benchHistory = [fixture(25, [row(NEW, "bench", { appeared: false, minutes_played: 0 })]), fixture(12), fixture(5)];
  const bench = buildFixtureSquadStateV2(inputs(benchHistory, []), POLICY);
  assert.deepEqual(startKnowledge(bench), { starts: 0, known: 1, start_known_matches: 1 });
  const starterHistory = [fixture(25, [row(NEW, "starter")]), fixture(12), fixture(5)];
  assert.deepEqual(startKnowledge(buildFixtureSquadStateV2(inputs(starterHistory, []), POLICY)), { starts: 1, known: 1, start_known_matches: 1 });
  // An explicit unknown lineup role stays unknown, even with certain membership.
  const unknownHistory = [fixture(25, [row(NEW, "unknown")]), fixture(12), fixture(5)];
  assert.equal(knownFor([membership(NEW, { from: "2026-07-01" })], unknownHistory), 2);
  // Absence from a PARTIAL lineup is always unknown, even with certain membership.
  const partialHistory = [fixture(25, [], "partial"), fixture(12, [], "partial"), fixture(5)];
  assert.equal(knownFor([membership(NEW, { from: "2026-07-01" })], partialHistory), 1);
});

test("multiple membership assertions: the strongest applicable coverage wins, deterministically", () => {
  const history = [fixture(25), fixture(12), fixture(5)];
  const knownFor = (memberships: MembershipAsOfRow[]) => startKnowledge(buildFixtureSquadStateV2(inputs(history, memberships), POLICY)).known;
  const certainFromOct20 = membership(NEW, { from: "2026-10-20" }, "k-a");
  const possibleWholeOctober = membership(NEW, { from: "2026-09-25", fromLatest: "2026-10-30" }, "k-b");
  const endedSeptember = membership(NEW, { from: "2026-07-01", to: "2026-09-30" }, "k-c");
  // possible + certain -> certain where either is certain (Oct 25 only).
  assert.equal(knownFor([possibleWholeOctober, certainFromOct20]), 1);
  // Order of assertions never matters.
  assert.equal(knownFor([certainFromOct20, possibleWholeOctober]), 1);
  // possible + possible -> unknown.
  assert.equal(knownFor([possibleWholeOctober, membership(NEW, { from: "2026-10-01", fromLatest: "2026-10-28" }, "k-d")]), 0);
  // An assertion that ended is not negative evidence against another stint: two stints with a gap.
  assert.equal(knownFor([endedSeptember, certainFromOct20]), 1);
  assert.equal(knownFor([endedSeptember, membership(NEW, { from: "2026-10-04" }, "k-e")]), 3);
  // The helper itself.
  assert.equal(historicalMembershipCoverage([endedSeptember, possibleWholeOctober], "2026-10-12"), "possible");
  assert.equal(historicalMembershipCoverage([endedSeptember], "2026-10-12"), "outside");
  assert.equal(historicalMembershipCoverage([], "2026-10-12"), "outside");
  assert.equal(historicalMembershipCoverage([endedSeptember, certainFromOct20], "2026-10-25"), "certain");
  // V2 reads the historical bounds, never the target-date `coverage` field (set to "certain" on all rows here).
  assert.equal(knownFor([endedSeptember]), 0);
});

test("historical dates are the UTC calendar date of the observation kickoff, inclusive at membership bounds", () => {
  assert.equal(historicalFixtureDate("2026-10-20T18:00:00+00:00"), "2026-10-20");
  assert.equal(historicalFixtureDate("2026-10-21T00:30:00+02:00"), "2026-10-20"); // 22:30 UTC
  assert.equal(historicalFixtureDate("2026-10-20T23:30:00-02:00"), "2026-10-21"); // 01:30 UTC next day
  assert.throws(() => historicalFixtureDate("not a date"));
  const joinsOct20 = [membership(NEW, { from: "2026-10-20" })];
  const knownAt = (kickoff: string) => startKnowledge(buildFixtureSquadStateV2(inputs([fixture(20, [], "complete", kickoff)], joinsOct20), POLICY)).known;
  assert.equal(knownAt("2026-10-20T00:00:00+00:00"), 1); // first day of the membership is covered
  assert.equal(knownAt("2026-10-20T01:00:00+03:00"), 0); // 22:00 UTC on Oct 19: before the membership
});

test("merged identities: memberships and rows are matched by canonical id", () => {
  // The membership was stored for raw id A, which is now merged into NEW; history rows already read NEW.
  const A = P(97);
  const history = [fixture(25, [row(NEW, "starter", { observed_player_id: A })]), fixture(12), fixture(5)];
  const v2 = buildFixtureSquadStateV2(inputs(history, [membership(NEW, { from: "2026-07-01" }, "k-merged", A)]), POLICY);
  assert.deepEqual(startKnowledge(v2), { starts: 1, known: 3, start_known_matches: 3 });
  assert.ok(candidate(v2).observed_player_ids.includes(A));
});

test("V1 and V2 from the same raw inputs: versioned, deterministic, and they differ only in historical start knownness", () => {
  const v1 = buildFixtureSquadState(GOLDEN_INPUTS, GOLDEN_POLICY);
  const v2 = buildFixtureSquadStateV2(GOLDEN_INPUTS, GOLDEN_POLICY);
  assert.deepEqual([v2.contract_version, v2.builder_version, v2.features_version], ["kapiloto-squad-state-v1", "kapiloto-squad-state-builder-v2", "kapiloto-squad-features-v2"]);
  assert.deepEqual([v1.contract_version, v1.builder_version, v1.features_version], ["kapiloto-squad-state-v1", "kapiloto-squad-state-builder-v1", "kapiloto-squad-features-v1"]);
  // Deterministic.
  assert.equal(squadStateArtifact(buildFixtureSquadStateV2(GOLDEN_INPUTS, GOLDEN_POLICY)).sha256, squadStateArtifact(v2).sha256);
  assert.equal(buildFixtureSquadStateFor("kapiloto-squad-state-builder-v2", GOLDEN_INPUTS, GOLDEN_POLICY).builder_version, "kapiloto-squad-state-builder-v2");
  // Different hashes, explainably.
  assert.notEqual(squadStateArtifact(v1).sha256, squadStateArtifact(v2).sha256);
  const startFields = ["start_known_matches", "starts_last", "consecutive_starts"] as const;
  const strip = (s: FixtureSquadState) => ({
    ...s, builder_version: null, features_version: null,
    candidates: s.candidates.map((c) => ({ ...c, history: Object.fromEntries(Object.entries(c.history).filter(([k]) => !(startFields as readonly string[]).includes(k))) })),
  });
  assert.equal(canonicalJson(strip(v2)), canonicalJson(strip(v1)));
  const changed = v2.candidates.filter((c, i) => canonicalJson(c.history) !== canonicalJson(v1.candidates[i].history)).map((c) => c.canonical_player_id);
  // P(20) joined Oct 18 (absent Oct 5/12), P(11) left Oct 15 (absent Oct 25), P(21) only "possible": all fail closed in V2.
  const G = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  assert.deepEqual(changed.sort(), [G(11), G(20), G(21)].sort());
  for (const c of v2.candidates) {
    const before = v1.candidates.find((x) => x.canonical_player_id === c.canonical_player_id)!;
    assert.ok(c.history.start_known_matches <= before.history.start_known_matches);
    assert.equal(c.history.starts, before.history.starts); // positives come only from rows
  }
  // The lineup model still produces a valid V1 output on a V2 state.
  const output = buildLineupForecast(lineupModelInput(GOLDEN_INPUTS, v2));
  assert.equal(output.model_version, "kapiloto-lineup-model-v1");
});

test("builder/features versions are a closed, paired set; artifacts with anything else are refused", () => {
  assert.equal(isSupportedSquadStateBuild("kapiloto-squad-state-builder-v1", "kapiloto-squad-features-v1"), true);
  assert.equal(isSupportedSquadStateBuild("kapiloto-squad-state-builder-v2", "kapiloto-squad-features-v2"), true);
  assert.equal(isSupportedSquadStateBuild("kapiloto-squad-state-builder-v2", "kapiloto-squad-features-v1"), false);
  assert.equal(isSupportedSquadStateBuild("kapiloto-squad-state-builder-v1", "kapiloto-squad-features-v2"), false);
  assert.equal(isSupportedSquadStateBuild("kapiloto-squad-state-builder-v3", "kapiloto-squad-features-v3"), false);
  assert.equal(isSupportedSquadStateBuild("toString", undefined), false);
  assert.throws(() => buildFixtureSquadStateFor("kapiloto-squad-state-builder-v3" as never, GOLDEN_INPUTS, GOLDEN_POLICY), /unsupported squad-state builder/);

  const v2 = buildFixtureSquadStateV2(GOLDEN_INPUTS, GOLDEN_POLICY);
  const forged = (patch: Partial<FixtureSquadState>) => {
    const text = canonicalJson({ ...v2, ...patch });
    return () => parseSquadStateArtifact(text, squadStateArtifact({ ...v2, ...patch } as FixtureSquadState).sha256);
  };
  assert.throws(forged({ features_version: "kapiloto-squad-features-v1" as never }), /unsupported contract or builder\/features/);
  assert.throws(forged({ builder_version: "kapiloto-squad-state-builder-v3" as never }), /unsupported contract or builder\/features/);
  assert.throws(forged({ contract_version: "kapiloto-squad-state-v2" as never }), /unsupported contract or builder\/features/);
  assert.equal(parseSquadStateArtifact(squadStateArtifact(v2).canonicalJson, squadStateArtifact(v2).sha256).builder_version, "kapiloto-squad-state-builder-v2");
});
