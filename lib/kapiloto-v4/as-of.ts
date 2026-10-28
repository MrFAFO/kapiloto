import type { MatchLedgerObservation, TeamSide } from "./match-ledger";

/**
 * As-of rule (kapiloto-as-of-first-seen-v1).
 *
 * "What did Kapiloto know at cutoff T?" is answered ONLY by information time:
 *   1. keep versions with firstSeenAt <= T;
 *   2. per (fixture, provider) take the highest surviving version; if it is a
 *      withdrawal, the pair contributes nothing;
 *   3. only then apply event-time filters (kickoff before T, status).
 *
 * Event time never admits a row: a provider record about an Oct 30 match that
 * Kapiloto first stored on Nov 3 is invisible at a Nov 1 cutoff. Applying the
 * event-time filter before step 2 would be wrong too: it could resurrect an
 * older version that a visible newer version had corrected.
 *
 * Multi-provider contract: every history API is PROVIDER-SCOPED. It takes one
 * provider and returns at most one row per canonical fixture, so a last-N
 * window can never count a match twice. There is deliberately no API that
 * unions providers; a fused canonical history needs an explicit provider
 * precedence/fusion policy and will be a separate, named API. Never merge the
 * results of two provider-scoped calls into one last-N list.
 *
 * Identity contract (kapiloto-canonical-identity-v1): information time governs
 * football facts only. Canonical identity is read at its current state: a
 * player's history includes rows stored under ids since merged into him (a
 * merged id passed in redirects to the survivor), and team history reports
 * both the observed and the canonical coach. Exact historical model inputs
 * are preserved by the prediction registry, not by replaying the identity
 * graph.
 */

export const MATCH_LEDGER_AS_OF_FUNCTIONS = {
  observation: "match_ledger_observation_as_of",
  providerTeamMatches: "match_ledger_provider_team_matches_as_of",
  providerPlayerMatches: "match_ledger_provider_player_matches_as_of",
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
 * One provider's latest version per fixture among versions known at the
 * cutoff (at most one per fixture). A latest version that is a withdrawal
 * hides the fixture.
 */
export function latestProviderObservationsAsOf<T extends Versioned>(
  observations: readonly T[],
  provider: string,
  cutoff: string,
): T[] {
  const latest = new Map<string, T>();
  for (const observation of observations) {
    if (observation.provider !== provider || !isKnownAsOf(observation, cutoff)) continue;
    const current = latest.get(observation.fixtureId);
    if (!current || observation.observationVersion > current.observationVersion) {
      latest.set(observation.fixtureId, observation);
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

/**
 * Row returned by public.match_ledger_provider_player_matches_as_of. One row
 * per fixture for the canonical person: observed_player_id is the id stored in
 * the immutable version (possibly since merged), canonical_player_id its
 * survivor.
 */
export type ProviderPlayerMatchAsOfRow = {
  observation_id: string;
  fixture_id: string;
  provider: string;
  observation_version: number;
  first_seen_at: string;
  kickoff_at: string;
  canonical_player_id: string;
  observed_player_id: string;
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

/**
 * Row returned by public.match_ledger_provider_team_matches_as_of. Coach
 * models group by canonical_coach_id; observed_coach_id is what the version
 * stored.
 */
export type ProviderTeamMatchAsOfRow = {
  observation_id: string;
  fixture_id: string;
  provider: string;
  observation_version: number;
  first_seen_at: string;
  kickoff_at: string;
  side: TeamSide;
  opponent_team_id: string;
  neutral_venue: boolean | null;
  observed_coach_id: string | null;
  canonical_coach_id: string | null;
  formation_nominal: string | null;
  goals_for_90: number | null;
  goals_against_90: number | null;
  lineup_status: string;
  substitutions_status: string;
  events_status: string;
  statistics_status: string;
};
