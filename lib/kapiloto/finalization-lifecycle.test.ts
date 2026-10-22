import assert from "node:assert/strict";
import test from "node:test";

import OpenAI from "openai";

import {
  EntailmentProviderError,
  EntailmentVerificationError,
  type EntailmentJudge,
} from "./entailment-verifier";
import {
  classifyFinalizationError,
  finalizeKapilotoRunWithClaim,
  KapilotoFinalizationDataError,
  prepareKapilotoRunPublication,
  FinalizationClaimLostError,
} from "./run-finalizer";
import { materializeValidatedResearchRound } from "./run-materialization";
import {
  clearBackoff,
  countingJudge,
  createFinalizationDb,
  expireLeases,
  finalizableRun,
  finalizationAttempts,
  MemoryStore,
  PgliteFinalizationLedger,
  publishedAnalyses,
  RUN_ID,
  runRow,
} from "./test-support/pglite-finalization";

function options(workerId: string) {
  return { workerId, heartbeatIntervalMs: 0, leaseSeconds: 180 };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 1_000; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

function providerFailureJudge(): EntailmentJudge & { calls: number } {
  const judge = {
    calls: 0,
    async verify() {
      judge.calls += 1;
      throw new EntailmentProviderError(
        OpenAI.APIError.generate(503, undefined, "upstream unavailable", new Headers()),
        [],
      );
    },
  };
  return judge;
}

test("15 supported fixtures publish normally while one unsupported fixture is withheld", async () => {
  const db = await createFinalizationDb();
  const ledger = new PgliteFinalizationLedger(db);
  const judge = countingJudge(["fixture-7:e-7"]);

  const result = await finalizeKapilotoRunWithClaim(
    { ledger, store: new MemoryStore(finalizableRun()), judge },
    RUN_ID,
    options("worker-a"),
  );

  assert.equal(result.status, "published");
  if (result.status !== "published") throw new Error("expected publication");
  assert.deepEqual(result.downgradedFixtureIds, ["fixture-7"]);
  assert.equal(result.checkedEntailments, 16);

  const rows = await publishedAnalyses(db);
  assert.equal(rows.length, 16);
  const outcomes = new Map(rows.map((row) => [row.fixture_id, row.payload.outcome]));
  assert.equal(outcomes.get("fixture-7"), "insufficient_data");
  assert.equal(
    [...outcomes.values()].filter((outcome) => outcome === "analyzed").length,
    15,
  );

  const withheld = rows.find((row) => row.fixture_id === "fixture-7")!.payload as Record<
    string,
    unknown
  >;
  assert.equal(withheld.round_game_id, "game-7");
  assert.equal(withheld.primary_pick, null);
  assert.equal(withheld.suggested_double, null);
  assert.equal(withheld.p_final_1_bp, null);
  assert.equal(withheld.p_sol_1_bp, null);
  assert.equal(withheld.double_priority_rank, null);
  assert.equal(withheld.p_prior_1_bp, 4500, "frozen prior is preserved");
  assert.equal(withheld.kickoff_at_snapshot, "2026-10-21T18:00:00.000Z");
  assert.equal(withheld.summary, null);
  assert.deepEqual(withheld.key_assumptions, []);
  assert.deepEqual(withheld.factors, []);
  assert.ok(
    (withheld.reliability_reasons as string[]).includes("material_entailment_unsupported"),
  );
  const withheldEvidence = withheld.evidence as Array<Record<string, unknown>>;
  assert.equal(withheldEvidence[0].status, "rejected");
  assert.equal(withheldEvidence[0].rejected_reason, "entailment_unsupported");
  const audit = (withheld.inputs as Array<Record<string, unknown>>).find(
    (input) => input.input_type === "entailment_downgrade",
  );
  assert.ok(audit, "downgrade audit input is recorded");

  // No unsupported claim is ever published as accepted evidence.
  for (const row of rows) {
    for (const evidence of row.payload.evidence as Array<Record<string, unknown>>) {
      assert.equal(
        evidence.status === "accepted" && evidence.entailment === "unsupported",
        false,
      );
    }
  }

  const synthesis = await db.query<{ round_synthesis: { double_ranking: Array<{ fixture_id: string }> } }>(
    "select round_synthesis from public.kapiloto_research_runs where id = $1",
    [RUN_ID],
  );
  const ranking = synthesis.rows[0].round_synthesis.double_ranking;
  assert.equal(ranking.length, 15);
  assert.equal(ranking.some((item) => item.fixture_id === "fixture-7"), false);

  const run = await runRow(db);
  assert.equal(run.status, "completed");
  assert.equal(run.active_run_id, null);
  assert.equal(run.current_run_id, RUN_ID);

  const attempts = await finalizationAttempts(db);
  assert.equal(attempts.length, 1, "unsupported is not an operational retry");
  assert.equal(attempts[0].status, "succeeded");
  assert.equal(attempts[0].worker_id, "worker-a");
  assert.equal(attempts[0].checked_claims, 16);
  assert.equal(attempts[0].unsupported_claims, 1);
  assert.deepEqual(attempts[0].entailment_response_ids, ["entail-1"]);
  assert.equal(attempts[0].entailment_model, "sol-model");
  assert.equal(attempts[0].total_tokens, 1_200);
  assert.ok(attempts[0].finished_at);
});

test("two racing workers: exactly one claim, one entailment call and one publication", async () => {
  const db = await createFinalizationDb();
  const ledger = new PgliteFinalizationLedger(db);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const judge = countingJudge([], () => gate);
  const store = new MemoryStore(finalizableRun());

  const first = finalizeKapilotoRunWithClaim({ ledger, store, judge }, RUN_ID, options("worker-a"));
  await waitFor(() => judge.calls === 1);

  const second = await finalizeKapilotoRunWithClaim(
    { ledger, store, judge },
    RUN_ID,
    options("worker-b"),
  );
  assert.deepEqual(second, { status: "skipped", runId: RUN_ID, reason: "already_claimed" });

  release();
  const firstResult = await first;
  assert.equal(firstResult.status, "published");

  const third = await finalizeKapilotoRunWithClaim(
    { ledger, store, judge },
    RUN_ID,
    options("worker-c"),
  );
  assert.deepEqual(third, { status: "skipped", runId: RUN_ID, reason: "already_completed" });

  assert.equal(judge.calls, 1);
  assert.equal(ledger.publishCalls, 1);
  assert.equal(store.loads, 1);
  assert.equal((await publishedAnalyses(db)).length, 16);
  assert.equal((await finalizationAttempts(db)).length, 1);
});

test("a crashed finalizer's lease expires and another worker reclaims safely", async () => {
  const db = await createFinalizationDb();
  const ledger = new PgliteFinalizationLedger(db);
  const judge = countingJudge();
  const store = new MemoryStore(finalizableRun());

  const crashed = await ledger.claim(RUN_ID, "worker-a", 180);
  assert.equal(crashed.outcome, "claimed");

  const blocked = await finalizeKapilotoRunWithClaim({ ledger, store, judge }, RUN_ID, options("worker-b"));
  assert.deepEqual(blocked, { status: "skipped", runId: RUN_ID, reason: "already_claimed" });
  assert.equal(judge.calls, 0);

  await expireLeases(db);

  const recovered = await finalizeKapilotoRunWithClaim({ ledger, store, judge }, RUN_ID, options("worker-b"));
  assert.equal(recovered.status, "published");
  if (recovered.status === "published") assert.equal(recovered.attemptNo, 2);

  const attempts = await finalizationAttempts(db);
  assert.deepEqual(
    attempts.map((item) => [item.attempt_no, item.status, item.failure_code]),
    [
      [1, "abandoned", "lease_expired"],
      [2, "succeeded", null],
    ],
  );

  // The dead worker wakes up late: replay only, no duplicate analyses.
  if (crashed.outcome !== "claimed") throw new Error("expected claim");
  const prepared = await prepareKapilotoRunPublication(finalizableRun(), countingJudge());
  const late = await ledger.publish(crashed.attemptId, "worker-a", prepared.materialized, {});
  assert.equal(late.claimOutcome, "already_completed");
  assert.equal(late.replayed, true);
  assert.equal((await publishedAnalyses(db)).length, 16);
});

test("a stale owner is fenced out once another worker reclaims", async () => {
  const db = await createFinalizationDb();
  const ledger = new PgliteFinalizationLedger(db);

  const stale = await ledger.claim(RUN_ID, "worker-a", 180);
  await expireLeases(db);
  const fresh = await ledger.claim(RUN_ID, "worker-b", 180);
  assert.equal(fresh.outcome, "claimed");
  if (stale.outcome !== "claimed") throw new Error("expected claim");

  const prepared = await prepareKapilotoRunPublication(finalizableRun(), countingJudge());
  await assert.rejects(
    () => ledger.publish(stale.attemptId, "worker-a", prepared.materialized, {}),
    FinalizationClaimLostError,
  );
  assert.equal((await publishedAnalyses(db)).length, 0);
  assert.equal(await ledger.heartbeat(stale.attemptId, "worker-a", 180), false);
});

test("publish-then-crash: the next worker sees a completed run and duplicates nothing", async () => {
  const db = await createFinalizationDb();
  const ledger = new PgliteFinalizationLedger(db);
  const judge = countingJudge();
  const store = new MemoryStore(finalizableRun());

  const claim = await ledger.claim(RUN_ID, "worker-a", 180);
  if (claim.outcome !== "claimed") throw new Error("expected claim");
  const prepared = await prepareKapilotoRunPublication(finalizableRun(), judge);
  // Worker A commits publication and "dies" before any local bookkeeping.
  const published = await ledger.publish(claim.attemptId, "worker-a", prepared.materialized, {});
  assert.equal(published.claimOutcome, "published");

  const next = await finalizeKapilotoRunWithClaim({ ledger, store, judge }, RUN_ID, options("worker-b"));
  assert.deepEqual(next, { status: "skipped", runId: RUN_ID, reason: "already_completed" });

  const replay = await ledger.publish(claim.attemptId, "worker-a", prepared.materialized, {});
  assert.equal(replay.replayed, true);
  assert.equal(judge.calls, 1);
  assert.equal(store.loads, 0);
  assert.equal((await publishedAnalyses(db)).length, 16);
  assert.deepEqual(
    (await finalizationAttempts(db)).map((item) => item.status),
    ["succeeded"],
  );
});

test("repeated provider failures are bounded and end in an explicit terminal run failure", async () => {
  const db = await createFinalizationDb();
  const ledger = new PgliteFinalizationLedger(db);
  const judge = providerFailureJudge();
  const store = new MemoryStore(finalizableRun());

  const outcomes: string[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const result = await finalizeKapilotoRunWithClaim(
      { ledger, store, judge },
      RUN_ID,
      options(`worker-${index}`),
    );
    assert.equal(result.status, "failed");
    if (result.status !== "failed") throw new Error("expected failure");
    assert.equal(result.retryable, true);
    assert.equal(result.code, "entailment_openai_server_error");
    outcomes.push(result.ledgerOutcome);
    await clearBackoff(db);
  }
  assert.deepEqual(outcomes, ["retry_scheduled", "retry_scheduled", "run_failed"]);

  const run = await runRow(db);
  assert.equal(run.status, "failed");
  assert.equal(run.failure_class, "provider_transient");
  assert.equal(run.active_run_id, null, "the round is released");

  const afterTerminal = await finalizeKapilotoRunWithClaim(
    { ledger, store, judge },
    RUN_ID,
    options("worker-4"),
  );
  assert.deepEqual(afterTerminal, { status: "skipped", runId: RUN_ID, reason: "not_finalizable" });
  assert.equal(judge.calls, 3, "no infinite paid retry loop");
  assert.equal((await publishedAnalyses(db)).length, 0);
});

test("backoff blocks an immediate paid retry after an operational failure", async () => {
  const db = await createFinalizationDb();
  const ledger = new PgliteFinalizationLedger(db);
  const judge = providerFailureJudge();
  const store = new MemoryStore(finalizableRun());

  await finalizeKapilotoRunWithClaim({ ledger, store, judge }, RUN_ID, options("worker-a"));
  const second = await finalizeKapilotoRunWithClaim({ ledger, store, judge }, RUN_ID, options("worker-b"));

  assert.deepEqual(second, { status: "skipped", runId: RUN_ID, reason: "backoff" });
  assert.equal(judge.calls, 1);
});

test("invalid judge output is an operational retry, never a fixture downgrade", async () => {
  const db = await createFinalizationDb();
  const ledger = new PgliteFinalizationLedger(db);
  const judge: EntailmentJudge = {
    async verify() {
      throw new EntailmentVerificationError(
        "Entailment model output was not valid JSON.",
        "invalid_judge_output",
        [
          {
            responseId: "resp-bad",
            model: "sol-model",
            claims: 16,
            usage: {
              inputTokens: 900,
              cachedInputTokens: 0,
              outputTokens: 40,
              reasoningTokens: 30,
              totalTokens: 940,
            },
          },
        ],
      );
    },
  };

  const result = await finalizeKapilotoRunWithClaim(
    { ledger, store: new MemoryStore(finalizableRun()), judge },
    RUN_ID,
    options("worker-a"),
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failure");
  assert.equal(result.retryable, true);
  assert.equal(result.code, "entailment_invalid_judge_output");
  assert.equal(result.ledgerOutcome, "retry_scheduled");

  assert.equal((await runRow(db)).status, "running");
  assert.equal((await publishedAnalyses(db)).length, 0);
  const [attempt] = await finalizationAttempts(db);
  assert.equal(attempt.failure_class, "operational");
  assert.deepEqual(attempt.entailment_response_ids, ["resp-bad"], "paid usage is kept");
  assert.equal(attempt.total_tokens, 940);
  assert.equal(attempt.unsupported_claims, null);
});

test("a publication identity mismatch fails terminally and releases the round", async () => {
  const db = await createFinalizationDb();
  const ledger = new PgliteFinalizationLedger(db);
  const run = finalizableRun();
  // Internally consistent run whose fixture 16 differs from the frozen DB set.
  const last = run.fixtureSet[15];
  if (last.mode !== "research") throw new Error("expected research fixture");
  last.fixtureId = "fixture-99";
  last.card = { ...last.card, fixture_id: "fixture-99", fixture_key: "fixture-99" };
  run.attempts[15] = {
    ...run.attempts[15],
    fixtureId: "fixture-99",
    validatedOutput: { ...run.attempts[15].validatedOutput, fixture_key: "fixture-99" },
  };

  const result = await finalizeKapilotoRunWithClaim(
    { ledger, store: new MemoryStore(run), judge: countingJudge() },
    RUN_ID,
    options("worker-a"),
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failure");
  assert.equal(result.retryable, false);
  assert.equal(result.code, "publication_rejected");
  assert.equal(result.ledgerOutcome, "run_failed");

  const row = await runRow(db);
  assert.equal(row.status, "failed");
  assert.equal(row.failure_class, "internal");
  assert.equal(row.active_run_id, null);
  assert.equal((await publishedAnalyses(db)).length, 0);
});

test("repeated finalizer crashes are bounded and fail the run as worker_lost", async () => {
  const db = await createFinalizationDb();
  const ledger = new PgliteFinalizationLedger(db);

  for (let index = 1; index <= 3; index += 1) {
    const claim = await ledger.claim(RUN_ID, `worker-${index}`, 180);
    assert.equal(claim.outcome, "claimed");
    await expireLeases(db);
  }

  const exhausted = await ledger.claim(RUN_ID, "worker-4", 180);
  assert.equal(exhausted.outcome, "exhausted");

  const row = await runRow(db);
  assert.equal(row.status, "failed");
  assert.equal(row.failure_class, "worker_lost");
  assert.equal(row.active_run_id, null);
  assert.deepEqual(
    (await finalizationAttempts(db)).map((item) => item.status),
    ["abandoned", "abandoned", "abandoned"],
  );
});

test("the database refuses to claim runs that are not ready", async () => {
  const active = await createFinalizationDb({ activeAttempts: 1 });
  const activeClaim = await new PgliteFinalizationLedger(active).claim(RUN_ID, "worker-a", 180);
  assert.equal(activeClaim.outcome, "not_ready");
  assert.equal((await finalizationAttempts(active)).length, 0);

  const incomplete = await createFinalizationDb({ succeededTasks: 15 });
  const incompleteClaim = await new PgliteFinalizationLedger(incomplete).claim(RUN_ID, "worker-a", 180);
  if (incompleteClaim.outcome === "claimed") throw new Error("must not claim");
  assert.equal(incompleteClaim.outcome, "not_ready");
  assert.equal(incompleteClaim.detail.reason, "missing_succeeded_tasks:1");
  assert.equal((await finalizationAttempts(incomplete)).length, 0);
});

test("finalization error classification separates operational from terminal failures", () => {
  const cases: Array<[unknown, boolean, string]> = [
    [new EntailmentVerificationError("bad json", "invalid_judge_output"), true, "entailment_invalid_judge_output"],
    [new EntailmentVerificationError("cut off", "judge_incomplete"), true, "entailment_judge_incomplete"],
    [new EntailmentVerificationError("missing", "invalid_grounding"), false, "entailment_invalid_grounding"],
    [
      new EntailmentProviderError(OpenAI.APIError.generate(429, undefined, "slow", new Headers()), []),
      true,
      "entailment_openai_rate_limited",
    ],
    [
      new EntailmentProviderError(OpenAI.APIError.generate(400, undefined, "bad schema", new Headers()), []),
      false,
      "entailment_openai_bad_request",
    ],
    [new KapilotoFinalizationDataError("identity"), false, "finalization_data_invalid"],
    [new Error("Failed to load Kapiloto run: fetch failed"), true, "finalization_operational_error"],
    [
      new Error("Failed to publish: Kapiloto analysis payload does not match frozen fixture_set"),
      false,
      "publication_rejected",
    ],
  ];

  for (const [error, retryable, code] of cases) {
    const classified = classifyFinalizationError(error);
    assert.equal(classified.retryable, retryable, code);
    assert.equal(classified.code, code);
  }
});

test("an unsupported verdict always withholds the fixture, even without audit metadata", () => {
  const run = finalizableRun();
  const fixtures = run.fixtureSet.map((fixture, index) => {
    if (fixture.mode !== "research") throw new Error("expected research fixture");
    const grounding = structuredClone(run.attempts[index].grounding);
    grounding.requiresEntailmentVerification = [];
    grounding.accepted[0].entailment = index === 2 ? "unsupported" : "supported";
    return {
      gameNumber: fixture.gameNumber,
      roundGameId: fixture.roundGameId,
      fixtureId: fixture.fixtureId,
      card: fixture.card,
      output: run.attempts[index].validatedOutput,
      grounding,
    };
  });

  const round = materializeValidatedResearchRound(fixtures);
  const withheld = round.analyses[2];
  assert.equal(withheld.outcome, "insufficient_data");
  assert.equal(withheld.primary_pick, null);
  assert.equal(withheld.evidence[0].status, "rejected");
  assert.equal(round.synthesis.insufficient_data_fixtures, 1);
  assert.equal(round.synthesis.double_ranking.length, 15);
});

test("materialization keeps the exactly-16 and unique-identity guards", () => {
  const run = finalizableRun();
  const fixtures = run.fixtureSet.map((fixture, index) => {
    if (fixture.mode !== "research") throw new Error("expected research fixture");
    const grounding = structuredClone(run.attempts[index].grounding);
    grounding.requiresEntailmentVerification = [];
    grounding.accepted[0].entailment = "supported";
    return {
      gameNumber: fixture.gameNumber,
      roundGameId: fixture.roundGameId,
      fixtureId: fixture.fixtureId,
      card: fixture.card,
      output: run.attempts[index].validatedOutput,
      grounding,
    };
  });

  assert.throws(
    () => materializeValidatedResearchRound(fixtures.slice(0, 15)),
    /exactly 16 fixtures/,
  );

  const duplicated = [...fixtures.slice(0, 15), { ...fixtures[14] }];
  assert.throws(
    () => materializeValidatedResearchRound(duplicated),
    /duplicate or invalid fixture identity/,
  );
});

test("finalization is fenced to the round's current active run", async () => {
  const scenarios: Array<[string, string]> = [
    ["active run cleared", "update public.kapiloto_round_research_state set active_run_id = null"],
    [
      "another run is active",
      "update public.kapiloto_round_research_state set active_run_id = '33333333-3333-4333-8333-333333333333'",
    ],
    ["round state missing", "delete from public.kapiloto_round_research_state"],
  ];

  for (const [label, mutation] of scenarios) {
    const db = await createFinalizationDb();
    await db.exec(mutation);
    const ledger = new PgliteFinalizationLedger(db);
    const judge = countingJudge();
    const store = new MemoryStore(finalizableRun());

    const claim = await ledger.claim(RUN_ID, "worker-a", 180);
    if (claim.outcome === "claimed") throw new Error(`${label}: must not claim`);
    assert.equal(claim.outcome, "not_finalizable", label);
    assert.equal(claim.detail.reason, "not_active_run", label);

    const result = await finalizeKapilotoRunWithClaim(
      { ledger, store, judge },
      RUN_ID,
      options("worker-b"),
    );
    assert.deepEqual(result, { status: "skipped", runId: RUN_ID, reason: "not_finalizable" }, label);

    assert.equal(judge.calls, 0, `${label}: entailment never runs`);
    assert.equal(store.loads, 0, label);
    assert.equal((await finalizationAttempts(db)).length, 0, `${label}: no attempt consumed`);
    assert.equal((await runRow(db)).status, "running", `${label}: run is not failed`);
    assert.equal((await publishedAnalyses(db)).length, 0, label);
  }
});

test("an expired claim on a superseded run is left untouched, not consumed", async () => {
  const db = await createFinalizationDb();
  const ledger = new PgliteFinalizationLedger(db);
  assert.equal((await ledger.claim(RUN_ID, "worker-a", 180)).outcome, "claimed");
  await expireLeases(db);
  await db.exec("update public.kapiloto_round_research_state set active_run_id = null");

  const claim = await ledger.claim(RUN_ID, "worker-b", 180);
  if (claim.outcome === "claimed") throw new Error("must not claim");
  assert.equal(claim.detail.reason, "not_active_run");
  assert.deepEqual(
    (await finalizationAttempts(db)).map((item) => item.status),
    ["running"],
  );
});
