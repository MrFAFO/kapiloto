import assert from "node:assert/strict";
import test from "node:test";

import type { KapilotoFixtureCard } from "./fixture-card";
import { KAPILOTO_RESEARCH_DIMENSIONS } from "./research-output";
import type { SolFixtureResearchOutput } from "./research-output";
import type { GroundingResult } from "./source-grounding";
import {
  materializeKapilotoResearchRun,
  materializeValidatedResearchRound,
  type MaterializableFixture,
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
        entailment: "supported",
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

test("directional factor with rejected evidence invalidates p_sol and falls back to market only", () => {
  const fixtures = round();
  fixtures[0].output.evidence.push({
    evidence_id: "e2",
    url: "https://example.com/rejected",
    quote: "Rejected source text",
    claim: "Unsupported availability.",
    claim_type: "availability",
    about_team: "home",
    event_time: null,
  });
  fixtures[0].output.availability = [
    {
      team: "home",
      player_name: "Player One",
      status: "out",
      role: "regular",
      certainty: "reported",
      evidence_ids: ["e2"],
    },
  ];
  fixtures[0].output.factors[0].evidence_ids = ["e1", "e2"];
  fixtures[0].output.conflicts = [
    {
      topic: "availability",
      evidence_ids_a: ["e1"],
      evidence_ids_b: ["e2"],
      resolution: "unresolved",
    },
  ];
  fixtures[0].grounding = {
    ...grounding(),
    rejected: [{ evidenceId: "e2", reason: "document_missing" }],
  };

  const result = materializeValidatedResearchRound(fixtures);
  const first = result.analyses[0];

  assert.equal(first.outcome, "analyzed");
  assert.equal(first.blend_weight, 0);
  assert.equal(first.p_sol_1_bp, null);
  assert.equal(first.p_final_1_bp, first.p_prior_1_bp);
  assert.deepEqual(first.factors, []);
  assert.deepEqual(first.availability, []);
  assert.deepEqual(first.conflicts, []);
  assert.equal(first.double_priority_rank, null);
  assert.equal(
    first.reliability_reasons.includes("p_sol_invalidated:baseline_form"),
    true,
  );
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

test("analyzed fixture with no grounded directional evidence falls back to market only", () => {
  const fixtures = round();
  fixtures[0].grounding = {
    accepted: [],
    rejected: [{ evidenceId: "e1", reason: "quote_not_found" }],
    requiresEntailmentVerification: [],
  };

  const result = materializeValidatedResearchRound(fixtures);
  const first = result.analyses[0];
  assert.equal(first.outcome, "analyzed");
  assert.equal(first.blend_weight, 0);
  assert.equal(first.p_sol_1_bp, null);
  assert.equal(first.p_final_1_bp, first.p_prior_1_bp);
  assert.equal(first.double_priority_rank, null);
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


test("mixed run keeps 16-row coherence and ranks carried analysis with fresh research", () => {
  const fresh = round();
  const previous = materializeValidatedResearchRound(round()).analyses[14];

  const fixtures: MaterializableFixture[] = [
    ...fresh.slice(0, 14).map((fixture) => ({
      ...fixture,
      mode: "research" as const,
    })),
    {
      mode: "carried_forward",
      gameNumber: 15,
      roundGameId: "game-15",
      fixtureId: "fixture-15",
      carriedFromAnalysisId: "analysis-old-15",
      reason: "missing_prior",
      researchCutoffAt: "2026-10-20T10:00:00.000Z",
      context: {
        kickoffAt: "2026-10-21T18:00:00.000Z",
        settlementRule: "result_after_90_minutes_including_stoppage_time",
        neutralVenue: false,
      },
      source: {
        analysisId: "analysis-old-15",
        analysis: previous,
      },
    },
    {
      mode: "research_unavailable",
      gameNumber: 16,
      roundGameId: "game-16",
      fixtureId: "fixture-16",
      reason: "missing_prior",
      researchCutoffAt: "2026-10-20T10:00:00.000Z",
      context: {
        kickoffAt: "2026-10-21T18:00:00.000Z",
        settlementRule: "result_after_90_minutes_including_stoppage_time",
        neutralVenue: false,
      },
    },
  ];

  const result = materializeKapilotoResearchRun(fixtures);

  assert.equal(result.analyses.length, 16);
  assert.equal(result.synthesis.analyzed_fixtures, 14);
  assert.equal(result.synthesis.carried_forward_fixtures, 1);
  assert.equal(result.synthesis.research_unavailable_fixtures, 1);
  assert.equal(result.synthesis.double_ranking.length, 15);
  assert.equal(result.analyses[14].outcome, "carried_forward");
  assert.equal(result.analyses[14].carried_from_analysis_id, "analysis-old-15");
  assert.equal(result.analyses[15].outcome, "research_unavailable");
  assert.equal(result.analyses[15].primary_pick, null);
});


test("structured-only grounded factor survives publication and contributes reliability", () => {
  const fixtures = round();
  const first = fixtures[0];

  first.card = {
    ...first.card,
    fixture_card_version: "kapiloto-fixture-card-v3",
    structured: {
      ...first.card.structured,
      structured_snapshot: {
        id: "snapshot-1",
        feature_version: "kapiloto-features-v1",
        sha256: "a".repeat(64),
        computed_at: "2026-10-20T09:55:00.000Z",
        cutoff_at: first.card.research_cutoff_at,
        features: {
          feature_version: "kapiloto-features-v1",
          home: {
            form: {
              played: 6,
              points: 15,
              gf: 12,
              ga: 5,
              venue_played: 4,
              venue_points: 10,
              venue_gf: 8,
              venue_ga: 3,
              last_match_at: "2026-10-17T18:00:00.000Z",
            },
            rest: { rest_days: 4, matches_last_14d: 2 },
            table: null,
            coverage: {
              form: "partial",
              rest: "available",
              table: "unavailable",
            },
          },
          away: {
            form: {
              played: 6,
              points: 7,
              gf: 6,
              ga: 10,
              venue_played: 4,
              venue_points: 4,
              venue_gf: 3,
              venue_ga: 8,
              last_match_at: "2026-10-18T18:00:00.000Z",
            },
            rest: { rest_days: 2, matches_last_14d: 4 },
            table: null,
            coverage: {
              form: "partial",
              rest: "available",
              table: "unavailable",
            },
          },
          sources: [],
        },
      },
    },
  };

  first.output.protocol_version = "kapiloto-research-v2";
  first.output.evidence = [];
  first.output.availability = [];
  first.output.factors = [
    {
      dimension: "baseline_form",
      favors: "home",
      magnitude: "small",
      evidence_ids: [],
      structured_refs: ["home.form", "away.form"],
      rationale: "The frozen form snapshot favors the home side.",
    },
  ];
  first.grounding = {
    accepted: [],
    rejected: [],
    requiresEntailmentVerification: [],
  };

  const result = materializeValidatedResearchRound(fixtures);
  const analysis = result.analyses[0];

  assert.equal(analysis.outcome, "analyzed");
  assert.notEqual(analysis.p_sol_1_bp, null);
  assert.equal(analysis.evidence.length, 0);
  assert.deepEqual(analysis.factors[0].structured_refs, [
    "away.form",
    "home.form",
  ]);
  assert.equal(
    analysis.reliability_reasons.includes("verified_structured_evidence"),
    true,
  );
  assert.ok(
    analysis.inputs.some(
      (input) => input.input_type === "structured_factor_refs",
    ),
  );
});
