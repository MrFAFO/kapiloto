import { createHash } from "node:crypto";

import type { VersionedConfig } from "./provenance";

/**
 * Bounded evidence windows (D-047). Live-development artifacts never keep a
 * full article: only a window of text around a verified quote, its hash, the
 * quote offsets inside it and the hash of the full document text, so replay
 * can re-check quote, entity and support spans without the article.
 */

export type EvidenceWindowConfig = VersionedConfig & { radius: number; maxLength: number };

export const EVIDENCE_WINDOW_CONFIG: EvidenceWindowConfig = {
  id: "research-v2-evidence-window",
  version: "evidence-window-v1",
  status: "candidate",
  radius: 400,
  maxLength: 1200,
};

export const sha256Text = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const QUOTE_MARKS = /[‘’‚‛′׳`´]/g;
const DOUBLE_QUOTE_MARKS = /[“”„‟″״«»]/g;
const DASHES = /[‐-―−־]/g;

/** Normalization used for every match: NFKC, unified quotes and dashes, lowercase, whitespace collapsed. */
function normalizeChar(char: string): string {
  return char.normalize("NFKC").replace(QUOTE_MARKS, "'").replace(DOUBLE_QUOTE_MARKS, '"').replace(DASHES, "-").toLowerCase();
}

/** Normalized text plus, for each normalized UTF-16 unit, the index of the source code point it came from. */
export function normalizeWithMap(text: string): { normalized: string; sourceIndex: number[] } {
  let normalized = "";
  const sourceIndex: number[] = [];
  let pendingSpace = false;
  let index = 0;
  for (const char of text) {
    if (/\s/u.test(char)) {
      pendingSpace = normalized.length > 0;
    } else {
      if (pendingSpace) {
        normalized += " ";
        sourceIndex.push(index);
        pendingSpace = false;
      }
      const out = normalizeChar(char);
      for (let i = 0; i < out.length; i += 1) sourceIndex.push(index);
      normalized += out;
    }
    index += char.length;
  }
  return { normalized, sourceIndex };
}

export const normalizeForMatch = (text: string) => normalizeWithMap(text).normalized;

export type QuoteLocation = { start: number; end: number; occurrences: number };

/** First verbatim (normalized) occurrence of `quote` in `text`, as offsets into the original text. */
export function locateQuote(text: string, quote: string): QuoteLocation | null {
  const needle = normalizeForMatch(quote);
  if (needle.length === 0) return null;
  const { normalized, sourceIndex } = normalizeWithMap(text);
  const first = normalized.indexOf(needle);
  if (first < 0) return null;
  let occurrences = 0;
  for (let at = first; at >= 0; at = normalized.indexOf(needle, at + 1)) occurrences += 1;
  const lastUnit = first + needle.length - 1;
  const lastSource = sourceIndex[lastUnit];
  const lastCodePoint = text.codePointAt(lastSource) ?? 0;
  return { start: sourceIndex[first], end: lastSource + (lastCodePoint > 0xffff ? 2 : 1), occurrences };
}

export type EvidenceWindow = {
  version: string;
  /** Window text (persisted). */
  text: string;
  windowSha256: string;
  /** Hash of the full extracted document text (the text itself is not persisted). */
  documentTextSha256: string;
  /** Window position inside the full document text. */
  windowStart: number;
  windowEnd: number;
  /** Quote position inside the window. */
  quoteStart: number;
  quoteEnd: number;
};

const isLowSurrogate = (text: string, index: number) => {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
};

/** Window of at most `maxLength` units around a located quote, never splitting a surrogate pair. */
export function buildEvidenceWindow(documentText: string, quote: QuoteLocation, config: EvidenceWindowConfig = EVIDENCE_WINDOW_CONFIG): EvidenceWindow {
  if (quote.start < 0 || quote.end > documentText.length || quote.start >= quote.end) throw new Error("buildEvidenceWindow: invalid quote location");
  const allowed = Math.max(0, config.maxLength - (quote.end - quote.start));
  let before = Math.min(config.radius, quote.start);
  let after = Math.min(config.radius, documentText.length - quote.end);
  if (before + after > allowed) {
    // Share the allowance evenly, giving one side's unused share to the other.
    const half = Math.floor(allowed / 2);
    if (before < half) after = allowed - before;
    else if (after < allowed - half) before = allowed - after;
    else [before, after] = [half, allowed - half];
  }
  let start = quote.start - before;
  let end = quote.end + after;
  if (start > 0 && isLowSurrogate(documentText, start)) start += 1;
  if (end < documentText.length && isLowSurrogate(documentText, end)) end -= 1;
  const text = documentText.slice(start, end);
  return {
    version: config.version,
    text,
    windowSha256: sha256Text(text),
    documentTextSha256: sha256Text(documentText),
    windowStart: start,
    windowEnd: end,
    quoteStart: quote.start - start,
    quoteEnd: quote.end - start,
  };
}

export type WindowCheck = {
  hashMatches: boolean;
  quoteAtOffsets: boolean;
  entityInWindow: boolean | null;
  spanInWindow: boolean | null;
};

/** Replay-time checks on a stored window: hash, quote at its offsets, entity and support span inside it. */
export function checkEvidenceWindow(window: EvidenceWindow, input: { quote: string; entityName?: string | null; supportSpan?: string | null }): WindowCheck {
  const normalizedWindow = normalizeForMatch(window.text);
  const containsNormalized = (value: string | null | undefined) =>
    value == null ? null : normalizeForMatch(value).length > 0 && normalizedWindow.includes(normalizeForMatch(value));
  return {
    hashMatches: sha256Text(window.text) === window.windowSha256,
    quoteAtOffsets: normalizeForMatch(window.text.slice(window.quoteStart, window.quoteEnd)) === normalizeForMatch(input.quote),
    entityInWindow: containsNormalized(input.entityName),
    spanInWindow: containsNormalized(input.supportSpan),
  };
}

export type CitationEvidence = { quoteFound: boolean; occurrences: number; window: EvidenceWindow | null };

/** Capture-time step: locate a citation's quote in the full extracted text and keep only its window. */
export function buildCitationEvidence(documentText: string, quote: string, config: EvidenceWindowConfig = EVIDENCE_WINDOW_CONFIG): CitationEvidence {
  const location = locateQuote(documentText, quote);
  if (!location) return { quoteFound: false, occurrences: 0, window: null };
  return { quoteFound: true, occurrences: location.occurrences, window: buildEvidenceWindow(documentText, location, config) };
}
