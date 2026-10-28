import type { MatchLedgerObservation, TeamSide } from "./match-ledger";

/**
 * As-of rule (kapiloto-as-of-first-seen-v1).
 *
 * "What did Kapiloto know at cutoff T?" is answered ONLY by information time:
 *   1. keep versions with firstSeenAt <= T;
 *   2. per (fixture, provider) take the highest surviving version;
 *   3. only then apply event-time filters (kickoff before T, status).
 *
 * Event time never admits a row: a provider record about an Oct 30 match that
 * Kapiloto first stored on Nov 3 is invisible at a Nov 1 cutoff. Applying the
 * event-time filter before step 2 would be wrong too: it could resurrect an
 * older version that a visible newer version had corrected.
 *
 * The SQL functions public.match_ledger_observation_as_of,
 * public.match_ledger_team_matches_as_of and public.team_coach_tenures_as_of
 * implement the same rule in the database; this module mirrors it for
 * in-memory replay and tests.
 */

export const MATCH_LEDGER_AS_OF_FUNCTIONS = {
  observation: "match_ledger_observation_as_of",
  teamMatches: "match_ledger_team_matches_as_of",
  playerMatches: "match_ledger_player_matches_as_of",
  coachTenures: "team_coach_tenures_as_of",
} as const;

export function isKnownAsOf(record: { firstSeenAt: string }, cutoff: string): boolean {
  return Date.parse(record.firstSeenAt) <= Date.parse(cutoff);
}

type Versioned = Pick<
  MatchLedgerObservation,
  "fixtureId" | "provider" | "observationVersion" | "firstSeenAt"
> &
  Partial<Pick<MatchLedgerObservation, "observationKind">>;

/**
 * Latest version per (fixture, provider) among versions known at the cutoff.
 * A latest version that is a withdrawal hides the pair entirely.
 */
export function latestObservationsAsOf<T extends Versioned>(observations: readonly T[], cutoff: string): T[] {
  const latest = new Map<string, T>();
  for (const observation of observations) {
    if (!isKnownAsOf(observation, cutoff)) continue;
    const key = `${observation.fixtureId}|${observation.provider}`;
    const current = latest.get(key);
    if (!current || observation.observationVersion > current.observationVersion) {
      latest.set(key, observation);
    }
  }
  return [...latest.values()].filter((observation) => observation.observationKind !== "withdrawal");
}

/** Latest version per tenure key known at the cutoff, retractions dropped. */
export function tenuresAsOf<
  T extends { tenureKey: string; tenureVersion: number; firstSeenAt: string; assertionStatus: string },
>(tenures: readonly T[], cutoff: string): T[] {
  const latest = new Map<string, T>();
  for (const tenure of tenures) {
    if (!isKnownAsOf(tenure, cutoff)) continue;
    const current = latest.get(tenure.tenureKey);
    if (!current || tenure.tenureVersion > current.tenureVersion) latest.set(tenure.tenureKey, tenure);
  }
  return [...latest.values()].filter((tenure) => tenure.assertionStatus === "asserted");
}

/** Row returned by public.match_ledger_player_matches_as_of. */
export type PlayerMatchAsOfRow = {
  observation_id: string;
  fixture_id: string;
  provider: string;
  observation_version: number;
  first_seen_at: string;
  kickoff_at: string;
  team_id: string;
  lineup_role: string;
  appeared: boolean | null;
  position_code: string | null;
  formation_position: number | null;
  is_captain: boolean | null;
  minutes_played: number | null;
  entered_minute: number | null;
  exited_minute: number | null;
  data_completeness: string;
};

/** Row returned by public.match_ledger_team_matches_as_of. */
export type TeamMatchAsOfRow = {
  observation_id: string;
  fixture_id: string;
  provider: string;
  observation_version: number;
  first_seen_at: string;
  kickoff_at: string;
  side: TeamSide;
  opponent_team_id: string;
  neutral_venue: boolean | null;
  coach_id: string | null;
  formation_nominal: string | null;
  goals_for_90: number | null;
  goals_against_90: number | null;
  lineup_status: string;
  substitutions_status: string;
  events_status: string;
  statistics_status: string;
};
