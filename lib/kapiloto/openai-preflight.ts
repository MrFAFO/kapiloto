import OpenAI from "openai";

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
