import assert from "node:assert/strict";
import test from "node:test";

import { buildKapilotoDemandWorkerOptions } from "./worker-demand";

test("demand worker can only start one non-finalizing short-lease task", () => {
  const options = buildKapilotoDemandWorkerOptions("request:run-1");

  assert.match(options.workerId, /^demand:request:run-1:/);
  assert.equal(options.maxTasks, 1);
  assert.equal(options.leaseSeconds, 180);
  assert.equal(options.heartbeatIntervalMs, 30_000);
  assert.equal(options.finalizeRuns, false);
});

test("demand worker inherits the request invocation deadline", () => {
  const withDeadline = buildKapilotoDemandWorkerOptions("request:run-1", 123_456);
  assert.equal(withDeadline.deadlineAtMs, 123_456);

  const withoutDeadline = buildKapilotoDemandWorkerOptions("request:run-1");
  assert.equal("deadlineAtMs" in withoutDeadline, false);
});
