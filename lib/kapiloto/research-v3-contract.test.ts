import assert from "node:assert/strict";
import test from "node:test";

import researchV3Schema from "@/docs/ai/kapiloto-research-output.v3.schema.json";

import { buildKapilotoFixtureCard } from "./fixture-card";
import {
  KAPILOTO_RESEARCH_DIMENSIONS,
  validateSolFixtureResearchOutput,
  type SolFixtureResearchOutput,
} from "./research-output";

function card(hoursUntilKickoff = 30) {
  const cutoff = new Date("2026-10-29T12:00:00.000Z");
  const kickoff = new Date(cutoff.getTime() + hoursUntilKickoff * 3_600_000);
  return buildKapilotoFixtureCard(
    {
      fixtureId: "fixture-v3",
      roundId: "round-v3",
      roundGameId: "game-v3",
      gameNumber: 1,
      home: { id: "home", canonicalName: "Home FC" },
      away: { id: "away", canonicalName: "Away FC" },
      competition: {
        id: "league",
        name: "League",
        stage: null,
        leg: null,
        aggregateHome: null,
        aggregateAway: null,
      },
      kickoffAt: kickoff.toISOString(),
      neutralVenue: false,
      prior: {
        type: "market",
        snapshotId: "market-v3",
        capturedAt: "2026-10-29T11:00:00.000Z",
        probabilitiesBp: { home: 4200, draw: 2900, away: 2900 },
      },
    },
    cutoff.toISOString(),
  );
}

function output(): SolFixtureResearchOutput {
  return {
    protocol_version: "kapiloto-research-v3",
    fixture_key: "fixture-v3",
    home_team_id: "home",
    away_team_id: "away",
    outcome: "analyzed",
    evidence: [
      {
        evidence_id: "e1",
        url: "https://example.com/tactics",
        quote: "Home FC presses high and Away FC builds short.",
        claim: "The tactical matchup favors Home FC.",
        claim_type: "tactical_setup",
        about_team: "both",
        event_time: "2026-10-29",
      },
    ],
    availability: [],
    expected_lineups: {
      home: {
        status: "insufficient_data",
        formation: null,
        formation_evidence_ids: [],
        starters: [],
      },
      away: {
        status: "insufficient_data",
        formation: null,
        formation_evidence_ids: [],
        starters: [],
      },
    },
    tactical_facts: [
      {
        fact_id: "t1",
        team: "home",
        phase: "defending",
        attribute: "press_height",
        value: "high",
        evidence_ids: ["e1"],
      },
      {
        fact_id: "t2",
        team: "away",
        phase: "possession",
        attribute: "build_up",
        value: "short",
        evidence_ids: ["e1"],
      },
    ],
    matchup_analysis: [
      {
        matchup_id: "m1",
        kind: "press_vs_buildup",
        fact_ids: ["t1", "t2"],
        favors: "home",
        magnitude: "small",
        description: "Home press can disrupt Away's short build-up.",
        evidence_ids: ["e1"],
      },
    ],
    regime_changes: [],
    factors: [
      {
        dimension: "tactical_matchup",
        favors: "home",
        magnitude: "small",
        evidence_ids: ["e1"],
        structured_refs: [],
        matchup_ids: ["m1"],
        rationale: "The press-versus-build-up interaction favors Home.",
      },
    ],
    dimension_coverage: KAPILOTO_RESEARCH_DIMENSIONS.map((dimension) => ({
      dimension,
      status:
        dimension === "tactical_matchup"
          ? ("material_signal" as const)
          : ("no_material_signal" as const),
    })),
    conflicts: [],
    p_sol: { home_bp: 4400, draw_bp: 2800, away_bp: 2800 },
    market_deviation: null,
    key_assumptions: [],
    main_risk: "Tactical evidence is limited.",
    summary: "Home has a small tactical edge.",
    watch_items: [],
    data_quality: {
      sparse_coverage: false,
      language_limited: false,
      notes: "Contract test.",
    },
    suspicious_content_observed: [],
    model_self_confidence: "medium",
  };
}

test("v3 contract validates a linked descriptive matchup and probability factor", () => {
  const result = validateSolFixtureResearchOutput(
    output(),
    card(),
    ["https://example.com/tactics"],
    "kapiloto-research-v3",
  );
  assert.equal(result.output.protocol_version, "kapiloto-research-v3");
  assert.deepEqual(result.output.factors[0].matchup_ids, ["m1"]);
});

test("v3 rejects a directional matchup that is not linked to a factor", () => {
  const raw = output();
  raw.factors[0].matchup_ids = [];
  assert.throws(
    () =>
      validateSolFixtureResearchOutput(
        raw,
        card(),
        ["https://example.com/tactics"],
        "kapiloto-research-v3",
      ),
    /Directional matchup m1 must be linked/,
  );
});

test("v3 refuses lineup predictions when the frozen card disables lineup research", () => {
  const raw = output();
  raw.expected_lineups!.home = {
    status: "partial",
    formation: null,
    formation_evidence_ids: [],
    starters: [
      {
        player_name: "Player One",
        position: "FW",
        confidence: "medium",
        evidence_ids: ["e1"],
      },
    ],
  };

  assert.throws(
    () =>
      validateSolFixtureResearchOutput(
        raw,
        card(96),
        ["https://example.com/tactics"],
        "kapiloto-research-v3",
      ),
    /must stay empty when lineup research is disabled/,
  );
});

test("v3 protocol cannot be accepted as a frozen v2 run", () => {
  assert.throws(
    () =>
      validateSolFixtureResearchOutput(
        output(),
        card(),
        ["https://example.com/tactics"],
        "kapiloto-research-v2",
      ),
    /does not match frozen run protocol/,
  );
});

test("v3 strict schema requires all tactical structures and keeps hard caps", () => {
  const schema = researchV3Schema as unknown as {
    properties: {
      protocol_version: { enum: string[] };
      evidence: { maxItems: number };
      tactical_facts: { maxItems: number };
      matchup_analysis: { maxItems: number };
      regime_changes: { maxItems: number };
      factors: { items: { required: string[] } };
    };
    required: string[];
  };

  assert.deepEqual(schema.properties.protocol_version.enum, [
    "kapiloto-research-v3",
  ]);
  for (const field of [
    "expected_lineups",
    "tactical_facts",
    "matchup_analysis",
    "regime_changes",
  ]) {
    assert.equal(schema.required.includes(field), true);
  }
  assert.equal(schema.properties.evidence.maxItems, 24);
  assert.equal(schema.properties.tactical_facts.maxItems, 8);
  assert.equal(schema.properties.matchup_analysis.maxItems, 3);
  assert.equal(schema.properties.regime_changes.maxItems, 2);
  assert.equal(
    schema.properties.factors.items.required.includes("matchup_ids"),
    true,
  );
});
