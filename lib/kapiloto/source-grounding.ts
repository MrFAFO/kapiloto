import type { KapilotoFixtureCard } from "./fixture-card";
import { verifyStructuredFactor } from "./structured-refs";
import {
  normalizeEvidenceUrl,
  type SolFixtureResearchOutput,
} from "./research-output";
import { groundResearchV3Items } from "./research-v3-grounding";
import {
  resolveV3TierMap,
  tierFromMap,
  V3_MAX_DISTINCT_EVIDENCE_URLS,
} from "./research-v3-rules";

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
  /**
   * Research v3 only: the domain's resolved tier per claim type, so policy can
   * rate the evidence by the canonical class of the item citing it.
   */
  claimTierMap?: Record<string, number>;
};

export type GroundingRejection = {
  evidenceId: string;
  reason:
    | "unobserved_url"
    | "document_missing"
    | "source_denied"
    | "quote_not_found"
    | "published_after_cutoff"
    | "undated_time_sensitive_claim"
    | "invalid_source_timestamp"
    | "url_cap_exceeded";
};

/** One server-written item-level entailment check (research v3). */
export type GroundingItemEntailmentRequest = {
  verificationId: string;
  evidenceIds: string[];
  claim: string;
};

export type GroundingResult = {
  accepted: GroundedEvidence[];
  rejected: GroundingRejection[];
  requiresEntailmentVerification: string[];
  /** Research v3 item-level checks still to be judged. */
  itemEntailmentRequests?: GroundingItemEntailmentRequest[];
  /** Research v3 item-level verdicts keyed by item verification id. */
  itemEntailmentVerdicts?: Record<string, "supported" | "unsupported">;
  /**
   * Research v3: evidence ids that are unusable for a specific item (for
   * example `factor:2`) because they fail that item's derived provenance or
   * freshness rule, although the evidence row itself was quote-verified.
   */
  itemEvidenceExclusions?: Record<string, string[]>;
  /**
   * Deterministic item-level evidence-policy failures. These do not justify
   * another paid model call: callers must remove unsupported items and only
   * withhold the whole fixture if no supported recommendation signal remains.
   */
  policyFailures?: string[];
};

const TIME_SENSITIVE_CLAIM_TYPES = new Set([
  "availability",
  "schedule_fatigue",
  "club_coach_news",
  "conditions",
  "lineup",
  "formation",
  "tactical_setup",
  "coach_regime",
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

function acceptedReferences(
  ids: string[],
  accepted: Map<string, GroundedEvidence>,
): GroundedEvidence[] {
  return ids
    .map((id) => accepted.get(id))
    .filter((item): item is GroundedEvidence => item != null);
}

export function verifyGroundedResearchEvidence(
  output: SolFixtureResearchOutput,
  card: KapilotoFixtureCard,
  documents: RetrievedSourceDocument[],
  registryEntries: SourceRegistryEntry[],
  observedSourceUrls: string[] | null = null,
): GroundingResult {
  const cutoffMs = Date.parse(card.research_cutoff_at);
  if (!Number.isFinite(cutoffMs)) {
    throw new Error("Fixture Card has an invalid research cutoff.");
  }

  const documentsByUrl = documentMap(documents);
  const observed =
    observedSourceUrls == null
      ? null
      : new Set(observedSourceUrls.map((url) => normalizeEvidenceUrl(url)));
  const accepted: GroundedEvidence[] = [];
  const rejected: GroundingRejection[] = [];
  const isV3 = output.protocol_version === "kapiloto-research-v3";
  const distinctUrls = new Set<string>();

  for (const evidence of output.evidence) {
    const canonicalUrl = normalizeEvidenceUrl(evidence.url);

    if (isV3) {
      distinctUrls.add(canonicalUrl);
      if (distinctUrls.size > V3_MAX_DISTINCT_EVIDENCE_URLS) {
        distinctUrls.delete(canonicalUrl);
        rejected.push({
          evidenceId: evidence.evidence_id,
          reason: "url_cap_exceeded",
        });
        continue;
      }
    }

    if (observed != null && !observed.has(canonicalUrl)) {
      rejected.push({
        evidenceId: evidence.evidence_id,
        reason: "unobserved_url",
      });
      continue;
    }

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
      trustTier: isV3
        ? tierFromMap(
            resolveV3TierMap(registry?.tierByClaimType ?? {}),
            evidence.claim_type,
          )
        : trustTier(evidence.claim_type, registry),
      quoteVerified: true,
      entailment: "not_checked",
      syndicationClusterId: registry?.syndicationClusterId ?? null,
      contentSha256: document.contentSha256,
      ...(isV3
        ? { claimTierMap: resolveV3TierMap(registry?.tierByClaimType ?? {}) }
        : {}),
    });
  }

  const acceptedById = new Map(
    accepted.map((item) => [item.modelEvidenceId, item]),
  );

  const policyFailures: string[] = [];
  const v3 = isV3
    ? groundResearchV3Items(output, card, acceptedById)
    : null;
  if (v3) policyFailures.push(...v3.policyFailures);

  for (const availability of output.availability) {
    const supporting = acceptedReferences(
      availability.evidence_ids,
      acceptedById,
    );
    if (supporting.length !== availability.evidence_ids.length) {
      policyFailures.push(
        `availability:${availability.player_name} has evidence that failed grounding.`,
      );
    }
  }

  for (const conflict of output.conflicts) {
    const left = acceptedReferences(conflict.evidence_ids_a, acceptedById);
    const right = acceptedReferences(conflict.evidence_ids_b, acceptedById);
    if (left.length !== conflict.evidence_ids_a.length) {
      policyFailures.push(
        `conflict:${conflict.topic}:a has evidence that failed grounding.`,
      );
    }
    if (right.length !== conflict.evidence_ids_b.length) {
      policyFailures.push(
        `conflict:${conflict.topic}:b has evidence that failed grounding.`,
      );
    }
  }

  if (output.market_deviation) {
    const supporting = acceptedReferences(
      output.market_deviation.evidence_ids,
      acceptedById,
    );
    if (supporting.length !== output.market_deviation.evidence_ids.length) {
      policyFailures.push(
        "market_deviation has evidence that failed grounding.",
      );
    }
  }

  const requiresEntailmentVerification = new Set<string>();

  for (const [factorIndex, factor] of output.factors.entries()) {
    const excluded = new Set(
      v3?.itemEvidenceExclusions[`factor:${factorIndex}`] ?? [],
    );
    const supporting = acceptedReferences(
      factor.evidence_ids.filter((id) => !excluded.has(id)),
      acceptedById,
    );
    const structured =
      (factor.structured_refs?.length ?? 0) > 0
        ? verifyStructuredFactor(factor, card)
        : null;

    if (supporting.length !== factor.evidence_ids.length) {
      policyFailures.push(
        `factor:${factor.dimension} has evidence that failed grounding.`,
      );
      continue;
    }

    if (structured && !structured.valid) {
      policyFailures.push(
        `factor:${factor.dimension} failed structured verification: ${structured.reason}.`,
      );
      continue;
    }

    if (factor.evidence_ids.length === 0 && !structured?.valid) {
      policyFailures.push(
        `factor:${factor.dimension} has no verified support channel.`,
      );
      continue;
    }

    // Every directional web-backed factor can move p_sol and therefore its
    // web claims require entailment verification. A structured-only small
    // factor is checked deterministically by verifyStructuredFactor instead.
    if (
      factor.favors === "none" &&
      factor.magnitude === "small" &&
      factor.evidence_ids.length === 0
    ) {
      continue;
    }

    if (factor.magnitude !== "small") {
      // V1 deliberately refuses medium/large structured-only effects. When a
      // factor is material, web support still needs the existing strong-source
      // or independent corroboration rule.
      if (factor.evidence_ids.length === 0) {
        policyFailures.push(
          `Material factor ${factor.dimension} requires grounded web corroboration in V1.`,
        );
        continue;
      }

      const hasStrongSource = supporting.some((item) => item.trustTier <= 2);
      const hasTwoIndependent =
        supporting.some((left, index) =>
          supporting
            .slice(index + 1)
            .some((right) => isIndependent(left, right)),
        );

      if (!hasStrongSource && !hasTwoIndependent) {
        policyFailures.push(
          `Material factor ${factor.dimension} lacks strong or independent corroborated evidence.`,
        );
        continue;
      }
    }

    for (const item of supporting) {
      requiresEntailmentVerification.add(item.modelEvidenceId);
    }
  }

  return {
    accepted,
    rejected,
    // Unsupported items are removed individually by the executor. Material
    // factors that remain fully grounded still require entailment verification.
    requiresEntailmentVerification: [
      ...requiresEntailmentVerification,
    ].sort(),
    ...(v3
      ? {
          itemEntailmentRequests: v3.itemEntailmentRequests,
          itemEntailmentVerdicts: {},
          itemEvidenceExclusions: v3.itemEvidenceExclusions,
        }
      : {}),
    policyFailures,
  };
}