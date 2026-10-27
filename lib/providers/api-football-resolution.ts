import { bestHybridAliasSimilarity, normalizeTeamName } from "./match";
import type { ProviderFixture, ProviderSpikeFixtureInput } from "./types";

/** Provider kickoff may differ from the Toto snapshot by at most this much. */
export const KICKOFF_TOLERANCE_HOURS = 3;
/** Each side must reach this name similarity during name bootstrap. */
export const NAME_MIN_SIMILARITY = 0.8;
/** Two name candidates closer than this are ambiguous. */
export const AMBIGUITY_MARGIN = 0.05;

export type ApiFootballFixtureSelection = {
  fixture: ProviderFixture | null;
  resolution:
    | "provider_team_ids"
    | "name_match"
    | "not_found"
    | "ambiguous"
    | "orientation_mismatch";
};

/**
 * UTC dates the kickoff tolerance window touches, the kickoff's own date first.
 * A late-evening or after-midnight kickoff also needs the adjacent provider
 * date, because the provider may list the fixture on the other side of midnight.
 */
export function kickoffWindowDates(kickoffAt: string): string[] {
  const kickoffMs = Date.parse(kickoffAt);
  if (!Number.isFinite(kickoffMs)) return [];
  const toleranceMs = KICKOFF_TOLERANCE_HOURS * 3_600_000;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [...new Set([day(kickoffMs), day(kickoffMs - toleranceMs), day(kickoffMs + toleranceMs)])];
}

type Side = { names: [string, ...string[]]; teamId: string | null };

function side(name: string, aliases: string[] | undefined, teamId: string | null | undefined): Side {
  return { names: [name, ...(aliases ?? [])], teamId: teamId?.trim() || null };
}

function nameScore(target: Side, providerName: string): number {
  const [primary, ...aliases] = target.names;
  return bestHybridAliasSimilarity(providerName, primary, aliases);
}

function single(
  matches: ProviderFixture[],
  resolution: "provider_team_ids" | "name_match",
): ApiFootballFixtureSelection {
  if (matches.length === 1) return { fixture: matches[0], resolution };
  return { fixture: null, resolution: matches.length === 0 ? "not_found" : "ambiguous" };
}

/**
 * Picks the provider fixture for one Toto game from same-date candidates.
 *
 * Order of evidence:
 * 1. kickoff within KICKOFF_TOLERANCE_HOURS, and the mapped provider
 *    competition when one is known (otherwise the competition name, when any
 *    candidate carries it);
 * 2. mapped provider team ids: when both are known they decide alone, when one
 *    is known the other side must still pass the name threshold;
 * 3. names (Hebrew canonical, aliases, other providers' confirmed English
 *    names) only when no team id is known, as a bootstrap.
 *
 * A fixture listed with home and away swapped is `orientation_mismatch`, never
 * a match. Two plausible candidates are `ambiguous`, never a guess.
 */
export function selectApiFootballFixture(
  input: ProviderSpikeFixtureInput,
  candidates: readonly ProviderFixture[],
): ApiFootballFixtureSelection {
  const home = side(input.homeTeam, input.aliases?.home, input.providerTeamIds?.home);
  const away = side(input.awayTeam, input.aliases?.away, input.providerTeamIds?.away);
  const targetMs = Date.parse(input.kickoffAt);
  const competitionId = input.providerCompetitionId?.trim() || null;

  let pool = candidates.filter((fixture) => {
    const kickoffMs = Date.parse(fixture.kickoffAt);
    return (
      Number.isFinite(targetMs) &&
      Number.isFinite(kickoffMs) &&
      Math.abs(kickoffMs - targetMs) <= KICKOFF_TOLERANCE_HOURS * 3_600_000
    );
  });
  if (competitionId) {
    pool = pool.filter((fixture) => fixture.competition.id === competitionId);
  } else if (input.competition) {
    const wanted = normalizeTeamName(input.competition);
    const sameName = pool.filter(
      (fixture) => normalizeTeamName(fixture.competition.name) === wanted,
    );
    if (sameName.length > 0) pool = sameName;
  }

  if (home.teamId && away.teamId) {
    const exact = pool.filter(
      (fixture) => fixture.home.id === home.teamId && fixture.away.id === away.teamId,
    );
    if (exact.length > 0) return single(exact, "provider_team_ids");
    const reversed = pool.some(
      (fixture) => fixture.home.id === away.teamId && fixture.away.id === home.teamId,
    );
    return { fixture: null, resolution: reversed ? "orientation_mismatch" : "not_found" };
  }

  if (home.teamId || away.teamId) {
    const known = home.teamId ? "home" : "away";
    const knownId = (home.teamId ?? away.teamId) as string;
    const other = known === "home" ? away : home;
    const onSide = pool.filter((fixture) => fixture[known].id === knownId);
    const passing = onSide.filter(
      (fixture) =>
        nameScore(other, fixture[known === "home" ? "away" : "home"].name) >= NAME_MIN_SIMILARITY,
    );
    if (passing.length > 0) return single(passing, "provider_team_ids");
    const flipped = known === "home" ? "away" : "home";
    const reversed = pool.some((fixture) => fixture[flipped].id === knownId);
    return { fixture: null, resolution: reversed ? "orientation_mismatch" : "not_found" };
  }

  const scored = pool
    .map((fixture) => ({
      fixture,
      home: nameScore(home, fixture.home.name),
      away: nameScore(away, fixture.away.name),
    }))
    .filter((item) => item.home >= NAME_MIN_SIMILARITY && item.away >= NAME_MIN_SIMILARITY)
    .map((item) => ({ ...item, score: (item.home + item.away) / 2 }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    const reversed = pool.some(
      (fixture) =>
        nameScore(home, fixture.away.name) >= NAME_MIN_SIMILARITY &&
        nameScore(away, fixture.home.name) >= NAME_MIN_SIMILARITY,
    );
    return { fixture: null, resolution: reversed ? "orientation_mismatch" : "not_found" };
  }
  if (scored.length > 1 && scored[0].score - scored[1].score < AMBIGUITY_MARGIN) {
    return { fixture: null, resolution: "ambiguous" };
  }
  return { fixture: scored[0].fixture, resolution: "name_match" };
}
