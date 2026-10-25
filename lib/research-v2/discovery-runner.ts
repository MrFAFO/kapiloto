import { CANDIDATE_ADJUSTMENT_POLICY, CANDIDATE_EFFECT_SIZES } from "./adjustments";
import { CANDIDATE_PRICING, CostLedger } from "./cost-ledger";
import { buildDiscoveryInput, CANDIDATE_DISCOVERY_REQUEST, runDiscoveryCall, type DiscoveryCallResult } from "./discovery-client";
import {
  baseAgeGate,
  configProvenanceOf,
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  DISCOVERY_RUNNER_VERSION,
  eligibilityRecord,
  fixtureRefOf,
  judgeCandidates,
  planFromSnapshot,
  sealDiscoveryArtifact,
  snapshotFromBase,
  successfulAttempt,
  verifyRecord,
  type DiscoveryArtifact,
  type DiscoveryRuntime,
  type FixtureResearchRecord,
  type ResearchConfigs,
  type RetryPolicyConfig,
  type SearchNames,
  type StoredDiscoveryAttempt,
  type StoredEntailment,
  type StoredFetch,
  type StoredFetchPolicy,
} from "./discovery-artifact";
import { CANDIDATE_DISCOVERY_BUDGET, CANDIDATE_DISCOVERY_PLAN_CONFIG } from "./discovery-plan";
import { DOCUMENT_DATES_CONFIG, extractDocumentDates } from "./document-dates";
import { CANDIDATE_ENTAILMENT_REQUEST, runEntailmentCall, type EntailmentCallResult, type EntailmentItem } from "./entailment-client";
import { buildCitationEvidence, EVIDENCE_WINDOW_CONFIG, sha256Text } from "./evidence-window";
import { extractByline, extractHtml } from "./html-extract";
import { CANDIDATE_IMPACT_RULES } from "./impact-rules";
import type { LiveDevArtifact } from "./live-dev-runner";
import type { ResponsesClient } from "./model-call";
import { RESEARCH_V2_ENGINE_VERSION } from "./provenance";
import { CANDIDATE_TIMING_MARGIN } from "./research-timing";
import { FETCHER_CONFIG, safeFetch, type FetcherConfig, type FetchFailure, type SafeFetchResult } from "./safe-fetch";
import { CANDIDATE_DEDUP, CANDIDATE_SOURCE_QUALITY } from "./source-quality";
import { SOURCE_REGISTRY_SEED } from "./source-registry";
import { CANDIDATE_SOURCE_POLICY } from "./sources";
import { CANDIDATE_SPEND_GUARD } from "./spend-guard";
import { canonicalEvidenceUrl, CANDIDATE_VERIFICATION_V2, citationIdOf, type CitationCaptureV2, type StoredDocumentV2 } from "./verification";

/**
 * Research v2 discovery runner (D-047): the capture side. It executes the
 * approved stages in order — base freshness, eligibility, planner, spend
 * guard, Sol discovery (one runner-owned retry), safe fetch of observed URLs,
 * evidence cutoff and second eligibility, deterministic prechecks, spend
 * guard, the judge — records everything, and seals the artifact whose
 * deterministic half (claims, market revalidation, adjustments) is computed
 * by `discovery-artifact.ts`. It never mutates the base, never writes to a
 * database and produces no recommendation, pick or double.
 */

export const CANDIDATE_RETRY_POLICY: RetryPolicyConfig = {
  id: "research-v2-retry-policy",
  version: "retry-policy-v1",
  status: "candidate",
  maxRetries: 1,
  retryableFailures: ["timeout", "api_error", "malformed_output", "schema_invalid", "incomplete", "search_not_executed"],
  retryableApiErrors: "server_or_unknown",
};

/** Candidate configuration of a research run; every value versioned and candidate. */
export const CANDIDATE_RESEARCH_CONFIGS: ResearchConfigs = {
  freshness: { id: "research-v2-base-freshness", version: "research-base-freshness-v1", status: "candidate", maxBaseAgeMinutes: 15 },
  minLeadMinutes: 60,
  retry: CANDIDATE_RETRY_POLICY,
  plan: CANDIDATE_DISCOVERY_PLAN_CONFIG,
  budget: CANDIDATE_DISCOVERY_BUDGET,
  discoveryRequest: CANDIDATE_DISCOVERY_REQUEST,
  entailmentRequest: CANDIDATE_ENTAILMENT_REQUEST,
  verification: CANDIDATE_VERIFICATION_V2,
  sourceQuality: CANDIDATE_SOURCE_QUALITY,
  dates: DOCUMENT_DATES_CONFIG,
  evidenceWindow: EVIDENCE_WINDOW_CONFIG,
  fetcher: FETCHER_CONFIG,
  dedup: CANDIDATE_DEDUP,
  sourcePolicy: CANDIDATE_SOURCE_POLICY,
  registry: SOURCE_REGISTRY_SEED,
  impactRules: CANDIDATE_IMPACT_RULES,
  adjustmentPolicy: CANDIDATE_ADJUSTMENT_POLICY,
  timingMargin: CANDIDATE_TIMING_MARGIN,
  effects: CANDIDATE_EFFECT_SIZES,
  pricing: CANDIDATE_PRICING,
  spendGuard: CANDIDATE_SPEND_GUARD,
};

/** Whether a failed discovery attempt may be retried once (retry-policy-v1). */
export function retryDecision(result: DiscoveryCallResult, policy: RetryPolicyConfig): { retryable: boolean; reason: string } | null {
  if (result.status === "ok") return null;
  const failure = result.failure ?? "unknown";
  if (!policy.retryableFailures.includes(failure)) return { retryable: false, reason: `not_retryable:${failure}` };
  if (failure === "api_error" && result.errorStatus != null && result.errorStatus >= 400 && result.errorStatus < 500) {
    return { retryable: false, reason: `not_retryable:api_error_${result.errorStatus}` };
  }
  return { retryable: true, reason: `retryable:${failure}` };
}

/** External access the runner needs, injected so tests and replay never touch the network. */
export type ResearchDeps = {
  now(): Date;
  /** Current status and kickoff of a fixture (read-only). */
  loadFixtureStatus(fixtureId: string): Promise<{ status: string; kickoffAt: string }>;
  responsesClient: ResponsesClient;
  /** Must be the SSRF-safe fetcher (default) or a test double. */
  fetchPage?: (url: string) => Promise<SafeFetchResult>;
};

const stripDiscovery = (result: DiscoveryCallResult): StoredDiscoveryAttempt["result"] => {
  if (!result.response) return { ...result, response: null };
  const { latencyMs: _latency, ...response } = result.response;
  return { ...result, response };
};
const stripEntailment = (result: EntailmentCallResult, skipped: StoredEntailment["skipped"] = null): StoredEntailment => {
  if (!result.response) return { ...result, response: null, skipped };
  const { latencyMs: _latency, ...response } = result.response;
  return { ...result, response, skipped };
};

/** Failure detail that is part of the policy outcome; addresses and transport error text are dropped (runtime keeps them). */
const POLICY_DETAIL: Partial<Record<FetchFailure, RegExp>> = {
  invalid_url: /^[^\s]{1,200}$/,
  http_status: /^\d{3}$/,
  redirect_without_location: /^\d{3}$/,
  too_many_redirects: /^\d+$/,
  unsupported_content_type: /^[\w.+-]+\/[\w.+-]+$/,
  unsupported_encoding: /^[\w.+-]+$/,
  response_too_large: /^(> \d+ bytes|content-length \d+)$/,
};

export function policyDetail(reason: FetchFailure, detail: string | null): string | null {
  return detail != null && POLICY_DETAIL[reason]?.test(detail) ? detail : null;
}

function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol.replace(/:$/, "");
  } catch {
    return null;
  }
}

/** The deterministic fetch-security outcome of one attempted fetch (hashed). */
export function fetchPolicyRecord(canonicalUrl: string, result: SafeFetchResult, fetcher: FetcherConfig): StoredFetchPolicy {
  // safeFetch records one decision per hop, and a redirect only after its hop was allowed.
  const hops = result.decisions.map((decision, index) => ({
    url: decision.url,
    scheme: schemeOf(decision.url),
    host: decision.host,
    allowed: decision.allowed,
    reason: decision.reason,
    redirect: result.redirects[index] ? { to: result.redirects[index].to, status: result.redirects[index].status } : null,
  }));
  return {
    policy: { id: fetcher.id, version: fetcher.version },
    requestedUrl: result.requestedUrl,
    canonicalUrl,
    allowed: hops.length > 0 && hops.every((hop) => hop.allowed),
    reason: result.ok ? null : result.reason,
    reasonDetail: result.ok ? null : policyDetail(result.reason, result.detail),
    hops,
    finalUrl: result.ok ? result.finalUrl : null,
    response: result.responseChecks,
    outcome: result.ok ? "fetched" : "failed",
  };
}

function documentFrom(canonicalUrl: string, result: SafeFetchResult): { document: StoredDocumentV2; text: string | null } {
  if (!result.ok) {
    return { document: { requestedUrl: canonicalUrl, fetch: { ok: false, reason: result.reason, detail: policyDetail(result.reason, result.detail) }, documentTextSha256: null, dates: null, byline: null }, text: null };
  }
  const extracted = result.contentType === "text/plain" ? null : extractHtml(result.body);
  const text = extracted ? extracted.text : result.body.replace(/\s+/g, " ").trim();
  return {
    text,
    document: {
      requestedUrl: canonicalUrl,
      fetch: { ok: true, finalUrl: result.finalUrl, status: result.status, contentType: result.contentType, bytes: result.bytes, bodySha256: result.bodySha256, retrievedAt: result.retrievedAt },
      documentTextSha256: sha256Text(text),
      dates: extracted ? extractDocumentDates(extracted) : { published: null, modified: null, allCandidates: [] },
      byline: extracted ? extractByline(extracted) : null,
    },
  };
}

type FixtureRuntime = DiscoveryRuntime["fixtures"][number];

/** All research stages for one fixture; returns the record (hashed) and runtime diagnostics (not hashed). */
export async function researchFixture(input: {
  base: LiveDevArtifact;
  fixtureId: string;
  searchNames: SearchNames;
  deps: ResearchDeps;
  ledger: CostLedger;
  configs?: ResearchConfigs;
}): Promise<{ record: FixtureResearchRecord; runtime: FixtureRuntime }> {
  const configs = input.configs ?? CANDIDATE_RESEARCH_CONFIGS;
  const { deps, ledger } = input;
  const fetchPage = deps.fetchPage ?? ((url: string) => safeFetch(url, { config: configs.fetcher }));
  const nowIso = () => deps.now().toISOString();
  const nowMs = () => deps.now().getTime();
  const snapshot = snapshotFromBase(input.base, input.fixtureId);
  const fixtureRef = fixtureRefOf(snapshot);
  const record: FixtureResearchRecord = {
    fixtureRef,
    fixtureId: input.fixtureId,
    gameNumber: snapshot.fixtureInput.identity.gameNumber,
    snapshot,
    searchNames: input.searchNames,
    timestamps: { baseCutoffAt: snapshot.baseCutoffAt, researchStartedAt: null, knowledgeCutoffAt: null, evidenceCutoffAt: null, forecastFinalizedAt: null },
    gates: { preliminary: null, final: null },
    eligibility: { e1: null, retry: null, e2: null },
    plan: null,
    discoveryInput: null,
    attempts: [],
    fetches: [],
    citations: [],
    entailment: null,
    stoppedAt: null,
  };
  const runtime: FixtureRuntime = { fixtureRef, attemptLatenciesMs: [], entailmentLatencyMs: null, fetchDiagnostics: [] };
  const stop = (reason: FixtureResearchRecord["stoppedAt"]) => {
    record.stoppedAt = reason;
    record.timestamps.forecastFinalizedAt = nowIso();
    return { record, runtime };
  };

  // 0. The base fixture must have been researchable (eligible, with arms and triage).
  if (!snapshot.fixtureOutput.arms || !snapshot.fixtureOutput.triage) return stop("base_fixture_not_researchable");
  // 1. Base freshness (cheap check before any read), then eligibility #1 and the final gate at research start.
  record.gates.preliminary = baseAgeGate(snapshot.baseCutoffAt, nowIso(), configs.freshness);
  if (!record.gates.preliminary.fresh) return stop("fresh_base_required");
  const status1 = await deps.loadFixtureStatus(input.fixtureId);
  const researchStartedAt = nowIso();
  record.gates.final = baseAgeGate(snapshot.baseCutoffAt, researchStartedAt, configs.freshness);
  if (!record.gates.final.fresh) return stop("fresh_base_required");
  record.eligibility.e1 = eligibilityRecord(snapshot, status1, researchStartedAt, configs.minLeadMinutes);
  if (!record.eligibility.e1.eligible) return stop("e1_ineligible");
  // 3. The knowledge cutoff is fixed here and never moves.
  record.timestamps.researchStartedAt = researchStartedAt;
  record.timestamps.knowledgeCutoffAt = researchStartedAt;

  // 4. Deterministic planner and the allow-listed discovery input.
  const plan = planFromSnapshot(snapshot, input.searchNames, configs);
  record.plan = plan;
  if (!plan || plan.needs.length === 0) return stop("no_needs");
  const triage = snapshot.fixtureOutput.triage;
  const discoveryInput = buildDiscoveryInput({
    plan,
    names: input.searchNames,
    competition: snapshot.fixtureInput.identity.competitionName,
    kickoffAt: snapshot.fixtureInput.identity.kickoffAt,
    knowledgeCutoffAt: researchStartedAt,
    restDays: snapshot.fixtureInput.triageContext.restDays,
    matchesLast14Days: snapshot.fixtureInput.triageContext.matchesLast14Days,
    structuredAbsences: [],
    newToCompetition: snapshot.fixtureOutput.membership?.newToCompetitionThisSeason ?? { home: null, away: null },
    statColdStartSides: (["home", "away"] as const).filter((side) => triage.statColdStart[side] === true),
  });
  record.discoveryInput = discoveryInput;

  // 5–7. Spend guard + Sol discovery, with at most one runner-owned retry (same input, same cutoff, same budget).
  const call = () => runDiscoveryCall({ client: deps.responsesClient, discoveryInput, plan, ledger, config: configs.discoveryRequest, guardConfig: configs.spendGuard, now: nowMs });
  let attempt = await call();
  runtime.attemptLatenciesMs.push(attempt.response?.latencyMs ?? 0);
  let decision = retryDecision(attempt, configs.retry);
  record.attempts.push({ attempt: 1, result: stripDiscovery(attempt), retry: decision });
  if (attempt.failure === "spend_guard_blocked") return stop("spend_guard_blocked");
  for (let retries = 0; decision?.retryable && retries < configs.retry.maxRetries; retries += 1) {
    const status = await deps.loadFixtureStatus(input.fixtureId);
    record.eligibility.retry = eligibilityRecord(snapshot, status, nowIso(), configs.minLeadMinutes);
    if (!record.eligibility.retry.eligible) break;
    attempt = await call();
    runtime.attemptLatenciesMs.push(attempt.response?.latencyMs ?? 0);
    decision = retryDecision(attempt, configs.retry);
    record.attempts.push({ attempt: record.attempts.length + 1, result: stripDiscovery(attempt), retry: decision });
  }
  const success = successfulAttempt(record);
  if (!success) return stop("discovery_failed");

  // 8. Safe fetch of cited URLs that appear in this call's recorded web-search sources only.
  const parse = success.result.parse;
  const claims = parse && parse.status === "accepted" ? parse.claims.filter((entry) => entry.status === "admitted").map((entry) => entry.claim).sort((a, b) => a.claim_id.localeCompare(b.claim_id)) : [];
  const sources = new Set(success.result.webSearch.sources.map(canonicalEvidenceUrl));
  const ordered: string[] = [];
  for (const claim of claims) {
    for (const citation of claim.citations) {
      const canonical = canonicalEvidenceUrl(citation.url);
      if (sources.has(canonical) && !ordered.includes(canonical)) ordered.push(canonical);
    }
  }
  const texts = new Map<string, string>();
  for (const [order, canonicalUrl] of ordered.entries()) {
    if (order >= plan.budget.maxFetchedPages) {
      record.fetches.push({ order, canonicalUrl, outcome: "skipped_budget", policy: null, document: null, redirects: [] });
      continue;
    }
    const fetchStarted = performance.now();
    const result = await fetchPage(canonicalUrl);
    const latencyMs = Math.round(performance.now() - fetchStarted);
    if (result.ok) ledger.recordFetch(fixtureRef, result.bytes);
    const { document, text } = documentFrom(canonicalUrl, result);
    if (text != null) texts.set(canonicalUrl, text);
    record.fetches.push({ order, canonicalUrl, outcome: result.ok ? "fetched" : "failed", policy: fetchPolicyRecord(canonicalUrl, result, configs.fetcher), document, redirects: result.redirects });
    runtime.fetchDiagnostics.push({ canonicalUrl, latencyMs, hops: result.decisions.map((decision) => ({ url: decision.url, addresses: decision.addresses })), rawDetail: result.ok ? null : result.detail });
  }
  // Evidence windows; full article text exists only in this function's memory.
  record.citations = claims.flatMap((claim) =>
    claim.citations.map((citation, citationIndex): CitationCaptureV2 => {
      const text = texts.get(canonicalEvidenceUrl(citation.url));
      return { claimId: claim.claim_id, citationIndex, url: citation.url, quote: citation.quote, evidence: text == null ? null : buildCitationEvidence(text, citation.quote, configs.evidenceWindow) };
    }),
  );
  texts.clear();

  // 9–10. Evidence cutoff and eligibility #2.
  record.timestamps.evidenceCutoffAt = nowIso();
  const status2 = await deps.loadFixtureStatus(input.fixtureId);
  record.eligibility.e2 = eligibilityRecord(snapshot, status2, record.timestamps.evidenceCutoffAt, configs.minLeadMinutes);

  // 11–13. Deterministic prechecks; only surviving forecast-changing citations reach the judge.
  if (!record.eligibility.e2.eligible) {
    record.entailment = { status: "failed", failure: "no_items", detail: "crossed_min_lead", guard: null, request: null, response: null, items: [], unknownItemIds: [], cost: null, skipped: "crossed_min_lead" };
  } else {
    const prechecks = verifyRecord(record, configs, {});
    const candidates = judgeCandidates(prechecks);
    if (candidates.length === 0) {
      record.entailment = { status: "failed", failure: "no_items", detail: "no citation passed every precheck", guard: null, request: null, response: null, items: [], unknownItemIds: [], cost: null, skipped: "no_surviving_items" };
    } else {
      const byId = new Map(claims.map((claim) => [claim.claim_id, claim]));
      const items: EntailmentItem[] = candidates.map((citationId) => {
        const capture = record.citations.find((citation) => citationIdOf(citation.claimId, citation.citationIndex) === citationId) as CitationCaptureV2;
        return { itemId: citationId, claim: byId.get(capture.claimId) as (typeof claims)[number], window: capture.evidence!.window! };
      });
      const judged = await runEntailmentCall({
        client: deps.responsesClient,
        fixtureRef,
        items,
        maxJudgeItems: plan.budget.maxJudgeItems,
        ledger,
        config: configs.entailmentRequest,
        guardConfig: configs.spendGuard,
        now: nowMs,
      });
      runtime.entailmentLatencyMs = judged.response?.latencyMs ?? null;
      record.entailment = stripEntailment(judged);
    }
  }
  // 14–19 are deterministic and run in finalizeFixtureResearch (also on replay); 20: finalized.
  record.timestamps.forecastFinalizedAt = nowIso();
  return { record, runtime };
}

/** One research run over the given fixtures of a base artifact, sharing one cost ledger (run cap). */
export async function runDiscoveryResearch(input: {
  base: LiveDevArtifact;
  baseArtifactPath?: string | null;
  fixtures: Array<{ fixtureId: string; searchNames: SearchNames }>;
  deps: ResearchDeps;
  configs?: ResearchConfigs;
}): Promise<DiscoveryArtifact> {
  const configs = input.configs ?? CANDIDATE_RESEARCH_CONFIGS;
  const ledger = new CostLedger(configs.pricing);
  const startedAt = input.deps.now().toISOString();
  const records: FixtureResearchRecord[] = [];
  const runtimes: FixtureRuntime[] = [];
  const order = new Map(input.base.deterministic.inputs.fixtures.map((fixture) => [fixture.identity.fixtureId, fixture.identity.gameNumber]));
  for (const target of [...input.fixtures].sort((a, b) => (order.get(a.fixtureId) ?? 0) - (order.get(b.fixtureId) ?? 0))) {
    const { record, runtime } = await researchFixture({ base: input.base, fixtureId: target.fixtureId, searchNames: target.searchNames, deps: input.deps, ledger, configs });
    records.push(record);
    runtimes.push(runtime);
  }
  return sealDiscoveryArtifact(
    {
      schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
      runnerVersion: DISCOVERY_RUNNER_VERSION,
      engineVersion: RESEARCH_V2_ENGINE_VERSION,
      roundId: input.base.deterministic.inputs.roundId,
      configs,
      configProvenance: configProvenanceOf(configs),
      fixtures: records,
      ledger: ledger.snapshot(),
    },
    { baseArtifactPath: input.baseArtifactPath ?? null, startedAt, finishedAt: input.deps.now().toISOString(), fixtures: runtimes },
  );
}
