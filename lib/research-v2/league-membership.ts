import type { HistoricalMatchResult } from "@/lib/evaluation/history";

import type { VersionedConfig } from "./provenance";

/**
 * Competition membership facts derived from stored league history only.
 * `newToCompetitionThisSeason` says what the history proves: the team did not
 * play in this competition's previous season. It is not a claim of promotion
 * (a team can also arrive by relegation, expansion or a provider id change).
 */

export const LEAGUE_MEMBERSHIP_VERSION = "membership-v1" as const;

/** A league history row that may carry the provider's own season id. */
export type SeasonedMatch = HistoricalMatchResult & { providerSeasonId?: string | null };

export type LeagueMembershipConfig = VersionedConfig & {
  /** Primary season boundary: the provider's season id on every row. */
  seasonSource: "provider_season_id";
  /** Used only when season ids are missing or inconsistent. */
  fallback: "inactivity_gap";
  /** A gap of at least this many days between matches starts a new season (fallback, and target-season test). */
  seasonGapDays: number;
  /**
   * The previous season counts as fully covered only when its first stored
   * match is at least this many days after the history window start;
   * otherwise it may have begun before the window and membership is unknown.
   */
  previousSeasonStartCoverageDays: number;
};

/** Candidate values only; not approved and not derived from any outcome. */
export const CANDIDATE_LEAGUE_MEMBERSHIP_CONFIG: LeagueMembershipConfig = {
  id: "research-v2-league-membership",
  version: LEAGUE_MEMBERSHIP_VERSION,
  status: "candidate",
  seasonSource: "provider_season_id",
  fallback: "inactivity_gap",
  seasonGapDays: 60,
  previousSeasonStartCoverageDays: 14,
};

export type SeasonSegment = {
  key: string;
  firstKickoffAt: string;
  lastKickoffAt: string;
  matches: number;
  teams: string[];
};

export type SeasonSegmentation = {
  source: "provider_season_id" | "inactivity_gap";
  /** Why the provider season ids were not used (null when they were). */
  fallbackReason: string | null;
  seasons: SeasonSegment[];
};

export type MembershipUnknownReason = "team_unmapped" | "no_previous_season" | "previous_season_possibly_truncated";

export type CompetitionMembership = {
  version: typeof LEAGUE_MEMBERSHIP_VERSION;
  seasonSource: SeasonSegmentation["source"];
  fallbackReason: string | null;
  seasonCount: number;
  /** True when the target kicks off at least seasonGapDays after the latest stored match. */
  targetOpensNewSeason: boolean;
  previousSeason: { key: string; firstKickoffAt: string; lastKickoffAt: string; matches: number } | null;
  newToCompetitionThisSeason: { home: boolean | null; away: boolean | null };
  unknownReason: { home: MembershipUnknownReason | null; away: MembershipUnknownReason | null };
};

const DAY_MS = 86_400_000;

export function assertLeagueMembershipConfig(config: LeagueMembershipConfig): void {
  if (config?.version !== LEAGUE_MEMBERSHIP_VERSION || config.seasonSource !== "provider_season_id" || config.fallback !== "inactivity_gap") {
    throw new Error(`research_v2_membership_config_unsupported: ${config?.id ?? "?"}@${config?.version ?? "?"}`);
  }
  if (!(config.seasonGapDays > 0) || !(config.previousSeasonStartCoverageDays >= 0)) {
    throw new Error("research_v2_membership_config_invalid: seasonGapDays must be > 0 and coverage days >= 0.");
  }
}

function ordered(matches: readonly SeasonedMatch[]): SeasonedMatch[] {
  return [...matches].sort(
    (a, b) => Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt) || a.providerFixtureId.localeCompare(b.providerFixtureId),
  );
}

function segment(key: string, matches: SeasonedMatch[]): SeasonSegment {
  const teams = new Set<string>();
  for (const match of matches) {
    teams.add(match.homeTeamKey);
    teams.add(match.awayTeamKey);
  }
  return {
    key,
    firstKickoffAt: new Date(Date.parse(matches[0].kickoffAt)).toISOString(),
    lastKickoffAt: new Date(Date.parse(matches[matches.length - 1].kickoffAt)).toISOString(),
    matches: matches.length,
    teams: [...teams].sort(),
  };
}

/**
 * Splits one competition's history into seasons. Provider season ids decide
 * when every row has one and the seasons do not overlap in time; otherwise a
 * gap of at least `seasonGapDays` between consecutive matches starts a season.
 */
export function segmentSeasons(matches: readonly SeasonedMatch[], config: LeagueMembershipConfig): SeasonSegmentation {
  assertLeagueMembershipConfig(config);
  const rows = ordered(matches);
  if (rows.length === 0) return { source: "inactivity_gap", fallbackReason: "no_history", seasons: [] };

  const missing = rows.filter((match) => !match.providerSeasonId?.trim()).length;
  let fallbackReason: string | null = missing > 0 ? `season_id_missing:${missing}` : null;
  if (!fallbackReason) {
    const groups = new Map<string, SeasonedMatch[]>();
    for (const match of rows) {
      const key = (match.providerSeasonId as string).trim();
      groups.set(key, [...(groups.get(key) ?? []), match]);
    }
    const seasons = [...groups.entries()]
      .map(([key, group]) => segment(`season:${key}`, group))
      .sort((a, b) => Date.parse(a.firstKickoffAt) - Date.parse(b.firstKickoffAt) || a.key.localeCompare(b.key));
    const overlap = seasons.some((season, index) => index > 0 && Date.parse(season.firstKickoffAt) <= Date.parse(seasons[index - 1].lastKickoffAt));
    if (!overlap) return { source: "provider_season_id", fallbackReason: null, seasons };
    fallbackReason = "season_id_overlap";
  }

  const gapMs = config.seasonGapDays * DAY_MS;
  const seasons: SeasonSegment[] = [];
  let current: SeasonedMatch[] = [rows[0]];
  for (let index = 1; index < rows.length; index += 1) {
    if (Date.parse(rows[index].kickoffAt) - Date.parse(rows[index - 1].kickoffAt) >= gapMs) {
      seasons.push(segment(`gap:${current[0].kickoffAt.slice(0, 10)}`, current));
      current = [];
    }
    current.push(rows[index]);
  }
  seasons.push(segment(`gap:${current[0].kickoffAt.slice(0, 10)}`, current));
  return { source: "inactivity_gap", fallbackReason, seasons };
}

/**
 * Whether each side played in the competition's season before the target's.
 * `history` must already be limited to results knowable at the cutoff;
 * `coverageStartDate` is the first day (YYYY-MM-DD) of the requested history window.
 */
export function deriveCompetitionMembership(
  input: {
    history: readonly SeasonedMatch[];
    competitionKey: string;
    homeTeamKey: string | null;
    awayTeamKey: string | null;
    targetKickoffAt: string;
    coverageStartDate: string;
  },
  config: LeagueMembershipConfig,
): CompetitionMembership {
  const segmentation = segmentSeasons(
    input.history.filter((match) => match.competitionKey === input.competitionKey),
    config,
  );
  const { seasons } = segmentation;
  const last = seasons.at(-1) ?? null;
  const targetOpensNewSeason =
    last != null && Date.parse(input.targetKickoffAt) - Date.parse(last.lastKickoffAt) >= config.seasonGapDays * DAY_MS;
  const previous = targetOpensNewSeason ? last : (seasons.at(-2) ?? null);

  let commonReason: MembershipUnknownReason | null = null;
  if (!previous) {
    commonReason = "no_previous_season";
  } else {
    const windowStartMs = Date.parse(`${input.coverageStartDate}T00:00:00.000Z`);
    if (!Number.isFinite(windowStartMs)) throw new Error(`Invalid coverageStartDate: ${input.coverageStartDate}`);
    if (Date.parse(previous.firstKickoffAt) - windowStartMs < config.previousSeasonStartCoverageDays * DAY_MS) {
      commonReason = "previous_season_possibly_truncated";
    }
  }
  const side = (teamKey: string | null): { value: boolean | null; reason: MembershipUnknownReason | null } => {
    if (!teamKey) return { value: null, reason: "team_unmapped" };
    if (commonReason || !previous) return { value: null, reason: commonReason };
    return { value: !previous.teams.includes(teamKey), reason: null };
  };
  const home = side(input.homeTeamKey);
  const away = side(input.awayTeamKey);

  return {
    version: LEAGUE_MEMBERSHIP_VERSION,
    seasonSource: segmentation.source,
    fallbackReason: segmentation.fallbackReason,
    seasonCount: seasons.length,
    targetOpensNewSeason,
    previousSeason: previous
      ? { key: previous.key, firstKickoffAt: previous.firstKickoffAt, lastKickoffAt: previous.lastKickoffAt, matches: previous.matches }
      : null,
    newToCompetitionThisSeason: { home: home.value, away: away.value },
    unknownReason: { home: home.reason, away: away.reason },
  };
}
