import OpenAI from "openai";

import { callCost, type CallCost, type CallKind, type CostLedger, type RecordedUsage } from "./cost-ledger";

/**
 * Shared plumbing for the Research v2 model clients (discovery, entailment):
 * the minimal Responses interface they need (so tests inject recorded
 * payloads), response parsing and the explicit failure model. Nothing here
 * interprets claims.
 */

/** The only part of the OpenAI client the Research v2 model clients use. */
export type ResponsesClient = {
  responses: { create(params: Record<string, unknown>, options?: { maxRetries?: number; timeout?: number }): Promise<unknown> };
};

/** Real client from an API key (server-side only; never in the deterministic base runner). */
export function createResponsesClient(apiKey: string): ResponsesClient {
  return new OpenAI({ apiKey }) as unknown as ResponsesClient;
}

export type ModelCallFailure =
  | "spend_guard_blocked"
  | "unsafe_input"
  | "api_error"
  | "timeout"
  | "refusal"
  | "incomplete"
  | "malformed_output"
  | "schema_invalid"
  | "forecast_field_in_output"
  | "fixture_ref_mismatch"
  | "search_not_executed";

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function outputItems(response: unknown): Json[] {
  return asArray(asRecord(response)?.output).map(asRecord).filter((item): item is Json => item != null);
}

export type UrlCitation = { url: string; title: string | null; startIndex: number | null; endIndex: number | null };

/** The assistant message's text parts, refusals and inline URL citations. */
export function messageContent(response: unknown): { text: string | null; refusal: string | null; citations: UrlCitation[] } {
  const texts: string[] = [];
  const refusals: string[] = [];
  const citations: UrlCitation[] = [];
  for (const item of outputItems(response).filter((entry) => entry.type === "message")) {
    for (const part of asArray(item.content).map(asRecord)) {
      if (!part) continue;
      if (part.type === "refusal") refusals.push(asString(part.refusal) ?? "");
      if (part.type === "output_text") {
        texts.push(asString(part.text) ?? "");
        for (const annotation of asArray(part.annotations).map(asRecord)) {
          if (annotation?.type === "url_citation" && typeof annotation.url === "string") {
            citations.push({ url: annotation.url, title: asString(annotation.title), startIndex: asNumber(annotation.start_index), endIndex: asNumber(annotation.end_index) });
          }
        }
      }
    }
  }
  return { text: texts.length > 0 ? texts.join("") : null, refusal: refusals.length > 0 ? refusals.join(" ") : null, citations };
}

/** Usage exactly as reported; absent fields stay null (never zero). */
export function recordedUsage(response: unknown): RecordedUsage | null {
  const usage = asRecord(asRecord(response)?.usage);
  if (!usage) return null;
  const input = asRecord(usage.input_tokens_details);
  const output = asRecord(usage.output_tokens_details);
  return {
    inputTokens: asNumber(usage.input_tokens),
    cachedInputTokens: asNumber(input?.cached_tokens),
    outputTokens: asNumber(usage.output_tokens),
    reasoningTokens: asNumber(output?.reasoning_tokens),
    cacheWriteTokens: asNumber(input?.cache_write_tokens),
  };
}

export type ResponseMeta = { id: string | null; model: string | null; status: string | null; incompleteReason: string | null };

export function responseMeta(response: unknown): ResponseMeta {
  const record = asRecord(response);
  return {
    id: asString(record?.id),
    model: asString(record?.model),
    status: asString(record?.status),
    incompleteReason: asString(asRecord(record?.incomplete_details)?.reason),
  };
}

export type WebSearchCallRecord = {
  id: string | null;
  status: string | null;
  actionType: "search" | "open_page" | "find_in_page" | "unknown";
  queries: string[];
  sources: string[];
  url: string | null;
  pattern: string | null;
};

/** Every web_search_call item with its action, queries and sources as returned. */
export function webSearchCalls(response: unknown): WebSearchCallRecord[] {
  return outputItems(response)
    .filter((item) => item.type === "web_search_call")
    .map((item): WebSearchCallRecord => {
      const action = asRecord(item.action);
      const type = asString(action?.type);
      const queries = asArray(action?.queries).map(asString).filter((query): query is string => query != null);
      const legacyQuery = asString(action?.query);
      return {
        id: asString(item.id),
        status: asString(item.status),
        actionType: type === "search" || type === "open_page" || type === "find_in_page" ? type : "unknown",
        queries: queries.length > 0 ? queries : legacyQuery ? [legacyQuery] : [],
        sources: asArray(action?.sources).map(asRecord).map((source) => asString(source?.url)).filter((url): url is string => url != null),
        url: asString(action?.url),
        pattern: asString(action?.pattern),
      };
    });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Removes key-like fragments from provider error text before it is stored:
 * OpenAI-style keys (also masked ones such as `sk-proj-****abcd`), bearer and
 * basic credentials, key/token/secret assignments in URLs, headers or JSON,
 * and long opaque tokens (canonical UUIDs are kept).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_*.-]{3,}/g, "[redacted-key]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=*-]+/gi, "$1 [redacted]")
    .replace(/((?:api[_-]?key|api[_-]?token|access[_-]?token|apikey|token|secret|password|authorization|x-apisports-key)["']?\s*[=:]\s*["']?)[^\s&"',;}]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9][A-Za-z0-9_-]{31,}\b/g, (token) => (UUID.test(token) || !/\d/.test(token) ? token : "[redacted-token]"));
}

/**
 * Maps a thrown SDK/network error to an explicit failure. A timeout, a server
 * error or an error without a status may still have been processed and billed,
 * so its cost is unknown (charged at the projection); a 4xx rejection was not.
 * The detail is redacted before truncation, so no key fragment reaches the artifact.
 */
export function classifyCallError(error: unknown): { failure: "timeout" | "api_error"; detail: string; possiblyBilled: boolean; status: number | null } {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const timeout = name === "APIConnectionTimeoutError" || error instanceof OpenAI.APIConnectionTimeoutError || /timed? ?out/i.test(message);
  const status = asNumber(asRecord(error)?.status);
  const possiblyBilled = timeout || status == null || status >= 500;
  return { status, possiblyBilled, failure: timeout ? "timeout" : "api_error", detail: redactSecrets(`${name || "Error"}${status != null ? ` ${status}` : ""}: ${message}`).slice(0, 300) };
}

/** Parses the structured-output text; malformed JSON is a failure, never partially parsed. */
export function parseStructuredText(text: string | null): { ok: true; value: unknown } | { ok: false } {
  if (text == null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Records a call whose outcome (and so usage) is unknown, charged at its pre-call projection. */
export function unknownOutcomeCost(kind: CallKind, fixtureRef: string, model: string, startedAt: number, projectedMicros: number | null, ledger: CostLedger): CallCost {
  const cost = callCost({
    kind,
    fixtureRef,
    callId: `${kind}:${fixtureRef}:${startedAt}:unknown-outcome`,
    model,
    usage: null,
    billableWebSearchCalls: 0,
    projectedMicros: projectedMicros ?? 0,
    pricing: ledger.pricing,
  });
  ledger.recordCall(cost);
  return cost;
}
