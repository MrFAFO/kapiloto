import OpenAI from "openai";

import researchOutputSchema from "@/docs/ai/kapiloto-research-output.v3.schema.json";

export type KapilotoOpenAIPreflightResult = {
  responseId: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

export async function runKapilotoOpenAIPreflight(
  client: OpenAI,
  model: string,
): Promise<KapilotoOpenAIPreflightResult> {
  const response = await client.responses.create({
    model,
    reasoning: { effort: "low" },
    input:
      "Kapiloto runtime preflight. Reply with exactly the two letters OK and nothing else.",
    max_output_tokens: 128,
    store: false,
  });

  if (response.status !== "completed") {
    throw new Error(
      `OpenAI preflight did not complete: ${response.status}`,
    );
  }

  if (response.output_text.trim() !== "OK") {
    throw new Error("OpenAI preflight returned an unexpected response.");
  }

  return {
    responseId: response.id,
    model: response.model,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
  };
}

export type KapilotoResearchSchemaPreflightResult = {
  schemaAccepted: true;
  responseId: string;
  model: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

/**
 * Confirms the provider accepts the strict research output schema (including
 * its `pattern` length bounds) without running research: no tools, low
 * effort and a tiny output cap. An unsupported schema keyword is rejected
 * with HTTP 400 before generation, so an `incomplete` status still proves
 * acceptance. Run this after any schema change and before resuming workers.
 */
export async function runKapilotoResearchSchemaPreflight(
  client: OpenAI,
  model: string,
): Promise<KapilotoResearchSchemaPreflightResult> {
  const response = await client.responses.create(
    {
      model,
      reasoning: { effort: "low" },
      input:
        "Kapiloto schema preflight. Do not research. Return the smallest valid object.",
      text: {
        format: {
          type: "json_schema",
          name: "kapiloto_fixture_research_v3",
          strict: true,
          schema: researchOutputSchema as Record<string, unknown>,
        },
      },
      max_output_tokens: 64,
      store: false,
    },
    { maxRetries: 0, timeout: 45_000 },
  );

  return {
    schemaAccepted: true,
    responseId: response.id,
    model: response.model,
    status: String(response.status),
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
  };
}
