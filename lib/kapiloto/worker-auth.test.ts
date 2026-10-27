import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { verifyKapilotoWorkerAuthorization } from "./worker-auth";

test("accepts a bearer secret whose SHA-256 matches the configured digest", () => {
  const secret = "kapiloto-worker-test-secret";
  const digest = createHash("sha256").update(secret).digest("hex");

  assert.equal(
    verifyKapilotoWorkerAuthorization(`Bearer ${secret}`, digest),
    true,
  );
});

test("rejects malformed or incorrect worker authorization", () => {
  const digest = createHash("sha256").update("correct-secret").digest("hex");

  assert.equal(verifyKapilotoWorkerAuthorization(null, digest), false);
  assert.equal(verifyKapilotoWorkerAuthorization("Basic nope", digest), false);
  assert.equal(
    verifyKapilotoWorkerAuthorization("Bearer wrong-secret", digest),
    false,
  );
  assert.equal(
    verifyKapilotoWorkerAuthorization("Bearer correct-secret", "bad-digest"),
    false,
  );
});
