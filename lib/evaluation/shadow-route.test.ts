import assert from "node:assert/strict";
import test from "node:test";

import { shadowCadenceProfile, shadowCycleConfigFromEnv } from "./env";
import {
  DEFAULT_CADENCE_CONFIG,
  FREE_PLAN_CADENCE_CONFIG,
  simulateCaptureSchedule,
} from "./market-cadence";
import { handleShadowEvaluationRequest, type ShadowCycleOutcome } from "./shadow-route";

const ENABLED = { KAPILOTO_SHADOW_EVALUATION_ENABLED: "true" };

function harness(options: { authorized?: boolean; env?: Record<string, string>; body?: string; outcome?: () => Promise<ShadowCycleOutcome> } = {}) {
  const deferred: Array<() => Promise<void>> = [];
  const logs: Array<{ level: "info" | "error"; message: string; detail: Record<string, unknown> }> = [];
  let cycles = 0;
  const run = () =>
    handleShadowEvaluationRequest({
      request: new Request("https://example.test/api/internal/cron/shadow-evaluation", {
        method: "POST",
        body: options.body ?? "{}",
      }),
      authorized: options.authorized ?? true,
      env: options.env ?? ENABLED,
      runCycle: async () => {
        cycles += 1;
        return options.outcome ? options.outcome() : { failed: false, summary: { roundId: "round-1" } };
      },
      defer: (task) => deferred.push(task),
      log: {
        info: (message, detail) => logs.push({ level: "info", message, detail }),
        error: (message, detail) => logs.push({ level: "error", message, detail }),
      },
      now: () => new Date("2026-10-24T12:07:00Z"),
    });
  return { run, deferred, logs, cycles: () => cycles };
}

test("an unauthorized request is rejected and runs nothing", async () => {
  const h = harness({ authorized: false });
  const response = await h.run();
  assert.equal(response.status, 401);
  assert.equal(h.deferred.length, 0);
  assert.equal(h.cycles(), 0);
});

test("with shadow evaluation disabled the route answers immediately and runs nothing", async () => {
  const h = harness({ env: {} });
  const response = await h.run();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, enabled: false, workStarted: false });
  assert.equal(h.deferred.length, 0);
});

test("a scheduled call is acknowledged with 202 before the cycle runs", async () => {
  const h = harness({ body: "" });
  const response = await h.run();
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.match(body.runId, /^shadow:/);
  assert.equal(h.cycles(), 0, "no work happens inside the request");
  assert.equal(h.deferred.length, 1);

  await h.deferred[0]();
  assert.equal(h.cycles(), 1);
  assert.equal(h.logs[0].level, "info");
  assert.equal(h.logs[0].detail.runId, body.runId);
});

test("a failed or throwing deferred cycle is logged as an error and never escapes", async () => {
  const failed = harness({ outcome: async () => ({ failed: true, summary: { errors: ["market"] } }) });
  await failed.run();
  await failed.deferred[0]();
  assert.equal(failed.logs[0].level, "error");

  const throwing = harness({ outcome: async () => { throw new Error("current_round_missing"); } });
  await throwing.run();
  await assert.doesNotReject(throwing.deferred[0]());
  assert.equal(throwing.logs[0].level, "error");
  assert.equal(throwing.logs[0].detail.error, "current_round_missing");
});

test("preflight reports configuration without starting work", async () => {
  const h = harness({
    body: JSON.stringify({ preflight: true }),
    env: {
      ...ENABLED,
      KAPILOTO_SHADOW_MARKET_CAPTURE_ENABLED: "true",
      KAPILOTO_SHADOW_MARKET_PROVIDER_RESERVE: "40",
      KAPILOTO_SHADOW_MARKET_MAX_REQUESTS_PER_DAY: "60",
    },
  });
  const response = await h.run();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preflight, true);
  assert.equal(body.marketCapture, true);
  assert.equal(body.marketProviderConfigured, false);
  assert.equal(body.cadence, "free_plan");
  assert.equal(body.budget.providerReserve, 40);
  assert.equal(body.budget.maxRequestsPerDay, 60);
  assert.equal(body.workStarted, false);
  assert.equal(h.deferred.length, 0);

  const invalid = await harness({ body: JSON.stringify({ preflight: "yes" }) }).run();
  assert.equal(invalid.status, 400);
});

test("the cadence defaults to the Free-plan profile unless adaptive is chosen explicitly", () => {
  assert.equal(shadowCadenceProfile({}), "free_plan");
  assert.equal(shadowCadenceProfile({ KAPILOTO_SHADOW_MARKET_CADENCE: "adaptiv" }), "free_plan");
  assert.equal(shadowCadenceProfile({ KAPILOTO_SHADOW_MARKET_CADENCE: "Adaptive" }), "adaptive");
  assert.deepEqual(shadowCycleConfigFromEnv({}).cadence, FREE_PLAN_CADENCE_CONFIG);
  assert.deepEqual(shadowCycleConfigFromEnv({ KAPILOTO_SHADOW_MARKET_CADENCE: "adaptive" }).cadence, DEFAULT_CADENCE_CONFIG);
});

test("the Free-plan cadence captures each fixture at T-24h, T-6h and once in the final window", () => {
  const kickoffs = ["2026-10-24T13:00:00Z", "2026-10-25T16:30:00Z", "2026-10-26T17:00:00Z", "2026-10-26T23:30:00Z"];
  const fixtures = kickoffs.map((kickoffAt, index) => ({ fixtureId: `f${index}`, kickoffAt }));
  const schedule = simulateCaptureSchedule(fixtures, {
    fromAt: "2026-10-20T00:00:00Z",
    cronMinute: 7,
    config: FREE_PLAN_CADENCE_CONFIG,
  });
  assert.deepEqual(schedule.byWindow, { far: 0, mid: 4, near: 4, final: 4 });
  for (const fixture of fixtures) {
    assert.equal(schedule.perFixture[fixture.fixtureId], 3, fixture.kickoffAt);
    const minutes = schedule.lastCaptureMinutesBeforeDeadline[fixture.fixtureId];
    assert.ok(minutes > 0 && minutes <= 75, `final capture ${minutes} min before deadline`);
  }
});
