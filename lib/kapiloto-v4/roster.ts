import type { TenureSourceKind } from "./entities";
import { TEAM_PLAYER_MEMBERSHIP_CONTRACT_VERSION } from "./versions";

/**
 * Roster membership contracts (V4 Foundation 1C).
 *
 * A membership is an ASSERTION by a source that a player belongs to a team
 * within an uncertain date interval. It is not participation (Match Ledger),
 * not availability and not a lineup. Rows are immutable; a correction or a
 * retraction is a new version of the same membership_key, and first_seen_at
 * is stamped by the database. Overlapping assertions from different sources
 * are allowed and never resolved into transfer or loan "truth".
 *
 * Identity: writes name surviving canonical players (D-050). Reads report the
 * stored id (observed) and its current survivor (canonical). A membership key
 * never changes team or person; a later version of a membership first
 * asserted for a since-merged player names the survivor.
 */

export const SQUAD_GROUPS = ["first_team", "reserve", "youth", "unknown"] as const;
export type SquadGroup = (typeof SQUAD_GROUPS)[number];

export const MEMBERSHIP_ASSERTION_STATUSES = ["asserted", "retracted"] as const;
export type MembershipAssertionStatus = (typeof MEMBERSHIP_ASSERTION_STATUSES)[number];

/**
 * Date coverage of an assertion for one calendar date (inclusive bounds):
 * outside  date < starts_on_earliest, or date > ends_on_latest;
 * certain  date >= starts_on_latest and (open, or date <= ends_on_earliest);
 * possible otherwise (the date falls inside a bound's uncertainty).
 */
export const MEMBERSHIP_COVERAGES = ["certain", "possible", "outside"] as const;
export type MembershipCoverage = (typeof MEMBERSHIP_COVERAGES)[number];

export type MembershipDateBounds = {
  starts_on_earliest: string;
  starts_on_latest: string;
  ends_on_earliest: string | null;
  ends_on_latest: string | null;
};

/** Mirrors the coverage rule of public.team_player_memberships_as_of. */
export function membershipCoverage(bounds: MembershipDateBounds, date: string): MembershipCoverage {
  if (date < bounds.starts_on_earliest) return "outside";
  if (bounds.ends_on_latest !== null && date > bounds.ends_on_latest) return "outside";
  const startCertain = date >= bounds.starts_on_latest;
  const endCertain = bounds.ends_on_earliest === null || date <= bounds.ends_on_earliest;
  return startCertain && endCertain ? "certain" : "possible";
}

/** Columns a writer supplies; version and first_seen_at are database-assigned. */
export type TeamPlayerMembershipInsert = MembershipDateBounds & {
  contract_version: typeof TEAM_PLAYER_MEMBERSHIP_CONTRACT_VERSION;
  membership_key: string;
  team_id: string;
  player_id: string;
  squad_group: SquadGroup;
  shirt_number: number | null;
  assertion_status: MembershipAssertionStatus;
  source_kind: TenureSourceKind;
  provider: string | null;
  provider_record_id: string | null;
  source_reference: string | null;
  source_fingerprint: string | null;
  document_version_id: string | null;
  retrieved_at: string | null;
  ingest_version: string;
};

/** Row returned by public.team_player_memberships_as_of. */
export type MembershipAsOfRow = MembershipDateBounds & {
  membership_id: string;
  membership_key: string;
  membership_version: number;
  team_id: string;
  observed_player_id: string;
  canonical_player_id: string;
  squad_group: SquadGroup;
  shirt_number: number | null;
  coverage: MembershipCoverage;
  source_kind: TenureSourceKind;
  provider: string | null;
  provider_record_id: string | null;
  source_reference: string | null;
  document_version_id: string | null;
  first_seen_at: string;
};

export const ROSTER_FUNCTIONS = {
  membershipsAsOf: "team_player_memberships_as_of",
  squadStateInputsAsOf: "squad_state_inputs_as_of",
} as const;
