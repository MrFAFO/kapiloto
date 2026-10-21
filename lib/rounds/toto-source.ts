import type { TotoRoundSnapshotInput } from "./toto-round";

export type DiscoveredCompetition = {
  canonicalName: string;
  countryCode: string | null;
  competitionType: string | null;
  sourceLabel: string;
};

export type DiscoveredRoundGame = {
  gameNumber: number;
  rawKickoff: string;
  kickoffAt: string | null;
  homeTeam: string;
  awayTeam: string;
  competition: DiscoveredCompetition;
};

export type TotoRoundDiscovery = {
  source: string;
  sourceUrl: string;
  externalRoundNumber: string;
  sourceVersion: string;
  fetchedAt: string;
  games: DiscoveredRoundGame[];
  completeKickoffs: boolean;
};

export interface TotoRoundProvider {
  discoverCurrent(): Promise<TotoRoundDiscovery>;
}

export function discoveryToImportSnapshot(
  discovery: TotoRoundDiscovery,
  options: {
    lockAt: string;
    status?: TotoRoundSnapshotInput["status"];
  },
): TotoRoundSnapshotInput {
  if (discovery.games.length !== 16) {
    throw new Error(
      `Winner 16 discovery requires 16 games; got ${discovery.games.length}.`,
    );
  }

  const unresolved = discovery.games.filter((game) => !game.kickoffAt);
  if (unresolved.length > 0) {
    throw new Error(
      `Winner 16 discovery has unresolved kickoff times for games: ${unresolved
        .map((game) => game.gameNumber)
        .join(", ")}.`,
    );
  }

  const kickoffTimes = discovery.games.map((game) =>
    Date.parse(game.kickoffAt as string),
  );
  const startsAt = new Date(Math.min(...kickoffTimes)).toISOString();

  return {
    source: discovery.source,
    externalRoundNumber: discovery.externalRoundNumber,
    sourceVersion: discovery.sourceVersion,
    startsAt,
    lockAt: options.lockAt,
    status: options.status ?? "upcoming",
    games: discovery.games.map((game) => ({
      gameNumber: game.gameNumber,
      home: {
        canonicalName: game.homeTeam,
        countryCode: game.competition.countryCode,
        languageCode: "he",
        aliases: [game.homeTeam],
      },
      away: {
        canonicalName: game.awayTeam,
        countryCode: game.competition.countryCode,
        languageCode: "he",
        aliases: [game.awayTeam],
      },
      competition: {
        canonicalName: game.competition.canonicalName,
        countryCode: game.competition.countryCode,
        competitionType: game.competition.competitionType,
      },
      kickoffAt: game.kickoffAt as string,
      neutralVenue: false,
      fixtureStatus: "upcoming",
    })),
  };
}
