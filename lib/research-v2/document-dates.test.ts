import assert from "node:assert/strict";
import test from "node:test";

import {
  assessDocumentDates,
  candidateVsKnowledgeCutoff,
  earliestPossibleInstantMs,
  extractDocumentDates,
  parseDateValue,
  type DateCandidate,
} from "./document-dates";
import { extractHtml } from "./html-extract";

const CUTOFF = "2026-10-25T01:35:00.000Z"; // 2026-10-24 13:35 in UTC−12

const page = (head: string, body = "<p>Text</p>") => extractHtml(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`);
const item = (raw: string, field: DateCandidate["field"] = "published"): DateCandidate => {
  const parsed = parseDateValue(raw);
  return { field, method: "meta", location: "test", raw, precision: parsed?.precision ?? null, normalized: parsed?.normalized ?? null };
};

test("ISO forms are parsed with explicit precision; anything else is unsupported", () => {
  assert.deepEqual(parseDateValue("2026-10-24"), { precision: "date", normalized: "2026-10-24" });
  assert.deepEqual(parseDateValue("2026-10-24T21:15:20+00:00"), { precision: "datetime_tz", normalized: "2026-10-24T21:15:20.000Z" });
  assert.deepEqual(parseDateValue("2026-10-24T23:15:20+0200"), { precision: "datetime_tz", normalized: "2026-10-24T21:15:20.000Z" });
  assert.deepEqual(parseDateValue("2026-10-24T21:15:20.123Z"), { precision: "datetime_tz", normalized: "2026-10-24T21:15:20.123Z" });
  assert.deepEqual(parseDateValue("2026-10-24 21:15"), { precision: "datetime_no_tz", normalized: "2026-10-24T21:15:00" });
  for (const raw of ["24/10/2026", "October 24, 2026", "2026-02-30", "2026-10-24T25:00:00Z", "", "yesterday"]) assert.equal(parseDateValue(raw), null, raw);
});

test("published and modified are extracted separately, with method and location, from JSON-LD, meta and time elements", () => {
  const extracted = page(`
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"WebPage","dateModified":"2026-10-25T09:00:00Z"},
      {"@type":"NewsArticle","datePublished":"2026-10-24T18:00:00+01:00","dateModified":"2026-10-24T19:30:00+01:00"}]}</script>
    <meta property="article:published_time" content="2026-10-24T17:00:00Z">
    <meta property="article:modified_time" content="2026-10-24T18:30:00Z">`,
    `<time datetime="2026-10-20">old</time><time itemprop="datePublished" datetime="2026-10-24T17:00:00Z">pub</time>`);
  const dates = extractDocumentDates(extracted);
  assert.equal(dates.published?.candidates[0].method, "jsonld_article", "article JSON-LD outranks meta");
  assert.equal(dates.published?.candidates[0].normalized, "2026-10-24T17:00:00.000Z");
  assert.equal(dates.published?.candidates[0].location, "jsonld[0].@graph[1].datePublished");
  assert.equal(dates.modified?.candidates[0].normalized, "2026-10-24T18:30:00.000Z", "WebPage render-time dateModified ranks below the article");
  assert.ok(dates.allCandidates.some((c) => c.method === "jsonld_other" && c.field === "modified"));
  assert.ok(dates.allCandidates.some((c) => c.method === "time_element" && c.location === "time#1"));
  assert.ok(!dates.allCandidates.some((c) => c.location === "time#0"), "an unmarked <time> is never a publication date");
});

test("modifiedAt never substitutes for publishedAt", () => {
  const dates = extractDocumentDates(page(`<meta property="article:modified_time" content="2026-10-24T10:00:00Z">`));
  assert.equal(dates.published, null);
  assert.equal(dates.modified?.candidates[0].normalized, "2026-10-24T10:00:00.000Z");
  assert.deepEqual(assessDocumentDates(dates, CUTOFF).rejections, ["undated"]);
});

test("disagreeing candidates of the same method are kept and judged conservatively", () => {
  const dates = extractDocumentDates(page(`
    <meta property="article:published_time" content="2026-10-24T10:00:00Z">
    <meta property="article:published_time" content="2026-10-25T03:00:00Z">`));
  assert.equal(dates.published?.conflict, true);
  const assessment = assessDocumentDates(dates, CUTOFF);
  assert.deepEqual(assessment.rejections, ["published_after_knowledge_cutoff"]);
  assert.equal(assessment.evidenceTimeMs, Date.parse("2026-10-24T10:00:00Z"), "market timing takes the earliest");
});

test("datetime with timezone: at the cutoff is proven, one millisecond later is after", () => {
  assert.equal(candidateVsKnowledgeCutoff(item("2026-10-25T01:35:00Z"), CUTOFF), "proven_before");
  assert.equal(candidateVsKnowledgeCutoff(item("2026-10-25T01:35:00.001Z"), CUTOFF), "after");
});

test("date-only: strictly before the cutoff's UTC−12 calendar date proves existence; the same date is ambiguous", () => {
  assert.equal(candidateVsKnowledgeCutoff(item("2026-10-23"), CUTOFF), "proven_before");
  assert.equal(candidateVsKnowledgeCutoff(item("2026-10-24"), CUTOFF), "ambiguous", "UTC date would be 10-25, but UTC−12 is still 10-24");
  assert.equal(candidateVsKnowledgeCutoff(item("2026-10-25"), CUTOFF), "ambiguous", "could still be 10-24 10:00Z in UTC+14");
  assert.equal(candidateVsKnowledgeCutoff(item("2026-10-26"), CUTOFF), "after");
  // UTC−12 boundary: at 12:00Z the UTC−12 date rolls over.
  assert.equal(candidateVsKnowledgeCutoff(item("2026-10-24"), "2026-10-25T11:59:59.999Z"), "ambiguous");
  assert.equal(candidateVsKnowledgeCutoff(item("2026-10-24"), "2026-10-25T12:00:00.000Z"), "proven_before");
});

test("datetime without timezone: proven only when value + 12 h is at or before the cutoff", () => {
  assert.equal(candidateVsKnowledgeCutoff(item("2026-10-24T13:35:00"), CUTOFF), "proven_before");
  assert.equal(candidateVsKnowledgeCutoff(item("2026-10-24T13:35:01"), CUTOFF), "ambiguous");
  assert.equal(candidateVsKnowledgeCutoff(item("2026-10-25T15:35:01"), CUTOFF), "after", "earliest reading (−14 h) is after the cutoff");
});

test("market timing uses the earliest possible instant", () => {
  assert.equal(earliestPossibleInstantMs(item("2026-10-24")), Date.parse("2026-10-23T10:00:00Z"));
  assert.equal(earliestPossibleInstantMs(item("2026-10-24T18:00:00")), Date.parse("2026-10-24T04:00:00Z"));
  assert.equal(earliestPossibleInstantMs(item("2026-10-24T18:00:00+02:00")), Date.parse("2026-10-24T16:00:00Z"));
});

test("citation date assessment: published and modified are each proven against the knowledge cutoff", () => {
  const assess = (head: string) => assessDocumentDates(extractDocumentDates(page(head)), CUTOFF).rejections;
  assert.deepEqual(assess(`<meta property="article:published_time" content="2026-10-24T20:00:00Z">`), []);
  assert.deepEqual(
    assess(`<meta property="article:published_time" content="2026-10-24T20:00:00Z"><meta property="article:modified_time" content="2026-10-25T02:00:00Z">`),
    ["modified_after_knowledge_cutoff"],
  );
  assert.deepEqual(
    assess(`<meta property="article:published_time" content="2026-10-24T20:00:00Z"><meta property="article:modified_time" content="2026-10-24">`),
    ["modification_time_ambiguous"],
  );
  assert.deepEqual(assess(`<meta property="article:published_time" content="2026-10-24">`), ["publication_time_ambiguous"]);
  assert.deepEqual(assess(`<meta property="article:published_time" content="2026-10-25T05:00:00Z">`), ["published_after_knowledge_cutoff"]);
  assert.deepEqual(assess(`<meta property="article:published_time" content="Saturday morning">`), ["undated"]);
});

test("HTML text extraction is deterministic, skips scripts and hidden content, and separates blocks", () => {
  const extracted = page(
    `<title> Hull  news </title><link rel="canonical" href="https://news.example.com/a">`,
    `<header>Menu</header><article><h1>Team news</h1><p>Smith   will miss <b>Saturday's</b> game.</p>
     <script>var x = "not text";</script><style>.a{}</style><div hidden>secret</div><p aria-hidden="true">icon</p><p>Second &amp; last.</p></article>`,
  );
  assert.equal(extracted.title, "Hull news");
  assert.equal(extracted.canonicalUrl, "https://news.example.com/a");
  assert.equal(extracted.text, "Menu\nTeam news\nSmith will miss Saturday's game.\nSecond & last.");
  assert.deepEqual(extractHtml("<p>a</p>").text, extractHtml("<p>a</p>").text);
  const broken = extractHtml(`<script type="application/ld+json">{broken</script>`);
  assert.deepEqual(broken.jsonLd, [{ index: 0, value: null, parseError: true }]);
});
