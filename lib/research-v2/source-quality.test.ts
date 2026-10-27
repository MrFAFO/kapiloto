import assert from "node:assert/strict";
import test from "node:test";

import { normalizeForMatch } from "./evidence-window";
import {
  assessSourceV2,
  clusterCitations,
  corroborateClusters,
  originKey,
  type CitationAttribution,
  type ClusterMember,
} from "./source-quality";
import { effectiveRegistryEntries, REGISTRY_TEAMS, SOURCE_REGISTRY_SEED } from "./source-registry";
import { CANDIDATE_SOURCE_POLICY } from "./sources";
import { canonicalEvidenceUrl } from "./verification";

const REGISTRY = effectiveRegistryEntries();
const primary: CitationAttribution = { reporting: "primary", directQuote: false, citedOrigin: { type: "none", name: null, date: null } };
const secondary: CitationAttribution = { ...primary, reporting: "secondary" };
const direct: CitationAttribution = { ...primary, directQuote: true };
const grade = (url: string, clubKey: string, attribution = primary, byline: string | null = null) =>
  assessSourceV2({ url, byline, attribution, clubKey, originKey: null }, REGISTRY);

test("a verified local specialist grades B for its club only", () => {
  const hull = grade("https://www.hulldailymail.co.uk/sport/football/a", REGISTRY_TEAMS.hull);
  assert.deepEqual([hull.grade, hull.basis, hull.specialistForClub, hull.registryStatus], ["B", "club_specialist", true, "verified"]);
  const otherClub = grade("https://www.hulldailymail.co.uk/sport/football/a", REGISTRY_TEAMS.brentford);
  assert.deepEqual([otherClub.grade, otherClub.basis, otherClub.specialistForClub], ["C", "established_primary", false]);
  assert.equal(grade("https://www.hulldailymail.co.uk/a", REGISTRY_TEAMS.hull, secondary).grade, "C", "secondary reporting is never specialist B");
});

test("an ordinary established outlet stays C, primary or secondary; size never grants trust", () => {
  for (const attribution of [primary, secondary]) {
    const sky = grade("https://www.skysports.com/football/news/a", REGISTRY_TEAMS.hull, attribution);
    assert.equal(sky.grade, "C");
    assert.equal(sky.specialistForClub, false);
  }
});

test("a needs_verification entry cannot acquire B or A privileges", () => {
  const raw = SOURCE_REGISTRY_SEED.entries.find((entry) => entry.domain === "football.london")!;
  assert.equal(raw.reviewStatus, "needs_verification");
  const palace = grade("https://www.football.london/crystal-palace-fc/news/a", REGISTRY_TEAMS.crystalPalace);
  assert.deepEqual([palace.grade, palace.specialistForClub, palace.registryStatus], ["C", false, "needs_verification"]);
  const quoted = grade("https://www.football.london/crystal-palace-fc/news/a", REGISTRY_TEAMS.crystalPalace, direct);
  assert.notEqual(quoted.grade, "A", "a direct quote on an unverified outlet is not a verified statement");
  // Even if the raw (unstripped) registry were passed, the trust guard inside assessSourceV2 holds.
  const rawGrade = assessSourceV2({ url: "https://www.football.london/a", byline: null, attribution: primary, clubKey: REGISTRY_TEAMS.crystalPalace, originKey: null }, SOURCE_REGISTRY_SEED.entries);
  assert.equal(rawGrade.grade, "C");
});

test("verified official sources grade A for their own club and competition; other clubs are not official for the claim", () => {
  assert.deepEqual([grade("https://www.wearehullcity.co.uk/news/a", REGISTRY_TEAMS.hull).grade, grade("https://www.wearehullcity.co.uk/news/a", REGISTRY_TEAMS.hull).basis], ["A", "official_own_club"]);
  assert.deepEqual([grade("https://www.wearehullcity.co.uk/news/a", REGISTRY_TEAMS.brentford).grade, grade("https://www.wearehullcity.co.uk/news/a", REGISTRY_TEAMS.brentford).basis], ["C", "official_other_club"]);
  assert.deepEqual([grade("https://www.premierleague.com/news/a", REGISTRY_TEAMS.hull).grade, grade("https://www.premierleague.com/news/a", REGISTRY_TEAMS.hull).basis], ["A", "official_competition"]);
  assert.equal(grade("https://www.skysports.com/a", REGISTRY_TEAMS.hull, direct).basis, "verified_direct_statement");
  assert.equal(grade("https://www.skysports.com/a", REGISTRY_TEAMS.hull, direct).grade, "A");
});

test("reporter-level trust is scoped to the reporter's clubs", () => {
  const palace = grade("https://www.standard.co.uk/sport/football/a", REGISTRY_TEAMS.crystalPalace, primary, "Dom Smith");
  assert.deepEqual([palace.grade, palace.basis, palace.scopedReporter], ["B", "scoped_reporter", true]);
  const hull = grade("https://www.standard.co.uk/sport/football/a", REGISTRY_TEAMS.hull, primary, "Dom Smith");
  assert.deepEqual([hull.grade, hull.scopedReporter], ["C", false]);
  assert.equal(grade("https://www.standard.co.uk/sport/football/a", REGISTRY_TEAMS.crystalPalace, primary, "Someone Else").grade, "C");
});

test("aggregators and unregistered domains are D, even with a direct quote; the full vector is recorded", () => {
  assert.equal(grade("https://www.sportsmole.co.uk/a", REGISTRY_TEAMS.hull, direct).grade, "D");
  const unknown = grade("https://random-blog.example/a", REGISTRY_TEAMS.hull, direct);
  assert.deepEqual([unknown.grade, unknown.basis, unknown.registryStatus], ["D", "unregistered", "unregistered"]);
  assert.deepEqual(Object.keys(grade("https://www.skysports.com/a", REGISTRY_TEAMS.hull)).sort(), [
    "basis", "byline", "denied", "directQuote", "domain", "grade", "organization", "originKey", "registryStatus", "reporting", "scopedReporter", "sourceType", "specialistForClub",
  ]);
});

test("D never corroborates; one A/B cluster passes alone; otherwise two independent C clusters are needed", () => {
  const policy = CANDIDATE_SOURCE_POLICY;
  assert.equal(corroborateClusters([{ clusterId: "a", grade: "D" }, { clusterId: "b", grade: "D" }, { clusterId: "c", grade: "D" }], policy).reason, "weak_sources_only");
  assert.equal(corroborateClusters([{ clusterId: "a", grade: "C" }, { clusterId: "b", grade: "D" }], policy).reason, "insufficient_corroboration");
  const twoC = corroborateClusters([{ clusterId: "a", grade: "C" }, { clusterId: "b", grade: "C" }], policy);
  assert.deepEqual([twoC.passed, twoC.reason, twoC.qualifyingClusters], [true, "independent_corroboration", 2]);
  assert.equal(corroborateClusters([{ clusterId: "a", grade: "B" }], policy).reason, "strong_cluster");
  assert.equal(corroborateClusters([{ clusterId: "a", grade: "A" }], policy).reason, "strong_cluster");
  assert.equal(corroborateClusters([], policy).reason, "no_clusters");
});

const member = (citationId: string, url: string, quote: string, extra: Partial<ClusterMember> = {}): ClusterMember => ({
  citationId,
  canonicalUrl: canonicalEvidenceUrl(url),
  normalizedQuote: normalizeForMatch(quote),
  agency: null,
  subjectKey: "home:player:john keeper",
  originKey: null,
  ...extra,
});

test("syndicated agency copy is one cluster", () => {
  const clusters = clusterCitations([
    member("C1#0", "https://a.example/x", "short quote one", { agency: "pa media" }),
    member("C1#1", "https://b.example/y", "another short", { agency: "pa media" }),
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].reasons.map((reason) => reason.key), ["agency:pa media:home:player:john keeper"]);
});

test("two articles quoting the same press conference are one cluster; genuinely independent reports are two", () => {
  const presser = originKey({ type: "press_conference", name: null, date: "2026-10-24" }, { clubKey: REGISTRY_TEAMS.hull, subjectKey: "s", fallbackDate: null });
  assert.equal(presser, "presser:sportmonks:22:2026-10-24");
  const samePresser = clusterCitations([
    member("C1#0", "https://a.example/x", "Keeper misses out", { originKey: presser }),
    member("C1#1", "https://b.example/y", "The manager confirmed", { originKey: presser }),
  ]);
  assert.equal(samePresser.length, 1);
  assert.deepEqual(samePresser[0].reasons, [{ key: `origin:${presser}`, members: ["C1#0", "C1#1"] }]);
  const independent = clusterCitations([
    member("C1#0", "https://a.example/x", "Keeper misses out"),
    member("C1#1", "https://b.example/y", "Keeper ruled out, says report"),
  ]);
  assert.equal(independent.length, 2);
  assert.ok(independent.every((cluster) => cluster.reasons.length === 0));
  assert.equal(
    originKey({ type: "outlet", name: "The Athletic", date: null }, { clubKey: "x", subjectKey: "s", fallbackDate: null }),
    "outlet:the athletic",
  );
});

test("duplicate URLs differing only in tracking parameters, and long identical quotes, are one cluster", () => {
  const tracked = clusterCitations([
    member("C1#0", "https://www.a.example/x?utm_source=tw&utm_medium=social", "quote a"),
    member("C2#0", "https://a.example/x/#top", "quote b"),
  ]);
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].reasons[0].key, "url:https://a.example/x");
  const long = "The goalkeeper will miss the next three matches with a hamstring problem";
  assert.equal(clusterCitations([member("C1#0", "https://a.example/1", long), member("C1#1", "https://b.example/2", long)]).length, 1);
  assert.equal(clusterCitations([member("C1#0", "https://a.example/1", "He is out."), member("C1#1", "https://b.example/2", "He is out.")]).length, 2, "short identical quotes are not syndication");
});

test("cluster ids and reasons are deterministic and order-independent", () => {
  const members = [member("C1#1", "https://b.example/y", "x"), member("C1#0", "https://a.example/x", "y", { agency: "reuters" }), member("C2#0", "https://a.example/x", "z")];
  assert.deepEqual(clusterCitations(members), clusterCitations([...members].reverse()));
});
