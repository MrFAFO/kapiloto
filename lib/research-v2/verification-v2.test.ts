import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { decideClaimsV2 } from "./claim-decisions";
import type { DiscoveryClaim } from "./discovery-contract";
import { canonicalJson } from "./provenance";
import { CANDIDATE_SOURCE_POLICY } from "./sources";
import {
  claim,
  CLUB_KEYS,
  entailed,
  EVIDENCE_CUTOFF,
  evidenceFor,
  hoursBefore,
  KNOWLEDGE_CUTOFF,
  PRIMARY,
  REGISTRY,
  VERIFY_CONFIGS,
} from "./test-support-v2";
import { verifyCitationsV2, type EntailmentInputV2 } from "./verification";

const HULL_LIVE = (path: string) => `https://www.hulldailymail.co.uk/sport/football/${path}`;
const QUOTE = "John Keeper will miss Sunday's game with a knee injury";
const TEXT = `Team news update. ${QUOTE}, the club said. More copy follows here.`;

type Built = ReturnType<typeof evidenceFor>;
function run(claims: DiscoveryClaim[], built: Built, entailment: Record<string, EntailmentInputV2>, structured: Parameters<typeof decideClaimsV2>[0]["structuredAvailability"] = []) {
  const citations = verifyCitationsV2({
    claims,
    citations: built.citations,
    documents: built.documents,
    observedUrls: built.observedUrls,
    entailment,
    clubKeys: CLUB_KEYS,
    knowledgeCutoffAt: KNOWLEDGE_CUTOFF,
    evidenceCutoffAt: EVIDENCE_CUTOFF,
    registry: REGISTRY,
    configs: VERIFY_CONFIGS,
  });
  const decisions = decideClaimsV2({ claims, citations, entailment, structuredAvailability: structured, registry: REGISTRY, sourcePolicy: CANDIDATE_SOURCE_POLICY });
  return { citations, decisions };
}
const merge = (...parts: Built[]): Built => ({
  documents: parts.flatMap((part) => part.documents),
  citations: parts.flatMap((part) => part.citations),
  observedUrls: parts.flatMap((part) => part.observedUrls),
});

test("each citation is judged alone; bad extra citations do not poison a valid one", () => {
  const built = evidenceFor("C1", [
    { page: { url: HULL_LIVE("good"), text: TEXT }, quote: QUOTE },
    { page: { url: HULL_LIVE("unseen"), text: TEXT }, quote: QUOTE, observed: false },
    { page: { url: "https://www.skysports.com/a", text: "Nothing relevant here." }, quote: QUOTE },
  ]);
  const c = claim({ citations: built.citations.map((cit) => ({ url: cit.url, quote: cit.quote, publisher_claimed: null, author_claimed: null, published_at_claimed: null })) });
  const { citations, decisions } = run([c], built, { "C1#0": entailed("knee injury"), "C1#1": entailed("knee injury"), "C1#2": entailed("knee injury") });
  assert.deepEqual(citations.map((check) => [check.citationId, check.status, check.rejections]), [
    ["C1#0", "accepted", []],
    ["C1#1", "rejected", ["url_not_observed"]],
    ["C1#2", "rejected", ["quote_not_found"]],
  ]);
  const good = citations[0];
  assert.equal(good.quote.found, true);
  assert.equal(good.quote.windowHashOk && good.quote.offsetsOk && good.quote.documentHashOk, true);
  assert.equal(good.entity.inWindow, true);
  assert.equal(good.source.grade, "B");
  const decision = decisions.claims[0];
  assert.equal(decision.status, "adjusting");
  assert.deepEqual(decision.acceptedCitations, ["C1#0"]);
  assert.deepEqual(decision.reasons, ["corroboration:strong_cluster", "impact:availability_first_choice_goalkeeper"]);
  assert.equal(decision.proposal?.impact_class, "moderate");
});

function single(page: Partial<Parameters<typeof evidenceFor>[1][number]["page"]>, options: { quote?: string; entail?: EntailmentInputV2 | null; tamper?: boolean; kind?: DiscoveryClaim["claim_kind"]; subjectName?: string } = {}) {
  const built = evidenceFor("C1", [{ page: { url: HULL_LIVE("a"), text: TEXT, ...page }, quote: options.quote ?? QUOTE, tamper: options.tamper }]);
  const c = claim({ claim_kind: options.kind ?? "absence", subjectName: options.subjectName, citations: [{ url: HULL_LIVE("a"), quote: options.quote ?? QUOTE, publisher_claimed: null, author_claimed: null, published_at_claimed: null }] });
  const entailment: Record<string, EntailmentInputV2> = options.entail === null ? {} : { "C1#0": options.entail ?? entailed("knee injury") };
  return run([c], built, entailment).citations[0];
}

test("explicit citation rejections: fetch, retrieval time, dates against the knowledge cutoff, freshness", () => {
  assert.deepEqual(single({ fetchFailure: { ok: false, reason: "resolves_to_blocked_address", detail: null } }).rejections, ["fetch_blocked"]);
  assert.deepEqual(single({ fetchFailure: { ok: false, reason: "http_status", detail: "404" } }).rejections, ["page_not_retrieved"]);
  assert.deepEqual(single({ retrievedAt: "2026-10-25T08:05:00.001Z" }).rejections, ["retrieved_after_evidence_cutoff"]);
  assert.deepEqual(single({ published: "2026-10-25T08:00:00.001Z" }).rejections, ["published_after_knowledge_cutoff"]);
  assert.deepEqual(single({ published: "2026-10-24" }).rejections, ["publication_time_ambiguous"], "same UTC−12 calendar date");
  assert.deepEqual(single({ published: null }).rejections, ["undated"]);
  assert.deepEqual(single({ published: hoursBefore(3), modified: "2026-10-25T09:00:00Z" }).rejections, ["modified_after_knowledge_cutoff"]);
  assert.deepEqual(single({ published: hoursBefore(30), modified: "2026-10-24" }).rejections, ["modification_time_ambiguous"]);
  const stale = single({ published: hoursBefore(73) }, { kind: "doubtful" });
  assert.deepEqual(stale.rejections, ["stale_for_claim_kind"]);
  assert.equal(stale.freshness.maxAgeHours, 72);
  assert.equal(single({ published: hoursBefore(72) }, { kind: "doubtful" }).status, "accepted", "exactly the limit is fresh");
});

test("explicit citation rejections: quote, window integrity, entity, entailment and denied sources", () => {
  assert.deepEqual(single({}, { quote: "A quote that is not on the page" }).rejections, ["quote_not_found"]);
  assert.deepEqual(single({}, { tamper: true }).rejections, ["window_integrity_failed"]);
  assert.deepEqual(single({}, { subjectName: "Someone Else" }).rejections, ["entity_not_in_window"]);
  assert.deepEqual(single({}, { entail: null }).rejections, ["entailment_missing"]);
  assert.deepEqual(single({}, { entail: { ...entailed("knee injury"), verdict: "contradicted" } }).rejections, ["entailment_unsupported"]);
  assert.deepEqual(single({}, { entail: entailed("words that are not in the window") }).rejections, ["support_span_invalid"]);
  assert.deepEqual(single({}, { entail: null, kind: "squad_change" }).rejections, [], "explanatory claims do not need the judge");
  const deniedRegistry = REGISTRY.map((entry) => (entry.domain === "hulldailymail.co.uk" ? { ...entry, denied: true } : entry));
  const built = evidenceFor("C1", [{ page: { url: HULL_LIVE("a"), text: TEXT }, quote: QUOTE }]);
  const denied = verifyCitationsV2({
    claims: [claim({ citations: [{ url: HULL_LIVE("a"), quote: QUOTE, publisher_claimed: null, author_claimed: null, published_at_claimed: null }] })],
    citations: built.citations, documents: built.documents, observedUrls: built.observedUrls, entailment: { "C1#0": entailed("knee injury") },
    clubKeys: CLUB_KEYS, knowledgeCutoffAt: KNOWLEDGE_CUTOFF, evidenceCutoffAt: EVIDENCE_CUTOFF, registry: deniedRegistry, configs: VERIFY_CONFIGS,
  })[0];
  assert.deepEqual(denied.rejections, ["source_denied"]);
});

/** A claim plus one or more pages that support it, for claim-level scenarios. */
function supported(claimId: string, overrides: Partial<DiscoveryClaim> & { subjectName?: string }, pages: Array<{ url: string; text: string; published?: string; attribution?: EntailmentInputV2["attribution"]; byline?: string }>) {
  const built = evidenceFor(claimId, pages.map((page) => ({ page: { url: page.url, text: page.text, published: page.published, byline: page.byline }, quote: page.text.split(". ")[0] })));
  const c = claim({ claim_id: claimId, ...overrides, citations: built.citations.map((cit) => ({ url: cit.url, quote: cit.quote, publisher_claimed: null, author_claimed: null, published_at_claimed: null })) });
  const entailment = Object.fromEntries(built.citations.map((cit, index) => [`${claimId}#${cit.citationIndex}`, entailed(cit.quote, { attribution: pages[index].attribution ?? PRIMARY })]));
  return { claim: c, built, entailment };
}

test("D-only evidence is explanatory; two independent C clusters adjust; one C cluster does not", () => {
  const d = supported("C1", {}, [{ url: "https://www.sportsmole.co.uk/a", text: "John Keeper will miss Sunday. Extra." }]);
  assert.deepEqual(run([d.claim], d.built, d.entailment).decisions.claims[0].reasons, ["corroboration:weak_sources_only"]);
  const oneC = supported("C1", {}, [{ url: "https://www.skysports.com/a", text: "John Keeper will miss Sunday. Extra." }]);
  const oneDecision = run([oneC.claim], oneC.built, oneC.entailment).decisions.claims[0];
  assert.deepEqual([oneDecision.status, oneDecision.reasons], ["explanatory", ["corroboration:insufficient_corroboration"]]);
  const twoC = supported("C1", {}, [
    { url: "https://www.skysports.com/a", text: "John Keeper will miss Sunday. Extra." },
    { url: "https://www.theguardian.com/b", text: "John Keeper is ruled out for Hull. More." },
  ]);
  const twoDecision = run([twoC.claim], twoC.built, twoC.entailment).decisions.claims[0];
  assert.equal(twoDecision.status, "adjusting");
  assert.equal(twoDecision.reasons[0], "corroboration:independent_corroboration");
  assert.equal(twoDecision.clusters.length, 2);
  const samePresser = supported("C1", {}, [
    { url: "https://www.skysports.com/a", text: "John Keeper will miss Sunday. Extra.", attribution: { reporting: "secondary", directQuote: false, citedOrigin: { type: "press_conference", name: null, date: "2026-10-24" } } },
    { url: "https://www.theguardian.com/b", text: "John Keeper is ruled out for Hull. More.", attribution: { reporting: "secondary", directQuote: false, citedOrigin: { type: "press_conference", name: null, date: "2026-10-24" } } },
  ]);
  const presserDecision = run([samePresser.claim], samePresser.built, samePresser.entailment);
  assert.equal(presserDecision.decisions.claims[0].clusters.length, 1, "two reports of one press conference are one cluster");
  assert.equal(presserDecision.decisions.claims[0].status, "explanatory");
});

test("no accepted citation rejects the claim; explanatory kinds never adjust", () => {
  const none = supported("C1", {}, [{ url: "https://www.skysports.com/a", text: "John Keeper will miss Sunday. Extra.", published: "2026-10-25T09:00:00Z" }]);
  const decision = run([none.claim], none.built, none.entailment).decisions.claims[0];
  assert.deepEqual([decision.status, decision.reasons], ["rejected", ["no_accepted_citation"]]);
  const context = supported("C1", { claim_kind: "manager_change", subject: { type: "manager", name_in_source: "John Keeper", name_normalized_en: "John Keeper", role: "unknown", squad_status_claimed: "unknown", squad_status_quote: null, named_players: [] } }, [
    { url: HULL_LIVE("m"), text: "John Keeper was appointed head coach. Extra." },
  ]);
  assert.deepEqual(run([context.claim], context.built, context.entailment).decisions.claims[0].reasons, ["explanatory_kind"]);
});

test("a matching structured availability fact makes the web claim explanatory", () => {
  const s = supported("C1", {}, [{ url: HULL_LIVE("a"), text: "John Keeper will miss Sunday. Extra." }]);
  const decision = run([s.claim], s.built, s.entailment, [{ team: "home", playerKey: "sm:999", playerName: "John Keeper", status: "out", source: "sportmonks:sidelined" }]).decisions.claims[0];
  assert.deepEqual([decision.status, decision.structuredDuplicate], ["explanatory", true]);
  assert.ok(decision.reasons.includes("structured_duplicate"));
  const otherPlayer = run([s.claim], s.built, s.entailment, [{ team: "home", playerKey: "sm:1", playerName: "Other Player", status: "out", source: "x" }]).decisions.claims[0];
  assert.equal(otherPlayer.status, "adjusting");
});

test("contradictory statuses for one subject are non-adjusting", () => {
  const out = supported("C1", {}, [{ url: HULL_LIVE("out"), text: "John Keeper will miss Sunday. Extra.", published: hoursBefore(5) }]);
  const back = supported("C2", { claim_kind: "expected_return", claim: "John Keeper is fit again." }, [{ url: HULL_LIVE("back"), text: "John Keeper is fit to play Sunday. Extra.", published: hoursBefore(3) }]);
  const { decisions } = run([out.claim, back.claim], merge(out.built, back.built), { ...out.entailment, ...back.entailment });
  for (const decision of decisions.claims) {
    assert.equal(decision.status, "explanatory");
    assert.ok(decision.reasons.includes("conflicting_sources"));
    assert.deepEqual(decision.conflict?.claimIds, ["C1", "C2"]);
  }
});

test("a strictly later verified grade-A official statement supersedes; an overlapping one does not", () => {
  const out = supported("C1", {}, [{ url: HULL_LIVE("out"), text: "John Keeper will miss Sunday. Extra.", published: hoursBefore(10) }]);
  const official = supported("C2", { claim_kind: "expected_return" }, [{ url: "https://www.wearehullcity.co.uk/news/keeper", text: "John Keeper is available for Sunday. Extra.", published: hoursBefore(2) }]);
  const later = run([out.claim, official.claim], merge(out.built, official.built), { ...out.entailment, ...official.entailment }).decisions.claims;
  assert.deepEqual(later.map((d) => [d.claimId, d.status, d.conflict?.resolution]), [["C1", "explanatory", "superseded"], ["C2", "adjusting", "supersedes"]]);
  assert.ok(later[0].reasons.includes("superseded_by_later_official"));
  assert.ok(later[1].reasons.includes("supersedes_earlier_claims"));
  assert.equal(later[1].proposal?.effect, "strengthens");

  const rivalLater = supported("C1", {}, [{ url: HULL_LIVE("out2"), text: "John Keeper will miss Sunday. Extra.", published: hoursBefore(1) }]);
  const overlap = run([rivalLater.claim, official.claim], merge(rivalLater.built, official.built), { ...rivalLater.entailment, ...official.entailment }).decisions.claims;
  assert.ok(overlap.every((d) => d.status === "explanatory" && d.reasons.includes("conflicting_sources")), "an official statement that is not later than the rival cannot win");
});

test("the same status reported twice gives one adjustment per subject", () => {
  const first = supported("C1", {}, [{ url: HULL_LIVE("one"), text: "John Keeper will miss Sunday. Extra." }]);
  const again = supported("C2", {}, [{ url: HULL_LIVE("two"), text: "John Keeper is ruled out for Hull. Extra." }]);
  const { decisions } = run([first.claim, again.claim], merge(first.built, again.built), { ...first.entailment, ...again.entailment });
  assert.deepEqual(decisions.claims.map((d) => [d.claimId, d.status]), [["C1", "adjusting"], ["C2", "explanatory"]]);
  assert.ok(decisions.claims[1].reasons.includes("duplicate_subject"));
});

test("verification and claim decisions replay bit-identically from stored inputs", () => {
  const a = supported("C1", {}, [
    { url: HULL_LIVE("a?utm_source=x"), text: "John Keeper will miss Sunday. Extra." },
    { url: "https://www.skysports.com/a", text: "John Keeper is ruled out for Hull. More." },
  ]);
  const b = supported("C2", { claim_kind: "expected_return" }, [{ url: "https://www.wearehullcity.co.uk/n", text: "John Keeper is available. Extra.", published: hoursBefore(1) }]);
  const claims = [a.claim, b.claim];
  const built = merge(a.built, b.built);
  const entailment = { ...a.entailment, ...b.entailment };
  const first = run(claims, built, entailment);
  const stored = JSON.parse(JSON.stringify({ claims, built, entailment }));
  const second = run(stored.claims, stored.built, stored.entailment);
  assert.equal(canonicalJson(second), canonicalJson(first));
});

test("step 4 modules are network-free: no network module or fetcher value import", () => {
  for (const file of ["verification.ts", "claim-decisions.ts", "source-quality.ts", "research-timing.ts", "source-registry.ts"]) {
    const source = readFileSync(join(process.cwd(), "lib", "research-v2", file), "utf8");
    assert.doesNotMatch(source, /from "node:(http|https|dns|net|tls|dgram)"/, file);
    assert.doesNotMatch(source, /import \{[^}]*\b(safeFetch|installLiveDevFetchGuard)\b[^}]*\} from/, file);
    assert.doesNotMatch(source, /\bfetch\(/, file);
  }
});
