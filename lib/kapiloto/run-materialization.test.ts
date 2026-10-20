import assert from "node:assert/strict";
import test from "node:test";

import type { KapilotoFixtureCard } from "./fixture-card";
import { KAPILOTO_RESEARCH_DIMENSIONS } from "./research-output";
import type { SolFixtureResearchOutput } from "./research-output";
import type { GroundingResult } from "./source-grounding";
import {
  materializeValidatedResearchRound,
  type ValidatedFixtureResearch,
} from "./run-materialization";

function card(gameNumber: number): KapilotoFixtureCard {
  const fixtureId = `fixture-${gameNumber}`;
  return {
    fixture_card_version: "kapiloto-fixture-card-v2",
    fixture_key: fixtureId,
    fixture_id: fixtureId,
    round_game_id: `game-${gameNumber}`,
    toto_number: gameNumber,
    settlement: "result_after_90_minutes_including_stoppage_time",
    orientation: {
      "1": `home-${gameNumber}`,
      "2": `away-${gameNumber}`,
    },
    teams: {
      home: { id: `home-${gameNumber}`, names: [`Home ${gameNumber}`] },
      away: { id: `away-${gameNumber}`, names: [`Away ${gameNumber}`] },
    },
    competition: {
      id: "competition-1",
      name: "League",
      stage: null,
      leg: null,
      aggregate: null,
    },
    kickoff_at: "2026-10-21T18:00:00.000Z",
    neutral_venue: false,
    research_cutoff_at: "2026-10-20T10:00:00.000Z",
    structured: {
      table_snapshot_id: null,
      recent_matches: [],
      squad_snapshot_id: null,
      coach: null,
      prior: {
        type: "market",
        snapshot_id: `market-${gameNumber}`,
        captured_at: "2026-10-20T09:59:00.000Z",
        p_home_bp: 4300,
        p_draw_bp: 3000,
        p_away_bp: 2700,
      },
    },
  };
}

function output(gameNumber: number): SolFixtureResearchOutput {
  return {
    protocol_version: "kapiloto-research-v1",
    fixture_key: `fixture-${gameNumber}`,
    home_team_id: `home-${gameNumber}`,
    away_team_id: `away-${gameNumber}`,
    outcome: "analyzed",
    evidence: [
      {
        evidence_id: "e1",
        url: "https://example.com/report",
        quote: "Verified source text",
        claim: "Current context is relevant.",
        claim_type: "baseline_form",
        about_team: "both",
        event_time: null,
      },
    ],
    availability: [],
    factors: [
      {
        dimension: "baseline_form",
        favors: "home",
        magnitude: "small",
        evidence_ids: ["e1"],
        rationale: "Home side has the stronger recent baseline.",
      },
    ],
    dimension_coverage: KAPILOTO_RESEARCH_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "no_material_signal" as const,
    })),
    conflicts: [],
    p_sol: {
      home_bp: 4300 + gameNumber * 10,
      draw_bp: 3000,
      away_bp: 2700 - gameNumber * 10,
    },
    market_deviation: null,
    key_assumptions: [],
    main_risk: "Late team news.",
    summary: `Fixture ${gameNumber} research summary.`,
    watch_items: [],
    data_quality: {
      sparse_coverage: false,
      language_limited: false,
      notes: "",
    },
    suspicious_content_observed: [],
    model_self_confidence: "medium",
  };
}

function grounding(): GroundingResult {
  return {
    accepted: [
      {
        modelEvidenceId: "e1",
        canonicalUrl: "https://example.com/report",
        domain: "example.com",
        claimType: "baseline_form",
        aboutTeam: "both",
        quote: "Verified source text",
        claim: "Current context is relevant.",
        sourceEventTime: null,
        publishedAt: "2026-10-20T08:00:00.000Z",
        retrievedAt: "2026-10-20T09:00:00.000Z",
        trustTier: 2,
        quoteVerified: true,
        entailment: "not_checked",
        syndicationClusterId: null,
        contentSha256: "abc123",
      },
    ],
    rejected: [],
    requiresEntailmentVerification: [],
  };
}

function round(): ValidatedFixtureResearch[] {
  return Array.from({ length: 16 }, (_, index) => {
    const gameNumber = index + 1;
    return {
      gameNumber,
      roundGameId: `game-${gameNumber}`,
      fixtureId: `fixture-${gameNumber}`,
      card: card(gameNumber),
      output: output(gameNumber),
      grounding: grounding(),
    };
  });
}

test("materializes 16 grounded fixtures and assigns a unique deterministic double rank", () => {
  const result = materializeValidatedResearchRound(round());

  assert.equal(result.analyses.length, 16);
  assert.equal(result.synthesis.analyzed_fixtures, 16);
  assert.equal(result.synthesis.insufficient_data_fixtures, 0);

  const ranks = result.analyses
    .map((analysis) => analysis.double_priority_rank)
    .filter((rank): rank is number => rank != null)
    .sort((a, b) => a - b);

  assert.deepEqual(
    ranks,
    Array.from({ length: 16 }, (_, index) => index + 1),
  );

  const first = result.analyses[0];
  assert.equal(first.fixture_id, "fixture-1");
  assert.equal(first.round_game_id, "game-1");
  assert.equal(first.evidence.length, 1);
  assert.equal(first.factors[0].evidence_model_ids[0], "e1");
  assert.equal(first.inputs[0].input_type, "fixture_card");
  assert.equal(first.orientation_verified, true);
});

test("insufficient-data fixture is materialized without pick or double rank", () => {
  const fixtures = round();
  fixtures[4].output.outcome = "insufficient_data";
  fixtures[4].output.evidence = [];
  fixtures[4].output.factors = [];
  fixtures[4].grounding = {
    accepted: [],
    rejected: [],
    requiresEntailmentVerification: [],
  };

  const result = materializeValidatedResearchRound(fixtures);
  const fifth = result.analyses[4];

  assert.equal(fifth.outcome, "insufficient_data");
  assert.equal(fifth.primary_pick, null);
  assert.equal(fifth.suggested_double, null);
  assert.equal(fifth.double_priority_rank, null);
  assert.equal(result.synthesis.analyzed_fixtures, 15);
  assert.equal(result.synthesis.insufficient_data_fixtures, 1);
  assert.equal(result.synthesis.double_ranking.length, 15);
});

test("analyzed fixture cannot materialize without accepted grounded evidence", () => {
  const fixtures = round();
  fixtures[0].grounding = {
    accepted: [],
    rejected: [{ evidenceId: "e1", reason: "quote_not_found" }],
    requiresEntailmentVerification: [],
  };

  assert.throws(
    () => materializeValidatedResearchRound(fixtures),
    /no accepted grounded evidence/,
  );
});

test("pending material-factor entailment blocks publication", () => {
  const fixtures = round();
  fixtures[0].grounding = {
    ...grounding(),
    requiresEntailmentVerification: ["e1"],
  };

  assert.throws(
    () => materializeValidatedResearchRound(fixtures),
    /still requires material-factor entailment verification/,
  );
});

test("fixture identity mismatch is rejected before derivation", () => {
  const fixtures = round();
  fixtures[0] = {
    ...fixtures[0],
    fixtureId: "wrong-fixture",
  };

  assert.throws(
    () => materializeValidatedResearchRound(fixtures),
    /does not match its frozen fixture identity/,
  );
});
