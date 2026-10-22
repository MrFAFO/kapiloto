import type { ProviderFixture } from "@/lib/providers/types";
import {
  crossScriptTeamSimilarity,
  normalizeTeamName,
} from "@/lib/providers/match";

import type {
  DiscoveredRoundGame,
  TotoRoundDiscovery,
} from "./toto-source";

function fixturePairScore(
  game: DiscoveredRoundGame,
  fixture: ProviderFixture,
): number {
  if (
    normalizeTeamName(game.competition.canonicalName) !==
    normalizeTeamName(fixture.competition.name)
  ) {
    return 0;
  }

  const home = crossScriptTeamSimilarity(game.homeTeam, fixture.home.name);
  const away = crossScriptTeamSimilarity(game.awayTeam, fixture.away.name);

  if (home < 0.55 || away < 0.55) return 0;
  return home * 0.5 + away * 0.5;
}

export type DiscoveryCompletion = {
  discovery: TotoRoundDiscovery;
  resolvedBySportmonks: Array<{
    gameNumber: number;
    providerFixtureId: string;
    kickoffAt: string;
    score: number;
  }>;
  unresolvedGameNumbers: number[];
};

export function completeMissingKickoffsFromFixtures(
  discovery: TotoRoundDiscovery,
  providerFixtures: ProviderFixture[],
): DiscoveryCompletion {
  const usedFixtureIds = new Set<string>();
  const resolvedBySportmonks: DiscoveryCompletion["resolvedBySportmonks"] = [];

  const games = discovery.games.map((game) => {
    if (game.kickoffAt) return { ...game };

    const candidates = providerFixtures
      .filter((fixture) => !usedFixtureIds.has(fixture.providerFixtureId))
      .map((fixture) => ({
        fixture,
        score: fixturePairScore(game, fixture),
      }))
      .filter((candidate) => candidate.score >= 0.68)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) return { ...game };

    const best = candidates[0];
    const second = candidates[1];
    if (second && best.score - second.score < 0.08) {
      return { ...game };
    }

    usedFixtureIds.add(best.fixture.providerFixtureId);
    resolvedBySportmonks.push({
      gameNumber: game.gameNumber,
      providerFixtureId: best.fixture.providerFixtureId,
      kickoffAt: best.fixture.kickoffAt,
      score: Math.round(best.score * 10_000) / 10_000,
    });

    return {
      ...game,
      kickoffAt: new Date(best.fixture.kickoffAt).toISOString(),
      rawKickoff: `${game.rawKickoff} · resolved:sportmonks`,
    };
  });

  const unresolvedGameNumbers = games
    .filter((game) => !game.kickoffAt)
    .map((game) => game.gameNumber);

  const suffix =
    resolvedBySportmonks.length === 0
      ? ""
      : `+sportmonks:${resolvedBySportmonks
          .map((item) => `${item.gameNumber}=${item.providerFixtureId}`)
          .join(",")}`;

  return {
    discovery: {
      ...discovery,
      sourceVersion: `${discovery.sourceVersion}${suffix}`,
      games,
      completeKickoffs: unresolvedGameNumbers.length === 0,
    },
    resolvedBySportmonks,
    unresolvedGameNumbers,
  };
}

export function sportmonksCompletionWindow(
  discovery: TotoRoundDiscovery,
): { startDate: string; endDate: string } | null {
  const known = discovery.games
    .map((game) => game.kickoffAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);

  if (known.length === 0) return null;

  const start = new Date(Math.min(...known));
  const end = new Date(Math.max(...known));
  start.setUTCDate(start.getUTCDate() - 1);
  end.setUTCDate(end.getUTCDate() + 2);

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

export type OperationalLock = {
  lockAt: string;
  sourceType: "derived_safety";
  sourceRef: string;
  derived: true;
  safetyMinutes: number;
};

export function deriveConservativeOperationalLock(
  discovery: TotoRoundDiscovery,
  safetyMinutes = 30,
): OperationalLock {
  if (!Number.isInteger(safetyMinutes) || safetyMinutes < 5 || safetyMinutes > 180) {
    throw new Error("Toto safety lock must be an integer between 5 and 180 minutes.");
  }

  const kickoffTimes = discovery.games.map((game) => {
    if (!game.kickoffAt) {
      throw new Error(
        `Cannot derive operational lock with unresolved game ${game.gameNumber}.`,
      );
    }
    return Date.parse(game.kickoffAt);
  });

  const earliest = Math.min(...kickoffTimes);
  return {
    lockAt: new Date(earliest - safetyMinutes * 60_000).toISOString(),
    sourceType: "derived_safety",
    sourceRef: `earliest_fixture_minus_${safetyMinutes}m`,
    derived: true,
    safetyMinutes,
  };
}
