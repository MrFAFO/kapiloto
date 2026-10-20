import type { KapilotoFixtureCard } from "./fixture-card";
import {
  normalizeEvidenceUrl,
  type SolFixtureResearchOutput,
} from "./research-output";

export type SourceRegistryEntry = {
  domain: string;
  denied: boolean;
  tierByClaimType: Record<string, number | undefined>;
  syndicationClusterId?: string | null;
};

export type RetrievedSourceDocument = {
  requestedUrl: string;
  finalUrl: string;
  retrievedAt: string;
  publishedAt: string | null;
  text: string;
  contentSha256: string;
};

export type GroundedEvidence = {
  modelEvidenceId: string;
  canonicalUrl: string;
  domain: string;
  claimType: string;
  aboutTeam: "home" | "away" | "both" | "none";
  quote: string;
  claim: string;
  sourceEventTime: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  trustTier: number;
  quoteVerified: true;
  entailment: "supported" | "unsupported" | "not_checked";
  syndicationClusterId: string | null;
  contentSha256: string;
};

export type GroundingRejection = {
  evidenceId: string;
  reason:
    | "document_missing"
    | "source_denied"
    | "quote_not_found"
    | "published_after_cutoff"
    | "undated_time_sensitive_claim"
    | "invalid_source_timestamp";
};

export type GroundingResult = {
  accepted: GroundedEvidence[];
  rejected: GroundingRejection[];
  requiresEntailmentVerification: string[];
};

const TIME_SENSITIVE_CLAIM_TYPES = new Set([
  "availability",
  "schedule_fatigue",
  "club_coach_news",
  "conditions",
]);

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function domainOf(url: string): string {
  return new URL(url).hostname.toLocaleLowerCase();
}

function matchingRegistryEntry(
  hostname: string,
  entries: SourceRegistryEntry[],
): SourceRegistryEntry | null {
  const candidates = entries
    .map((entry) => ({
      entry,
      domain: entry.domain.toLocaleLowerCase().replace(/^\.+/, ""),
    }))
    .filter(
      ({ domain }) =>
        hostname === domain || hostname.endsWith(`.${domain}`),
    )
    .sort((a, b) => b.domain.length - a.domain.length);

  return candidates[0]?.entry ?? null;
}

function trustTier(
  claimType: string,
  registry: SourceRegistryEntry | null,
): number {
  if (!registry) return 4;

  const specific = registry.tierByClaimType[claimType];
  const fallback = registry.tierByClaimType.default;
  const value = specific ?? fallback ?? 4;

  if (!Number.isInteger(value) || value < 1 || value > 4) return 4;
  return value;
}

function documentMap(
  documents: RetrievedSourceDocument[],
): Map<string, RetrievedSourceDocument> {
  const map = new Map<string, RetrievedSourceDocument>();

  for (const document of documents) {
    for (const url of [document.requestedUrl, document.finalUrl]) {
      try {
        map.set(normalizeEvidenceUrl(url), document);
      } catch {
        // A malformed fetched URL can never match accepted evidence.
      }
    }
  }

  return map;
}

function isIndependent(
  a: GroundedEvidence,
  b: GroundedEvidence,
): boolean {
  if (a.domain === b.domain) return false;

  if (
    a.syndicationClusterId &&
    b.syndicationClusterId &&
    a.syndicationClusterId === b.syndicationClusterId
  ) {
    return false;
  }

  return true;
}

function assertAcceptedReferences(
  ids: string[],
  accepted: Map<string, GroundedEvidence>,
  context: string,
): void {
  for (const id of ids) {
    if (!accepted.has(id)) {
      throw new Error(
        `${context} depends on evidence that failed grounding: ${id}`,
      );
    }
  }
}

export function verifyGroundedResearchEvidence(
  output: SolFixtureResearchOutput,
  card: KapilotoFixtureCard,
  documents: RetrievedSourceDocument[],
  registryEntries: SourceRegistryEntry[],
): GroundingResult {
  const cutoffMs = Date.parse(card.research_cutoff_at);
  if (!Number.isFinite(cutoffMs)) {
    throw new Error("Fixture Card has an invalid research cutoff.");
  }

  const documentsByUrl = documentMap(documents);
  const accepted: GroundedEvidence[] = [];
  const rejected: GroundingRejection[] = [];

  for (const evidence of output.evidence) {
    const canonicalUrl = normalizeEvidenceUrl(evidence.url);
    const document = documentsByUrl.get(canonicalUrl);

    if (!document) {
      rejected.push({
        evidenceId: evidence.evidence_id,
        reason: "document_missing",
      });
      continue;
    }

    const domain = domainOf(normalizeEvidenceUrl(document.finalUrl));
    const registry = matchingRegistryEntry(domain, registryEntries);

    if (registry?.denied) {
      rejected.push({
        evidenceId: evidence.evidence_id,
        reason: "source_denied",
      });
      continue;
    }

    const quote = normalizedText(evidence.quote);
    const sourceText = normalizedText(document.text);
    if (!quote || !sourceText.includes(quote)) {
      rejected.push({
        evidenceId: evidence.evidence_id,
        reason: "quote_not_found",
      });
      continue;
    }

    let publishedAt: string | null = null;
    if (document.publishedAt != null) {
      const publishedMs = Date.parse(document.publishedAt);
      if (!Number.isFinite(publishedMs)) {
        rejected.push({
          evidenceId: evidence.evidence_id,
          reason: "invalid_source_timestamp",
        });
        continue;
      }
      if (publishedMs > cutoffMs) {
        rejected.push({
          evidenceId: evidence.evidence_id,
          reason: "published_after_cutoff",
        });
        continue;
      }
      publishedAt = new Date(publishedMs).toISOString();
    } else if (TIME_SENSITIVE_CLAIM_TYPES.has(evidence.claim_type)) {
      rejected.push({
        evidenceId: evidence.evidence_id,
        reason: "undated_time_sensitive_claim",
      });
      continue;
    }

    const retrievedMs = Date.parse(document.retrievedAt);
    if (!Number.isFinite(retrievedMs)) {
      rejected.push({
        evidenceId: evidence.evidence_id,
        reason: "invalid_source_timestamp",
      });
      continue;
    }

    accepted.push({
      modelEvidenceId: evidence.evidence_id,
      canonicalUrl: normalizeEvidenceUrl(document.finalUrl),
      domain,
      claimType: evidence.claim_type,
      aboutTeam: evidence.about_team,
      quote: evidence.quote,
      claim: evidence.claim,
      sourceEventTime: evidence.event_time,
      publishedAt,
      retrievedAt: new Date(retrievedMs).toISOString(),
      trustTier: trustTier(evidence.claim_type, registry),
      quoteVerified: true,
      entailment: "not_checked",
      syndicationClusterId: registry?.syndicationClusterId ?? null,
      contentSha256: document.contentSha256,
    });
  }

  const acceptedById = new Map(
    accepted.map((item) => [item.modelEvidenceId, item]),
  );

  for (const availability of output.availability) {
    assertAcceptedReferences(
      availability.evidence_ids,
      acceptedById,
      `availability:${availability.player_name}`,
    );
  }

  for (const conflict of output.conflicts) {
    assertAcceptedReferences(
      conflict.evidence_ids_a,
      acceptedById,
      `conflict:${conflict.topic}:a`,
    );
    assertAcceptedReferences(
      conflict.evidence_ids_b,
      acceptedById,
      `conflict:${conflict.topic}:b`,
    );
  }

  if (output.market_deviation) {
    assertAcceptedReferences(
      output.market_deviation.evidence_ids,
      acceptedById,
      "market_deviation",
    );
  }

  const requiresEntailmentVerification = new Set<string>();

  for (const factor of output.factors) {
    assertAcceptedReferences(
      factor.evidence_ids,
      acceptedById,
      `factor:${factor.dimension}`,
    );

    if (factor.magnitude === "small") continue;

    const supporting = factor.evidence_ids
      .map((id) => acceptedById.get(id))
      .filter((item): item is GroundedEvidence => item != null);

    const hasStrongSource = supporting.some((item) => item.trustTier <= 2);
    const hasTwoIndependent =
      supporting.some((left, index) =>
        supporting
          .slice(index + 1)
          .some((right) => isIndependent(left, right)),
      );

    if (!hasStrongSource && !hasTwoIndependent) {
      throw new Error(
        `Material factor ${factor.dimension} lacks strong or independent corroborated evidence.`,
      );
    }

    for (const item of supporting) {
      requiresEntailmentVerification.add(item.modelEvidenceId);
    }
  }

  return {
    accepted,
    rejected,
    requiresEntailmentVerification: [...requiresEntailmentVerification].sort(),
  };
}
