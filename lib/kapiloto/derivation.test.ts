import assert from "node:assert/strict";
import test from "node:test";

import type { KapilotoFixtureCard } from "./fixture-card";
import type { SolFixtureResearchOutput } from "./research-output";
import {
  deriveFixtureAnalysis,
  rankDoubleCandidates,
} from "./derivation";
import { KAPILOTO_RESEARCH_DIMENSIONS } from "./research-output";

function card(
  prior: [number, number, number] = [4500, 3000, 2500],
): KapilotoFixtureCard {
  return {
    fixture_card_version: "kapiloto-fixture-card-v2",
    fixture_key: "fixture-1",
    fixture_id: "fixture-1",
    round_game_id: "game-1",
    toto_number: 1,
    settlement: "result_after_90_minutes_including_stoppage_time",
    orientation: { "1": "home", "2": "away" },
    teams: {
      home: { id: "home", names: ["Home"] },
      away: { id: "away", names: ["Away"] },
    },
    competition: {
      id: "competition",
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
        snapshot_id: "market-1",
        captured_at: "2026-10-20T09:59:00.000Z",
        p_home_bp: prior[0],
        p_draw_bp: prior[1],
        p_away_bp: prior[2],
      },
    },
  };
}

function output(
  pSol: [number, number, number] = [5000, 2800, 2200],
): SolFixtureResearchOutput {
  return {
    protocol_version: "kapiloto-research-v1",
    fixture_key: "fixture-1",
    home_team_id: "home",
    away_team_id: "away",
    outcome: "analyzed",
    evidence: [],
    availability: [],
    factors: [],
    dimension_coverage: KAPILOTO_RESEARCH_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "no_material_signal" as const,
    })),
    conflicts: [],
    p_sol: {
      home_bp: pSol[0],
      draw_bp: pSol[1],
      away_bp: pSol[2],
    },
    market_deviation: null,
    key_assumptions: [],
    main_risk: "Late information.",
    summary: "Structured shadow derivation test.",
    watch_items: [],
    data_quality: {
      sparse_coverage: false,
      language_limited: false,
      notes: "",
    },
    suspicious_content_observed: [],
    model_self_confidence: "high",
  };
}

test("derives final probabilities deterministically and preserves 10000 basis points", () => {
  const result = deriveFixtureAnalysis(output(), card(), {
    acceptedTrustTiers: [1, 2],
    rejectedCount: 0,
  });

  assert.equal(result.outcome, "analyzed");
  if (result.outcome !== "analyzed") return;

  assert.equal(
    result.pFinal["1"] + result.pFinal.X + result.pFinal["2"],
    10_000,
  );
  assert.equal(result.primaryPick, "1");
  assert.equal(result.suggestedDouble, "1X");
  assert.ok(result.reliability >= 0.2 && result.reliability <= 0.85);
  assert.equal(result.blendWeight, result.reliability);
  assert.equal(result.deviationCapApplied, false);
});

test("sparse and weakly grounded research lowers reliability", () => {
  const strong = deriveFixtureAnalysis(output(), card(), {
    acceptedTrustTiers: [1, 1],
    rejectedCount: 0,
  });

  const weakOutput = output();
  weakOutput.dimension_coverage = weakOutput.dimension_coverage.map(
    (item, index) => ({
      ...item,
      status: index < 3 ? "no_material_signal" : "insufficient_data",
    }),
  );
  weakOutput.data_quality.sparse_coverage = true;
  weakOutput.data_quality.language_limited = true;

  const weak = deriveFixtureAnalysis(weakOutput, card(), {
    acceptedTrustTiers: [4],
    rejectedCount: 2,
  });

  assert.ok(weak.reliability < strong.reliability);
  assert.ok(weak.reliability >= 0.2);
});

test("insufficient data never receives a pick or probability synthesis", () => {
  const insufficient = output();
  insufficient.outcome = "insufficient_data";

  const result = deriveFixtureAnalysis(insufficient, card(), {
    acceptedTrustTiers: [],
    rejectedCount: 0,
  });

  assert.deepEqual(result.outcome, "insufficient_data");
  assert.equal(result.reliabilityBand, "low");
  assert.ok(
    result.reliabilityReasons.includes("sol_reported_insufficient_data"),
  );
  assert.ok(!("primaryPick" in result));
});

test("double ranking uses second/top ratio before reliability and game number", () => {
  const a = deriveFixtureAnalysis(
    output([5000, 3000, 2000]),
    card([5000, 3000, 2000]),
    { acceptedTrustTiers: [1], rejectedCount: 0 },
  );
  const b = deriveFixtureAnalysis(
    output([4200, 3800, 2000]),
    card([4200, 3800, 2000]),
    { acceptedTrustTiers: [1], rejectedCount: 0 },
  );

  assert.equal(a.outcome, "analyzed");
  assert.equal(b.outcome, "analyzed");
  if (a.outcome !== "analyzed" || b.outcome !== "analyzed") return;

  const ranked = rankDoubleCandidates([
    {
      gameNumber: 1,
      roundGameId: "game-1",
      fixtureId: "fixture-1",
      derived: a,
    },
    {
      gameNumber: 2,
      roundGameId: "game-2",
      fixtureId: "fixture-2",
      derived: b,
    },
  ]);

  assert.equal(ranked[0].fixtureId, "fixture-2");
  assert.equal(ranked[0].doublePriorityRank, 1);
  assert.equal(ranked[1].doublePriorityRank, 2);
});

test("double ranking tie breaker prefers lower reliability then lower Toto number", () => {
  const base = deriveFixtureAnalysis(
    output([5000, 3000, 2000]),
    card([5000, 3000, 2000]),
    { acceptedTrustTiers: [1], rejectedCount: 0 },
  );
  assert.equal(base.outcome, "analyzed");
  if (base.outcome !== "analyzed") return;

  const lowReliability = { ...base, reliability: 0.4 };
  const highReliability = { ...base, reliability: 0.8 };

  const ranked = rankDoubleCandidates([
    {
      gameNumber: 1,
      roundGameId: "game-1",
      fixtureId: "fixture-1",
      derived: highReliability,
    },
    {
      gameNumber: 5,
      roundGameId: "game-5",
      fixtureId: "fixture-5",
      derived: lowReliability,
    },
    {
      gameNumber: 3,
      roundGameId: "game-3",
      fixtureId: "fixture-3",
      derived: lowReliability,
    },
  ]);

  assert.deepEqual(
    ranked.map((item) => item.fixtureId),
    ["fixture-3", "fixture-5", "fixture-1"],
  );
});
