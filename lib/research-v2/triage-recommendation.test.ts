import assert from "node:assert/strict";
import test from "node:test";

import { buildDeterministicBase } from "./base";
import type { CombinationResult } from "./combination";
import { classifyLiveDevFixture, FORMAL_SAMPLING_ENABLED, ROUND_264201_LIVE_DEV_FIXTURES } from "./live-dev";
import { configProvenance } from "./provenance";
import { allocateDoubles, CANDIDATE_RECOMMENDATION_POLICY, recommendFixture } from "./recommendation";
import { assignTriage, CANDIDATE_TRIAGE_CONFIG, extractTriageFeatures, type TriageContext } from "./triage";
import { baseInputs, CONFIGS, quotes } from "./test-support";

const quietContext: TriageContext = {
  managerChangeDaysAgo: { home: null, away: null },
  restDays: { home: 6, away: 7 },
  matchesLast14Days: { home: 2, away: 2 },
  competition: { isCup: false, isSecondLeg: false },
  promoted: { home: false, away: false },
  unresolvedAvailability: 0,
};

const features = (overrides: Partial<TriageContext> = {}, inputs = baseInputs()) =>
  extractTriageFeatures(buildDeterministicBase(inputs, CONFIGS.base), { ...quietContext, ...overrides }, {
    statArm: CANDIDATE_TRIAGE_CONFIG.statArm,
    neutralVenue: false,
  });

test("triage features are pure facts, separate from scoring config", () => {
  const extracted = features();
  assert.equal(extracted.marketQuality, "standard");
  assert.equal(extracted.statAvailable, true);
  assert.equal(typeof extracted.disagreementBp, "number");
  assert.deepEqual(features(), extracted, "extraction is deterministic");
  assert.ok(!("tier" in extracted) && !("score" in extracted));
});

test("every fixture gets the cheap availability/rotation check; deeper research follows uncertainty", () => {
  const strictConfig = { ...CANDIDATE_TRIAGE_CONFIG, disagreementBands: [{ minBp: 100_000, points: 1 }] };
  const quiet = assignTriage(features(), strictConfig);
  assert.equal(quiet.tier, "minimal");
  assert.deepEqual(
    quiet.needs.map((need) => need.needId),
    ["availability_rotation_check:away", "availability_rotation_check:home"],
  );
  const busy = assignTriage(
    features({ managerChangeDaysAgo: { home: 10, away: null }, restDays: { home: 2, away: 6 }, unresolvedAvailability: 1 }),
    strictConfig,
  );
  assert.equal(busy.tier, "deep");
  assert.ok(busy.needs.some((need) => need.kind === "manager_change_context"));
  assert.ok(busy.needs.some((need) => need.kind === "congestion_rotation"));
  assert.ok(busy.needs.some((need) => need.kind === "availability_rotation_check"));
  assert.ok(busy.budget.maxSearches > quiet.budget.maxSearches);

  const noMarket = assignTriage(features({}, baseInputs({ marketQuotes: [] })), strictConfig);
  assert.ok(noMarket.reasons.includes("market_missing"));
  assert.ok(noMarket.needs.some((need) => need.kind === "coverage_gap"));
});

test("triage thresholds are config: changing them changes the tier without changing the engine", () => {
  const extracted = features({ managerChangeDaysAgo: { home: 10, away: null } });
  const lenient = assignTriage(extracted, { ...CANDIDATE_TRIAGE_CONFIG, tierMinScore: { standard: 50, deep: 60 } });
  const strict = assignTriage(extracted, { ...CANDIDATE_TRIAGE_CONFIG, version: "triage-v1b", tierMinScore: { standard: 1, deep: 2 } });
  assert.equal(lenient.tier, "minimal");
  assert.equal(strict.tier, "deep");
  assert.equal(lenient.engineVersion, strict.engineVersion);
  assert.notEqual(lenient.config.sha256, strict.config.sha256);
  assert.equal(lenient.score, strict.score, "the score itself does not depend on tier thresholds");
});

const available = (candidateId: string, home: number, draw: number, away: number): CombinationResult => ({
  candidateId,
  status: "available",
  probabilities: { home, draw, away },
  usedArms: ["p_market_v1"],
  config: configProvenance({ id: candidateId, version: "v", status: "candidate" }),
});

test("no_signal and insufficient_data are deterministic and the threshold is configurable", () => {
  const close = [available("log_market65_elo", 0.36, 0.34, 0.3)];
  const first = recommendFixture({ fixtureId: "f", gameNumber: 1, candidates: close }, CANDIDATE_RECOMMENDATION_POLICY);
  assert.equal(first.state, "no_signal");
  assert.deepEqual(recommendFixture({ fixtureId: "f", gameNumber: 1, candidates: close }, CANDIDATE_RECOMMENDATION_POLICY), first);
  const lowered = recommendFixture({ fixtureId: "f", gameNumber: 1, candidates: close }, { ...CANDIDATE_RECOMMENDATION_POLICY, noSignalMarginBp: 100 });
  assert.equal(lowered.state, "pick");
  assert.equal(lowered.topOutcome, "1");

  const unavailable: CombinationResult = { candidateId: "log_market65_elo", status: "unavailable", reason: "market_missing", config: close[0].config };
  const none = recommendFixture({ fixtureId: "f", gameNumber: 1, candidates: [unavailable] }, CANDIDATE_RECOMMENDATION_POLICY);
  assert.equal(none.state, "insufficient_data");
  assert.equal(none.topOutcome, null);
});

test("ticket doubles go to the largest second-outcome gains, deterministically", () => {
  const recommendations = [
    recommendFixture({ fixtureId: "a", gameNumber: 1, candidates: [available("market_only", 0.7, 0.2, 0.1)] }, CANDIDATE_RECOMMENDATION_POLICY),
    recommendFixture({ fixtureId: "b", gameNumber: 2, candidates: [available("market_only", 0.4, 0.33, 0.27)] }, CANDIDATE_RECOMMENDATION_POLICY),
    recommendFixture({ fixtureId: "c", gameNumber: 3, candidates: [available("market_only", 0.45, 0.33, 0.22)] }, CANDIDATE_RECOMMENDATION_POLICY),
    recommendFixture({ fixtureId: "d", gameNumber: 4, candidates: [] }, CANDIDATE_RECOMMENDATION_POLICY),
  ];
  const ticket = allocateDoubles(recommendations, 1, CANDIDATE_RECOMMENDATION_POLICY);
  assert.deepEqual(ticket.fixtures.map((f) => f.finalState), ["pick", "double", "pick", "insufficient_data"]);
  assert.deepEqual(allocateDoubles([...recommendations].reverse(), 1, CANDIDATE_RECOMMENDATION_POLICY), ticket);
});

test("live-dev fixtures are never a formal sample, and started fixtures are excluded", () => {
  assert.equal(FORMAL_SAMPLING_ENABLED, false);
  assert.deepEqual(ROUND_264201_LIVE_DEV_FIXTURES.map((f) => f.gameNumber), [1, 7, 8, 9, 12]);
  const fixture = ROUND_264201_LIVE_DEV_FIXTURES[1];
  const kickoffAt = "2026-10-25T14:00:00Z";
  assert.deepEqual(classifyLiveDevFixture({ fixtureId: fixture.fixtureId, kickoffAt, status: "upcoming", now: new Date("2026-10-25T10:00:00Z") }), { status: "live_dev", formalSample: false });
  assert.equal(classifyLiveDevFixture({ fixtureId: fixture.fixtureId, kickoffAt, status: "upcoming", now: new Date("2026-10-25T13:50:00Z") }).status, "excluded_started");
  assert.equal(classifyLiveDevFixture({ fixtureId: fixture.fixtureId, kickoffAt, status: "live", now: new Date("2026-10-25T10:00:00Z") }).status, "excluded_started");
  assert.equal(classifyLiveDevFixture({ fixtureId: "other", kickoffAt, status: "upcoming", now: new Date("2026-10-25T10:00:00Z") }).status, "excluded_not_live_dev");
});

test("a thin market raises triage need and is visible as a feature", () => {
  const extracted = features({}, baseInputs({ marketQuotes: quotes({ bookmakers: 2 }) }));
  assert.equal(extracted.marketQuality, "thin");
  const decision = assignTriage(extracted, CANDIDATE_TRIAGE_CONFIG);
  assert.ok(decision.reasons.includes("market_thin"));
});
