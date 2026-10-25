import assert from "node:assert/strict";
import test from "node:test";

import { applyAdjustments, CANDIDATE_ADJUSTMENT_POLICY, CANDIDATE_EFFECT_SIZES } from "./adjustments";
import { buildDeterministicBase, revalidateMarketState, type MarketState } from "./base";
import type { ClaimDecisionV2 } from "./claim-decisions";
import { applyImpactRules } from "./impact-rules";
import { canonicalJson } from "./provenance";
import { timeClaimAdjustments } from "./research-timing";
import { CANDIDATE_SOURCE_POLICY } from "./sources";
import { baseInputs, CONFIGS, CUTOFF_AT, quotes } from "./test-support";

const MIN = 60_000;
const PRICE_AT = new Date(Date.parse(CUTOFF_AT) - 60 * MIN).toISOString(); // provider update, 60 min before the base cutoff
const at = (minutesAfterPrice: number, extraMs = 0) => new Date(Date.parse(PRICE_AT) + minutesAfterPrice * MIN + extraMs).toISOString();
const inputs = () => baseInputs({ marketQuotes: quotes({ capturedAt: new Date(Date.parse(CUTOFF_AT) - 5 * MIN).toISOString(), sourceUpdatedAt: PRICE_AT }) });

test("revalidation at the knowledge cutoff: exactly 360 minutes stays standard, 1 ms more is non-fresh", () => {
  const atLimit = revalidateMarketState(inputs(), CONFIGS.base, at(360));
  assert.equal(atLimit.quality, "standard");
  assert.equal(atLimit.informationAgeMinutesAtCutoff, 360);
  const over = revalidateMarketState(inputs(), CONFIGS.base, at(360, 1));
  assert.equal(over.quality, "thin");
  assert.equal(over.reason, "market_information_not_fresh");
  assert.equal(over.baseCutoffAt, CUTOFF_AT);
  assert.equal(over.evaluatedAt, at(360, 1));
});

test("revalidation keeps missing, thin and stale markets as they are", () => {
  assert.equal(revalidateMarketState(baseInputs({ marketQuotes: [] }), CONFIGS.base, at(120)).quality, "missing");
  assert.equal(revalidateMarketState(baseInputs({ marketQuotes: quotes({ bookmakers: 2, sourceUpdatedAt: PRICE_AT, capturedAt: PRICE_AT }) }), CONFIGS.base, at(120)).quality, "thin");
  assert.equal(revalidateMarketState(inputs(), CONFIGS.base, at(24 * 60, 1)).quality, "stale");
});

test("the original base, its arms and hashes are unchanged; inputs are not mutated", () => {
  const stored = inputs();
  const before = canonicalJson(stored);
  const base = buildDeterministicBase(stored, CONFIGS.base);
  const baseBefore = canonicalJson(base);
  revalidateMarketState(stored, CONFIGS.base, at(400));
  assert.equal(canonicalJson(stored), before);
  assert.equal(canonicalJson(base), baseBefore);
  assert.equal(buildDeterministicBase(stored, CONFIGS.base).inputSha256, base.inputSha256);
  assert.equal(base.market.quality, "standard", "the base keeps its own market state");
  assert.throws(() => revalidateMarketState(stored, CONFIGS.base, at(0)), /precedes the base cutoff/);
});

function adjustingClaim(evidenceAt: string | null, timingImprecise = false): ClaimDecisionV2 {
  const impact = applyImpactRules({
    claimId: "C1", subjectKey: "home:player:john keeper", claimKind: "absence", side: "home", statedStatus: "confirmed",
    appliesToThisFixture: true, observation: "reported", verified: true, structuredDuplicate: false, conflict: false,
    role: "goalkeeper", verifiedSquadStatus: "first_choice", rotation: null, evidenceIds: ["C1#0"],
  });
  return {
    claimId: "C1", needId: "availability_rotation_check:home", claimKind: "absence", side: "home", subjectKey: "home:player:john keeper",
    status: "adjusting", reasons: ["corroboration:strong_cluster", `impact:${impact.ruleId}`], acceptedCitations: ["C1#0"], rejectedCitations: [],
    clusters: [{ clusterId: "cl_x", grade: "B" }],
    corroboration: { passed: true, reason: "strong_cluster", clusterGrades: [{ clusterId: "cl_x", grade: "B" }], qualifyingClusters: 1, policy: { id: CANDIDATE_SOURCE_POLICY.id, version: CANDIDATE_SOURCE_POLICY.version, status: "candidate", sha256: "x" } },
    structuredDuplicate: false, availabilityState: "out", conflict: null, impact, proposal: impact.proposal,
    evidenceTimeMs: evidenceAt == null ? null : Date.parse(evidenceAt), timingImprecise,
  };
}

const time = (market: MarketState, claim: ClaimDecisionV2, knowledgeCutoffAt: string) =>
  timeClaimAdjustments({ claims: [claim], market, knowledgeCutoffAt, policy: CANDIDATE_ADJUSTMENT_POLICY }).adjustments[0];

test("market timing on the revalidated state: incorporated, full, ambiguous and stat path", () => {
  const knowledge = at(180);
  const market = revalidateMarketState(inputs(), CONFIGS.base, knowledge);
  assert.equal(market.informationLatestAt, PRICE_AT);
  const before = time(market, adjustingClaim(at(-60)), knowledge);
  assert.deepEqual([before.timing.class, before.decision.path], ["at_or_before_newest_price", "market_likely_incorporated"]);
  const after = time(market, adjustingClaim(at(90)), knowledge);
  assert.deepEqual([after.timing.class, after.decision.path], ["after_newest_price", "full"]);
  const nearPrice = time(market, adjustingClaim(at(30)), knowledge);
  assert.deepEqual([nearPrice.timing.class, nearPrice.decision.path], ["ambiguous", "market_likely_incorporated"], "within the 30-minute margin");
  const imprecise = time(market, adjustingClaim(at(90), true), knowledge);
  assert.deepEqual([imprecise.timing.class, imprecise.decision.path], ["ambiguous", "market_likely_incorporated"], "date-only or no-timezone publication");
  const staleKnowledge = at(360, 1);
  const stale = time(revalidateMarketState(inputs(), CONFIGS.base, staleKnowledge), adjustingClaim(at(300)), staleKnowledge);
  assert.deepEqual([stale.timing.class, stale.decision.path], ["non_fresh_market", "stat_path"], "standard at the base, non-fresh at research time");
  const missing = time(revalidateMarketState(baseInputs({ marketQuotes: [] }), CONFIGS.base, knowledge), adjustingClaim(at(90)), knowledge);
  assert.equal(missing.decision.path, "stat_path");
});

test("timing records its inputs, refuses other market semantics and feeds unchanged effect sizes", () => {
  const knowledge = at(180);
  const market = revalidateMarketState(inputs(), CONFIGS.base, knowledge);
  const timed = time(market, adjustingClaim(at(90)), knowledge);
  assert.deepEqual(timed.timing, { class: "after_newest_price", evidenceAt: at(90), newestPriceAt: PRICE_AT, knowledgeCutoffAt: knowledge, marginMinutes: 30 });
  assert.equal(timed.decision.marketStateVersion, "market-state-v2");
  const applied = applyAdjustments({ home: 0.45, draw: 0.27, away: 0.28 }, [timed.decision], ["full"], CANDIDATE_EFFECT_SIZES);
  assert.equal(applied.appliedShift, -CANDIDATE_EFFECT_SIZES.impact.moderate * CANDIDATE_EFFECT_SIZES.uncertaintyMultiplier.low);
  assert.throws(() => time({ ...market, policy: { ...market.policy, version: "market-state-v1" } }, adjustingClaim(at(90)), knowledge), /market_state_mismatch/);
  const explanatory = { ...adjustingClaim(at(90)), status: "explanatory" as const, proposal: null };
  assert.deepEqual(timeClaimAdjustments({ claims: [explanatory], market, knowledgeCutoffAt: knowledge, policy: CANDIDATE_ADJUSTMENT_POLICY }).adjustments, []);
});
