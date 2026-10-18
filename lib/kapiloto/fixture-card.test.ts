import assert from "node:assert/strict";
import test from "node:test";

import {
  assessFixtureResearchEligibility,
  buildKapilotoFixtureCard,
  buildRoundFixtureCards,
  type FixtureCardInput,
} from "./fixture-card";

function fixture(gameNumber = 1): FixtureCardInput {
  return {
    roundId: "round-1",
    roundGameId: `game-${gameNumber}`,
    gameNumber,
    home: {
      id: `home-${gameNumber}`,
      canonicalName: `Home ${gameNumber}`,
      aliases: [`Home ${gameNumber}`, `H${gameNumber}`],
    },
    away: {
      id: `away-${gameNumber}`,
      canonicalName: `Away ${gameNumber}`,
      aliases: [`A${gameNumber}`],
    },
    competition: {
      id: "competition-1",
      name: "League",
      stage: "Regular Season",
      leg: null,
      aggregateHome: null,
      aggregateAway: null,
    },
    kickoffAt: "2026-10-20T18:00:00Z",
    neutralVenue: false,
    settlementRule: "result_after_90_minutes_including_stoppage_time",
    prior: {
      type: "market",
      snapshotId: `market-${gameNumber}`,
      capturedAt: "2026-10-18T10:00:00Z",
      probabilitiesBp: {
        home: 4300,
        draw: 2800,
        away: 2900,
      },
    },
  };
}

test("builds a deterministic fixture card with locked 1/2 orientation", () => {
  const card = buildKapilotoFixtureCard(
    fixture(),
    "2026-10-18T12:00:00Z",
  );

  assert.equal(card.fixture_key, "round-1:1");
  assert.equal(card.orientation["1"], "home-1");
  assert.equal(card.orientation["2"], "away-1");
  assert.equal(card.settlement, "result_after_90_minutes_including_stoppage_time");
  assert.equal(
    card.structured.prior.p_home_bp +
      card.structured.prior.p_draw_bp +
      card.structured.prior.p_away_bp,
    10_000,
  );
  assert.deepEqual(card.teams.home.names, ["Home 1", "H1"]);
});

test("rejects a prior captured after the research cutoff", () => {
  const input = fixture();
  input.prior.capturedAt = "2026-10-18T12:01:00Z";

  const eligibility = assessFixtureResearchEligibility(
    input,
    "2026-10-18T12:00:00Z",
  );

  assert.deepEqual(eligibility, {
    eligible: false,
    reason: "post_cutoff_prior",
  });
  assert.throws(
    () => buildKapilotoFixtureCard(input, "2026-10-18T12:00:00Z"),
    /post_cutoff_prior/,
  );
});

test("does not research inside the kickoff safety window", () => {
  const input = fixture();
  input.kickoffAt = "2026-10-18T12:14:00Z";

  assert.deepEqual(
    assessFixtureResearchEligibility(input, "2026-10-18T12:00:00Z"),
    { eligible: false, reason: "kickoff_too_close" },
  );
});

test("rejects malformed market probabilities", () => {
  const input = fixture();
  input.prior.probabilitiesBp.away = 2_899;

  assert.throws(
    () => buildKapilotoFixtureCard(input, "2026-10-18T12:00:00Z"),
    /sum to exactly 10000/,
  );
});

test("round builder requires all Toto numbers exactly once and sorts them", () => {
  const inputs = Array.from({ length: 16 }, (_, index) => fixture(16 - index));
  const cards = buildRoundFixtureCards(inputs, "2026-10-18T12:00:00Z");

  assert.deepEqual(
    cards.map((card) => card.toto_number),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );

  assert.throws(
    () => buildRoundFixtureCards(inputs.slice(0, 15), "2026-10-18T12:00:00Z"),
    /exactly 16/,
  );
});
