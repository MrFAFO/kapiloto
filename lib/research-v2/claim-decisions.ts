import type { ImpactProposal } from "./adjustments";
import type { StructuredAvailability } from "./base";
import { isForecastChangingKind, applyImpactRules, CANDIDATE_IMPACT_RULES, type ImpactRuleResult, type ImpactRulesConfig } from "./impact-rules";
import type { ClaimKindV2, DiscoveryClaim } from "./discovery-contract";
import { normalizeForMatch } from "./evidence-window";
import { configProvenance, type ConfigProvenance } from "./provenance";
import {
  CANDIDATE_DEDUP,
  clusterCitations,
  corroborateClusters,
  registryEntryFor,
  type CorroborationV2,
  type DedupConfig,
  type EvidenceCluster,
} from "./source-quality";
import type { SourceRegistrySeedEntry } from "./source-registry";
import type { SourcePolicyConfig, SourceQuality } from "./sources";
import { canonicalEvidenceUrl, subjectKeyV2, type CitationCheckV2, type EntailmentInputV2 } from "./verification";

/**
 * Claim-level decisions (verification-v2, D-047). Only accepted citations are
 * used. Claims are clustered into independent reports, held to the source
 * policy, checked against structured availability and against each other for
 * incompatible statuses (a later verified grade-A official statement may
 * supersede, strictly by time), then mapped through impact-rules-v1. Every
 * outcome carries deterministic reason codes; no model prose decides anything.
 */

export type ClaimStatus = "adjusting" | "explanatory" | "rejected";

export type ClaimReason =
  | "no_accepted_citation"
  | "explanatory_kind"
  | "structured_duplicate"
  | "conflicting_sources"
  | "superseded_by_later_official"
  | "supersedes_earlier_claims"
  | "duplicate_subject"
  | `corroboration:${CorroborationV2["reason"]}`
  | `impact:${ImpactRuleResult["ruleId"]}`;

export type AvailabilityState = "out" | "doubt" | "available";

export type ClaimDecisionV2 = {
  claimId: string;
  needId: string;
  claimKind: ClaimKindV2;
  side: "home" | "away";
  subjectKey: string;
  status: ClaimStatus;
  reasons: ClaimReason[];
  acceptedCitations: string[];
  rejectedCitations: string[];
  clusters: Array<{ clusterId: string; grade: SourceQuality }>;
  corroboration: CorroborationV2;
  structuredDuplicate: boolean;
  availabilityState: AvailabilityState | null;
  conflict: { subjectKey: string; claimIds: string[]; resolution: "conflict" | "superseded" | "supersedes" | "duplicate" } | null;
  impact: ImpactRuleResult | null;
  proposal: ImpactProposal | null;
  /** Earliest possible publication instant among accepted citations (market timing). */
  evidenceTimeMs: number | null;
  /** True when any accepted citation's publication time lacks an explicit timezone. */
  timingImprecise: boolean;
};

export type ClaimDecisionReport = {
  version: "claim-decisions-v1";
  clusters: EvidenceCluster[];
  claims: ClaimDecisionV2[];
  config: { sourcePolicy: ConfigProvenance; dedup: ConfigProvenance; impactRules: ConfigProvenance };
};

const AVAILABILITY_KINDS = new Set<ClaimKindV2>(["absence", "suspension", "doubtful", "expected_return"]);
const OFFICIAL_BASES = new Set(["official_own_club", "official_competition", "verified_direct_statement"]);

const normalizePlayer = (value: string) =>
  value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Availability state a claim asserts; a denial flips it. */
export function availabilityState(claim: DiscoveryClaim): AvailabilityState | null {
  if (!AVAILABILITY_KINDS.has(claim.claim_kind)) return null;
  const base: AvailabilityState = claim.claim_kind === "expected_return" ? "available" : claim.claim_kind === "doubtful" ? "doubt" : "out";
  if (claim.stated_status !== "denied") return base;
  return base === "available" ? "out" : "available";
}

function isStructuredDuplicate(claim: DiscoveryClaim, structured: readonly StructuredAvailability[]): boolean {
  if (!AVAILABILITY_KINDS.has(claim.claim_kind) || claim.subject.type !== "player") return false;
  const names = [claim.subject.name_in_source, claim.subject.name_normalized_en].filter((name): name is string => !!name).map(normalizePlayer);
  return structured.some((fact) => fact.team === claim.side && (names.includes(normalizePlayer(fact.playerName)) || names.includes(normalizePlayer(fact.playerKey))));
}

const GRADE_ORDER: Record<SourceQuality, number> = { A: 4, B: 3, C: 2, D: 1 };

/** Decides every claim from its accepted citations. Pure: identical inputs give identical output. */
export function decideClaimsV2(input: {
  claims: readonly DiscoveryClaim[];
  citations: readonly CitationCheckV2[];
  entailment: Readonly<Record<string, EntailmentInputV2>>;
  structuredAvailability: readonly StructuredAvailability[];
  registry: readonly SourceRegistrySeedEntry[];
  sourcePolicy: SourcePolicyConfig;
  dedup?: DedupConfig;
  impactRules?: ImpactRulesConfig;
}): ClaimDecisionReport {
  const dedup = input.dedup ?? CANDIDATE_DEDUP;
  const impactRules = input.impactRules ?? CANDIDATE_IMPACT_RULES;
  const claims = [...input.claims].sort((a, b) => a.claim_id.localeCompare(b.claim_id));
  const byClaim = new Map(claims.map((claim) => [claim.claim_id, input.citations.filter((check) => check.claimId === claim.claim_id)]));
  const accepted = input.citations.filter((check) => check.status === "accepted");
  const agencies = new Set(input.sourcePolicy.syndicationAgencies.map((name) => name.toLowerCase().trim()));
  const claimById = new Map(claims.map((claim) => [claim.claim_id, claim]));

  // 1. Independent clusters over every accepted citation of the fixture.
  const clusters = clusterCitations(
    accepted.map((check) => {
      const claim = claimById.get(check.claimId) as DiscoveryClaim;
      const entry = registryEntryFor(check.fetch.finalUrl ?? check.url, input.registry);
      const byline = check.source.byline?.toLowerCase().trim() ?? null;
      const agency = entry?.agency ? entry.organization.toLowerCase() : byline && agencies.has(byline) ? byline : null;
      return {
        citationId: check.citationId,
        canonicalUrl: canonicalEvidenceUrl(check.fetch.finalUrl ?? check.url),
        normalizedQuote: normalizeForMatch(claim.citations[check.citationIndex]?.quote ?? ""),
        agency,
        subjectKey: subjectKeyV2(claim),
        originKey: check.source.originKey,
      };
    }),
    dedup,
  );
  const clusterOf = new Map(clusters.flatMap((cluster) => cluster.members.map((member) => [member, cluster.clusterId] as const)));

  // 2. Per-claim corroboration and preliminary status.
  type Working = ClaimDecisionV2 & { claim: DiscoveryClaim; acceptedChecks: CitationCheckV2[] };
  const working: Working[] = claims.map((claim) => {
    const checks = byClaim.get(claim.claim_id) ?? [];
    const acceptedChecks = checks.filter((check) => check.status === "accepted");
    const gradeByCluster = new Map<string, SourceQuality>();
    for (const check of acceptedChecks) {
      const clusterId = clusterOf.get(check.citationId) as string;
      const current = gradeByCluster.get(clusterId);
      if (!current || GRADE_ORDER[check.source.grade] > GRADE_ORDER[current]) gradeByCluster.set(clusterId, check.source.grade);
    }
    const clusterGrades = [...gradeByCluster.entries()].map(([clusterId, grade]) => ({ clusterId, grade }));
    const corroboration = corroborateClusters(clusterGrades, input.sourcePolicy);
    const evidenceTimes = acceptedChecks.map((check) => check.dates.evidenceTimeMs).filter((ms): ms is number => ms != null);
    const decision: Working = {
      claim,
      acceptedChecks,
      claimId: claim.claim_id,
      needId: claim.need_id,
      claimKind: claim.claim_kind,
      side: claim.side,
      subjectKey: subjectKeyV2(claim),
      status: "explanatory",
      reasons: [],
      acceptedCitations: acceptedChecks.map((check) => check.citationId),
      rejectedCitations: checks.filter((check) => check.status === "rejected").map((check) => check.citationId),
      clusters: corroboration.clusterGrades,
      corroboration,
      structuredDuplicate: isStructuredDuplicate(claim, input.structuredAvailability),
      availabilityState: availabilityState(claim),
      conflict: null,
      impact: null,
      proposal: null,
      evidenceTimeMs: evidenceTimes.length > 0 ? Math.min(...evidenceTimes) : null,
      timingImprecise: acceptedChecks.some((check) => check.dates.publishedPrecision !== "datetime_tz"),
    };
    if (acceptedChecks.length === 0) {
      decision.status = "rejected";
      decision.reasons.push("no_accepted_citation");
    } else if (!isForecastChangingKind(claim.claim_kind)) {
      decision.reasons.push("explanatory_kind");
    } else if (!corroboration.passed) {
      decision.reasons.push(`corroboration:${corroboration.reason}`);
    } else if (decision.structuredDuplicate) {
      decision.reasons.push(`corroboration:${corroboration.reason}`, "structured_duplicate");
    } else {
      decision.reasons.push(`corroboration:${corroboration.reason}`);
      decision.status = "adjusting"; // provisional until conflicts and impact rules
    }
    return decision;
  });

  // 3. Incompatible statuses for one subject: non-adjusting unless a later
  //    verified grade-A official statement strictly postdates every rival.
  const candidates = working.filter((decision) => decision.status === "adjusting" && decision.availabilityState != null);
  const bySubject = new Map<string, Working[]>();
  for (const decision of candidates) bySubject.set(decision.subjectKey, [...(bySubject.get(decision.subjectKey) ?? []), decision]);
  for (const [subjectKey, group] of bySubject) {
    if (group.length < 2) continue;
    const claimIds = group.map((decision) => decision.claimId);
    const states = new Set(group.map((decision) => decision.availabilityState));
    if (states.size > 1) {
      const officialTime = (decision: Working) => {
        const times = decision.acceptedChecks
          .filter((check) => check.source.grade === "A" && OFFICIAL_BASES.has(check.source.basis))
          .map((check) => check.dates.evidenceTimeMs)
          .filter((ms): ms is number => ms != null);
        return times.length > 0 ? Math.min(...times) : null;
      };
      const latestTime = (decision: Working) => {
        const times = decision.acceptedChecks.map((check) => check.dates.latestPublicationMs).filter((ms): ms is number => ms != null);
        return times.length > 0 ? Math.max(...times) : Number.POSITIVE_INFINITY;
      };
      const winners = group.filter((decision) => {
        const at = officialTime(decision);
        return at != null && group.every((other) => other === decision || other.availabilityState === decision.availabilityState || at > latestTime(other));
      });
      const winner = winners.length === 1 ? winners[0] : null;
      for (const decision of group) {
        if (winner && decision === winner) {
          decision.reasons.push("supersedes_earlier_claims");
          decision.conflict = { subjectKey, claimIds, resolution: "supersedes" };
        } else if (winner && decision.availabilityState === winner.availabilityState) {
          decision.status = "explanatory";
          decision.reasons.push("duplicate_subject");
          decision.conflict = { subjectKey, claimIds, resolution: "duplicate" };
        } else {
          decision.status = "explanatory";
          decision.reasons.push(winner ? "superseded_by_later_official" : "conflicting_sources");
          decision.conflict = { subjectKey, claimIds, resolution: winner ? "superseded" : "conflict" };
        }
      }
    } else {
      // Same status reported by several claims: one adjustment per subject (first claim id).
      for (const decision of group.slice(1)) {
        decision.status = "explanatory";
        decision.reasons.push("duplicate_subject");
        decision.conflict = { subjectKey, claimIds, resolution: "duplicate" };
      }
    }
  }

  // 4. Impact rules for what remains provisionally adjusting.
  const admittedAbsences = new Map<string, Set<string>>();
  for (const decision of working) {
    if (decision.status === "adjusting" && decision.availabilityState === "out" && decision.claim.subject.type === "player") {
      const names = admittedAbsences.get(decision.side) ?? new Set<string>();
      names.add(normalizePlayer(decision.claim.subject.name_normalized_en ?? decision.claim.subject.name_in_source));
      admittedAbsences.set(decision.side, names);
    }
  }
  for (const decision of working) {
    if (decision.status !== "adjusting") continue;
    const judged = decision.acceptedChecks.map((check) => input.entailment[check.citationId]).filter((entry): entry is EntailmentInputV2 => entry != null);
    const squadSupported = judged.some((entry) => entry.squadStatusSupported);
    const supportedPlayers = new Set(judged.flatMap((entry) => entry.namedPlayersSupported.map(normalizePlayer)));
    for (const name of admittedAbsences.get(decision.side) ?? []) supportedPlayers.delete(name);
    const gradeADirect = decision.acceptedChecks.some((check) => check.source.grade === "A" && OFFICIAL_BASES.has(check.source.basis));
    const impact = applyImpactRules(
      {
        claimId: decision.claimId,
        subjectKey: decision.subjectKey,
        claimKind: decision.claimKind,
        side: decision.side,
        statedStatus: decision.claim.stated_status,
        appliesToThisFixture: decision.claim.applies_to_this_fixture,
        observation: decision.claim.observation,
        verified: true,
        structuredDuplicate: false,
        conflict: false,
        role: decision.claim.subject.role,
        verifiedSquadStatus: squadSupported ? decision.claim.subject.squad_status_claimed : "unknown",
        rotation: decision.claimKind === "rotation_statement" ? { gradeADirectStatement: gradeADirect, supportedFirstChoicePlayers: supportedPlayers.size } : null,
        evidenceIds: decision.acceptedCitations,
      },
      impactRules,
    );
    decision.impact = impact;
    decision.proposal = impact.proposal;
    decision.reasons.push(`impact:${impact.ruleId}`);
    if (!impact.proposal) decision.status = "explanatory";
  }

  return {
    version: "claim-decisions-v1",
    clusters,
    claims: working.map(({ claim: _claim, acceptedChecks: _checks, ...decision }) => decision),
    config: { sourcePolicy: configProvenance(input.sourcePolicy), dedup: configProvenance(dedup), impactRules: configProvenance(impactRules) },
  };
}
