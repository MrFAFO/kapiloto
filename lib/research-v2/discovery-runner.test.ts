import assert from "node:assert/strict";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import tls from "node:tls";

import { syntheticLeague } from "@/lib/evaluation/test-fixtures";

import { CANDIDATE_DETERMINISTIC_BASE_CONFIG } from "./base";
import { CANDIDATE_COMBINATIONS } from "./combination";
import { CANDIDATE_PRICING } from "./cost-ledger";
import { replayDiscoveryArtifact, sealDiscoveryArtifact, type DiscoveryArtifact, type SearchNames } from "./discovery-artifact";
import type { DiscoveryClaim } from "./discovery-contract";
import { CANDIDATE_RESEARCH_CONFIGS, fetchPolicyRecord, retryDecision, runDiscoveryResearch, type ResearchDeps } from "./discovery-runner";
import { CANDIDATE_LEAGUE_MEMBERSHIP_CONFIG } from "./league-membership";
import { captureLiveDevArtifact, type LiveDevArtifact, type LiveDevFixtureIdentity, type LiveDevHistoryRow, type LiveDevProviders, type MarketInput } from "./live-dev-runner";
import type { ResponsesClient } from "./model-call";
import { blockAllNetwork } from "./network-block";
import { FETCHER_CONFIG, safeFetch, type ResponseChecks, type SafeFetchResult } from "./safe-fetch";
import type { SourceRegistrySeed } from "./source-registry";
import { CANDIDATE_TRIAGE_CONFIG } from "./triage";

// ---- synthetic base (no provider call) ---------------------------------------------------

const PREMIER: LiveDevHistoryRow[] = syntheticLeague({ teams: 10, seasons: 2, competitionKey: "sportmonks:8" }).map((row) => ({ ...row, providerSeasonId: null }));
const NOW = new Date(Math.max(...PREMIER.map((m) => Date.parse(m.kickoffAt))) + 20 * 86_400_000);
const MIN = 60_000;
const at = (minutes: number, ms = 0) => new Date(NOW.getTime() + minutes * MIN + ms);
const iso = (minutes: number, ms = 0) => at(minutes, ms).toISOString();

function identity(gameNumber: number, kickoffAt: string): LiveDevFixtureIdentity {
  return {
    fixtureId: `fixture-${gameNumber}`, roundId: "round-1", roundGameId: `rg-${gameNumber}`, gameNumber,
    homeTeamId: `home-${gameNumber}`, awayTeamId: `away-${gameNumber}`, homeName: `Home ${gameNumber}`, awayName: `Away ${gameNumber}`,
    competitionId: "competition-8", competitionName: "Premier League", competitionType: "league", kickoffAt, status: "upcoming",
    neutralVenue: false, legNumber: null, sportmonks: { leagueId: "8", homeTeamId: "t0", awayTeamId: "t5", fixtureId: `sm-target-${gameNumber}` },
  };
}

const market = (priceAt: string): MarketInput => ({
  status: "ok", capturedAt: NOW.toISOString(), apiFootballFixtureId: "af-1", resolution: "provider_team_ids",
  quotes: Array.from({ length: 4 }, (_, i) => ({ bookmakerId: `b${i}`, bookmakerName: `Book ${i}`, sourceUpdatedAt: priceAt, odds: { home: 1.9 + i * 0.01, draw: 3.6, away: 4.3 - i * 0.01 } })),
});

async function makeBase(options: { games?: number[]; kickoffAt?: string; priceAt?: string } = {}): Promise<LiveDevArtifact> {
  const games = options.games ?? [8];
  const providers: LiveDevProviders = {
    now: () => NOW,
    loadIdentities: async () => games.map((game) => identity(game, options.kickoffAt ?? iso(6 * 60))),
    loadLeagueHistory: async () => PREMIER,
    loadMarket: async () => market(options.priceAt ?? iso(-30)),
    loadTriageContext: async () => ({
      structuredSnapshotId: "snap",
      context: { managerChange: { home: { status: "unknown" }, away: { status: "unknown" } }, restDays: { home: 6, away: 6 }, matchesLast14Days: { home: 2, away: 2 }, competition: { isCup: false, isSecondLeg: false }, unresolvedAvailability: null },
    }),
  };
  return captureLiveDevArtifact({
    roundId: "round-1", providers, historyLookbackDays: 1460, historyFloor: null,
    configs: { base: CANDIDATE_DETERMINISTIC_BASE_CONFIG, combinations: CANDIDATE_COMBINATIONS, triage: CANDIDATE_TRIAGE_CONFIG, membership: CANDIDATE_LEAGUE_MEMBERSHIP_CONFIG },
  });
}

// ---- synthetic registry, pages, model replies ---------------------------------------------

const REGISTRY: SourceRegistrySeed = {
  id: "research-v2-source-registry", version: "source-registry-test", status: "candidate",
  entries: [
    { domain: "home8news.example", organization: "Home 8 News", defaultType: "major_outlet", specialistFor: ["sportmonks:t0" as never], competitions: ["sportmonks:8"], languages: ["en"], reviewStatus: "verified", evidence: { checkedOn: "2026-10-25", methods: ["dedicated_section"], sources: ["https://home8news.example/club"], finding: "synthetic test specialist" } },
    { domain: "national.example", organization: "National", defaultType: "major_outlet", competitions: ["sportmonks:8"], languages: ["en"], reviewStatus: "verified", evidence: { checkedOn: "2026-10-25", methods: ["http_title"], sources: ["https://national.example/"], finding: "synthetic national outlet" } },
  ],
};
const CONFIGS = { ...CANDIDATE_RESEARCH_CONFIGS, registry: REGISTRY };
const NAMES: SearchNames = { home: { en: "Home Eight", source: [] }, away: { en: "Away Eight", source: [] } };

const QUOTE = "John Keeper will miss Sunday's game with a knee injury";
const ARTICLE = "https://home8news.example/news/keeper";

function claim(overrides: Partial<DiscoveryClaim> & { name?: string; quote?: string; url?: string } = {}): DiscoveryClaim {
  const { name = "John Keeper", quote = QUOTE, url = ARTICLE, ...rest } = overrides;
  return {
    claim_id: "C1", need_id: "availability_rotation_check:home", claim_kind: "absence", side: "home",
    subject: { type: "player", name_in_source: name, name_normalized_en: name, role: "goalkeeper", squad_status_claimed: "first_choice", squad_status_quote: null, named_players: [] },
    claim: `${name} is ruled out of the match.`, stated_status: "confirmed", applies_to_this_fixture: true, event_time: null,
    observation: "reported", extraction_confidence: "high", corroboration_claimed: false,
    citations: [{ url, quote, publisher_claimed: null, author_claimed: null, published_at_claimed: null }],
    ...rest,
  };
}

const usage = (input: number, output: number) => ({ input_tokens: input, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output });
const searchCall = (sources: string[]) => ({ type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", queries: ["team news"], sources: sources.map((url) => ({ type: "url", url })) } });
const discoveryReply = (claims: DiscoveryClaim[], options: { sources?: string[]; fixtureRef?: string; searched?: boolean } = {}) => ({
  id: "resp_d", model: "gpt-6.1-sol-2026-10-01", status: "completed", usage: usage(20_000, 1_500),
  output: [
    ...(options.searched === false ? [] : [searchCall(options.sources ?? [ARTICLE])]),
    { type: "message", content: [{ type: "output_text", text: JSON.stringify({ contract_version: "kapiloto-research-v2-discovery-v2", fixture_ref: options.fixtureRef ?? "fx-8", needs_addressed: [], claims }), annotations: [] }] },
  ],
});
const judgedItem = (itemId: string, span: string, extra: Record<string, unknown> = {}) => ({
  item_id: itemId, verdicts: { claim_kind: "entailed", side: "entailed", subject: "entailed", stated_status: "entailed", applies_to_fixture: "entailed" },
  support_span: span, attribution: { reporting: "primary", direct_quote: false, cited_origin: { type: "none", name: null, date: null } },
  squad_status_supported: true, named_players_supported: [], ...extra,
});
const lunaReply = (items: unknown[], fixtureRef = "fx-8") => ({
  id: "resp_l", model: "gpt-6-luna-2026-09-15", status: "completed", usage: usage(3_000, 600),
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ contract_version: "kapiloto-research-v2-entailment-v1", fixture_ref: fixtureRef, items }), annotations: [] }] }],
});

/** Routes discovery requests (with tools) and judge requests (without) to their own reply queues. */
function client(discovery: Array<unknown | Error>, luna: Array<unknown | Error> = []): ResponsesClient & { calls: { discovery: number; luna: number } } {
  const calls = { discovery: 0, luna: 0 };
  return {
    calls,
    responses: {
      async create(body) {
        const isDiscovery = Array.isArray(body.tools);
        const queue = isDiscovery ? discovery : luna;
        const index = isDiscovery ? calls.discovery++ : calls.luna++;
        const reply = queue[index];
        if (reply === undefined) throw new Error(`unexpected ${isDiscovery ? "discovery" : "luna"} call ${index + 1}`);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
}

const page = (body: string, published: string, byline = "Beat Writer") =>
  `<html><head><meta property="article:published_time" content="${published}"><meta name="author" content="${byline}"></head><body><p>${body}</p></body></html>`;
const ACCEPTED = (bytes: number): ResponseChecks => ({ httpStatus: 200, status: "passed", mediaType: "text/html", contentType: "passed", encoding: "passed", size: "passed", bytes });
const NOT_REACHED: ResponseChecks = { httpStatus: null, status: "not_reached", mediaType: null, contentType: "not_reached", encoding: "not_reached", size: "not_reached", bytes: null };
const allowedHop = (url: string, addresses = ["93.184.216.34"]) => ({ url, host: new URL(url).hostname, addresses, allowed: true, reason: null });
const ok = (url: string, html: string, retrievedAt: string): SafeFetchResult => ({
  ok: true, requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", charset: "utf-8", bytes: html.length,
  bodySha256: "0".repeat(64), body: html, redirects: [], decisions: [allowedHop(url)], responseChecks: ACCEPTED(html.length), retrievedAt,
});

type Clock = { t: number; step: number };
function deps(options: { client: ResponsesClient; clock: Clock; pages?: Record<string, string>; status?: (call: number) => { status: string; kickoffAt: string }; onFetch?: (url: string) => void; fetchResult?: (url: string) => SafeFetchResult }) {
  let statusCalls = 0;
  const fetched: string[] = [];
  const d: ResearchDeps & { fetched: string[] } = {
    fetched,
    now: () => {
      const value = new Date(options.clock.t);
      options.clock.t += options.clock.step;
      return value;
    },
    responsesClient: options.client,
    loadFixtureStatus: async () => options.status?.(statusCalls++) ?? { status: "upcoming", kickoffAt: iso(6 * 60) },
    fetchPage: async (url) => {
      fetched.push(url);
      options.onFetch?.(url);
      if (options.fetchResult) return options.fetchResult(url);
      const html = options.pages?.[url];
      if (!html) return { ok: false, requestedUrl: url, reason: "http_status", detail: "404", redirects: [], decisions: [allowedHop(url)], responseChecks: { ...NOT_REACHED, httpStatus: 404, status: "failed" } };
      return ok(url, html, new Date(options.clock.t).toISOString());
    },
  };
  return d;
}

const startClock = (minutesAfterBase = 5, step = 1_000): Clock => ({ t: at(minutesAfterBase).getTime(), step });
const keeperPage = (published = iso(1)) => ({ [ARTICLE]: page(`Team news. ${QUOTE}. More copy.`, published) });

async function research(options: {
  base?: LiveDevArtifact;
  discovery: Array<unknown | Error>;
  luna?: Array<unknown | Error>;
  pages?: Record<string, string>;
  clock?: Clock;
  configs?: typeof CONFIGS;
  status?: (call: number) => { status: string; kickoffAt: string };
  fetchResult?: (url: string) => SafeFetchResult;
  onFetch?: (url: string) => void;
}) {
  const base = options.base ?? (await makeBase());
  const c = client(options.discovery, options.luna ?? []);
  const d = deps({ client: c, clock: options.clock ?? startClock(), pages: options.pages ?? keeperPage(), status: options.status, fetchResult: options.fetchResult, onFetch: options.onFetch });
  const artifact = await runDiscoveryResearch({ base, fixtures: [{ fixtureId: "fixture-8", searchNames: NAMES }], deps: d, configs: options.configs ?? CONFIGS });
  return { artifact, base, client: c, deps: d, outcome: artifact.deterministic.outputs.fixtures[0], record: artifact.deterministic.inputs.fixtures[0] };
}

const unchanged = (outcome: DiscoveryArtifact["deterministic"]["outputs"]["fixtures"][number]) =>
  outcome.candidates.length > 0 && outcome.candidates.every((c) => c.preMatchesBase && JSON.stringify(c.preBp) === JSON.stringify(c.postBp));
const timeout = () => Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { name: status >= 500 ? "InternalServerError" : "BadRequestError", status });

// ---- happy path, adjustments, replay -------------------------------------------------------

test("one valid adjustment end to end: discovery, safe fetch, judge, claim decision, full-path shift", async () => {
  const { outcome, record, client: c, deps: d, artifact } = await research({ discovery: [discoveryReply([claim()])], luna: [lunaReply([judgedItem("C1#0", "knee injury")])] });
  assert.equal(outcome.status, "researched");
  assert.deepEqual([c.calls.discovery, c.calls.luna], [1, 1]);
  assert.deepEqual(d.fetched, [ARTICLE]);
  assert.equal(record.timestamps.knowledgeCutoffAt, record.timestamps.researchStartedAt);
  assert.ok(Date.parse(record.timestamps.evidenceCutoffAt!) > Date.parse(record.timestamps.knowledgeCutoffAt!));
  assert.deepEqual([record.eligibility.e1?.eligible, record.eligibility.e2?.eligible], [true, true]);
  assert.equal(outcome.counts.adjusting, 1);
  assert.equal(outcome.adjustments[0].decision.path, "full");
  assert.equal(outcome.adjustments[0].timing.class, "after_newest_price");
  assert.equal(outcome.adjustments[0].decision.proposal.impact_class, "moderate");
  const marketOnly = outcome.candidates.find((c) => c.candidateId === "market_only")!;
  assert.equal(marketOnly.preMatchesBase, true);
  assert.ok(marketOnly.postBp!.home < marketOnly.preBp!.home, "a weakened home side loses probability");
  assert.equal(marketOnly.fullShift, -0.12);
  assert.ok(outcome.planReproduced && outcome.judgeSelectionReproduced && outcome.snapshotVerified);
  // Bodies are never stored; only windows and hashes.
  assert.ok(!JSON.stringify(artifact).includes("<html>"));
  assert.ok(record.citations[0].evidence?.window?.text.includes(QUOTE));
  assert.ok(!JSON.stringify(artifact.deterministic).match(/"(recommendation|pick|double|tip|bet)":(?!null)/), "no recommendation, pick or double anywhere (the base's own null is allowed)");
});

test("replay is bit-identical offline; runtime diagnostics are outside the hash; tampering is detected", async () => {
  const { artifact } = await research({ discovery: [discoveryReply([claim()])], luna: [lunaReply([judgedItem("C1#0", "knee injury")])] });
  const stored = JSON.parse(JSON.stringify(artifact)) as DiscoveryArtifact;
  const replay = replayDiscoveryArtifact(stored);
  assert.deepEqual([replay.identical, replay.snapshotsVerified, replay.artifactSha256], [true, true, artifact.deterministic.artifactSha256]);
  const resealed = sealDiscoveryArtifact(stored.deterministic.inputs, { ...stored.runtime, fixtures: stored.runtime.fixtures.map((f) => ({ ...f, attemptLatenciesMs: [99_999] })) });
  assert.equal(resealed.deterministic.artifactSha256, artifact.deterministic.artifactSha256);

  const tamperedWindow = structuredClone(stored);
  const window = tamperedWindow.deterministic.inputs.fixtures[0].citations[0].evidence!.window!;
  window.text = window.text.replace("knee", "ankle");
  const windowReplay = replayDiscoveryArtifact(tamperedWindow);
  assert.equal(windowReplay.identical, false);
  assert.equal(windowReplay.outputs.fixtures[0].counts.adjusting, 0, "a tampered window fails its own hash check");

  const tamperedBase = structuredClone(stored);
  (tamperedBase.deterministic.inputs.fixtures[0].snapshot.fixtureOutput.armsBp as Record<string, unknown>).p_market_v1 = { home: 1, draw: 1, away: 9998 };
  const baseReplay = replayDiscoveryArtifact(tamperedBase);
  assert.deepEqual([baseReplay.identical, baseReplay.snapshotsVerified, baseReplay.outputs.fixtures[0].reasons], [false, false, ["snapshot_hash_mismatch"]]);
  assert.throws(() => replayDiscoveryArtifact({ ...stored, schemaVersion: "other" } as unknown as DiscoveryArtifact), /artifact_schema_unsupported/);
});

test("the fetch-security policy outcome is hashed; resolved addresses and latency are not", async () => {
  const { artifact, record } = await research({ discovery: [discoveryReply([claim()])], luna: [lunaReply([judgedItem("C1#0", "knee injury")])] });
  assert.deepEqual(record.fetches[0].policy, {
    policy: { id: "research-v2-fetcher", version: "fetcher-v1" },
    requestedUrl: ARTICLE,
    canonicalUrl: ARTICLE,
    allowed: true,
    reason: null,
    reasonDetail: null,
    hops: [{ url: ARTICLE, scheme: "https", host: "home8news.example", allowed: true, reason: null, redirect: null }],
    finalUrl: ARTICLE,
    response: ACCEPTED(record.fetches[0].policy!.response.bytes!),
    outcome: "fetched",
  });
  assert.ok(!JSON.stringify(artifact.deterministic).includes("93.184.216.34"), "resolved addresses stay out of the hash");
  const stored = JSON.parse(JSON.stringify(artifact)) as DiscoveryArtifact;
  const hash = stored.deterministic.artifactSha256;

  // Runtime-only diagnostics: different addresses (DNS/CDN variation) and latencies seal to the same hash.
  const diagnostics = structuredClone(stored.runtime);
  diagnostics.fixtures[0].fetchDiagnostics[0].latencyMs = 87_654;
  diagnostics.fixtures[0].fetchDiagnostics[0].hops[0].addresses = ["151.101.1.1", "2a04:4e42::1"];
  diagnostics.fixtures[0].attemptLatenciesMs = [1, 2];
  assert.equal(sealDiscoveryArtifact(stored.deterministic.inputs, diagnostics).deterministic.artifactSha256, hash);

  // Policy outcome: any change to allow/block, reason, redirect hops or acceptance checks changes the hash.
  const tamper = (edit: (policy: NonNullable<DiscoveryArtifact["deterministic"]["inputs"]["fixtures"][number]["fetches"][number]["policy"]>) => void) => {
    const copy = structuredClone(stored);
    edit(copy.deterministic.inputs.fixtures[0].fetches[0].policy!);
    assert.equal(replayDiscoveryArtifact(copy).identical, false);
    return sealDiscoveryArtifact(copy.deterministic.inputs, copy.runtime).deterministic.artifactSha256;
  };
  const tampered = [
    tamper((policy) => { policy.hops[0].allowed = false; policy.hops[0].reason = "resolves_to_blocked_address"; }),
    tamper((policy) => { policy.reason = "unsupported_content_type"; }),
    tamper((policy) => { policy.hops[0].redirect = { to: "https://elsewhere.example/a", status: 302 }; }),
    tamper((policy) => { policy.hops.push({ url: "https://elsewhere.example/a", scheme: "https", host: "elsewhere.example", allowed: false, reason: "ip_literal_host", redirect: null }); }),
    tamper((policy) => { policy.response.contentType = "failed"; }),
    tamper((policy) => { policy.policy.version = "fetcher-v0"; }),
  ];
  for (const value of tampered) assert.notEqual(value, hash);
});

test("redirect hops are recorded with their own allow/block result; failure detail never carries addresses", async () => {
  const body = (status: number, headers: Record<string, string>, text = "") => ({
    status, headers, destroy: () => {}, body: (async function* () { if (text) yield Buffer.from(text); })(),
  });
  const routes: Record<string, () => ReturnType<typeof body>> = {
    "http://news.example.com/a": () => body(301, { location: "https://news.example.com/a" }),
    "https://news.example.com/a": () => body(302, { location: "https://internal.example.com/secret" }),
  };
  const result = await safeFetch("http://news.example.com/a", {
    resolver: async (host) => [{ address: host === "internal.example.com" ? "192.168.0.10" : "93.184.216.34", family: 4 }],
    transport: async ({ url }) => routes[url.toString()](),
  });
  const policy = fetchPolicyRecord("http://news.example.com/a", result, FETCHER_CONFIG);
  assert.deepEqual(policy.hops.map((hop) => [hop.url, hop.scheme, hop.allowed, hop.reason, hop.redirect]), [
    ["http://news.example.com/a", "http", true, null, { to: "https://news.example.com/a", status: 301 }],
    ["https://news.example.com/a", "https", true, null, { to: "https://internal.example.com/secret", status: 302 }],
    ["https://internal.example.com/secret", "https", false, "resolves_to_blocked_address", null],
  ]);
  assert.deepEqual([policy.allowed, policy.reason, policy.reasonDetail, policy.finalUrl, policy.outcome], [false, "resolves_to_blocked_address", null, null, "failed"]);
  assert.equal(policy.response.httpStatus, 302, "the last response seen was the refused redirect");
  assert.ok(!JSON.stringify(policy).includes("192.168.0.10") && !JSON.stringify(policy).includes("93.184.216.34"));

  const tooLarge = fetchPolicyRecord("https://a.example/x", { ok: false, requestedUrl: "https://a.example/x", reason: "response_too_large", detail: "content-length 5000000", redirects: [], decisions: [allowedHop("https://a.example/x")], responseChecks: { ...NOT_REACHED, httpStatus: 200, status: "passed", mediaType: "text/html", contentType: "passed", size: "failed" } }, FETCHER_CONFIG);
  assert.deepEqual([tooLarge.allowed, tooLarge.reason, tooLarge.reasonDetail, tooLarge.response.size], [true, "response_too_large", "content-length 5000000", "failed"]);
  const transport = fetchPolicyRecord("https://a.example/x", { ok: false, requestedUrl: "https://a.example/x", reason: "transport_error", detail: "Error: connect ECONNREFUSED 93.184.216.34:443", redirects: [], decisions: [allowedHop("https://a.example/x")], responseChecks: NOT_REACHED }, FETCHER_CONFIG);
  assert.equal(transport.reasonDetail, null, "raw transport error text stays in runtime");
});

test("several adjustments hit the existing effect cap", async () => {
  const names = ["John Keeper", "Second Keeper", "Third Keeper", "Fourth Keeper"];
  const sentences = names.map((name) => `${name} will miss Sunday's game with an injury`);
  const claims = names.map((name, i) => claim({ claim_id: `C${i + 1}`, name, quote: sentences[i] }));
  const pages = { [ARTICLE]: page(`Team news. ${sentences.join(". ")}. End.`, iso(1)) };
  const { outcome } = await research({ discovery: [discoveryReply(claims)], luna: [lunaReply(names.map((_, i) => judgedItem(`C${i + 1}#0`, "will miss Sunday")))], pages });
  assert.equal(outcome.counts.adjusting, 4);
  const marketOnly = outcome.candidates.find((c) => c.candidateId === "market_only")!;
  assert.equal(marketOnly.capped, true);
  assert.equal(marketOnly.fullShift, -CONFIGS.effects.totalCap);
});

test("a market that becomes non-fresh by the knowledge cutoff moves adjustments to the stat path", async () => {
  const base = await makeBase({ priceAt: iso(-355) });
  const { outcome } = await research({ base, clock: startClock(6), discovery: [discoveryReply([claim()])], luna: [lunaReply([judgedItem("C1#0", "knee injury")])], pages: keeperPage(iso(2)) });
  assert.equal(outcome.market?.quality, "thin");
  assert.equal(outcome.market?.reason, "market_information_not_fresh");
  assert.equal(outcome.adjustments[0].decision.path, "stat_path");
  const marketOnly = outcome.candidates.find((c) => c.candidateId === "market_only")!;
  const eloOnly = outcome.candidates.find((c) => c.candidateId === "stat_elo_only")!;
  assert.deepEqual(marketOnly.postBp, marketOnly.preBp, "the market input is never adjusted");
  assert.notDeepEqual(eloOnly.postBp, eloOnly.preBp);
});

// ---- gates: freshness, eligibility --------------------------------------------------------

test("base freshness: exactly 15 minutes runs, 15 minutes + 1 ms is refused before any call", async () => {
  const fixed = (minutes: number, ms = 0): Clock => ({ t: at(minutes, ms).getTime(), step: 0 });
  const allowed = await research({ clock: fixed(15), discovery: [discoveryReply([])] });
  assert.equal(allowed.record.gates.final?.fresh, true);
  assert.equal(allowed.client.calls.discovery, 1);
  const stale = await research({ clock: fixed(15, 1), discovery: [] });
  assert.deepEqual([stale.record.stoppedAt, stale.outcome.status, stale.outcome.reasons], ["fresh_base_required", "not_researched", ["fresh_base_required"]]);
  assert.deepEqual([stale.client.calls.discovery, stale.client.calls.luna, stale.deps.fetched.length], [0, 0, 0]);
  assert.ok(unchanged(stale.outcome), "the base forecast stands");
});

test("eligibility #1: exactly 60 minutes runs, 60 minutes − 1 ms does not start research", async () => {
  const start = at(5).getTime();
  const fixed = (): Clock => ({ t: start, step: 0 });
  const kickoff = (ms: number) => () => ({ status: "upcoming", kickoffAt: new Date(start + 60 * MIN + ms).toISOString() });
  const exact = await research({ clock: fixed(), status: kickoff(0), discovery: [discoveryReply([])] });
  assert.equal(exact.record.eligibility.e1?.eligible, true);
  const short = await research({ clock: fixed(), status: kickoff(-1), discovery: [] });
  assert.deepEqual([short.record.stoppedAt, short.record.eligibility.e1?.reason, short.client.calls.discovery], ["e1_ineligible", "kickoff_within_min_lead", 0]);
  assert.ok(unchanged(short.outcome));
});

test("eligibility #2: crossing the minimum lead keeps the artifact but makes all evidence non-adjusting", async () => {
  const clock: Clock = { t: at(5).getTime(), step: 0 };
  const kickoffAt = new Date(clock.t + 65 * MIN).toISOString();
  const { outcome, record, client: c } = await research({
    clock, status: () => ({ status: "upcoming", kickoffAt }),
    onFetch: () => { clock.t += 10 * MIN; }, // a slow fetch: the evidence cutoff is now 55 minutes before kickoff
    discovery: [discoveryReply([claim()])],
  });
  assert.deepEqual([record.eligibility.e1?.eligible, record.eligibility.e2?.eligible, record.eligibility.e2?.reason], [true, false, "kickoff_within_min_lead"]);
  assert.equal(record.entailment?.skipped, "crossed_min_lead");
  assert.equal(c.calls.luna, 0, "no judge spend after crossing the lead");
  assert.equal(outcome.status, "researched");
  assert.ok(outcome.reasons.includes("crossed_min_lead"));
  assert.equal(outcome.adjustments.length, 0);
  assert.ok(unchanged(outcome));
});

// ---- discovery retries ----------------------------------------------------------------------

test("retry policy: transient failures retry once; 4xx, refusals and safety failures never retry", () => {
  const result = (failure: string | null, errorStatus: number | null = null) => ({ status: failure ? "failed" : "ok", failure, errorStatus }) as never;
  const policy = CONFIGS.retry;
  for (const failure of ["timeout", "malformed_output", "schema_invalid", "incomplete", "search_not_executed"]) assert.equal(retryDecision(result(failure), policy)?.retryable, true, failure);
  assert.equal(retryDecision(result("api_error", 503), policy)?.retryable, true);
  assert.equal(retryDecision(result("api_error", null), policy)?.retryable, true);
  assert.deepEqual(retryDecision(result("api_error", 400), policy), { retryable: false, reason: "not_retryable:api_error_400" });
  for (const failure of ["refusal", "forecast_field_in_output", "fixture_ref_mismatch", "unsafe_input", "no_needs", "spend_guard_blocked"]) {
    assert.equal(retryDecision(result(failure), policy)?.retryable, false, failure);
  }
  assert.equal(retryDecision(result(null), policy), null);
  assert.equal(policy.maxRetries, 1);
});

/** Room for one retry of a standard-tier call ($0.446 projection): a timeout is charged its full projection. */
const RETRY_ROOM = { ...CONFIGS, spendGuard: { ...CONFIGS.spendGuard, perFixtureCapUsd: 1.0 } };

test("a timed-out discovery is retried once with the same input and cutoff, and the retry can succeed", async () => {
  const { outcome, record, client: c } = await research({ configs: RETRY_ROOM, discovery: [timeout(), discoveryReply([claim()])], luna: [lunaReply([judgedItem("C1#0", "knee injury")])] });
  assert.equal(c.calls.discovery, 2);
  assert.deepEqual(record.attempts.map((a) => [a.attempt, a.result.status, a.retry?.reason ?? null]), [[1, "failed", "retryable:timeout"], [2, "ok", null]]);
  assert.equal(record.attempts[0].result.request?.payloadSha256, record.attempts[1].result.request?.payloadSha256, "same immutable input");
  assert.equal(record.eligibility.retry?.eligible, true);
  assert.equal(outcome.counts.adjusting, 1);
});

test("Sol 5xx, malformed output and search_not_executed are retried; 4xx is not; every failure leaves the base", async () => {
  const fail2 = async (first: unknown, second: unknown) => research({ configs: RETRY_ROOM, discovery: [first, second] });
  for (const [first, label] of [[httpError(503), "5xx"], [{ ...discoveryReply([claim()]), output: [searchCall([ARTICLE]), { type: "message", content: [{ type: "output_text", text: "{bad", annotations: [] }] }] }, "malformed"], [discoveryReply([claim()], { searched: false }), "search_not_executed"]] as const) {
    const run = await fail2(first, first);
    assert.equal(run.client.calls.discovery, 2, label);
    assert.deepEqual([run.record.stoppedAt, run.outcome.status], ["discovery_failed", "research_failed"], label);
    assert.ok(unchanged(run.outcome), label);
  }
  const clientError = await research({ configs: RETRY_ROOM, discovery: [httpError(400)] });
  assert.equal(clientError.client.calls.discovery, 1);
  assert.equal(clientError.record.attempts[0].retry?.reason, "not_retryable:api_error_400");
  assert.ok(unchanged(clientError.outcome));
});

test("a retry blocked by the fixture cap never reaches the network (default caps, standard tier)", async () => {
  const { record, client: c, artifact } = await research({ discovery: [timeout()] });
  assert.equal(record.plan?.tier, "standard");
  assert.equal(c.calls.discovery, 1);
  assert.deepEqual(record.attempts.map((a) => a.result.failure), ["timeout", "spend_guard_blocked"]);
  assert.equal(record.attempts[1].result.detail, "fixture_cap_would_be_exceeded");
  assert.equal(artifact.deterministic.inputs.ledger.fixtures["fx-8"].chargedMicros, 446_000, "the timed-out call is charged its full projection");
  assert.equal(artifact.deterministic.outputs.fixtures[0].status, "research_failed");
});

test("a retry blocked by the run cap stops; one fixture cannot spend another fixture's budget", async () => {
  const configs = { ...CONFIGS, spendGuard: { ...CONFIGS.spendGuard, perFixtureCapUsd: 1.0, runCapUsd: 1.5 } };
  const base = await makeBase({ games: [7, 8] });
  const c = client([timeout(), timeout(), timeout()]);
  const d = deps({ client: c, clock: startClock() });
  const artifact = await runDiscoveryResearch({ base, fixtures: [{ fixtureId: "fixture-7", searchNames: NAMES }, { fixtureId: "fixture-8", searchNames: NAMES }], deps: d, configs });
  const [seven, eight] = artifact.deterministic.inputs.fixtures;
  assert.deepEqual(seven.attempts.map((a) => a.result.failure), ["timeout", "timeout"]);
  assert.deepEqual(eight.attempts.map((a) => a.result.failure), ["timeout", "spend_guard_blocked"]);
  assert.equal(eight.attempts[1].result.detail, "run_cap_would_be_exceeded");
  assert.equal(c.calls.discovery, 3);
  const ledger = artifact.deterministic.inputs.ledger;
  assert.deepEqual([ledger.fixtures["fx-7"].chargedMicros, ledger.fixtures["fx-8"].chargedMicros, ledger.run.chargedMicros], [892_000, 446_000, 1_338_000], "each fixture is charged only for its own calls");
});

// ---- evidence-stage failures ----------------------------------------------------------------

test("zero useful claims, citations that all fail, and blocked fetches leave the base forecast in force", async () => {
  const none = await research({ discovery: [discoveryReply([])] });
  assert.deepEqual([none.outcome.status, none.outcome.counts.claims, none.deps.fetched.length], ["researched", 0, 0]);
  assert.ok(none.outcome.reasons.includes("no_admitted_claims") && unchanged(none.outcome));

  const unobserved = await research({ discovery: [discoveryReply([claim({ url: "https://home8news.example/other" })])] });
  assert.equal(unobserved.deps.fetched.length, 0, "a URL outside the recorded sources is never fetched");
  assert.deepEqual(unobserved.outcome.citationChecks[0].rejections, ["url_not_observed", "not_fetched"]);
  assert.equal(unobserved.outcome.claims?.claims[0].status, "rejected");
  assert.ok(unchanged(unobserved.outcome));

  const blocked = await research({
    discovery: [discoveryReply([claim()])],
    fetchResult: (url) => ({ ok: false, requestedUrl: url, reason: "resolves_to_blocked_address", detail: "10.0.0.5", redirects: [], decisions: [{ url, host: "home8news.example", addresses: ["10.0.0.5"], allowed: false, reason: "resolves_to_blocked_address" }], responseChecks: NOT_REACHED }),
  });
  assert.deepEqual(blocked.outcome.citationChecks[0].rejections, ["fetch_blocked"]);
  assert.equal(blocked.client.calls.luna, 0);
  assert.deepEqual([blocked.record.fetches[0].policy?.allowed, blocked.record.fetches[0].policy?.reason], [false, "resolves_to_blocked_address"], "the block and its reason are hashed");
  assert.ok(!JSON.stringify(blocked.artifact.deterministic).includes("10.0.0.5"), "resolved addresses never enter the hash");
  assert.deepEqual(blocked.artifact.runtime.fixtures[0].fetchDiagnostics[0].hops[0].addresses, ["10.0.0.5"], "addresses are kept as runtime diagnostics");
  assert.ok(unchanged(blocked.outcome));
});

test("only cited URLs from the recorded sources are fetched, deduplicated, in order, within maxFetchedPages", async () => {
  const letters = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const urls = ["https://home8news.example/a", "https://home8news.example/a?utm_source=x", ...letters.slice(1).map((letter) => `https://home8news.example/${letter}`)];
  const claims = urls.map((url, i) => claim({ claim_id: `C${String(i + 1).padStart(2, "0")}`, name: `Player ${i}`, url, quote: `Player ${i} out` }));
  const { record, deps: d } = await research({ discovery: [discoveryReply(claims, { sources: urls })], pages: {} });
  const budget = record.plan!.budget.maxFetchedPages;
  const canonical = letters.map((letter) => `https://home8news.example/${letter}`);
  assert.deepEqual(d.fetched, canonical.slice(0, budget), "canonical duplicates fetched once, in claim order, within the page budget");
  assert.deepEqual(record.fetches.map((f) => f.outcome), [...Array(budget).fill("failed"), ...Array(canonical.length - budget).fill("skipped_budget")]);
});

test("a blocked or failing judge leaves forecast-changing claims non-adjusting", async () => {
  const unpriced = { ...CONFIGS, pricing: { ...CANDIDATE_PRICING, luna: null } };
  const blocked = await research({ configs: unpriced, discovery: [discoveryReply([claim()])] });
  assert.equal(blocked.record.entailment?.failure, "spend_guard_blocked");
  assert.equal(blocked.client.calls.luna, 0);
  assert.deepEqual(blocked.outcome.citationChecks[0].rejections, ["entailment_unsupported"]);
  assert.equal(blocked.outcome.counts.adjusting, 0);
  assert.ok(unchanged(blocked.outcome));
  const refused = await research({ discovery: [discoveryReply([claim()])], luna: [{ id: "r", model: "m", status: "completed", usage: usage(10, 1), output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] }] });
  assert.equal(refused.record.entailment?.failure, "refusal");
  assert.equal(refused.outcome.counts.adjusting, 0);
});

test("verified explanatory-only claims need no judge; an unsupported squad status adjusts nothing", async () => {
  const context = claim({ claim_kind: "squad_change", need_id: "availability_rotation_check:home" });
  const plan = await research({ discovery: [discoveryReply([context])] });
  // squad_change is not allowed for the availability need, so the parser rejects it: no claims to judge.
  assert.equal(plan.client.calls.luna, 0);
  const lineup = claim({ claim_kind: "lineup_confirmed" });
  const explanatory = await research({ discovery: [discoveryReply([lineup])] });
  assert.equal(explanatory.client.calls.luna, 0, "explanatory claims are not sent to the judge");
  assert.deepEqual([explanatory.outcome.claims?.claims[0].status, explanatory.outcome.claims?.claims[0].reasons], ["explanatory", ["explanatory_kind"]]);
  const notFirstChoice = await research({ discovery: [discoveryReply([claim()])], luna: [lunaReply([judgedItem("C1#0", "knee injury", { squad_status_supported: false })])] });
  assert.deepEqual([notFirstChoice.outcome.claims?.claims[0].status, notFirstChoice.outcome.claims?.claims[0].reasons.at(-1)], ["explanatory", "impact:availability_not_first_choice"]);
  assert.ok(unchanged(notFirstChoice.outcome));
});

// ---- isolation ------------------------------------------------------------------------------

test("replay runs under the offline guard: DNS, fetch, http(s), net and tls are all blocked", async () => {
  const { artifact } = await research({ discovery: [discoveryReply([claim()])], luna: [lunaReply([judgedItem("C1#0", "knee injury")])] });
  const stored = JSON.parse(JSON.stringify(artifact)) as DiscoveryArtifact;
  const originalLookup = dns.lookup;
  const restore = blockAllNetwork("discovery_replay_network");
  try {
    const attempts: Array<[string, () => unknown]> = [
      ["dns.lookup", () => dns.lookup("example.com", () => {})],
      ["dns.resolve", () => dns.resolve("example.com", () => {})],
      ["dns.resolve4", () => dns.resolve4("example.com", () => {})],
      ["dns.resolve6", () => dns.resolve6("example.com", () => {})],
      ["dns.resolveTxt", () => dns.resolveTxt("example.com", () => {})],
      ["dns.reverse", () => dns.reverse("93.184.216.34", () => {})],
      ["dns.promises.lookup", () => dns.promises.lookup("example.com")],
      ["dns.promises.resolve", () => dns.promises.resolve("example.com")],
      ["dns.promises.resolve4", () => dnsPromises.resolve4("example.com")],
      ["dns.promises.resolveAny", () => dnsPromises.resolveAny("example.com")],
      ["dns.Resolver.resolve4", () => new dns.Resolver().resolve4("example.com", () => {})],
      ["dns.promises.Resolver.resolve", () => new dnsPromises.Resolver().resolve("example.com")],
      ["fetch", () => fetch("https://example.com")],
      ["http.get", () => http.get("http://example.com")],
      ["https.request", () => https.request("https://example.com")],
      ["net.connect", () => net.connect(443, "example.com")],
      ["net.createConnection", () => net.createConnection(443, "example.com")],
      ["tls.connect", () => tls.connect(443, "example.com")],
    ];
    for (const [name, attempt] of attempts) {
      assert.throws(attempt, /discovery_replay_network_blocked/, `${name} must be blocked`);
    }
    const replay = replayDiscoveryArtifact(stored);
    assert.deepEqual([replay.identical, replay.snapshotsVerified], [true, true], "replay completes with every network primitive blocked");
  } finally {
    restore();
  }
  assert.equal(dns.lookup, originalLookup, "the guard restores the originals");
});

/** Runtime import graph: follows value imports and re-exports; type-only imports are erased and skipped. */
function runtimeGraph(entry: string, options: { dynamic?: boolean } = {}): Set<string> {
  const root = process.cwd();
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...[...source.matchAll(/^\s*import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]),
      ...[...source.matchAll(/^\s*export\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]),
      ...(options.dynamic ? [...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]) : []),
    ];
    for (const specifier of specifiers) {
      const base = specifier.startsWith("@/") ? join(root, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(file), specifier) : null;
      if (!base) {
        seen.add(`pkg:${specifier}`);
        continue;
      }
      for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
        if (existsSync(candidate) && candidate.endsWith(".ts")) {
          walk(candidate);
          break;
        }
      }
    }
  };
  walk(join(root, entry));
  return seen;
}
const rel = (file: string) => file.startsWith("pkg:") ? file : file.slice(process.cwd().length + 1).replace(/\\/g, "/");
const NETWORK_PACKAGES = ["pkg:openai", "pkg:node:http", "pkg:node:https", "pkg:node:net", "pkg:node:tls", "pkg:node:dns", "pkg:@supabase/supabase-js"];

test("replay reaches no network, model, fetch or database code", () => {
  const graph = [...runtimeGraph("lib/research-v2/discovery-artifact.ts")].map(rel);
  for (const forbidden of [...NETWORK_PACKAGES, "lib/research-v2/safe-fetch.ts", "lib/research-v2/model-call.ts", "lib/research-v2/discovery-client.ts", "lib/research-v2/entailment-client.ts", "lib/research-v2/live-dev-providers.ts"]) {
    assert.ok(!graph.includes(forbidden), `${forbidden} is reachable from replay`);
  }
  assert.ok(!graph.includes("lib/research-v2/network-block.ts"), "the guard is applied by the CLI, not imported by replay");
  const cli = [...runtimeGraph("scripts/research-v2-discovery.ts")].map(rel);
  for (const forbidden of ["pkg:openai", "pkg:@supabase/supabase-js", "lib/research-v2/safe-fetch.ts", "lib/research-v2/model-call.ts", "lib/research-v2/live-dev-providers.ts"]) {
    assert.ok(!cli.includes(forbidden), `${forbidden} is statically reachable from the CLI (research loads it lazily)`);
  }
});

test("the research path reaches OpenAI only through model-call, article network only through safe-fetch, and writes nothing", () => {
  const graph = runtimeGraph("lib/research-v2/discovery-runner.ts");
  const files = [...graph].filter((file) => !file.startsWith("pkg:"));
  const importing = (pkg: string) => files.filter((file) => new RegExp(`from\\s+["']${pkg}["']`).test(readFileSync(file, "utf8"))).map(rel);
  assert.deepEqual(importing("openai"), ["lib/research-v2/model-call.ts"]);
  assert.deepEqual([...importing("node:http"), ...importing("node:https"), ...importing("node:dns"), ...importing("node:net")].sort(), ["lib/research-v2/safe-fetch.ts", "lib/research-v2/safe-fetch.ts", "lib/research-v2/safe-fetch.ts", "lib/research-v2/safe-fetch.ts"]);
  assert.ok(!graph.has("pkg:@supabase/supabase-js"));
  for (const file of [...files, join(process.cwd(), "scripts", "research-v2-discovery.ts")]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /\.from\([^)]*\)\s*\.(insert|upsert|update|delete)\(|\.rpc\(|\.storage\.|\.functions\./, rel(file));
  }
  const cli = readFileSync(join(process.cwd(), "scripts", "research-v2-discovery.ts"), "utf8");
  assert.match(cli, /readOnlySupabaseClient\(/);
  assert.match(cli, /blockAllNetwork\(\);\r?\n  const result = replayDiscoveryArtifact/);
});
