import type { HistoricalMatchResult } from "./history";

/** Deterministic PRNG (mulberry32) so synthetic leagues are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(lambda: number, random: () => number): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let product = random();
  while (product > limit) {
    k += 1;
    product *= random();
  }
  return k;
}

export function match(
  overrides: Partial<HistoricalMatchResult> & {
    id: string;
    kickoffAt: string;
    home: string;
    away: string;
    score: [number, number];
  },
): HistoricalMatchResult {
  return {
    provider: "sportmonks",
    providerFixtureId: overrides.id,
    competitionKey: overrides.competitionKey ?? "sportmonks:8",
    kickoffAt: overrides.kickoffAt,
    homeTeamKey: `sportmonks:${overrides.home}`,
    awayTeamKey: `sportmonks:${overrides.away}`,
    homeGoals: overrides.score[0],
    awayGoals: overrides.score[1],
    neutralVenue: overrides.neutralVenue,
  };
}

/**
 * Double round-robin league with fixed team strengths (team t0 strongest),
 * one round per week and a 90-day break between seasons. Goals are Poisson
 * with a home edge, so the generated league has a real home advantage.
 */
export function syntheticLeague(options: {
  teams?: number;
  seasons?: number;
  startAt?: string;
  seed?: number;
  competitionKey?: string;
} = {}): HistoricalMatchResult[] {
  const teamCount = options.teams ?? 10;
  const seasons = options.seasons ?? 2;
  const random = seededRandom(options.seed ?? 7);
  const competitionKey = options.competitionKey ?? "sportmonks:8";
  const strength = (index: number) =>
    0.4 - (0.8 * index) / Math.max(1, teamCount - 1);

  const rounds: Array<Array<[number, number]>> = [];
  const order = Array.from({ length: teamCount }, (_, index) => index);
  for (let round = 0; round < teamCount - 1; round += 1) {
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < teamCount / 2; i += 1) {
      const a = order[i];
      const b = order[teamCount - 1 - i];
      pairs.push(round % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    order.splice(1, 0, order.pop() as number);
  }
  const seasonRounds = [
    ...rounds,
    ...rounds.map((pairs) => pairs.map(([a, b]) => [b, a] as [number, number])),
  ];

  const matches: HistoricalMatchResult[] = [];
  let at = Date.parse(options.startAt ?? "2023-08-12T14:00:00Z");
  let id = 1;
  for (let season = 0; season < seasons; season += 1) {
    for (const pairs of seasonRounds) {
      for (const [home, away] of pairs) {
        const diff = strength(home) - strength(away);
        matches.push({
          provider: "sportmonks",
          providerFixtureId: String(id++),
          competitionKey,
          kickoffAt: new Date(at).toISOString(),
          homeTeamKey: `sportmonks:t${home}`,
          awayTeamKey: `sportmonks:t${away}`,
          homeGoals: poisson(Math.exp(0.35 + diff), random),
          awayGoals: poisson(Math.exp(0.1 - diff), random),
        });
      }
      at += 7 * 86_400_000;
    }
    at += 90 * 86_400_000;
  }
  return matches;
}
