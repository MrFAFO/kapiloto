import assert from "node:assert/strict";
import test from "node:test";

import {
  cadenceWindow,
  isDue,
  planCaptures,
  simulateCaptureSchedule,
} from "./market-cadence";

const KICKOFF = "2026-10-31T15:00:00.000Z";
const kickoffMs = Date.parse(KICKOFF);
const hoursBefore = (hours: number) => kickoffMs - hours * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

test("cadence windows follow the distance to kickoff", () => {
  assert.equal(cadenceWindow(hoursBefore(200), KICKOFF), null);
  assert.equal(cadenceWindow(hoursBefore(100), KICKOFF), "far");
  assert.equal(cadenceWindow(hoursBefore(48), KICKOFF), "mid");
  assert.equal(cadenceWindow(hoursBefore(7), KICKOFF), "mid");
  assert.equal(cadenceWindow(hoursBefore(6), KICKOFF), "near");
  assert.equal(cadenceWindow(hoursBefore(1.6), KICKOFF), "near");
  // deadline is kickoff - 15 min; final window is the 75 minutes before it
  assert.equal(cadenceWindow(hoursBefore(1.5), KICKOFF), "final");
  assert.equal(cadenceWindow(kickoffMs - 16 * 60_000, KICKOFF), "final");
  assert.equal(cadenceWindow(kickoffMs - 15 * 60_000, KICKOFF), null);
  assert.equal(cadenceWindow(kickoffMs + 60_000, KICKOFF), null);
});

test("captures are due on the window interval, with slack for an hourly scheduler", () => {
  const at = (ms: number, status = "saved") => ({ at: iso(ms), status });
  assert.equal(isDue(hoursBefore(30), KICKOFF, null).reason, "never_attempted");
  assert.equal(isDue(hoursBefore(30), KICKOFF, at(hoursBefore(32))).due, false);
  assert.equal(isDue(hoursBefore(30), KICKOFF, at(hoursBefore(32.84))).due, true);
  assert.equal(isDue(hoursBefore(4), KICKOFF, at(hoursBefore(4.5))).due, false);
  assert.equal(isDue(hoursBefore(4), KICKOFF, at(hoursBefore(4.84))).due, true);
  assert.equal(isDue(hoursBefore(80), KICKOFF, at(hoursBefore(90))).due, false);
  assert.equal(isDue(hoursBefore(80), KICKOFF, at(hoursBefore(104))).due, true);
  assert.equal(isDue(hoursBefore(80), KICKOFF, at(hoursBefore(81), "skipped_budget")).reason, "never_attempted");
  assert.equal(isDue(hoursBefore(30), KICKOFF, at(hoursBefore(31), "error")).reason, "retry_after_error");
});

test("one final snapshot is forced inside the last 75 minutes before the deadline", () => {
  const deadline = kickoffMs - 15 * 60_000;
  const lastNear = { at: iso(deadline - 80 * 60_000), status: "saved" };
  const decision = isDue(deadline - 70 * 60_000, KICKOFF, lastNear);
  assert.deepEqual([decision.due, decision.reason], [true, "final_snapshot"]);
  const afterFinal = { at: iso(deadline - 70 * 60_000), status: "saved" };
  assert.equal(isDue(deadline - 30 * 60_000, KICKOFF, afterFinal).due, false);
});

test("budget planning admits the most urgent fixtures first", () => {
  const candidates = [
    { fixtureId: "far", kickoffAt: iso(hoursBefore(-100)), window: "far" as const },
    { fixtureId: "near-late", kickoffAt: iso(hoursBefore(-5)), window: "near" as const },
    { fixtureId: "final", kickoffAt: iso(hoursBefore(-1)), window: "final" as const },
    { fixtureId: "near-early", kickoffAt: iso(hoursBefore(-3)), window: "near" as const },
  ];
  const plan = planCaptures(candidates, { availableRequests: 5, requestsPerCapture: 2 });
  assert.deepEqual(plan.admitted.map((item) => item.fixtureId), ["final", "near-early"]);
  assert.deepEqual(plan.skipped.map((item) => item.fixtureId), ["near-late", "far"]);
  assert.equal(planCaptures(candidates, { availableRequests: -3, requestsPerCapture: 2 }).admitted.length, 0);
});

test("hourly simulation over the last week: 5 daily, 14 three-hourly, 5 hourly and 1 final capture", () => {
  // Cron at :07, kickoff at 15:00 -> runs at 167.88h, 143.88h, ... before kickoff.
  const simulation = simulateCaptureSchedule([{ fixtureId: "f", kickoffAt: KICKOFF }], {
    fromAt: iso(hoursBefore(7 * 24)),
    cronMinute: 7,
  });
  assert.deepEqual(simulation.byWindow, { far: 5, mid: 14, near: 5, final: 1 });
  assert.equal(simulation.captures, 25);
  // last run before the deadline is 52.8 min before kickoff = ~38 min before deadline
  assert.equal(simulation.lastCaptureMinutesBeforeDeadline.f, 38);
  assert.equal(simulation.estimatedRequests, 50);
});

test("request estimate shares one resolution request per kickoff date per run", () => {
  const simulation = simulateCaptureSchedule(
    [
      { fixtureId: "a", kickoffAt: KICKOFF },
      { fixtureId: "b", kickoffAt: KICKOFF },
    ],
    { fromAt: iso(hoursBefore(2)), cronMinute: 7 },
  );
  assert.equal(simulation.captures, 4);
  assert.equal(simulation.estimatedRequests, 6);
  assert.equal(simulation.maxRequestsInOneRun, 3);
});
