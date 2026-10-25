import { createHash } from "node:crypto";

import { findResultLikeKeys } from "./base";
import { callCost, type CallCost, type CostLedger, type RecordedUsage, type UsageStatus, usageStatus } from "./cost-ledger";
import { DISCOVERY_V2_OUTPUT_SCHEMA, parseDiscoveryOutputV2, type DiscoveryParseResult, type Side } from "./discovery-contract";
import { planSummary, type DiscoveryPlan } from "./discovery-plan";
import {
  classifyCallError,
  messageContent,
  parseStructuredText,
  recordedUsage,
  responseMeta,
  webSearchCalls,
  type ModelCallFailure,
  unknownOutcomeCost,
  type ResponsesClient,
  type UrlCitation,
  type WebSearchCallRecord,
} from "./model-call";
import { findForbiddenModelKeys, forecastLanguageFindings } from "./model-output-guards";
import { configProvenance, sha256Canonical, type ConfigProvenance, type VersionedConfig } from "./provenance";
import { CANDIDATE_SPEND_GUARD, checkSpend, type GuardDecision, type SpendGuardConfig } from "./spend-guard";

/**
 * Research v2 discovery client (discovery-request-v1, D-047): one Sol call
 * per fixture through the Responses API with only the built-in web_search
 * tool and strict Structured Outputs (discovery-v2). It records everything
 * the call did — web search actions, queries, sources, citations, usage — and
 * never interprets, verifies or adjusts a claim. Retries belong to the runner.
 */

export type DiscoveryRequestConfig = VersionedConfig & {
  /** Exact model id sent; the response's own model id is recorded separately. */
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  searchContextSize: "low" | "medium" | "high";
  timeoutMs: number;
};

export const CANDIDATE_DISCOVERY_REQUEST: DiscoveryRequestConfig = {
  id: "research-v2-discovery-request",
  version: "discovery-request-v1",
  status: "candidate",
  model: "gpt-6.1-sol",
  reasoningEffort: "medium",
  searchContextSize: "low",
  timeoutMs: 180_000,
};

export const DISCOVERY_INSTRUCTIONS_VERSION = "discovery-instructions-v1" as const;

export const DISCOVERY_INSTRUCTIONS = [
  "You research one football fixture for Kapiloto. Report verifiable factual claims only, for the listed information needs, using web search.",
  "Never state or imply a probability, odds, a predicted winner or score, a pick, a double, a betting tip, or how a fact changes anyone's chances. Do not judge importance, direction or size of an effect.",
  "Report only facts published before knowledge_cutoff_at. Every claim needs at least one citation with the exact URL you found and a verbatim quote copied from that page.",
  "Use only the claim kinds allowed for each need and only the sides in its scope. If a need yields nothing, mark it nothing_found. Do not research topics that are not listed (head-to-head, tactics, motivation, weather, form).",
  "Return only the JSON object defined by the schema, with fixture_ref copied exactly.",
].join("\n");

/** Typed allow-list: the only fields Sol ever receives. */
export type DiscoveryInputV1 = {
  input_version: "discovery-input-v1";
  fixture_ref: string;
  home: { name_en: string; source_names: string[] };
  away: { name_en: string; source_names: string[] };
  competition: string;
  kickoff_at: string;
  knowledge_cutoff_at: string;
  languages: string[];
  needs: Array<{ need_id: string; kind: string; scope: Side[]; allowed_claim_kinds: string[]; search_hints: string[] }>;
  budget: { target_search_actions: number; max_claims: number };
  known_facts: {
    rest_days: { home: number | null; away: number | null } | null;
    matches_last_14_days: { home: number | null; away: number | null } | null;
    structured_absences: Array<{ side: Side; player: string; status: string }>;
    new_to_competition: { home: boolean | null; away: boolean | null };
    stat_cold_start_sides: Side[];
  };
};

export function buildDiscoveryInput(input: {
  plan: DiscoveryPlan;
  names: { home: { en: string; source: string[] }; away: { en: string; source: string[] } };
  competition: string;
  kickoffAt: string;
  knowledgeCutoffAt: string;
  restDays: { home: number | null; away: number | null };
  matchesLast14Days: { home: number | null; away: number | null };
  structuredAbsences: Array<{ side: Side; player: string; status: string }>;
  newToCompetition: { home: boolean | null; away: boolean | null };
  statColdStartSides: Side[];
}): DiscoveryInputV1 {
  const congestion = input.plan.needs.some((need) => need.kind === "congestion_rotation");
  return {
    input_version: "discovery-input-v1",
    fixture_ref: input.plan.fixtureRef,
    home: { name_en: input.names.home.en, source_names: [...input.names.home.source] },
    away: { name_en: input.names.away.en, source_names: [...input.names.away.source] },
    competition: input.competition,
    kickoff_at: new Date(input.kickoffAt).toISOString(),
    knowledge_cutoff_at: new Date(input.knowledgeCutoffAt).toISOString(),
    languages: [...input.plan.languages],
    needs: input.plan.needs.map((need) => ({
      need_id: need.needId,
      kind: need.kind,
      scope: [...need.scope],
      allowed_claim_kinds: [...need.allowedClaimKinds],
      search_hints: [...need.searchHints],
    })),
    budget: { target_search_actions: input.plan.budget.targetSearchActions, max_claims: input.plan.budget.maxClaims },
    known_facts: {
      rest_days: congestion ? { ...input.restDays } : null,
      matches_last_14_days: congestion ? { ...input.matchesLast14Days } : null,
      structured_absences: input.structuredAbsences.map((absence) => ({ side: absence.side, player: absence.player, status: absence.status })),
      new_to_competition: { ...input.newToCompetition },
      stat_cold_start_sides: input.plan.needs.some((need) => need.kind === "stat_cold_start_context") ? [...input.statColdStartSides] : [],
    },
  };
}

/** Problems that make an input unsafe to send (result-like keys, forecast keys, forecast language in hints). */
export function discoveryInputProblems(input: DiscoveryInputV1): string[] {
  const problems = [...findResultLikeKeys(input, "input"), ...findForbiddenModelKeys(input, "input")];
  for (const need of input.needs) {
    for (const hint of need.search_hints) if (forecastLanguageFindings(hint).length > 0) problems.push(`input.needs.${need.need_id}.search_hints: forecast language`);
  }
  return problems;
}

const sha256Text = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export type DiscoveryRequestRecord = {
  model: string;
  toolChoice: "required";
  maxToolCalls: number;
  maxOutputTokens: number;
  searchContextSize: string;
  reasoningEffort: string;
  payloadSha256: string;
  schemaSha256: string;
  instructionsSha256: string;
  instructionsVersion: string;
  config: ConfigProvenance;
};

/** The exact Responses request body (pure; tests assert on it). */
export function buildDiscoveryRequest(input: DiscoveryInputV1, plan: DiscoveryPlan, config: DiscoveryRequestConfig = CANDIDATE_DISCOVERY_REQUEST) {
  const body: Record<string, unknown> = {
    model: config.model,
    instructions: DISCOVERY_INSTRUCTIONS,
    input: JSON.stringify(input),
    tools: [{ type: "web_search", search_context_size: config.searchContextSize }],
    tool_choice: "required",
    include: ["web_search_call.action.sources"],
    max_tool_calls: plan.budget.maxWebToolCalls,
    max_output_tokens: plan.budget.maxOutputTokens,
    reasoning: { effort: config.reasoningEffort },
    text: {
      format: {
        type: "json_schema",
        name: "kapiloto_research_v2_discovery",
        strict: true,
        schema: DISCOVERY_V2_OUTPUT_SCHEMA,
      },
    },
    store: false,
  };
  const record: DiscoveryRequestRecord = {
    model: config.model,
    toolChoice: "required",
    maxToolCalls: plan.budget.maxWebToolCalls,
    maxOutputTokens: plan.budget.maxOutputTokens,
    searchContextSize: config.searchContextSize,
    reasoningEffort: config.reasoningEffort,
    payloadSha256: sha256Canonical(input),
    schemaSha256: sha256Canonical(DISCOVERY_V2_OUTPUT_SCHEMA),
    instructionsSha256: sha256Text(DISCOVERY_INSTRUCTIONS),
    instructionsVersion: DISCOVERY_INSTRUCTIONS_VERSION,
    config: configProvenance(config),
  };
  return { body, record };
}

export type DiscoveryCallResult = {
  status: "ok" | "failed";
  failure: ModelCallFailure | "no_needs" | null;
  detail: string | null;
  guard: GuardDecision | null;
  request: DiscoveryRequestRecord | null;
  response: { id: string | null; model: string | null; status: string | null; incompleteReason: string | null; latencyMs: number; usage: RecordedUsage | null; usageStatus: UsageStatus } | null;
  webSearch: {
    calls: WebSearchCallRecord[];
    searchActions: number;
    openPageActions: number;
    findInPageActions: number;
    billableCalls: number;
    queries: string[];
    /** Every source URL the web_search tool returned in this call (the only basis for url_observed). */
    sources: string[];
  };
  citations: UrlCitation[];
  parse: DiscoveryParseResult | null;
  cost: CallCost | null;
};

const EMPTY_SEARCH: DiscoveryCallResult["webSearch"] = { calls: [], searchActions: 0, openPageActions: 0, findInPageActions: 0, billableCalls: 0, queries: [], sources: [] };

function summarizeSearch(calls: WebSearchCallRecord[]): DiscoveryCallResult["webSearch"] {
  return {
    calls,
    searchActions: calls.filter((call) => call.actionType === "search").length,
    openPageActions: calls.filter((call) => call.actionType === "open_page").length,
    findInPageActions: calls.filter((call) => call.actionType === "find_in_page").length,
    // Every recorded web_search_call is treated as billable unless reported otherwise.
    billableCalls: calls.length,
    queries: [...new Set(calls.flatMap((call) => call.queries))],
    sources: [...new Set(calls.flatMap((call) => call.sources))],
  };
}

/**
 * One discovery call: spend check, input guards, request, then strict
 * parsing. Never retries; never throws for model or network failures.
 */
export async function runDiscoveryCall(input: {
  client: ResponsesClient;
  discoveryInput: DiscoveryInputV1;
  plan: DiscoveryPlan;
  ledger: CostLedger;
  config?: DiscoveryRequestConfig;
  guardConfig?: SpendGuardConfig;
  now?: () => number;
}): Promise<DiscoveryCallResult> {
  const config = input.config ?? CANDIDATE_DISCOVERY_REQUEST;
  const guardConfig = input.guardConfig ?? CANDIDATE_SPEND_GUARD;
  const now = input.now ?? (() => Date.now());
  const base = { guard: null, request: null, response: null, webSearch: EMPTY_SEARCH, citations: [], parse: null, cost: null };
  const fail = (failure: DiscoveryCallResult["failure"], detail: string | null, extra: Partial<DiscoveryCallResult> = {}): DiscoveryCallResult => ({
    ...base,
    status: "failed",
    failure,
    detail,
    ...extra,
  });

  if (input.plan.needs.length === 0) return fail("no_needs", "the plan has no information needs; no call is made");
  if (input.discoveryInput.fixture_ref !== input.plan.fixtureRef) return fail("unsafe_input", "discovery input and plan disagree on fixture_ref");
  const problems = discoveryInputProblems(input.discoveryInput);
  if (problems.length > 0) return fail("unsafe_input", problems.join("; "));

  const projection = { kind: "discovery" as const, fixtureRef: input.plan.fixtureRef, maxToolCalls: input.plan.budget.maxWebToolCalls, maxOutputTokens: input.plan.budget.maxOutputTokens };
  const guard = checkSpend(projection, input.ledger, guardConfig);
  if (!guard.allowed) return fail("spend_guard_blocked", guard.reason, { guard });

  const { body, record } = buildDiscoveryRequest(input.discoveryInput, input.plan, config);
  const startedAt = now();
  let raw: unknown;
  try {
    raw = await input.client.responses.create(body, { maxRetries: 0, timeout: config.timeoutMs });
  } catch (error) {
    const classified = classifyCallError(error);
    const cost = classified.possiblyBilled ? unknownOutcomeCost("discovery", input.plan.fixtureRef, config.model, startedAt, guard.projectedMicros, input.ledger) : null;
    return fail(classified.failure, classified.detail, { guard, request: record, cost });
  }
  const latencyMs = now() - startedAt;

  const meta = responseMeta(raw);
  const usage = recordedUsage(raw);
  const webSearch = summarizeSearch(webSearchCalls(raw));
  const content = messageContent(raw);
  const cost = callCost({
    kind: "discovery",
    fixtureRef: input.plan.fixtureRef,
    callId: meta.id ?? `discovery:${input.plan.fixtureRef}:${startedAt}`,
    model: meta.model ?? config.model,
    usage,
    billableWebSearchCalls: webSearch.billableCalls,
    projectedMicros: guard.projectedMicros ?? 0,
    pricing: input.ledger.pricing,
  });
  input.ledger.recordCall(cost);
  const recorded = {
    guard,
    request: record,
    response: { ...meta, latencyMs, usage, usageStatus: usageStatus(usage) },
    webSearch,
    citations: content.citations,
    cost,
  };

  if (content.refusal != null) return fail("refusal", content.refusal.slice(0, 300), recorded);
  if (meta.status !== "completed") return fail("incomplete", meta.incompleteReason ?? meta.status ?? "unknown", recorded);
  const parsedText = parseStructuredText(content.text);
  if (!parsedText.ok) return fail("malformed_output", "structured output is not valid JSON", recorded);
  const parse = parseDiscoveryOutputV2(parsedText.value, planSummary(input.plan));
  if (parse.status === "rejected") {
    const failure = parse.reason === "forecast_field_in_output" ? "forecast_field_in_output" : parse.reason === "fixture_ref_mismatch" ? "fixture_ref_mismatch" : "schema_invalid";
    return fail(failure, parse.errors.slice(0, 5).join("; "), { ...recorded, parse });
  }
  if (webSearch.searchActions === 0) return fail("search_not_executed", "needs exist but no web search action was recorded", { ...recorded, parse });
  return { ...base, ...recorded, status: "ok", failure: null, detail: null, parse };
}

/** URLs that count as observed for verification: only the recorded web_search sources of this call. */
export function observedUrls(result: DiscoveryCallResult): string[] {
  return [...result.webSearch.sources];
}
