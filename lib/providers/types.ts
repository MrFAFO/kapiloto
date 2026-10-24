export type ProviderName = "api-football" | "sportmonks";

export type ThreeWayBasisPoints = {
  home: number;
  draw: number;
  away: number;
};

export type DecimalThreeWayOdds = {
  home: number;
  draw: number;
  away: number;
};

export type TeamRef = {
  id: string;
  name: string;
};

export type ProviderFixture = {
  provider: ProviderName;
  providerFixtureId: string;
  kickoffAt: string;
  status: string;
  season: number | null;
  competition: {
    id: string;
    name: string;
    country: string | null;
    round: string | null;
  };
  home: TeamRef;
  away: TeamRef;
};

export type ProviderCompletedMatch = {
  provider: ProviderName;
  providerFixtureId: string;
  kickoffAt: string;
  competition: {
    id: string;
    name: string;
    country: string | null;
  };
  season: number | null;
  home: TeamRef;
  away: TeamRef;
  homeScore: number;
  awayScore: number;
};

export type ProviderStanding = {
  provider: ProviderName;
  competitionId: string;
  season: number;
  teamId: string;
  position: number;
  points: number;
  played: number | null;
  goalDifference: number | null;
  pointsDeducted: boolean | null;
};

export type BookmakerThreeWayQuote = {
  provider: ProviderName;
  providerFixtureId: string;
  bookmakerId: string;
  bookmakerName: string;
  capturedAt: string | null;
  odds: DecimalThreeWayOdds;
};

export type MarketPrior = {
  probabilitiesBp: ThreeWayBasisPoints;
  bookmakerCount: number;
  method: "median-devig-v1";
  degraded: boolean;
};

export type ProviderSpikeFixtureInput = {
  gameNumber: number;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: string;
  competition?: string;
  aliases?: {
    home?: string[];
    away?: string[];
  };
  apiFootballFixtureId?: number;
  sportmonksFixtureId?: number;
  /** Confirmed provider team ids for the resolving provider; they outrank names. */
  providerTeamIds?: {
    home?: string | null;
    away?: string | null;
  };
  /** Confirmed provider competition id for the resolving provider. */
  providerCompetitionId?: string | null;
};

export type ProviderCapabilities = {
  lineups: boolean | null;
  injuries: boolean | null;
  odds: boolean | null;
  predictions: boolean | null;
  statistics?: boolean | null;
  xg?: boolean | null;
  pressure?: boolean | null;
};

export type ProviderAnalyticsCoverage = {
  statisticsEntries: number;
  xgEntries: number;
  xgMetricDeveloperNames: string[];
  pressureEntries: number;
  pressureParticipants: number;
};

export type ProviderFixtureCoverage = {
  gameNumber: number;
  input: ProviderSpikeFixtureInput;
  resolvedFixture: ProviderFixture | null;
  fixtureResolution:
    | "provided_id"
    | "provider_team_ids"
    | "name_match"
    | "not_found"
    | "ambiguous"
    | "orientation_mismatch";
  capabilities: ProviderCapabilities;
  lineupEntries: number;
  injuryEntries: number;
  completeBookmakers: number;
  marketPrior: MarketPrior | null;
  analytics?: ProviderAnalyticsCoverage;
  providerErrors: string[];
};

export type ProviderSpikeReport = {
  provider: ProviderName;
  generatedAt: string;
  fixtures: ProviderFixtureCoverage[];
  summary: {
    requestedFixtures: number;
    resolvedFixtures: number;
    fixturesWithLineupCoverage: number;
    fixturesWithObservedLineups: number;
    fixturesWithInjuryCoverage: number;
    fixturesWithObservedInjuries: number;
    fixturesWithOddsCoverage: number;
    fixturesWithObservedOdds: number;
    fixturesWithStatisticsCoverage: number;
    fixturesWithObservedStatistics: number;
    fixturesWithXgCoverage: number;
    fixturesWithObservedXg: number;
    fixturesWithPressureCoverage: number;
    fixturesWithObservedPressure: number;
    averageCompleteBookmakersWhenAvailable: number;
  };
};
