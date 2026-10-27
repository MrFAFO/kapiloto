import type { DiscoveryClaim } from "./discovery-contract";
import { DOCUMENT_DATES_CONFIG, extractDocumentDates } from "./document-dates";
import { buildCitationEvidence, sha256Text } from "./evidence-window";
import { extractHtml } from "./html-extract";
import { CANDIDATE_SOURCE_QUALITY, type CitationAttribution } from "./source-quality";
import { effectiveRegistryEntries, REGISTRY_TEAMS } from "./source-registry";
import {
  CANDIDATE_VERIFICATION_V2,
  type CitationCaptureV2,
  type EntailmentInputV2,
  type StoredDocumentV2,
} from "./verification";

/** Synthetic, network-free fixtures for verification-v2 tests (Hull v Brentford). */

export const KNOWLEDGE_CUTOFF = "2026-10-25T08:00:00.000Z";
export const EVIDENCE_CUTOFF = "2026-10-25T08:05:00.000Z";
export const CLUB_KEYS = { home: REGISTRY_TEAMS.hull, away: REGISTRY_TEAMS.brentford };
export const REGISTRY = effectiveRegistryEntries();
export const VERIFY_CONFIGS = { verification: CANDIDATE_VERIFICATION_V2, sourceQuality: CANDIDATE_SOURCE_QUALITY, dates: DOCUMENT_DATES_CONFIG };

export const hoursBefore = (hours: number) => new Date(Date.parse(KNOWLEDGE_CUTOFF) - hours * 3_600_000).toISOString();

export type PageSpec = {
  url: string;
  text: string;
  published?: string | null;
  modified?: string | null;
  byline?: string | null;
  retrievedAt?: string;
  fetchFailure?: StoredDocumentV2["fetch"] & { ok: false };
};

/** A stored document as the capture would persist it (no body), plus the transient text. */
export function storedPage(spec: PageSpec): { document: StoredDocumentV2; text: string } {
  const head = [
    spec.published === undefined ? `<meta property="article:published_time" content="${hoursBefore(2)}">` : spec.published ? `<meta property="article:published_time" content="${spec.published}">` : "",
    spec.modified ? `<meta property="article:modified_time" content="${spec.modified}">` : "",
    spec.byline ? `<meta name="author" content="${spec.byline}">` : "",
  ].join("");
  const extracted = extractHtml(`<html><head>${head}</head><body><p>${spec.text}</p></body></html>`);
  if (spec.fetchFailure) {
    return { document: { requestedUrl: spec.url, fetch: spec.fetchFailure, documentTextSha256: null, dates: null, byline: null }, text: extracted.text };
  }
  return {
    text: extracted.text,
    document: {
      requestedUrl: spec.url,
      fetch: { ok: true, finalUrl: spec.url, status: 200, contentType: "text/html", bytes: spec.text.length, bodySha256: sha256Text(spec.text), retrievedAt: spec.retrievedAt ?? "2026-10-25T08:01:00.000Z" },
      documentTextSha256: sha256Text(extracted.text),
      dates: extractDocumentDates(extracted),
      byline: spec.byline ?? null,
    },
  };
}

export function claim(overrides: Partial<DiscoveryClaim> & { subjectName?: string } = {}): DiscoveryClaim {
  const { subjectName, ...rest } = overrides;
  const name = subjectName ?? "John Keeper";
  return {
    claim_id: "C1",
    need_id: "availability_rotation_check:home",
    claim_kind: "absence",
    side: "home",
    subject: { type: "player", name_in_source: name, name_normalized_en: name, role: "goalkeeper", squad_status_claimed: "first_choice", squad_status_quote: null, named_players: [] },
    claim: `${name} is ruled out of the match.`,
    stated_status: "confirmed",
    applies_to_this_fixture: true,
    event_time: null,
    observation: "reported",
    extraction_confidence: "high",
    corroboration_claimed: false,
    citations: [],
    ...rest,
  };
}

export const PRIMARY: CitationAttribution = { reporting: "primary", directQuote: false, citedOrigin: { type: "none", name: null, date: null } };

export function entailed(supportSpan: string, overrides: Partial<EntailmentInputV2> = {}): EntailmentInputV2 {
  return { verdict: "entailed", supportSpan, attribution: PRIMARY, squadStatusSupported: true, namedPlayersSupported: [], ...overrides };
}

/** Builds documents, citations and observed URLs for a claim from page specs and quotes. */
export function evidenceFor(claimId: string, items: Array<{ page: PageSpec; quote: string; observed?: boolean; tamper?: boolean }>) {
  const documents: StoredDocumentV2[] = [];
  const citations: CitationCaptureV2[] = [];
  const observedUrls: string[] = [];
  items.forEach((item, citationIndex) => {
    const { document, text } = storedPage(item.page);
    documents.push(document);
    if (item.observed !== false) observedUrls.push(item.page.url);
    let evidence = item.page.fetchFailure ? null : buildCitationEvidence(text, item.quote);
    if (evidence?.window && item.tamper) evidence = { ...evidence, window: { ...evidence.window, text: evidence.window.text.replace(/o/g, "0") } };
    citations.push({ claimId, citationIndex, url: item.page.url, quote: item.quote, evidence });
  });
  return { documents, citations, observedUrls };
}
