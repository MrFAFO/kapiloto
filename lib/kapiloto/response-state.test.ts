import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveKapilotoApiState,
  deriveKapilotoReadState,
} from "./response-state";

test("read state: active run is researching even with a previous analysis", () => {
  for (const hasAnalysis of [false, true]) {
    assert.equal(
      deriveKapilotoReadState({
        hasAnalysis,
        freshness: hasAnalysis ? "stale" : null,
        activeRunId: "run",
        runsRemaining: 2,
      }),
      "researching",
    );
  }
});

test("read state: analysis maps to ready/stale; none maps to unresearched or limit", () => {
  const base = { activeRunId: null, runsRemaining: 2 };
  assert.equal(
    deriveKapilotoReadState({ ...base, hasAnalysis: true, freshness: "fresh" }),
    "ready",
  );
  assert.equal(
    deriveKapilotoReadState({ ...base, hasAnalysis: true, freshness: "locked" }),
    "ready",
  );
  assert.equal(
    deriveKapilotoReadState({ ...base, hasAnalysis: true, freshness: "stale" }),
    "stale",
  );
  assert.equal(
    deriveKapilotoReadState({ ...base, hasAnalysis: false, freshness: null }),
    "unresearched",
  );
  assert.equal(
    deriveKapilotoReadState({
      hasAnalysis: false,
      freshness: null,
      activeRunId: null,
      runsRemaining: 0,
    }),
    "limit_reached",
  );
});

test("created/joined runs return 202 researching", () => {
  assert.deepEqual(
    deriveKapilotoApiState({
      outcome: "created_run",
      hasAnalysis: false,
      freshness: null,
    }),
    { state: "researching", httpStatus: 202 },
  );

  assert.deepEqual(
    deriveKapilotoApiState({
      outcome: "joined_run",
      hasAnalysis: true,
      freshness: "stale",
    }),
    { state: "researching", httpStatus: 202 },
  );
});

test("stale cached analysis returns stale", () => {
  assert.deepEqual(
    deriveKapilotoApiState({
      outcome: "served_cache",
      hasAnalysis: true,
      freshness: "stale",
    }),
    { state: "stale", httpStatus: 200 },
  );
});

test("limit reached is explicit only when no fresh usable analysis exists", () => {
  assert.deepEqual(
    deriveKapilotoApiState({
      outcome: "limit_reached",
      hasAnalysis: true,
      freshness: "stale",
    }),
    { state: "limit_reached", httpStatus: 200 },
  );

  assert.deepEqual(
    deriveKapilotoApiState({
      outcome: "limit_reached",
      hasAnalysis: true,
      freshness: "fresh",
    }),
    { state: "ready", httpStatus: 200 },
  );
});

test("breaker without cache is an error but with cache degrades gracefully", () => {
  assert.deepEqual(
    deriveKapilotoApiState({
      outcome: "breaker_open",
      hasAnalysis: false,
      freshness: null,
    }),
    { state: "error", httpStatus: 200 },
  );

  assert.deepEqual(
    deriveKapilotoApiState({
      outcome: "breaker_open",
      hasAnalysis: true,
      freshness: "fresh",
    }),
    { state: "ready", httpStatus: 200 },
  );
});
