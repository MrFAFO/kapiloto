import assert from "node:assert/strict";
import test from "node:test";

import { devig, DEVIG_METHOD_VERSIONS } from "./devig";
import { buildMarketPrior, type MarketQuoteRecord } from "./market-prior";
import { assertValidProbabilities } from "./probabilities";

const FIXTURE = "fixture-1";
const CUTOFF = "2026-10-24T10:00:00.000Z";
const minutesBefore = (minutes: number) =>
  new Date(Date.parse(CUTOFF) - minutes * 60_000).toISOString();

function quote(
  id: string,
  bookmakerId: string,
  ageMinutes: number,
  odds = { home: 2.1, draw: 3.4, away: 3.6 },
  overrides: Partial<MarketQuoteRecord> = {},
): MarketQuoteRecord {
  return {
    id,
    fixtureId: FIXTURE,
    provider: "api-football",
    bookmakerId,
    bookmakerName: `Book ${bookmakerId}`,
    capturedAt: minutesBefore(ageMinutes),
    sourceUpdatedAt: null,
    odds,
    ...overrides,
  };
}

const prior = (quotes: MarketQuoteRecord[]) =>
  buildMarketPrior(quotes, { fixtureId: FIXTURE, cutoffAt: CUTOFF });

test("missing market returns no prediction", () => {
  const result = prior([]);
  assert.equal(result.status, "unavailable");
  assert.equal(result.status === "unavailable" && result.reason, "no_quotes_before_cutoff");
});

test("a single bookmaker is never treated as a market", () => {
  const result = prior([quote("q1", "8", 30)]);
  assert.equal(result.status === "unavailable" && result.reason, "insufficient_bookmakers");
});

test("stale quotes are excluded and an all-stale market is unavailable", () => {
  const result = prior([quote("q1", "8", 25 * 60), quote("q2", "11", 30 * 60)]);
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.reason, "stale_market");
  assert.deepEqual(
    result.excluded.map((item) => item.reason),
    ["stale", "stale"],
  );
});

test("quotes captured after the cutoff never influence the prior", () => {
  const base = [quote("q1", "8", 60), quote("q2", "11", 90)];
  const withFuture = [
    ...base,
    quote("q3", "8", -5, { home: 9, draw: 9, away: 1.1 }),
    quote("q4", "16", -60),
  ];
  const before = prior(base);
  const after = prior(withFuture);
  assert.equal(before.status, "available");
  assert.equal(after.status, "available");
  if (before.status !== "available" || after.status !== "available") return;
  assert.deepEqual(after.probabilities, before.probabilities);
  assert.deepEqual(
    after.excluded.filter((item) => item.reason === "captured_after_cutoff").map((item) => item.quoteId),
    ["q3", "q4"],
  );
});

test("a provider update stamped after the cutoff is excluded", () => {
  const result = prior([
    quote("q1", "8", 60),
    quote("q2", "11", 60, undefined, { sourceUpdatedAt: minutesBefore(-1) }),
    quote("q3", "16", 60),
  ]);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.deepEqual(result.bookmakers.map((item) => item.quoteId).sort(), ["q1", "q3"]);
});

test("only the latest pre-cutoff quote per bookmaker is used", () => {
  const result = prior([
    quote("old", "8", 300, { home: 3, draw: 3, away: 3 }),
    quote("new", "8", 20),
    quote("q2", "11", 20),
  ]);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.deepEqual(result.bookmakers.map((item) => item.quoteId).sort(), ["new", "q2"]);
  assert.ok(result.excluded.some((item) => item.quoteId === "old" && item.reason === "superseded_by_newer_quote"));
});

test("market normalization: per-bookmaker power de-vig, median, renormalized", () => {
  const books = [
    { home: 2.0, draw: 3.5, away: 3.8 },
    { home: 2.1, draw: 3.3, away: 3.7 },
    { home: 1.95, draw: 3.6, away: 4.0 },
  ];
  const result = prior(books.map((odds, index) => quote(`q${index}`, String(index), 30, odds)));
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.devigMethodVersion, DEVIG_METHOD_VERSIONS.power);
  assert.equal(result.quality, "standard");
  assertValidProbabilities(result.probabilities);

  const devigged = books.map((odds) => devig(odds, "power"));
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[1];
  const raw = {
    home: median(devigged.map((p) => p.home)),
    draw: median(devigged.map((p) => p.draw)),
    away: median(devigged.map((p) => p.away)),
  };
  const total = raw.home + raw.draw + raw.away;
  assert.ok(Math.abs(result.probabilities.home - raw.home / total) < 1e-12);
  assert.ok(Math.abs(result.probabilities.away - raw.away / total) < 1e-12);
});

test("quality is thin with only two books or any aged quote", () => {
  const two = prior([quote("q1", "8", 30), quote("q2", "11", 30)]);
  assert.equal(two.status === "available" && two.quality, "thin");
  const aged = prior([quote("q1", "8", 30), quote("q2", "11", 30), quote("q3", "16", 7 * 60)]);
  assert.equal(aged.status === "available" && aged.quality, "thin");
});

test("implausible overrounds and other fixtures are excluded", () => {
  const result = prior([
    quote("arb", "8", 30, { home: 3.5, draw: 3.5, away: 3.5 }),
    quote("greedy", "11", 30, { home: 1.2, draw: 2.2, away: 2.4 }),
    quote("other", "16", 30, undefined, { fixtureId: "fixture-2" }),
    quote("ok", "21", 30),
  ]);
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.reason, "insufficient_bookmakers");
  assert.deepEqual(
    result.excluded.map((item) => [item.quoteId, item.reason]).sort(),
    [
      ["arb", "implausible_overround"],
      ["greedy", "implausible_overround"],
      ["other", "wrong_fixture"],
    ],
  );
});
