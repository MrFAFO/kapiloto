import type { KapilotoFixtureCard } from "./fixture-card";
import { verifyStructuredFactor } from "./structured-refs";
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
    | "unobserved_url"
    | "document_missing"
    | "source_denied"
    | "quote_not_found"
    | "published_after_cutoff"
    | "undated_time_sensitive_claim"
    | "stale_time_sensitive_claim"
    | "invalid_source_timestamp";
};

export type GroundingItemEntailmentRequest = {
  verificationId: string;
  evidenceIds: string[];
  claim: string;
};

export type GroundingResult = {
  accepted: GroundedEvidence[];
  rejected: GroundingRejection[];
  requiresEntailmentVerification: string[];
  itemEntailmentRequests?: GroundingItemEntailmentRequest[];
  itemEntailmentVerdicts?: Record<string, "supported" | "unsupported">;
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

const DAY_MS = 86_400_000;

function v3MaxAgeMs(claimType: string): number | null {
  switch (claimType) {
    case "lineup":
    case "formation":
      return 7 * DAY_MS;
    case "availability":
    case "schedule_fatigue":
      return 14 * DAY_MS;
    case "conditions":
      return 7 * DAY_MS;
    case "tactical_setup":
      return 45 * DAY_MS;
    case "coach_regime":
    case "club_coach_news":
      return 180 * DAY_MS;
    default:
      return null;
  }
}

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

  for (const evidence of output.evidence) {
    const canonicalUrl = normalizeEvidenceUrl(evidence.url);

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
      if (output.protocol_version === "kapiloto-research-v3") {
        const maxAgeMs = v3MaxAgeMs(evidence.claim_type);
        if (maxAgeMs != null && cutoffMs - publishedMs > maxAgeMs) {
          rejected.push({
            evidenceId: evidence.evidence_id,
            reason: "stale_time_sensitive_claim",
          });
          continue;
        }

        if (
          (evidence.claim_type === "lineup" ||
            evidence.claim_type === "formation") &&
          (evidence.about_team === "home" || evidence.about_team === "away")
        ) {
          const lastMatchAt =
            card.structured.structured_snapshot?.features[evidence.about_team]
              .form?.last_match_at ?? null;
          const lastMatchMs =
            lastMatchAt == null ? null : Date.parse(lastMatchAt);
          if (
            lastMatchMs != null &&
            Number.isFinite(lastMatchMs) &&
            publishedMs < lastMatchMs
          ) {
            rejected.push({
              evidenceId: evidence.evidence_id,
              reason: "stale_time_sensitive_claim",
            });
            continue;
          }
        }
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

  const policyFailures: string[] = [];
  const itemEntailmentRequests: GroundingItemEntailmentRequest[] = [];

  const teamName = (side: "home" | "away") =>
    card.teams[side].names[0] ?? side;
  const evidenceUsableFor = (
    ids: string[],
    side: "home" | "away" | null,
    allowedTypes: readonly string[],
    label: string,
  ): GroundedEvidence[] | null => {
    const supporting = acceptedReferences(ids, acceptedById);
    if (supporting.length !== ids.length) {
      policyFailures.push(`${label} has evidence that failed grounding.`);
      return null;
    }
    if (
      supporting.some(
        (item) =>
          !allowedTypes.includes(item.claimType) ||
          (side != null &&
            item.aboutTeam !== side &&
            item.aboutTeam !== "both"),
      )
    ) {
      policyFailures.push(`${label} has incompatible evidence provenance.`);
      return null;
    }
    return supporting;
  };
  const addItemRequest = (
    verificationId: string,
    evidenceIds: string[],
    claim: string,
  ) => {
    itemEntailmentRequests.push({
      verificationId,
      evidenceIds: [...new Set(evidenceIds)].sort(),
      claim,
    });
  };

  if (output.protocol_version === "kapiloto-research-v3") {
    for (const side of ["home", "away"] as const) {
      const lineup = output.expected_lineups?.[side];
      if (lineup?.formation) {
        const supporting = evidenceUsableFor(
          lineup.formation_evidence_ids,
          side,
          ["lineup", "formation"],
          `lineup:${side}:formation`,
        );
        if (
          supporting &&
          supporting.some(
            (item) =>
              !normalizedText(item.quote).includes(
                normalizedText(lineup.formation ?? ""),
              ),
          )
        ) {
          policyFailures.push(
            `lineup:${side}:formation quote does not contain the formation.`,
          );
        } else if (supporting) {
          addItemRequest(
            `lineup:${side}:formation`,
            lineup.formation_evidence_ids,
            `${teamName(side)} is expected to line up in ${lineup.formation}.`,
          );
        }
      }

      for (let index = 0; index < (lineup?.starters.length ?? 0); index += 1) {
        const starter = lineup!.starters[index];
        const label = `lineup:${side}:starter:${index}`;
        const supporting = evidenceUsableFor(
          starter.evidence_ids,
          side,
          ["lineup", "availability"],
          label,
        );
        if (
          supporting &&
          supporting.some(
            (item) =>
              !normalizedText(item.quote).includes(
                normalizedText(starter.player_name),
              ),
          )
        ) {
          policyFailures.push(
            `${label} quote does not contain the player name.`,
          );
        } else if (supporting) {
          addItemRequest(
            label,
            starter.evidence_ids,
            `${starter.player_name} is expected to start for ${teamName(side)}.`,
          );
        }
      }
    }

    for (let index = 0; index < output.availability.length; index += 1) {
      const item = output.availability[index];
      const functions = item.functions ?? [];
      const functionEvidenceIds = item.function_evidence_ids ?? [];
      if (functions.length === 0) continue;
      const label = `availability:functions:${index}`;
      const supporting = evidenceUsableFor(
        functionEvidenceIds,
        item.team,
        ["availability", "tactical_setup", "club_coach_news"],
        label,
      );
      if (
        supporting &&
        supporting.some(
          (evidence) =>
            !normalizedText(evidence.quote).includes(
              normalizedText(item.player_name),
            ),
        )
      ) {
        policyFailures.push(
          `${label} quote does not contain the player name.`,
        );
      } else if (supporting) {
        addItemRequest(
          label,
          functionEvidenceIds,
          `${item.player_name} performs the ${functions.join(" and ")} function for ${teamName(item.team)}.`,
        );
      }
    }

    for (const fact of output.tactical_facts ?? []) {
      const label = `tactical_fact:${fact.fact_id}`;
      const supporting = evidenceUsableFor(
        fact.evidence_ids,
        fact.team,
        ["tactical_setup", "formation"],
        label,
      );
      if (supporting) {
        addItemRequest(
          label,
          fact.evidence_ids,
          `${teamName(fact.team)}: ${fact.phase} ${fact.attribute} is ${fact.value}.`,
        );
      }
    }

    for (const matchup of output.matchup_analysis ?? []) {
      const relatedFacts = (output.tactical_facts ?? []).filter((fact) =>
        matchup.fact_ids.includes(fact.fact_id),
      );
      const evidenceIds = [
        ...matchup.evidence_ids,
        ...relatedFacts.flatMap((fact) => fact.evidence_ids),
      ];
      const supporting = evidenceUsableFor(
        [...new Set(evidenceIds)],
        null,
        [
          "tactical_setup",
          "formation",
          "availability",
          "coach_regime",
          "club_coach_news",
        ],
        `matchup:${matchup.matchup_id}`,
      );
      if (supporting) {
        addItemRequest(
          `matchup:${matchup.matchup_id}`,
          evidenceIds,
          `${matchup.description} The interaction favors ${matchup.favors} with ${matchup.magnitude} magnitude.`,
        );
      }
    }

    for (let index = 0; index < (output.regime_changes?.length ?? 0); index += 1) {
      const regime = output.regime_changes![index];
      const label = `regime:${index}`;
      const supporting = evidenceUsableFor(
        regime.evidence_ids,
        regime.team,
        ["coach_regime", "club_coach_news", "formation"],
        label,
      );
      if (supporting) {
        addItemRequest(
          label,
          regime.evidence_ids,
          `${teamName(regime.team)} had a ${regime.type} effective ${regime.effective_date}.`,
        );
      }
    }
  }

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

  for (const factor of output.factors) {
    const supporting = acceptedReferences(
      factor.evidence_ids,
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
    itemEntailmentRequests,
    itemEntailmentVerdicts: {},
    policyFailures,
  };
}