import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { loadSquadStateInputs, loadSquadStateInputsV2, type SquadStateRpc } from "./squad-state";
import { createLedgerDatabase, recordObservation, resultOnlyObservation } from "./test-support/ledger-fixtures";
import {
  attestTeam,
  attestedWorld,
  canonicalFixtureFor,
  ingestV2,
  revokeTeam,
} from "./test-support/attestation-fixtures";

const PAST_KICKOFF = "2026-08-15T18:00:00.000Z";
const CAPTURED = "2026-10-30T08:59:00.000Z";
const SEEN = "2026-10-30T09:00:00.000Z";
const TARGET_KICKOFF = "2026-11-02T18:00:00.000Z";
const CUTOFF = "2026-11-02T17:00:00.000Z";

const squadRpc = (db: PGlite): SquadStateRpc => async (fn, args) =>
  (await db.query<{ r: unknown }>(
    `select public.${fn}($1, $2, $3, $4) as r`,
    [args.p_fixture_id, args.p_team_id, args.p_cutoff, args.p_history_fixture_limit ?? 30],
  )).rows[0].r;

async function asOf(db: PGlite, fn: "match_ledger_observation_as_of" | "match_ledger_observation_as_of_v2", fixtureId: string) {
  return (await db.query<{ id: string | null }>(
    `select public.${fn}($1, 'sportmonks', $2) as id`,
    [fixtureId, CUTOFF],
  )).rows[0].id;
}

async function teamRows(db: PGlite, fn: "match_ledger_provider_team_matches_as_of" | "match_ledger_provider_team_matches_as_of_v2", teamId: string) {
  return (await db.query<{ observation_id: string; fixture_id: string }>(
    `select observation_id, fixture_id from public.${fn}('sportmonks', $1, $2, 50)`,
    [teamId, CUTOFF],
  )).rows;
}

async function playerRows(db: PGlite, fn: "match_ledger_provider_player_matches_as_of" | "match_ledger_provider_player_matches_as_of_v2", playerId: string) {
  return (await db.query<{ observation_id: string; fixture_id: string }>(
    `select observation_id, fixture_id from public.${fn}('sportmonks', $1, $2, 50)`,
    [playerId, CUTOFF],
  )).rows;
}

test("attestation-aware consumer reads include only currently trusted V2 observations and never fall back", async () => {
  const db = await createLedgerDatabase();
  const w = await attestedWorld(db, { kickoffAt: PAST_KICKOFF, capturedAt: CAPTURED });
  const recorded = await ingestV2(db, w.observation(), SEEN);
  assert.equal(recorded.status, "recorded");
  assert.ok(recorded.observation_id && recorded.fixture_id);

  const targetFixture = await canonicalFixtureFor(db, w.seed, TARGET_KICKOFF);

  // A plain 1A observation on the same attested canonical teams has no sealed
  // attestation provenance and must remain visible only through frozen V1.
  const plainFixture = await canonicalFixtureFor(db, w.seed, "2026-07-01T18:00:00.000Z");
  const plain = await recordObservation(
    db,
    resultOnlyObservation(
      { fixtureId: plainFixture, providerFixtureId: "plain-consumer-v1" },
      w.seed.homeTeamId,
      w.seed.awayTeamId,
      { kickoffAt: "2026-07-01T18:00:00.000Z", retrievedAt: SEEN, homeGoals: 1, awayGoals: 0 },
    ),
    SEEN,
  );
  assert.equal(plain.status, "recorded");

  assert.equal(await asOf(db, "match_ledger_observation_as_of", recorded.fixture_id!), recorded.observation_id);
  assert.equal(await asOf(db, "match_ledger_observation_as_of_v2", recorded.fixture_id!), recorded.observation_id);
  assert.equal(await asOf(db, "match_ledger_observation_as_of", plainFixture), plain.observation_id);
  assert.equal(await asOf(db, "match_ledger_observation_as_of_v2", plainFixture), null);

  const onePlayer = (await db.query<{ player_id: string }>(
    "select player_id from public.match_ledger_players where observation_id = $1 order by player_id limit 1",
    [recorded.observation_id],
  )).rows[0].player_id;

  assert.deepEqual((await teamRows(db, "match_ledger_provider_team_matches_as_of_v2", w.seed.homeTeamId)).map((r) => r.observation_id), [recorded.observation_id]);
  assert.equal((await teamRows(db, "match_ledger_provider_team_matches_as_of", w.seed.homeTeamId)).some((r) => r.observation_id === plain.observation_id), true);
  assert.deepEqual((await playerRows(db, "match_ledger_provider_player_matches_as_of_v2", onePlayer)).map((r) => r.observation_id), [recorded.observation_id]);

  const v1Inputs = await loadSquadStateInputs(squadRpc(db), { fixtureId: targetFixture, teamId: w.seed.homeTeamId, cutoff: CUTOFF });
  const v2Inputs = await loadSquadStateInputsV2(squadRpc(db), { fixtureId: targetFixture, teamId: w.seed.homeTeamId, cutoff: CUTOFF });
  assert.equal(v1Inputs.history.some((o) => o.observation_id === plain.observation_id), true);
  assert.deepEqual(v2Inputs.history.map((o) => o.observation_id), [recorded.observation_id]);

  // Revoking the sealed generation immediately excludes the observation from
  // every V2 consumer. V1 remains frozen and still exposes its historical row.
  await revokeTeam(db, w.ids.homeTeamId, w.seed.homeTeamId, "consumer-read negative control");
  assert.equal(await asOf(db, "match_ledger_observation_as_of_v2", recorded.fixture_id!), null);
  assert.equal(await asOf(db, "match_ledger_observation_as_of", recorded.fixture_id!), recorded.observation_id);
  assert.deepEqual(await teamRows(db, "match_ledger_provider_team_matches_as_of_v2", w.seed.homeTeamId), []);
  assert.deepEqual(await playerRows(db, "match_ledger_provider_player_matches_as_of_v2", onePlayer), []);
  assert.deepEqual((await loadSquadStateInputsV2(squadRpc(db), { fixtureId: targetFixture, teamId: w.seed.homeTeamId, cutoff: CUTOFF })).history, []);

  // Re-attesting the same provider team opens a new generation. The old
  // observation stays stale; the V2 reads must not resurrect it.
  await attestTeam(db, w.ids.homeTeamId, w.seed.homeTeamId);
  assert.equal(await asOf(db, "match_ledger_observation_as_of_v2", recorded.fixture_id!), null);
  assert.deepEqual(await teamRows(db, "match_ledger_provider_team_matches_as_of_v2", w.seed.homeTeamId), []);
  assert.deepEqual((await loadSquadStateInputsV2(squadRpc(db), { fixtureId: targetFixture, teamId: w.seed.homeTeamId, cutoff: CUTOFF })).history, []);

  await db.close();
});
