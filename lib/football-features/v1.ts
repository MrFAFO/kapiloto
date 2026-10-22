import type {
  ProviderCompletedMatch,
  ProviderStanding,
  ProviderName,
} from "@/lib/providers/types";

export const KAPILOTO_FEATURE_VERSION = "kapiloto-features-v1" as const;

export type StructuredCoverageStatus =
  | "available"
  | "partial"
  | "unavailable"
  | "stale"
  | "conflict";

export type TeamFormFeature = {
  played: number;
  points: number;
  gf: number;
  ga: number;
  venue_played: number;
  venue_points: number;
  venue_gf: number;
  venue_ga: number;
  last_match_at: string | null;
};

export type TeamRestFeature = {
  rest_days: number;
  matches_last_14d: number;
};

export type TeamTableFeature = {
  position: number;
  points: number;
  played: number | null;
  goal_difference: number | null;
  points_deducted: boolean | null;
};

export type TeamStructuredFeatures = {
  form: TeamFormFeature | null;
  rest: TeamRestFeature | null;
  table: TeamTableFeature | null;
  coverage: {
    form: StructuredCoverageStatus;
    rest: StructuredCoverageStatus;
    table: StructuredCoverageStatus;
  };
};

export type StructuredFeatureSource = {
  provider: ProviderName;
  capability: "results" | "standings";
  observed_at: string;
};

export type FixtureStructuredFeaturesV1 = {
  feature_version: typeof KAPILOTO_FEATURE_VERSION;
  home: TeamStructuredFeatures;
  away: TeamStructuredFeatures;
  sources: StructuredFeatureSource[];
};

type TeamFeatureInput = {
  teamId: string;
  venue: "home" | "away";
  targetCompetitionId: string;
  targetSeason: number | null;
  targetKickoffAt: string;
  researchCutoffAt: string;
  matches: ProviderCompletedMatch[];
  standing: ProviderStanding | null;
};

function parseTime(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return parsed;
}

function pointsFor(
  match: ProviderCompletedMatch,
  teamId: string,
): { points: number; gf: number; ga: number; venue: "home" | "away" } | null {
  if (match.home.id === teamId) {
    return {
      points:
        match.homeScore > match.awayScore
          ? 3
          : match.homeScore === match.awayScore
            ? 1
            : 0,
      gf: match.homeScore,
      ga: match.awayScore,
      venue: "home",
    };
  }
  if (match.away.id === teamId) {
    return {
      points:
        match.awayScore > match.homeScore
          ? 3
          : match.awayScore === match.homeScore
            ? 1
            : 0,
      gf: match.awayScore,
      ga: match.homeScore,
      venue: "away",
    };
  }
  return null;
}

function dedupeAndFreezeHistory(
  matches: ProviderCompletedMatch[],
  teamId: string,
  cutoffMs: number,
): ProviderCompletedMatch[] {
  const byFixture = new Map<string, ProviderCompletedMatch>();
  for (const match of matches) {
    const kickoffMs = Date.parse(match.kickoffAt);
    if (!Number.isFinite(kickoffMs) || kickoffMs >= cutoffMs) continue;
    if (match.home.id !== teamId && match.away.id !== teamId) continue;
    const key = `${match.provider}:${match.providerFixtureId}`;
    if (!byFixture.has(key)) byFixture.set(key, match);
  }
  return [...byFixture.values()].sort(
    (a, b) => Date.parse(b.kickoffAt) - Date.parse(a.kickoffAt),
  );
}

function aggregateForm(
  matches: ProviderCompletedMatch[],
  teamId: string,
  venue: "home" | "away",
  competitionId: string,
  season: number | null,
): { feature: TeamFormFeature | null; coverage: StructuredCoverageStatus } {
  const sameCompetitionSeason = (match: ProviderCompletedMatch) =>
    match.competition.id === competitionId &&
    (season == null || match.season === season);

  const league = matches
    .filter(sameCompetitionSeason)
    .slice(0, 6);

  if (league.length === 0) {
    return { feature: null, coverage: "unavailable" };
  }

  let points = 0;
  let gf = 0;
  let ga = 0;
  for (const match of league) {
    const view = pointsFor(match, teamId);
    if (!view) continue;
    points += view.points;
    gf += view.gf;
    ga += view.ga;
  }

  const venueMatches = matches
    .filter(
      (match) =>
        sameCompetitionSeason(match) &&
        pointsFor(match, teamId)?.venue === venue,
    )
    .slice(0, 6);

  let venuePoints = 0;
  let venueGf = 0;
  let venueGa = 0;
  for (const match of venueMatches) {
    const view = pointsFor(match, teamId);
    if (!view) continue;
    venuePoints += view.points;
    venueGf += view.gf;
    venueGa += view.ga;
  }

  return {
    feature: {
      played: league.length,
      points,
      gf,
      ga,
      venue_played: venueMatches.length,
      venue_points: venuePoints,
      venue_gf: venueGf,
      venue_ga: venueGa,
      last_match_at: league[0]?.kickoffAt ?? null,
    },
    coverage:
      league.length >= 6 && venueMatches.length >= 6
        ? "available"
        : "partial",
  };
}

function restFeature(
  matches: ProviderCompletedMatch[],
  targetKickoffMs: number,
): { feature: TeamRestFeature | null; coverage: StructuredCoverageStatus } {
  const latest = matches[0];
  if (!latest) return { feature: null, coverage: "unavailable" };

  const latestMs = Date.parse(latest.kickoffAt);
  const restDays = Math.max(
    0,
    Math.floor((targetKickoffMs - latestMs) / 86_400_000),
  );
  const fourteenDaysBefore = targetKickoffMs - 14 * 86_400_000;
  const matchesLast14d = matches.filter((match) => {
    const time = Date.parse(match.kickoffAt);
    return time >= fourteenDaysBefore && time < targetKickoffMs;
  }).length;

  return {
    feature: {
      rest_days: restDays,
      matches_last_14d: matchesLast14d,
    },
    coverage: "available",
  };
}

export function buildTeamStructuredFeaturesV1(
  input: TeamFeatureInput,
): TeamStructuredFeatures {
  const cutoffMs = parseTime(input.researchCutoffAt, "researchCutoffAt");
  const targetKickoffMs = parseTime(input.targetKickoffAt, "targetKickoffAt");
  if (cutoffMs >= targetKickoffMs) {
    throw new Error("researchCutoffAt must be before targetKickoffAt.");
  }

  const history = dedupeAndFreezeHistory(
    input.matches,
    input.teamId,
    cutoffMs,
  );
  const form = aggregateForm(
    history,
    input.teamId,
    input.venue,
    input.targetCompetitionId,
    input.targetSeason,
  );
  const rest = restFeature(history, targetKickoffMs);

  const standing =
    input.standing &&
    input.standing.teamId === input.teamId &&
    input.standing.competitionId === input.targetCompetitionId
      ? input.standing
      : null;

  return {
    form: form.feature,
    rest: rest.feature,
    table: standing
      ? {
          position: standing.position,
          points: standing.points,
          played: standing.played,
          goal_difference: standing.goalDifference,
          points_deducted: standing.pointsDeducted,
        }
      : null,
    coverage: {
      form: form.coverage,
      rest: rest.coverage,
      table: standing ? "available" : "unavailable",
    },
  };
}
