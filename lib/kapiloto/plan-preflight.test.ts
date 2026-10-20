import assert from "node:assert/strict";
import test from "node:test";

import { summarizeKapilotoPreparedRun } from "./plan-preflight";
import type { PreparedKapilotoRun } from "./research-request-service";

function prepared(): PreparedKapilotoRun {
  const fixtureSet = Array.from({ length: 16 }, (_, index) => {
    const gameNumber = index + 1;

    if (gameNumber === 15) {
      return {
        gameNumber,
        fixtureId: "fixture-15",
        roundGameId: "game-15",
        mode: "carried_forward",
      };
    }

    if (gameNumber === 16) {
      return {
        gameNumber,
        fixtureId: "fixture-16",
        roundGameId: "game-16",
        mode: "research_unavailable",
      };
    }

    return {
      gameNumber,
      fixtureId: `fixture-${gameNumber}`,
      roundGameId: `game-${gameNumber}`,
      mode: "research",
      card: {
        structured: {
          prior: {
            type: gameNumber === 1 ? "market" : "league_base",
          },
        },
      },
    };
  });

  return {
    researchCutoffAt: "2026-10-20T12:00:00.000Z",
    fixtureSet,
    fixtureSetSha256: "abc",
    inputSnapshot: {},
    taskGameIds: fixtureSet
      .filter((item) => item.mode === "research")
      .map((item) => String(item.roundGameId)),
  };
}

test("summarizes mixed prepared run without mutating it", () => {
  const input = prepared();
  const summary = summarizeKapilotoPreparedRun(input);

  assert.equal(summary.fixtureCount, 16);
  assert.equal(summary.taskCount, 14);
  assert.equal(summary.researchCount, 14);
  assert.equal(summary.carriedForwardCount, 1);
  assert.equal(summary.researchUnavailableCount, 1);
  assert.equal(summary.marketPriorCount, 1);
  assert.equal(summary.leagueBasePriorCount, 13);
  assert.equal(summary.ratingPriorCount, 0);
});
