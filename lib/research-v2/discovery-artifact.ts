import { applyAdjustments, type AdjustmentDecision, type AdjustmentPolicyConfig, type EffectSizeConfig } from "./adjustments";
import { revalidateMarketState, type DeterministicBase, type MarketState } from "./base";
import { decideClaimsV2, type ClaimDecisionReport, type ClaimDecisionV2 } from "./claim-decisions";
import { combineCandidate, type CombinationResult } from "./combination";
import type { LedgerSnapshot, PricingConfig } from "./cost-ledger";
import type { DiscoveryCallResult, DiscoveryInputV1, DiscoveryRequestConfig } from "./discovery-client";
import type { DiscoveryClaim } from "./discovery-contract";
import { buildDiscoveryPlan, type DiscoveryBudgetConfig, type DiscoveryPlan, type DiscoveryPlanConfig } from "./discovery-plan";
import type { DocumentDatesConfig } from "./document-dates";
import type { EntailmentCallResult, EntailmentRequestConfig } from "./entailment-client";
import type { EvidenceWindowConfig } from "./evidence-window";
import type { ImpactRulesConfig } from "./impact-rules";
import { liveDevEligibility, marketQuotes, type LiveDevArtifact, type LiveDevDeterministicInputs, type LiveDevFixtureInputs, type LiveDevFixtureOutput } from "./live-dev-runner";
import { toBasisPoints, type BasisPoints } from "./probability";
import { canonicalJson, configProvenance, RESEARCH_V2_ENGINE_VERSION, sha256Canonical, type ConfigProvenance, type VersionedConfig } from "./provenance";
import { timeClaimAdjustments, type TimedAdjustment, type TimingMarginConfig } from "./research-timing";
import type { FetcherConfig, FetchFailure, ResponseChecks } from "./safe-fetch";
import type { DedupConfig, SourceQualityConfig } from "./source-quality";
import { effectiveRegistryEntries, type SourceRegistrySeed } from "./source-registry";
import type { SourcePolicyConfig } from "./sources";
import type { SpendGuardConfig } from "./spend-guard";
import { verifyCitationsV2, type CitationCaptureV2, type CitationCheckV2, type EntailmentInputV2, type StoredDocumentV2, type VerificationConfigV2 } from "./verification";

/**
 * Research v2 discovery artifact (research-v2-discovery-artifact-v1, D-047)
 * and its pure, network-free half: the base snapshot, the deterministic
 * finalization of one fixture's research, sealing and offline replay. This
 * module imports no network, model, fetch or database code; model-client and
 * fetcher modules appear only as type imports.
 *
 * Hash boundary: `deterministic.inputs` holds everything recorded at capture
 * that later stages read (base snapshot, timestamps, eligibility decisions,
 * plan, discovery attempts without latency, document metadata without
 * bodies, the fetch-security policy outcome of every attempted fetch (per-hop
 * allow/block and reason, redirects, final URL, response acceptance checks),
 * evidence windows, judge results, cost ledger); `deterministic.outputs` is
 * recomputed from those inputs alone. `runtime` (latencies, resolved IP
 * addresses, raw transport error text, file paths) is recorded but never hashed.
 */

export const DISCOVERY_ARTIFACT_SCHEMA_VERSION = "research-v2-discovery-artifact-v1" as const;
export const DISCOVERY_RUNNER_VERSION = "kapiloto-research-v2-discovery-runner-v1" as const;

export type ResearchFreshnessConfig = VersionedConfig & { maxBaseAgeMinutes: number };
export type RetryPolicyConfig = VersionedConfig & { maxRetries: number; retryableFailures: string[]; retryableApiErrors: "server_or_unknown" };

export type ResearchConfigs = {
  freshness: ResearchFreshnessConfig;
  minLeadMinutes: number;
  retry: RetryPolicyConfig;
  plan: DiscoveryPlanConfig;
  budget: DiscoveryBudgetConfig;
  discoveryRequest: DiscoveryRequestConfig;
  entailmentRequest: EntailmentRequestConfig;
  verification: VerificationConfigV2;
  sourceQuality: SourceQualityConfig;
  dates: DocumentDatesConfig;
  evidenceWindow: EvidenceWindowConfig;
  fetcher: FetcherConfig;
  dedup: DedupConfig;
  sourcePolicy: SourcePolicyConfig;
  registry: SourceRegistrySeed;
  impactRules: ImpactRulesConfig;
  adjustmentPolicy: AdjustmentPolicyConfig;
  timingMargin: TimingMarginConfig;
  effects: EffectSizeConfig;
  pricing: PricingConfig;
  spendGuard: SpendGuardConfig;
};

// ---- base snapshot ------------------------------------------------------------------

/**
 * The immutable part of a base artifact research needs, so replay never needs
 * the base file: the fixture's full input and output records and the base
 * configs, with hashes that tie them back to the base artifact.
 */
export type BaseSnapshot = {
  baseSchemaVersion: string;
  baseArtifactSha256: string;
  baseInputSha256: string;
  baseOutputSha256: string;
  baseCutoffAt: string;
  configs: LiveDevDeterministicInputs["configs"];
  fixtureInput: LiveDevFixtureInputs;
  fixtureOutput: LiveDevFixtureOutput;
  /** Start of the league history window used by the base (membership coverage). */
  leagueWindowStart: string | null;
  subsetHashes: { configs: string; fixtureInput: string; fixtureOutput: string };
};

export function snapshotFromBase(base: LiveDevArtifact, fixtureId: string): BaseSnapshot {
  const inputs = base.deterministic.inputs;
  const fixtureInput = inputs.fixtures.find((fixture) => fixture.identity.fixtureId === fixtureId);
  const fixtureOutput = base.deterministic.outputs.fixtures.find((fixture) => fixture.fixtureId === fixtureId);
  if (!fixtureInput || !fixtureOutput) throw new Error(`snapshotFromBase: fixture ${fixtureId} is not in the base artifact`);
  const leagueId = fixtureInput.identity.sportmonks.leagueId;
  const league = inputs.leagues.find((entry) => entry.leagueId === leagueId);
  return {
    baseSchemaVersion: base.schemaVersion,
    baseArtifactSha256: base.deterministic.artifactSha256,
    baseInputSha256: base.deterministic.inputSha256,
    baseOutputSha256: base.deterministic.outputSha256,
    baseCutoffAt: inputs.executionCutoffAt,
    configs: inputs.configs,
    fixtureInput,
    fixtureOutput,
    leagueWindowStart: league?.window.startDate ?? null,
    subsetHashes: { configs: sha256Canonical(inputs.configs), fixtureInput: sha256Canonical(fixtureInput), fixtureOutput: sha256Canonical(fixtureOutput) },
  };
}

/** The snapshot still hashes to what was recorded from the base; with the base, also matches it. */
export function verifySnapshot(snapshot: BaseSnapshot, base?: LiveDevArtifact): boolean {
  const own =
    sha256Canonical(snapshot.configs) === snapshot.subsetHashes.configs &&
    sha256Canonical(snapshot.fixtureInput) === snapshot.subsetHashes.fixtureInput &&
    sha256Canonical(snapshot.fixtureOutput) === snapshot.subsetHashes.fixtureOutput;
  if (!base) return own;
  const fresh = snapshotFromBase(base, snapshot.fixtureInput.identity.fixtureId);
  return own && fresh.baseArtifactSha256 === snapshot.baseArtifactSha256 && canonicalJson(fresh.subsetHashes) === canonicalJson(snapshot.subsetHashes);
}

export const fixtureRefOf = (snapshot: BaseSnapshot) => `fx-${snapshot.fixtureInput.identity.gameNumber}`;

export const clubKeysOf = (snapshot: BaseSnapshot) => ({
  home: `sportmonks:${snapshot.fixtureInput.identity.sportmonks.homeTeamId ?? "unmapped"}`,
  away: `sportmonks:${snapshot.fixtureInput.identity.sportmonks.awayTeamId ?? "unmapped"}`,
});

export type SearchNames = { home: { en: string; source: string[] }; away: { en: string; source: string[] } };

export function planFromSnapshot(snapshot: BaseSnapshot, names: SearchNames, configs: Pick<ResearchConfigs, "plan" | "budget">): DiscoveryPlan | null {
  const triage = snapshot.fixtureOutput.triage;
  if (!triage) return null;
  const identity = snapshot.fixtureInput.identity;
  return buildDiscoveryPlan(
    {
      fixtureRef: fixtureRefOf(snapshot),
      triage,
      triageConfig: snapshot.configs.triage,
      context: snapshot.fixtureInput.triageContext,
      competitionKey: identity.sportmonks.leagueId ? `sportmonks:${identity.sportmonks.leagueId}` : null,
      competitionName: identity.competitionName,
      names: { home: names.home.en, away: names.away.en },
    },
    { plan: configs.plan, budget: configs.budget },
  );
}

export type BaseAgeGate = { at: string; baseAgeMinutes: number; maxBaseAgeMinutes: number; fresh: boolean };

/** research-base-freshness-v1: research may start at most `maxBaseAgeMinutes` after the base cutoff (inclusive). */
export function baseAgeGate(baseCutoffAt: string, atIso: string, config: ResearchFreshnessConfig): BaseAgeGate {
  const ageMs = Date.parse(atIso) - Date.parse(baseCutoffAt);
  return { at: atIso, baseAgeMinutes: ageMs / 60_000, maxBaseAgeMinutes: config.maxBaseAgeMinutes, fresh: ageMs >= 0 && ageMs <= config.maxBaseAgeMinutes * 60_000 };
}

export type EligibilityRecord = { at: string; status: string; kickoffAt: string; eligible: boolean; reason: string | null; minutesToKickoff: number | null };

export function eligibilityRecord(snapshot: BaseSnapshot, current: { status: string; kickoffAt: string }, atIso: string, minLeadMinutes: number): EligibilityRecord {
  const decision = liveDevEligibility({ ...snapshot.fixtureInput.identity, status: current.status, kickoffAt: current.kickoffAt }, atIso, minLeadMinutes);
  return { at: atIso, status: current.status, kickoffAt: current.kickoffAt, eligible: decision.eligible, reason: decision.reason, minutesToKickoff: decision.minutesToKickoff };
}

// ---- recorded research of one fixture (deterministic inputs) -------------------------

export type ResearchStop =
  | "base_fixture_not_researchable"
  | "fresh_base_required"
  | "e1_ineligible"
  | "no_needs"
  | "spend_guard_blocked"
  | "discovery_failed";

export type StoredDiscoveryAttempt = {
  attempt: number;
  /** The client result without latency (latency is runtime-only). */
  result: Omit<DiscoveryCallResult, "response"> & { response: Omit<NonNullable<DiscoveryCallResult["response"]>, "latencyMs"> | null };
  retry: { retryable: boolean; reason: string } | null;
};

/** One hop of the fetcher's URL and address policy; resolved addresses are runtime-only. */
export type StoredFetchPolicyHop = {
  url: string;
  scheme: string | null;
  host: string | null;
  allowed: boolean;
  reason: FetchFailure | null;
  /** The redirect this hop answered with, if any; the target is checked as the next hop. */
  redirect: { to: string; status: number } | null;
};

/**
 * Deterministic fetch-security outcome of one attempted fetch (hashed): whether
 * the URL passed the policy, why it was refused or failed, every redirect hop
 * and its result, and the response checks that decided acceptance. Resolved
 * addresses, timings and raw transport error text stay in runtime.
 */
export type StoredFetchPolicy = {
  policy: { id: string; version: string };
  requestedUrl: string;
  canonicalUrl: string;
  /** Every attempted hop passed the URL and address policy. */
  allowed: boolean;
  reason: FetchFailure | null;
  /** Policy-relevant detail only (HTTP status, media type, size, hop count); never addresses. */
  reasonDetail: string | null;
  hops: StoredFetchPolicyHop[];
  finalUrl: string | null;
  response: ResponseChecks;
  outcome: "fetched" | "failed";
};

export type StoredFetch = {
  order: number;
  canonicalUrl: string;
  outcome: "fetched" | "failed" | "skipped_budget";
  /** Null only for a fetch skipped by the page budget (never attempted). */
  policy: StoredFetchPolicy | null;
  /** Document metadata only; the body is never stored. */
  document: StoredDocumentV2 | null;
  redirects: Array<{ from: string; to: string; status: number }>;
};

export type StoredEntailment = Omit<EntailmentCallResult, "response"> & {
  response: Omit<NonNullable<EntailmentCallResult["response"]>, "latencyMs"> | null;
  skipped: "crossed_min_lead" | "no_surviving_items" | null;
};

export type FixtureResearchRecord = {
  fixtureRef: string;
  fixtureId: string;
  gameNumber: number;
  snapshot: BaseSnapshot;
  searchNames: SearchNames;
  timestamps: { baseCutoffAt: string; researchStartedAt: string | null; knowledgeCutoffAt: string | null; evidenceCutoffAt: string | null; forecastFinalizedAt: string | null };
  gates: { preliminary: BaseAgeGate | null; final: BaseAgeGate | null };
  eligibility: { e1: EligibilityRecord | null; retry: EligibilityRecord | null; e2: EligibilityRecord | null };
  plan: DiscoveryPlan | null;
  discoveryInput: DiscoveryInputV1 | null;
  attempts: StoredDiscoveryAttempt[];
  fetches: StoredFetch[];
  citations: CitationCaptureV2[];
  entailment: StoredEntailment | null;
  stoppedAt: ResearchStop | null;
};

// ---- deterministic finalization ------------------------------------------------------

export type CandidateOutcome = {
  candidateId: string;
  pre: CombinationResult;
  preBp: BasisPoints | null;
  /** Pre-research probabilities match the base artifact's stored candidate. */
  preMatchesBase: boolean;
  post: CombinationResult;
  postBp: BasisPoints | null;
  statPathShift: number;
  fullShift: number;
  capped: boolean;
};

export type FixtureResearchOutcome = {
  fixtureRef: string;
  fixtureId: string;
  status: "not_researched" | "research_failed" | "researched";
  reasons: string[];
  snapshotVerified: boolean;
  planReproduced: boolean | null;
  judgeSelectionReproduced: boolean | null;
  citationChecks: CitationCheckV2[];
  claims: ClaimDecisionReport | null;
  market: (MarketState & { evaluatedAt: string; baseCutoffAt: string }) | null;
  adjustments: TimedAdjustment[];
  candidates: CandidateOutcome[];
  counts: { claims: number; adjusting: number; explanatory: number; rejected: number; acceptedCitations: number; adjustmentsApplied: number };
};

const bp = (result: CombinationResult) => (result.status === "available" ? toBasisPoints(result.probabilities) : null);

function baseLike(snapshot: BaseSnapshot): DeterministicBase {
  return { arms: snapshot.fixtureOutput.arms, market: { quality: snapshot.fixtureOutput.market.quality } } as unknown as DeterministicBase;
}

/** Pre-research candidates, and post-research ones under the given admitted adjustments (effect-sizes-v1). */
function candidateOutcomes(snapshot: BaseSnapshot, decisions: AdjustmentDecision[], effects: EffectSizeConfig): CandidateOutcome[] {
  const base = baseLike(snapshot);
  const stored = new Map(snapshot.fixtureOutput.candidates.map((candidate) => [candidate.candidateId, candidate]));
  if (!snapshot.fixtureOutput.arms) return [];
  return snapshot.configs.combinations.map((candidate) => {
    const pre = combineCandidate(base, candidate);
    let statPathShift = 0;
    let statCapped = false;
    const pooled = combineCandidate(base, candidate, (_, probabilities) => {
      const applied = applyAdjustments(probabilities, decisions, ["stat_path"], effects);
      statPathShift = applied.appliedShift;
      statCapped = applied.capped;
      return applied.probabilities;
    });
    let post: CombinationResult = pooled;
    let fullShift = 0;
    let fullCapped = false;
    if (pooled.status === "available") {
      const full = applyAdjustments(pooled.probabilities, decisions, ["full"], effects);
      post = { ...pooled, probabilities: full.probabilities };
      fullShift = full.appliedShift;
      fullCapped = full.capped;
    }
    const storedBp = stored.get(candidate.id)?.probabilitiesBp ?? null;
    return {
      candidateId: candidate.id,
      pre,
      preBp: bp(pre),
      preMatchesBase: canonicalJson(bp(pre)) === canonicalJson(storedBp),
      post,
      postBp: bp(post),
      statPathShift,
      fullShift,
      capped: statCapped || fullCapped,
    };
  });
}

function admittedClaims(record: FixtureResearchRecord): DiscoveryClaim[] {
  const success = [...record.attempts].reverse().find((attempt) => attempt.result.status === "ok");
  const parse = success?.result.parse;
  return parse && parse.status === "accepted" ? parse.claims.filter((entry) => entry.status === "admitted").map((entry) => entry.claim) : [];
}

export const successfulAttempt = (record: FixtureResearchRecord) => [...record.attempts].reverse().find((attempt) => attempt.result.status === "ok") ?? null;

function revalidate(record: FixtureResearchRecord, knowledgeCutoffAt: string) {
  const snapshot = record.snapshot;
  const identity = snapshot.fixtureInput.identity;
  const leagueId = identity.sportmonks.leagueId;
  return revalidateMarketState(
    {
      fixture: {
        fixtureId: identity.fixtureId,
        roundGameId: identity.roundGameId,
        gameNumber: identity.gameNumber,
        homeTeamId: identity.homeTeamId,
        awayTeamId: identity.awayTeamId,
        kickoffAt: identity.kickoffAt,
        neutralVenue: identity.neutralVenue,
        competitionKey: leagueId ? `sportmonks:${leagueId}` : null,
        homeTeamKey: identity.sportmonks.homeTeamId ? `sportmonks:${identity.sportmonks.homeTeamId}` : null,
        awayTeamKey: identity.sportmonks.awayTeamId ? `sportmonks:${identity.sportmonks.awayTeamId}` : null,
      },
      informationCutoffAt: snapshot.baseCutoffAt,
      history: [],
      marketSnapshotId: snapshot.fixtureInput.market?.status === "ok" ? `live_dev:${identity.fixtureId}:${snapshot.fixtureInput.market.capturedAt}` : null,
      marketQuotes: marketQuotes(identity, snapshot.fixtureInput.market),
      structuredAvailability: [],
    },
    snapshot.configs.base,
    knowledgeCutoffAt,
  );
}

/** Citation precheck: forecast-changing citations whose only open point is the judge. */
export function judgeCandidates(checks: readonly CitationCheckV2[]): string[] {
  return checks.filter((check) => check.entailment.required && check.rejections.length === 1 && check.rejections[0] === "entailment_missing").map((check) => check.citationId).sort();
}

export function verifyRecord(record: FixtureResearchRecord, configs: ResearchConfigs, entailment: Readonly<Record<string, EntailmentInputV2>>): CitationCheckV2[] {
  const success = successfulAttempt(record);
  if (!success || !record.timestamps.knowledgeCutoffAt || !record.timestamps.evidenceCutoffAt) return [];
  return verifyCitationsV2({
    claims: admittedClaims(record),
    citations: record.citations,
    documents: record.fetches.map((fetch) => fetch.document).filter((document): document is StoredDocumentV2 => document != null),
    observedUrls: success.result.webSearch.sources,
    entailment,
    clubKeys: clubKeysOf(record.snapshot),
    knowledgeCutoffAt: record.timestamps.knowledgeCutoffAt,
    evidenceCutoffAt: record.timestamps.evidenceCutoffAt,
    registry: effectiveRegistryEntries(configs.registry),
    configs: { verification: configs.verification, sourceQuality: configs.sourceQuality, dates: configs.dates },
  });
}

/** Deterministic stages for one fixture, from its recorded research alone. */
export function finalizeFixtureResearch(record: FixtureResearchRecord, configs: ResearchConfigs): FixtureResearchOutcome {
  const snapshotVerified = verifySnapshot(record.snapshot);
  const recomputedPlan = planFromSnapshot(record.snapshot, record.searchNames, configs);
  const planReproduced = record.plan ? canonicalJson(recomputedPlan) === canonicalJson(record.plan) : null;
  const unchanged = candidateOutcomes(record.snapshot, [], configs.effects);
  const outcome = (status: FixtureResearchOutcome["status"], reasons: string[], extra: Partial<FixtureResearchOutcome> = {}): FixtureResearchOutcome => ({
    fixtureRef: record.fixtureRef,
    fixtureId: record.fixtureId,
    status,
    reasons,
    snapshotVerified,
    planReproduced,
    judgeSelectionReproduced: null,
    citationChecks: [],
    claims: null,
    market: null,
    adjustments: [],
    candidates: unchanged,
    counts: { claims: 0, adjusting: 0, explanatory: 0, rejected: 0, acceptedCitations: 0, adjustmentsApplied: 0 },
    ...extra,
  });
  if (!snapshotVerified) return outcome("research_failed", ["snapshot_hash_mismatch"]);
  if (record.stoppedAt && record.stoppedAt !== "discovery_failed") return outcome("not_researched", [record.stoppedAt]);
  if (record.stoppedAt === "discovery_failed" || !successfulAttempt(record)) {
    return outcome("research_failed", ["discovery_failed", ...record.attempts.map((attempt) => `attempt_${attempt.attempt}:${attempt.result.failure}`)]);
  }

  const knowledgeCutoffAt = record.timestamps.knowledgeCutoffAt as string;
  const prechecks = verifyRecord(record, configs, {});
  const entailment = Object.fromEntries((record.entailment?.items ?? []).map((item) => [item.itemId, item.input]));
  // The judge must have received exactly the citations that pass every deterministic precheck.
  const expectedJudgeItems = judgeCandidates(prechecks);
  const recordedJudgeItems = (record.entailment?.items ?? []).map((item) => item.itemId).sort();
  const judgeSelectionReproduced =
    record.entailment?.skipped === "crossed_min_lead" || canonicalJson(recordedJudgeItems) === canonicalJson(expectedJudgeItems);
  const citationChecks = verifyRecord(record, configs, entailment);
  const report = decideClaimsV2({
    claims: admittedClaims(record),
    citations: citationChecks,
    entailment,
    structuredAvailability: [],
    registry: effectiveRegistryEntries(configs.registry),
    sourcePolicy: configs.sourcePolicy,
    dedup: configs.dedup,
    impactRules: configs.impactRules,
  });
  const crossed = record.eligibility.e2 != null && !record.eligibility.e2.eligible;
  const claims: ClaimDecisionV2[] = crossed
    ? report.claims.map((claim) => (claim.status === "adjusting" ? { ...claim, status: "explanatory", reasons: [...claim.reasons, "crossed_min_lead"], proposal: null } : claim))
    : report.claims;
  const market = revalidate(record, knowledgeCutoffAt);
  const timed = timeClaimAdjustments({ claims, market, knowledgeCutoffAt, policy: configs.adjustmentPolicy, margin: configs.timingMargin });
  const decisions = timed.adjustments.map((entry) => entry.decision);
  const candidates = candidateOutcomes(record.snapshot, decisions, configs.effects);
  const reasons = [
    ...(crossed ? ["crossed_min_lead"] : []),
    ...(planReproduced === false ? ["plan_not_reproduced"] : []),
    ...(judgeSelectionReproduced ? [] : ["judge_selection_not_reproduced"]),
    ...(record.entailment?.failure ? [`entailment:${record.entailment.failure}`] : []),
    ...(claims.length === 0 ? ["no_admitted_claims"] : []),
    ...(decisions.length === 0 ? ["no_adjustments"] : []),
  ];
  return outcome("researched", reasons, {
    judgeSelectionReproduced,
    citationChecks,
    claims: { ...report, claims },
    market,
    adjustments: timed.adjustments,
    candidates,
    counts: {
      claims: claims.length,
      adjusting: claims.filter((claim) => claim.status === "adjusting").length,
      explanatory: claims.filter((claim) => claim.status === "explanatory").length,
      rejected: claims.filter((claim) => claim.status === "rejected").length,
      acceptedCitations: citationChecks.filter((check) => check.status === "accepted").length,
      adjustmentsApplied: decisions.filter((decision) => decision.path === "full" || decision.path === "stat_path").length,
    },
  });
}

// ---- artifact -------------------------------------------------------------------------

export type DiscoveryDeterministicInputs = {
  schemaVersion: typeof DISCOVERY_ARTIFACT_SCHEMA_VERSION;
  runnerVersion: typeof DISCOVERY_RUNNER_VERSION;
  engineVersion: typeof RESEARCH_V2_ENGINE_VERSION;
  roundId: string;
  configs: ResearchConfigs;
  configProvenance: Record<string, ConfigProvenance>;
  fixtures: FixtureResearchRecord[];
  ledger: LedgerSnapshot;
};

export type DiscoveryDeterministicOutputs = {
  fixtures: FixtureResearchOutcome[];
  summary: {
    fixtures: number;
    researched: number;
    adjustmentsApplied: number;
    chargedMicros: number;
    costUncertain: boolean;
    caps: { fixtureCapMicros: number; runCapMicros: number; runCapReached: boolean; fixturesAtCap: string[] };
  };
};

export type DiscoveryRuntime = {
  baseArtifactPath: string | null;
  startedAt: string;
  finishedAt: string;
  fixtures: Array<{
    fixtureRef: string;
    attemptLatenciesMs: number[];
    entailmentLatencyMs: number | null;
    /** Non-deterministic fetch diagnostics: latency, resolved addresses per hop, raw failure detail. */
    fetchDiagnostics: Array<{ canonicalUrl: string; latencyMs: number; hops: Array<{ url: string; addresses: string[] }>; rawDetail: string | null }>;
  }>;
};

export type DiscoveryArtifact = {
  schemaVersion: typeof DISCOVERY_ARTIFACT_SCHEMA_VERSION;
  tag: "live_dev";
  formalSample: false;
  publication: false;
  deterministic: {
    inputs: DiscoveryDeterministicInputs;
    outputs: DiscoveryDeterministicOutputs;
    inputSha256: string;
    outputSha256: string;
    artifactSha256: string;
  };
  /** Never hashed. */
  runtime: DiscoveryRuntime;
};

export function configProvenanceOf(configs: ResearchConfigs): Record<string, ConfigProvenance> {
  return Object.fromEntries(
    Object.entries(configs)
      .filter(([, value]) => value && typeof value === "object" && "version" in (value as object))
      .map(([key, value]) => [key, configProvenance(value as VersionedConfig)]),
  );
}

export function computeDiscoveryOutputs(inputs: DiscoveryDeterministicInputs): DiscoveryDeterministicOutputs {
  const fixtures = inputs.fixtures.map((record) => finalizeFixtureResearch(record, inputs.configs));
  const fixtureCapMicros = Math.round(inputs.configs.spendGuard.perFixtureCapUsd * 1_000_000);
  const runCapMicros = Math.round(inputs.configs.spendGuard.runCapUsd * 1_000_000);
  return {
    fixtures,
    summary: {
      fixtures: fixtures.length,
      researched: fixtures.filter((fixture) => fixture.status === "researched").length,
      adjustmentsApplied: fixtures.reduce((sum, fixture) => sum + fixture.counts.adjustmentsApplied, 0),
      chargedMicros: inputs.ledger.run.chargedMicros,
      costUncertain: inputs.ledger.run.costUncertain,
      caps: {
        fixtureCapMicros,
        runCapMicros,
        runCapReached: inputs.ledger.run.chargedMicros >= runCapMicros,
        fixturesAtCap: Object.entries(inputs.ledger.fixtures).filter(([, totals]) => totals.chargedMicros >= fixtureCapMicros).map(([ref]) => ref).sort(),
      },
    },
  };
}

export function sealDiscoveryArtifact(inputs: DiscoveryDeterministicInputs, runtime: DiscoveryRuntime): DiscoveryArtifact {
  const outputs = computeDiscoveryOutputs(inputs);
  const inputSha256 = sha256Canonical(inputs);
  const outputSha256 = sha256Canonical(outputs);
  return {
    schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
    tag: "live_dev",
    formalSample: false,
    publication: false,
    deterministic: {
      inputs,
      outputs,
      inputSha256,
      outputSha256,
      artifactSha256: sha256Canonical({ inputSha256, outputSha256, schema: DISCOVERY_ARTIFACT_SCHEMA_VERSION }),
    },
    runtime,
  };
}

/** Offline replay: recompute every deterministic stage from the stored inputs; no network, model or database. */
export function replayDiscoveryArtifact(artifact: DiscoveryArtifact): {
  identical: boolean;
  inputSha256: string;
  outputSha256: string;
  artifactSha256: string;
  snapshotsVerified: boolean;
  outputs: DiscoveryDeterministicOutputs;
} {
  if (artifact?.schemaVersion !== DISCOVERY_ARTIFACT_SCHEMA_VERSION || artifact.deterministic?.inputs?.schemaVersion !== DISCOVERY_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`artifact_schema_unsupported: ${String(artifact?.schemaVersion ?? "missing")}; replay requires ${DISCOVERY_ARTIFACT_SCHEMA_VERSION}`);
  }
  const outputs = computeDiscoveryOutputs(artifact.deterministic.inputs);
  const inputSha256 = sha256Canonical(artifact.deterministic.inputs);
  const outputSha256 = sha256Canonical(outputs);
  const artifactSha256 = sha256Canonical({ inputSha256, outputSha256, schema: DISCOVERY_ARTIFACT_SCHEMA_VERSION });
  return {
    identical:
      inputSha256 === artifact.deterministic.inputSha256 &&
      outputSha256 === artifact.deterministic.outputSha256 &&
      artifactSha256 === artifact.deterministic.artifactSha256,
    inputSha256,
    outputSha256,
    artifactSha256,
    snapshotsVerified: artifact.deterministic.inputs.fixtures.every((record) => verifySnapshot(record.snapshot)),
    outputs,
  };
}

