import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateSolUsageCostMicros,
  KAPILOTO_SOL_PRICING_VERSION,
} from "./research-cost";

test("prices Sol usage with cached input and web search separately", () => {
  assert.equal(KAPILOTO_SOL_PRICING_VERSION, "gpt-6.1-sol-standard-2026-10-22");
  assert.equal(
    estimateSolUsageCostMicros({
      inputTokens: 580_987,
      cachedInputTokens: 55_035,
      outputTokens: 39_371,
      webSearchCalls: 65,
    }),
    2_101_118,
  );
});

test("reasoning is not double-counted and missing provider usage stays unpriced", () => {
  assert.equal(
    estimateSolUsageCostMicros({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      webSearchCalls: null,
    }),
    null,
  );
});
