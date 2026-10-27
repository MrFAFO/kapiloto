import assert from "node:assert/strict";
import test from "node:test";

import { buildKapilotoFixtureCard } from "./fixture-card";
import {
  validateStructuredRefs,
  verifyStructuredFactor,
} from "./structured-refs";
import type { SolFixtureResearchOutput } from "./research-output";

function card() {
  return buildKapilotoFixtureCard(
    {
      fixtureId: "fixture-1",
      roundId: "round-1",
      roundGameId: "game-1",
      gameNumber: 1,
      home: { id: "home", canonicalName: "Home" },
      away: { id: "away", canonicalName: "Away" },
      competition: {
        id: "league-1",
        name: "League",
        stage: "Regular",
        leg: null,
        aggregateHome: null,
        aggregateAway: null,
      },
      kickoffAt: "2026-10-30T18:00:00Z",
      neutralVenue: false,
      structuredSnapshot: {
        id: "snapshot-1",
        featureVersion: "kapiloto-features-v1",
        sha256: "a".repeat(64),
        computedAt: "2026-10-29T12:00:00Z",
        cutoffAt: "2026-10-29T12:00:00Z",
        features: {
          feature_version: "kapiloto-features-v1",
          home: {
            form: {
              played: 6,
              points: 15,
              gf: 12,
              ga: 5,
              venue_played: 5,
              venue_points: 13,
              venue_gf: 10,
              venue_ga: 3,
              last_match_at: "2026-10-25T18:00:00Z",
            },
            rest: { rest_days: 5, matches_last_14d: 2 },
            table: {
              position: 2,
              points: 24,
              played: 10,
              goal_difference: 12,
              points_deducted: null,
            },
            coverage: {
              form: "partial",
              rest: "available",
              table: "available",
            },
          },
          away: {
            form: {
              played: 6,
              points: 8,
              gf: 7,
              ga: 9,
              venue_played: 5,
              venue_points: 6,
              venue_gf: 5,
              venue_ga: 8,
              last_match_at: "2026-10-26T18:00:00Z",
            },
            rest: { rest_days: 2, matches_last_14d: 4 },
            table: {
              position: 8,
              points: 12,
              played: 10,
              goal_difference: -3,
              points_deducted: null,
            },
            coverage: {
              form: "partial",
              rest: "available",
              table: "available",
            },
          },
          sources: [],
        },
      },
      providerAnalytics: {
        provider: "football-il-parse",
        sourceVersion: "football-il-parse-v11",
        capturedAt: "2026-10-29T11:30:00Z",
        season: "26/27",
        home: {
          team_id: "home",
          xg_expected: 14.4,
          games_played: 8,
          xg_per_match: 1.8,
          goals_scored: 18,
          shots_total: 110,
          shots_on_target: 42,
          possession: 55.2,
        },
        away: {
          team_id: "away",
          xg_expected: 9.6,
          games_played: 8,
          xg_per_match: 1.2,
          goals_scored: 11,
          shots_total: 85,
          shots_on_target: 30,
          possession: 48.1,
        },
      },
      prior: {
        type: "market",
        snapshotId: "market-1",
        capturedAt: "2026-10-29T11:00:00Z",
        probabilitiesBp: { home: 4500, draw: 2800, away: 2700 },
      },
    },
    "2026-10-29T12:00:00Z",
  );
}

type Factor = SolFixtureResearchOutput["factors"][number];

function factor(
  dimension: Factor["dimension"],
  favors: Factor["favors"],
  refs: string[],
  evidenceIds: string[] = [],
  magnitude: Factor["magnitude"] = "small",
): Factor {
  return {
    dimension,
    favors,
    magnitude,
    evidence_ids: evidenceIds,
    structured_refs: refs,
    rationale: "Structured facts support this direction.",
  };
}

test("validates only references present in the frozen structured snapshot", () => {
  assert.deepEqual(
    validateStructuredRefs(["away.form", "home.form"], card()),
    ["away.form", "home.form"],
  );

  assert.throws(
    () => validateStructuredRefs(["home.xg"], card()),
    /Unknown structured reference/,
  );
});

test("supports a small baseline-form factor only when the structured direction agrees", () => {
  assert.equal(
    verifyStructuredFactor(
      factor("baseline_form", "home", ["home.form", "away.form"]),
      card(),
    ).valid,
    true,
  );

  const opposite = verifyStructuredFactor(
    factor("baseline_form", "away", ["home.form", "away.form"]),
    card(),
  );
  assert.equal(opposite.valid, false);
  assert.equal(opposite.reason, "direction_mismatch");
});

test("requires both sides for comparative structured factors", () => {
  const result = verifyStructuredFactor(
    factor("baseline_form", "home", ["home.form"]),
    card(),
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, "insufficient_pair");
});

test("supports schedule direction from rest and congestion differences", () => {
  const result = verifyStructuredFactor(
    factor("load_schedule", "home", ["home.rest", "away.rest"]),
    card(),
  );
  assert.equal(result.valid, true);
});

test("does not allow structured-only medium or large factors", () => {
  const result = verifyStructuredFactor(
    factor(
      "baseline_form",
      "home",
      ["home.form", "away.form"],
      [],
      "medium",
    ),
    card(),
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, "structured_only_magnitude_too_large");
});

test("structured refs cannot support unsupported V1 dimensions", () => {
  const result = verifyStructuredFactor(
    factor("tactical_matchup", "home", ["home.form", "away.form"]),
    card(),
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, "wrong_dimension");
});


test("paired normalized attack xG refs support a small baseline-form factor", () => {
  assert.deepEqual(
    validateStructuredRefs(
      ["home.attack_xg", "away.attack_xg"],
      card(),
    ),
    ["away.attack_xg", "home.attack_xg"],
  );

  const result = verifyStructuredFactor(
    factor(
      "baseline_form",
      "home",
      ["home.attack_xg", "away.attack_xg"],
    ),
    card(),
  );

  assert.equal(result.valid, true);

  const opposite = verifyStructuredFactor(
    factor(
      "baseline_form",
      "away",
      ["home.attack_xg", "away.attack_xg"],
    ),
    card(),
  );
  assert.equal(opposite.valid, false);
  assert.equal(opposite.reason, "direction_mismatch");
});

test("attack xG structured factors require both sides", () => {
  const result = verifyStructuredFactor(
    factor("baseline_form", "home", ["home.attack_xg"]),
    card(),
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, "insufficient_pair");
});
