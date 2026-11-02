import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { MATCH_LEDGER_AS_OF_FUNCTIONS, MATCH_LEDGER_AS_OF_V2_FUNCTIONS } from "./as-of";
import { buildMatchLedgerWithdrawalPayload, type MatchLedgerObservationInput } from "./match-ledger";
import { loadSquadStateInputs, loadSquadStateInputsV2, type SquadStateRpc } from "./squad-state";
import { createLedgerDatabase, recordObservation, resultOnlyObservation, setClock } from "./test-support/ledger-fixtures";
import {
  attestCompetition,
  attestTeam,
  attestedWorld,
  canonicalFixtureFor,
  ingestV2,
  operatorSql,
  revokeCompetition,
  revokeTeam,
  type AttestedWorld,
} from "./test-support/attestation-fixtures";
import { ingest } from "./test-support/provider-ingest-fixtures";
import { insertMembership, membershipKey } from "./test-support/roster-fixtures";
import { insertTenure } from "./test-support/lineup-fixtures";

/**
 * Attestation-aware consumer reads (PR #43) against the real migration
 * chain: the V2 reads select the latest visible version and the V1 last-N
 * window exactly as V1 does, then keep only observations whose sealed Stage 1
 * identity attestations are currently valid. Every case below is a negative
 * control for "fail closed, never fall back".
 */

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

async function asOf(db: PGlite, fn: "match_ledger_observation_as_of" | "match_ledger_observation_as_of_v2", fixtureId: string, provider = "sportmonks", cutoff = CUTOFF) {
  return (await db.query<{ id: string | null }>(
    `select public.${fn}($1, $2, $3) as id`,
    [fixtureId, provider, cutoff],
  )).rows[0].id;
}

async function teamRows(db: PGlite, fn: "match_ledger_provider_team_matches_as_of" | "match_ledger_provider_team_matches_as_of_v2", teamId: string, limit = 50, provider = "sportmonks") {
  return (await db.query<{ observation_id: string; fixture_id: string }>(
    `select observation_id, fixture_id from public.${fn}($1, $2, $3, $4)`,
    [provider, teamId, CUTOFF, limit],
  )).rows;
}

async function playerRows(db: PGlite, fn: "match_ledger_provider_player_matches_as_of" | "match_ledger_provider_player_matches_as_of_v2", playerId: string, limit = 50) {
  return (await db.query<{ observation_id: string; fixture_id: string }>(
    `select observation_id, fixture_id from public.${fn}('sportmonks', $1, $2, $3)`,
    [playerId, CUTOFF, limit],
  )).rows;
}

async function firstPlayer(db: PGlite, observationId: string, teamId: string): Promise<string> {
  return (await db.query<{ player_id: string }>(
    "select player_id from public.match_ledger_players where observation_id = $1 and team_id = $2 order by player_id limit 1",
    [observationId, teamId],
  )).rows[0].player_id;
}

async function issueOf(db: PGlite, observationId: string): Promise<string | null> {
  return (await db.query<{ i: string | null }>("select private.match_ledger_observation_attestation_issue($1) as i", [observationId])).rows[0].i;
}

/** What every V2 consumer read returns for one fixture, home team and one home player. */
async function v2View(db: PGlite, w: AttestedWorld, ctx: { fixtureId: string; target: string; playerId: string }) {
  const squad = await loadSquadStateInputsV2(squadRpc(db), { fixtureId: ctx.target, teamId: w.seed.homeTeamId, cutoff: CUTOFF });
  return {
    asOf: await asOf(db, "match_ledger_observation_as_of_v2", ctx.fixtureId),
    team: (await teamRows(db, "match_ledger_provider_team_matches_as_of_v2", w.seed.homeTeamId)).filter((r) => r.fixture_id === ctx.fixtureId).map((r) => r.observation_id),
    player: (await playerRows(db, "match_ledger_provider_player_matches_as_of_v2", ctx.playerId)).filter((r) => r.fixture_id === ctx.fixtureId).map((r) => r.observation_id),
    squad: squad.history.filter((h) => h.fixture_id === ctx.fixtureId).map((h) => h.observation_id),
  };
}

const visible = (id: string) => ({ asOf: id, team: [id], player: [id], squad: [id] });
const HIDDEN = { asOf: null, team: [], player: [], squad: [] };

/** One attested world with one trusted (V2-ingested) finished fixture and an upcoming target. */
async function trustedFixture(db: PGlite) {
  const w = await attestedWorld(db, { kickoffAt: PAST_KICKOFF, capturedAt: CAPTURED });
  const recorded = await ingestV2(db, w.observation(), SEEN);
  assert.equal(recorded.status, "recorded");
  const target = await canonicalFixtureFor(db, w.seed, TARGET_KICKOFF);
  const playerId = await firstPlayer(db, recorded.observation_id!, w.seed.homeTeamId);
  return { w, recorded, fixtureId: recorded.fixture_id!, target, playerId, ctx: { fixtureId: recorded.fixture_id!, target, playerId } };
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

  const onePlayer = await firstPlayer(db, recorded.observation_id!, w.seed.homeTeamId);

  assert.deepEqual((await teamRows(db, "match_ledger_provider_team_matches_as_of_v2", w.seed.homeTeamId)).map((r) => r.observation_id), [recorded.observation_id]);
  assert.equal((await teamRows(db, "match_ledger_provider_team_matches_as_of", w.seed.homeTeamId)).some((r) => r.observation_id === plain.observation_id), true);
  assert.deepEqual((await playerRows(db, "match_ledger_provider_player_matches_as_of_v2", onePlayer)).map((r) => r.observation_id), [recorded.observation_id]);

  const v1Inputs = await loadSquadStateInputs(squadRpc(db), { fixtureId: targetFixture, teamId: w.seed.homeTeamId, cutoff: CUTOFF });
  const v2Inputs = await loadSquadStateInputsV2(squadRpc(db), { fixtureId: targetFixture, teamId: w.seed.homeTeamId, cutoff: CUTOFF });
  assert.equal(v1Inputs.history.some((o) => o.observation_id === plain.observation_id), true);
  assert.deepEqual(v2Inputs.history.map((o) => o.observation_id), [recorded.observation_id]);
  // The read names itself; the frozen V1 read does not.
  assert.equal(v2Inputs.read_version, "kapiloto-squad-state-read-v2");
  assert.equal(v1Inputs.read_version, undefined);

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

test("multi-version chains: the latest visible version decides; an untrusted plain 1A or V1-ingest correction never resurrects an older trusted version", async () => {
  const db = await createLedgerDatabase();
  const { w, recorded: v1, fixtureId, ctx } = await trustedFixture(db);
  assert.deepEqual(await v2View(db, w, ctx), visible(v1.observation_id!));

  // A trusted V2 re-ingest with corrected facts is the new latest version.
  const v2 = await ingestV2(db, w.observation({ score90: [3, 1], capturedAt: "2026-10-30T09:59:00.000Z" }), "2026-10-30T10:00:00.000Z");
  assert.deepEqual([v2.status, v2.observation_version], ["recorded", 2]);
  const ctx2 = { ...ctx, playerId: await firstPlayer(db, v2.observation_id!, w.seed.homeTeamId) };
  assert.deepEqual(await v2View(db, w, ctx2), visible(v2.observation_id!));

  // An old-style V1 provider ingest correction (v3): recorded without a
  // sealed attestation sidecar. V2 hides the fixture; it does not fall back to v2.
  const v3 = await ingest(db, w.observation({ score90: [4, 1], capturedAt: "2026-10-30T10:59:00.000Z" }), "2026-10-30T11:00:00.000Z");
  assert.deepEqual([v3.status, v3.observation_version], ["recorded", 3]);
  assert.equal(await issueOf(db, v3.observation_id!), "attestation_missing");
  assert.equal(await asOf(db, "match_ledger_observation_as_of", fixtureId), v3.observation_id);
  assert.deepEqual(await v2View(db, w, ctx2), HIDDEN);
  // As of a cutoff before v3 was first seen, v2 is still the latest and trusted.
  assert.equal(await asOf(db, "match_ledger_observation_as_of_v2", fixtureId, "sportmonks", "2026-10-30T10:30:00.000Z"), v2.observation_id);

  // A plain 1A correction (v4) on top: still hidden, and V2 ingest cannot
  // stack a trusted version on a latest version that has no sealed refs.
  const v4 = await recordObservation(db, resultOnlyObservation({ fixtureId, providerFixtureId: w.providerFixtureId }, w.seed.homeTeamId, w.seed.awayTeamId,
    { kickoffAt: PAST_KICKOFF, retrievedAt: "2026-10-30T11:59:00.000Z", homeGoals: 5, awayGoals: 1 }), "2026-10-30T12:00:00.000Z");
  assert.deepEqual([v4.status, v4.observation_version], ["recorded", 4]);
  assert.deepEqual(await v2View(db, w, ctx2), HIDDEN);
  const stacked = await ingestV2(db, w.observation({ score90: [6, 1], capturedAt: "2026-10-30T12:59:00.000Z" }), "2026-10-30T13:00:00.000Z");
  assert.deepEqual([stacked.status, stacked.reason_code], ["quarantined", "provider_refs_unrecorded"]);
  assert.deepEqual(await v2View(db, w, ctx2), HIDDEN);

  // The same rule for a plain correction directly on a trusted v1.
  const second = await trustedFixture(db);
  const plain = await recordObservation(db, resultOnlyObservation({ fixtureId: second.fixtureId, providerFixtureId: second.w.providerFixtureId }, second.w.seed.homeTeamId, second.w.seed.awayTeamId,
    { kickoffAt: PAST_KICKOFF, retrievedAt: "2026-10-30T09:59:00.000Z", homeGoals: 4, awayGoals: 4 }), "2026-10-30T10:00:00.000Z");
  assert.equal(plain.observation_version, 2);
  assert.deepEqual(await v2View(db, second.w, second.ctx), HIDDEN);
  assert.equal(await asOf(db, "match_ledger_observation_as_of", second.fixtureId), plain.observation_id);
  await db.close();
});

test("a withdrawal hides the fixture in V2 exactly as in V1, and only a newer trusted version shows it again", async () => {
  const db = await createLedgerDatabase();
  const { w, fixtureId, ctx } = await trustedFixture(db);
  await setClock(db, "2026-10-30T10:00:00.000Z");
  const withdrawal = (await db.query<{ r: { status: string; observation_version: number } }>("select public.match_ledger_record_observation($1::jsonb) as r", [JSON.stringify(buildMatchLedgerWithdrawalPayload({
    fixtureId, provider: "sportmonks", providerFixtureId: w.providerFixtureId, captureMode: "backfill", ingestVersion: "withdrawal-test-v1",
    retrievedAt: "2026-10-30T09:59:00.000Z", withdrawalReason: "attached to the wrong fixture",
  }))])).rows[0].r;
  assert.deepEqual([withdrawal.status, withdrawal.observation_version], ["recorded", 2]);
  assert.equal(await asOf(db, "match_ledger_observation_as_of", fixtureId), null);
  assert.deepEqual(await v2View(db, w, ctx), HIDDEN);

  const corrected = await ingestV2(db, w.observation({ score90: [0, 0], capturedAt: "2026-10-30T10:59:00.000Z" }), "2026-10-30T11:00:00.000Z");
  assert.deepEqual([corrected.status, corrected.observation_version], ["recorded", 3]);
  const playerId = await firstPlayer(db, corrected.observation_id!, w.seed.homeTeamId);
  assert.deepEqual(await v2View(db, w, { ...ctx, playerId }), visible(corrected.observation_id!));
  await db.close();
});

test("competition, home and away attestations are each required; re-attestation opens a new generation and never rehabilitates", async () => {
  const db = await createLedgerDatabase();
  // Away team revoked: the observation (both sides sealed) is hidden for the home team too.
  const away = await trustedFixture(db);
  await revokeTeam(db, away.w.ids.awayTeamId, away.w.seed.awayTeamId);
  assert.equal(await issueOf(db, away.recorded.observation_id!), "generation_revoked");
  assert.deepEqual(await v2View(db, away.w, away.ctx), HIDDEN);
  await attestTeam(db, away.w.ids.awayTeamId, away.w.seed.awayTeamId);
  assert.equal(await issueOf(db, away.recorded.observation_id!), "attestation_generation_stale");
  assert.deepEqual(await v2View(db, away.w, away.ctx), HIDDEN);
  // Only new evidence under the new generation is trusted: a fresh V2 ingest.
  const fresh = await ingestV2(db, away.w.observation({ score90: [2, 2], capturedAt: "2026-10-30T10:59:00.000Z" }), "2026-10-30T11:00:00.000Z");
  assert.equal(fresh.status, "recorded");
  const freshPlayer = await firstPlayer(db, fresh.observation_id!, away.w.seed.homeTeamId);
  assert.deepEqual(await v2View(db, away.w, { ...away.ctx, playerId: freshPlayer }), visible(fresh.observation_id!));

  // Competition revoked, then re-attested.
  const league = await trustedFixture(db);
  await revokeCompetition(db, league.w.ids.leagueId, league.w.seed.competitionId);
  assert.equal(await issueOf(db, league.recorded.observation_id!), "generation_revoked");
  assert.deepEqual(await v2View(db, league.w, league.ctx), HIDDEN);
  await attestCompetition(db, league.w.ids.leagueId, league.w.seed.competitionId);
  assert.equal(await issueOf(db, league.recorded.observation_id!), "attestation_generation_stale");
  assert.deepEqual(await v2View(db, league.w, league.ctx), HIDDEN);
  // V1 never looked at trust.
  assert.equal(await asOf(db, "match_ledger_observation_as_of", league.fixtureId), league.recorded.observation_id);
  await db.close();
});

test("mapping demotion, deletion with a V3-style re-insert, and re-pointing all fail closed", async () => {
  const db = await createLedgerDatabase();
  const where = "where provider = 'sportmonks' and provider_team_id = $1";

  // Demotion of the team mapping, and of the competition mapping.
  const demoted = await trustedFixture(db);
  await operatorSql(db, `update public.provider_team_mappings set mapping_status = 'confirmed' ${where}`, [demoted.w.ids.homeTeamId]);
  assert.equal(await issueOf(db, demoted.recorded.observation_id!), "mapping_not_manual_override");
  assert.deepEqual(await v2View(db, demoted.w, demoted.ctx), HIDDEN);
  const leagueDemoted = await trustedFixture(db);
  await operatorSql(db, "update public.provider_competition_mappings set mapping_status = 'confirmed' where provider = 'sportmonks' and provider_competition_id = $1", [leagueDemoted.w.ids.leagueId]);
  assert.equal(await issueOf(db, leagueDemoted.recorded.observation_id!), "mapping_not_manual_override");
  assert.deepEqual(await v2View(db, leagueDemoted.w, leagueDemoted.ctx), HIDDEN);

  // Deletion, then the weak V3 bootstrap re-insert: still not trusted (RFC 8).
  const deleted = await trustedFixture(db);
  await operatorSql(db, `delete from public.provider_team_mappings ${where}`, [deleted.w.ids.homeTeamId]);
  assert.equal(await issueOf(db, deleted.recorded.observation_id!), "mapping_missing");
  assert.deepEqual(await v2View(db, deleted.w, deleted.ctx), HIDDEN);
  await db.query(
    "insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_status, mapping_confidence) values ('sportmonks', $1, $2, 'confirmed', 0.9)",
    [deleted.w.ids.homeTeamId, deleted.w.seed.homeTeamId],
  );
  assert.equal(await issueOf(db, deleted.recorded.observation_id!), "mapping_not_manual_override");
  assert.deepEqual(await v2View(db, deleted.w, deleted.ctx), HIDDEN);
  // Current-state trust (D-058): only an operator restoring the exact
  // agreeing manual_override mapping, under a generation that was never
  // revoked, makes the sealed observation trusted again.
  await operatorSql(db, `update public.provider_team_mappings set mapping_status = 'manual_override', mapping_confidence = 1 ${where}`, [deleted.w.ids.homeTeamId]);
  assert.equal(await issueOf(db, deleted.recorded.observation_id!), null);
  assert.deepEqual(await v2View(db, deleted.w, deleted.ctx), visible(deleted.recorded.observation_id!));

  // Re-pointing without the revoke sequence disagrees; the RFC sequence
  // (revoke -> correct mapping -> attest the new canonical) leaves the old
  // observation stale for good.
  const repointed = await trustedFixture(db);
  const other = (await db.query<{ id: string }>("insert into public.teams (canonical_name, country_code) values ('Synthetic Repoint Target', 'IL') returning id")).rows[0].id;
  await operatorSql(db, `update public.provider_team_mappings set team_id = $2 ${where}`, [repointed.w.ids.homeTeamId, other]);
  assert.equal(await issueOf(db, repointed.recorded.observation_id!), "mapping_disagrees");
  assert.deepEqual(await v2View(db, repointed.w, repointed.ctx), HIDDEN);
  await operatorSql(db, `update public.provider_team_mappings set team_id = $2 ${where}`, [repointed.w.ids.homeTeamId, repointed.w.seed.homeTeamId]);
  await revokeTeam(db, repointed.w.ids.homeTeamId, repointed.w.seed.homeTeamId);
  await operatorSql(db, `update public.provider_team_mappings set team_id = $2 ${where}`, [repointed.w.ids.homeTeamId, other]);
  await attestTeam(db, repointed.w.ids.homeTeamId, other);
  assert.equal(await issueOf(db, repointed.recorded.observation_id!), "attestation_generation_stale");
  assert.deepEqual(await v2View(db, repointed.w, repointed.ctx), HIDDEN);
  await db.close();
});

test("a multi-provider fixture contributes only its attested Sportmonks observation to V2", async () => {
  const db = await createLedgerDatabase();
  const { w, recorded, fixtureId, target, ctx } = await trustedFixture(db);
  // Stage 1 attests Sportmonks only: an API-Football observation of the same
  // canonical fixture is never trusted.
  const af = await recordObservation(db, resultOnlyObservation({ fixtureId, providerFixtureId: "af-multi" }, w.seed.homeTeamId, w.seed.awayTeamId,
    { kickoffAt: PAST_KICKOFF, retrievedAt: SEEN, homeGoals: 2, awayGoals: 1, provider: "api_football" }), SEEN);
  assert.equal(af.status, "recorded");
  const v1 = await loadSquadStateInputs(squadRpc(db), { fixtureId: target, teamId: w.seed.homeTeamId, cutoff: CUTOFF });
  assert.deepEqual(v1.history.map((h) => h.provider).sort(), ["api_football", "sportmonks"]);
  assert.deepEqual(await v2View(db, w, ctx), visible(recorded.observation_id!));
  const v2 = await loadSquadStateInputsV2(squadRpc(db), { fixtureId: target, teamId: w.seed.homeTeamId, cutoff: CUTOFF });
  assert.deepEqual(v2.history.map((h) => h.provider), ["sportmonks"]);
  assert.equal(await asOf(db, "match_ledger_observation_as_of_v2", fixtureId, "api_football"), null);
  assert.deepEqual(await teamRows(db, "match_ledger_provider_team_matches_as_of_v2", w.seed.homeTeamId, 50, "api_football"), []);
  assert.equal(await asOf(db, "match_ledger_observation_as_of", fixtureId, "api_football"), af.observation_id);
  await db.close();
});

test("empty trusted history: V2 returns no history but the same memberships, claims and tenures", async () => {
  const db = await createLedgerDatabase();
  const w = await attestedWorld(db, { kickoffAt: PAST_KICKOFF, capturedAt: CAPTURED });
  const target = await canonicalFixtureFor(db, w.seed, TARGET_KICKOFF);
  const plainFixture = await canonicalFixtureFor(db, w.seed, "2026-07-01T18:00:00.000Z");
  await recordObservation(db, resultOnlyObservation({ fixtureId: plainFixture, providerFixtureId: "plain-only" }, w.seed.homeTeamId, w.seed.awayTeamId,
    { kickoffAt: "2026-07-01T18:00:00.000Z", retrievedAt: SEEN, homeGoals: 1, awayGoals: 0 }), SEEN);
  const player = (await db.query<{ id: string }>("insert into public.players (canonical_name) values ('Synthetic Member') returning id")).rows[0].id;
  const coach = (await db.query<{ id: string }>("insert into public.coaches (canonical_name) values ('Synthetic Coach') returning id")).rows[0].id;
  await insertMembership(db, { membership_key: membershipKey(), team_id: w.seed.homeTeamId, player_id: player }, "2026-09-01T00:00:00.000Z");
  await insertTenure(db, w.seed.homeTeamId, coach, "2026-09-01T00:00:00.000Z");

  const v1 = await loadSquadStateInputs(squadRpc(db), { fixtureId: target, teamId: w.seed.homeTeamId, cutoff: CUTOFF });
  const v2 = await loadSquadStateInputsV2(squadRpc(db), { fixtureId: target, teamId: w.seed.homeTeamId, cutoff: CUTOFF });
  assert.equal(v1.history.length, 1);
  assert.deepEqual(v2.history, []);
  assert.deepEqual(v2.memberships, v1.memberships);
  assert.equal(v2.memberships.length, 1);
  assert.deepEqual(v2.tenures, v1.tenures);
  assert.equal(v2.tenures.length, 1);
  assert.deepEqual(v2.claims, v1.claims);
  assert.deepEqual(await teamRows(db, "match_ledger_provider_team_matches_as_of_v2", w.seed.homeTeamId), []);
  await db.close();
});

test("conservative window: an untrusted fixture inside the V1 last-N window shrinks V2 history and is never replaced by an older one", async () => {
  const db = await createLedgerDatabase();
  const { w, recorded: trusted, target, playerId } = await trustedFixture(db);
  // A newer finished fixture known only through a plain 1A observation that
  // also lists the home player (so the player read has it in its window too).
  const newerKickoff = "2026-09-20T18:00:00.000Z";
  const newer = await canonicalFixtureFor(db, w.seed, newerKickoff);
  const observation: MatchLedgerObservationInput = resultOnlyObservation({ fixtureId: newer, providerFixtureId: "plain-newer" }, w.seed.homeTeamId, w.seed.awayTeamId,
    { kickoffAt: newerKickoff, retrievedAt: SEEN, homeGoals: 0, awayGoals: 1 });
  observation.teams[0].lineupStatus = "partial";
  observation.players = [{
    teamId: w.seed.homeTeamId, playerId, providerPlayerId: null, providerPlayerName: null, lineupRole: "starter", appeared: true,
    positionCode: "GK", providerPosition: null, formationPosition: 1, formationField: null, shirtNumber: 1, isCaptain: null,
    minutesPlayed: null, enteredMinute: null, exitedMinute: null, dataCompleteness: "partial",
  }];
  const plain = await recordObservation(db, observation, SEEN);
  assert.equal(plain.status, "recorded");

  const squad = async (read: "v1" | "v2", limit: number) => {
    const load = read === "v1" ? loadSquadStateInputs : loadSquadStateInputsV2;
    return (await load(squadRpc(db), { fixtureId: target, teamId: w.seed.homeTeamId, cutoff: CUTOFF, historyFixtureLimit: limit })).history.map((h) => h.observation_id);
  };
  const ids = (rows: { observation_id: string }[]) => rows.map((r) => r.observation_id);

  // Window of 1: V1 picks the newer (plain) fixture; V2 keeps that window and
  // drops it. It must NOT reach back to the older trusted fixture.
  assert.deepEqual(await squad("v1", 1), [plain.observation_id]);
  assert.deepEqual(await squad("v2", 1), []);
  assert.deepEqual(ids(await teamRows(db, "match_ledger_provider_team_matches_as_of", w.seed.homeTeamId, 1)), [plain.observation_id]);
  assert.deepEqual(ids(await teamRows(db, "match_ledger_provider_team_matches_as_of_v2", w.seed.homeTeamId, 1)), []);
  assert.deepEqual(ids(await playerRows(db, "match_ledger_provider_player_matches_as_of", playerId, 1)), [plain.observation_id]);
  assert.deepEqual(ids(await playerRows(db, "match_ledger_provider_player_matches_as_of_v2", playerId, 1)), []);

  // Window of 2 covers both; V2 returns the trusted one only.
  assert.deepEqual((await squad("v1", 2)).sort(), [plain.observation_id, trusted.observation_id].sort());
  assert.deepEqual(await squad("v2", 2), [trusted.observation_id]);
  assert.deepEqual(ids(await teamRows(db, "match_ledger_provider_team_matches_as_of_v2", w.seed.homeTeamId, 2)), [trusted.observation_id]);
  assert.deepEqual(ids(await playerRows(db, "match_ledger_provider_player_matches_as_of_v2", playerId, 2)), [trusted.observation_id]);
  await db.close();
});

test("the TypeScript read names: V2 reads are executable by service_role, the frozen V1 consumer reads are not", async () => {
  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true });
  const serviceRole = async (fn: string) => (await db.query<{ s: boolean | null }>(
    "select bool_and(has_function_privilege('service_role', p.oid, 'execute')) as s from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1",
    [fn],
  )).rows[0].s;
  for (const fn of Object.values(MATCH_LEDGER_AS_OF_V2_FUNCTIONS)) assert.equal(await serviceRole(fn), true, fn);
  for (const [key, fn] of Object.entries(MATCH_LEDGER_AS_OF_FUNCTIONS)) {
    assert.equal(await serviceRole(fn), key === "coachTenures", fn);
  }
  await db.close();
});
