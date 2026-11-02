import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

/**
 * The reviewed operator SQL of the M2B/M2C recovery runbook
 * (docs/operations/sql). Tests execute these files verbatim, exactly as an
 * operator pastes them, so the rehearsal exercises the production text.
 */
export const RUNBOOK_SQL = {
  m2cRevoke: "kapiloto-v4-m2c-revoke-body.sql",
  m2cVerify: "kapiloto-v4-m2c-verify.sql",
  withdrawChain: "kapiloto-v4-recovery-withdraw-chain.sql",
  correctMintedFixture: "kapiloto-v4-recovery-correct-minted-fixture.sql",
  unmapProviderFixture: "kapiloto-v4-recovery-unmap-provider-fixture.sql",
  correctIdentityMapping: "kapiloto-v4-recovery-correct-identity-mapping.sql",
  verifyChain: "kapiloto-v4-recovery-verify-chain.sql",
  affectedForecasts: "kapiloto-v4-recovery-affected-forecasts.sql",
} as const;

export type RunbookSql = keyof typeof RUNBOOK_SQL;

export function runbookSql(name: RunbookSql): string {
  return readFileSync(join("docs", "operations", "sql", RUNBOOK_SQL[name]), "utf8");
}

/**
 * One operator execution: the kapiloto_recovery.* parameters and the
 * template in ONE transaction (as the SQL editor runs a pasted script).
 * Returns the notices; a raised exception rolls the whole execution back.
 */
export async function runRunbookSql(db: PGlite, name: RunbookSql, params: Record<string, string> = {}): Promise<string[]> {
  const notices: string[] = [];
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(params)) {
      await tx.query("select set_config($1, $2, true)", [`kapiloto_recovery.${key}`, value]);
    }
    await tx.exec(runbookSql(name), { onNotice: (notice) => notices.push(notice.message ?? "") });
  });
  return notices;
}

/** Rows of a read-only runbook report (parameters set in the same transaction). */
export async function runbookReport<T>(db: PGlite, name: RunbookSql, params: Record<string, string>): Promise<T[]> {
  return db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(params)) {
      await tx.query("select set_config($1, $2, true)", [`kapiloto_recovery.${key}`, value]);
    }
    return (await tx.query<T>(runbookSql(name))).rows;
  });
}

/** Every table M2C or recovery could touch, including the private attestation tables. */
export const RECOVERY_DIGEST_TABLES = [
  "public.fixtures",
  "public.teams",
  "public.competitions",
  "public.provider_fixture_mappings",
  "public.provider_team_mappings",
  "public.provider_competition_mappings",
  "public.match_ledger_fixture_mints",
  "public.players",
  "public.provider_player_mappings",
  "public.player_aliases",
  "public.match_ledger_observations",
  "public.match_ledger_team_records",
  "public.match_ledger_players",
  "public.match_ledger_team_stats",
  "public.match_ledger_observation_provider_refs",
  "public.match_ledger_observation_family_fetches",
  "public.match_ledger_observation_identity_attestations",
  "public.provider_ingest_runs",
  "public.provider_ingest_items",
  "private.provider_team_identity_attestation_events",
  "private.provider_competition_identity_attestation_events",
  "private.provider_team_identity_attestations",
  "private.provider_competition_identity_attestations",
] as const;

/** Content digest per table (row text, not counts): detects updates as well as inserts and deletes. */
export async function recoveryDataDigest(db: PGlite): Promise<Record<string, string>> {
  const digest: Record<string, string> = {};
  for (const table of RECOVERY_DIGEST_TABLES) {
    const result = await db.query<{ d: string }>(
      `select md5(coalesce(string_agg(t::text, E'\\n' order by t::text), '')) as d from ${table} t`,
    );
    digest[table] = result.rows[0].d;
  }
  return digest;
}
