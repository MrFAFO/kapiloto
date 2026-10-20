import OpenAI from "openai";

import type { GroundingResult } from "./source-grounding";

export type EntailmentVerdict = {
  evidenceId: string;
  verdict: "supported" | "unsupported";
};

export interface EntailmentJudge {
  verify(
    items: Array<{
      fixtureId: string;
      evidenceId: string;
      claim: string;
      quote: string;
      domain: string;
    }>,
  ): Promise<{
    verdicts: EntailmentVerdict[];
    provenance?: {
      responseId?: string | null;
      model?: string | null;
    };
  }>;
}

export type FixtureGroundingForEntailment = {
  fixtureId: string;
  grounding: GroundingResult;
};

export type EntailmentVerificationBatchResult = {
  fixtures: FixtureGroundingForEntailment[];
  checkedEvidenceCount: number;
  provenance: {
    responseId: string | null;
    model: string | null;
  };
};

export class EntailmentVerificationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unsupported_claim"
      | "invalid_judge_output"
      | "too_many_claims",
  ) {
    super(message);
    this.name = "EntailmentVerificationError";
  }
}

function pendingItems(
  fixtures: FixtureGroundingForEntailment[],
): Array<{
  fixtureId: string;
  evidenceId: string;
  claim: string;
  quote: string;
  domain: string;
}> {
  const pending: Array<{
    fixtureId: string;
    evidenceId: string;
    claim: string;
    quote: string;
    domain: string;
  }> = [];
  const seen = new Set<string>();

  for (const fixture of fixtures) {
    for (const evidenceId of fixture.grounding.requiresEntailmentVerification) {
      const evidence = fixture.grounding.accepted.find(
        (item) => item.modelEvidenceId === evidenceId,
      );

      if (!evidence) {
        throw new EntailmentVerificationError(
          `Fixture ${fixture.fixtureId} requires missing grounded evidence ${evidenceId}.`,
          "invalid_judge_output",
        );
      }

      const key = `${fixture.fixtureId}:${evidenceId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      pending.push({
        fixtureId: fixture.fixtureId,
        evidenceId,
        claim: evidence.claim,
        quote: evidence.quote,
        domain: evidence.domain,
      });
    }
  }

  return pending;
}

export async function verifyRequiredEntailment(
  fixtures: FixtureGroundingForEntailment[],
  judge: EntailmentJudge,
): Promise<EntailmentVerificationBatchResult> {
  const pending = pendingItems(fixtures);

  if (pending.length === 0) {
    return {
      fixtures,
      checkedEvidenceCount: 0,
      provenance: { responseId: null, model: null },
    };
  }

  if (pending.length > 128) {
    throw new EntailmentVerificationError(
      `Entailment batch exceeds the 128-claim safety limit: ${pending.length}.`,
      "too_many_claims",
    );
  }

  const judged = await judge.verify(pending);
  const verdictByKey = new Map<string, EntailmentVerdict["verdict"]>();

  for (const verdict of judged.verdicts) {
    const matches = pending.filter(
      (item) => item.evidenceId === verdict.evidenceId,
    );

    if (matches.length !== 1) {
      throw new EntailmentVerificationError(
        `Entailment judge returned ambiguous or unknown evidence id ${verdict.evidenceId}.`,
        "invalid_judge_output",
      );
    }

    const key = `${matches[0].fixtureId}:${verdict.evidenceId}`;
    if (verdictByKey.has(key)) {
      throw new EntailmentVerificationError(
        `Entailment judge returned duplicate verdict for ${verdict.evidenceId}.`,
        "invalid_judge_output",
      );
    }
    verdictByKey.set(key, verdict.verdict);
  }

  if (verdictByKey.size !== pending.length) {
    throw new EntailmentVerificationError(
      "Entailment judge did not return exactly one verdict for every required evidence item.",
      "invalid_judge_output",
    );
  }

  for (const item of pending) {
    const verdict = verdictByKey.get(
      `${item.fixtureId}:${item.evidenceId}`,
    );

    if (verdict !== "supported") {
      throw new EntailmentVerificationError(
        `Material claim is not entailed by its grounded quote: ${item.evidenceId}.`,
        "unsupported_claim",
      );
    }
  }

  const updatedFixtures = fixtures.map((fixture) => {
    const required = new Set(
      fixture.grounding.requiresEntailmentVerification,
    );

    return {
      fixtureId: fixture.fixtureId,
      grounding: {
        ...fixture.grounding,
        accepted: fixture.grounding.accepted.map((evidence) =>
          required.has(evidence.modelEvidenceId)
            ? { ...evidence, entailment: "supported" as const }
            : evidence,
        ),
        requiresEntailmentVerification: [],
      },
    };
  });

  return {
    fixtures: updatedFixtures,
    checkedEvidenceCount: pending.length,
    provenance: {
      responseId: judged.provenance?.responseId ?? null,
      model: judged.provenance?.model ?? null,
    },
  };
}

type OpenAIEntailmentJudgeOptions = {
  model: string;
  reasoningEffort?: "low" | "medium" | "high";
  maxOutputTokens?: number;
};

export function createOpenAIEntailmentJudge(
  client: OpenAI,
  options: OpenAIEntailmentJudgeOptions,
): EntailmentJudge {
  return {
    async verify(items) {
      if (items.length === 0) {
        return {
          verdicts: [],
          provenance: { responseId: null, model: options.model },
        };
      }

      const response = await client.responses.create({
        model: options.model,
        reasoning: {
          effort: options.reasoningEffort ?? "medium",
        },
        instructions: [
          "You are a strict evidence-entailment verifier.",
          "For each item, decide only whether the quoted text directly supports the stated claim.",
          "Do not use outside knowledge, assumptions, or the source domain as evidence.",
          "Return supported only when the quote itself is sufficient for the claim as written.",
          "Return unsupported when the quote is weaker, ambiguous, contradictory, or merely related.",
        ].join(" "),
        input: JSON.stringify(
          items.map((item) => ({
            evidence_id: item.evidenceId,
            claim: item.claim,
            quote: item.quote,
          })),
        ),
        text: {
          format: {
            type: "json_schema",
            name: "kapiloto_entailment_batch_v1",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                verdicts: {
                  type: "array",
                  minItems: items.length,
                  maxItems: items.length,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      evidence_id: { type: "string" },
                      verdict: {
                        type: "string",
                        enum: ["supported", "unsupported"],
                      },
                    },
                    required: ["evidence_id", "verdict"],
                  },
                },
              },
              required: ["verdicts"],
            },
          },
        },
        max_output_tokens: options.maxOutputTokens ?? 4_000,
        store: false,
      });

      if (response.status !== "completed" || !response.output_text) {
        throw new EntailmentVerificationError(
          `Entailment model did not complete successfully: ${response.status}.`,
          "invalid_judge_output",
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.output_text);
      } catch {
        throw new EntailmentVerificationError(
          "Entailment model output was not valid JSON.",
          "invalid_judge_output",
        );
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new EntailmentVerificationError(
          "Entailment model output had an invalid shape.",
          "invalid_judge_output",
        );
      }

      const rawVerdicts = (parsed as { verdicts?: unknown }).verdicts;
      if (!Array.isArray(rawVerdicts)) {
        throw new EntailmentVerificationError(
          "Entailment model output omitted verdicts.",
          "invalid_judge_output",
        );
      }

      const verdicts: EntailmentVerdict[] = rawVerdicts.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          throw new EntailmentVerificationError(
            "Entailment verdict row had an invalid shape.",
            "invalid_judge_output",
          );
        }

        const evidenceId = (row as { evidence_id?: unknown }).evidence_id;
        const verdict = (row as { verdict?: unknown }).verdict;

        if (
          typeof evidenceId !== "string" ||
          (verdict !== "supported" && verdict !== "unsupported")
        ) {
          throw new EntailmentVerificationError(
            "Entailment verdict row contained invalid values.",
            "invalid_judge_output",
          );
        }

        return { evidenceId, verdict };
      });

      return {
        verdicts,
        provenance: {
          responseId: response.id,
          model: response.model,
        },
      };
    },
  };
}
