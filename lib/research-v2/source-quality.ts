import { createHash } from "node:crypto";

import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";
import { grantsTrustPrivileges, type SourceRegistrySeedEntry } from "./source-registry";
import { domainOf, qualityAtLeast, type SourcePolicyConfig, type SourceQuality } from "./sources";

/**
 * source-quality-v2 (D-047). Quality is assessed per citation from a stored
 * vector: registry type and review status, primary or secondary reporting,
 * club-scoped specialist or reporter trust, direct statement and origin. Trust
 * comes only from verified or approved registry entries (the effective
 * registry); outlet size or popularity never grants it.
 */

export type SourceQualityConfig = VersionedConfig & {
  /** Grade of an established outlet's own (primary) reporting without club-scoped trust. */
  establishedPrimaryGrade: SourceQuality;
  /** Grade of secondary reporting (citing another outlet or source). */
  secondaryGrade: SourceQuality;
};

/** Candidate values only; not approved and not derived from any outcome. */
export const CANDIDATE_SOURCE_QUALITY: SourceQualityConfig = {
  id: "research-v2-source-quality",
  version: "source-quality-v2",
  status: "candidate",
  establishedPrimaryGrade: "C",
  secondaryGrade: "C",
};

export type CitedOrigin = { type: "press_conference" | "outlet" | "agency" | "none"; name: string | null; date: string | null };

/** Attribution facts for one citation (from the entailment judge in production; injected in tests). */
export type CitationAttribution = { reporting: "primary" | "secondary"; directQuote: boolean; citedOrigin: CitedOrigin };

export type QualityBasis =
  | "official_own_club"
  | "official_competition"
  | "verified_direct_statement"
  | "club_specialist"
  | "scoped_reporter"
  | "established_primary"
  | "secondary_reporting"
  | "official_other_club"
  | "aggregator"
  | "unregistered"
  | "denied";

export type SourceQualityVector = {
  domain: string;
  organization: string | null;
  registryStatus: SourceRegistrySeedEntry["reviewStatus"] | "unregistered";
  sourceType: SourceRegistrySeedEntry["defaultType"] | "unknown";
  reporting: CitationAttribution["reporting"];
  /** Verified specialist outlet for the claim's club. */
  specialistForClub: boolean;
  /** Byline matches a verified reporter whose scope includes the claim's club. */
  scopedReporter: boolean;
  directQuote: boolean;
  byline: string | null;
  originKey: string | null;
  basis: QualityBasis;
  grade: SourceQuality;
  denied: boolean;
};

const normalizeName = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export function registryEntryFor(url: string, registry: readonly SourceRegistrySeedEntry[]): SourceRegistrySeedEntry | null {
  const domain = domainOf(url);
  const matches = registry.filter((entry) => domain === entry.domain || domain.endsWith(`.${entry.domain}`));
  return matches.sort((a, b) => b.domain.length - a.domain.length)[0] ?? null;
}

/**
 * Deterministic origin key. A press conference is keyed by club and date, a
 * cited outlet by its normalized name, agency copy by agency and subject; a
 * report with no external origin has none (it is its own origin).
 */
export function originKey(origin: CitedOrigin, input: { clubKey: string; subjectKey: string; fallbackDate: string | null }): string | null {
  if (origin.type === "press_conference") return `presser:${input.clubKey}:${(origin.date ?? input.fallbackDate ?? "unknown").slice(0, 10)}`;
  if (origin.type === "outlet" && origin.name) return `outlet:${normalizeName(origin.name)}`;
  if (origin.type === "agency" && origin.name) return `agency:${normalizeName(origin.name)}:${input.subjectKey}`;
  return null;
}

/**
 * One citation's quality. `registry` must be the effective registry
 * (`effectiveRegistryEntries`); entries that do not grant trust are also
 * ignored for trust here, as a second guard.
 */
export function assessSourceV2(
  input: {
    url: string;
    byline: string | null;
    attribution: CitationAttribution;
    /** Provider team key of the club the claim is about. */
    clubKey: string;
    originKey: string | null;
  },
  registry: readonly SourceRegistrySeedEntry[],
  config: SourceQualityConfig = CANDIDATE_SOURCE_QUALITY,
): SourceQualityVector {
  const entry = registryEntryFor(input.url, registry);
  const trusted = entry != null && grantsTrustPrivileges(entry);
  const byline = input.byline?.trim() || null;
  const specialistForClub = trusted && (entry.specialistFor ?? []).some((team) => team === input.clubKey);
  const scopedReporter =
    trusted &&
    byline != null &&
    Object.entries(entry.reporterScopes ?? {}).some(([name, teams]) => normalizeName(name) === normalizeName(byline) && teams.includes(input.clubKey as never));
  const primary = input.attribution.reporting === "primary";
  const base = {
    domain: domainOf(input.url),
    organization: entry?.organization ?? null,
    registryStatus: entry?.reviewStatus ?? ("unregistered" as const),
    sourceType: entry?.defaultType ?? ("unknown" as const),
    reporting: input.attribution.reporting,
    specialistForClub,
    scopedReporter,
    directQuote: input.attribution.directQuote,
    byline,
    originKey: input.originKey,
    denied: entry?.denied === true,
  };
  const graded = (basis: QualityBasis, grade: SourceQuality): SourceQualityVector => ({ ...base, basis, grade });

  if (!entry) return graded("unregistered", "D");
  if (entry.denied) return graded("denied", "D");
  if (entry.defaultType === "aggregator") return graded("aggregator", "D");
  const officialSource = trusted && (entry.defaultType === "official_club" || entry.defaultType === "official_competition");
  if (officialSource && entry.defaultType === "official_competition") return graded("official_competition", "A");
  if (officialSource && entry.officialFor === input.clubKey) return graded("official_own_club", "A");
  if (officialSource) return graded("official_other_club", config.secondaryGrade);
  // A relayed direct statement is grade A only from a trusted (verified/approved) outlet.
  if (input.attribution.directQuote && trusted) return graded("verified_direct_statement", "A");
  if (!primary) return graded("secondary_reporting", config.secondaryGrade);
  if (specialistForClub) return graded("club_specialist", "B");
  if (scopedReporter) return graded("scoped_reporter", "B");
  return graded("established_primary", config.establishedPrimaryGrade);
}

// ---- deterministic clustering ------------------------------------------------

export type DedupConfig = VersionedConfig & { minQuoteChars: number };

export const CANDIDATE_DEDUP: DedupConfig = { id: "research-v2-dedup", version: "dedup-v1", status: "candidate", minQuoteChars: 40 };

export type ClusterMember = {
  citationId: string;
  canonicalUrl: string;
  normalizedQuote: string;
  /** Agency name when the copy is agency copy (byline or registry agency), else null. */
  agency: string | null;
  subjectKey: string;
  originKey: string | null;
};

export type ClusterLink = { key: string; members: string[] };

export type EvidenceCluster = {
  clusterId: string;
  members: string[];
  /** Exact keys that joined members (each with the members sharing it). */
  reasons: ClusterLink[];
};

/** Union-find over shared URL, long identical quote, agency + subject and origin keys. */
export function clusterCitations(members: readonly ClusterMember[], config: DedupConfig = CANDIDATE_DEDUP): EvidenceCluster[] {
  const sorted = [...members].sort((a, b) => a.citationId.localeCompare(b.citationId));
  const parent = new Map(sorted.map((member) => [member.citationId, member.citationId]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  const byKey = new Map<string, string[]>();
  for (const member of sorted) {
    const keys = [`url:${member.canonicalUrl}`];
    if (member.normalizedQuote.length >= config.minQuoteChars) keys.push(`quote:${member.normalizedQuote}`);
    if (member.agency) keys.push(`agency:${member.agency}:${member.subjectKey}`);
    if (member.originKey) keys.push(`origin:${member.originKey}`);
    for (const key of keys) byKey.set(key, [...(byKey.get(key) ?? []), member.citationId]);
  }
  for (const ids of byKey.values()) {
    for (const id of ids.slice(1)) {
      const a = find(ids[0]);
      const b = find(id);
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
  }
  const groups = new Map<string, string[]>();
  for (const member of sorted) groups.set(find(member.citationId), [...(groups.get(find(member.citationId)) ?? []), member.citationId]);
  return [...groups.values()]
    .map((ids): EvidenceCluster => {
      const reasons = [...byKey.entries()]
        .filter(([, keyMembers]) => keyMembers.length > 1 && keyMembers.every((id) => ids.includes(id)))
        .map(([key, keyMembers]) => ({ key, members: [...keyMembers] }))
        .sort((a, b) => a.key.localeCompare(b.key));
      return { clusterId: `cl_${createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16)}`, members: ids, reasons };
    })
    .sort((a, b) => a.clusterId.localeCompare(b.clusterId));
}

export type CorroborationV2 = {
  passed: boolean;
  reason: "strong_cluster" | "independent_corroboration" | "weak_sources_only" | "insufficient_corroboration" | "no_clusters";
  /** Best grade per independent cluster considered (D clusters are listed but never count). */
  clusterGrades: Array<{ clusterId: string; grade: SourceQuality }>;
  qualifyingClusters: number;
  policy: ConfigProvenance;
};

/**
 * Source policy over one claim's accepted clusters: one independent cluster at
 * `minQualityAlone` passes; otherwise `independentClustersBelowAlone` clusters
 * at `minQualityToCorroborate` or better. D never counts.
 */
export function corroborateClusters(clusterGrades: Array<{ clusterId: string; grade: SourceQuality }>, policy: SourcePolicyConfig): CorroborationV2 {
  const provenance = configProvenance(policy);
  const sorted = [...clusterGrades].sort((a, b) => a.clusterId.localeCompare(b.clusterId));
  if (sorted.length === 0) return { passed: false, reason: "no_clusters", clusterGrades: sorted, qualifyingClusters: 0, policy: provenance };
  const counting = sorted.filter((cluster) => cluster.grade !== "D" && qualityAtLeast(cluster.grade, policy.minQualityToCorroborate));
  if (sorted.some((cluster) => cluster.grade !== "D" && qualityAtLeast(cluster.grade, policy.minQualityAlone))) {
    return { passed: true, reason: "strong_cluster", clusterGrades: sorted, qualifyingClusters: counting.length, policy: provenance };
  }
  if (counting.length >= policy.independentClustersBelowAlone) {
    return { passed: true, reason: "independent_corroboration", clusterGrades: sorted, qualifyingClusters: counting.length, policy: provenance };
  }
  return {
    passed: false,
    reason: counting.length === 0 ? "weak_sources_only" : "insufficient_corroboration",
    clusterGrades: sorted,
    qualifyingClusters: counting.length,
    policy: provenance,
  };
}
