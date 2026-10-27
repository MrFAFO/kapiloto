import assert from "node:assert/strict";
import test from "node:test";

import { configProvenance } from "./provenance";
import {
  effectiveRegistryEntries,
  grantsTrustPrivileges,
  REGISTRY_COMPETITIONS,
  REGISTRY_EXCLUDED,
  REGISTRY_KNOWN_GAPS,
  REGISTRY_TEAMS,
  SOURCE_REGISTRY_SEED,
  type SourceRegistrySeed,
  type SourceRegistrySeedEntry,
} from "./source-registry";
import { assessSource } from "./sources";

const entries = SOURCE_REGISTRY_SEED.entries;

test("the registry seed is versioned, candidate and hashable; nothing is human-approved yet", () => {
  assert.equal(SOURCE_REGISTRY_SEED.version, "source-registry-v2");
  assert.equal(SOURCE_REGISTRY_SEED.status, "candidate");
  assert.match(configProvenance(SOURCE_REGISTRY_SEED).sha256, /^[0-9a-f]{64}$/);
  assert.ok(entries.every((entry) => entry.reviewStatus !== "approved"));
});

test("every entry records evidence: a check date, a method and at least one source URL", () => {
  for (const entry of entries) {
    assert.match(entry.evidence.checkedOn, /^\d{4}-\d{2}-\d{2}$/, entry.domain);
    assert.ok(entry.evidence.methods.length > 0, entry.domain);
    assert.ok(entry.evidence.sources.length > 0 && entry.evidence.sources.every((url) => /^https:\/\//.test(url)), entry.domain);
    assert.ok(entry.evidence.finding.length > 10, entry.domain);
  }
});

test("domains are unique, lowercase hostnames without scheme or path, and excluded domains stay out", () => {
  const domains = entries.map((entry) => entry.domain);
  assert.equal(new Set(domains).size, domains.length);
  for (const domain of domains) assert.match(domain, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, domain);
  for (const excluded of REGISTRY_EXCLUDED) assert.ok(!domains.includes(excluded.domain), excluded.domain);
});

test("every live-dev club has exactly one official entry, and every competition an official body", () => {
  for (const team of Object.values(REGISTRY_TEAMS)) {
    const official = entries.filter((entry) => entry.officialFor === team);
    assert.equal(official.length, 1, `official source for ${team}`);
    assert.equal(official[0].defaultType, "official_club");
  }
  for (const competition of Object.values(REGISTRY_COMPETITIONS)) {
    assert.ok(entries.some((entry) => entry.defaultType === "official_competition" && entry.competitions.includes(competition)), competition);
  }
  const israel = entries.filter((entry) => entry.defaultType === "official_competition" && entry.competitions.includes(REGISTRY_COMPETITIONS.ligatHaAl));
  assert.deepEqual(israel.map((entry) => entry.domain).sort(), ["football.co.il", "football.org.il"], "league administration and FA are separate");
});

test("specialist status needs a dedicated section or reporter; scopes and reporters name known clubs only", () => {
  const known = new Set<string>(Object.values(REGISTRY_TEAMS));
  for (const entry of entries) {
    if (entry.specialistFor) {
      assert.ok(entry.evidence.methods.some((method) => method === "dedicated_section" || method === "dedicated_reporter"), entry.domain);
      for (const team of entry.specialistFor) assert.ok(known.has(team), `${entry.domain} → ${team}`);
    }
    for (const teams of Object.values(entry.reporterScopes ?? {})) for (const team of teams) assert.ok(known.has(team));
    if (entry.defaultType === "aggregator") {
      assert.equal(entry.specialistFor, undefined, entry.domain);
      assert.equal(assessSource({ url: `https://${entry.domain}/x`, author: "Someone", isDirectQuote: true }, entries).quality, "D", entry.domain);
    }
  }
  const brentfordSpecialists = entries.filter((entry) => entry.specialistFor?.includes(REGISTRY_TEAMS.brentford));
  assert.deepEqual(brentfordSpecialists, [], "occasional coverage never makes a Brentford specialist");
  for (const gap of REGISTRY_KNOWN_GAPS) assert.ok(!entries.some((entry) => entry.specialistFor?.includes(gap.team)), gap.team);
});

test("a small local specialist outlet is not graded below a national outlet", () => {
  const local = assessSource({ url: "https://www.sunderlandecho.com/sport/a", author: null, isDirectQuote: false }, entries);
  const national = assessSource({ url: "https://www.skysports.com/football/a", author: null, isDirectQuote: false }, entries);
  assert.equal(local.quality, national.quality);
});

test("a needs_verification entry gets no specialist or reporter trust; only verified or approved entries do", () => {
  const london = entries.find((entry) => entry.domain === "football.london")!;
  assert.equal(london.reviewStatus, "needs_verification", "kept unverified until stronger current evidence");
  assert.equal(grantsTrustPrivileges(london), false);
  const effectiveLondon = effectiveRegistryEntries().find((entry) => entry.domain === "football.london")!;
  assert.equal(effectiveLondon.specialistFor, undefined);
  assert.equal(effectiveLondon.reporterScopes, undefined);
  assert.equal(effectiveLondon.defaultType, "major_outlet", "the plain outlet type is kept");
  for (const entry of effectiveRegistryEntries()) {
    if (!grantsTrustPrivileges(entry)) {
      assert.equal(entry.specialistFor, undefined, entry.domain);
      assert.equal(entry.reporterScopes, undefined, entry.domain);
      assert.equal(entry.accreditedReporters, undefined, entry.domain);
    }
  }
  const verifiedSpecialist = effectiveRegistryEntries().find((entry) => entry.domain === "chroniclelive.co.uk")!;
  assert.ok(verifiedSpecialist.specialistFor && verifiedSpecialist.specialistFor.length > 0, "verified specialists keep their scope");
});

test("an unverified accredited reporter or draft specialist scope can never lift a source to grade B", () => {
  const draft: SourceRegistrySeedEntry = {
    ...entries.find((entry) => entry.domain === "football.london")!,
    domain: "draft-outlet.example",
    accreditedReporters: ["Jane Writer"],
    reporterScopes: { "Jane Writer": [REGISTRY_TEAMS.crystalPalace] },
  };
  const seed: SourceRegistrySeed = { ...SOURCE_REGISTRY_SEED, entries: [draft] };
  const byline = { url: "https://draft-outlet.example/news/a", author: "Jane Writer", isDirectQuote: false };
  assert.equal(assessSource(byline, seed.entries).quality, "B", "the raw draft entry would grant B");
  assert.equal(assessSource(byline, effectiveRegistryEntries(seed)).quality, "C", "the effective registry does not");
  const verified: SourceRegistrySeed = { ...seed, entries: [{ ...draft, reviewStatus: "verified" }] };
  assert.equal(assessSource(byline, effectiveRegistryEntries(verified)).quality, "B");
});

test("an unverified entry is never an official source", () => {
  for (const entry of entries) {
    if (!grantsTrustPrivileges(entry)) {
      assert.equal(entry.officialFor, undefined, entry.domain);
      assert.ok(!entry.defaultType.startsWith("official"), entry.domain);
    }
  }
});
