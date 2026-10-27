import assert from "node:assert/strict";
import test from "node:test";

import {
  getApiFootballMinRequestIntervalMs,
  getKapilotoReasoningEffort,
  getKapilotoRunConfig,
  KAPILOTO_PROMPT_TEMPLATE_SHA256,
  sha256Text,
} from "./research-config";
import { KAPILOTO_SOL_SYSTEM_PROMPT } from "./research-prompt";

test("prompt provenance hash is computed from the actual prompt", () => {
  assert.equal(
    KAPILOTO_PROMPT_TEMPLATE_SHA256,
    sha256Text(KAPILOTO_SOL_SYSTEM_PROMPT),
  );
  assert.match(KAPILOTO_PROMPT_TEMPLATE_SHA256, /^[a-f0-9]{64}$/);
});

test("run config keeps exact Sol model id in server environment", () => {
  const config = getKapilotoRunConfig({
    KAPILOTO_OPENAI_MODEL: "configured-sol-model",
    KAPILOTO_MAX_ATTEMPTS_PER_TASK: "4",
  });

  assert.equal(config.modelKey, "configured-sol-model");
  assert.equal(config.maxAttemptsPerTask, 4);
  assert.equal(config.executionTopology, "fixture_fanout");
  assert.equal(config.calibrationVersion, null);
});

test("invalid model/reasoning config fails closed", () => {
  assert.throws(() => getKapilotoRunConfig({}), /KAPILOTO_OPENAI_MODEL/);
  assert.throws(
    () =>
      getKapilotoReasoningEffort({
        KAPILOTO_OPENAI_REASONING_EFFORT: "extreme",
      }),
    /low, medium, or high/,
  );
});

test("API-Football interval is configurable without code changes", () => {
  assert.equal(getApiFootballMinRequestIntervalMs({}), 6500);
  assert.equal(
    getApiFootballMinRequestIntervalMs({
      API_FOOTBALL_MIN_REQUEST_INTERVAL_MS: "250",
    }),
    250,
  );
});
