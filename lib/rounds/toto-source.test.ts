import assert from "node:assert/strict";
import test from "node:test";

import {
  discoveryToImportSnapshot,
  type TotoRoundDiscovery,
} from "./toto-source";

function discovery(): TotoRoundDiscovery {
  return {
    source: "test-source",
    sourceUrl: "https://example.test",
    externalRoundNumber: "264201",
    sourceVersion: "sha256:test",
    fetchedAt: "2026-10-20T08:00:00.000Z",
    completeKickoffs: true,
    games: Array.from({ length: 16 }, (_, index) => ({
      gameNumber: index + 1,
      rawKickoff: "24/10 19:00",
      kickoffAt: new Date(
        Date.UTC(2026, 9, 24, 16, index),
      ).toISOString(),
      homeTeam: `בית ${index + 1}`,
      awayTeam: `חוץ ${index + 1}`,
      competition: {
        canonicalName: "Ligat Ha'al",
        countryCode: "IL",
        competitionType: "league",
        sourceLabel: "ישראל - ליגת Winner",
      },
    })),
  };
}

test("requires every discovered kickoff before creating an import snapshot", () => {
  const input = discovery();
  input.games[14].kickoffAt = null;
  input.completeKickoffs = false;

  assert.throws(
    () =>
      discoveryToImportSnapshot(input, {
        lockAt: "2026-10-24T15:00:00Z",
      }),
    /unresolved kickoff times for games: 15/,
  );
});

test("uses an explicit lock time and earliest fixture as round start", () => {
  const snapshot = discoveryToImportSnapshot(discovery(), {
    lockAt: "2026-10-24T15:00:00Z",
  });

  assert.equal(snapshot.lockAt, "2026-10-24T15:00:00Z");
  assert.equal(snapshot.startsAt, "2026-10-24T16:00:00.000Z");
  assert.equal(snapshot.games.length, 16);
  assert.equal(snapshot.games[0].competition.canonicalName, "Ligat Ha'al");
});
