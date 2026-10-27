import assert from "node:assert/strict";
import test from "node:test";

import {
  EntailmentProviderError,
  EntailmentVerificationError,
  verifyRequiredEntailment,
  type EntailmentJudge,
  type FixtureGroundingForEntailment,
} from "./entailment-verifier";
import type { GroundingResult } from "./source-grounding";

function grounding(evidenceId = "e1"): GroundingResult {
  return {
    accepted: [
      {
        modelEvidenceId: evidenceId,
        canonicalUrl: "https://example.com/report",
        domain: "example.com",
        claimType: "availability",
        aboutTeam: "home",
        quote: "The player will miss Sunday's match.",
        claim: "The player is unavailable for the match.",
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
    requiresEntailmentVerification: [evidenceId],
  };
}

test("batches required evidence and marks supported claims", async () => {
  const calls: Array<Array<{ verificationId: string }>> = [];
  const judge: EntailmentJudge = {
    async verify(items) {
      calls.push(items);
      return {
        verdicts: items.map((item) => ({
          verificationId: item.verificationId,
          verdict: "supported" as const,
        })),
        provenance: {
          responseId: "resp-entailment",
          model: "sol-model",
        },
      };
    },
  };

  const fixtures: FixtureGroundingForEntailment[] = [
    { fixtureId: "fixture-1", grounding: grounding("e1") },
    { fixtureId: "fixture-2", grounding: grounding("e1") },
  ];

  const result = await verifyRequiredEntailment(fixtures, judge);

  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].map((item) => item.verificationId),
    ["fixture-1:e1", "fixture-2:e1"],
  );
  assert.equal(result.checkedEvidenceCount, 2);
  assert.equal(result.provenance.responseId, "resp-entailment");
  assert.equal(result.fixtures[0].grounding.accepted[0].entailment, "supported");
  assert.equal(result.fixtures[1].grounding.accepted[0].entailment, "supported");
  assert.deepEqual(
    result.fixtures[0].grounding.requiresEntailmentVerification,
    [],
  );
});

test("unsupported material claim is a structured downgrade result, not an error", async () => {
  const judge: EntailmentJudge = {
    async verify(items) {
      return {
        verdicts: items.map((item) => ({
          verificationId: item.verificationId,
          verdict:
            item.fixtureId === "fixture-2"
              ? ("unsupported" as const)
              : ("supported" as const),
        })),
        provenance: { responseId: "resp-1", model: "sol-model" },
      };
    },
  };

  const result = await verifyRequiredEntailment(
    [
      { fixtureId: "fixture-1", grounding: grounding("e1") },
      { fixtureId: "fixture-2", grounding: grounding("e1") },
    ],
    judge,
  );

  assert.deepEqual(result.downgradedFixtureIds, ["fixture-2"]);
  assert.equal(result.unsupported.length, 1);
  assert.equal(result.unsupported[0].evidenceId, "e1");
  assert.equal(result.unsupported[0].canonicalUrl, "https://example.com/report");
  assert.equal(result.fixtures[0].grounding.accepted[0].entailment, "supported");
  // The rejected claim is never marked supported.
  assert.equal(result.fixtures[1].grounding.accepted[0].entailment, "unsupported");
  assert.deepEqual(result.fixtures[1].grounding.requiresEntailmentVerification, []);
});

test("missing or duplicate judge verdicts are rejected", async () => {
  const missing: EntailmentJudge = {
    async verify() {
      return { verdicts: [] };
    },
  };

  await assert.rejects(
    () =>
      verifyRequiredEntailment(
        [{ fixtureId: "fixture-1", grounding: grounding() }],
        missing,
      ),
    /exactly one verdict/,
  );

  const duplicate: EntailmentJudge = {
    async verify(items) {
      return {
        verdicts: [
          {
            verificationId: items[0].verificationId,
            verdict: "supported" as const,
          },
          {
            verificationId: items[0].verificationId,
            verdict: "supported" as const,
          },
        ],
      };
    },
  };

  await assert.rejects(
    () =>
      verifyRequiredEntailment(
        [{ fixtureId: "fixture-1", grounding: grounding() }],
        duplicate,
      ),
    /duplicate verdict/,
  );
});

test("no pending material evidence skips the judge", async () => {
  let called = false;
  const judge: EntailmentJudge = {
    async verify() {
      called = true;
      return { verdicts: [] };
    },
  };

  const complete = grounding();
  complete.accepted[0].entailment = "supported";
  complete.requiresEntailmentVerification = [];

  const result = await verifyRequiredEntailment(
    [{ fixtureId: "fixture-1", grounding: complete }],
    judge,
  );

  assert.equal(called, false);
  assert.equal(result.checkedEvidenceCount, 0);
});

test("invalid judge output is an operational, retryable failure", async () => {
  const judge: EntailmentJudge = {
    async verify() {
      throw new EntailmentVerificationError(
        "Entailment model output was not valid JSON.",
        "invalid_judge_output",
        [{ responseId: "resp-bad", model: "sol", claims: 1, usage: null }],
      );
    },
  };

  await assert.rejects(
    () =>
      verifyRequiredEntailment(
        [{ fixtureId: "fixture-1", grounding: grounding() }],
        judge,
      ),
    (error: unknown) =>
      error instanceof EntailmentVerificationError &&
      error.code === "invalid_judge_output" &&
      error.retryable &&
      error.calls[0]?.responseId === "resp-bad",
  );
});

test("inconsistent grounding is terminal, not retryable", async () => {
  const broken = grounding("e1");
  broken.requiresEntailmentVerification = ["missing-evidence"];

  await assert.rejects(
    () =>
      verifyRequiredEntailment(
        [{ fixtureId: "fixture-1", grounding: broken }],
        {
          async verify() {
            throw new Error("judge must not run");
          },
        },
      ),
    (error: unknown) =>
      error instanceof EntailmentVerificationError &&
      error.code === "invalid_grounding" &&
      !error.retryable,
  );
});

test("large claim sets are chunked and keep every completed call on failure", async () => {
  const fixtures: FixtureGroundingForEntailment[] = Array.from(
    { length: 70 },
    (_, index) => ({
      fixtureId: `fixture-${index + 1}`,
      grounding: grounding("e1"),
    }),
  );
  let call = 0;
  const judge: EntailmentJudge = {
    async verify(items) {
      call += 1;
      const responseId = `resp-${call}`;
      if (call === 3) {
        throw new EntailmentProviderError(new Error("503 upstream"), []);
      }
      return {
        verdicts: items.map((item) => ({
          verificationId: item.verificationId,
          verdict: "supported" as const,
        })),
        provenance: {
          responseId,
          model: "sol",
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            reasoningTokens: 2,
            totalTokens: 15,
          },
        },
      };
    },
  };

  await assert.rejects(
    () => verifyRequiredEntailment(fixtures, judge),
    (error: unknown) =>
      error instanceof EntailmentProviderError &&
      error.calls.length === 2 &&
      error.calls.every((item) => item.claims === 32),
  );
  assert.equal(call, 3);
});
