import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { buildLineupForecastSnapshot } from "./lineup-snapshot";
import { buildMatchLedgerWithdrawalPayload } from "./match-ledger";
import { buildPredictionSnapshotPayload, buildPredictionSnapshotV2Payload, type PredictionSnapshotV2Input } from "./prediction-registry";
import { basePrediction, recordClaim, recordPrediction, recordResolution } from "./test-support/knowledge-fixtures";
import { createFixture, realisticObservation, recordObservation, setClock } from "./test-support/ledger-fixtures";
import {
  LINEUP_CUTOFF,
  LINEUP_KICKOFF,
  LINEUP_POLICY,
  LINEUP_RECORDED,
  forecastSnapshot,
  recordPredictionV2,
  setupLineupWorld,
  type LineupWorld,
} from "./test-support/lineup-fixtures";
import { insertMembership, membershipKey } from "./test-support/roster-fixtures";

/**
 * Prediction Registry V2 guards: contract separation, leakage, team scope,
 * payload/context integrity, idempotency, direct-write bypass and identity
 * merges. Every refused write leaves nothing behind.
 */

type Payload = Record<string, any>;

const v2Payload = (snapshot: PredictionSnapshotV2Input): Payload => buildPredictionSnapshotV2Payload(snapshot) as Payload;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const count = async (db: PGlite, table: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n);

async function homeForecast(world: LineupWorld, idempotencyKey?: string) {
  return forecastSnapshot(world, world.home.teamId, idempotencyKey ? { idempotencyKey } : {});
}

/** Records a mutated copy of `base` under a fresh idempotency key. */
function attempter(db: PGlite, base: Payload, prefix: string) {
  let n = 0;
  return (mutate: (payload: Payload) => void) => {
    n += 1;
    const payload = clone(base);
    payload.idempotency_key = `${prefix}-${n}`;
    mutate(payload);
    return recordPredictionV2(db, payload, LINEUP_RECORDED);
  };
}

async function thirdTeamMembership(world: LineupWorld) {
  const third = await world.db.query<{ team_id: string; player_id: string }>(
    `select r.team_id, p.player_id from public.match_ledger_team_records r
     join public.match_ledger_players p on p.observation_id = r.observation_id and p.team_id = r.team_id
     where r.observation_id = $1 order by p.player_id limit 1`,
    [world.obs.unrelated.observation_id],
  );
  const member = await insertMembership(world.db, { membership_key: membershipKey(), team_id: third.rows[0].team_id, player_id: third.rows[0].player_id }, "2026-09-01T00:00:00.000Z");
  return { teamId: third.rows[0].team_id, membershipId: member.id };
}

test("V1 and V2 contracts stay separate; V2 match outcomes keep the 1/X/2 rule", async () => {
  const world = await setupLineupWorld();
  const { db, home, target } = world;
  const { snapshot } = await homeForecast(world);
  const third = await thirdTeamMembership(world);

  // Each RPC accepts only its own contract, and V1 has no kind/subject fields.
  await assert.rejects(recordPrediction(db, v2Payload(snapshot), LINEUP_RECORDED), /unsupported prediction snapshot contract/);
  const v1 = buildPredictionSnapshotPayload(basePrediction(target.fixtureId)) as Payload;
  await assert.rejects(recordPredictionV2(db, v1, LINEUP_RECORDED), /unsupported prediction snapshot contract/);
  await assert.rejects(recordPrediction(db, { ...v1, prediction_kind: "lineup_forecast" }, LINEUP_RECORDED), /unknown prediction snapshot field/);

  // A V2 match outcome: 1/X/2 required, no subject team, no squad context;
  // memberships of either fixture team may be frozen as context.
  const outcome = (patch: Partial<PredictionSnapshotV2Input> = {}): PredictionSnapshotV2Input => ({
    ...basePrediction(target.fixtureId),
    predictionKind: "match_outcome",
    subjectTeamId: null,
    inputs: {},
    ...patch,
  });
  const recorded = await recordPredictionV2(db, outcome({
    inputs: { memberships: [{ membershipId: world.members.homeKeeper.id, inputRole: "roster_context" }, { membershipId: world.members.awayKeeper.id, inputRole: "roster_context" }] },
  }), LINEUP_RECORDED);
  const row = (await db.query<Payload>("select contract_version, prediction_kind, subject_team_id, p_1_bp from public.prediction_snapshots where id = $1", [recorded.snapshot_id])).rows[0];
  assert.deepEqual(row, { contract_version: "kapiloto-prediction-snapshot-v2", prediction_kind: "match_outcome", subject_team_id: null, p_1_bp: 4600 });
  await assert.rejects(recordPredictionV2(db, outcome({ probabilities: null }), LINEUP_RECORDED), /check constraint/);
  await assert.rejects(recordPredictionV2(db, outcome({ subjectTeamId: home.teamId }), LINEUP_RECORDED), /check constraint/);
  await assert.rejects(recordPredictionV2(db, outcome({ inputs: { squadStateContext: snapshot.inputs.squadStateContext } }), LINEUP_RECORDED), /only lineup forecasts carry a squad-state context/);
  await assert.rejects(
    recordPredictionV2(db, outcome({ inputs: { memberships: [{ membershipId: third.membershipId, inputRole: "roster_context" }] } }), LINEUP_RECORDED),
    /belongs to a team outside the fixture/,
  );

  // Lineup forecasts: a subject team that plays the fixture, no 1/X/2,
  // lineup_estimate when predicted, a squad-state context always.
  const lineup = attempter(db, v2Payload(snapshot), "lineup-bad");
  await assert.rejects(lineup((p) => { p.subject_team_id = null; }), /check constraint/);
  await assert.rejects(lineup((p) => Object.assign(p, { p_1_bp: 4600, p_x_bp: 2800, p_2_bp: 2600 })), /check constraint/);
  await assert.rejects(lineup((p) => { p.payload = {}; }), /check constraint/);
  await assert.rejects(lineup((p) => { p.subject_team_id = third.teamId; }), /does not play fixture/);
  await assert.rejects(lineup((p) => Object.assign(p, { outcome: "abstained", abstain_reason: null })), /check constraint/);
  await assert.rejects(lineup((p) => { p.inputs.squad_state_context = null; }), /has no squad-state context/);
  await assert.rejects(lineup((p) => { p.prediction_kind = "bench_forecast"; }), /check constraint/);
  await assert.rejects(lineup((p) => { delete p.prediction_kind; }), /null value|not-null/);
  await assert.rejects(lineup((p) => { p.inputs.squad_state_context = "frozen"; }), /must be an object or null/);
  assert.equal(await count(db, "prediction_snapshots"), 1);
  await db.close();
});

test("a lineup forecast refuses any input first seen after its cutoff and any post-kickoff cutoff", async () => {
  const world = await setupLineupWorld();
  const { db, home } = world;
  const { snapshot } = await homeForecast(world);
  const base = v2Payload(snapshot);
  const attempt = attempter(db, base, "leak");

  await assert.rejects(attempt((p) => p.inputs.memberships.push({ membership_id: world.members.homeLate.id, input_role: "squad_membership" })), /first seen after the prediction cutoff/);
  await assert.rejects(attempt((p) => p.inputs.tenures.push({ tenure_id: world.tenures.homeLate, input_role: "squad_coach_tenure" })), /first seen after the prediction cutoff/);
  await assert.rejects(attempt((p) => p.inputs.ledger.push({ ledger_observation_id: world.obs.backfilled.observation_id, input_role: "squad_history_alternative" })), /first seen after the prediction cutoff/);
  await assert.rejects(attempt((p) => p.inputs.claims.push({ claim_id: world.claims.late.claimId, resolution_id: world.claims.late.resolutionId, input_role: "squad_availability_claim" })), /or its resolution was first seen after the prediction cutoff/);
  // The belief must be the resolution version seen at the cutoff, not a later one.
  await assert.rejects(attempt((p) => {
    p.inputs.claims.find((c: Payload) => c.claim_id === world.claims.doubtful.claimId).resolution_id = world.lateResolutionId;
  }), /or its resolution was first seen after the prediction cutoff/);

  // A cutoff after kickoff is refused by the as-of read/builder and by the registry.
  await assert.rejects(forecastSnapshot(world, home.teamId, { cutoff: "2026-11-02T18:30:00.000Z" }), /cutoff|kickoff/);
  const late = clone(base);
  Object.assign(late, { idempotency_key: "late-cutoff", research_cutoff_at: "2026-11-02T18:30:00.000Z", generated_at: "2026-11-02T18:30:00.000Z" });
  await assert.rejects(recordPredictionV2(db, late, "2026-11-03T00:00:00.000Z"), /is after the fixture kickoff/);
  assert.equal(await count(db, "prediction_snapshots"), 0);
  await db.close();
});

test("a lineup forecast is scoped to its subject team, the target fixture's claims and prior history", async () => {
  const world = await setupLineupWorld();
  const { db, home, away } = world;
  const { snapshot } = await homeForecast(world);
  const attempt = attempter(db, v2Payload(snapshot), "scope");

  // Opponent rows.
  await assert.rejects(attempt((p) => p.inputs.memberships.push({ membership_id: world.members.awayKeeper.id, input_role: "squad_membership" })), /another team than the subject team/);
  await assert.rejects(attempt((p) => p.inputs.tenures.push({ tenure_id: world.tenures.away, input_role: "squad_coach_tenure" })), /another team than the subject team/);
  await assert.rejects(attempt((p) => p.inputs.claims.push({ claim_id: world.claims.away.claimId, resolution_id: world.claims.away.resolutionId, input_role: "squad_availability_claim" })), /target-fixture claims about the subject team/);
  // A match without the subject team.
  await assert.rejects(attempt((p) => p.inputs.ledger.push({ ledger_observation_id: world.obs.unrelated.observation_id, input_role: "squad_history_alternative" })), /does not involve the subject team/);
  // A claim about another fixture.
  const otherFixtureClaim = await recordClaim(db, {
    claimKind: "reported_expectation", claimType: "player_availability", predicate: "availability_status",
    fixtureId: world.fixtures.h1.fixtureId, teamId: home.teamId, playerId: home.playerIds[1],
    objectValue: { status: "out" }, temporalScope: "fixture",
  }, "2026-10-20T09:00:00.000Z");
  await assert.rejects(attempt((p) => p.inputs.claims.push({ claim_id: otherFixtureClaim.claim_id, resolution_id: null, input_role: "squad_availability_claim" })), /target-fixture claims about the subject team/);
  // Squad roles are mandatory and typed.
  await assert.rejects(attempt((p) => { p.inputs.memberships[0].input_role = "roster"; }), /use role squad_membership/);
  await assert.rejects(attempt((p) => { p.inputs.tenures[0].input_role = "coach"; }), /use role squad_coach_tenure/);
  await assert.rejects(attempt((p) => { p.inputs.ledger[0].input_role = "history"; }), /squad_history_selected or squad_history_alternative/);
  await assert.rejects(attempt((p) => {
    p.inputs.claims.find((c: Payload) => c.claim_id === world.claims.doubtful.claimId).input_role = "squad_lineup_claim";
  }), /by claim type/);
  // The context must describe this team with a well-formed provider priority.
  await assert.rejects(attempt((p) => { p.inputs.squad_state_context.subject_team_id = away.teamId; }), /context team does not match/);
  await assert.rejects(attempt((p) => { p.inputs.squad_state_context.provider_priority = ["sportmonks", "sportmonks"]; }), /distinct provider keys/);
  await assert.rejects(attempt((p) => { p.inputs.squad_state_context.squad_state_contract = "kapiloto-squad-state-v2"; }), /check constraint/);
  await assert.rejects(attempt((p) => { p.inputs.squad_state_context.surprise = 1; }), /unknown squad-state context field: surprise/);
  await assert.rejects(attempt((p) => { p.inputs.memberships[0].surprise = 1; }), /unknown membership input field: surprise/);

  // The target fixture's own ledger data (e.g. a pre-kickoff lineup capture)
  // is never squad history.
  const lineupCapture = realisticObservation(world.seed, world.target, { kickoffAt: LINEUP_KICKOFF, retrievedAt: "2026-10-29T08:59:00.000Z" });
  Object.assign(lineupCapture, { matchStatus: "upcoming", homeGoals90: null, awayGoals90: null, substitutions: [], events: [], teamStats: [] });
  for (const team of lineupCapture.teams) Object.assign(team, { substitutionsStatus: "not_provided", eventsStatus: "not_provided", statisticsStatus: "not_provided" });
  for (const p of lineupCapture.players ?? []) Object.assign(p, { appeared: null, minutesPlayed: null, enteredMinute: null, exitedMinute: null });
  const targetObservation = await recordObservation(db, lineupCapture, "2026-10-29T09:00:00.000Z");
  await assert.rejects(attempt((p) => p.inputs.ledger.push({ ledger_observation_id: targetObservation.observation_id, input_role: "squad_history_alternative" })), /target fixture's own ledger data/);
  assert.equal(await count(db, "prediction_snapshots"), 0);
  await db.close();
});

test("the lineup payload must match its frozen squad-state context, fixture, team and identity bindings", async () => {
  const world = await setupLineupWorld();
  const { db } = world;
  const { snapshot, state, output, inputs } = await homeForecast(world);
  const attempt = attempter(db, v2Payload(snapshot), "integrity");
  const otherHash = "f".repeat(64);

  await assert.rejects(attempt((p) => { p.payload.lineup_estimate.squad_state_sha256 = otherHash; }), /hash does not match its frozen context/);
  await assert.rejects(attempt((p) => { p.inputs.squad_state_context.squad_state_sha256 = otherHash; }), /hash does not match its frozen context/);
  await assert.rejects(attempt((p) => { p.payload.lineup_estimate.subject_team_id = world.away.teamId; }), /subject team does not match/);
  await assert.rejects(attempt((p) => { p.payload.lineup_estimate.fixture_id = world.fixtures.h1.fixtureId; }), /fixture does not match/);
  await assert.rejects(attempt((p) => { p.payload.lineup_estimate.status = "insufficient_candidates"; }), /must carry a projected lineup estimate/);
  await assert.rejects(attempt((p) => { p.payload.lineup_estimate.players = {}; }), /players must be an array/);
  await assert.rejects(attempt((p) => {
    const dropped = p.payload.lineup_estimate.players[0].canonical_player_id;
    p.inputs.identities = p.inputs.identities.filter((b: Payload) => b.entity_id !== dropped);
  }), /has no identity binding/);
  await assert.rejects(attempt((p) => { p.payload.lineup_estimate.players.push({ canonical_player_id: null }); }), /\(missing id\) has no identity binding/);
  // An abstention that keeps its estimate is held to the same checks.
  await assert.rejects(attempt((p) => {
    Object.assign(p, { outcome: "abstained", abstain_reason: "manual_hold" });
    p.payload.lineup_estimate.squad_state_sha256 = otherHash;
  }), /hash does not match its frozen context/);
  assert.equal(await count(db, "prediction_snapshots"), 0);
  const held = await attempt((p) => Object.assign(p, { outcome: "abstained", abstain_reason: "manual_hold" }));
  assert.equal(held.status, "recorded");

  // The TypeScript layer refuses to pair an output with a different state.
  assert.throws(() => buildLineupForecastSnapshot({
    inputs, state, policy: LINEUP_POLICY, output: { ...output, squad_state_sha256: otherHash },
    meta: { idempotencyKey: "x", purpose: "shadow", predictionProtocolVersion: "p", pipelineVersion: "p", codeRevision: "abcdef0", generatedAt: "2026-10-30T12:05:00.000Z" },
  }), /not computed from this squad state/);
  await db.close();
});

test("an exact replay is unchanged; any material difference under the same key is refused", async () => {
  const world = await setupLineupWorld();
  const { db } = world;
  const { snapshot } = await homeForecast(world, "lineup-idempotent");
  const base = v2Payload(snapshot);
  const first = await recordPredictionV2(db, base, LINEUP_RECORDED);
  assert.equal(first.status, "recorded");
  const replay = await recordPredictionV2(db, clone(base), "2026-10-30T12:20:00.000Z");
  assert.equal(replay.status, "unchanged");
  assert.deepEqual({ ...replay, status: "recorded" }, first);

  const changes: [string, (p: Payload) => void][] = [
    ["parameter version", (p) => { p.model_identifiers.lineup_parameters = "kapiloto-lineup-parameters-v2"; }],
    ["subject team", (p) => { p.subject_team_id = world.away.teamId; }],
    ["prediction kind", (p) => { p.prediction_kind = "match_outcome"; }],
    ["provider priority", (p) => { p.inputs.squad_state_context.provider_priority = ["api_football", "sportmonks"]; }],
    ["history window", (p) => { p.inputs.squad_state_context.history_max_fixtures = 5; }],
    ["membership set", (p) => { p.inputs.memberships.pop(); }],
    ["tenure set", (p) => { p.inputs.tenures = []; }],
    ["considered ledger set", (p) => { p.inputs.ledger = p.inputs.ledger.filter((l: Payload) => l.input_role !== "squad_history_alternative"); }],
    ["claim resolution", (p) => { p.inputs.claims[0].resolution_id = null; }],
    ["claim set", (p) => { p.inputs.claims.pop(); }],
    ["squad-state hash", (p) => { p.inputs.squad_state_context.squad_state_sha256 = "e".repeat(64); p.payload.lineup_estimate.squad_state_sha256 = "e".repeat(64); }],
    ["lineup payload", (p) => { p.payload.lineup_estimate.players[0].expected_regulation_minutes_tenths += 1; }],
    ["identity bindings", (p) => { p.inputs.identities.pop(); }],
  ];
  for (const [label, mutate] of changes) {
    const payload = clone(base);
    mutate(payload);
    await assert.rejects(recordPredictionV2(db, payload, LINEUP_RECORDED), /already used for a different snapshot/, label);
  }
  assert.equal(await count(db, "prediction_snapshots"), 1);
  await db.close();
});

test("direct writes cannot bypass the V2 RPC, and frozen V2 links are immutable", async () => {
  const world = await setupLineupWorld();
  const { db, home } = world;
  const { snapshot } = await homeForecast(world);
  const recorded = await recordPredictionV2(db, snapshot, LINEUP_RECORDED);
  const sid = recorded.snapshot_id;

  // Links cannot be added to a sealed snapshot ...
  await assert.rejects(db.query("insert into public.prediction_membership_inputs (snapshot_id, membership_id, input_role, input_first_seen_at) values ($1, $2, 'squad_membership', now())", [sid, world.members.homeLate.id]), /is sealed/);
  await assert.rejects(db.query("insert into public.prediction_tenure_inputs (snapshot_id, tenure_id, input_role, input_first_seen_at) values ($1, $2, 'squad_coach_tenure', now())", [sid, world.tenures.homeLate]), /is sealed/);
  // ... nor changed or removed.
  for (const table of ["prediction_membership_inputs", "prediction_tenure_inputs", "prediction_squad_state_context"]) {
    await assert.rejects(db.query(`update public.${table} set snapshot_id = snapshot_id where snapshot_id = $1`, [sid]), /immutable/, table);
    await assert.rejects(db.query(`delete from public.${table} where snapshot_id = $1`, [sid]), /immutable/, table);
    await assert.rejects(db.query(`truncate public.${table}`), /immutable/, table);
  }
  await assert.rejects(db.query("update public.prediction_snapshots set subject_team_id = $2 where id = $1", [sid, world.away.teamId]), /immutable/);

  // A single-statement direct write (snapshot and links in one statement, so
  // not "sealed") is still verified when the transaction commits.
  await setClock(db, LINEUP_RECORDED);
  const insertSnapshot = (key: string, hash: string, contract = "kapiloto-prediction-snapshot-v2") => `
    insert into public.prediction_snapshots
      (contract_version, idempotency_key, fixture_id, prediction_kind, subject_team_id, purpose, prediction_protocol_version,
       pipeline_version, code_revision, research_cutoff_at, kickoff_at_snapshot, generated_at, outcome, abstain_reason,
       payload_schema_version, input_bundle_sha256, output_bundle_sha256)
    values ('${contract}', '${key}', '${world.target.fixtureId}', 'lineup_forecast', '${home.teamId}', 'shadow', 'p', 'p', 'abcdef0',
       '${LINEUP_CUTOFF}', '${LINEUP_KICKOFF}', '${LINEUP_CUTOFF}', 'abstained', 'x', 'v1', '${hash}', '${hash}')
    returning id`;
  await assert.rejects(db.query(insertSnapshot("direct-no-context", "c".repeat(64))), /has no squad-state context/);
  await assert.rejects(db.query(insertSnapshot("direct-v1-lineup", "c".repeat(64), "kapiloto-prediction-snapshot-v1")), /check constraint/);
  const context = v2Payload(snapshot).inputs.squad_state_context;
  await assert.rejects(
    db.query(`
      with s as (${insertSnapshot("direct-forged-hash", "c".repeat(64))})
      insert into public.prediction_squad_state_context
        (snapshot_id, subject_team_id, squad_state_inputs_contract, squad_state_contract, squad_state_builder_version,
         squad_features_version, history_selection_policy_version, availability_normalization_version, target_date_policy,
         provider_priority, history_max_fixtures, squad_state_sha256)
      select s.id, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11 from s`,
      [home.teamId, context.squad_state_inputs_contract, context.squad_state_contract, context.squad_state_builder_version,
        context.squad_features_version, context.history_selection_policy_version, context.availability_normalization_version,
        context.target_date_policy, context.provider_priority, context.history_max_fixtures, context.squad_state_sha256],
    ),
    /do not match its input bundle hash/,
  );
  // V2 link tables refuse rows for V1 snapshots, even in the same statement.
  await assert.rejects(
    db.query(`
      with s as (
        insert into public.prediction_snapshots
          (contract_version, idempotency_key, fixture_id, purpose, prediction_protocol_version, pipeline_version, code_revision,
           research_cutoff_at, kickoff_at_snapshot, generated_at, outcome, abstain_reason, payload_schema_version,
           input_bundle_sha256, output_bundle_sha256)
        values ('kapiloto-prediction-snapshot-v1', 'direct-v1-membership', $1, 'shadow', 'p', 'p', 'abcdef0', $2, $3, $2,
          'abstained', 'x', 'v1', $4, $4)
        returning id)
      insert into public.prediction_membership_inputs (snapshot_id, membership_id, input_role, input_first_seen_at)
      select s.id, $5, 'squad_membership', now() from s`,
      [world.target.fixtureId, LINEUP_CUTOFF, LINEUP_KICKOFF, "c".repeat(64), world.members.homeKeeper.id],
    ),
    /V2 snapshots only/,
  );
  assert.equal(await count(db, "prediction_snapshots"), 1);
  await db.close();
});

test("identity merges: a lineup forecast binds active canonical ids; history keeps what the model saw", async () => {
  const world = await setupLineupWorld();
  const { db, seed, home } = world;
  // Before the cutoff, bench player 16 appears in one match under a second
  // record M (a duplicate not yet discovered).
  const p16 = home.playerIds[16];
  const m = "63000000-0000-4000-8000-0000000f00aa";
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Bench 16 (second record)')", [m]);
  const fixture = await createFixture(db, seed, "2026-10-27T18:00:00.000Z");
  const observation = realisticObservation(seed, fixture, { kickoffAt: "2026-10-27T18:00:00.000Z", retrievedAt: "2026-10-28T08:59:00.000Z" });
  for (const p of observation.players ?? []) if (p.playerId === p16) p.playerId = m;
  await recordObservation(db, observation, "2026-10-28T09:00:00.000Z");

  // The live forecast treats M and player 16 as two candidates.
  const live = await homeForecast(world, "lineup-pre-merge");
  const liveIds = live.output.players.map((p) => p.canonical_player_id);
  assert.ok(liveIds.includes(m) && liveIds.includes(p16));
  const liveRecorded = await recordPredictionV2(db, live.snapshot, LINEUP_RECORDED);

  // M is then discovered to be player 16.
  await db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [m, p16]);

  // The registry still proves the live model kept them apart, and the exact
  // live write still replays as unchanged.
  const frozen = await db.query<{ player_id: string }>(
    "select player_id from public.prediction_identity_bindings where snapshot_id = $1 and player_id = any($2) order by player_id",
    [liveRecorded.snapshot_id, [m, p16]],
  );
  assert.deepEqual(frozen.rows.map((r) => r.player_id), [m, p16].sort());
  assert.equal((await recordPredictionV2(db, live.snapshot, "2026-11-05T00:00:00.000Z")).status, "unchanged");

  // A re-run binds only the survivor, keeping M as the observed raw id, and
  // derives a different squad state.
  const rerun = await forecastSnapshot(world, home.teamId, { idempotencyKey: "lineup-post-merge", purpose: "backtest" });
  const survivor = rerun.output.players.find((p) => p.canonical_player_id === p16)!;
  assert.ok(survivor.observed_player_ids.includes(m));
  assert.equal(rerun.output.players.some((p) => p.canonical_player_id === m), false);
  assert.notEqual(rerun.output.squad_state_sha256, live.output.squad_state_sha256);
  const rerunRecorded = await recordPredictionV2(db, rerun.snapshot, "2026-11-05T00:00:00.000Z");
  const rebound = await db.query<{ player_id: string; observed_player_id: string | null }>(
    "select player_id, observed_player_id from public.prediction_identity_bindings where snapshot_id = $1 and player_id = $2",
    [rerunRecorded.snapshot_id, p16],
  );
  assert.deepEqual(rebound.rows, [{ player_id: p16, observed_player_id: m }]);

  // Binding the merged id is refused.
  const forged = v2Payload(rerun.snapshot);
  forged.idempotency_key = "lineup-merged-binding";
  forged.inputs.identities.push({ entity_type: "player", entity_id: m, observed_entity_id: null, binding_role: "lineup_candidate", context_team_id: home.teamId, provider: null, provider_entity_id: null });
  await assert.rejects(recordPredictionV2(db, forged, "2026-11-05T00:00:00.000Z"), /bind the surviving id the prediction used/);
  await db.close();
});

test("squad history must be what the as-of read could return: no superseded versions, withdrawals or upcoming matches", async () => {
  const world = await setupLineupWorld();
  const { db, seed } = world;
  // A forecast built before the corrections below.
  const { snapshot: stale } = await homeForecast(world, "lineup-stale");

  // Before the cutoff: H1 (sportmonks) is corrected to version 2 and H1
  // (api_football) is withdrawn.
  const corrected = realisticObservation(seed, world.fixtures.h1, { kickoffAt: "2026-10-25T18:00:00.000Z", retrievedAt: "2026-10-27T08:59:00.000Z", homeGoals: 3 });
  const h1v2 = await recordObservation(db, corrected, "2026-10-27T09:00:00.000Z");
  assert.equal(h1v2.observation_version, 2);
  const withdrawal = await recordObservation(db, buildMatchLedgerWithdrawalPayload({
    fixtureId: world.fixtures.h1.fixtureId,
    provider: "api_football",
    providerFixtureId: "af-h1",
    captureMode: "manual_import",
    ingestVersion: "test",
    retrievedAt: "2026-10-27T10:00:00.000Z",
    withdrawalReason: "attached to the wrong fixture",
  }) as unknown as Record<string, unknown>, "2026-10-27T10:00:00.000Z");

  // The stale forecast links H1 v1 and the withdrawn api_football version.
  await assert.rejects(recordPredictionV2(db, stale, LINEUP_RECORDED), /superseded before the prediction cutoff/);
  const attempt = attempter(db, v2Payload(stale), "as-of");
  await assert.rejects(attempt((p) => {
    p.inputs.ledger = p.inputs.ledger.filter((l: Payload) => l.ledger_observation_id !== world.obs.h1.observation_id && l.ledger_observation_id !== world.obs.h1af.observation_id);
    p.inputs.ledger.push({ ledger_observation_id: withdrawal.observation_id, input_role: "squad_history_alternative" });
  }), /not a finished match observation/);
  // A pre-kickoff capture of an upcoming match is not history either.
  const upcomingFixture = await createFixture(db, seed, "2026-11-09T18:00:00.000Z");
  const upcoming = realisticObservation(seed, upcomingFixture, { kickoffAt: "2026-11-09T18:00:00.000Z", retrievedAt: "2026-10-29T08:59:00.000Z" });
  Object.assign(upcoming, { matchStatus: "upcoming", homeGoals90: null, awayGoals90: null, substitutions: [], events: [], teamStats: [] });
  for (const team of upcoming.teams) Object.assign(team, { substitutionsStatus: "not_provided", eventsStatus: "not_provided", statisticsStatus: "not_provided" });
  for (const p of upcoming.players ?? []) Object.assign(p, { appeared: null, minutesPlayed: null, enteredMinute: null, exitedMinute: null });
  const upcomingObservation = await recordObservation(db, upcoming, "2026-10-29T09:00:00.000Z");
  await assert.rejects(attempt((p) => {
    p.inputs.ledger = p.inputs.ledger.filter((l: Payload) => l.ledger_observation_id !== world.obs.h1.observation_id && l.ledger_observation_id !== world.obs.h1af.observation_id);
    p.inputs.ledger.push({ ledger_observation_id: upcomingObservation.observation_id, input_role: "squad_history_alternative" });
  }), /not a finished match observation/);
  assert.equal(await count(db, "prediction_snapshots"), 0);

  // A fresh forecast reads version 2 and no longer sees the withdrawn version.
  const fresh = await homeForecast(world, "lineup-fresh");
  const ledgerIds = fresh.snapshot.inputs.ledger!.map((l) => l.ledgerObservationId);
  assert.ok(ledgerIds.includes(h1v2.observation_id));
  assert.equal(ledgerIds.includes(world.obs.h1.observation_id), false);
  assert.equal(ledgerIds.includes(world.obs.h1af.observation_id), false);
  assert.equal((await recordPredictionV2(db, fresh.snapshot, LINEUP_RECORDED)).status, "recorded");
  await db.close();
});

test("memberships, tenures and claim beliefs must be the versions the as-of read returns", async () => {
  const world = await setupLineupWorld();
  const { db, home } = world;
  const { snapshot: stale } = await homeForecast(world, "lineup-stale-versions");
  const staleClaims = v2Payload(stale).inputs.claims as Payload[];

  // Before the cutoff: the keeper's membership is corrected, the signing is
  // retracted, the coach tenure is corrected and the "starts" belief is
  // re-adjudicated.
  const keys = await db.query<{ id: string; membership_key: string }>("select id, membership_key from public.team_player_memberships where id = any($1)", [[world.members.homeKeeper.id, world.members.homeSigning.id]]);
  const keyOf = (id: string) => keys.rows.find((r) => r.id === id)!.membership_key;
  const keeperV2 = await insertMembership(db, { membership_key: keyOf(world.members.homeKeeper.id), team_id: home.teamId, player_id: home.playerIds[0], shirt_number: 99 }, "2026-10-29T10:00:00.000Z");
  const signingRetraction = await insertMembership(db, {
    membership_key: keyOf(world.members.homeSigning.id), team_id: home.teamId, player_id: world.signing,
    starts_on_earliest: "2026-10-20", starts_on_latest: "2026-10-28", assertion_status: "retracted",
  }, "2026-10-29T10:00:00.000Z");
  await setClock(db, "2026-10-29T10:00:00.000Z");
  const tenureV2 = await db.query<{ id: string }>(
    `insert into public.team_coach_tenures (tenure_key, team_id, coach_id, starts_on_earliest, starts_on_latest, source_kind, ingest_version)
     select tenure_key, team_id, coach_id, '2026-06-30', '2026-06-30', source_kind, 'test-v2' from public.team_coach_tenures where id = $1
     returning id`,
    [world.tenures.home],
  );

  const startsV2 = await recordResolution(db, {
    claimId: world.claims.starts.claimId, status: "verified", resolverKind: "grounding", resolverVersion: "g1b",
    reasonCode: "second_source", evidence: [{ evidenceRole: "supporting", claimObservationId: world.claims.starts.observationId }],
  }, "2026-10-29T12:00:00.000Z");

  const attempt = attempter(db, v2Payload(stale), "versions");
  await assert.rejects(attempt(() => undefined), /superseded before the prediction cutoff/);
  // Each stale family on its own (the others replaced with current versions).
  const current = (p: Payload) => {
    p.inputs.memberships = [{ membership_id: keeperV2.id, input_role: "squad_membership" }];
    p.inputs.tenures = [{ tenure_id: tenureV2.rows[0].id, input_role: "squad_coach_tenure" }];
    p.inputs.claims = staleClaims.map((c) => (c.claim_id === world.claims.starts.claimId ? { ...c, resolution_id: startsV2.resolution_id } : c));
  };
  await assert.rejects(attempt((p) => { current(p); p.inputs.memberships.push({ membership_id: world.members.homeKeeper.id, input_role: "squad_membership" }); }), /prediction_membership_inputs input was superseded/);
  await assert.rejects(attempt((p) => { current(p); p.inputs.memberships.push({ membership_id: signingRetraction.id, input_role: "squad_membership" }); }), /retracted assertion/);
  await assert.rejects(attempt((p) => { current(p); p.inputs.tenures = [{ tenure_id: world.tenures.home, input_role: "squad_coach_tenure" }]; }), /prediction_tenure_inputs input was superseded/);
  await assert.rejects(attempt((p) => { current(p); p.inputs.claims = staleClaims; }), /resolution was superseded before the prediction cutoff/);
  await assert.rejects(attempt((p) => {
    current(p);
    p.inputs.claims = p.inputs.claims.map((c: Payload) => (c.claim_id === world.claims.starts.claimId ? { ...c, resolution_id: null } : c));
  }), /was resolved before the prediction cutoff/);
  assert.equal(await count(db, "prediction_snapshots"), 0);

  // A fresh forecast reads exactly the current versions and records.
  const fresh = await homeForecast(world, "lineup-current-versions");
  assert.deepEqual(fresh.snapshot.inputs.memberships!.map((m) => m.membershipId), [keeperV2.id]);
  assert.deepEqual(fresh.snapshot.inputs.tenures!.map((t) => t.tenureId), [tenureV2.rows[0].id]);
  assert.equal(fresh.snapshot.inputs.claims!.find((c) => c.claimId === world.claims.starts.claimId)?.resolutionId, startsV2.resolution_id);
  assert.equal((await recordPredictionV2(db, fresh.snapshot, LINEUP_RECORDED)).status, "recorded");
  await db.close();
});
