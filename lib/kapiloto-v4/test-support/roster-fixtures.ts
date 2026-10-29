import type { PGlite } from "@electric-sql/pglite";

import type { MembershipAsOfRow, TeamPlayerMembershipInsert } from "../roster";
import { TEAM_PLAYER_MEMBERSHIP_CONTRACT_VERSION } from "../versions";
import { setClock } from "./ledger-fixtures";

let keyCounter = 0;

export function membershipKey(): string {
  keyCounter += 1;
  return `91000000-0000-4000-8000-${String(keyCounter).padStart(12, "0")}`;
}

export async function insertMembership(
  db: PGlite,
  row: Partial<TeamPlayerMembershipInsert> & Pick<TeamPlayerMembershipInsert, "membership_key" | "team_id" | "player_id">,
  clock: string,
): Promise<{ id: string; membership_version: number; first_seen_at: Date }> {
  await setClock(db, clock);
  const full: TeamPlayerMembershipInsert = {
    contract_version: TEAM_PLAYER_MEMBERSHIP_CONTRACT_VERSION,
    squad_group: "first_team",
    shirt_number: null,
    starts_on_earliest: "2026-07-01",
    starts_on_latest: "2026-07-01",
    ends_on_earliest: null,
    ends_on_latest: null,
    assertion_status: "asserted",
    source_kind: "official_club",
    provider: null,
    provider_record_id: null,
    source_reference: null,
    source_fingerprint: null,
    document_version_id: null,
    retrieved_at: null,
    ingest_version: "roster-test-v1",
    ...row,
  };
  const columns = Object.keys(full);
  const result = await db.query<{ id: string; membership_version: number; first_seen_at: Date }>(
    `insert into public.team_player_memberships (${columns.join(", ")}, membership_version)
     values (${columns.map((_, i) => `$${i + 1}`).join(", ")}, 99)
     returning id, membership_version, first_seen_at`,
    Object.values(full),
  );
  return result.rows[0];
}

export async function membershipsAsOf(db: PGlite, teamId: string, cutoff: string, onDate: string): Promise<MembershipAsOfRow[]> {
  const result = await db.query<MembershipAsOfRow>(
    "select * from public.team_player_memberships_as_of($1, $2, $3)",
    [teamId, cutoff, onDate],
  );
  return result.rows;
}
