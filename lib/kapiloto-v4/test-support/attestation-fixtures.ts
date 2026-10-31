import type { PGlite } from "@electric-sql/pglite";

import type { AttestationBasis, AttestationEvidence, AttestationResult } from "../identity-attestations";
import { buildProviderMatchObservationPayload, type ProviderIngestResult, type ProviderMatchObservation } from "../provider-ingest";
import type { SportmonksLedgerCaptureV1 } from "../sportmonks-ledger";
import { PROVIDER_IDENTITY_ATTESTATION_EVIDENCE_VERSION } from "../versions";
import { setClock } from "./ledger-fixtures";
import { asIdentityOperator, observationFrom, seedIngestIdentities, syntheticCapture, type IngestSeed, type SyntheticCaptureOptions } from "./provider-ingest-fixtures";

/**
 * SYNTHETIC Stage 1 attestation fixtures (D-058). No real team or competition
 * is attested; every provider id, name and evidence source is invented.
 */

export const SYNTHETIC_DUPLICATE_AUDIT_SHA256 = "a".repeat(64);

export function syntheticEvidence(overrides: Record<string, unknown> = {}): AttestationEvidence {
  return {
    contract_version: PROVIDER_IDENTITY_ATTESTATION_EVIDENCE_VERSION,
    sources: ["synthetic:offline-test-fixture"],
    reviewed_by: "synthetic reviewer",
    duplicate_audit_sha256: SYNTHETIC_DUPLICATE_AUDIT_SHA256,
    ...overrides,
  } as AttestationEvidence;
}

/** One RPC call = one autocommit transaction (the attest/revoke first-write rule). */
export async function callIdentityRpc(db: PGlite, fn: string, payload: unknown): Promise<AttestationResult> {
  return (await db.query<{ r: AttestationResult }>(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(payload)])).rows[0].r;
}

export function teamAttestation(providerTeamId: string, teamId: string, options: { evidence?: unknown; basis?: AttestationBasis; provider?: string } = {}) {
  return {
    provider: options.provider ?? "sportmonks",
    provider_team_id: providerTeamId,
    team_id: teamId,
    attestation_basis: options.basis ?? "operator_manual",
    evidence: options.evidence ?? syntheticEvidence(),
    attested_by: "synthetic operator",
  };
}

export function competitionAttestation(providerCompetitionId: string, competitionId: string, options: { evidence?: unknown; basis?: AttestationBasis; provider?: string } = {}) {
  return {
    provider: options.provider ?? "sportmonks",
    provider_competition_id: providerCompetitionId,
    competition_id: competitionId,
    attestation_basis: options.basis ?? "operator_manual",
    evidence: options.evidence ?? syntheticEvidence(),
    attested_by: "synthetic operator",
  };
}

export const attestTeam = (db: PGlite, providerTeamId: string, teamId: string, options: Parameters<typeof teamAttestation>[2] = {}) =>
  callIdentityRpc(db, "provider_identity_attest_team", teamAttestation(providerTeamId, teamId, options));

export const attestCompetition = (db: PGlite, providerCompetitionId: string, competitionId: string, options: Parameters<typeof competitionAttestation>[2] = {}) =>
  callIdentityRpc(db, "provider_identity_attest_competition", competitionAttestation(providerCompetitionId, competitionId, options));

export const revokeTeam = (db: PGlite, providerTeamId: string, expectedTeamId: string, reason = "synthetic revocation") =>
  callIdentityRpc(db, "provider_identity_revoke_team", {
    provider: "sportmonks",
    provider_team_id: providerTeamId,
    expected_team_id: expectedTeamId,
    reason,
    revoked_by: "synthetic operator",
  });

export const revokeCompetition = (db: PGlite, providerCompetitionId: string, expectedCompetitionId: string, reason = "synthetic revocation") =>
  callIdentityRpc(db, "provider_identity_revoke_competition", {
    provider: "sportmonks",
    provider_competition_id: providerCompetitionId,
    expected_competition_id: expectedCompetitionId,
    reason,
    revoked_by: "synthetic operator",
  });

/** Operator mapping change (D-057 override) in its own transaction. */
export const operatorSql = asIdentityOperator;

export type AttestedIds = { leagueId: string; homeTeamId: string; awayTeamId: string };

/**
 * Canonical competition + teams, manual_override mappings, and (unless
 * attest: false) active V4 attestations for all three, each in its own
 * transaction as the RPC requires.
 */
export async function seedAttestedIdentities(db: PGlite, ids: AttestedIds, options: { attest?: boolean } = {}): Promise<IngestSeed> {
  const seed = await seedIngestIdentities(db, { ...ids, teamMappingStatus: "manual_override" });
  if (options.attest !== false) {
    await attestCompetition(db, ids.leagueId, seed.competitionId);
    await attestTeam(db, ids.homeTeamId, seed.homeTeamId);
    await attestTeam(db, ids.awayTeamId, seed.awayTeamId);
  }
  return seed;
}

/** An immutable ingest run whose scope allow-lists exactly these provider fixture ids. */
export async function createScopedRun(
  db: PGlite,
  providerFixtureIds: unknown,
  options: { provider?: string; fixtureMintKickoffBefore?: string | null } = {},
): Promise<string> {
  const scope = providerFixtureIds === undefined ? {} : { provider_fixture_ids: providerFixtureIds };
  const result = await db.query<{ id: string }>(
    `insert into public.provider_ingest_runs (provider, purpose, ingest_version, scope, fixture_mint_kickoff_before)
     values ($1, 'test', 'kapiloto-sportmonks-ledger-mapping-v1', $2::jsonb, $3) returning id`,
    [options.provider ?? "sportmonks", JSON.stringify(scope), options.fixtureMintKickoffBefore ?? null],
  );
  return result.rows[0].id;
}

/** Calls the V2 ingest RPC as one statement at the given information-clock time. */
export async function ingestV2(
  db: PGlite,
  observation: ProviderMatchObservation | Record<string, unknown>,
  clock: string,
): Promise<ProviderIngestResult> {
  await setClock(db, clock);
  const payload = "contract_version" in observation ? observation : buildProviderMatchObservationPayload(observation as ProviderMatchObservation);
  const result = await db.query<{ result: ProviderIngestResult }>(
    "select public.match_ledger_ingest_provider_fixture_v2($1::jsonb) as result",
    [JSON.stringify(payload)],
  );
  return result.rows[0].result;
}

export type AttestedWorld = {
  seed: IngestSeed;
  ids: AttestedIds;
  providerFixtureId: string;
  runId: string;
  capture: (overrides?: Partial<SyntheticCaptureOptions>) => SportmonksLedgerCaptureV1;
  observation: (overrides?: Partial<SyntheticCaptureOptions>, options?: { mint?: boolean; runId?: string | null }) => ProviderMatchObservation;
};

let worldCounter = 0;

/** Information-clock time the synthetic worlds are attested at (before the tests' ingest times). */
export const SYNTHETIC_ATTESTED_AT = "2026-10-29T00:00:00.000Z";

/** A fully attested synthetic world with one allow-listed provider fixture. */
export async function attestedWorld(
  db: PGlite,
  options: { kickoffAt: string; capturedAt: string; attest?: boolean; extraFixtureIds?: string[] },
): Promise<AttestedWorld> {
  worldCounter += 1;
  const n = worldCounter;
  const ids = { leagueId: String(8_100 + n), homeTeamId: String(85_000 + n * 2), awayTeamId: String(85_001 + n * 2) };
  await setClock(db, SYNTHETIC_ATTESTED_AT);
  const seed = await seedAttestedIdentities(db, ids, { attest: options.attest });
  const providerFixtureId = String(28_000_000 + n);
  const runId = await createScopedRun(db, [providerFixtureId, ...(options.extraFixtureIds ?? [])]);
  const capture = (overrides: Partial<SyntheticCaptureOptions> = {}) =>
    syntheticCapture({
      ...ids,
      providerFixtureId,
      playerIdBase: [9_000_000 + n * 100, 9_500_000 + n * 100],
      kickoffAt: options.kickoffAt,
      capturedAt: options.capturedAt,
      ...overrides,
    });
  const observation = (overrides: Partial<SyntheticCaptureOptions> = {}, o: { mint?: boolean; runId?: string | null } = {}) =>
    observationFrom(capture(overrides), { mint: o.mint, runId: o.runId === undefined ? runId : o.runId });
  return { seed, ids, providerFixtureId, runId, capture, observation };
}

export async function canonicalFixtureFor(
  db: PGlite,
  seed: IngestSeed,
  kickoffAt: string,
  options: { status?: string; competitionId?: string | null; swap?: boolean } = {},
): Promise<string> {
  const [home, away] = options.swap ? [seed.awayTeamId, seed.homeTeamId] : [seed.homeTeamId, seed.awayTeamId];
  const result = await db.query<{ id: string }>(
    `insert into public.fixtures (competition_id, home_team_id, away_team_id, kickoff_at, status)
     values ($1, $2, $3, $4, $5) returning id`,
    [options.competitionId === undefined ? seed.competitionId : options.competitionId, home, away, kickoffAt, options.status ?? "upcoming"],
  );
  return result.rows[0].id;
}

/** A Sportmonks fixture mapping row as V3 writes it (confirmed at 0.9 unless told otherwise). */
export async function mapProviderFixture(
  db: PGlite,
  fixtureId: string,
  providerFixtureId: string,
  status = "confirmed",
  confidence: number | null = 0.9,
): Promise<void> {
  await db.query(
    "insert into public.provider_fixture_mappings (fixture_id, provider, provider_fixture_id, mapping_status, mapping_confidence) values ($1, 'sportmonks', $2, $3, $4)",
    [fixtureId, providerFixtureId, status, confidence],
  );
}
