import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalSportmonksLiveStatus,
  parseSportmonksLiveResult,
} from "./sportmonks";

test("maps Sportmonks fixture states to canonical live states", () => {
  assert.equal(canonicalSportmonksLiveStatus("NS"), "upcoming");
  assert.equal(canonicalSportmonksLiveStatus("INPLAY_1ST_HALF"), "live");
  assert.equal(canonicalSportmonksLiveStatus("INPLAY_2ND_HALF"), "live");
  assert.equal(canonicalSportmonksLiveStatus("HT"), "halftime");
  assert.equal(canonicalSportmonksLiveStatus("FT"), "finished");
  assert.equal(canonicalSportmonksLiveStatus("INPLAY_ET"), "finished");
  assert.equal(canonicalSportmonksLiveStatus("FT_PEN"), "finished");
  assert.equal(canonicalSportmonksLiveStatus("POSTPONED"), "postponed");
  assert.equal(canonicalSportmonksLiveStatus("CANCELLED"), "cancelled");
  assert.equal(canonicalSportmonksLiveStatus("SUSPENDED"), "suspended");
  assert.equal(canonicalSportmonksLiveStatus("AWARDED"), "under_review");
});

test("uses CURRENT while regular time is live", () => {
  const result = parseSportmonksLiveResult(
    {
      id: 11,
      state: { developer_name: "INPLAY_2ND_HALF" },
      scores: [
        { description: "CURRENT", score: { goals: 2, participant: "home" } },
        { description: "CURRENT", score: { goals: 1, participant: "away" } },
      ],
    },
    "2026-10-24T14:00:00.000Z",
  );

  assert.deepEqual(result, {
    providerFixtureId: "11",
    providerState: "INPLAY_2ND_HALF",
    status: "live",
    homeScore: 2,
    awayScore: 1,
    scoreBasis: "current",
    observedAt: "2026-10-24T14:00:00.000Z",
  });
});

test("uses 90-minute score after extra time instead of CURRENT", () => {
  const result = parseSportmonksLiveResult(
    {
      id: 12,
      state: { developer_name: "AET" },
      scores: [
        { description: "2ND_HALF", score: { goals: 1, participant: "home" } },
        { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
        { description: "CURRENT", score: { goals: 2, participant: "home" } },
        { description: "CURRENT", score: { goals: 1, participant: "away" } },
      ],
    },
    "2026-10-24T15:30:00.000Z",
  );

  assert.equal(result?.status, "finished");
  assert.equal(result?.homeScore, 1);
  assert.equal(result?.awayScore, 1);
  assert.equal(result?.scoreBasis, "regular_time");
});

test("does not fall back to extra-time CURRENT when 90-minute score is unavailable", () => {
  const result = parseSportmonksLiveResult({
    id: 13,
    state: { developer_name: "FT_PEN" },
    scores: [
      { description: "CURRENT", score: { goals: 5, participant: "home" } },
      { description: "CURRENT", score: { goals: 4, participant: "away" } },
    ],
  });

  assert.equal(result?.status, "finished");
  assert.equal(result?.homeScore, null);
  assert.equal(result?.awayScore, null);
  assert.equal(result?.scoreBasis, null);
});
