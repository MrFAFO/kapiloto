import { createHash } from "node:crypto";

import { DOCUMENT_VERSION_CONTRACT_VERSION } from "./versions";

/**
 * Document archive contracts (V4 Foundation 1B).
 *
 * A DOCUMENT is the stable identity of source material Kapiloto actually
 * observed (an article URL, a provider object, a social post). A DOCUMENT
 * VERSION is one immutable observation of it. Re-fetching identical content
 * returns the existing version; a changed page (text, title, byline,
 * published time or rights) is a new version. Raw bytes (HTML, audio, video)
 * live in external object storage and are referenced by URI and hash.
 */

export const DOCUMENT_SOURCE_KINDS = [
  "news_article",
  "official_announcement",
  "federation_page",
  "provider_response",
  "social_post",
  "podcast_transcript",
  "video_transcript",
  "press_conference_transcript",
  "other",
] as const;
export type DocumentSourceKind = (typeof DOCUMENT_SOURCE_KINDS)[number];

/**
 * Why Kapiloto holds the material. Rights are provenance, not a legal-policy
 * engine: they record what was known about permission at fetch time.
 */
export const ACCESS_BASES = [
  "public_web",
  "licensed",
  "provider_contract",
  "user_supplied",
  "internal_only",
  "transcript_authorized",
  "unknown",
  "restricted",
] as const;
export type AccessBasis = (typeof ACCESS_BASES)[number];

/** Optional research-discovery hook (no planner in Foundation 1B). */
export const DISCOVERY_CHANNELS = [
  "search",
  "feed",
  "provider_api",
  "crawl",
  "link_follow",
  "manual",
  "user_submitted",
  "unknown",
] as const;
export type DiscoveryChannel = (typeof DISCOVERY_CHANNELS)[number];

/** Inline extracted-text bound; longer material is stored externally. */
export const DOCUMENT_TEXT_MAX_CHARS = 200_000;

export type DocumentRights = {
  accessBasis: AccessBasis;
  /** Raw bytes may be kept (in external storage). */
  mayRetainRaw: boolean;
  /** Extracted text and verbatim excerpts may be kept. */
  mayRetainText: boolean;
  /** Excerpts may be shown to end users. */
  mayExposeExcerpts: boolean;
  rightsNote?: string | null;
};

export type DocumentVersionInput = {
  sourceKind: DocumentSourceKind;
  /** Identity: an external id (provider/platform) wins over the URL. */
  canonicalUrl?: string | null;
  provider?: string | null;
  platform?: string | null;
  externalId?: string | null;
  domain?: string | null;
  publisher?: string | null;
  /** Social handle, channel or journalist account, for reliability stats. */
  sourceAccount?: string | null;
  title?: string | null;
  author?: string | null;
  languageCode?: string | null;
  publishedAt?: string | null;
  sourceUpdatedAt?: string | null;
  retrievedAt: string;
  /**
   * The normalized text Kapiloto read. It is always hashed; it is retained
   * only when rights allow and it fits DOCUMENT_TEXT_MAX_CHARS.
   */
  extractedText: string;
  rawContentSha256?: string | null;
  rawContentUri?: string | null;
  extractionVersion: string;
  syndicationCluster?: string | null;
  rights: DocumentRights;
  discovery?: {
    channel: DiscoveryChannel;
    querySha256?: string | null;
    rank?: number | null;
    discoveredAt?: string | null;
  };
  ingestVersion: string;
  metadata?: Record<string, unknown>;
};

export type RecordDocumentVersionResult = {
  status: "recorded" | "unchanged";
  document_id: string;
  document_version_id: string;
  version_no: number;
  first_seen_at: string;
};

/** SHA-256 of the UTF-8 text; the database verifies it for retained text. */
export function documentContentSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Mirrors knowledge_documents.identity_key. */
export function documentIdentityKey(
  input: Pick<DocumentVersionInput, "canonicalUrl" | "provider" | "platform" | "externalId">,
): string | null {
  const namespace = input.provider ?? input.platform ?? null;
  if (input.externalId && namespace) return `ext:${namespace}:${input.externalId}`;
  return input.canonicalUrl ? `url:${input.canonicalUrl}` : null;
}

function retainedText(input: DocumentVersionInput): string | null {
  return input.rights.mayRetainText && input.extractedText.length <= DOCUMENT_TEXT_MAX_CHARS
    ? input.extractedText
    : null;
}

export function validateDocumentVersion(input: DocumentVersionInput): string[] {
  const issues: string[] = [];
  if (!documentIdentityKey(input)) issues.push("a document needs a canonical URL or a provider/platform external id");
  if (input.rawContentUri && !input.rights.mayRetainRaw) issues.push("raw content may not be retained under these rights");
  if (input.rights.mayExposeExcerpts && ["unknown", "restricted"].includes(input.rights.accessBasis)) {
    issues.push("excerpts cannot be exposed when rights are unknown or restricted");
  }
  if (input.discovery && input.discovery.channel !== "search" && (input.discovery.querySha256 || input.discovery.rank)) {
    issues.push("search query and rank apply to search discovery only");
  }
  return issues;
}

/** Maps the camelCase input to the RPC payload. */
export function buildDocumentVersionPayload(input: DocumentVersionInput): Record<string, unknown> {
  return {
    contract_version: DOCUMENT_VERSION_CONTRACT_VERSION,
    source_kind: input.sourceKind,
    canonical_url: input.canonicalUrl ?? null,
    provider: input.provider ?? null,
    platform: input.platform ?? null,
    external_id: input.externalId ?? null,
    domain: input.domain ?? null,
    publisher: input.publisher ?? null,
    source_account: input.sourceAccount ?? null,
    title: input.title ?? null,
    author: input.author ?? null,
    language_code: input.languageCode ?? null,
    published_at: input.publishedAt ?? null,
    source_updated_at: input.sourceUpdatedAt ?? null,
    retrieved_at: input.retrievedAt,
    content_sha256: documentContentSha256(input.extractedText),
    raw_content_sha256: input.rawContentSha256 ?? null,
    raw_content_uri: input.rawContentUri ?? null,
    extracted_text: retainedText(input),
    extraction_version: input.extractionVersion,
    syndication_cluster: input.syndicationCluster ?? null,
    access_basis: input.rights.accessBasis,
    may_retain_raw: input.rights.mayRetainRaw,
    may_retain_text: input.rights.mayRetainText,
    may_expose_excerpts: input.rights.mayExposeExcerpts,
    rights_note: input.rights.rightsNote ?? null,
    discovery_channel: input.discovery?.channel ?? null,
    discovery_query_sha256: input.discovery?.querySha256 ?? null,
    discovery_rank: input.discovery?.rank ?? null,
    discovered_at: input.discovery?.discoveredAt ?? null,
    ingest_version: input.ingestVersion,
    metadata: input.metadata ?? {},
  };
}
