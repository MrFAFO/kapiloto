import assert from "node:assert/strict";
import test from "node:test";

import { createKapilotoClient, type KapilotoFixtureRef } from "./client";
import {
  createKapilotoDemoFetch,
  type KapilotoDemoScenario,
} from "./demo-fetch";
import { KapilotoPanelController } from "./panel-controller";
import { deriveKapilotoPanelView } from "./panel-view";

const ROUND = "33333333-3333-4333-8333-333333333333";
const GROUP = "22222222-2222-4222-8222-222222222222";
const GAME_IDS = Array.from(
  { length: 16 },
  (_, i) => `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`,
);

type Call = { method: string; url: string; key: string | null };

const instantSleep = async (_ms: number, signal?: AbortSignal) => {
  await new Promise((resolve) => setImmediate(resolve));
  if (signal?.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }
};

function setup(
  scenario: KapilotoDemoScenario,
  options: { gameIndex?: number; fetchOverride?: typeof fetch } = {},
) {
  const calls: Call[] = [];
  const demo = createKapilotoDemoFetch({
    scenario,
    roundId: ROUND,
    roundGameIds: GAME_IDS,
    latencyMs: 0,
    pollsPerRun: 2,
  });
  const inner = options.fetchOverride ?? demo;
  const recordingFetch: typeof fetch = (input, init) => {
    calls.push({
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      key: new Headers(init?.headers).get("idempotency-key"),
    });
    return inner(input, init);
  };
  const client = createKapilotoClient({
    fetch: recordingFetch,
    sleep: instantSleep,
  });
  const ref: KapilotoFixtureRef = {
    roundId: ROUND,
    groupId: GROUP,
    roundGameId: GAME_IDS[options.gameIndex ?? 0],
  };
  const published: string[] = [];
  const controller = new KapilotoPanelController(client, ref, {
    pollOptions: { sleep: instantSleep },
    onRoundRunPublished: (runId) => published.push(runId),
  });
  const view = () => deriveKapilotoPanelView(controller.getState());
  return { controller, calls, view, published, demo };
}

async function settle(controller: KapilotoPanelController) {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (controller.getState().activity === "idle") return;
  }
  throw new Error("controller did not settle");
}

const posts = (calls: Call[]) => calls.filter((call) => call.method === "POST");

test("opening the panel is read-only and shows never-researched", async () => {
  const { controller, calls, view } = setup("unresearched");

  controller.open();
  assert.equal(view().kind, "loading");
  await settle(controller);

  assert.equal(view().kind, "unresearched");
  assert.equal(view().canConsult, true);
  assert.deepEqual(posts(calls), []);
});

test("Consult sends exactly one POST, polls with GET only and converges to fresh", async () => {
  const { controller, calls, view, published } = setup("unresearched");
  controller.open();
  await settle(controller);

  const consulting = controller.consult();
  void controller.consult();
  void controller.recheck();
  assert.equal(view().kind, "first_loading");
  await consulting;
  assert.equal(view().kind, "first_loading");
  await settle(controller);

  assert.equal(view().kind, "fresh");
  assert.equal(posts(calls).length, 1);
  assert.ok(posts(calls)[0].key);

  const afterPost = calls.slice(calls.indexOf(posts(calls)[0]) + 1);
  assert.ok(afterPost.length >= 2);
  assert.ok(afterPost.every((call) => call.method === "GET" && call.key == null));
  assert.equal(published.length, 1);
});

test("joining another user's active run shows shared researching and never POSTs", async () => {
  const { controller, calls, view } = setup("shared");
  controller.open();
  for (let i = 0; i < 5 && view().kind !== "shared_researching"; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(view().kind, "shared_researching");
  await settle(controller);

  assert.equal(view().kind, "fresh");
  assert.deepEqual(posts(calls), []);
});

test("Recheck keeps the previous analysis visible and flags a changed recommendation", async () => {
  const { controller, calls, view } = setup("stale", { gameIndex: 0 });
  controller.open();
  await settle(controller);
  assert.equal(view().kind, "stale");
  const previous = view().analysis;
  assert.ok(previous);

  const rechecking = controller.recheck();
  assert.equal(view().kind, "rechecking");
  assert.equal(view().analysis?.analysisId, previous.analysisId);
  await rechecking;

  const seenDuringPoll: string[] = [];
  for (let i = 0; i < 200 && controller.getState().activity !== "idle"; i += 1) {
    const current = view();
    if (current.kind === "rechecking") {
      assert.equal(current.analysis?.analysisId, previous.analysisId);
      seenDuringPoll.push(current.kind);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(seenDuringPoll.length > 0);

  const done = view();
  assert.equal(done.kind, "changed");
  assert.notEqual(done.analysis?.runId, previous.runId);
  assert.equal(done.previousAnalysis?.analysisId, previous.analysisId);
  assert.equal(posts(calls).length, 1);
  assert.match(JSON.stringify(posts(calls)), /requests/);
});

test("budget exhaustion renders separately from 429 request throttling", async () => {
  const exhausted = setup("exhausted");
  exhausted.controller.open();
  await settle(exhausted.controller);
  assert.equal(exhausted.view().kind, "budget_exhausted");
  assert.equal(exhausted.view().canRecheck, false);
  assert.ok(exhausted.view().analysis, "newest analysis stays visible");

  const throttled = setup("rate_limited");
  throttled.controller.open();
  await settle(throttled.controller);
  await throttled.controller.consult();
  assert.equal(throttled.view().kind, "rate_limited");
  assert.deepEqual(throttled.view().notice, {
    kind: "rate_limited",
    retryAfterSeconds: 20,
  });
});

test("a run that ends without publishing shows a retriable research error", async () => {
  const { controller, view } = setup("error");
  controller.open();
  await settle(controller);
  await controller.consult();
  await settle(controller);

  assert.equal(view().kind, "error");
  assert.deepEqual(view().notice, { kind: "error", reason: "research_failed" });
});

test("manual retry after a transport failure replays the same idempotency key", async () => {
  let failing = true;
  const demo = createKapilotoDemoFetch({
    scenario: "unresearched",
    roundId: ROUND,
    roundGameIds: GAME_IDS,
    latencyMs: 0,
  });
  const flaky: typeof fetch = (input, init) => {
    if (failing && (init?.method ?? "GET") === "POST") {
      return Promise.reject(new TypeError("offline"));
    }
    return demo(input, init);
  };
  const { controller, calls, view } = setup("unresearched", {
    fetchOverride: flaky,
  });
  controller.open();
  await settle(controller);

  await controller.consult();
  assert.equal(view().kind, "error");
  assert.deepEqual(view().notice, { kind: "error", reason: "network" });
  const failedKeys = new Set(posts(calls).map((call) => call.key));
  assert.equal(failedKeys.size, 1);

  failing = false;
  controller.retry();
  await settle(controller);

  const keys = new Set(posts(calls).map((call) => call.key));
  assert.equal(keys.size, 1, "retry must reuse the original key");
  assert.equal(view().kind, "fresh");
});

test("collapse keeps the cached result and reopening does not refetch", async () => {
  const { controller, calls, view } = setup("fresh");
  controller.open();
  await settle(controller);
  assert.equal(view().kind, "fresh");
  const before = calls.length;

  controller.collapse();
  assert.equal(view().kind, "collapsed");
  controller.open();
  assert.equal(view().kind, "fresh");
  assert.equal(calls.length, before);
});

test("a run published elsewhere refreshes other open panels via GET", async () => {
  const { controller, calls, view } = setup("fresh");
  controller.open();
  await settle(controller);
  const before = calls.length;

  controller.syncRoundRun("55555555-5555-4555-8555-000000000009");
  await settle(controller);

  assert.ok(calls.length > before);
  assert.ok(calls.slice(before).every((call) => call.method === "GET"));
  assert.equal(view().kind, "fresh");
});
