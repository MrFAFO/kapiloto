import assert from "node:assert/strict";
import test from "node:test";

import { buildMatchLedgerObservationPayload } from "./match-ledger";
import {
  createFixture,
  createLedgerDatabase,
  realisticObservation,
  recordObservation,
  seedLedger,
  setClock,
} from "./test-support/ledger-fixtures";

const KICKOFF = "2026-10-30T18:00:00.000Z";
const SEEN = "2026-10-31T09:00:00.000Z";
const RETRIEVED = "2026-10-31T08:59:30.000Z";

async function count(db: Awaited<ReturnType<typeof createLedgerDatabase>>, table: string, observationId: string) {
  const result = await db.query<{ n: number }>(
    `select count(*)::int as n from public.${table} where observation_id = $1`,
    [observationId],
  );
  return result.rows[0].n;
}

test("a realistic fixture is stored atomically with lineups, substitutions, events and stats", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, KICKOFF);
  const input = realisticObservation(seed, fixture, { kickoffAt: KICKOFF, retrievedAt: RETRIEVED, withRedCard: true });

  const result = await recordObservation(db, input, SEEN);
  assert.equal(result.status, "recorded");
  assert.equal(result.observation_version, 1);
  assert.equal(new Date(result.first_seen_at).toISOString(), SEEN);
  assert.match(result.content_sha256, /^[0-9a-f]{64}$/);

  const id = result.observation_id;
  assert.equal(await count(db, "match_ledger_team_records", id), 2);
  assert.equal(await count(db, "match_ledger_players", id), 36);
  assert.equal(await count(db, "match_ledger_substitutions", id), 6);
  assert.equal(await count(db, "match_ledger_events", id), 8);
  assert.equal(await count(db, "match_ledger_team_stats", id), 10);

  const teams = await db.query<{ side: string; team_id: string; opponent_team_id: string; coach_id: string; formation_nominal: string; first_seen_at: Date }>(
    "select side, team_id, opponent_team_id, coach_id, formation_nominal, first_seen_at from public.match_ledger_team_records where observation_id = $1 order by side",
    [id],
  );
  assert.deepEqual(
    teams.rows.map((row) => [row.side, row.team_id, row.opponent_team_id, row.coach_id, row.formation_nominal]),
    [
      ["away", seed.away.teamId, seed.home.teamId, seed.away.coachId, "4-3-3"],
      ["home", seed.home.teamId, seed.away.teamId, seed.home.coachId, "4-2-3-1"],
    ],
  );
  assert.equal(teams.rows[0].first_seen_at.toISOString(), SEEN);

  const starters = await db.query<{ team_id: string; n: number }>(
    "select team_id, count(*)::int as n from public.match_ledger_players where observation_id = $1 and lineup_role = 'starter' group by team_id",
    [id],
  );
  assert.deepEqual(starters.rows.map((row) => row.n), [11, 11]);

  // Fixture lineup reconstruction joins substitutions back to the squad.
  const subs = await db.query<{ minute: number; off_role: string; on_role: string; on_entered: number }>(
    `select s.minute, off.lineup_role as off_role, onp.lineup_role as on_role, onp.entered_minute as on_entered
     from public.match_ledger_substitutions s
     join public.match_ledger_players off on off.observation_id = s.observation_id and off.player_id = s.player_off_id
     join public.match_ledger_players onp on onp.observation_id = s.observation_id and onp.player_id = s.player_on_id
     where s.observation_id = $1 and s.team_id = $2 order by s.sequence_no`,
    [id, seed.home.teamId],
  );
  assert.deepEqual(subs.rows.map((row) => [row.minute, row.off_role, row.on_role, row.on_entered]), [
    [61, "starter", "bench", 61],
    [70, "starter", "bench", 70],
    [78, "starter", "bench", 78],
  ]);

  const events = await db.query<{ event_type: string; minute: number; stoppage_minute: number | null; coach_id: string | null }>(
    "select event_type, minute, stoppage_minute, coach_id from public.match_ledger_events where observation_id = $1 order by sequence_no",
    [id],
  );
  assert.deepEqual(events.rows.map((row) => row.event_type), [
    "goal", "yellow_card", "own_goal", "yellow_card", "penalty_goal", "penalty_missed", "second_yellow_card", "yellow_card",
  ]);
  assert.equal(events.rows[2].stoppage_minute, 2);
  assert.equal(events.rows[7].coach_id, seed.home.coachId);

  // Numeric analytical query across the typed stat representation.
  const xg = await db.query<{ team_id: string; value: string }>(
    `select ts.team_id, ts.value_numeric::text as value
     from public.match_ledger_team_stats ts
     join public.match_ledger_stat_definitions d on d.id = ts.stat_definition_id
     where ts.observation_id = $1 and d.stat_key = 'expected_goals' order by ts.value_numeric desc`,
    [id],
  );
  assert.deepEqual(xg.rows.map((row) => [row.team_id, row.value]), [
    [seed.home.teamId, "1.82"],
    [seed.away.teamId, "1.11"],
  ]);
  await db.close();
});

test("re-ingesting identical content is a no-op; a correction is a new version", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, KICKOFF);
  const input = realisticObservation(seed, fixture, { kickoffAt: KICKOFF, retrievedAt: RETRIEVED });
  const first = await recordObservation(db, input, SEEN);

  // Same football content, different retrieval metadata and player order.
  const again = buildMatchLedgerObservationPayload({
    ...input,
    retrievedAt: "2026-11-02T10:00:00.000Z",
    sourceUpdatedAt: "2026-11-02T09:00:00.000Z",
    players: [...input.players!].reverse(),
  });
  const unchanged = await recordObservation(db, again, "2026-11-02T10:00:30.000Z");
  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.observation_id, first.observation_id);

  const corrected = realisticObservation(seed, fixture, {
    kickoffAt: KICKOFF,
    retrievedAt: "2026-11-03T08:59:00.000Z",
    withRedCard: true,
  });
  const second = await recordObservation(db, corrected, "2026-11-03T09:00:00.000Z");
  assert.equal(second.status, "recorded");
  assert.equal(second.observation_version, 2);
  assert.notEqual(second.content_sha256, first.content_sha256);

  // Version 1 is untouched: 7 events, no red card.
  assert.equal(await count(db, "match_ledger_events", first.observation_id), 7);
  assert.equal(await count(db, "match_ledger_events", second.observation_id), 8);
  await db.close();
});

test("observations are immutable and sealed after their transaction", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, KICKOFF);
  const result = await recordObservation(db, realisticObservation(seed, fixture, { kickoffAt: KICKOFF, retrievedAt: RETRIEVED }), SEEN);
  const id = result.observation_id;

  for (const table of [
    "match_ledger_observations",
    "match_ledger_team_records",
    "match_ledger_players",
    "match_ledger_substitutions",
    "match_ledger_events",
    "match_ledger_team_stats",
  ]) {
    const column = table === "match_ledger_observations" ? "id" : "observation_id";
    await assert.rejects(db.query(`delete from public.${table} where ${column} = $1`, [id]), /immutable/, table);
  }
  await assert.rejects(
    db.query("update public.match_ledger_observations set home_goals_90 = 5 where id = $1", [id]),
    /immutable/,
  );
  await assert.rejects(db.query("truncate public.match_ledger_events"), /immutable|truncate/);

  // Appending a red card to the old version later would backdate information.
  await setClock(db, "2026-11-03T09:00:00.000Z");
  await assert.rejects(
    db.query(
      `insert into public.match_ledger_events (observation_id, team_id, sequence_no, event_type, player_id)
       values ($1, $2, 99, 'red_card', $3)`,
      [id, seed.away.teamId, seed.away.playerIds[4]],
    ),
    /sealed/,
  );
  await db.close();
});

test("writers cannot backdate first_seen_at or choose observation versions", async () => {
  // Real clock: no test override.
  const db = await createLedgerDatabase({ testClock: false });
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, "2024-01-01T18:00:00.000Z");
  const before = Date.now();
  const inserted = await db.query<{ first_seen_at: Date; observation_version: number }>(
    `insert into public.match_ledger_observations
       (fixture_id, provider, provider_fixture_id, capture_mode, ingest_version,
        content_sha256, retrieved_at, first_seen_at, kickoff_at, match_status,
        observation_version, home_goals_90, away_goals_90)
     values ($1, 'sportmonks', $2, 'manual_import', 'test', repeat('a', 64),
        '2024-01-02T00:00:00Z', '2024-01-02T00:00:00Z', '2024-01-01T18:00:00Z', 'finished',
        42, 1, 0)
     returning first_seen_at, observation_version`,
    [fixture.fixtureId, fixture.providerFixtureId],
  );
  assert.ok(inserted.rows[0].first_seen_at.getTime() >= before - 60_000);
  assert.equal(inserted.rows[0].observation_version, 1);
  await db.close();
});

test("the RPC rejects malformed, inconsistent or mis-mapped observations", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, KICKOFF);
  const base = () => realisticObservation(seed, fixture, { kickoffAt: KICKOFF, retrievedAt: RETRIEVED });

  const unknownField = buildMatchLedgerObservationPayload(base());
  (unknownField.players as Array<Record<string, unknown>>)[0].minutes_playd = 90;
  await assert.rejects(recordObservation(db, unknownField, SEEN), /unknown match ledger player field: minutes_playd/);

  const wrongVersion = { ...buildMatchLedgerObservationPayload(base()), contract_version: "v0" };
  await assert.rejects(recordObservation(db, wrongVersion, SEEN), /unsupported match ledger contract version/);

  const oneTeam = base();
  oneTeam.teams = [oneTeam.teams[0]];
  await assert.rejects(recordObservation(db, oneTeam, SEEN), /exactly two teams/);

  const swapped = base();
  swapped.teams[0].side = "away";
  swapped.teams[1].side = "home";
  await assert.rejects(recordObservation(db, swapped, SEEN), /does not match the fixture/);

  const twelve = base();
  twelve.players![11].lineupRole = "starter";
  await assert.rejects(recordObservation(db, twelve, SEEN), /more than 11 starters/);

  const starterOn = base();
  starterOn.substitutions![0].playerOnId = seed.home.playerIds[1];
  await assert.rejects(recordObservation(db, starterOn, SEEN), /starter cannot be substituted on|duplicate key/);

  const foreignScorer = base();
  foreignScorer.events![0].playerId = seed.away.playerIds[3];
  await assert.rejects(recordObservation(db, foreignScorer, SEEN), /foreign key/);

  const unknownPlayer = base();
  unknownPlayer.players![0].playerId = "63000000-0000-4000-8000-999999999999";
  await assert.rejects(recordObservation(db, unknownPlayer, SEEN), /foreign key/);

  // A finished match cannot be first seen before it could have ended.
  await assert.rejects(recordObservation(db, base(), "2026-10-30T19:00:00.000Z"), /check constraint/);

  // retrieved_at cannot be later than the information time.
  await assert.rejects(
    recordObservation(db, { ...base(), retrievedAt: "2026-11-05T00:00:00.000Z" }, SEEN),
    /check constraint/,
  );

  // Two events claiming the same provider event id are refused.
  const duplicateEvent = base();
  duplicateEvent.events![1].providerEventId = duplicateEvent.events![0].providerEventId;
  await assert.rejects(recordObservation(db, duplicateEvent, SEEN), /duplicate key/);

  // A provider fixture id mapped to another canonical fixture is refused.
  const other = await createFixture(db, seed, "2026-10-20T18:00:00.000Z");
  await db.query(
    "insert into public.provider_fixture_mappings (fixture_id, provider, provider_fixture_id) values ($1, 'sportmonks', $2)",
    [other.fixtureId, fixture.providerFixtureId],
  );
  await assert.rejects(recordObservation(db, base(), SEEN), /mapped to a different canonical fixture/);

  // Nothing partial was left behind by any failed call.
  const rows = await db.query<{ n: number }>("select count(*)::int as n from public.match_ledger_observations");
  assert.equal(rows.rows[0].n, 0);
  await db.close();
});

test("one provider fixture id cannot be recorded against two canonical fixtures", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, KICKOFF);
  // A duplicated canonical fixture for the same match, without any mapping row.
  const duplicate = await createFixture(db, seed, KICKOFF);
  await recordObservation(db, realisticObservation(seed, fixture, { kickoffAt: KICKOFF, retrievedAt: RETRIEVED }), SEEN);
  await assert.rejects(
    recordObservation(
      db,
      realisticObservation(seed, { fixtureId: duplicate.fixtureId, providerFixtureId: fixture.providerFixtureId }, { kickoffAt: KICKOFF, retrievedAt: RETRIEVED }),
      SEEN,
    ),
    /already recorded for a different canonical fixture/,
  );
  await db.close();
});

test("partial provider data and derived game-state segments are representable", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, KICKOFF);
  const input = realisticObservation(seed, fixture, { kickoffAt: KICKOFF, retrievedAt: RETRIEVED });
  // Away lineup only partially known (IFA-style sheet without bench), no stats.
  input.players = input.players!.filter((p) => p.teamId === seed.home.teamId || p.lineupRole === "starter");
  input.players.filter((p) => p.teamId === seed.away.teamId).forEach((p) => {
    p.dataCompleteness = "partial";
    p.minutesPlayed = null;
    p.exitedMinute = null;
  });
  input.substitutions = input.substitutions!.filter((s) => s.teamId === seed.home.teamId);
  input.teams[1] = { ...input.teams[1], lineupStatus: "partial", substitutionsStatus: "not_provided", statisticsStatus: "not_provided", coachId: null, formationNominal: null };
  input.teamStats = input.teamStats!.filter((s) => s.teamId === seed.home.teamId);
  const result = await recordObservation(db, input, SEEN);
  assert.equal(result.status, "recorded");

  await setClock(db, "2026-11-10T00:00:00.000Z");
  await db.query(
    `insert into public.match_ledger_game_state_segments
       (observation_id, team_id, derivation_version, segment_index, period,
        from_minute, to_minute, goals_for, goals_against, men_for, men_against)
     values ($1, $2, 'game-state-test-v1', 0, 'first_half', 0, 12, 0, 0, 11, 11),
            ($1, $2, 'game-state-test-v1', 1, 'first_half', 12, 45, 1, 0, 11, 11)`,
    [result.observation_id, seed.home.teamId],
  );
  const segments = await db.query<{ score_diff: number; men_diff: number }>(
    "select score_diff, men_diff from public.match_ledger_game_state_segments where observation_id = $1 order by segment_index",
    [result.observation_id],
  );
  assert.deepEqual(segments.rows.map((row) => [row.score_diff, row.men_diff]), [[0, 0], [1, 0]]);
  await assert.rejects(
    db.query(
      `insert into public.match_ledger_game_state_segments
         (observation_id, team_id, derivation_version, segment_index, period,
          from_minute, to_minute, goals_for, goals_against, men_for, men_against)
       values ($1, $2, 'game-state-test-v1', 2, 'second_half', 70, 60, 1, 0, 11, 11)`,
      [result.observation_id, seed.home.teamId],
    ),
    /check constraint/,
  );
  await db.close();
});
