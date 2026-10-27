import type {
  BookmakerThreeWayQuote,
  DecimalThreeWayOdds,
  MarketPrior,
  ThreeWayBasisPoints,
} from "./types";

type ThreeWayProbabilities = {
  home: number;
  draw: number;
  away: number;
};

const BASIS_POINTS = 10_000;

function assertFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 1) {
    throw new Error(`Invalid decimal odds for ${field}: ${value}`);
  }
}

export function deVigDecimalOdds(
  odds: DecimalThreeWayOdds,
): { probabilities: ThreeWayProbabilities; overround: number } {
  assertFinitePositive(odds.home, "home");
  assertFinitePositive(odds.draw, "draw");
  assertFinitePositive(odds.away, "away");

  const raw = {
    home: 1 / odds.home,
    draw: 1 / odds.draw,
    away: 1 / odds.away,
  };
  const impliedSum = raw.home + raw.draw + raw.away;

  return {
    probabilities: {
      home: raw.home / impliedSum,
      draw: raw.draw / impliedSum,
      away: raw.away / impliedSum,
    },
    overround: impliedSum - 1,
  };
}

export function probabilitiesToBasisPoints(
  probabilities: ThreeWayProbabilities,
): ThreeWayBasisPoints {
  const entries = [
    ["home", probabilities.home],
    ["draw", probabilities.draw],
    ["away", probabilities.away],
  ] as const;

  for (const [name, value] of entries) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid probability for ${name}: ${value}`);
    }
  }

  const total = probabilities.home + probabilities.draw + probabilities.away;
  if (total <= 0) {
    throw new Error("Probability total must be positive.");
  }

  const normalized = entries.map(([name, value], index) => {
    const exact = (value / total) * BASIS_POINTS;
    const floor = Math.floor(exact);
    return { name, index, floor, remainder: exact - floor };
  });

  let remaining =
    BASIS_POINTS - normalized.reduce((sum, item) => sum + item.floor, 0);

  normalized
    .slice()
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .forEach((item) => {
      if (remaining > 0) {
        item.floor += 1;
        remaining -= 1;
      }
    });

  const byName = Object.fromEntries(
    normalized.map((item) => [item.name, item.floor]),
  ) as ThreeWayBasisPoints;

  return byName;
}

function median(values: number[]): number {
  if (values.length === 0) throw new Error("Cannot take median of an empty set.");
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);

  if (ordered.length % 2 === 1) return ordered[middle];
  return (ordered[middle - 1] + ordered[middle]) / 2;
}

export function aggregateMarketPrior(
  quotes: BookmakerThreeWayQuote[],
): MarketPrior | null {
  if (quotes.length === 0) return null;

  const distributions = quotes.map((quote) =>
    deVigDecimalOdds(quote.odds).probabilities,
  );

  const probabilitiesBp = probabilitiesToBasisPoints({
    home: median(distributions.map((p) => p.home)),
    draw: median(distributions.map((p) => p.draw)),
    away: median(distributions.map((p) => p.away)),
  });

  return {
    probabilitiesBp,
    bookmakerCount: quotes.length,
    method: "median-devig-v1",
    degraded: quotes.length < 2,
  };
}
