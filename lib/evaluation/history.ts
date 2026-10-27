import type { Outcome } from "./probabilities";

/**
 * One finished league match with its regular-time (90-minute) score.
 * Competition and team keys are provider-scoped (`sportmonks:8`), so history
 * never depends on every opponent having a canonical Kapiloto team row.
 */
export type HistoricalMatchResult = {
  provider: string;
  providerFixtureId: string;
  competitionKey: string;
  kickoffAt: string;
  homeTeamKey: string;
  awayTeamKey: string;
  homeGoals: number;
  awayGoals: number;
  neutralVenue?: boolean;
};

/**
 * A result counts as known only once the match could have finished: kickoff
 * plus this buffer must be at or before the information cutoff. A match that
 * kicked off shortly before the cutoff is excluded even if a score exists.
 */
export const RESULT_KNOWN_AFTER_KICKOFF_MINUTES = 150;

const DAY_MS = 86_400_000;

export function parseInstant(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}: ${value}`);
  return parsed;
}

export function resultKnownAtMs(match: HistoricalMatchResult): number {
  return (
    parseInstant(match.kickoffAt, "kickoffAt") +
    RESULT_KNOWN_AFTER_KICKOFF_MINUTES * 60_000
  );
}

export function matchOutcome(match: HistoricalMatchResult): Outcome {
  if (match.homeGoals > match.awayGoals) return "1";
  if (match.homeGoals < match.awayGoals) return "2";
  return "X";
}

function validScore(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function ageInDays(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / DAY_MS);
}

/**
 * The only path from stored history to model inputs. Returns same-competition
 * matches whose result was knowable at `cutoffAt`, within the lookback window,
 * deduplicated by provider fixture and sorted oldest first (ties by id) so
 * every downstream fold is order-deterministic.
 */
export function historyBeforeCutoff(
  matches: readonly HistoricalMatchResult[],
  options: { competitionKey: string; cutoffAt: string; lookbackDays: number },
): HistoricalMatchResult[] {
  const cutoffMs = parseInstant(options.cutoffAt, "cutoffAt");
  const windowStartMs = cutoffMs - options.lookbackDays * DAY_MS;
  const byFixture = new Map<string, HistoricalMatchResult>();

  for (const match of matches) {
    if (match.competitionKey !== options.competitionKey) continue;
    const kickoffMs = Date.parse(match.kickoffAt);
    if (!Number.isFinite(kickoffMs)) continue;
    if (kickoffMs < windowStartMs) continue;
    if (resultKnownAtMs(match) > cutoffMs) continue;
    if (!validScore(match.homeGoals) || !validScore(match.awayGoals)) continue;
    if (match.homeTeamKey === match.awayTeamKey) continue;
    const key = `${match.provider}:${match.providerFixtureId}`;
    if (!byFixture.has(key)) byFixture.set(key, match);
  }

  return [...byFixture.values()].sort(
    (a, b) =>
      Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt) ||
      a.providerFixtureId.localeCompare(b.providerFixtureId),
  );
}

/** Stable fingerprint input for the matches a computation actually used. */
export function historyFingerprint(matches: readonly HistoricalMatchResult[]) {
  return matches.map((match) => [
    match.provider,
    match.providerFixtureId,
    match.kickoffAt,
    match.homeTeamKey,
    match.awayTeamKey,
    match.homeGoals,
    match.awayGoals,
  ]);
}
