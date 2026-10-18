import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureKapilotoResearch,
  type KapilotoResearchPreparer,
  type KapilotoResearchRpc,
  type KapilotoRpcCall,
  type KapilotoRpcResponse,
  type KapilotoRunConfig,
} from "./research-request-service";

const config: KapilotoRunConfig = {
  modelKey: "openai-sol",
  researchProtocolVersion: "kapiloto-research-v1",
  derivationVersion: "kapiloto-derivation-v1",
  sourcePolicyVersion: "source-v1",
  recencyPolicyVersion: "recency-v1",
  reliabilityFormulaVersion: "reliability-v1",
  blendPolicyVersion: "blend-v1",
  calibrationVersion: null,
  promptTemplateSha256: "a".repeat(64),
  executionTopology: "fixture_fanout",
  maxAttemptsPerTask: 3,
};

const request = {
  userId: "user-1",
  roundId: "round-1",
  roundGameId: "game-1",
  intent: "consult" as const,
  idempotencyKey: "idem-1",
  basedOnRunId: null,
  refreshEligible: false,
  breakerOpen: false,
};

function response(
  outcome: KapilotoRpcResponse["outcome"],
  overrides: Partial<KapilotoRpcResponse> = {},
): KapilotoRpcResponse {
  return {
    replayed: false,
    outcome,
    round_id: "round-1",
    runs_consumed: 0,
    active_run_id: null,
    current_run_id: null,
    ...overrides,
  };
}

test("cached request does not prepare structured research inputs", async () => {
  let prepareCalls = 0;
  const rpc: KapilotoResearchRpc = {
    async call() {
      return response("served_cache", {
        run_id: "run-1",
        current_run_id: "run-1",
        runs_consumed: 1,
      });
    },
  };
  const preparer: KapilotoResearchPreparer = {
    async prepare() {
      prepareCalls += 1;
      throw new Error("should not prepare");
    },
  };

  const result = await ensureKapilotoResearch(
    rpc,
    preparer,
    request,
    config,
  );

  assert.equal(result.outcome, "served_cache");
  assert.equal(prepareCalls, 0);
});

test("prepare_required performs one preparation and retries the same request", async () => {
  const calls: KapilotoRpcCall[] = [];
  const rpc: KapilotoResearchRpc = {
    async call(input) {
      calls.push(input);
      if (calls.length === 1) {
        return response("prepare_required", {
          next_budget_slot: 1,
        });
      }
      return response("created_run", {
        run_id: "run-1",
        active_run_id: "run-1",
        runs_consumed: 1,
        budget_slot: 1,
        task_count: 16,
      });
    },
  };

  let prepareCalls = 0;
  const preparer: KapilotoResearchPreparer = {
    async prepare() {
      prepareCalls += 1;
      return {
        researchCutoffAt: "2026-10-18T12:00:00Z",
        fixtureSet: Array.from({ length: 16 }, (_, index) => ({
          game_number: index + 1,
        })),
        fixtureSetSha256: "b".repeat(64),
        inputSnapshot: { provider: "api-football" },
        taskGameIds: Array.from(
          { length: 16 },
          (_, index) => `game-${index + 1}`,
        ),
      };
    },
  };

  const result = await ensureKapilotoResearch(
    rpc,
    preparer,
    request,
    config,
  );

  assert.equal(result.outcome, "created_run");
  assert.equal(prepareCalls, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].prepared, null);
  assert.ok(calls[1].prepared);
  assert.equal(calls[0].requestSha256, calls[1].requestSha256);
});

test("a concurrent run created during preparation wins on the second RPC call", async () => {
  let callNo = 0;
  const rpc: KapilotoResearchRpc = {
    async call() {
      callNo += 1;
      if (callNo === 1) {
        return response("prepare_required");
      }
      return response("joined_run", {
        run_id: "run-other",
        active_run_id: "run-other",
        runs_consumed: 1,
      });
    },
  };

  const preparer: KapilotoResearchPreparer = {
    async prepare() {
      return {
        researchCutoffAt: "2026-10-18T12:00:00Z",
        fixtureSet: Array.from({ length: 16 }, (_, index) => ({
          game_number: index + 1,
        })),
        fixtureSetSha256: "c".repeat(64),
        inputSnapshot: {},
        taskGameIds: ["game-1"],
      };
    },
  };

  const result = await ensureKapilotoResearch(
    rpc,
    preparer,
    request,
    config,
  );

  assert.equal(result.outcome, "joined_run");
  assert.equal(result.run_id, "run-other");
});
