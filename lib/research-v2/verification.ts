import type { StructuredAvailability } from "./base";
import {
  AVAILABILITY_CLAIM_KINDS,
  type DiscoveryEvidenceItem,
  type EvidenceClaimKind,
} from "./evidence";
import type { ClaimKindV2, DiscoveryClaim } from "./discovery-contract";
import {
  assessDocumentDates,
  latestPossibleInstantMs,
  type CutoffVerdict,
  type DatePrecision,
  type DateRejection,
  type DocumentDates,
  type DocumentDatesConfig,
} from "./document-dates";
import { checkEvidenceWindow, type CitationEvidence } from "./evidence-window";
import { isForecastChangingKind } from "./impact-rules";
import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";
import type { FetchFailure } from "./safe-fetch";
import { assessSourceV2, originKey, type CitationAttribution, type SourceQualityConfig, type SourceQualityVector } from "./source-quality";
import type { SourceRegistrySeedEntry } from "./source-registry";
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

// =============================================================================
// verification-v2 (D-047): every citation is checked independently against
// stored documents, evidence windows, the knowledge cutoff and the effective
// registry; rejected citations drop out without affecting other citations.
// Pure and network-free: the same stored inputs give bit-identical results.
// =============================================================================

export type VerificationConfigV2 = VersionedConfig & {
  /** Oldest a claim may be at the knowledge cutoff, per claim kind, in hours. */
  maxAgeHoursByKind: Record<ClaimKindV2, number>;
};

export const CANDIDATE_VERIFICATION_V2: VerificationConfigV2 = {
  id: "research-v2-verification",
  version: "verification-v2",
  status: "candidate",
  maxAgeHoursByKind: {
    absence: 120,
    suspension: 240,
    doubtful: 72,
    expected_return: 120,
    rotation_statement: 72,
    lineup_confirmed: 6,
    schedule_disruption: 168,
    manager_change: 720,
    squad_change: 720,
    shape_change: 168,
    other_context: 168,
  },
};

/** What the capture stored for one fetched URL (no article body). */
export type StoredDocumentV2 = {
  requestedUrl: string;
  fetch:
    | { ok: true; finalUrl: string; status: number; contentType: string; bytes: number; bodySha256: string; retrievedAt: string }
    | { ok: false; reason: FetchFailure; detail: string | null };
  documentTextSha256: string | null;
  dates: DocumentDates | null;
  byline: string | null;
};

/** One citation as captured: its URL and, when the quote was found, the stored evidence window. */
export type CitationCaptureV2 = { claimId: string; citationIndex: number; url: string; quote: string; evidence: CitationEvidence | null };

export type EntailmentVerdictV2 = "entailed" | "contradicted" | "not_enough_info" | "error";

/** Entailment-judge result for one claim × citation (injected; the judge is not called in this slice). */
export type EntailmentInputV2 = {
  verdict: EntailmentVerdictV2;
  supportSpan: string | null;
  attribution: CitationAttribution;
  squadStatusSupported: boolean;
  namedPlayersSupported: string[];
};

export type CitationRejectionV2 =
  | "url_not_observed"
  | "not_fetched"
  | "fetch_blocked"
  | "page_not_retrieved"
  | "retrieved_after_evidence_cutoff"
  | DateRejection
  | "stale_for_claim_kind"
  | "quote_not_found"
  | "window_integrity_failed"
  | "entity_not_in_window"
  | "source_denied"
  | "entailment_missing"
  | "entailment_unsupported"
  | "support_span_invalid";

export type CitationCheckV2 = {
  citationId: string;
  claimId: string;
  citationIndex: number;
  url: string;
  canonicalUrl: string;
  observed: boolean;
  fetch: { attempted: boolean; ok: boolean; reason: FetchFailure | null; finalUrl: string | null; retrievedAt: string | null };
  retrievedBeforeEvidenceCutoff: boolean | null;
  dates: {
    published: CutoffVerdict | null;
    modified: CutoffVerdict | null;
    /** Earliest possible publication instant (market timing, freshness). */
    evidenceTimeMs: number | null;
    publishedPrecision: DatePrecision | null;
    /** Latest possible publication instant (time ordering for supersession). */
    latestPublicationMs: number | null;
  };
  freshness: { maxAgeHours: number; ageHours: number | null; fresh: boolean | null };
  quote: { found: boolean; occurrences: number; windowHashOk: boolean | null; offsetsOk: boolean | null; documentHashOk: boolean | null };
  entity: { name: string; inWindow: boolean | null };
  entailment: { required: boolean; verdict: EntailmentVerdictV2 | "missing"; spanValid: boolean | null };
  source: SourceQualityVector;
  status: "accepted" | "rejected";
  rejections: CitationRejectionV2[];
};

const BLOCKED_FETCH: ReadonlySet<FetchFailure> = new Set([
  "unsupported_scheme",
  "credentials_in_url",
  "ip_literal_host",
  "blocked_hostname",
  "port_not_allowed",
  "resolves_to_blocked_address",
]);

/** Without a judge record (explanatory claims), reporting is treated as secondary with no origin. */
const UNKNOWN_ATTRIBUTION: CitationAttribution = { reporting: "secondary", directQuote: false, citedOrigin: { type: "none", name: null, date: null } };

export const citationIdOf = (claimId: string, citationIndex: number) => `${claimId}#${citationIndex}`;

const normalizeSubject = (value: string) =>
  value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Stable subject key: side + subject type + normalized name (English name when given). */
export function subjectKeyV2(claim: DiscoveryClaim): string {
  return [claim.side, claim.subject.type, normalizeSubject(claim.subject.name_normalized_en ?? claim.subject.name_in_source)].join(":");
}

function publicationBounds(dates: DocumentDates | null, config: DocumentDatesConfig): { precision: DatePrecision | null; latest: number | null } {
  const candidates = dates?.published?.candidates ?? [];
  if (candidates.length === 0) return { precision: null, latest: null };
  return { precision: candidates[0].precision, latest: Math.max(...candidates.map((item) => latestPossibleInstantMs(item, config))) };
}

function parseIsoOrThrow(value: string, field: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("Invalid " + field + ": " + value);
  return ms;
}

const NO_DATES: DocumentDates = { published: null, modified: null, allCandidates: [] };

/** Citation-level verification of every citation of every claim. */
export function verifyCitationsV2(input: {
  claims: readonly DiscoveryClaim[];
  citations: readonly CitationCaptureV2[];
  documents: readonly StoredDocumentV2[];
  observedUrls: readonly string[];
  entailment: Readonly<Record<string, EntailmentInputV2>>;
  clubKeys: { home: string; away: string };
  knowledgeCutoffAt: string;
  evidenceCutoffAt: string;
  /** Must be the effective registry (effectiveRegistryEntries). */
  registry: readonly SourceRegistrySeedEntry[];
  configs: { verification: VerificationConfigV2; sourceQuality: SourceQualityConfig; dates: DocumentDatesConfig };
}): CitationCheckV2[] {
  const knowledgeMs = parseIsoOrThrow(input.knowledgeCutoffAt, "knowledgeCutoffAt");
  const evidenceMs = parseIsoOrThrow(input.evidenceCutoffAt, "evidenceCutoffAt");
  if (evidenceMs < knowledgeMs) throw new Error("verifyCitationsV2: evidenceCutoffAt precedes knowledgeCutoffAt");
  const observed = new Set(input.observedUrls.map(canonicalEvidenceUrl));
  const documents = new Map(input.documents.map((document) => [canonicalEvidenceUrl(document.requestedUrl), document]));
  const claims = new Map(input.claims.map((claim) => [claim.claim_id, claim]));

  return [...input.citations]
    .sort((a, b) => a.claimId.localeCompare(b.claimId) || a.citationIndex - b.citationIndex)
    .map((citation): CitationCheckV2 => {
      const claim = claims.get(citation.claimId);
      if (!claim) throw new Error("verifyCitationsV2: citation for unknown claim " + citation.claimId);
      const citationId = citationIdOf(citation.claimId, citation.citationIndex);
      const canonicalUrl = canonicalEvidenceUrl(citation.url);
      const rejections: CitationRejectionV2[] = [];

      const isObserved = observed.has(canonicalUrl);
      if (!isObserved) rejections.push("url_not_observed");

      const document = documents.get(canonicalUrl) ?? null;
      const fetched = document && document.fetch.ok ? document.fetch : null;
      if (!document) rejections.push("not_fetched");
      else if (!document.fetch.ok) rejections.push(BLOCKED_FETCH.has(document.fetch.reason) ? "fetch_blocked" : "page_not_retrieved");
      const retrievedBefore = fetched ? Date.parse(fetched.retrievedAt) <= evidenceMs : null;
      if (retrievedBefore === false) rejections.push("retrieved_after_evidence_cutoff");

      const dateAssessment = fetched ? assessDocumentDates(document?.dates ?? NO_DATES, input.knowledgeCutoffAt, input.configs.dates) : null;
      if (dateAssessment) rejections.push(...dateAssessment.rejections);
      const bounds = publicationBounds(document?.dates ?? null, input.configs.dates);
      const maxAgeHours = input.configs.verification.maxAgeHoursByKind[claim.claim_kind];
      const ageHours = dateAssessment?.evidenceTimeMs != null ? (knowledgeMs - dateAssessment.evidenceTimeMs) / 3_600_000 : null;
      const fresh = ageHours == null ? null : ageHours <= maxAgeHours;
      if (fresh === false) rejections.push("stale_for_claim_kind");

      const window = citation.evidence?.window ?? null;
      const windowCheck = window ? checkEvidenceWindow(window, { quote: citation.quote, entityName: claim.subject.name_in_source }) : null;
      const documentHashOk = window ? document?.documentTextSha256 != null && window.documentTextSha256 === document.documentTextSha256 : null;
      if (fetched) {
        if (!citation.evidence?.quoteFound || !window) rejections.push("quote_not_found");
        else if (!windowCheck?.hashMatches || !windowCheck.quoteAtOffsets || !documentHashOk) rejections.push("window_integrity_failed");
        else if (windowCheck.entityInWindow === false) rejections.push("entity_not_in_window");
      }

      const required = isForecastChangingKind(claim.claim_kind);
      const judged = input.entailment[citationId] ?? null;
      const spanValid =
        judged && judged.verdict === "entailed" && window
          ? judged.supportSpan != null && checkEvidenceWindow(window, { quote: citation.quote, supportSpan: judged.supportSpan }).spanInWindow === true
          : null;
      // The judge sees only citations that passed every deterministic pre-check.
      const precheckPassed = rejections.length === 0;
      if (required && precheckPassed) {
        if (!judged) rejections.push("entailment_missing");
        else if (judged.verdict !== "entailed") rejections.push("entailment_unsupported");
        else if (spanValid !== true) rejections.push("support_span_invalid");
      }

      const attribution = judged?.attribution ?? UNKNOWN_ATTRIBUTION;
      const clubKey = input.clubKeys[claim.side];
      const origin = originKey(attribution.citedOrigin, {
        clubKey,
        subjectKey: subjectKeyV2(claim),
        fallbackDate: dateAssessment?.evidenceTimeMs != null ? new Date(dateAssessment.evidenceTimeMs).toISOString() : null,
      });
      const source = assessSourceV2(
        { url: fetched?.finalUrl ?? citation.url, byline: document?.byline ?? null, attribution, clubKey, originKey: origin },
        input.registry,
        input.configs.sourceQuality,
      );
      if (source.denied) rejections.push("source_denied");

      return {
        citationId,
        claimId: citation.claimId,
        citationIndex: citation.citationIndex,
        url: citation.url,
        canonicalUrl,
        observed: isObserved,
        fetch: {
          attempted: document != null,
          ok: fetched != null,
          reason: document && !document.fetch.ok ? document.fetch.reason : null,
          finalUrl: fetched?.finalUrl ?? null,
          retrievedAt: fetched?.retrievedAt ?? null,
        },
        retrievedBeforeEvidenceCutoff: retrievedBefore,
        dates: {
          published: dateAssessment?.publishedVerdict ?? null,
          modified: dateAssessment?.modifiedVerdict ?? null,
          evidenceTimeMs: dateAssessment?.evidenceTimeMs ?? null,
          publishedPrecision: bounds.precision,
          latestPublicationMs: bounds.latest,
        },
        freshness: { maxAgeHours, ageHours, fresh },
        quote: {
          found: citation.evidence?.quoteFound === true,
          occurrences: citation.evidence?.occurrences ?? 0,
          windowHashOk: windowCheck?.hashMatches ?? null,
          offsetsOk: windowCheck?.quoteAtOffsets ?? null,
          documentHashOk,
        },
        entity: { name: claim.subject.name_in_source, inWindow: windowCheck?.entityInWindow ?? null },
        entailment: { required, verdict: judged?.verdict ?? "missing", spanValid },
        source,
        status: rejections.length === 0 ? "accepted" : "rejected",
        rejections,
      };
    });
}
