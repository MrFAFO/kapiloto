import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { buildMatchLedgerObservationPayload } from "./match-ledger";
import { PROVIDER_REF_CONFLICT_CODES, loadProviderRefConflicts, type ProviderRefConflict } from "./provider-ingest";
import { createFixture, createLedgerDatabase, realisticObservation, recordObservation, seedLedger } from "./test-support/ledger-fixtures";
import {
  ingest,
  observationFrom,
  pgliteRpc,
  seedIngestIdentities,
  syntheticCapture,
  writeFootprint,
  type SyntheticCaptureOptions,
} from "./test-support/provider-ingest-fixtures";

/**
 * match_ledger_provider_ref_conflicts: detection only. Compares the provider
 * refs (and the canonical ids they resolved to) sealed with each observation
 * version against today's mappings under the historical-ingest trust rules.
 */

const KICKOFF = "2026-08-15T18:00:00.000Z";
const CAPTURED = "2026-10-30T08:59:00.000Z";
const SEEN = "2026-10-30T09:00:00.000Z";
const LATER = "2026-10-30T10:00:00.000Z";

let n = 0;

async function scenario(db: PGlite) {
  n += 1;
  const ids = { leagueId: String(5100 + n), homeTeamId: String(55_000 + n * 2), awayTeamId: String(55_001 + n * 2) };
  const seed = await seedIngestIdentities(db, ids);
  const capture = (more: Partial<SyntheticCaptureOptions> = {}) =>
    syntheticCapture({ ...ids, providerFixtureId: String(15_000_000 + n), playerIdBase: [9_000_000 + n * 100, 9_500_000 + n * 100], kickoffAt: KICKOFF, capturedAt: CAPTURED, ...more });
  return { seed, ids, capture };
}

const conflicts = (db: PGlite) => loadProviderRefConflicts(pgliteRpc(db) as never, "sportmonks");
const brief = (rows: ProviderRefConflict[]) =>
  rows.map((r) => [r.issue_code, r.ref_kind, r.provider_ref, r.observation_version, r.is_current_version, r.recorded_canonical_id, r.current_canonical_id]);

async function otherTeam(db: PGlite, name: string): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.teams (canonical_name) values ($1) returning id", [name])).rows[0].id;
}

test("a clean ingest seals canonical ids with its refs and reports no conflicts", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const result = await ingest(db, observationFrom(s.capture()), SEEN);
  const refs = await db.query<{ ref_kind: string; provider_ref: string; canonical_id: string | null }>(
    "select ref_kind, provider_ref, canonical_id from public.match_ledger_observation_provider_refs where observation_id = $1 order by ref_kind",
    [result.observation_id],
  );
  assert.deepEqual(refs.rows.map((r) => [r.ref_kind, r.provider_ref, r.canonical_id]), [
    ["league", s.ids.leagueId, s.seed.competitionId],
    ["season", "99001", null],
    ["team_away", s.ids.awayTeamId, s.seed.awayTeamId],
    ["team_home", s.ids.homeTeamId, s.seed.homeTeamId],
  ]);
  assert.deepEqual(await conflicts(db), []);
  await db.close();
});

test("team refs: missing, untrusted and drift are reported with deterministic codes and order", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  await ingest(db, observationFrom(s.capture()), SEEN);
  const elsewhere = await otherTeam(db, "Repointed FC");

  // V3-style repoint of the home team (trusted, different team) and a name-resolved away team.
  await db.query("update public.provider_team_mappings set team_id = $1 where provider = 'sportmonks' and provider_team_id = $2", [elsewhere, s.ids.homeTeamId]);
  await db.query("update public.provider_team_mappings set mapping_confidence = 0.9 where provider = 'sportmonks' and provider_team_id = $1", [s.ids.awayTeamId]);
  const first = await conflicts(db);
  assert.deepEqual(brief(first), [
    ["team_mapping_untrusted", "team_away", s.ids.awayTeamId, 1, true, s.seed.awayTeamId, s.seed.awayTeamId],
    ["team_mapping_drift", "team_home", s.ids.homeTeamId, 1, true, s.seed.homeTeamId, elsewhere],
  ]);
  assert.deepEqual([first[0].current_mapping_status, first[0].current_mapping_confidence], ["confirmed", 0.9]);
  assert.deepEqual(await conflicts(db), first);

  // An untrusted mapping that also points elsewhere reports both; a missing one reports only "missing".
  await db.query("update public.provider_team_mappings set team_id = $1, mapping_status = 'unverified' where provider = 'sportmonks' and provider_team_id = $2", [elsewhere, s.ids.awayTeamId]);
  await db.query("delete from public.provider_team_mappings where provider = 'sportmonks' and provider_team_id = $1", [s.ids.homeTeamId]);
  assert.deepEqual(brief(await conflicts(db)), [
    ["team_mapping_drift", "team_away", s.ids.awayTeamId, 1, true, s.seed.awayTeamId, elsewhere],
    ["team_mapping_untrusted", "team_away", s.ids.awayTeamId, 1, true, s.seed.awayTeamId, elsewhere],
    ["team_mapping_missing", "team_home", s.ids.homeTeamId, 1, true, s.seed.homeTeamId, null],
  ]);
  await db.close();
});

test("competition refs: missing, untrusted, drift and fixture competition drift", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const result = await ingest(db, observationFrom(s.capture()), SEEN);
  const other = await seedIngestIdentities(db, { mapCompetition: false, mapTeams: false });

  // Plain V3 'confirmed' is below the historical trust boundary.
  await db.query("update public.provider_competition_mappings set mapping_status = 'confirmed' where provider = 'sportmonks' and provider_competition_id = $1", [s.ids.leagueId]);
  assert.deepEqual(brief(await conflicts(db)), [["competition_mapping_untrusted", "league", s.ids.leagueId, 1, true, s.seed.competitionId, s.seed.competitionId]]);

  // Repointed to another competition under manual_override.
  await db.query(
    "update public.provider_competition_mappings set mapping_status = 'manual_override', competition_id = $1 where provider = 'sportmonks' and provider_competition_id = $2",
    [other.competitionId, s.ids.leagueId],
  );
  assert.deepEqual(brief(await conflicts(db)), [["competition_mapping_drift", "league", s.ids.leagueId, 1, true, s.seed.competitionId, other.competitionId]]);

  // V3 re-files the canonical fixture (the Toto import updates competition_id).
  await db.query("update public.fixtures set competition_id = $1 where id = $2", [other.competitionId, result.fixture_id]);
  assert.deepEqual(brief(await conflicts(db)), [
    ["competition_mapping_drift", "league", s.ids.leagueId, 1, true, s.seed.competitionId, other.competitionId],
    ["fixture_competition_drift", "league", s.ids.leagueId, 1, true, s.seed.competitionId, other.competitionId],
  ]);

  await db.query("delete from public.provider_competition_mappings where provider = 'sportmonks' and provider_competition_id = $1", [s.ids.leagueId]);
  assert.deepEqual(brief(await conflicts(db)).map((r) => r[0]), ["competition_mapping_missing", "fixture_competition_drift"]);
  await db.close();
});

test("reconciliation covers every observation version, marks the current one, ignores unsealed history and never writes", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  await ingest(db, observationFrom(s.capture()), SEEN);
  await ingest(db, observationFrom(s.capture({ score90: [3, 1] })), LATER);
  // A plain 1A write (no sealed refs) is outside this report.
  const legacy = await seedLedger(db);
  const fixture = await createFixture(db, legacy, KICKOFF);
  await recordObservation(db, buildMatchLedgerObservationPayload(realisticObservation(legacy, fixture, { kickoffAt: KICKOFF, retrievedAt: CAPTURED })), SEEN);

  const elsewhere = await otherTeam(db, "Moved FC");
  await db.query("update public.provider_team_mappings set team_id = $1 where provider = 'sportmonks' and provider_team_id = $2", [elsewhere, s.ids.homeTeamId]);
  const before = await writeFootprint(db);
  const rows = await conflicts(db);
  assert.deepEqual(rows.map((r) => [r.issue_code, r.observation_version, r.is_current_version]), [
    ["team_mapping_drift", 1, false],
    ["team_mapping_drift", 2, true],
  ]);
  assert.ok(rows.every((r) => (PROVIDER_REF_CONFLICT_CODES as readonly string[]).includes(r.issue_code)));
  assert.deepEqual(await writeFootprint(db), before);
  const volatility = (await db.query<{ v: string }>("select provolatile as v from pg_proc where oid = 'public.match_ledger_provider_ref_conflicts(text)'::regprocedure")).rows[0].v;
  assert.equal(volatility, "s");

  // The 1A fixture reconciliation is unchanged and still reports fixture-mapping drift.
  await db.query("update public.provider_fixture_mappings set provider_fixture_id = 'moved' where provider = 'sportmonks' and provider_fixture_id = $1", [String(15_000_000 + n)]);
  await db.query("insert into public.provider_fixture_mappings (fixture_id, provider, provider_fixture_id, mapping_confidence) values ($1, 'sportmonks', $2, 1)", [fixture.fixtureId, String(15_000_000 + n)]);
  const fixtureDrift = await db.query<{ conflict_kind: string }>("select conflict_kind from public.match_ledger_mapping_conflicts('sportmonks') where conflict_kind = 'fixture'");
  assert.equal(fixtureDrift.rows.length, 1);
  await db.close();
});
