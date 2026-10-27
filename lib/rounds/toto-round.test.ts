import assert from "node:assert/strict";
import test from "node:test";

import {
  serializeTotoRoundSnapshot,
  validateTotoRoundSnapshot,
  type TotoRoundSnapshotInput,
} from "./toto-round";

function snapshot(): TotoRoundSnapshotInput {
  return {
    source: "manual-test",
    externalRoundNumber: "264101",
    sourceVersion: "2026-10-20T00:00:00Z",
    startsAt: "2026-10-17T13:30:00Z",
    lockAt: "2026-10-17T13:00:00Z",
    status: "finished",
    games: Array.from({ length: 16 }, (_, index) => ({
      gameNumber: index + 1,
      home: {
        canonicalName: `Home ${index + 1}`,
        countryCode: "il",
        aliases: [`Home Alias ${index + 1}`, `Home Alias ${index + 1}`],
      },
      away: {
        canonicalName: `Away ${index + 1}`,
        countryCode: "il",
      },
      competition: {
        canonicalName: "League",
        countryCode: "il",
        competitionType: "league",
      },
      kickoffAt: `2026-10-${String(17 + Math.floor(index / 8)).padStart(2, "0")}T15:00:00Z`,
    })),
  };
}

test("validates a complete explicit Winner 16 snapshot", () => {
  assert.doesNotThrow(() => validateTotoRoundSnapshot(snapshot()));
});

test("requires exactly game numbers 1 through 16", () => {
  const input = snapshot();
  input.games[15].gameNumber = 15;

  assert.throws(
    () => validateTotoRoundSnapshot(input),
    /game numbers must be exactly 1\.\.16/,
  );
});

test("requires explicit valid lock and start timestamps", () => {
  const input = snapshot();
  input.lockAt = "not-a-time";

  assert.throws(
    () => validateTotoRoundSnapshot(input),
    /lockAt must be an ISO-8601 timestamp/,
  );
});

test("serializes snake_case RPC payload and deduplicates aliases", () => {
  const serialized = serializeTotoRoundSnapshot(snapshot());
  assert.ok(serialized && typeof serialized === "object" && !Array.isArray(serialized));

  const row = serialized as Record<string, unknown>;
  assert.equal(row.external_round_number, "264101");
  assert.equal(row.lock_at, "2026-10-17T13:00:00.000Z");

  const games = row.games as Array<Record<string, unknown>>;
  const home = games[0].home as Record<string, unknown>;

  assert.deepEqual(home.aliases, ["Home Alias 1"]);
  assert.equal(home.country_code, "IL");
  assert.equal(games[0].settlement_rule, "result_after_90_minutes_including_stoppage_time");
});
