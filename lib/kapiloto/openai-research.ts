import OpenAI from "openai";

import researchOutputSchema from "@/docs/ai/kapiloto-research-output.v3.schema.json";

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
export type KapilotoSearchContextSize = "low" | "medium" | "high";

/**
 * `max_output_tokens` caps reasoning tokens plus visible output. OpenAI
 * recommends reserving at least 25,000 tokens for reasoning models; the
 * worst-case serialized fixture output is roughly 38k characters
 * (about 10k-15k tokens). The earlier 8k/12k caps made `incomplete` a
 * near-certain outcome at high reasoning effort with web search.
 */
export const KAPILOTO_SOL_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

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
  searchContextSize?: KapilotoSearchContextSize;
  allowedDomains?: string[];
  maxOutputTokens?: number;
  /**
   * Hard wall-clock limit for the provider request. The worker derives it
   * from the remaining serverless budget so a slow call fails with a recorded
   * reason instead of being killed by the platform mid-flight.
   */
  timeoutMs?: number;
};

export type SolFailureClass =
  | "model_refusal"
  | "model_output_invalid"
  | "provider_transient"
  | "internal";

export type SolFailureProvenance = {
  responseId: string;
  model: string;
  sourceUrls: string[];
  webSearchCalls: number;
  usage: SolResearchUsage;
};

export type SolFailureDetails = {
  /** Stable machine-readable code persisted as the attempt failure_code. */
  code?: string;
  /** Whether another attempt can plausibly succeed. */
  retryable?: boolean;
  /** True when retrying the identical request shape is likely to fail again. */
  capacityLimited?: boolean;
};

function defaultFailureCode(failureClass: SolFailureClass): string {
  switch (failureClass) {
    case "model_refusal":
      return "sol_refusal";
    case "model_output_invalid":
      return "sol_output_invalid";
    case "internal":
      return "sol_internal_error";
    default:
      return "sol_provider_transient";
  }
}

export class SolFixtureResearchError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly capacityLimited: boolean;

  constructor(
    message: string,
    readonly failureClass: SolFailureClass,
    readonly provenance: SolFailureProvenance | null = null,
    details: SolFailureDetails = {},
  ) {
    super(message);
    this.name = "SolFixtureResearchError";
    this.code = details.code ?? defaultFailureCode(failureClass);
    this.retryable =
      details.retryable ??
      (failureClass === "provider_transient" ||
        failureClass === "model_output_invalid");
    this.capacityLimited = details.capacityLimited ?? false;
  }
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/**
 * Maps OpenAI SDK/transport errors to attempt failure semantics. Client
 * errors (bad schema, auth, unknown model) are configuration problems that a
 * retry cannot fix, so they fail fast instead of burning every task attempt.
 */
export function classifyOpenAICallError(
  error: unknown,
): SolFixtureResearchError {
  if (error instanceof SolFixtureResearchError) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (
    error instanceof OpenAI.APIConnectionTimeoutError ||
    error instanceof OpenAI.APIUserAbortError
  ) {
    return new SolFixtureResearchError(
      `Sol request exceeded its execution deadline: ${message}`,
      "provider_transient",
      null,
      { code: "sol_deadline_exceeded", retryable: true, capacityLimited: true },
    );
  }

  const status = errorStatus(error);
  if (status === 429) {
    return new SolFixtureResearchError(message, "provider_transient", null, {
      code: "openai_rate_limited",
    });
  }
  if (status != null && status >= 500) {
    return new SolFixtureResearchError(message, "provider_transient", null, {
      code: "openai_server_error",
    });
  }
  if (status === 408 || status === 409) {
    return new SolFixtureResearchError(message, "provider_transient", null, {
      code: "openai_retryable_client_error",
    });
  }
  if (status != null && status >= 400) {
    return new SolFixtureResearchError(
      `OpenAI rejected the research request (HTTP ${status}): ${message}`,
      "internal",
      null,
      {
        code:
          status === 400 || status === 422
            ? "openai_bad_request"
            : "openai_configuration_error",
        retryable: false,
      },
    );
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new SolFixtureResearchError(message, "provider_transient", null, {
      code: "openai_connection_error",
    });
  }

  return new SolFixtureResearchError(message, "provider_transient", null, {
    code: "sol_unknown_error",
  });
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

function incompleteReason(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const details = (response as {
    incomplete_details?: { reason?: unknown } | null;
  }).incomplete_details;
  return details && typeof details.reason === "string"
    ? details.reason
    : null;
}

export function usageFromResponse(response: unknown): SolResearchUsage {
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

function failureProvenance(response: {
  id: string;
  model: string;
} & Record<string, unknown>): SolFailureProvenance {
  const sourceUrls = extractSourceUrls(response);
  return {
    responseId: response.id,
    model: response.model,
    sourceUrls,
    webSearchCalls: countWebSearchCalls(response),
    usage: usageFromResponse(response),
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
            search_context_size: options.searchContextSize ?? "high",
            user_location: { type: "approximate" as const },
          }
        : {
            type: "web_search" as const,
            search_context_size: options.searchContextSize ?? "high",
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
          name: "kapiloto_fixture_research_v3",
          description:
            "Grounded pre-match research output for one frozen Kapiloto fixture.",
          strict: true,
          schema: researchOutputSchema as Record<string, unknown>,
        },
      },
      max_output_tokens:
        options.maxOutputTokens ?? KAPILOTO_SOL_DEFAULT_MAX_OUTPUT_TOKENS,
      store: false,
    }, {
      // Attempt-level retries live in the database queue. SDK retries would
      // silently repeat a multi-minute paid request inside one serverless
      // invocation and push it past the platform execution ceiling.
      maxRetries: 0,
      ...(options.timeoutMs != null ? { timeout: options.timeoutMs } : {}),
    });

    if (hasRefusal(response)) {
      throw new SolFixtureResearchError(
        "Sol refused the fixture research request.",
        "model_refusal",
        failureProvenance(response as typeof response & Record<string, unknown>),
        { code: "sol_refusal", retryable: false },
      );
    }

    if (response.status !== "completed") {
      const reason = incompleteReason(response);
      const provenance = failureProvenance(
        response as typeof response & Record<string, unknown>,
      );
      const message = `Sol response did not complete: ${response.status}${reason ? ` (${reason})` : ""}`;

      if (reason === "content_filter") {
        throw new SolFixtureResearchError(message, "model_refusal", provenance, {
          code: "sol_incomplete:content_filter",
          retryable: false,
        });
      }

      throw new SolFixtureResearchError(message, "provider_transient", provenance, {
        code: `sol_incomplete:${reason ?? "unknown"}`,
        retryable: true,
        // Exhausting the output budget repeats for the same request shape;
        // the executor changes the shape before the next attempt.
        capacityLimited: reason === "max_output_tokens" || reason == null,
      });
    }

    if (!response.output_text) {
      throw new SolFixtureResearchError(
        "Sol response completed without structured output text.",
        "model_output_invalid",
        failureProvenance(response as typeof response & Record<string, unknown>),
        { code: "sol_output_empty" },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.output_text);
    } catch {
      throw new SolFixtureResearchError(
        "Sol structured output could not be parsed as JSON.",
        "model_output_invalid",
        failureProvenance(response as typeof response & Record<string, unknown>),
        { code: "sol_output_unparseable" },
      );
    }

    const sourceUrls = extractSourceUrls(response);
    let validated;
    try {
      validated = validateSolFixtureResearchOutput(
        parsed,
        card,
        sourceUrls,
      );
    } catch (error) {
      throw new SolFixtureResearchError(
        `Sol structured output failed semantic validation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "model_output_invalid",
        failureProvenance(response as typeof response & Record<string, unknown>),
        { code: "sol_semantic_validation_failed" },
      );
    }

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
    throw classifyOpenAICallError(error);
  }
}

export const __testOnly = {
  extractSourceUrls,
  countWebSearchCalls,
  hasRefusal,
  usageFromResponse,
  incompleteReason,
  failureProvenance,
};
