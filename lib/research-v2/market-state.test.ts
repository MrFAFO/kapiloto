import assert from "node:assert/strict";
import test from "node:test";

import { admitAdjustments, CANDIDATE_ADJUSTMENT_POLICY } from "./adjustments";
import { buildDeterministicBase, CANDIDATE_DETERMINISTIC_BASE_CONFIG, type DeterministicBaseConfig } from "./base";
import { computeResearchV2Forecast } from "./forecast";
import { CANDIDATE_SOURCE_POLICY } from "./sources";
import { baseInputs, CONFIGS, CUTOFF_AT, hoursBeforeCutoff, item, proposal, quotes, verified } from "./test-support";

const MINUTE = 60_000;
const beforeCutoff = (ms: number) => new Date(Date.parse(CUTOFF_AT) - ms).toISOString();
const market = (marketQuotes: ReturnType<typeof quotes>) =>
  buildDeterministicBase(baseInputs({ marketQuotes }), CONFIGS.base).market;

test("market time is the provider's update, not Kapiloto's retrieval", () => {
  const state = market(quotes({ capturedAt: hoursBeforeCutoff(1 / 60), sourceUpdatedAt: hoursBeforeCutoff(4) }));
  assert.equal(state.policy.version, "market-state-v2");
  assert.equal(state.quality, "standard");
  assert.equal(state.informationTimeSource, "provider_update");
  assert.equal(state.informationAgeMinutesAtCutoff, 240);
  assert.equal(state.informationEarliestAt, hoursBeforeCutoff(4));
  assert.equal(state.retrievedAt, hoursBeforeCutoff(1 / 60));
});

test("freshness boundary: a 6-hour-old oldest price is standard, one millisecond more is not", () => {
  const atLimit = market(quotes({ capturedAt: hoursBeforeCutoff(0.1), sourceUpdatedAt: beforeCutoff(360 * MINUTE) }));
  assert.equal(atLimit.quality, "standard");
  const over = market(quotes({ capturedAt: hoursBeforeCutoff(0.1), sourceUpdatedAt: beforeCutoff(360 * MINUTE + 1) }));
  assert.equal(over.quality, "thin");
  assert.equal(over.reason, "market_information_not_fresh");
});

test("staleness boundary: a 24-hour-old price is usable but thin, one millisecond more is stale", () => {
  const atLimit = buildDeterministicBase(
    baseInputs({ marketQuotes: quotes({ capturedAt: hoursBeforeCutoff(0.1), sourceUpdatedAt: beforeCutoff(1440 * MINUTE) }) }),
    CONFIGS.base,
  );
  assert.equal(atLimit.market.quality, "thin");
  assert.equal(atLimit.arms.p_market_v1.status, "available");
  const stale = buildDeterministicBase(
    baseInputs({ marketQuotes: quotes({ capturedAt: hoursBeforeCutoff(0.1), sourceUpdatedAt: beforeCutoff(1440 * MINUTE + 1) }) }),
    CONFIGS.base,
  );
  assert.equal(stale.market.quality, "stale");
  assert.equal(stale.arms.p_market_v1.status, "unavailable");
});

test("a quote without a provider update time can never support the standard label", () => {
  const none = market(quotes({ sourceUpdatedAt: null }));
  assert.equal(none.quality, "thin");
  assert.equal(none.reason, "provider_update_time_missing");
  assert.equal(none.informationTimeSource, "capture_fallback");
  const mixed = market(quotes({ sourceUpdatedAt: (index) => (index === 0 ? null : hoursBeforeCutoff(3)) }));
  assert.equal(mixed.quality, "thin");
  assert.equal(mixed.informationTimeSource, "mixed");
  assert.equal(mixed.reason, "provider_update_time_missing");
});

test("a provider time later than retrieval (clock skew) never makes a price look newer", () => {
  const state = market(quotes({ capturedAt: hoursBeforeCutoff(2), sourceUpdatedAt: hoursBeforeCutoff(1) }));
  assert.equal(state.informationLatestAt, hoursBeforeCutoff(2));
});

test("a quote retrieved after the cutoff is excluded even if the provider updated it earlier", () => {
  const after = new Date(Date.parse(CUTOFF_AT) + MINUTE).toISOString();
  const state = market(quotes({ capturedAt: after, sourceUpdatedAt: hoursBeforeCutoff(1) }));
  assert.equal(state.quality, "missing");
});

test("an unknown market-state policy version is refused", () => {
  const legacy = {
    ...CANDIDATE_DETERMINISTIC_BASE_CONFIG,
    marketState: { ...CANDIDATE_DETERMINISTIC_BASE_CONFIG.marketState, version: "market-state-v1" },
  } as unknown as DeterministicBaseConfig;
  assert.throws(() => buildDeterministicBase(baseInputs(), legacy), /research_v2_market_state_policy_unsupported/);
});

const forecastWith = (marketQuotes: ReturnType<typeof quotes>, publishedAt: string) =>
  computeResearchV2Forecast(
    { base: baseInputs({ marketQuotes }), research: { verification: verified([item()], { publishedAt }), proposals: [proposal()] } },
    CONFIGS,
  );

test("evidence after the provider update but before retrieval now shifts the forecast", () => {
  const providerOld = quotes({ capturedAt: hoursBeforeCutoff(1 / 60), sourceUpdatedAt: hoursBeforeCutoff(3) });
  const decision = forecastWith(providerOld, hoursBeforeCutoff(1)).adjustments[0];
  assert.equal(decision.path, "full");
  assert.equal(decision.marketInformationLatestAt, hoursBeforeCutoff(3));
  assert.equal(forecastWith(providerOld, hoursBeforeCutoff(4)).adjustments[0].path, "market_likely_incorporated");
});

test("the oldest price drives freshness and the newest price drives the full path", () => {
  const spread = quotes({ capturedAt: hoursBeforeCutoff(0.1), sourceUpdatedAt: (index) => hoursBeforeCutoff(3 - index * 0.5) });
  const state = market(spread);
  assert.equal(state.informationAgeMinutesAtCutoff, 180);
  assert.equal(state.informationLatestAt, hoursBeforeCutoff(1.5));
  assert.equal(forecastWith(spread, hoursBeforeCutoff(2)).adjustments[0].path, "market_likely_incorporated", "between oldest and newest price");
  assert.equal(forecastWith(spread, hoursBeforeCutoff(1)).adjustments[0].path, "full", "after the newest price");
});

test("the adjustment policy refuses a market state of another version", () => {
  const state = market(quotes());
  assert.throws(
    () =>
      admitAdjustments({
        proposals: [proposal()],
        evidence: verified([item()]).evidence,
        market: { ...state, policy: { ...state.policy, version: "market-state-v1" } },
        sourcePolicy: CANDIDATE_SOURCE_POLICY,
        policy: CANDIDATE_ADJUSTMENT_POLICY,
      }),
    /research_v2_market_state_mismatch/,
  );
  assert.equal(CANDIDATE_ADJUSTMENT_POLICY.version, "adjustment-policy-v2");
});
