import assert from "node:assert/strict";
import test from "node:test";

import { deriveKapilotoApiState } from "./response-state";

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
