import assert from "node:assert/strict";
import test from "node:test";

import type { KapilotoFixtureCard } from "./fixture-card";
import {
  executeOneResearchTask,
  sanitizeOutputForGrounding,
  type ClaimedResearchAttempt,
  type FixtureEvidenceGrounder,
  type FixtureResearchRunner,
  type FinishResearchAttemptInput,
  type ResearchAttemptQueue,
} from "./research-task-executor";
import {
  SolFixtureResearchError,
  type SolFixtureResearchResult,
} from "./openai-research";
import { KAPILOTO_RESEARCH_DIMENSIONS } from "./research-output";
import { KAPILOTO_RESEARCH_PROTOCOL_VERSION } from "./research-config";

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

function claimed(): ClaimedResearchAttempt {
  return {
    attemptId: "attempt-1",
    runId: "run-1",
    roundId: "round-1",
    taskKey: "fixture:fixture-1",
    roundGameId: "game-1",
    attemptNo: 1,
    leaseExpiresAt: "2026-10-18T12:15:00Z",
    fixtureCard: card,
    run: {
      modelKey: "sol-model",
      researchProtocolVersion: KAPILOTO_RESEARCH_PROTOCOL_VERSION,
      promptTemplateSha256: "a".repeat(64),
      maxAttemptsPerTask: 3,
      executionTopology: "fixture_fanout",
      researchCutoffAt: card.research_cutoff_at,
    },
  };
}

function successResult(): SolFixtureResearchResult {
  return {
    output: {
      protocol_version: "kapiloto-research-v1",
      fixture_key: card.fixture_key,
      home_team_id: "home",
      away_team_id: "away",
      outcome: "analyzed",
      evidence: [],
      availability: [],
      factors: [],
      dimension_coverage: KAPILOTO_RESEARCH_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "no_material_signal",
      })),
      conflicts: [],
      p_sol: { home_bp: 4000, draw_bp: 3000, away_bp: 3000 },
      market_deviation: null,
      key_assumptions: [],
      main_risk: "None.",
      summary: "Balanced fixture.",
      watch_items: [],
      data_quality: {
        sparse_coverage: false,
        language_limited: false,
        notes: "Adequate.",
      },
      suspicious_content_observed: [],
      model_self_confidence: "medium",
    },
    provenance: {
      responseId: "resp-1",
      model: "sol-model",
      sourceUrls: ["https://example.com/news"],
      webSearchCalls: 2,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 50,
        reasoningTokens: 10,
        totalTokens: 150,
      },
    },
  };
}

class MemoryQueue implements ResearchAttemptQueue {
  claimValue: ClaimedResearchAttempt | null = claimed();
  heartbeatOwned = true;
  finishes: FinishResearchAttemptInput[] = [];

  async claim(): Promise<ClaimedResearchAttempt | null> {
    return this.claimValue;
  }

  async heartbeat(): Promise<boolean> {
    return this.heartbeatOwned;
  }

  async finish(input: FinishResearchAttemptInput) {
    this.finishes.push(input);
    return {
      retryCreated: input.retryable,
      nextAttemptId: input.retryable ? "attempt-2" : null,
    };
  }
}

test("returns no_work when the queue is empty", async () => {
  const queue = new MemoryQueue();
  queue.claimValue = null;

  const runner: FixtureResearchRunner = {
    async research() {
      throw new Error("must not run");
    },
  };

  assert.deepEqual(
    await executeOneResearchTask(queue, runner, {
      workerId: "worker-1",
      heartbeatIntervalMs: 0,
    }),
    { status: "no_work" },
  );
});

test("persists a successful Sol fixture attempt with provenance", async () => {
  const queue = new MemoryQueue();
  const runner: FixtureResearchRunner = {
    async research() {
      return successResult();
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-1",
    heartbeatIntervalMs: 0,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(queue.finishes.length, 1);
  assert.equal(queue.finishes[0].success, true);
  assert.equal(queue.finishes[0].providerResponseId, "resp-1");
  assert.equal(queue.finishes[0].sourcesCount, 1);
  assert.equal(
    queue.finishes[0].validationReport.quote_verification,
    "pending",
  );
});

test("transient/model-output failures create bounded retry requests", async () => {
  const queue = new MemoryQueue();
  const runner: FixtureResearchRunner = {
    async research() {
      throw new SolFixtureResearchError(
        "temporary provider problem",
        "provider_transient",
      );
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-1",
    heartbeatIntervalMs: 0,
  });

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failure");
  assert.equal(result.retryable, true);
  assert.equal(result.retryCreated, true);
  assert.equal(queue.finishes[0].retryable, true);
});

test("model refusal is terminal for this logical task", async () => {
  const queue = new MemoryQueue();
  const runner: FixtureResearchRunner = {
    async research() {
      throw new SolFixtureResearchError("refused", "model_refusal");
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-1",
    heartbeatIntervalMs: 0,
  });

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failure");
  assert.equal(result.retryable, false);
  assert.equal(queue.finishes[0].retryable, false);
});

test("lost lease discards a returned model result without finishing it", async () => {
  const queue = new MemoryQueue();
  queue.heartbeatOwned = false;

  const runner: FixtureResearchRunner = {
    async research() {
      return successResult();
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-1",
    heartbeatIntervalMs: 0,
  });

  assert.equal(result.status, "lease_lost");
  assert.equal(queue.finishes.length, 0);
});


test("grounder runs before a successful attempt is persisted", async () => {
  const queue = new MemoryQueue();
  const runner: FixtureResearchRunner = {
    async research() {
      return successResult();
    },
  };
  const grounder: FixtureEvidenceGrounder = {
    async ground() {
      return {
        grounding: {
          accepted: [],
          rejected: [],
          requiresEntailmentVerification: [],
        },
        retrievalFailures: [],
      };
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-1",
    heartbeatIntervalMs: 0,
    grounder,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(queue.finishes.length, 1);
  assert.equal(queue.finishes[0].success, true);
  assert.equal(
    queue.finishes[0].validationReport.quote_verification,
    "passed",
  );
  assert.equal(
    queue.finishes[0].validationReport.entailment_verification,
    "not_required",
  );
  assert.deepEqual(
    queue.finishes[0].validationReport.source_retrieval_failures,
    [],
  );
});

test("grounding sanitization drops unsupported items without sinking a supported recommendation", () => {
  const researched = successResult().output;
  researched.evidence = [
    {
      evidence_id: "e1",
      url: "https://example.com/accepted",
      quote: "Accepted",
      claim: "Supported form signal.",
      claim_type: "baseline_form",
      about_team: "home",
      event_time: null,
    },
    {
      evidence_id: "e2",
      url: "https://example.com/rejected",
      quote: "Rejected",
      claim: "Unsupported availability.",
      claim_type: "availability",
      about_team: "home",
      event_time: null,
    },
  ];
  researched.factors = [
    {
      dimension: "baseline_form",
      favors: "home",
      magnitude: "small",
      evidence_ids: ["e1"],
      rationale: "The supported form evidence modestly favors the home side.",
    },
  ];
  researched.availability = [
    {
      team: "home",
      player_name: "Player A",
      status: "out",
      role: "regular",
      certainty: "reported",
      evidence_ids: ["e2"],
    },
  ];

  const result = sanitizeOutputForGrounding(researched, {
    accepted: [
      {
        modelEvidenceId: "e1",
        canonicalUrl: "https://example.com/accepted",
        domain: "example.com",
        claimType: "baseline_form",
        aboutTeam: "home",
        quote: "Accepted",
        claim: "Supported form signal.",
        sourceEventTime: null,
        publishedAt: "2026-10-18T10:00:00Z",
        retrievedAt: "2026-10-18T11:00:00Z",
        trustTier: 2,
        quoteVerified: true,
        entailment: "not_checked",
        syndicationClusterId: null,
        contentSha256: "a".repeat(64),
      },
    ],
    rejected: [{ evidenceId: "e2", reason: "quote_not_found" }],
    requiresEntailmentVerification: [],
    policyFailures: ["availability:Player A has evidence that failed grounding."],
  });

  assert.equal(result.wholeFixtureDowngraded, false);
  assert.equal(result.output.outcome, "analyzed");
  assert.equal(result.output.factors.length, 1);
  assert.deepEqual(result.output.availability, []);
  assert.deepEqual(result.droppedItems, ["availability:Player A"]);
});

test("grounding policy failures are preserved for finalization instead of mutating the attempt output", async () => {
  const queue = new MemoryQueue();
  const runner: FixtureResearchRunner = {
    async research() {
      return successResult();
    },
  };
  const grounder: FixtureEvidenceGrounder = {
    async ground() {
      return {
        grounding: {
          accepted: [],
          rejected: [{ evidenceId: "e1", reason: "quote_not_found" }],
          requiresEntailmentVerification: [],
          policyFailures: [
            "availability:Player A has no evidence that passed grounding.",
          ],
        },
        retrievalFailures: [],
      };
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-1",
    heartbeatIntervalMs: 0,
    grounder,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(queue.finishes.length, 1);
  assert.equal(queue.finishes[0].success, true);
  const output = queue.finishes[0].validatedOutput as SolFixtureResearchResult["output"];
  assert.equal(output.outcome, "analyzed");
  assert.equal(queue.finishes[0].validationReport.grounding_policy_downgraded, false);
  assert.deepEqual(queue.finishes[0].validationReport.grounding_policy_failures, [
    "availability:Player A has no evidence that passed grounding.",
  ]);
  assert.deepEqual(
    queue.finishes[0].validationReport.raw_validated_output,
    output,
  );
});

test("grounding failure marks the attempt retryable and does not persist success", async () => {
  const queue = new MemoryQueue();
  const runner: FixtureResearchRunner = {
    async research() {
      return successResult();
    },
  };
  const grounder: FixtureEvidenceGrounder = {
    async ground() {
      throw new Error("quote verification failed");
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-1",
    heartbeatIntervalMs: 0,
    grounder,
  });

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failure");
  assert.equal(result.retryable, true);
  assert.equal(result.retryCreated, true);
  assert.equal(queue.finishes.length, 1);
  assert.equal(queue.finishes[0].success, false);
  assert.equal(queue.finishes[0].failureCode, "evidence_grounding_failed");
  assert.equal(
    queue.finishes[0].validationReport.quote_verification,
    "failed",
  );
});


test("accepts equivalent research cutoff instants with different timestamp formatting", async () => {
  const queue = new MemoryQueue();
  const value = claimed();
  value.run = {
    ...value.run,
    researchCutoffAt: "2026-10-18T14:00:00.000+02:00",
  };
  queue.claimValue = value;

  let calls = 0;
  const runner: FixtureResearchRunner = {
    async research() {
      calls += 1;
      return successResult();
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-cutoff-format",
    heartbeatIntervalMs: 0,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(calls, 1);
  assert.equal(queue.finishes[0].success, true);
});

test("rejects genuinely different research cutoff instants before model execution", async () => {
  const queue = new MemoryQueue();
  const value = claimed();
  value.run = {
    ...value.run,
    researchCutoffAt: "2026-10-18T12:00:01.000Z",
  };
  queue.claimValue = value;

  let calls = 0;
  const runner: FixtureResearchRunner = {
    async research() {
      calls += 1;
      return successResult();
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-cutoff-mismatch",
    heartbeatIntervalMs: 0,
  });

  assert.equal(result.status, "failed");
  assert.equal(calls, 0);
  assert.equal(queue.finishes.length, 1);
  assert.equal(queue.finishes[0].success, false);
  assert.match(
    queue.finishes[0].failureDetail ?? "",
    /cutoff does not match run cutoff/,
  );
});

test("refuses a frozen run from a different research protocol before the paid model call", async () => {
  const queue = new MemoryQueue();
  queue.claimValue = claimed();
  queue.claimValue.run.researchProtocolVersion = "kapiloto-research-v2";
  let called = false;
  const runner: FixtureResearchRunner = {
    async research() {
      called = true;
      return successResult();
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-protocol-guard",
    heartbeatIntervalMs: 0,
  });

  assert.equal(called, false);
  assert.equal(result.status, "failed");
  assert.equal(queue.finishes.length, 1);
  assert.equal(queue.finishes[0].failureCode, "research_protocol_mismatch");
  assert.equal(queue.finishes[0].retryable, false);
  assert.match(
    queue.finishes[0].failureDetail ?? "",
    /does not match worker protocol/,
  );
});
