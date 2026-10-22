import assert from "node:assert/strict";
import test from "node:test";

import type { EntailmentJudge } from "./entailment-verifier";
import type { KapilotoFixtureCard } from "./fixture-card";
import { KAPILOTO_RESEARCH_DIMENSIONS } from "./research-output";
import type { SolFixtureResearchOutput } from "./research-output";
import {
  finalizeKapilotoRun,
  type FinalizableResearchRun,
  type KapilotoRunFinalizationStore,
  type KapilotoRunPublicationSink,
} from "./run-finalizer";
import {
  materializeValidatedResearchRound,
  type MaterializedRound,
} from "./run-materialization";
import type { GroundingResult } from "./source-grounding";

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
      home: { id: `home-${gameNumber}`, names: ["Home"] },
      away: { id: `away-${gameNumber}`, names: ["Away"] },
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
        snapshot_id: `market-${gameNumber}`,
        captured_at: "2026-10-20T09:55:00.000Z",
        p_home_bp: 4500,
        p_draw_bp: 3000,
        p_away_bp: 2500,
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
        evidence_id: `e-${gameNumber}`,
        url: "https://example.com/report",
        quote: "The home side has won four of its last five league matches.",
        claim: "The home side has strong recent league form.",
        claim_type: "baseline_form",
        about_team: "home",
        event_time: null,
      },
    ],
    availability: [],
    factors: [
      {
        dimension: "baseline_form",
        favors: "home",
        magnitude: "small",
        evidence_ids: [`e-${gameNumber}`],
        rationale: "Verified recent form favors the home side.",
      },
    ],
    dimension_coverage: KAPILOTO_RESEARCH_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "no_material_signal" as const,
    })),
    conflicts: [],
    p_sol: { home_bp: 4600, draw_bp: 3000, away_bp: 2400 },
    market_deviation: null,
    key_assumptions: [],
    main_risk: "Late news.",
    summary: "Grounded test summary.",
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

function grounding(gameNumber: number, needsEntailment = false): GroundingResult {
  const evidenceId = `e-${gameNumber}`;
  return {
    accepted: [
      {
        modelEvidenceId: evidenceId,
        canonicalUrl: "https://example.com/report",
        domain: "example.com",
        claimType: "baseline_form",
        aboutTeam: "home",
        quote: "The home side has won four of its last five league matches.",
        claim: "The home side has strong recent league form.",
        sourceEventTime: null,
        publishedAt: "2026-10-20T08:00:00.000Z",
        retrievedAt: "2026-10-20T09:00:00.000Z",
        trustTier: 2,
        quoteVerified: true,
        entailment: needsEntailment ? "not_checked" : "supported",
        syndicationClusterId: null,
        contentSha256: "abc123",
      },
    ],
    rejected: [],
    requiresEntailmentVerification: needsEntailment ? [evidenceId] : [],
  };
}

function finalizableRun(needsEntailment = false): FinalizableResearchRun {
  const fixtureSet = Array.from({ length: 16 }, (_, index) => {
    const gameNumber = index + 1;
    return {
      gameNumber,
      roundGameId: `game-${gameNumber}`,
      fixtureId: `fixture-${gameNumber}`,
      mode: "research" as const,
      taskKey: `fixture:fixture-${gameNumber}`,
      card: card(gameNumber),
    };
  });

  return {
    runId: "run-1",
    roundId: "round-1",
    status: "running",
    researchCutoffAt: "2026-10-20T10:00:00.000Z",
    fixtureSet,
    attempts: fixtureSet.map((fixture) => ({
      roundGameId: fixture.roundGameId,
      fixtureId: fixture.fixtureId,
      validatedOutput: output(fixture.gameNumber),
      grounding: grounding(fixture.gameNumber, needsEntailment),
    })),
    carriedSources: [],
  };
}

class MemoryStore implements KapilotoRunFinalizationStore {
  constructor(readonly run: FinalizableResearchRun) {}
  async load() {
    return this.run;
  }
}

class MemoryPublisher implements KapilotoRunPublicationSink {
  published = 0;
  lastAnalysisCount = 0;
  lastOutcomes: string[] = [];
  last: MaterializedRound | null = null;

  async publish(runId: string, materialized: MaterializedRound) {
    this.published += 1;
    this.last = materialized;
    this.lastAnalysisCount = materialized.analyses.length;
    this.lastOutcomes = materialized.analyses.map((analysis) => analysis.outcome);
    return {
      runId,
      roundId: "round-1",
      status: "completed" as const,
      analysisCount: materialized.analyses.length,
      publishedFixtureCount: materialized.analyses.length,
      replayed: false,
    };
  }
}

test("finalizes a complete grounded 16-fixture run", async () => {
  const publisher = new MemoryPublisher();
  const judge: EntailmentJudge = {
    async verify() {
      throw new Error("judge should not run without pending entailments");
    },
  };

  const result = await finalizeKapilotoRun(
    new MemoryStore(finalizableRun(false)),
    publisher,
    judge,
    "run-1",
  );

  assert.equal(result.analysisCount, 16);
  assert.equal(result.publishedFixtureCount, 16);
  assert.equal(result.checkedEntailments, 0);
  assert.equal(publisher.published, 1);
  assert.equal(publisher.lastAnalysisCount, 16);
});

test("finalizer performs one batched entailment pass before publication", async () => {
  const publisher = new MemoryPublisher();
  let calls = 0;
  const judge: EntailmentJudge = {
    async verify(items) {
      calls += 1;
      return {
        verdicts: items.map((item) => ({
          verificationId: item.verificationId,
          verdict: "supported" as const,
        })),
        provenance: { responseId: "entail-1", model: "sol-model" },
      };
    },
  };

  const result = await finalizeKapilotoRun(
    new MemoryStore(finalizableRun(true)),
    publisher,
    judge,
    "run-1",
  );

  assert.equal(calls, 1);
  assert.equal(result.checkedEntailments, 16);
  assert.equal(result.publishedFixtureCount, 16);
});

test("incomplete succeeded-attempt set is never published", async () => {
  const run = finalizableRun(false);
  run.attempts.pop();
  const publisher = new MemoryPublisher();
  const judge: EntailmentJudge = {
    async verify() {
      return { verdicts: [] };
    },
  };

  await assert.rejects(
    () =>
      finalizeKapilotoRun(
        new MemoryStore(run),
        publisher,
        judge,
        "run-1",
      ),
    /15\/16 succeeded research tasks/,
  );

  assert.equal(publisher.published, 0);
});

test("unsupported directional evidence invalidates p_sol for only that fixture; the round still publishes", async () => {
  const publisher = new MemoryPublisher();
  const judge: EntailmentJudge = {
    async verify(items) {
      return {
        verdicts: items.map((item) => ({
          verificationId: item.verificationId,
          verdict:
            item.verificationId === "fixture-1:e-1"
              ? ("unsupported" as const)
              : ("supported" as const),
        })),
      };
    },
  };

  const result = await finalizeKapilotoRun(
    new MemoryStore(finalizableRun(true)),
    publisher,
    judge,
    "run-1",
  );

  assert.equal(publisher.published, 1);
  assert.equal(result.analysisCount, 16);
  assert.deepEqual(result.downgradedFixtureIds, ["fixture-1"]);
  assert.equal(publisher.lastOutcomes[0], "analyzed");
  assert.deepEqual(
    publisher.lastOutcomes.slice(1),
    Array.from({ length: 15 }, () => "analyzed"),
  );

  const withheld = publisher.last!.analyses[0];
  assert.equal(withheld.blend_weight, 0);
  assert.equal(withheld.p_sol_1_bp, null);
  assert.equal(withheld.p_final_1_bp, withheld.p_prior_1_bp);
  assert.equal(withheld.double_priority_rank, null);
  assert.equal(withheld.evidence[0].status, "rejected");
  assert.equal(withheld.evidence[0].entailment, "unsupported");
  assert.equal(
    withheld.reliability_reasons.includes("p_sol_invalidated:baseline_form"),
    true,
  );
  assert.equal(
    publisher.last!.synthesis.double_ranking.some(
      (item) => item.fixture_id === "fixture-1",
    ),
    false,
  );
});


test("mixed run publishes researched, carried-forward and unavailable fixtures together", async () => {
  const run = finalizableRun(false);
  const sourceRound = materializeValidatedResearchRound(
    Array.from({ length: 16 }, (_, index) => {
      const gameNumber = index + 1;
      return {
        gameNumber,
        roundGameId: `game-${gameNumber}`,
        fixtureId: `fixture-${gameNumber}`,
        card: card(gameNumber),
        output: output(gameNumber),
        grounding: grounding(gameNumber),
      };
    }),
  );
  const source = sourceRound.analyses[14];

  run.fixtureSet[14] = {
    gameNumber: 15,
    roundGameId: "game-15",
    fixtureId: "fixture-15",
    mode: "carried_forward",
    carriedFromAnalysisId: "analysis-old-15",
    reason: "missing_prior",
    context: {
      kickoffAt: "2026-10-21T18:00:00.000Z",
      settlementRule: "result_after_90_minutes_including_stoppage_time",
      neutralVenue: false,
    },
  };
  run.fixtureSet[15] = {
    gameNumber: 16,
    roundGameId: "game-16",
    fixtureId: "fixture-16",
    mode: "research_unavailable",
    reason: "missing_prior",
    context: {
      kickoffAt: "2026-10-21T18:00:00.000Z",
      settlementRule: "result_after_90_minutes_including_stoppage_time",
      neutralVenue: false,
    },
  };
  run.attempts = run.attempts.slice(0, 14);
  run.carriedSources = [
    {
      analysisId: "analysis-old-15",
      analysis: source,
    },
  ];

  const publisher = new MemoryPublisher();
  const judge: EntailmentJudge = {
    async verify() {
      throw new Error("judge should not run without pending entailments");
    },
  };

  const result = await finalizeKapilotoRun(
    new MemoryStore(run),
    publisher,
    judge,
    "run-1",
  );

  assert.equal(result.analysisCount, 16);
  assert.equal(result.publishedFixtureCount, 16);
  assert.equal(publisher.lastOutcomes[14], "carried_forward");
  assert.equal(publisher.lastOutcomes[15], "research_unavailable");
});
