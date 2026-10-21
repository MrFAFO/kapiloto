import assert from "node:assert/strict";
import test from "node:test";

import { hashAuthRateLimitKey } from "./rate-limit";

test("auth rate-limit keys are deterministic hashes, not raw identifiers", () => {
  const key = "ofek93";
  const hashed = hashAuthRateLimitKey(key);

  assert.equal(hashed.length, 64);
  assert.notEqual(hashed, key);
  assert.equal(hashed, hashAuthRateLimitKey(key));
  assert.notEqual(hashed, hashAuthRateLimitKey("ofek94"));
});
