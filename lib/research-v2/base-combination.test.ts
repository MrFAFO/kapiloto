import assert from "node:assert/strict";
import test from "node:test";

import { buildDeterministicBase } from "./base";
import { CANDIDATE_COMBINATIONS, combineCandidate, type CombinationCandidate } from "./combination";
import { computeResearchV2Forecast, forecastEvaluationArms } from "./forecast";
import { toBasisPoints } from "./probability";
import { canonicalJson } from "./provenance";
import { recommendFixture, CANDIDATE_RECOMMENDATION_POLICY } from "./recommendation";
import { baseInputs, CONFIGS, hoursBeforeCutoff, item, proposal, quotes, verified } from "./test-support";

const bp = (result: { status: string; probabilities?: { home: number; draw: number; away: number } }) =>
  result.status === "available" && result.probabilities ? toBasisPoints(result.probabilities) : result.status;

test("deterministic base replay is bit-identical, including from serialized stored inputs", () => {
  const inputs = baseInputs();
  const first = buildDeterministicBase(inputs, CONFIGS.base);
  const second = buildDeterministicBase(JSON.parse(JSON.stringify(inputs)), CONFIGS.base);
  assert.equal(canonicalJson(second), canonicalJson(first));
  assert.equal(second.inputSha256, first.inputSha256);
  for (const arm of Object.values(first.arms)) {
    const replayed = second.arms[arm.arm];
    if (arm.status === "available" && replayed.status === "available") {
      assert.equal(replayed.probabilities.home, arm.probabilities.home);
      assert.equal(replayed.probabilities.draw, arm.probabilities.draw);
      assert.equal(replayed.probabilities.away, arm.probabilities.away);
    }
  }
});

test("golden replay: stored reference inputs reproduce the frozen forecast exactly", () => {
  const inputs = { base: baseInputs(), research: { verification: verified([item()]), proposals: [proposal()] } };
  const forecast = computeResearchV2Forecast(JSON.parse(JSON.stringify(inputs)), CONFIGS);
  assert.equal(forecast.inputSha256, "52478eb169c0f97318178b9c504c96cae56caf68d88088775b9776372beed036");
  assert.deepEqual(bp(forecast.base.arms.p_league_base_v1), { home: 4726, draw: 2049, away: 3225 });
  assert.deepEqual(bp(forecast.base.arms.p_stat_elo_v1), { home: 6819, draw: 1522, away: 1659 });
  assert.deepEqual(bp(forecast.base.arms.p_market_v1), { home: 5004, draw: 2690, away: 2306 });
  assert.equal(forecast.base.arms.p_stat_goal_model_v1.status, "unavailable");
  const log65 = forecast.candidates.find((candidate) => candidate.candidateId === "log_market65_elo");
  assert.deepEqual(bp(log65!.pre), { home: 5670, draw: 2241, away: 2089 });
  assert.deepEqual(bp(log65!.post), { home: 5225, draw: 2328, away: 2447 });
  assert.equal(log65!.fullShift, -0.12);
  assert.equal(
    canonicalJson(computeResearchV2Forecast(inputs, CONFIGS)),
    canonicalJson(forecast),
    "replaying twice gives identical output",
  );
});

test("changing one candidate's blend config changes only that arm", () => {
  const baseline = computeResearchV2Forecast({ base: baseInputs(), research: null }, CONFIGS);
  const modified: CombinationCandidate[] = CANDIDATE_COMBINATIONS.map((candidate) =>
    candidate.id === "log_market65_elo" && candidate.kind === "log_pool" ? { ...candidate, version: "combination-v1b", marketWeight: 0.9 } : candidate,
  );
  const changed = computeResearchV2Forecast({ base: baseInputs(), research: null }, { ...CONFIGS, combinations: modified });
  assert.equal(canonicalJson(changed.base), canonicalJson(baseline.base));
  for (const candidate of baseline.candidates) {
    const other = changed.candidates.find((item) => item.candidateId === candidate.candidateId)!;
    if (candidate.candidateId === "log_market65_elo") {
      assert.notEqual(canonicalJson(other.pre), canonicalJson(candidate.pre));
    } else {
      assert.equal(canonicalJson(other), canonicalJson(candidate), candidate.candidateId);
    }
  }
});

test("a stale market degrades explicitly and never silently feeds a market candidate", () => {
  const base = buildDeterministicBase(baseInputs({ marketQuotes: quotes({ capturedAt: hoursBeforeCutoff(30) }) }), CONFIGS.base);
  assert.equal(base.market.quality, "stale");
  assert.equal(base.arms.p_market_v1.status, "unavailable");
  for (const candidate of CANDIDATE_COMBINATIONS.filter((item) => item.kind !== "stat_only")) {
    const result = combineCandidate(base, candidate);
    assert.equal(result.status, "unavailable", candidate.id);
    assert.match(result.status === "unavailable" ? result.reason : "", /market_stale/);
  }
});

test("a thin market is labelled and can be excluded by a candidate's minimum quality", () => {
  const base = buildDeterministicBase(baseInputs({ marketQuotes: quotes({ bookmakers: 2 }) }), CONFIGS.base);
  assert.equal(base.market.quality, "thin");
  const strict: CombinationCandidate = { id: "strict_market", version: "x", status: "candidate", kind: "market_only", minMarketQuality: "standard" };
  const result = combineCandidate(base, strict);
  assert.equal(result.status, "unavailable");
  assert.equal(result.status === "unavailable" ? result.reason : "", "market_below_standard:thin");
});

test("missing p_market or p_stat degrades safely to whatever remains, and to insufficient_data when nothing does", () => {
  const noMarket = computeResearchV2Forecast({ base: baseInputs({ marketQuotes: [] }), research: null }, CONFIGS);
  assert.equal(noMarket.base.market.quality, "missing");
  const noMarketRecommendation = recommendFixture({ fixtureId: "fixture-1", gameNumber: 3, candidates: noMarket.candidates.map((c) => c.post) }, CANDIDATE_RECOMMENDATION_POLICY);
  assert.equal(noMarketRecommendation.candidateId, "stat_elo_only");

  const unmapped = baseInputs();
  unmapped.fixture = { ...unmapped.fixture, homeTeamKey: null };
  const noStat = computeResearchV2Forecast({ base: unmapped, research: null }, CONFIGS);
  assert.equal(noStat.base.arms.p_stat_elo_v1.status, "unavailable");
  const noStatRecommendation = recommendFixture({ fixtureId: "fixture-1", gameNumber: 3, candidates: noStat.candidates.map((c) => c.post) }, CANDIDATE_RECOMMENDATION_POLICY);
  assert.equal(noStatRecommendation.candidateId, "market_only");

  const neither = baseInputs({ marketQuotes: [] });
  neither.fixture = { ...neither.fixture, homeTeamKey: null };
  const empty = computeResearchV2Forecast({ base: neither, research: null }, CONFIGS);
  const emptyRecommendation = recommendFixture({ fixtureId: "fixture-1", gameNumber: 3, candidates: empty.candidates.map((c) => c.post) }, CANDIDATE_RECOMMENDATION_POLICY);
  assert.equal(emptyRecommendation.state, "insufficient_data");
});

test("every arm, before and after research, is exposed for forward evaluation", () => {
  const forecast = computeResearchV2Forecast({ base: baseInputs(), research: null }, CONFIGS);
  const arms = forecastEvaluationArms(forecast).map((arm) => arm.arm);
  assert.ok(arms.includes("p_market_v1") && arms.includes("p_stat_elo_v1") && arms.includes("p_league_base_v1"));
  assert.ok(arms.includes("log_market65_elo:pre_research") && arms.includes("log_market65_elo:post_research"));
  assert.equal(new Set(arms).size, arms.length);
});
