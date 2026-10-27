import assert from "node:assert/strict";
import test from "node:test";

import type { KapilotoFixtureCard } from "./fixture-card";
import {
  verifyGroundedResearchEvidence,
  type RetrievedSourceDocument,
  type SourceRegistryEntry,
} from "./source-grounding";
import {
  KAPILOTO_RESEARCH_DIMENSIONS,
  type SolFixtureResearchOutput,
} from "./research-output";

const card: KapilotoFixtureCard = {
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
    id: "league",
    name: "League",
    stage: null,
    leg: null,
    aggregate: null,
  },
  kickoff_at: "2026-10-20T18:00:00.000Z",
  neutral_venue: false,
  research_cutoff_at: "2026-10-18T12:00:00.000Z",
  structured: {
    table_snapshot_id: null,
    recent_matches: [],
    squad_snapshot_id: null,
    coach: null,
    prior: {
      type: "market",
      snapshot_id: "market",
      captured_at: "2026-10-18T11:00:00.000Z",
      p_home_bp: 4000,
      p_draw_bp: 3000,
      p_away_bp: 3000,
    },
  },
};

function baseOutput(): SolFixtureResearchOutput {
  return {
    protocol_version: "kapiloto-research-v1",
    fixture_key: "fixture-1",
    home_team_id: "home",
    away_team_id: "away",
    outcome: "analyzed",
    evidence: [
      {
        evidence_id: "e1",
        url: "https://club.example/news?utm_source=x",
        quote: "Player A will miss the match.",
        claim: "Player A is unavailable.",
        claim_type: "availability",
        about_team: "home",
        event_time: null,
      },
    ],
    availability: [
      {
        team: "home",
        player_name: "Player A",
        status: "out",
        role: "regular",
        certainty: "confirmed",
        evidence_ids: ["e1"],
      },
    ],
    factors: [
      {
        dimension: "availability",
        favors: "away",
        magnitude: "medium",
        evidence_ids: ["e1"],
        rationale: "A regular home player is unavailable.",
      },
    ],
    dimension_coverage: KAPILOTO_RESEARCH_DIMENSIONS.map((dimension) => ({
      dimension,
      status:
        dimension === "availability"
          ? "material_signal"
          : "no_material_signal",
    })),
    conflicts: [],
    p_sol: { home_bp: 3700, draw_bp: 3000, away_bp: 3300 },
    market_deviation: null,
    key_assumptions: [],
    main_risk: "Late team news.",
    summary: "A close fixture.",
    watch_items: [],
    data_quality: {
      sparse_coverage: false,
      language_limited: false,
      notes: "Adequate.",
    },
    suspicious_content_observed: [],
    model_self_confidence: "medium",
  };
}

function document(
  overrides: Partial<RetrievedSourceDocument> = {},
): RetrievedSourceDocument {
  return {
    requestedUrl: "https://club.example/news",
    finalUrl: "https://club.example/news",
    retrievedAt: "2026-10-18T11:10:00Z",
    publishedAt: "2026-10-18T10:00:00Z",
    text: "Club update: Player A will miss the match. More information follows.",
    contentSha256: "a".repeat(64),
    ...overrides,
  };
}

const registry: SourceRegistryEntry[] = [
  {
    domain: "club.example",
    denied: false,
    tierByClaimType: { availability: 1, default: 2 },
  },
];

test("accepts a verified pre-cutoff quote from a strong source", () => {
  const result = verifyGroundedResearchEvidence(
    baseOutput(),
    card,
    [document()],
    registry,
  );

  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0].trustTier, 1);
  assert.deepEqual(result.requiresEntailmentVerification, ["e1"]);
});

test("rejects a quote that does not appear in fetched text", () => {
  const output = baseOutput();
  output.factors = [];
  output.availability = [];

  const result = verifyGroundedResearchEvidence(
    output,
    card,
    [document({ text: "Different article text." })],
    registry,
  );

  assert.deepEqual(result.rejected, [
    { evidenceId: "e1", reason: "quote_not_found" },
  ]);
});

test("rejects post-cutoff evidence", () => {
  const output = baseOutput();
  output.factors = [];
  output.availability = [];

  const result = verifyGroundedResearchEvidence(
    output,
    card,
    [document({ publishedAt: "2026-10-18T12:01:00Z" })],
    registry,
  );

  assert.deepEqual(result.rejected, [
    { evidenceId: "e1", reason: "published_after_cutoff" },
  ]);
});

test("undated availability evidence is rejected as time sensitive", () => {
  const output = baseOutput();
  output.factors = [];
  output.availability = [];

  const result = verifyGroundedResearchEvidence(
    output,
    card,
    [document({ publishedAt: null })],
    registry,
  );

  assert.deepEqual(result.rejected, [
    { evidenceId: "e1", reason: "undated_time_sensitive_claim" },
  ]);
});

test("denied domains can never ground research", () => {
  const output = baseOutput();
  output.factors = [];
  output.availability = [];

  const result = verifyGroundedResearchEvidence(
    output,
    card,
    [document()],
    [{ domain: "club.example", denied: true, tierByClaimType: {} }],
  );

  assert.deepEqual(result.rejected, [
    { evidenceId: "e1", reason: "source_denied" },
  ]);
});

test("material factors that lack corroboration request a fail-closed downgrade", () => {
  const result = verifyGroundedResearchEvidence(
    baseOutput(),
    card,
    [document()],
    [
      {
        domain: "club.example",
        denied: false,
        tierByClaimType: { availability: 4 },
      },
    ],
  );

  assert.deepEqual(result.requiresEntailmentVerification, []);
  assert.ok(
    result.policyFailures?.some((failure) =>
      failure.includes("lacks strong or independent corroborated evidence"),
    ),
  );
});


test("partially grounded items are flagged for item-level removal", () => {
  const output = baseOutput();
  output.evidence.push({
    evidence_id: "e2",
    url: "https://league.example/report",
    quote: "Player A will miss the match.",
    claim: "Player A is unavailable.",
    claim_type: "availability",
    about_team: "home",
    event_time: null,
  });
  output.availability[0].evidence_ids = ["e1", "e2"];
  output.factors[0].evidence_ids = ["e1", "e2"];

  const leagueDocument = document({
    requestedUrl: "https://league.example/report",
    finalUrl: "https://league.example/report",
    contentSha256: "b".repeat(64),
  });

  const result = verifyGroundedResearchEvidence(
    output,
    card,
    [leagueDocument],
    [
      ...registry,
      {
        domain: "league.example",
        denied: false,
        tierByClaimType: { availability: 1, default: 2 },
      },
    ],
  );

  assert.deepEqual(result.rejected, [
    { evidenceId: "e1", reason: "document_missing" },
  ]);
  assert.deepEqual(
    result.accepted.map((item) => item.modelEvidenceId),
    ["e2"],
  );
  assert.deepEqual(result.requiresEntailmentVerification, []);
  assert.ok(
    result.policyFailures?.some((failure) =>
      failure.includes("availability:Player A has evidence that failed grounding"),
    ),
  );
  assert.ok(
    result.policyFailures?.some((failure) =>
      failure.includes("factor:availability has evidence that failed grounding"),
    ),
  );
});

test("a claim with no grounded support requests a fail-closed downgrade without a retry", () => {
  const result = verifyGroundedResearchEvidence(
    baseOutput(),
    card,
    [],
    registry,
  );

  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.requiresEntailmentVerification, []);
  assert.ok(
    result.policyFailures?.some((failure) =>
      failure.includes("evidence that failed grounding"),
    ),
  );
});

function v3LineupOutput(): SolFixtureResearchOutput {
  const output = baseOutput();
  output.protocol_version = "kapiloto-research-v3";
  output.evidence = [
    {
      evidence_id: "lineup-1",
      url: "https://club.example/lineup",
      quote: "Player A is expected to start for Home.",
      claim: "Player A is expected to start.",
      claim_type: "lineup",
      about_team: "home",
      event_time: "2026-10-18",
    },
  ];
  output.availability = [];
  output.expected_lineups = {
    home: {
      status: "partial",
      formation: null,
      formation_evidence_ids: [],
      starters: [
        {
          player_name: "Player A",
          position: "FW",
          confidence: "medium",
          evidence_ids: ["lineup-1"],
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
  output.tactical_facts = [];
  output.matchup_analysis = [];
  output.regime_changes = [];
  output.factors = [];
  return output;
}

test("v3 lineup evidence creates a server-written item entailment request", () => {
  const v3Card = { ...card, lineup_research: "enabled" as const };
  const result = verifyGroundedResearchEvidence(
    v3LineupOutput(),
    v3Card,
    [
      document({
        requestedUrl: "https://club.example/lineup",
        finalUrl: "https://club.example/lineup",
        publishedAt: "2026-10-18T10:00:00Z",
        text: "Team update: Player A is expected to start for Home.",
      }),
    ],
    [
      {
        domain: "club.example",
        denied: false,
        tierByClaimType: { lineup: 1, default: 2 },
      },
    ],
  );

  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.itemEntailmentRequests, [
    {
      verificationId: "lineup:home:starter:0",
      evidenceIds: ["lineup-1"],
      claim: "Player A is expected to start for Home.",
    },
  ]);
});

test("v3 rejects stale lineup evidence even when the model labels it correctly", () => {
  const v3Card = { ...card, lineup_research: "enabled" as const };
  const result = verifyGroundedResearchEvidence(
    v3LineupOutput(),
    v3Card,
    [
      document({
        requestedUrl: "https://club.example/lineup",
        finalUrl: "https://club.example/lineup",
        publishedAt: "2026-10-01T10:00:00Z",
        text: "Team update: Player A is expected to start for Home.",
      }),
    ],
    [
      {
        domain: "club.example",
        denied: false,
        tierByClaimType: { lineup: 1, default: 2 },
      },
    ],
  );

  assert.deepEqual(result.rejected, [
    { evidenceId: "lineup-1", reason: "stale_time_sensitive_claim" },
  ]);
});
