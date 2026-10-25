import type { ExtractedHtml } from "./html-extract";
import type { VersionedConfig } from "./provenance";

/**
 * Publication and modification times of a fetched document (D-047).
 * `publishedAt` and `modifiedAt` are extracted separately, each with its
 * method, precision and location; `modifiedAt` never substitutes for
 * `publishedAt`. Existence before the knowledge cutoff is proven only when it
 * holds under every publisher-timezone reading; market timing uses the
 * earliest possible instant, so ambiguity leans to "already incorporated".
 */

export type DocumentDatesConfig = VersionedConfig & {
  /** Latest civil timezone offset (hours): a local reading can be this far behind UTC. */
  latestZoneOffsetHours: number;
  /** Earliest civil timezone offset (hours): a local reading can be this far ahead of UTC. */
  earliestZoneOffsetHours: number;
};

export const DOCUMENT_DATES_CONFIG: DocumentDatesConfig = {
  id: "research-v2-document-dates",
  version: "document-dates-v1",
  status: "candidate",
  latestZoneOffsetHours: -12,
  earliestZoneOffsetHours: 14,
};

export type DateField = "published" | "modified";
export type DatePrecision = "datetime_tz" | "datetime_no_tz" | "date";
export type DateMethod = "jsonld_article" | "jsonld_other" | "meta" | "time_element";

export type DateCandidate = {
  field: DateField;
  method: DateMethod;
  /** Where it was found, e.g. `jsonld[0].@graph[1].datePublished` or `meta[article:published_time]#0`. */
  location: string;
  raw: string;
  /** Null when the raw value is not a supported ISO 8601 form. */
  precision: DatePrecision | null;
  /** Normalized value: ISO instant for datetime_tz, local `YYYY-MM-DDTHH:MM:SS` for datetime_no_tz, `YYYY-MM-DD` for date. */
  normalized: string | null;
};

export type ResolvedDate = {
  field: DateField;
  /** The candidate(s) of the highest-priority method that parsed; several when they disagree. */
  candidates: DateCandidate[];
  conflict: boolean;
};

export type DocumentDates = {
  published: ResolvedDate | null;
  modified: ResolvedDate | null;
  /** Every candidate found, parsed or not, for audit. */
  allCandidates: DateCandidate[];
};

const ARTICLE_TYPES = new Set(["article", "newsarticle", "reportagenewsarticle", "analysisnewsarticle", "blogposting", "liveblogposting", "sportsarticle", "report"]);
const META_KEYS: Record<DateField, string[]> = {
  published: ["article:published_time", "og:published_time", "datepublished", "pubdate", "publish-date", "parsely-pub-date", "dc.date.issued"],
  modified: ["article:modified_time", "og:updated_time", "datemodified", "last-modified", "dc.date.modified"],
};
const JSONLD_KEYS: Record<DateField, string> = { published: "datePublished", modified: "dateModified" };
const TIME_ITEMPROP: Record<DateField, string> = { published: "datepublished", modified: "datemodified" };
const METHOD_PRIORITY: DateMethod[] = ["jsonld_article", "meta", "time_element", "jsonld_other"];

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/i;

function validCalendar(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Parses the supported ISO 8601 forms; anything else is unsupported (precision null). */
export function parseDateValue(raw: string): { precision: DatePrecision; normalized: string } | null {
  const value = raw.trim();
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return validCalendar(+y, +m, +d) ? { precision: "date", normalized: `${y}-${m}-${d}` } : null;
  }
  const match = DATE_TIME.exec(value);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss = "00", fraction, zone] = match;
  if (!validCalendar(+y, +m, +d) || +hh > 23 || +mm > 59 || +ss > 59) return null;
  // Millisecond precision is kept so a value 1 ms after the cutoff is never read as at the cutoff.
  const millis = fraction ? `.${fraction.padEnd(3, "0").slice(0, 3)}` : "";
  const local = `${y}-${m}-${d}T${hh}:${mm}:${ss}${millis}`;
  if (!zone) return { precision: "datetime_no_tz", normalized: local };
  const offset = zone.toUpperCase() === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const ms = Date.parse(`${local}${offset}`);
  return Number.isFinite(ms) ? { precision: "datetime_tz", normalized: new Date(ms).toISOString() } : null;
}

function candidate(field: DateField, method: DateMethod, location: string, raw: string): DateCandidate {
  const parsed = typeof raw === "string" ? parseDateValue(raw) : null;
  return { field, method, location, raw: String(raw), precision: parsed?.precision ?? null, normalized: parsed?.normalized ?? null };
}

function typesOf(node: Record<string, unknown>): string[] {
  const type = node["@type"];
  return (Array.isArray(type) ? type : [type]).filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase());
}

function jsonLdCandidates(extracted: ExtractedHtml): DateCandidate[] {
  const found: DateCandidate[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((child, index) => walk(child, `${path}[${index}]`));
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const method: DateMethod = typesOf(record).some((type) => ARTICLE_TYPES.has(type)) ? "jsonld_article" : "jsonld_other";
    for (const field of ["published", "modified"] as const) {
      const value = record[JSONLD_KEYS[field]];
      if (typeof value === "string") found.push(candidate(field, method, `${path}.${JSONLD_KEYS[field]}`, value));
    }
    for (const [key, child] of Object.entries(record)) if (child && typeof child === "object") walk(child, `${path}.${key}`);
  };
  for (const block of extracted.jsonLd) if (!block.parseError) walk(block.value, `jsonld[${block.index}]`);
  return found;
}

/** All date candidates of a page, then the published and modified values by method priority. */
export function extractDocumentDates(extracted: ExtractedHtml): DocumentDates {
  const all: DateCandidate[] = [...jsonLdCandidates(extracted)];
  for (const field of ["published", "modified"] as const) {
    for (const meta of extracted.metas) if (META_KEYS[field].includes(meta.key)) all.push(candidate(field, "meta", meta.location, meta.content));
    for (const time of extracted.times) {
      // Only machine-marked time elements; an arbitrary <time> is not a publication date.
      const marked = time.itemprop?.toLowerCase() === TIME_ITEMPROP[field] || (field === "published" && time.pubdate);
      if (marked) all.push(candidate(field, "time_element", time.location, time.datetime));
    }
  }
  const resolve = (field: DateField): ResolvedDate | null => {
    for (const method of METHOD_PRIORITY) {
      const parsed = all.filter((item) => item.field === field && item.method === method && item.precision != null);
      if (parsed.length === 0) continue;
      const distinct = [...new Map(parsed.map((item) => [`${item.precision}|${item.normalized}`, item])).values()];
      return { field, candidates: distinct, conflict: distinct.length > 1 };
    }
    return null;
  };
  return { published: resolve("published"), modified: resolve("modified"), allCandidates: all };
}

// ---- knowledge-cutoff and market-timing rules ------------------------------

const HOUR = 3_600_000;
const asUtcMs = (local: string) => Date.parse(`${local}Z`);

export type CutoffVerdict = "proven_before" | "after" | "ambiguous";

/**
 * Whether one candidate is proven at or before `knowledgeCutoffAt`.
 * - datetime_tz: the instant ≤ cutoff.
 * - date: strictly before the calendar date containing the cutoff in the
 *   latest timezone (UTC−12); the same date is ambiguous.
 * - datetime_no_tz: value read at UTC−12 (value + 12 h) ≤ cutoff.
 * A value whose earliest possible instant is already after the cutoff is "after".
 */
export function candidateVsKnowledgeCutoff(item: DateCandidate, knowledgeCutoffAt: string, config: DocumentDatesConfig = DOCUMENT_DATES_CONFIG): CutoffVerdict {
  const cutoffMs = Date.parse(knowledgeCutoffAt);
  if (!Number.isFinite(cutoffMs)) throw new Error(`Invalid knowledgeCutoffAt: ${knowledgeCutoffAt}`);
  if (item.precision == null || item.normalized == null) return "ambiguous";
  const earliest = earliestPossibleInstantMs(item, config);
  if (earliest > cutoffMs) return "after";
  if (item.precision === "datetime_tz") return "proven_before";
  if (item.precision === "date") {
    const cutoffDateInLatestZone = new Date(cutoffMs + config.latestZoneOffsetHours * HOUR).toISOString().slice(0, 10);
    return item.normalized < cutoffDateInLatestZone ? "proven_before" : "ambiguous";
  }
  const latest = asUtcMs(item.normalized) - config.latestZoneOffsetHours * HOUR;
  return latest <= cutoffMs ? "proven_before" : "ambiguous";
}

/** Earliest instant a candidate could denote (date at 00:00 in UTC+14; no-timezone at value − 14 h). */
export function earliestPossibleInstantMs(item: DateCandidate, config: DocumentDatesConfig = DOCUMENT_DATES_CONFIG): number {
  if (item.precision == null || item.normalized == null) return Number.NaN;
  if (item.precision === "datetime_tz") return Date.parse(item.normalized);
  const local = item.precision === "date" ? `${item.normalized}T00:00:00` : item.normalized;
  return asUtcMs(local) - config.earliestZoneOffsetHours * HOUR;
}

/** Latest instant a candidate could denote (date at 24:00 in UTC−12; no-timezone at value + 12 h). */
export function latestPossibleInstantMs(item: DateCandidate, config: DocumentDatesConfig = DOCUMENT_DATES_CONFIG): number {
  if (item.precision == null || item.normalized == null) return Number.NaN;
  if (item.precision === "datetime_tz") return Date.parse(item.normalized);
  const local = item.precision === "date" ? `${item.normalized}T23:59:59.999` : item.normalized;
  return asUtcMs(local) - config.latestZoneOffsetHours * HOUR;
}

export type DateRejection =
  | "undated"
  | "published_after_knowledge_cutoff"
  | "publication_time_ambiguous"
  | "modified_after_knowledge_cutoff"
  | "modification_time_ambiguous";

export type DateAssessment = {
  rejections: DateRejection[];
  /** Earliest possible publication instant (market timing); null when undated. */
  evidenceTimeMs: number | null;
  publishedVerdict: CutoffVerdict | null;
  modifiedVerdict: CutoffVerdict | null;
};

/** Conservative over disagreeing candidates: any "after" wins, then any "ambiguous". */
function combined(resolved: ResolvedDate, knowledgeCutoffAt: string, config: DocumentDatesConfig): CutoffVerdict {
  const verdicts = resolved.candidates.map((item) => candidateVsKnowledgeCutoff(item, knowledgeCutoffAt, config));
  return verdicts.includes("after") ? "after" : verdicts.includes("ambiguous") ? "ambiguous" : "proven_before";
}

/** Date checks of one citation against the immutable knowledge cutoff. */
export function assessDocumentDates(dates: DocumentDates, knowledgeCutoffAt: string, config: DocumentDatesConfig = DOCUMENT_DATES_CONFIG): DateAssessment {
  const rejections: DateRejection[] = [];
  let publishedVerdict: CutoffVerdict | null = null;
  let modifiedVerdict: CutoffVerdict | null = null;
  if (!dates.published) rejections.push("undated");
  else {
    publishedVerdict = combined(dates.published, knowledgeCutoffAt, config);
    if (publishedVerdict === "after") rejections.push("published_after_knowledge_cutoff");
    if (publishedVerdict === "ambiguous") rejections.push("publication_time_ambiguous");
  }
  if (dates.modified) {
    modifiedVerdict = combined(dates.modified, knowledgeCutoffAt, config);
    if (modifiedVerdict === "after") rejections.push("modified_after_knowledge_cutoff");
    if (modifiedVerdict === "ambiguous") rejections.push("modification_time_ambiguous");
  }
  const evidenceTimeMs = dates.published
    ? Math.min(...dates.published.candidates.map((item) => earliestPossibleInstantMs(item, config)))
    : null;
  return { rejections, evidenceTimeMs, publishedVerdict, modifiedVerdict };
}
