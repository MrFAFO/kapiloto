import type { StructuredAvailability } from "./base";
import {
  AVAILABILITY_CLAIM_KINDS,
  type DiscoveryEvidenceItem,
  type EvidenceClaimKind,
} from "./evidence";
import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";
import {
  assessSource,
  domainOf,
  syndicationClusters,
  type SourceAssessment,
  type SourcePolicyConfig,
  type SourceRegistryV2Entry,
} from "./sources";

/** A page the server itself fetched for an evidence URL. */
export type RetrievedPage = {
  requestedUrl: string;
  finalUrl: string;
  text: string;
  publishedAt: string | null;
  retrievedAt: string;
  contentSha256: string;
};

export type EntailmentVerdict = "supported" | "unsupported" | "not_checked";

export type VerificationConfig = VersionedConfig & {
  /** Oldest a claim may be at the cutoff, per claim kind, in hours. */
  maxAgeHoursByKind: Record<EvidenceClaimKind, number>;
};

export const CANDIDATE_VERIFICATION_CONFIG: VerificationConfig = {
  id: "research-v2-verification",
  version: "verification-v1",
  status: "candidate",
  maxAgeHoursByKind: {
    absence: 120,
    suspension: 240,
    doubtful: 72,
    expected_return: 120,
    rotation_statement: 72,
    lineup_confirmed: 6,
    manager_change: 720,
    schedule_disruption: 168,
    other_context: 168,
  },
};

export type VerificationRejection =
  | "url_not_observed_in_search"
  | "page_not_retrieved"
  | "source_denied"
  | "quote_not_found"
  | "undated"
  | "published_after_cutoff"
  | "stale_for_claim_kind"
  | "entailment_unsupported"
  | "entailment_missing";

export type VerifiedEvidence = {
  item: DiscoveryEvidenceItem;
  canonicalUrl: string;
  publishedAt: string | null;
  contentSha256: string | null;
  source: SourceAssessment;
  syndicationClusterId: string;
  entailment: EntailmentVerdict;
  /** Server-computed: the fact is already in the structured inputs. */
  structuredDuplicate: boolean;
  status: "verified" | "rejected";
  rejections: VerificationRejection[];
};

export type VerificationReport = {
  evidence: VerifiedEvidence[];
  config: ConfigProvenance;
  sourcePolicy: ConfigProvenance;
};

export function canonicalEvidenceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

const normalizeText = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const normalizePlayer = (value: string) =>
  value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function subjectKey(item: DiscoveryEvidenceItem): string {
  return item.player_name
    ? `${item.team}:player:${normalizePlayer(item.player_name)}`
    : `${item.team}:${item.claim_kind}`;
}

function isStructuredDuplicate(item: DiscoveryEvidenceItem, structured: readonly StructuredAvailability[]): boolean {
  if (!AVAILABILITY_CLAIM_KINDS.has(item.claim_kind) || !item.player_name || item.team === "both") return false;
  const player = normalizePlayer(item.player_name);
  return structured.some(
    (entry) => entry.team === item.team && (normalizePlayer(entry.playerName) === player || entry.playerKey === item.player_name),
  );
}

/**
 * Stage 4. Every evidence item that could affect a forecast must pass every
 * check, entailment included: an item whose entailment was never checked is
 * rejected, never assumed supported.
 */
export function verifyEvidence(input: {
  items: readonly DiscoveryEvidenceItem[];
  pages: readonly RetrievedPage[];
  observedSearchUrls: readonly string[];
  entailment: Readonly<Record<string, EntailmentVerdict>>;
  informationCutoffAt: string;
  structuredAvailability: readonly StructuredAvailability[];
  registry: readonly SourceRegistryV2Entry[];
  sourcePolicy: SourcePolicyConfig;
  config: VerificationConfig;
}): VerificationReport {
  const cutoffMs = Date.parse(input.informationCutoffAt);
  if (!Number.isFinite(cutoffMs)) throw new Error("verifyEvidence: invalid informationCutoffAt");
  const observed = new Set(input.observedSearchUrls.map(canonicalEvidenceUrl));
  const pages = new Map(input.pages.map((page) => [canonicalEvidenceUrl(page.requestedUrl), page]));
  const clusters = syndicationClusters(
    input.items.map((item) => ({
      evidenceId: item.evidence_id,
      canonicalUrl: canonicalEvidenceUrl(pages.get(canonicalEvidenceUrl(item.url))?.finalUrl ?? item.url),
      quote: item.quote,
      author: item.author,
      subjectKey: subjectKey(item),
    })),
    input.sourcePolicy,
  );

  const evidence = [...input.items]
    .sort((a, b) => a.evidence_id.localeCompare(b.evidence_id))
    .map((item): VerifiedEvidence => {
      const canonicalUrl = canonicalEvidenceUrl(item.url);
      const page = pages.get(canonicalUrl) ?? null;
      const source = assessSource(
        { url: page?.finalUrl ?? item.url, author: item.author, isDirectQuote: item.is_direct_quote },
        input.registry,
      );
      const rejections: VerificationRejection[] = [];
      if (!observed.has(canonicalUrl)) rejections.push("url_not_observed_in_search");
      if (!page) rejections.push("page_not_retrieved");
      if (source.denied) rejections.push("source_denied");
      if (page && !normalizeText(page.text).includes(normalizeText(item.quote))) rejections.push("quote_not_found");
      const publishedAt = page?.publishedAt ?? null;
      const publishedMs = publishedAt == null ? Number.NaN : Date.parse(publishedAt);
      if (!Number.isFinite(publishedMs)) {
        rejections.push("undated");
      } else if (publishedMs > cutoffMs) {
        rejections.push("published_after_cutoff");
      } else if (cutoffMs - publishedMs > input.config.maxAgeHoursByKind[item.claim_kind] * 3_600_000) {
        rejections.push("stale_for_claim_kind");
      }
      const entailment = input.entailment[item.evidence_id] ?? "not_checked";
      if (entailment === "unsupported") rejections.push("entailment_unsupported");
      if (entailment === "not_checked") rejections.push("entailment_missing");
      return {
        item,
        canonicalUrl,
        publishedAt: Number.isFinite(publishedMs) ? new Date(publishedMs).toISOString() : null,
        contentSha256: page?.contentSha256 ?? null,
        source: { ...source, domain: domainOf(page?.finalUrl ?? item.url) },
        syndicationClusterId: clusters.get(item.evidence_id) as string,
        entailment,
        structuredDuplicate: isStructuredDuplicate(item, input.structuredAvailability),
        status: rejections.length === 0 ? "verified" : "rejected",
        rejections,
      };
    });

  return { evidence, config: configProvenance(input.config), sourcePolicy: configProvenance(input.sourcePolicy) };
}
