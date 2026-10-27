import assert from "node:assert/strict";
import test from "node:test";

import { assessRunFinalizationReadiness } from "./run-readiness";

function fixtureSet(modes: Array<"research" | "carried_forward" | "research_unavailable">) {
  return modes.map((mode, index) => ({
    gameNumber: index + 1,
    fixtureId: `fixture-${index + 1}`,
    roundGameId: `game-${index + 1}`,
    mode,
  }));
}

test("all-research run becomes ready when all 16 research tasks succeeded", () => {
  const result = assessRunFinalizationReadiness(
    fixtureSet(Array.from({ length: 16 }, () => "research")),
    Array.from({ length: 16 }, () => "succeeded"),
  );

  assert.deepEqual(result, { ready: true, reason: "ready" });
});

test("mixed run requires only the research dispositions to succeed", () => {
  const modes = [
    ...Array.from({ length: 13 }, () => "research" as const),
    "carried_forward" as const,
    "research_unavailable" as const,
    "research" as const,
  ];

  const result = assessRunFinalizationReadiness(
    fixtureSet(modes),
    Array.from({ length: 14 }, () => "succeeded"),
  );

  assert.deepEqual(result, { ready: true, reason: "ready" });
});

test("active retry blocks finalization", () => {
  const modes = [
    ...Array.from({ length: 15 }, () => "research" as const),
    "research_unavailable" as const,
  ];

  const result = assessRunFinalizationReadiness(
    fixtureSet(modes),
    [...Array.from({ length: 14 }, () => "succeeded"), "running"],
  );

  assert.deepEqual(result, {
    ready: false,
    reason: "active_attempts:1",
  });
});

test("terminal incomplete run remains deferred", () => {
  const modes = [
    ...Array.from({ length: 15 }, () => "research" as const),
    "carried_forward" as const,
  ];

  const result = assessRunFinalizationReadiness(
    fixtureSet(modes),
    Array.from({ length: 14 }, () => "succeeded"),
  );

  assert.deepEqual(result, {
    ready: false,
    reason: "succeeded_attempts:14/15",
  });
});
