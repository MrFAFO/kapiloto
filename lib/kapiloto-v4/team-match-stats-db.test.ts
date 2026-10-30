import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { buildMatchLedgerObservationPayload, buildMatchLedgerWithdrawalPayload } from "./match-ledger";
import { loadTeamMatchStats, type TeamMatchStatsRow } from "./team-match-stats";
import { loadRetrospectiveTrainingExclusions, loadTeamMatchStatsForTraining } from "./training/team-match-stats";
import { basePrediction, recordPrediction } from "./test-support/knowledge-fixtures";
import { createFixture, createLedgerDatabase, realisticObservation, recordObservation, seedLedger } from "./test-support/ledger-fixtures";
import {
  ingest,
  observationFrom,
  pgliteRpc,
  seedIngestIdentities,
  syntheticCapture,
  type SyntheticCaptureOptions,
} from "./test-support/provider-ingest-fixtures";

/** kapiloto-team-match-stats-v1 strict and retrospective-training reads on SYNTHETIC data. */

const KICKOFF = "2026-08-15T18:00:00.000Z";
const CAPTURED = "2026-10-30T08:59:00.000Z";
const SEEN = "2026-10-30T09:00:00.000Z";
const POLICY = "kapiloto-retrospective-training-availability-v1";

let n = 0;

async function scenario(db: PGlite, overrides: Partial<SyntheticCaptureOptions> = {}) {
  n += 1;
  const ids = { leagueId: String(7000 + n), homeTeamId: String(75_000 + n * 2), awayTeamId: String(75_001 + n * 2) };
  const seed = await seedIngestIdentities(db, ids);
  const capture = (more: Partial<SyntheticCaptureOptions> = {}) =>
    syntheticCapture({
      ...ids,
      providerFixtureId: String(17_000_000 + n),
      playerIdBase: [5_000_000 + n * 100, 6_000_000 + n * 100],
      kickoffAt: KICKOFF,
      capturedAt: CAPTURED,
      ...overrides,
      ...more,
    });
  return { seed, capture };
}

async function strict(db: PGlite, cutoff: string, competitionIds: string[] | null = null) {
  return (await loadTeamMatchStats(pgliteRpc(db) as never, { provider: "sportmonks", competitionIds, from: null, cutoff })).rows;
}

async function training(db: PGlite, trainingCutoff: string, competitionIds: string[] | null = null) {
  return (await loadTeamMatchStatsForTraining(pgliteRpc(db) as never, { provider: "sportmonks", competitionIds, from: null, trainingCutoff })).rows;
}

const side = (rows: TeamMatchStatsRow[], s: "home" | "away") => rows.find((r) => r.side === s)!;

async function exclusions(db: PGlite, trainingCutoff: string, competitionIds: string[] | null = null) {
  return loadRetrospectiveTrainingExclusions(pgliteRpc(db) as never, { provider: "sportmonks", competitionIds, from: null, trainingCutoff });
}

test("strict read: one row per team, for/against stats with provenance, only after first_seen_at", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const result = await ingest(db, observationFrom(s.capture()), SEEN);

  assert.deepEqual(await strict(db, "2026-10-30T08:59:59.000Z"), []);
  const rows = await strict(db, SEEN, [s.seed.competitionId]);
  assert.equal(rows.length, 2);
  const home = side(rows, "home");
  assert.equal(home.team_id, s.seed.homeTeamId);
  assert.equal(home.opponent_team_id, s.seed.awayTeamId);
  assert.equal(home.fixture_id, result.fixture_id);
  assert.equal(home.observation_id, result.observation_id);
  assert.deepEqual(
    [home.competition_id, home.provider_league_ref, home.provider_season_ref, home.provider, home.capture_mode, home.ingest_version],
    [s.seed.competitionId, String(7000 + n), "99001", "sportmonks", "backfill", "kapiloto-sportmonks-ledger-mapping-v1"],
  );
  assert.deepEqual([home.evaluation_class, home.availability_basis, home.availability_policy], ["actual", "actual", null]);
  assert.equal(new Date(home.first_seen_at).toISOString(), SEEN);
  assert.equal(new Date(home.effective_available_at).toISOString(), SEEN);
  assert.deepEqual([home.goals_for_90, home.goals_against_90, home.went_to_extra_time, home.penalties_for], [2, 1, false, null]);
  assert.deepEqual([home.lineup_status, home.statistics_status, home.quality_flags], ["complete", "complete", []]);
  assert.deepEqual(home.stats_for.expected_goals, {
    value: 1.82,
    status: "observed",
    definition_id: home.stats_for.expected_goals.definition_id,
    provider_stat_type: "5304",
    definition_version: "sm-2024-08",
    period: "full_time",
  });
  assert.match(home.stats_for.expected_goals.definition_id!, /^[0-9a-f-]{36}$/);
  assert.equal(home.stats_against.expected_goals.value, 1.11);
  assert.equal(home.stats_for.expected_goals_on_target.value, 1.64);
  assert.equal(home.stats_for.expected_non_penalty_goals.value, 1.06);
  assert.equal(home.stats_for.possession_pct.value, 54);
  const away = side(rows, "away");
  assert.deepEqual([away.goals_for_90, away.goals_against_90, away.stats_for.shots_total.value, away.stats_against.shots_total.value], [1, 2, 9, 14]);

  // Competition and lower-bound filters.
  assert.deepEqual(await strict(db, SEEN, ["00000000-0000-4000-8000-000000000000"]), []);
  const later = await loadTeamMatchStats(pgliteRpc(db) as never, { provider: "sportmonks", competitionIds: null, from: "2026-08-16T00:00:00.000Z", cutoff: SEEN });
  assert.deepEqual(later.rows, []);
  assert.deepEqual(await loadTeamMatchStats(pgliteRpc(db) as never, { provider: "api_football", competitionIds: null, from: null, cutoff: SEEN }).then((r) => r.rows), []);
  await db.close();
});

test("missingness: not_observed, family_not_provided and not_separable are distinct and never zero", async () => {
  const db = await createLedgerDatabase();

  const noXg = await scenario(db, { families: { xg: "not_requested" } });
  await ingest(db, observationFrom(noXg.capture()), SEEN);
  const missingCorners = await scenario(db, { omitStatTypes: [34] });
  await ingest(db, observationFrom(missingCorners.capture()), SEEN);
  const extraTime = await scenario(db, { state: "AET", score90: [1, 1], scoreAet: [2, 1] });
  await ingest(db, observationFrom(extraTime.capture()), SEEN);
  const shootout = await scenario(db, { state: "FT_PEN", score90: [0, 0], scoreAet: [0, 0], penalties: [4, 2] });
  await ingest(db, observationFrom(shootout.capture()), SEEN);

  const byCompetition = async (competitionId: string) => side(await strict(db, SEEN, [competitionId]), "home");

  const xg = await byCompetition(noXg.seed.competitionId);
  assert.deepEqual(xg.stats_for.expected_goals, { value: null, status: "family_not_provided", definition_id: null, provider_stat_type: null, definition_version: null, period: null });
  assert.equal(xg.stats_for.shots_total.status, "observed");
  assert.deepEqual([xg.statistics_status, xg.quality_flags], ["partial", ["xg_not_requested"]]);

  const corners = await byCompetition(missingCorners.seed.competitionId);
  assert.deepEqual([corners.stats_for.corners.value, corners.stats_for.corners.status], [null, "not_observed"]);
  assert.deepEqual([corners.stats_against.corners.status, corners.stats_for.expected_goals.status], ["not_observed", "observed"]);

  const aet = await byCompetition(extraTime.seed.competitionId);
  assert.deepEqual([aet.goals_for_90, aet.goals_against_90, aet.went_to_extra_time], [1, 1, true]);
  assert.ok(Object.values(aet.stats_for).every((e) => e.status === "not_separable" && e.value === null));
  assert.deepEqual(aet.quality_flags, ["went_to_extra_time"]);

  const pens = side(await strict(db, SEEN, [shootout.seed.competitionId]), "away");
  assert.deepEqual([pens.goals_for_90, pens.penalties_for, pens.penalties_against, pens.went_to_extra_time], [0, 2, 4, true]);
  await db.close();
});

test("observations written without family status (plain 1A writes) report family_not_provided for absent stats", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, KICKOFF);
  await recordObservation(db, realisticObservation(seed, fixture, { kickoffAt: KICKOFF, retrievedAt: CAPTURED }), SEEN);
  const home = side(await strict(db, SEEN, [seed.competitionId]), "home");
  assert.equal(home.stats_for.expected_goals.status, "observed");
  assert.equal(home.stats_for.expected_goals_on_target.status, "family_not_provided");
  assert.ok(home.quality_flags.includes("family_fetches_unrecorded"));
  assert.equal(home.provider_league_ref, null);
  await db.close();
});

test("retrospective training availability: version 1 of backfilled finished data at kickoff + 24h; with no later version it stays usable", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db, { families: { xg: "not_requested" } });
  const v1 = await ingest(db, observationFrom(s.capture()), SEEN);
  const cutoff = "2026-09-10T00:00:00.000Z";

  // Strict: not known at the cutoff. Training: available since kickoff + 24h.
  assert.deepEqual(await strict(db, cutoff), []);
  assert.deepEqual(await training(db, "2026-08-16T17:59:59.000Z"), []);
  const rows = await training(db, cutoff);
  assert.equal(rows.length, 2);
  const home = side(rows, "home");
  assert.deepEqual([home.evaluation_class, home.availability_basis, home.availability_policy], ["retrospective", "retrospective_backfill", POLICY]);
  assert.equal(new Date(home.effective_available_at).toISOString(), "2026-08-16T18:00:00.000Z");
  assert.equal(new Date(home.first_seen_at).toISOString(), SEEN);
  assert.equal(home.observation_id, v1.observation_id);
  assert.deepEqual(await exclusions(db, cutoff), []);
  await db.close();
});

test("a later correction excludes the chain from training until it is actually effective; strict reads are unchanged", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db, { families: { xg: "not_requested" } });
  const v1 = await ingest(db, observationFrom(s.capture()), SEEN);
  const correctedAt = "2026-10-30T12:00:00.000Z";
  const v2 = await ingest(db, observationFrom(s.capture({ score90: [3, 1] })), correctedAt);
  assert.equal(v2.observation_version, 2);

  // Known-superseded v1 is never returned as training truth, and v2 is never backdated.
  for (const cutoff of ["2026-09-10T00:00:00.000Z", "2026-10-30T11:59:59.000Z"]) {
    assert.deepEqual(await training(db, cutoff), [], cutoff);
    const excluded = await exclusions(db, cutoff);
    assert.equal(excluded.length, 1, cutoff);
    assert.deepEqual(
      [excluded[0].exclusion_reason, excluded[0].selected_observation_id, excluded[0].selected_observation_version, excluded[0].latest_observation_id, excluded[0].latest_observation_version, excluded[0].latest_observation_kind],
      ["later_correction", v1.observation_id, 1, v2.observation_id, 2, "observation"],
      cutoff,
    );
    assert.equal(new Date(excluded[0].latest_first_seen_at).toISOString(), correctedAt);
  }
  // Once the correction is actually effective, normal version selection applies.
  const corrected = await training(db, correctedAt);
  assert.deepEqual([side(corrected, "home").observation_id, side(corrected, "home").availability_basis, side(corrected, "home").goals_for_90], [v2.observation_id, "actual", 3]);
  assert.deepEqual(await exclusions(db, correctedAt), []);

  // The strict actual read is unchanged: v1 between first sightings, v2 from its own.
  assert.deepEqual(await strict(db, "2026-09-10T00:00:00.000Z"), []);
  const strictBefore = await strict(db, "2026-10-30T11:00:00.000Z");
  assert.deepEqual([side(strictBefore, "home").observation_id, side(strictBefore, "home").goals_for_90, side(strictBefore, "home").availability_basis], [v1.observation_id, 2, "actual"]);
  assert.equal(side(await strict(db, correctedAt), "home").observation_id, v2.observation_id);
  await db.close();
});

test("a later withdrawal excludes the chain from training; from the withdrawal time the fixture is hidden everywhere", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const v1 = await ingest(db, observationFrom(s.capture()), SEEN);
  const withdrawnAt = "2026-10-30T13:00:00.000Z";
  const withdraw = (at: string) =>
    recordObservation(
      db,
      buildMatchLedgerWithdrawalPayload({
        fixtureId: v1.fixture_id!,
        provider: "sportmonks",
        providerFixtureId: String(17_000_000 + n),
        captureMode: "backfill",
        ingestVersion: "test",
        retrievedAt: at,
        withdrawalReason: "synthetic withdrawal",
      }),
      at,
    );
  await withdraw(withdrawnAt);

  const early = "2026-09-10T00:00:00.000Z";
  assert.deepEqual(await training(db, early), []);
  const excluded = await exclusions(db, early);
  assert.deepEqual([excluded.length, excluded[0].exclusion_reason, excluded[0].latest_observation_version, excluded[0].latest_observation_kind], [1, "later_withdrawal", 2, "withdrawal"]);
  // Strict: v1 between its first sighting and the withdrawal, then hidden.
  assert.equal(side(await strict(db, "2026-10-30T12:00:00.000Z"), "home").observation_id, v1.observation_id);
  assert.deepEqual(await strict(db, withdrawnAt), []);
  assert.deepEqual(await training(db, withdrawnAt), []);
  assert.deepEqual(await exclusions(db, withdrawnAt), []);

  // v1 -> correction v2 -> withdrawal v3: the correction is also superseded until v3.
  const c = await scenario(db);
  await ingest(db, observationFrom(c.capture()), SEEN);
  const cv2 = await ingest(db, observationFrom(c.capture({ score90: [0, 0] })), "2026-10-30T12:00:00.000Z");
  await recordObservation(
    db,
    buildMatchLedgerWithdrawalPayload({
      fixtureId: cv2.fixture_id!,
      provider: "sportmonks",
      providerFixtureId: String(17_000_000 + n),
      captureMode: "backfill",
      ingestVersion: "test",
      retrievedAt: withdrawnAt,
      withdrawalReason: "synthetic withdrawal",
    }),
    "2026-10-30T14:00:00.000Z",
  );
  const between = await exclusions(db, "2026-10-30T13:30:00.000Z", [c.seed.competitionId]);
  assert.deepEqual([between.length, between[0].selected_observation_version, between[0].latest_observation_version, between[0].exclusion_reason], [1, 2, 3, "later_withdrawal"]);
  // The report applies the training read's filters.
  assert.deepEqual(await exclusions(db, "2026-10-30T13:30:00.000Z", ["00000000-0000-4000-8000-000000000000"]), []);
  await db.close();
});

test("only backfill captures are backdated; the policy string is mandatory and exact", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, KICKOFF);
  await recordObservation(
    db,
    buildMatchLedgerObservationPayload({ ...realisticObservation(seed, fixture, { kickoffAt: KICKOFF, retrievedAt: CAPTURED }), captureMode: "scheduled_sync" }),
    SEEN,
  );
  assert.deepEqual(await training(db, "2026-09-10T00:00:00.000Z"), []);
  assert.equal((await training(db, SEEN)).length, 2);

  await assert.rejects(
    db.query("select * from public.match_ledger_team_match_stats_for_training('sportmonks', null, null, now(), 'kapiloto-retrospective-training-availability-v2')"),
    /unsupported availability policy/,
  );
  await assert.rejects(db.query("select * from public.match_ledger_team_match_stats_for_training('sportmonks', null, null, now(), null)"), /unsupported availability policy/);
  await assert.rejects(db.query("select * from private.match_ledger_effective_versions('sportmonks', now(), 'actual', $1)", [POLICY]), /takes no availability policy/);
  await assert.rejects(db.query("select * from private.match_ledger_effective_versions('sportmonks', now(), 'live_simulation', null)"), /unsupported availability mode/);
  await db.close();
});

test("the strict loader refuses retrospective rows, and the registry refuses inputs first seen after the cutoff", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const backfilled = await ingest(db, observationFrom(s.capture()), SEEN);
  const cutoff = "2026-09-10T00:00:00.000Z";
  const retrospective = await training(db, cutoff);
  assert.equal(retrospective.length, 2);

  // Feeding training rows to the strict parser is refused.
  const { parseTeamMatchStatsRows } = await import("./team-match-stats");
  assert.throws(
    () => parseTeamMatchStatsRows(retrospective, { evaluationClass: "actual", availabilityPolicy: null, provider: "sportmonks", cutoff }),
    /unexpected evaluation class/,
  );
  assert.throws(
    () =>
      parseTeamMatchStatsRows(
        retrospective.map((r) => ({ ...r, evaluation_class: "actual", availability_policy: null })),
        { evaluationClass: "actual", availabilityPolicy: null, provider: "sportmonks", cutoff },
      ),
    /not actually known at the cutoff/,
  );

  // A prediction at that cutoff cannot cite the backfilled observation.
  const upcoming = await db.query<{ id: string }>(
    "insert into public.fixtures (competition_id, home_team_id, away_team_id, kickoff_at) values ($1, $2, $3, '2026-09-12T18:00:00Z') returning id",
    [s.seed.competitionId, s.seed.homeTeamId, s.seed.awayTeamId],
  );
  await assert.rejects(
    recordPrediction(
      db,
      basePrediction(upcoming.rows[0].id, {
        researchCutoffAt: cutoff,
        kickoffAtSnapshot: "2026-09-12T18:00:00.000Z",
        generatedAt: "2026-09-10T00:05:00.000Z",
        inputs: { ledger: [{ ledgerObservationId: backfilled.observation_id!, inputRole: "team_form" }] },
      }),
      "2026-09-10T00:05:00.000Z",
    ),
    /first seen after the prediction cutoff/,
  );
  await db.close();
});
