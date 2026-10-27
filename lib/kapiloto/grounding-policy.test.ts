import assert from "node:assert/strict";
import test from "node:test";

import { buildKapilotoFixtureCard } from "./fixture-card";
import { applyGroundingPolicy } from "./grounding-policy";
import type { SolFixtureResearchOutput } from "./research-output";
import type { GroundingResult } from "./source-grounding";

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
              form: "available",
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
              form: "available",
              rest: "available",
              table: "available",
            },
          },
          sources: [],
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

function output(): SolFixtureResearchOutput {
  return {
    protocol_version: "kapiloto-research-v2",
    fixture_key: "fixture-1",
    home_team_id: "home",
    away_team_id: "away",
    outcome: "analyzed",
    evidence: [
      {
        evidence_id: "e1",
        url: "https://weak.example/report",
        quote: "Home looks stronger.",
        claim: "Home looks stronger.",
        claim_type: "team_news",
        about_team: "home",
        event_time: null,
      },
    ],
    availability: [],
    factors: [
      {
        dimension: "baseline_form",
        favors: "home",
        magnitude: "large",
        evidence_ids: ["e1"],
        structured_refs: ["home.form", "away.form"],
        rationale: "Form and the report favor the home side.",
      },
    ],
    dimension_coverage: [
      "baseline_form",
      "availability",
      "tactical_matchup",
      "set_pieces",
      "load_schedule",
      "home_away_draw",
      "competition_context",
      "motivation",
      "conditions",
      "independent_model",
    ].map((dimension) => ({
      dimension,
      status: dimension === "baseline_form" ? "material_signal" : "no_material_signal",
    })) as SolFixtureResearchOutput["dimension_coverage"],
    conflicts: [],
    p_sol: { home_bp: 5200, draw_bp: 2600, away_bp: 2200 },
    market_deviation: null,
    key_assumptions: [],
    main_risk: "Evidence quality.",
    summary: "Home favored.",
    watch_items: [],
    data_quality: {
      sparse_coverage: false,
      language_limited: false,
      notes: "Test fixture.",
    },
    suspicious_content_observed: [],
    model_self_confidence: "medium",
  };
}

function grounding(entailment: "supported" | "not_checked"): GroundingResult {
  return {
    accepted: [
      {
        modelEvidenceId: "e1",
        canonicalUrl: "https://weak.example/report",
        domain: "weak.example",
        claimType: "team_news",
        aboutTeam: "home",
        quote: "Home looks stronger.",
        claim: "Home looks stronger.",
        sourceEventTime: null,
        publishedAt: "2026-10-29T10:00:00Z",
        retrievedAt: "2026-10-29T11:00:00Z",
        trustTier: 4,
        quoteVerified: true,
        entailment,
        syndicationClusterId: null,
        contentSha256: "a".repeat(64),
      },
    ],
    rejected: [],
    requiresEntailmentVerification: [],
  };
}

test("material factors cannot bypass web entailment through valid structured refs", () => {
  const decision = applyGroundingPolicy(
    output(),
    grounding("not_checked"),
    card(),
  );

  assert.equal(decision.mode, "market_only");
  assert.equal(decision.pSolValid, false);
  assert.equal(decision.output.factors.length, 0);
  assert.ok(
    decision.reasons.includes("p_sol_invalidated:baseline_form"),
  );
});

test("valid structured refs do not replace corroboration for material web factors", () => {
  const decision = applyGroundingPolicy(
    output(),
    grounding("supported"),
    card(),
  );

  assert.equal(decision.mode, "market_only");
  assert.equal(decision.pSolValid, false);
  assert.equal(decision.output.factors.length, 0);
});


test("v3 prunes an unsupported predicted starter and recomputes lineup status", () => {
  const raw = output();
  raw.protocol_version = "kapiloto-research-v3";
  raw.expected_lineups = {
    home: {
      status: "supported",
      formation: null,
      formation_evidence_ids: [],
      starters: [
        {
          player_name: "Player A",
          position: "FW",
          confidence: "high",
          evidence_ids: ["e2"],
        },
      ],
    },
    away: {
      status: "insufficient_data",
      formation: null,
      formation_evidence_ids: [],
      starters: [],
    },
  };
  raw.tactical_facts = [];
  raw.matchup_analysis = [];
  raw.regime_changes = [];

  const grounded = grounding("supported");
  grounded.accepted.push({
    modelEvidenceId: "e2",
    canonicalUrl: "https://club.example/lineup",
    domain: "club.example",
    claimType: "lineup",
    aboutTeam: "home",
    quote: "Player A may be considered.",
    claim: "Player A is expected to start.",
    sourceEventTime: "2026-10-29",
    publishedAt: "2026-10-29T10:00:00Z",
    retrievedAt: "2026-10-29T11:00:00Z",
    trustTier: 1,
    quoteVerified: true,
    entailment: "not_checked",
    syndicationClusterId: null,
    contentSha256: "b".repeat(64),
  });
  grounded.itemEntailmentVerdicts = {
    "lineup:home:starter:0": "unsupported",
  };

  const decision = applyGroundingPolicy(raw, grounded, card());

  assert.deepEqual(decision.output.expected_lineups?.home.starters, []);
  assert.equal(
    decision.output.expected_lineups?.home.status,
    "insufficient_data",
  );
  assert.ok(
    decision.removedItems.some((item) =>
      item.startsWith("lineup:home:starter:Player A"),
    ),
  );
});
