import { resultKnownAtMs, type HistoricalMatchResult } from "@/lib/evaluation/history";
import type { MarketQuoteRecord } from "@/lib/evaluation/market-prior";

import {
  buildDeterministicBase,
  findResultLikeKeys,
  type ArmResult,
  type BaseArmId,
  type DeterministicBaseConfig,
} from "./base";
import { combineCandidate, type CombinationCandidate } from "./combination";
import {
  deriveCompetitionMembership,
  type CompetitionMembership,
  type LeagueMembershipConfig,
  type SeasonedMatch,
} from "./league-membership";
import { FORMAL_SAMPLING_ENABLED } from "./live-dev";
import { toBasisPoints, type BasisPoints, type ThreeWayProbabilities } from "./probability";
import { RESEARCH_V2_ENGINE_VERSION, sha256Canonical } from "./provenance";
import { assignTriage, extractTriageFeatures, type TriageConfig, type TriageContext, type TriageDecision } from "./triage";

/**
 * Read-only Research v2 live-development runner (deterministic base only).
 * No research adjustments, no Sol call, no recommendation, no database write.
 * Provider data enters only through injected `LiveDevProviders`; everything
 * after retrieval is a pure function of the stored deterministic inputs, so a
 * stored artifact replays bit-for-bit without any network access.
 */

export const LIVE_DEV_ARTIFACT_SCHEMA_VERSION = "kapiloto-research-v2-live-dev-artifact-v2" as const;
export const LIVE_DEV_RUNNER_VERSION = "kapiloto-research-v2-live-dev-runner-v2" as const;
/** A fixture is eligible only while kickoff is at least this far away (inclusive). */
export const DEFAULT_LIVE_DEV_MIN_LEAD_MINUTES = 60;

export type LiveDevFixtureIdentity = {
  fixtureId: string;
  roundId: string;
  roundGameId: string;
  gameNumber: number;
  homeTeamId: string;
  awayTeamId: string;
  homeName: string;
  awayName: string;
  competitionId: string | null;
  competitionName: string;
  competitionType: string | null;
  kickoffAt: string;
  status: string;
  neutralVenue: boolean;
  legNumber: number | null;
  sportmonks: { leagueId: string | null; homeTeamId: string | null; awayTeamId: string | null; fixtureId: string | null };
};

export type LiveDevEligibility =
  | { eligible: true; reason: null; minutesToKickoff: number }
  | {
      eligible: false;
      reason: "not_upcoming" | "invalid_kickoff" | "kickoff_passed" | "kickoff_within_min_lead" | "not_retrieved";
      minutesToKickoff: number | null;
    };

/**
 * Eligible only when the fixture is still upcoming and kickoff is at least
 * `minLeadMinutes` after `atIso`. Exactly `minLeadMinutes` is eligible.
 */
export function liveDevEligibility(identity: LiveDevFixtureIdentity, atIso: string, minLeadMinutes: number): LiveDevEligibility {
  const kickoffMs = Date.parse(identity.kickoffAt);
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(kickoffMs) || !Number.isFinite(atMs)) return { eligible: false, reason: "invalid_kickoff", minutesToKickoff: null };
  const minutesToKickoff = (kickoffMs - atMs) / 60_000;
  if (identity.status !== "upcoming") return { eligible: false, reason: "not_upcoming", minutesToKickoff };
  if (minutesToKickoff <= 0) return { eligible: false, reason: "kickoff_passed", minutesToKickoff };
  if (minutesToKickoff < minLeadMinutes) return { eligible: false, reason: "kickoff_within_min_lead", minutesToKickoff };
  return { eligible: true, reason: null, minutesToKickoff };
}

/**
 * Earliest date the provider account actually serves history for. It only
 * bounds which windows are requested (no rows exist before it for this
 * account); it is not a model parameter and changes no statistic. When the
 * provider exposes older history, change it here (new version), not in code.
 */
export type ProviderHistoryFloor = {
  id: string;
  version: string;
  provider: "sportmonks";
  earliestDate: string;
  source: string;
};

/** Measured 2026-10-24: Sportmonks returned no rows before August 2024 for the five target leagues. */
export const SPORTMONKS_HISTORY_FLOOR: ProviderHistoryFloor = {
  id: "sportmonks-account-history-floor",
  version: "history-floor-v1",
  provider: "sportmonks",
  earliestDate: "2024-08-01",
  source: "2026-10-24 read-only coverage probe: earliest returned match 2024-08-15/16/17/23/24 per league",
};

/** The history window actually requested, recorded with the inputs for audit and replay. */
export type HistoryRequestPlan = {
  provider: "sportmonks";
  /** Lookback the statistical arms can use (from their configs). */
  lookbackDays: number;
  lookbackStartDate: string;
  floor: ProviderHistoryFloor | null;
  /** max(lookbackStartDate, floor.earliestDate). */
  requestedStartDate: string;
  requestedEndDate: string;
};

export function planHistoryRequest(
  guardCheckedAt: string,
  lookbackDays: number,
  floor: ProviderHistoryFloor | null,
): HistoryRequestPlan {
  const guardMs = Date.parse(guardCheckedAt);
  const lookbackStartDate = isoDay(guardMs - lookbackDays * 86_400_000);
  const requestedStartDate =
    floor && floor.earliestDate > lookbackStartDate ? floor.earliestDate : lookbackStartDate;
  return {
    provider: "sportmonks",
    lookbackDays,
    lookbackStartDate,
    floor,
    requestedStartDate,
    requestedEndDate: isoDay(guardMs),
  };
}

/** A provider history row with the provider's season id (null when the provider gave none). */
export type LiveDevHistoryRow = HistoricalMatchResult & { providerSeasonId: string | null };

export type LeagueHistoryInput =
  | { leagueId: string; window: { startDate: string; endDate: string }; status: "ok"; matches: LiveDevHistoryRow[] }
  | { leagueId: string; window: { startDate: string; endDate: string }; status: "failed"; reason: string };

export type MarketInput =
  | {
      status: "ok";
      capturedAt: string;
      apiFootballFixtureId: string;
      resolution: string;
      quotes: Array<{ bookmakerId: string; bookmakerName: string; sourceUpdatedAt: string | null; odds: { home: number; draw: number; away: number } }>;
    }
  | { status: "unavailable"; reason: string; resolution: string | null; apiFootballFixtureId: string | null };

export type LiveDevFixtureInputs = {
  identity: LiveDevFixtureIdentity;
  /** Null when the fixture was excluded before any provider retrieval. */
  market: MarketInput | null;
  triageContext: TriageContext;
  structuredSnapshotId: string | null;
};

/** Everything the deterministic output is computed from (and nothing else). */
export type LiveDevDeterministicInputs = {
  schemaVersion: typeof LIVE_DEV_ARTIFACT_SCHEMA_VERSION;
  runnerVersion: typeof LIVE_DEV_RUNNER_VERSION;
  engineVersion: typeof RESEARCH_V2_ENGINE_VERSION;
  roundId: string;
  executionCutoffAt: string;
  minLeadMinutes: number;
  configs: {
    base: DeterministicBaseConfig;
    combinations: CombinationCandidate[];
    triage: TriageConfig;
    membership: LeagueMembershipConfig;
  };
  historyPlan: HistoryRequestPlan;
  leagues: LeagueHistoryInput[];
  fixtures: LiveDevFixtureInputs[];
};

export type LiveDevCandidateArm = {
  candidateId: string;
  configVersion: string;
  configSha256: string;
  status: "available" | "unavailable";
  probabilities: ThreeWayProbabilities | null;
  probabilitiesBp: BasisPoints | null;
  reason: string | null;
};

export type LiveDevFixtureOutput = {
  gameNumber: number;
  fixtureId: string;
  roundGameId: string;
  home: string;
  away: string;
  competition: string;
  kickoffAt: string;
  executionCutoffAt: string;
  tag: "live_dev";
  formalSample: false;
  eligibility: LiveDevEligibility;
  sportmonks: {
    leagueId: string | null;
    homeTeamId: string | null;
    awayTeamId: string | null;
    historyStatus: "ok" | "failed" | "unmapped" | "not_retrieved";
    historyReason: string | null;
    historyWindow: { startDate: string; endDate: string } | null;
    historyRowsUsed: number;
  };
  arms: Record<BaseArmId, ArmResult> | null;
  armsBp: Partial<Record<BaseArmId, BasisPoints>>;
  market: {
    status: "ok" | "unavailable" | "not_retrieved";
    reason: string | null;
    apiFootballFixtureId: string | null;
    resolution: string | null;
    marketStateVersion: string | null;
    retrievedAt: string | null;
    informationEarliestAt: string | null;
    informationLatestAt: string | null;
    informationAgeMinutesAtCutoff: number | null;
    informationTimeSource: string | null;
    quality: string | null;
    bookmakersUsed: string[];
  };
  /** History-derived competition membership (null when no league history was usable). */
  membership: CompetitionMembership | null;
  candidates: LiveDevCandidateArm[];
  triage: TriageDecision | null;
  /** Non-degrading warnings, e.g. `p_stat_elo_v1:cold_start:home` or `p_stat_elo_v1:cold_start_unknown:away`. */
  flags: string[];
  researchAdjustmentsApplied: 0;
  solCalls: 0;
  recommendation: null;
  degraded: string[];
  baseInputSha256: string | null;
};

export type LiveDevDeterministicOutput = {
  fixtures: LiveDevFixtureOutput[];
  summary: { eligible: number; excluded: number; marketAvailable: number; statAvailable: number };
};

export type LiveDevRetrievalCall = {
  provider: "supabase" | "sportmonks" | "api-football";
  target: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error: string | null;
};

export type LiveDevArtifact = {
  schemaVersion: typeof LIVE_DEV_ARTIFACT_SCHEMA_VERSION;
  tag: "live_dev";
  formalSamplingEnabled: false;
  publication: false;
  deterministic: {
    inputs: LiveDevDeterministicInputs;
    outputs: LiveDevDeterministicOutput;
    inputSha256: string;
    outputSha256: string;
    /** Hash of the deterministic inputs and outputs only; retrieval metadata is excluded. */
    artifactSha256: string;
  };
  /** Non-deterministic metadata: never part of any deterministic hash. */
  retrieval: {
    guardCheckedAt: string;
    startedAt: string;
    finishedAt: string;
    guard: Array<{ gameNumber: number; fixtureId: string; eligibility: LiveDevEligibility }>;
    calls: LiveDevRetrievalCall[];
  };
};

function assertNoTargetResults(inputs: LiveDevDeterministicInputs): void {
  const found = inputs.fixtures.flatMap((fixture, index) =>
    findResultLikeKeys({ identity: fixture.identity, market: fixture.market, triageContext: fixture.triageContext }, `fixtures[${index}]`),
  );
  if (found.length > 0) throw new Error(`research_v2_result_leakage: result-like fields in live-dev inputs: ${found.join(", ")}`);
  for (const fixture of inputs.fixtures) {
    const targetId = fixture.identity.sportmonks.fixtureId;
    if (!targetId) continue;
    for (const league of inputs.leagues) {
      if (league.status === "ok" && league.matches.some((match) => match.providerFixtureId === targetId)) {
        throw new Error(`research_v2_result_leakage: target fixture ${targetId} appears in league history`);
      }
    }
  }
}

function historyFor(identity: LiveDevFixtureIdentity, league: LeagueHistoryInput | undefined, cutoffMs: number): LiveDevHistoryRow[] {
  if (!league || league.status !== "ok") return [];
  const kickoffMs = Date.parse(identity.kickoffAt);
  return league.matches.filter(
    (match) =>
      match.providerFixtureId !== identity.sportmonks.fixtureId &&
      resultKnownAtMs(match) <= cutoffMs &&
      Date.parse(match.kickoffAt) < kickoffMs,
  );
}

/** The market-quote records the base built from one fixture's capture (also used for research-time revalidation). */
export function marketQuotes(identity: LiveDevFixtureIdentity, market: MarketInput | null): MarketQuoteRecord[] {
  if (!market || market.status !== "ok") return [];
  return market.quotes.map((quote) => ({
    id: `${identity.fixtureId}:${quote.bookmakerId}`,
    fixtureId: identity.fixtureId,
    provider: "api-football",
    bookmakerId: quote.bookmakerId,
    bookmakerName: quote.bookmakerName,
    capturedAt: market.capturedAt,
    sourceUpdatedAt: quote.sourceUpdatedAt,
    odds: quote.odds,
  }));
}

function unavailableArm(arm: ArmResult, reason: string): ArmResult {
  return { arm: arm.arm, version: arm.version, status: "unavailable", reason, detail: {} };
}

/** Pure: identical inputs always give an identical (bit-for-bit) output. */
export function computeLiveDevOutputs(inputs: LiveDevDeterministicInputs): LiveDevDeterministicOutput {
  if (FORMAL_SAMPLING_ENABLED) throw new Error("Formal sampling must stay disabled for live-dev runs.");
  assertNoTargetResults(inputs);
  const cutoffMs = Date.parse(inputs.executionCutoffAt);
  if (!Number.isFinite(cutoffMs)) throw new Error("Invalid executionCutoffAt.");
  const leagues = new Map(inputs.leagues.map((league) => [league.leagueId, league]));

  const fixtures = [...inputs.fixtures]
    .sort((a, b) => a.identity.gameNumber - b.identity.gameNumber)
    .map((fixture): LiveDevFixtureOutput => {
      const { identity } = fixture;
      const eligibility = liveDevEligibility(identity, inputs.executionCutoffAt, inputs.minLeadMinutes);
      const leagueId = identity.sportmonks.leagueId;
      const league = leagueId ? leagues.get(leagueId) : undefined;
      const common = {
        gameNumber: identity.gameNumber,
        fixtureId: identity.fixtureId,
        roundGameId: identity.roundGameId,
        home: identity.homeName,
        away: identity.awayName,
        competition: identity.competitionName,
        kickoffAt: identity.kickoffAt,
        executionCutoffAt: inputs.executionCutoffAt,
        tag: "live_dev" as const,
        formalSample: false as const,
        eligibility,
        researchAdjustmentsApplied: 0 as const,
        solCalls: 0 as const,
        recommendation: null,
      };
      if (!eligibility.eligible || fixture.market == null) {
        return {
          ...common,
          eligibility: eligibility.eligible
            ? { eligible: false, reason: "not_retrieved", minutesToKickoff: eligibility.minutesToKickoff }
            : eligibility,
          sportmonks: { ...identity.sportmonks, historyStatus: "not_retrieved", historyReason: null, historyWindow: null, historyRowsUsed: 0 },
          arms: null,
          armsBp: {},
          market: {
            status: "not_retrieved",
            reason: null,
            apiFootballFixtureId: null,
            resolution: null,
            marketStateVersion: null,
            retrievedAt: null,
            informationEarliestAt: null,
            informationLatestAt: null,
            informationAgeMinutesAtCutoff: null,
            informationTimeSource: null,
            quality: null,
            bookmakersUsed: [],
          },
          membership: null,
          candidates: [],
          triage: null,
          flags: [],
          degraded: [`excluded:${eligibility.eligible ? "not_retrieved" : eligibility.reason}`],
          baseInputSha256: null,
        };
      }

      const history = historyFor(identity, league, cutoffMs);
      const base = buildDeterministicBase(
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
          informationCutoffAt: inputs.executionCutoffAt,
          history,
          marketSnapshotId: fixture.market.status === "ok" ? `live_dev:${identity.fixtureId}:${fixture.market.capturedAt}` : null,
          marketQuotes: marketQuotes(identity, fixture.market),
          structuredAvailability: [],
        },
        inputs.configs.base,
      );
      const degraded: string[] = [];
      if (league?.status === "failed") {
        // Never fabricate history: a failed provider call is reported as such.
        const reason = `sportmonks_history_unavailable:${league.reason}`;
        base.arms.p_league_base_v1 = unavailableArm(base.arms.p_league_base_v1, reason);
        base.arms.p_stat_elo_v1 = unavailableArm(base.arms.p_stat_elo_v1, reason);
      }
      for (const arm of Object.values(base.arms)) {
        if (arm.status === "unavailable" && arm.reason !== "not_implemented") degraded.push(`${arm.arm}:${arm.reason}`);
      }
      if (fixture.market.status === "unavailable") degraded.push(`market_provider:${fixture.market.reason}`);

      const candidates = inputs.configs.combinations.map((candidate): LiveDevCandidateArm => {
        const result = combineCandidate(base, candidate);
        return {
          candidateId: candidate.id,
          configVersion: candidate.version,
          configSha256: result.config.sha256,
          status: result.status,
          probabilities: result.status === "available" ? result.probabilities : null,
          probabilitiesBp: result.status === "available" ? toBasisPoints(result.probabilities) : null,
          reason: result.status === "available" ? null : result.reason,
        };
      });
      const competitionKey = leagueId ? `sportmonks:${leagueId}` : null;
      const membership =
        competitionKey && league?.status === "ok"
          ? deriveCompetitionMembership(
              {
                history: history as SeasonedMatch[],
                competitionKey,
                homeTeamKey: identity.sportmonks.homeTeamId ? `sportmonks:${identity.sportmonks.homeTeamId}` : null,
                awayTeamKey: identity.sportmonks.awayTeamId ? `sportmonks:${identity.sportmonks.awayTeamId}` : null,
                targetKickoffAt: identity.kickoffAt,
                coverageStartDate: league.window.startDate,
              },
              inputs.configs.membership,
            )
          : null;
      const triage = assignTriage(
        extractTriageFeatures(base, fixture.triageContext, {
          statArm: inputs.configs.triage.statArm,
          neutralVenue: identity.neutralVenue,
          history: { newToCompetition: membership?.newToCompetitionThisSeason ?? { home: null, away: null } },
        }),
        inputs.configs.triage,
      );
      const flags = (["home", "away"] as const).flatMap((side) =>
        triage.statColdStart[side] === true
          ? [`${inputs.configs.triage.statArm}:cold_start:${side}`]
          : triage.statColdStart[side] === null
            ? [`${inputs.configs.triage.statArm}:cold_start_unknown:${side}`]
            : [],
      );
      const armsBp: Partial<Record<BaseArmId, BasisPoints>> = {};
      for (const arm of Object.values(base.arms)) if (arm.status === "available") armsBp[arm.arm] = toBasisPoints(arm.probabilities);

      return {
        ...common,
        sportmonks: {
          ...identity.sportmonks,
          historyStatus: !leagueId ? "unmapped" : league?.status === "failed" ? "failed" : league ? "ok" : "not_retrieved",
          historyReason: league?.status === "failed" ? league.reason : null,
          historyWindow: league?.window ?? null,
          historyRowsUsed: history.length,
        },
        arms: base.arms,
        armsBp,
        market: {
          status: fixture.market.status,
          reason: fixture.market.status === "unavailable" ? fixture.market.reason : base.market.reason,
          apiFootballFixtureId: fixture.market.apiFootballFixtureId,
          resolution: fixture.market.resolution,
          marketStateVersion: base.market.policy.version,
          retrievedAt: fixture.market.status === "ok" ? fixture.market.capturedAt : null,
          informationEarliestAt: base.market.informationEarliestAt,
          informationLatestAt: base.market.informationLatestAt,
          informationAgeMinutesAtCutoff: base.market.informationAgeMinutesAtCutoff,
          informationTimeSource: base.market.informationTimeSource,
          quality: base.market.quality,
          bookmakersUsed:
            fixture.market.status === "ok" ? [...new Set(fixture.market.quotes.map((quote) => quote.bookmakerName))].sort() : [],
        },
        membership,
        candidates,
        triage,
        flags,
        degraded,
        baseInputSha256: base.inputSha256,
      };
    });

  return {
    fixtures,
    summary: {
      eligible: fixtures.filter((fixture) => fixture.eligibility.eligible).length,
      excluded: fixtures.filter((fixture) => !fixture.eligibility.eligible).length,
      marketAvailable: fixtures.filter((fixture) => fixture.arms?.p_market_v1.status === "available").length,
      statAvailable: fixtures.filter((fixture) => fixture.arms?.p_stat_elo_v1.status === "available").length,
    },
  };
}

export function sealLiveDevArtifact(
  inputs: LiveDevDeterministicInputs,
  retrieval: LiveDevArtifact["retrieval"],
): LiveDevArtifact {
  const outputs = computeLiveDevOutputs(inputs);
  const inputSha256 = sha256Canonical(inputs);
  const outputSha256 = sha256Canonical(outputs);
  return {
    schemaVersion: LIVE_DEV_ARTIFACT_SCHEMA_VERSION,
    tag: "live_dev",
    formalSamplingEnabled: false,
    publication: false,
    deterministic: {
      inputs,
      outputs,
      inputSha256,
      outputSha256,
      artifactSha256: sha256Canonical({ inputSha256, outputSha256, schema: LIVE_DEV_ARTIFACT_SCHEMA_VERSION }),
    },
    retrieval,
  };
}

/**
 * Refuses any artifact this runner did not produce. There is deliberately no
 * legacy path: an older schema may carry different market-time semantics.
 */
export function assertReplayableSchema(artifact: { schemaVersion?: unknown; deterministic?: { inputs?: { schemaVersion?: unknown } } }): void {
  const versions = [artifact?.schemaVersion, artifact?.deterministic?.inputs?.schemaVersion];
  if (versions.every((version) => version === LIVE_DEV_ARTIFACT_SCHEMA_VERSION)) return;
  const found = String(versions.find((version) => version !== LIVE_DEV_ARTIFACT_SCHEMA_VERSION) ?? "missing");
  throw new Error(`artifact_schema_unsupported: ${found}; runner v2 requires artifact schema v2 (${LIVE_DEV_ARTIFACT_SCHEMA_VERSION})`);
}

/** Replay mode: recompute from stored inputs only; no provider or network access. */
export function replayLiveDevArtifact(artifact: LiveDevArtifact): {
  identical: boolean;
  inputSha256: string;
  outputSha256: string;
  artifactSha256: string;
  outputs: LiveDevDeterministicOutput;
} {
  assertReplayableSchema(artifact);
  const outputs = computeLiveDevOutputs(artifact.deterministic.inputs);
  const inputSha256 = sha256Canonical(artifact.deterministic.inputs);
  const outputSha256 = sha256Canonical(outputs);
  const artifactSha256 = sha256Canonical({ inputSha256, outputSha256, schema: LIVE_DEV_ARTIFACT_SCHEMA_VERSION });
  return {
    identical:
      inputSha256 === artifact.deterministic.inputSha256 &&
      outputSha256 === artifact.deterministic.outputSha256 &&
      artifactSha256 === artifact.deterministic.artifactSha256,
    inputSha256,
    outputSha256,
    artifactSha256,
    outputs,
  };
}

/** Provider access, injected so tests and replay never touch the network. */
export interface LiveDevProviders {
  now(): Date;
  loadIdentities(): Promise<LiveDevFixtureIdentity[]>;
  loadLeagueHistory(leagueId: string, window: { startDate: string; endDate: string }): Promise<LiveDevHistoryRow[]>;
  loadMarket(identity: LiveDevFixtureIdentity): Promise<MarketInput>;
  loadTriageContext(identity: LiveDevFixtureIdentity): Promise<{ context: TriageContext; structuredSnapshotId: string | null }>;
}

/** Nothing known: every signal is explicitly unknown, never "checked, none". */
const UNKNOWN_CONTEXT: TriageContext = {
  managerChange: { home: { status: "unknown" }, away: { status: "unknown" } },
  restDays: { home: null, away: null },
  matchesLast14Days: { home: null, away: null },
  competition: { isCup: false, isSecondLeg: false },
  unresolvedAvailability: null,
};

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Live provider mode. Rereads fixture status, excludes started or too-close
 * fixtures before any provider call, retrieves provider data per league and
 * fixture (each failure isolated), then seals the deterministic artifact with
 * a cutoff taken after retrieval so every captured quote precedes it.
 */
export async function captureLiveDevArtifact(input: {
  roundId: string;
  providers: LiveDevProviders;
  configs: LiveDevDeterministicInputs["configs"];
  minLeadMinutes?: number;
  historyLookbackDays: number;
  /** Provider-account history floor; null requests the full lookback. */
  historyFloor: ProviderHistoryFloor | null;
}): Promise<LiveDevArtifact> {
  const minLeadMinutes = input.minLeadMinutes ?? DEFAULT_LIVE_DEV_MIN_LEAD_MINUTES;
  const calls: LiveDevRetrievalCall[] = [];
  const timed = async <T>(provider: LiveDevRetrievalCall["provider"], target: string, run: () => Promise<T>): Promise<T> => {
    const startedAt = input.providers.now().toISOString();
    try {
      const value = await run();
      calls.push({ provider, target, startedAt, finishedAt: input.providers.now().toISOString(), ok: true, error: null });
      return value;
    } catch (error) {
      calls.push({ provider, target, startedAt, finishedAt: input.providers.now().toISOString(), ok: false, error: message(error) });
      throw error;
    }
  };

  const startedAt = input.providers.now().toISOString();
  const identities = await timed("supabase", "fixture_identity", () => input.providers.loadIdentities());
  const guardCheckedAt = input.providers.now().toISOString();
  const guard = identities
    .map((identity) => ({ gameNumber: identity.gameNumber, fixtureId: identity.fixtureId, eligibility: liveDevEligibility(identity, guardCheckedAt, minLeadMinutes) }))
    .sort((a, b) => a.gameNumber - b.gameNumber);
  const eligible = identities.filter((identity) => guard.find((item) => item.fixtureId === identity.fixtureId)?.eligibility.eligible);

  const historyPlan = planHistoryRequest(guardCheckedAt, input.historyLookbackDays, input.historyFloor);
  const leagues: LeagueHistoryInput[] = [];
  for (const leagueId of [...new Set(eligible.map((identity) => identity.sportmonks.leagueId).filter((id): id is string => id != null))].sort()) {
    const window = { startDate: historyPlan.requestedStartDate, endDate: historyPlan.requestedEndDate };
    try {
      const matches = await timed("sportmonks", `league:${leagueId}`, () => input.providers.loadLeagueHistory(leagueId, window));
      leagues.push({ leagueId, window, status: "ok", matches });
    } catch (error) {
      leagues.push({ leagueId, window, status: "failed", reason: message(error) });
    }
  }

  const fixtures: LiveDevFixtureInputs[] = [];
  for (const identity of [...identities].sort((a, b) => a.gameNumber - b.gameNumber)) {
    if (!eligible.includes(identity)) {
      fixtures.push({ identity, market: null, triageContext: UNKNOWN_CONTEXT, structuredSnapshotId: null });
      continue;
    }
    let market: MarketInput;
    try {
      market = await timed("api-football", `fixture:${identity.fixtureId}`, () => input.providers.loadMarket(identity));
    } catch (error) {
      market = { status: "unavailable", reason: classifyProviderError(error), resolution: null, apiFootballFixtureId: null };
    }
    let context = UNKNOWN_CONTEXT;
    let structuredSnapshotId: string | null = null;
    try {
      const loaded = await timed("supabase", `triage_context:${identity.fixtureId}`, () => input.providers.loadTriageContext(identity));
      context = loaded.context;
      structuredSnapshotId = loaded.structuredSnapshotId;
    } catch {
      // Unknown context stays explicitly unknown (nulls), never invented.
    }
    fixtures.push({ identity, market, triageContext: context, structuredSnapshotId });
  }

  const executionCutoffAt = input.providers.now().toISOString();
  return sealLiveDevArtifact(
    {
      schemaVersion: LIVE_DEV_ARTIFACT_SCHEMA_VERSION,
      runnerVersion: LIVE_DEV_RUNNER_VERSION,
      engineVersion: RESEARCH_V2_ENGINE_VERSION,
      roundId: input.roundId,
      executionCutoffAt,
      minLeadMinutes,
      configs: input.configs,
      historyPlan,
      leagues,
      fixtures,
    },
    { guardCheckedAt, startedAt, finishedAt: executionCutoffAt, guard, calls },
  );
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** Explicit reason codes for provider failures (never a silent substitute). */
export function classifyProviderError(error: unknown): string {
  const text = message(error);
  if (/do not have access to this date|plan/i.test(text)) return "provider_plan_date_window";
  if (/429|rate limit/i.test(text)) return "provider_rate_limited";
  return `provider_error:${text.slice(0, 120)}`;
}
