import assert from "node:assert/strict";
import test from "node:test";

import {
  decideKapilotoResearchRequest,
  type KapilotoResearchPolicyState,
} from "./research-policy";

function state(
  overrides: Partial<KapilotoResearchPolicyState> = {},
): KapilotoResearchPolicyState {
  return {
    runsConsumed: 0,
    activeRunId: null,
    currentRunId: null,
    currentFreshness: null,
    refreshEligible: false,
    roundClosed: false,
    breakerOpen: false,
    ...overrides,
  };
}

test("first consult creates budget slot 1", () => {
  assert.deepEqual(
    decideKapilotoResearchRequest(state(), {
      intent: "consult",
      basedOnRunId: null,
    }),
    {
      action: "create_run",
      outcome: "created_run",
      budgetSlot: 1,
      basedOnRunId: null,
    },
  );
});

test("plain consult never refreshes an existing stale snapshot", () => {
  assert.deepEqual(
    decideKapilotoResearchRequest(
      state({
        runsConsumed: 1,
        currentRunId: "run-1",
        currentFreshness: "stale",
        refreshEligible: true,
      }),
      { intent: "consult", basedOnRunId: null },
    ),
    {
      action: "serve_current",
      outcome: "served_cache",
      runId: "run-1",
    },
  );
});

test("eligible recheck creates the next shared run", () => {
  assert.deepEqual(
    decideKapilotoResearchRequest(
      state({
        runsConsumed: 1,
        currentRunId: "run-1",
        currentFreshness: "stale",
        refreshEligible: true,
      }),
      { intent: "recheck", basedOnRunId: "run-1" },
    ),
    {
      action: "create_run",
      outcome: "created_run",
      budgetSlot: 2,
      basedOnRunId: "run-1",
    },
  );
});

test("concurrent demand joins the active run", () => {
  assert.deepEqual(
    decideKapilotoResearchRequest(
      state({
        runsConsumed: 1,
        activeRunId: "run-2",
        currentRunId: "run-1",
      }),
      { intent: "recheck", basedOnRunId: "run-1" },
    ),
    {
      action: "join_active",
      outcome: "joined_run",
      runId: "run-2",
    },
  );
});

test("request based on an older run serves the newer published snapshot", () => {
  assert.deepEqual(
    decideKapilotoResearchRequest(
      state({
        runsConsumed: 2,
        currentRunId: "run-2",
        refreshEligible: true,
      }),
      { intent: "recheck", basedOnRunId: "run-1" },
    ),
    {
      action: "serve_current",
      outcome: "served_newer",
      runId: "run-2",
    },
  );
});

test("the policy cannot create a fourth logical run", () => {
  assert.deepEqual(
    decideKapilotoResearchRequest(
      state({
        runsConsumed: 3,
        currentRunId: "run-3",
        currentFreshness: "stale",
        refreshEligible: true,
      }),
      { intent: "recheck", basedOnRunId: "run-3" },
    ),
    {
      action: "serve_current",
      outcome: "limit_reached",
      runId: "run-3",
    },
  );
});

test("Diego uses an existing completed snapshot instead of silently refreshing", () => {
  assert.deepEqual(
    decideKapilotoResearchRequest(
      state({
        runsConsumed: 1,
        currentRunId: "run-1",
        currentFreshness: "stale",
        refreshEligible: true,
      }),
      { intent: "diego", basedOnRunId: null },
    ),
    {
      action: "serve_current",
      outcome: "served_cache",
      runId: "run-1",
    },
  );
});

test("round close and circuit breaker never create a new run", () => {
  assert.equal(
    decideKapilotoResearchRequest(
      state({ roundClosed: true }),
      { intent: "consult", basedOnRunId: null },
    ).action,
    "serve_current",
  );

  assert.equal(
    decideKapilotoResearchRequest(
      state({ breakerOpen: true }),
      { intent: "consult", basedOnRunId: null },
    ).action,
    "serve_current",
  );
});
