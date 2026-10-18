import OpenAI from "openai";

import researchOutputSchema from "@/docs/ai/kapiloto-research-output.schema.json";

import type { KapilotoFixtureCard } from "./fixture-card";
import {
  buildKapilotoFixtureResearchInput,
  KAPILOTO_SOL_SYSTEM_PROMPT,
} from "./research-prompt";
import {
  validateSolFixtureResearchOutput,
  type SolFixtureResearchOutput,
} from "./research-output";

export type KapilotoSolReasoningEffort = "low" | "medium" | "high";

export type SolResearchUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

export type SolFixtureResearchResult = {
  output: SolFixtureResearchOutput;
  provenance: {
    responseId: string;
    model: string;
    sourceUrls: string[];
    webSearchCalls: number;
    usage: SolResearchUsage;
  };
};

export type SolFixtureResearchOptions = {
  model: string;
  reasoningEffort?: KapilotoSolReasoningEffort;
  allowedDomains?: string[];
  maxOutputTokens?: number;
};

export class SolFixtureResearchError extends Error {
  constructor(
    message: string,
    readonly failureClass:
      | "model_refusal"
      | "model_output_invalid"
      | "provider_transient",
  ) {
    super(message);
    this.name = "SolFixtureResearchError";
  }
}

export function createOpenAIClient(apiKey = process.env.OPENAI_API_KEY): OpenAI {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required on the server.");
  }
  return new OpenAI({ apiKey });
}

function extractSourceUrls(response: unknown): string[] {
  if (!response || typeof response !== "object") return [];
  const output = (response as { output?: unknown[] }).output;
  if (!Array.isArray(output)) return [];

  const urls = new Set<string>();

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const typed = item as {
      type?: string;
      action?: {
        url?: string | null;
        sources?: Array<{ url?: string | null }>;
      };
    };

    if (typed.type !== "web_search_call") continue;

    if (typed.action?.url) urls.add(typed.action.url);
    for (const source of typed.action?.sources ?? []) {
      if (source.url) urls.add(source.url);
    }
  }

  return [...urls];
}

function countWebSearchCalls(response: unknown): number {
  if (!response || typeof response !== "object") return 0;
  const output = (response as { output?: unknown[] }).output;
  if (!Array.isArray(output)) return 0;
  return output.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as { type?: string }).type === "web_search_call",
  ).length;
}

function hasRefusal(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const output = (response as { output?: unknown[] }).output;
  if (!Array.isArray(output)) return false;

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    if (
      content.some(
        (part) =>
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "refusal",
      )
    ) {
      return true;
    }
  }

  return false;
}

function usageFromResponse(response: unknown): SolResearchUsage {
  const usage =
    response && typeof response === "object"
      ? (response as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
            output_tokens_details?: { reasoning_tokens?: number };
          };
        }).usage
      : undefined;

  return {
    inputTokens: usage?.input_tokens ?? null,
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
  };
}

export async function researchFixtureWithSol(
  client: OpenAI,
  card: KapilotoFixtureCard,
  options: SolFixtureResearchOptions,
): Promise<SolFixtureResearchResult> {
  try {
    const webSearchTool =
      options.allowedDomains && options.allowedDomains.length > 0
        ? {
            type: "web_search" as const,
            filters: {
              allowed_domains: options.allowedDomains.slice(0, 100),
            },
            search_context_size: "high" as const,
            user_location: { type: "approximate" as const },
          }
        : {
            type: "web_search" as const,
            search_context_size: "high" as const,
            user_location: { type: "approximate" as const },
          };

    const response = await client.responses.create({
      model: options.model,
      reasoning: {
        effort: options.reasoningEffort ?? "high",
      },
      tools: [webSearchTool],
      tool_choice: "auto",
      include: ["web_search_call.action.sources"],
      instructions: KAPILOTO_SOL_SYSTEM_PROMPT,
      input: buildKapilotoFixtureResearchInput(JSON.stringify(card)),
      text: {
        format: {
          type: "json_schema",
          name: "kapiloto_fixture_research_v1",
          description:
            "Grounded pre-match research output for one frozen Kapiloto fixture.",
          strict: true,
          schema: researchOutputSchema as Record<string, unknown>,
        },
      },
      max_output_tokens: options.maxOutputTokens ?? 8_000,
      store: false,
    });

    if (hasRefusal(response)) {
      throw new SolFixtureResearchError(
        "Sol refused the fixture research request.",
        "model_refusal",
      );
    }

    if (response.status !== "completed") {
      throw new SolFixtureResearchError(
        `Sol response did not complete: ${response.status}`,
        "provider_transient",
      );
    }

    if (!response.output_text) {
      throw new SolFixtureResearchError(
        "Sol response completed without structured output text.",
        "model_output_invalid",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.output_text);
    } catch {
      throw new SolFixtureResearchError(
        "Sol structured output could not be parsed as JSON.",
        "model_output_invalid",
      );
    }

    const sourceUrls = extractSourceUrls(response);
    const validated = validateSolFixtureResearchOutput(
      parsed,
      card,
      sourceUrls,
    );

    return {
      output: validated.output,
      provenance: {
        responseId: response.id,
        model: response.model,
        sourceUrls: validated.normalizedSourceUrls,
        webSearchCalls: countWebSearchCalls(response),
        usage: usageFromResponse(response),
      },
    };
  } catch (error) {
    if (error instanceof SolFixtureResearchError) throw error;

    throw new SolFixtureResearchError(
      error instanceof Error ? error.message : String(error),
      "provider_transient",
    );
  }
}

export const __testOnly = {
  extractSourceUrls,
  countWebSearchCalls,
  hasRefusal,
  usageFromResponse,
};
