import assert from "node:assert/strict";
import test from "node:test";

import { admitAdjustments, CANDIDATE_ADJUSTMENT_POLICY } from "./adjustments";
import { buildDeterministicBase } from "./base";
import { computeResearchV2Forecast } from "./forecast";
import { canonicalJson } from "./provenance";
import { assessSource, CANDIDATE_SOURCE_POLICY, corroboration } from "./sources";
import { baseInputs, CONFIGS, hoursBeforeCutoff, item, page, proposal, quotes, REGISTRY, verified } from "./test-support";

const forecastWith = (options: { publishedAt: string; marketCapturedAt?: string; bookmakers?: number; quotesOff?: boolean }) =>
  computeResearchV2Forecast(
    {
      base: baseInputs({
        marketQuotes: options.quotesOff ? [] : quotes({ capturedAt: options.marketCapturedAt, bookmakers: options.bookmakers }),
      }),
      research: { verification: verified([item()], { publishedAt: options.publishedAt }), proposals: [proposal()] },
    },
    CONFIGS,
  );

const candidate = (forecast: ReturnType<typeof forecastWith>, id: string) => forecast.candidates.find((c) => c.candidateId === id)!;

test("evidence published after a fresh, standard market snapshot may shift the forecast", () => {
  const forecast = forecastWith({ marketCapturedAt: hoursBeforeCutoff(2), publishedAt: hoursBeforeCutoff(1) });
  assert.equal(forecast.adjustments[0].path, "full");
  for (const id of ["market_only", "stat_elo_only", "log_market65_elo"]) {
    const result = candidate(forecast, id);
    assert.notEqual(canonicalJson(result.post), canonicalJson(result.pre), id);
    assert.equal(result.fullShift, -0.12);
  }
});

test("evidence known before a fresh, standard market snapshot is explanatory only", () => {
  const forecast = forecastWith({ marketCapturedAt: hoursBeforeCutoff(2), publishedAt: hoursBeforeCutoff(3) });
  assert.equal(forecast.adjustments[0].status, "admitted");
  assert.equal(forecast.adjustments[0].path, "market_likely_incorporated");
  for (const result of forecast.candidates) {
    assert.equal(canonicalJson(result.post), canonicalJson(result.pre), result.candidateId);
  }
});

test("with a thin or missing market, earlier evidence may act only through the stat path", () => {
  for (const options of [{ bookmakers: 2 }, { quotesOff: true }]) {
    const forecast = forecastWith({ ...options, publishedAt: hoursBeforeCutoff(3) });
    assert.equal(forecast.adjustments[0].path, "stat_path");
    const stat = candidate(forecast, "stat_elo_only");
    assert.notEqual(canonicalJson(stat.post), canonicalJson(stat.pre));
    assert.equal(stat.statPathShift, -0.12);
    const market = candidate(forecast, "market_only");
    assert.equal(canonicalJson(market.post), canonicalJson(market.pre), "market input is never adjusted");
  }
  const thin = forecastWith({ bookmakers: 2, publishedAt: hoursBeforeCutoff(3) });
  const pool = candidate(thin, "log_market65_elo");
  assert.equal(pool.fullShift, 0);
  assert.equal(pool.statPathShift, -0.12);
});

test("the market-timing decision is stored per adjustment", () => {
  const forecast = forecastWith({ marketCapturedAt: hoursBeforeCutoff(2), publishedAt: hoursBeforeCutoff(1) });
  const decision = forecast.adjustments[0];
  assert.equal(decision.marketQuality, "standard");
  assert.equal(decision.marketStateVersion, "market-state-v2");
  assert.equal(decision.marketInformationLatestAt, forecast.base.market.informationLatestAt);
  assert.equal(decision.marketInformationAgeMinutes, 120);
  assert.equal(decision.earliestEvidenceAt, new Date(hoursBeforeCutoff(1)).toISOString());
});

test("unverified evidence cannot create an adjustment", () => {
  const cases = [
    verified([item()], { entailment: "not_checked" }),
    verified([item()], { entailment: "unsupported" }),
    verified([item()], { pages: [page(item(), hoursBeforeCutoff(1), "A page that does not contain the quote.")] }),
    verified([item()], { publishedAt: null }),
  ];
  for (const verification of cases) {
    assert.equal(verification.evidence[0].status, "rejected");
    const forecast = computeResearchV2Forecast({ base: baseInputs(), research: { verification, proposals: [proposal()] } }, CONFIGS);
    assert.equal(forecast.adjustments[0].status, "rejected");
    assert.ok(forecast.adjustments[0].rejections.includes("unverified_evidence"));
    assert.ok(forecast.candidates.every((c) => canonicalJson(c.post) === canonicalJson(c.pre)));
  }
  const missing = verified([item()], { entailment: "not_checked" });
  assert.ok(missing.evidence[0].rejections.includes("entailment_missing"));
});

test("structured duplicate evidence cannot create an adjustment, and one subject adjusts once", () => {
  const structured = [{ team: "home" as const, playerKey: "sm:1", playerName: "Smith", status: "out" as const, source: "sportmonks" }];
  const duplicate = verified([item()], { structuredAvailability: structured });
  assert.equal(duplicate.evidence[0].status, "verified");
  assert.equal(duplicate.evidence[0].structuredDuplicate, true);
  const forecast = computeResearchV2Forecast(
    { base: baseInputs({ structuredAvailability: structured }), research: { verification: duplicate, proposals: [proposal()] } },
    CONFIGS,
  );
  assert.deepEqual(forecast.adjustments[0].rejections, ["structured_duplicate"]);

  const second = item({ evidence_id: "E2", url: "https://localecho.example/smith", quote: "Smith has been ruled out of the weekend game." });
  const twice = verified([item(), second]);
  const decisions = admitAdjustments({
    proposals: [proposal(), proposal({ proposal_id: "A2", evidence_ids: ["E2"] })],
    evidence: twice.evidence,
    market: buildDeterministicBase(baseInputs(), CONFIGS.base).market,
    sourcePolicy: CANDIDATE_SOURCE_POLICY,
    policy: CANDIDATE_ADJUSTMENT_POLICY,
  }).decisions;
  assert.equal(decisions[0].status, "admitted");
  assert.deepEqual(decisions[1].rejections, ["duplicate_adjustment"]);
});

test("syndicated duplicates count once", () => {
  const quote = "The striker Jones has a hamstring problem and will not travel for the league match.";
  const copies = verified([
    item({ evidence_id: "E1", url: "https://bignews.example/a", quote, claim_kind: "absence", player_name: "Jones", player_role: "forward" }),
    item({ evidence_id: "E2", url: "https://othernews.example/b", quote, claim_kind: "absence", player_name: "Jones", player_role: "forward" }),
  ]);
  assert.equal(copies.evidence[0].syndicationClusterId, copies.evidence[1].syndicationClusterId);
  const decision = corroboration(
    copies.evidence.map((evidence) => ({ quality: evidence.source.quality, clusterId: evidence.syndicationClusterId })),
    CANDIDATE_SOURCE_POLICY,
  );
  assert.equal(decision.independentClusters, 1);
  assert.equal(decision.forecastEligible, false);

  const independent = verified([
    item({ evidence_id: "E1", url: "https://bignews.example/a", quote, player_name: "Jones" }),
    item({ evidence_id: "E2", url: "https://othernews.example/b", quote: "Jones misses out after injuring his hamstring in training this week.", player_name: "Jones" }),
  ]);
  const both = corroboration(
    independent.evidence.map((evidence) => ({ quality: evidence.source.quality, clusterId: evidence.syndicationClusterId })),
    CANDIDATE_SOURCE_POLICY,
  );
  assert.equal(both.independentClusters, 2);
  assert.equal(both.forecastEligible, true);

  const agency = verified([
    item({ evidence_id: "E1", url: "https://bignews.example/a", author: "PA Media", quote: "Jones will not be available this weekend for the visitors." }),
    item({ evidence_id: "E2", url: "https://othernews.example/b", author: "PA Media", quote: "Jones is unavailable after a setback in training." }),
  ]);
  assert.equal(agency.evidence[0].syndicationClusterId, agency.evidence[1].syndicationClusterId, "one agency story about one subject");
});

test("weak aggregator evidence cannot independently move the forecast", () => {
  const weak = item({ url: "https://aggregator.example/x" });
  const verification = verified([weak]);
  assert.equal(verification.evidence[0].status, "verified");
  assert.equal(verification.evidence[0].source.quality, "D");
  const forecast = computeResearchV2Forecast({ base: baseInputs(), research: { verification, proposals: [proposal()] } }, CONFIGS);
  assert.deepEqual(forecast.adjustments[0].rejections, ["insufficient_source_quality"]);
  assert.ok(forecast.candidates.every((c) => canonicalJson(c.post) === canonicalJson(c.pre)));

  const twoAggregators = corroboration([{ quality: "D", clusterId: "a" }, { quality: "D", clusterId: "b" }], CANDIDATE_SOURCE_POLICY);
  assert.equal(twoAggregators.forecastEligible, false);
  const corroborated = corroboration([{ quality: "D", clusterId: "a" }, { quality: "B", clusterId: "b" }], CANDIDATE_SOURCE_POLICY);
  assert.equal(corroborated.forecastEligible, true);
});

test("strong local reporting is not downgraded for being local; trust is not a static domain score", () => {
  assert.equal(assessSource({ url: "https://localecho.example/n", author: null, isDirectQuote: false }, REGISTRY).quality, "B");
  assert.equal(assessSource({ url: "https://bignews.example/n", author: null, isDirectQuote: false }, REGISTRY).quality, "C");
  assert.equal(assessSource({ url: "https://bignews.example/n", author: "Jane Writer", isDirectQuote: false }, REGISTRY).sourceType, "accredited_reporter");
  assert.equal(assessSource({ url: "https://bignews.example/n", author: null, isDirectQuote: true }, REGISTRY).sourceType, "press_conference");
  assert.equal(assessSource({ url: "https://aggregator.example/n", author: null, isDirectQuote: true }, REGISTRY).quality, "D");
  assert.equal(assessSource({ url: "https://unknown.example/n", author: null, isDirectQuote: false }, REGISTRY).quality, "D");
  const denied = verified([item({ url: "https://blocked.example/x" })]);
  assert.ok(denied.evidence[0].rejections.includes("source_denied"));
});

test("verification rejects stale, post-cutoff and unobserved evidence", () => {
  assert.ok(verified([item()], { publishedAt: hoursBeforeCutoff(200) }).evidence[0].rejections.includes("stale_for_claim_kind"));
  assert.ok(verified([item()], { publishedAt: hoursBeforeCutoff(-1) }).evidence[0].rejections.includes("published_after_cutoff"));
});
