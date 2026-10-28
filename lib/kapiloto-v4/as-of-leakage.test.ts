import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import type { ProviderPlayerMatchAsOfRow, ProviderTeamMatchAsOfRow } from "./as-of";
import { buildMatchLedgerWithdrawalPayload } from "./match-ledger";
import {
  createFixture,
  createLedgerDatabase,
  realisticObservation,
  recordObservation,
  resultOnlyObservation,
  seedLedger,
  setClock,
} from "./test-support/ledger-fixtures";

const NOV_1 = "2026-11-01T00:00:00.000Z";

async function teamMatchesAsOf(
  db: PGlite,
  teamId: string,
  cutoff: string,
  limit = 10,
  provider = "sportmonks",
): Promise<ProviderTeamMatchAsOfRow[]> {
  const result = await db.query<ProviderTeamMatchAsOfRow>(
    "select * from public.match_ledger_provider_team_matches_as_of($1, $2, $3, $4)",
    [provider, teamId, cutoff, limit],
  );
  return result.rows;
}

async function playerMatchesAsOf(
  db: PGlite,
  playerId: string,
  cutoff: string,
  provider = "sportmonks",
): Promise<ProviderPlayerMatchAsOfRow[]> {
  const result = await db.query<ProviderPlayerMatchAsOfRow>(
    "select * from public.match_ledger_provider_player_matches_as_of($1, $2, $3, 10)",
    [provider, playerId, cutoff],
  );
  return result.rows;
}

async function observationAsOf(db: PGlite, fixtureId: string, cutoff: string): Promise<string | null> {
  const result = await db.query<{ id: string | null }>(
    "select public.match_ledger_observation_as_of($1, 'sportmonks', $2) as id",
    [fixtureId, cutoff],
  );
  return result.rows[0].id;
}

test("leakage example: Oct 30 event first seen Nov 3 is invisible at a Nov 1 cutoff", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const kickoff = "2026-10-30T18:00:00.000Z";
  const fixture = await createFixture(db, seed, kickoff);

  // The provider backfills the Oct 30 match; Kapiloto first stores it Nov 3.
  const recorded = await recordObservation(
    db,
    realisticObservation(seed, fixture, { kickoffAt: kickoff, retrievedAt: "2026-11-03T08:59:00.000Z", withRedCard: true }),
    "2026-11-03T09:00:00.000Z",
  );
  const row = await db.query<{ kickoff_at: Date; first_seen_at: Date }>(
    "select kickoff_at, first_seen_at from public.match_ledger_observations where id = $1",
    [recorded.observation_id],
  );
  // Event-valid time is earlier than information time.
  assert.ok(row.rows[0].kickoff_at < new Date(NOV_1));
  assert.ok(row.rows[0].first_seen_at > new Date(NOV_1));

  // Nov 1 reconstruction: nothing about the match, from any entry point.
  assert.deepEqual(await teamMatchesAsOf(db, seed.home.teamId, NOV_1), []);
  assert.deepEqual(await teamMatchesAsOf(db, seed.away.teamId, NOV_1), []);
  assert.equal(await observationAsOf(db, fixture.fixtureId, NOV_1), null);
  assert.deepEqual(await playerMatchesAsOf(db, seed.away.playerIds[6], NOV_1), []);

  // After Nov 3 the same match is visible.
  const nov4 = await teamMatchesAsOf(db, seed.home.teamId, "2026-11-04T00:00:00.000Z");
  assert.equal(nov4.length, 1);
  assert.equal(nov4[0].fixture_id, fixture.fixtureId);
  await db.close();
});

test("a later correction never rewrites an earlier cutoff's view", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const kickoff = "2026-10-25T18:00:00.000Z";
  const fixture = await createFixture(db, seed, kickoff);
  const v1 = await recordObservation(
    db,
    realisticObservation(seed, fixture, { kickoffAt: kickoff, retrievedAt: "2026-10-26T08:00:00.000Z" }),
    "2026-10-26T08:00:30.000Z",
  );
  // Nov 3: provider corrects the match (adds a second yellow, changes score).
  const v2 = await recordObservation(
    db,
    realisticObservation(seed, fixture, {
      kickoffAt: kickoff,
      retrievedAt: "2026-11-03T08:59:00.000Z",
      withRedCard: true,
      homeGoals: 2,
      awayGoals: 2,
    }),
    "2026-11-03T09:00:00.000Z",
  );
  assert.equal(v2.observation_version, 2);

  assert.equal(await observationAsOf(db, fixture.fixtureId, NOV_1), v1.observation_id);
  const asOfNov1 = await teamMatchesAsOf(db, seed.home.teamId, NOV_1);
  assert.equal(asOfNov1.length, 1);
  assert.equal(asOfNov1[0].observation_version, 1);
  assert.deepEqual([asOfNov1[0].goals_for_90, asOfNov1[0].goals_against_90], [2, 1]);
  const redCardsNov1 = await db.query(
    "select 1 from public.match_ledger_events where observation_id = $1 and event_type in ('red_card', 'second_yellow_card')",
    [asOfNov1[0].observation_id],
  );
  assert.equal(redCardsNov1.rows.length, 0);

  const asOfNov4 = await teamMatchesAsOf(db, seed.home.teamId, "2026-11-04T00:00:00.000Z");
  assert.equal(asOfNov4[0].observation_id, v2.observation_id);
  assert.deepEqual([asOfNov4[0].goals_for_90, asOfNov4[0].goals_against_90], [2, 2]);

  // Player history reads one version per fixture: the sent-off player's
  // minutes change only for cutoffs after the correction was first seen.
  const sentOff = seed.away.playerIds[6];
  const playerNov1 = await playerMatchesAsOf(db, sentOff, NOV_1);
  assert.deepEqual(playerNov1.map((row) => [row.observation_version, row.minutes_played]), [[1, 90]]);
  const playerNov4 = await playerMatchesAsOf(db, sentOff, "2026-11-04T00:00:00.000Z");
  assert.deepEqual(playerNov4.map((row) => [row.observation_version, row.minutes_played, row.exited_minute]), [[2, 80, 80]]);
  await db.close();
});

test("a withdrawal hides wrongly attached data from later cutoffs only", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const kickoff = "2026-10-24T18:00:00.000Z";
  const fixture = await createFixture(db, seed, kickoff);
  const withdrawal = buildMatchLedgerWithdrawalPayload({
    fixtureId: fixture.fixtureId,
    provider: "sportmonks",
    providerFixtureId: fixture.providerFixtureId,
    captureMode: "manual_import",
    ingestVersion: "ledger-ingest-test-v1",
    retrievedAt: "2026-11-03T08:00:00.000Z",
    withdrawalReason: "provider fixture belongs to a different canonical fixture",
  });
  // Nothing to withdraw yet.
  await assert.rejects(recordObservation(db, withdrawal, "2026-10-20T00:00:00.000Z"), /no provider observation to withdraw/);

  const v1 = await recordObservation(
    db,
    realisticObservation(seed, fixture, { kickoffAt: kickoff, retrievedAt: "2026-10-25T06:00:00.000Z" }),
    "2026-10-25T06:00:30.000Z",
  );
  const withdrawn = await recordObservation(db, withdrawal, "2026-11-03T08:00:30.000Z");
  assert.equal(withdrawn.status, "recorded");
  assert.equal(withdrawn.observation_version, 2);
  const again = await recordObservation(db, withdrawal, "2026-11-03T09:00:00.000Z");
  assert.equal(again.status, "unchanged");

  assert.equal(await observationAsOf(db, fixture.fixtureId, NOV_1), v1.observation_id);
  assert.equal((await teamMatchesAsOf(db, seed.home.teamId, NOV_1)).length, 1);
  assert.equal((await playerMatchesAsOf(db, seed.home.playerIds[0], NOV_1)).length, 1);

  const nov4 = "2026-11-04T00:00:00.000Z";
  assert.equal(await observationAsOf(db, fixture.fixtureId, nov4), null);
  assert.deepEqual(await teamMatchesAsOf(db, seed.home.teamId, nov4), []);
  assert.deepEqual(await playerMatchesAsOf(db, seed.home.playerIds[0], nov4), []);

  // A withdrawal version cannot carry match data.
  await setClock(db, "2026-11-05T00:00:00.000Z");
  await assert.rejects(
    db.query(
      "insert into public.match_ledger_team_records (observation_id, team_id, side, lineup_status, substitutions_status, events_status, statistics_status) values ($1, $2, 'home', 'complete', 'complete', 'complete', 'complete')",
      [withdrawn.observation_id, seed.home.teamId],
    ),
    /sealed|withdrawal/,
  );
  await db.close();
});

test("one canonical fixture seen by two providers is never double-counted", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const kickoff = "2026-10-24T18:00:00.000Z";
  const fixture = await createFixture(db, seed, kickoff);
  await recordObservation(
    db,
    resultOnlyObservation(fixture, seed.home.teamId, seed.away.teamId, { kickoffAt: kickoff, retrievedAt: "2026-10-25T06:00:00.000Z", homeGoals: 1, awayGoals: 0 }),
    "2026-10-25T06:00:00.000Z",
  );
  await recordObservation(
    db,
    resultOnlyObservation({ fixtureId: fixture.fixtureId, providerFixtureId: "ifa-77" }, seed.home.teamId, seed.away.teamId, {
      kickoffAt: kickoff,
      retrievedAt: "2026-10-25T07:00:00.000Z",
      homeGoals: 1,
      awayGoals: 0,
      provider: "ifa",
    }),
    "2026-10-25T07:00:00.000Z",
  );
  for (const provider of ["sportmonks", "ifa"]) {
    const rows = await teamMatchesAsOf(db, seed.home.teamId, NOV_1, 10, provider);
    assert.deepEqual(rows.map((row) => row.fixture_id), [fixture.fixtureId], provider);
    assert.equal(new Set(rows.map((row) => row.fixture_id)).size, rows.length);
  }
  // There is no all-providers history: a missing provider is an error, not a union.
  await assert.rejects(
    db.query("select * from public.match_ledger_provider_team_matches_as_of(null, $1, $2, 10)", [seed.home.teamId, NOV_1]),
    /provider, team and cutoff are required/,
  );
  await assert.rejects(
    db.query("select * from public.match_ledger_provider_player_matches_as_of(null, $1, $2, 10)", [seed.home.playerIds[0], NOV_1]),
    /provider, player and cutoff are required/,
  );
  await assert.rejects(
    db.query("select public.match_ledger_observation_as_of($1, null, $2)", [fixture.fixtureId, NOV_1]),
    /fixture, provider and cutoff are required/,
  );
  await db.close();
});

test("recent matches as of a cutoff respect information time, order, limit and provider", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const home = seed.home.teamId;
  const away = seed.away.teamId;
  // Five matches; the last one played before the cutoff is learned too late.
  const schedule: Array<[string, string, "normal" | "reversed", number, number]> = [
    ["2026-10-03T18:00:00.000Z", "2026-10-04T06:00:00.000Z", "normal", 1, 0],
    ["2026-10-10T18:00:00.000Z", "2026-10-11T06:00:00.000Z", "reversed", 2, 2],
    ["2026-10-17T18:00:00.000Z", "2026-10-18T06:00:00.000Z", "normal", 0, 1],
    ["2026-10-24T18:00:00.000Z", "2026-10-25T06:00:00.000Z", "reversed", 3, 1],
    ["2026-10-30T18:00:00.000Z", "2026-11-03T09:00:00.000Z", "normal", 4, 0],
  ];
  for (const [kickoff, seen, orientation, homeGoals, awayGoals] of schedule) {
    const fixture = await createFixture(db, seed, kickoff, orientation);
    const [fixtureHome, fixtureAway] = orientation === "normal" ? [home, away] : [away, home];
    await recordObservation(
      db,
      resultOnlyObservation(fixture, fixtureHome, fixtureAway, {
        kickoffAt: kickoff,
        retrievedAt: seen,
        homeGoals,
        awayGoals,
      }),
      seen,
    );
  }
  // A second provider observed one match too; it is a separate source row.
  const cupFixture = await createFixture(db, seed, "2026-10-21T17:00:00.000Z");
  await recordObservation(
    db,
    resultOnlyObservation(cupFixture, home, away, {
      kickoffAt: "2026-10-21T17:00:00.000Z",
      retrievedAt: "2026-10-22T06:00:00.000Z",
      homeGoals: 1,
      awayGoals: 1,
      provider: "ifa",
    }),
    "2026-10-22T06:00:00.000Z",
  );

  const rows = await teamMatchesAsOf(db, home, NOV_1, 3);
  assert.deepEqual(
    rows.map((row) => [new Date(row.kickoff_at).toISOString(), row.side, row.goals_for_90, row.goals_against_90, row.provider]),
    [
      ["2026-10-24T18:00:00.000Z", "away", 1, 3, "sportmonks"],
      ["2026-10-17T18:00:00.000Z", "home", 0, 1, "sportmonks"],
      ["2026-10-10T18:00:00.000Z", "away", 2, 2, "sportmonks"],
    ],
  );
  const sportmonksOnly = await teamMatchesAsOf(db, home, NOV_1, 10);
  assert.equal(sportmonksOnly.length, 4);
  assert.equal(sportmonksOnly[0].lineup_status, "not_provided");
  // The IFA-only cup match exists only in the IFA view.
  const ifaOnly = await teamMatchesAsOf(db, home, NOV_1, 10, "ifa");
  assert.deepEqual(ifaOnly.map((row) => row.fixture_id), [cupFixture.fixtureId]);

  // A cutoff between kickoff and first-seen of the Oct 24 match excludes it.
  const oct25Early = await teamMatchesAsOf(db, home, "2026-10-25T05:00:00.000Z", 10);
  assert.deepEqual(oct25Early.map((row) => row.goals_for_90), [0, 2, 1]);
  await db.close();
});

test("coach tenures as of a cutoff ignore an end date learned later", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const tenureKey = "90000000-0000-4000-8000-000000000001";
  const insert = (end: string | null, status = "asserted") =>
    db.query(
      `insert into public.team_coach_tenures
         (tenure_key, team_id, coach_id, starts_on_earliest, starts_on_latest,
          ends_on_earliest, ends_on_latest, assertion_status, source_kind, ingest_version)
       values ($1, $2, $3, '2026-06-01', '2026-06-01', $4, $4, $5, 'official_club', 'tenure-test-v1')`,
      [tenureKey, seed.home.teamId, seed.home.coachId, end, status],
    );
  await setClock(db, "2026-06-02T00:00:00.000Z");
  await insert(null);
  // Sacked on Oct 30; Kapiloto records it on Nov 3.
  await setClock(db, "2026-11-03T00:00:00.000Z");
  await insert("2026-10-30");

  const tenuresAsOf = async (cutoff: string) =>
    (
      await db.query<{ tenure_version: number; ends_on_latest: Date | string | null }>(
        "select tenure_version, ends_on_latest from public.team_coach_tenures_as_of($1, $2)",
        [seed.home.teamId, cutoff],
      )
    ).rows;
  const nov1 = await tenuresAsOf(NOV_1);
  assert.deepEqual(nov1.map((row) => [row.tenure_version, row.ends_on_latest]), [[1, null]]);
  const nov4 = await tenuresAsOf("2026-11-04T00:00:00.000Z");
  assert.equal(nov4[0].tenure_version, 2);
  assert.notEqual(nov4[0].ends_on_latest, null);

  // A retraction hides the tenure from later cutoffs only.
  await setClock(db, "2026-11-05T00:00:00.000Z");
  await insert("2026-10-30", "retracted");
  assert.equal((await tenuresAsOf("2026-11-06T00:00:00.000Z")).length, 0);
  assert.equal((await tenuresAsOf("2026-11-04T00:00:00.000Z")).length, 1);
  await db.close();
});
