import assert from "node:assert/strict";
import test from "node:test";

import type { FixtureCardInput } from "./fixture-card";
import { buildKapilotoResearchRunPlan } from "./research-run-plan";
import { sha256Hex } from "./snapshot";

function fixture(gameNumber: number): FixtureCardInput {
  return {
    roundId: "round-a",
    roundGameId: `game-${gameNumber}`,
    gameNumber,
    home: {
      id: `home-${gameNumber}`,
      canonicalName: `Home ${gameNumber}`,
    },
    away: {
      id: `away-${gameNumber}`,
      canonicalName: `Away ${gameNumber}`,
    },
    competition: {
      id: "league",
      name: "League",
      stage: "regular",
      leg: null,
      aggregateHome: null,
      aggregateAway: null,
    },
    kickoffAt: "2026-10-20T18:00:00Z",
    neutralVenue: false,
    prior: {
      type: "market",
      snapshotId: `prior-${gameNumber}`,
      capturedAt: "2026-10-18T10:00:00Z",
      probabilitiesBp: { home: 4000, draw: 3000, away: 3000 },
    },
  };
}

test("run plan creates one fixture task per eligible fixture", () => {
  const plan = buildKapilotoResearchRunPlan(
    Array.from({ length: 16 }, (_, index) => fixture(index + 1)),
    "2026-10-18T12:00:00Z",
  );

  assert.equal(plan.fixtures.length, 16);
  assert.equal(plan.taskGameIds.length, 16);
  assert.ok(plan.fixtures.every((item) => item.mode === "research"));
  assert.match(plan.fixtureSetSha256, /^[a-f0-9]{64}$/);
});

test("late fixtures carry forward instead of being re-researched", () => {
  const inputs = Array.from({ length: 16 }, (_, index) => fixture(index + 1));
  inputs[0].kickoffAt = "2026-10-18T12:10:00Z";

  const plan = buildKapilotoResearchRunPlan(
    inputs,
    "2026-10-18T12:00:00Z",
    [{ roundGameId: "game-1", analysisId: "analysis-old-1" }],
  );

  assert.deepEqual(plan.fixtures[0], {
    gameNumber: 1,
    roundGameId: "game-1",
    mode: "carried_forward",
    carriedFromAnalysisId: "analysis-old-1",
    reason: "kickoff_too_close",
  });
  assert.equal(plan.taskGameIds.length, 15);
});

test("late fixture without prior analysis is explicit research_unavailable", () => {
  const inputs = Array.from({ length: 16 }, (_, index) => fixture(index + 1));
  inputs[0].kickoffAt = "2026-10-18T11:59:00Z";

  const plan = buildKapilotoResearchRunPlan(
    inputs,
    "2026-10-18T12:00:00Z",
  );

  assert.equal(plan.fixtures[0].mode, "research_unavailable");
  assert.equal(
    plan.fixtures[0].mode === "research_unavailable"
      ? plan.fixtures[0].reason
      : null,
    "already_started",
  );
});

test("snapshot hash is independent of object key insertion order", () => {
  const a = {
    z: 1,
    a: {
      beta: true,
      alpha: ["x", 2],
    },
  };
  const b = {
    a: {
      alpha: ["x", 2],
      beta: true,
    },
    z: 1,
  };

  assert.equal(sha256Hex(a), sha256Hex(b));
});
