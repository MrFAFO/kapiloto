import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateMarketPrior,
  deVigDecimalOdds,
  probabilitiesToBasisPoints,
} from "./market";
import type { BookmakerThreeWayQuote } from "./types";

test("de-vigged probabilities sum to one", () => {
  const { probabilities, overround } = deVigDecimalOdds({
    home: 2,
    draw: 3.5,
    away: 4,
  });

  assert.ok(overround > 0);
  assert.ok(
    Math.abs(probabilities.home + probabilities.draw + probabilities.away - 1) <
      1e-12,
  );
});

test("basis-point normalization is exactly 10000", () => {
  const bp = probabilitiesToBasisPoints({
    home: 0.333333,
    draw: 0.333333,
    away: 0.333334,
  });

  assert.equal(bp.home + bp.draw + bp.away, 10_000);
});

test("market prior uses median de-vigged bookmaker distributions", () => {
  const quotes: BookmakerThreeWayQuote[] = [
    {
      provider: "api-football",
      providerFixtureId: "1",
      bookmakerId: "a",
      bookmakerName: "A",
      capturedAt: null,
      odds: { home: 2, draw: 3.5, away: 4 },
    },
    {
      provider: "api-football",
      providerFixtureId: "1",
      bookmakerId: "b",
      bookmakerName: "B",
      capturedAt: null,
      odds: { home: 2.1, draw: 3.4, away: 3.8 },
    },
    {
      provider: "api-football",
      providerFixtureId: "1",
      bookmakerId: "c",
      bookmakerName: "C",
      capturedAt: null,
      odds: { home: 10, draw: 2, away: 1.4 },
    },
  ];

  const prior = aggregateMarketPrior(quotes);
  assert.ok(prior);
  assert.equal(prior.bookmakerCount, 3);
  assert.equal(prior.degraded, false);
  assert.equal(
    prior.probabilitiesBp.home +
      prior.probabilitiesBp.draw +
      prior.probabilitiesBp.away,
    10_000,
  );
});

test("one-bookmaker prior is explicitly degraded", () => {
  const prior = aggregateMarketPrior([
    {
      provider: "api-football",
      providerFixtureId: "1",
      bookmakerId: "a",
      bookmakerName: "A",
      capturedAt: null,
      odds: { home: 2, draw: 3.5, away: 4 },
    },
  ]);

  assert.ok(prior);
  assert.equal(prior.degraded, true);
});
