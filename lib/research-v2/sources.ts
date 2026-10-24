import { createHash } from "node:crypto";

import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";

/**
 * Source quality is assessed per evidence item from the organization, the
 * source type, the author, whether the quote is a direct statement and how
 * many independent (non-syndicated) reports agree. A domain alone never
 * decides it, and a strong local reporter is not downgraded for being local.
 */

export type SourceType =
  | "official_club"
  | "official_competition"
  | "press_conference"
  | "accredited_reporter"
  | "major_outlet"
  | "aggregator"
  | "unknown";

/** A = official/direct, B = strong reporting, C = established secondary, D = weak/aggregated. */
export type SourceQuality = "A" | "B" | "C" | "D";

export type SourceRegistryV2Entry = {
  domain: string;
  organization: string;
  defaultType: Exclude<SourceType, "press_conference">;
  /** Named reporters whose bylines raise an outlet item to accredited reporting. */
  accreditedReporters?: string[];
  denied?: boolean;
};

export type SourcePolicyConfig = VersionedConfig & {
  /** Lowest quality that may move a forecast on its own. */
  minQualityAlone: SourceQuality;
  /** Independent clusters needed when the best quality is below minQualityAlone. */
  independentClustersBelowAlone: number;
  /** Quality below which evidence never counts towards corroboration. */
  minQualityToCorroborate: SourceQuality;
  /** News agencies whose copy is syndicated; one agency story counts once. */
  syndicationAgencies: string[];
};

export const CANDIDATE_SOURCE_POLICY: SourcePolicyConfig = {
  id: "research-v2-source-policy",
  version: "source-policy-v1",
  status: "candidate",
  minQualityAlone: "B",
  independentClustersBelowAlone: 2,
  minQualityToCorroborate: "C",
  syndicationAgencies: ["pa", "press association", "pa media", "reuters", "afp", "ap", "associated press", "efe", "ansa", "dpa", "sid", "europa press"],
};

const QUALITY_ORDER: Record<SourceQuality, number> = { A: 4, B: 3, C: 2, D: 1 };

export function qualityAtLeast(quality: SourceQuality, minimum: SourceQuality): boolean {
  return QUALITY_ORDER[quality] >= QUALITY_ORDER[minimum];
}

export type SourceAssessment = {
  domain: string;
  organization: string | null;
  sourceType: SourceType;
  author: string | null;
  isDirectQuote: boolean;
  quality: SourceQuality;
  denied: boolean;
};

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function registryEntry(domain: string, registry: readonly SourceRegistryV2Entry[]): SourceRegistryV2Entry | null {
  const matches = registry.filter((entry) => domain === entry.domain || domain.endsWith(`.${entry.domain}`));
  return matches.sort((a, b) => b.domain.length - a.domain.length)[0] ?? null;
}

const normalizeName = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Quality of one source item. Official and direct statements rank highest; a
 * direct quote from a manager or club official published by any registered
 * outlet counts as a press-conference report.
 */
export function assessSource(
  item: { url: string; author: string | null; isDirectQuote: boolean },
  registry: readonly SourceRegistryV2Entry[],
): SourceAssessment {
  const domain = domainOf(item.url);
  const entry = registryEntry(domain, registry);
  const author = item.author?.trim() || null;
  let sourceType: SourceType = entry?.defaultType ?? "unknown";
  if (
    entry &&
    author &&
    (entry.accreditedReporters ?? []).some((name) => normalizeName(name) === normalizeName(author)) &&
    (sourceType === "major_outlet" || sourceType === "unknown" || sourceType === "aggregator")
  ) {
    sourceType = "accredited_reporter";
  }
  if (item.isDirectQuote && entry && sourceType !== "aggregator" && sourceType !== "unknown" && !sourceType.startsWith("official")) {
    sourceType = "press_conference";
  }
  const quality: SourceQuality =
    sourceType === "official_club" || sourceType === "official_competition" || sourceType === "press_conference"
      ? "A"
      : sourceType === "accredited_reporter"
        ? "B"
        : sourceType === "major_outlet"
          ? "C"
          : "D";
  return {
    domain,
    organization: entry?.organization ?? null,
    sourceType,
    author,
    isDirectQuote: item.isDirectQuote,
    quality,
    denied: entry?.denied === true,
  };
}

export type SyndicationMember = {
  evidenceId: string;
  canonicalUrl: string;
  quote: string;
  author: string | null;
  subjectKey: string;
};

const normalizeQuote = (quote: string) => quote.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Groups items that are the same underlying report: the same URL, the same
 * quote text (at least 40 normalized characters) or the same agency story
 * about the same subject. Union-find; deterministic cluster ids.
 */
export function syndicationClusters(
  members: readonly SyndicationMember[],
  policy: SourcePolicyConfig,
): Map<string, string> {
  const parent = new Map(members.map((member) => [member.evidenceId, member.evidenceId]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const agencies = new Set(policy.syndicationAgencies.map(normalizeName));
  const byKey = new Map<string, string>();
  const link = (key: string, id: string) => {
    const existing = byKey.get(key);
    if (existing) union(existing, id);
    else byKey.set(key, id);
  };
  for (const member of [...members].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))) {
    link(`url:${member.canonicalUrl}`, member.evidenceId);
    const quote = normalizeQuote(member.quote);
    if (quote.length >= 40) link(`quote:${quote}`, member.evidenceId);
    const author = member.author ? normalizeName(member.author) : null;
    if (author && agencies.has(author)) link(`agency:${author}:${member.subjectKey}`, member.evidenceId);
  }
  const rootUrls = new Map<string, string[]>();
  for (const member of members) {
    const root = find(member.evidenceId);
    rootUrls.set(root, [...(rootUrls.get(root) ?? []), member.canonicalUrl]);
  }
  const clusterIdByRoot = new Map(
    [...rootUrls].map(([root, urls]) => [
      root,
      `syn_${createHash("sha256").update([...new Set(urls)].sort().join("\n")).digest("hex").slice(0, 16)}`,
    ]),
  );
  return new Map(members.map((member) => [member.evidenceId, clusterIdByRoot.get(find(member.evidenceId)) as string]));
}

export type CorroborationDecision = {
  forecastEligible: boolean;
  bestQuality: SourceQuality;
  independentClusters: number;
  reason: "strong_source" | "independent_corroboration" | "weak_sources_only" | "insufficient_corroboration";
  policy: ConfigProvenance;
};

/**
 * Whether a set of verified reports about one subject may move the forecast.
 * Weak (aggregator/unknown) reports never move it on their own, and several
 * syndicated copies of one story count as one report.
 */
export function corroboration(
  items: ReadonlyArray<{ quality: SourceQuality; clusterId: string }>,
  policy: SourcePolicyConfig,
): CorroborationDecision {
  const provenance = configProvenance(policy);
  const bestByCluster = new Map<string, SourceQuality>();
  for (const item of items) {
    const current = bestByCluster.get(item.clusterId);
    if (!current || QUALITY_ORDER[item.quality] > QUALITY_ORDER[current]) bestByCluster.set(item.clusterId, item.quality);
  }
  const qualities = [...bestByCluster.values()];
  const bestQuality = qualities.reduce<SourceQuality>(
    (best, quality) => (QUALITY_ORDER[quality] > QUALITY_ORDER[best] ? quality : best),
    "D",
  );
  const corroborating = qualities.filter((quality) => qualityAtLeast(quality, policy.minQualityToCorroborate)).length;
  if (qualities.length > 0 && qualityAtLeast(bestQuality, policy.minQualityAlone)) {
    return { forecastEligible: true, bestQuality, independentClusters: qualities.length, reason: "strong_source", policy: provenance };
  }
  if (corroborating >= policy.independentClustersBelowAlone) {
    return { forecastEligible: true, bestQuality, independentClusters: qualities.length, reason: "independent_corroboration", policy: provenance };
  }
  return {
    forecastEligible: false,
    bestQuality,
    independentClusters: qualities.length,
    reason: corroborating === 0 ? "weak_sources_only" : "insufficient_corroboration",
    policy: provenance,
  };
}
