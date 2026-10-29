import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { recordLineupForecastSnapshot, squadStateSha256, verifySquadStateReconstruction, type PredictionRegistryV2Rpc } from "./lineup-snapshot";
import { buildPredictionSnapshotPayload, buildPredictionSnapshotV2Payload, type PredictionSnapshotV2Input } from "./prediction-registry";
import { buildFixtureSquadState, loadSquadStateInputs } from "./squad-state";
import { basePrediction, recordPrediction } from "./test-support/knowledge-fixtures";
import { setClock } from "./test-support/ledger-fixtures";
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

/**
 * Prediction Registry V2 against the real migration chain: lineup forecasts
 * freeze every 1C input family, are team-scoped, leakage-safe, idempotent
 * and fail closed on direct writes. V1 stays as it was.
 */

type Payload = Record<string, any>;

const v2Payload = (snapshot: PredictionSnapshotV2Input): Payload => buildPredictionSnapshotV2Payload(snapshot) as Payload;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const count = async (db: PGlite, table: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n);

async function homeForecast(world: LineupWorld, idempotencyKey?: string) {
  return forecastSnapshot(world, world.home.teamId, idempotencyKey ? { idempotencyKey } : {});
}

test("a lineup forecast records through the V2 RPC with every 1C input family frozen", async () => {
  const world = await setupLineupWorld();
  const { db, home } = world;
  const { inputs, state, output, snapshot } = await homeForecast(world, "lineup-home-1");
  assert.equal(output.status, "projected");

  const recorded = await recordPredictionV2(db, snapshot, LINEUP_RECORDED);
  assert.equal(recorded.status, "recorded");

  const row = (await db.query<Payload>(
    "select contract_version, prediction_kind, subject_team_id, outcome, p_1_bp, p_x_bp, p_2_bp, payload_schema_version, payload from public.prediction_snapshots where id = $1",
    [recorded.snapshot_id],
  )).rows[0];
  assert.equal(row.contract_version, "kapiloto-prediction-snapshot-v2");
  assert.equal(row.prediction_kind, "lineup_forecast");
  assert.equal(row.subject_team_id, home.teamId);
  assert.equal(row.outcome, "predicted");
  assert.deepEqual([row.p_1_bp, row.p_x_bp, row.p_2_bp], [null, null, null]);
  assert.equal(row.payload_schema_version, "kapiloto-lineup-output-v1");
  assert.equal(row.payload.lineup_estimate.team_start_total_bp, 110000);

  // Ledger: every considered observation with its selection role; never the
  // backfilled one, never the target fixture, never an unrelated match.
  const ledger = await db.query<{ ledger_observation_id: string; input_role: string }>(
    "select ledger_observation_id, input_role from public.prediction_ledger_inputs where snapshot_id = $1 order by ledger_observation_id",
    [recorded.snapshot_id],
  );
  const roleOf = new Map(ledger.rows.map((r) => [r.ledger_observation_id, r.input_role]));
  assert.equal(roleOf.get(world.obs.h1.observation_id), "squad_history_selected");
  assert.equal(roleOf.get(world.obs.h1af.observation_id), "squad_history_alternative");
  assert.equal(roleOf.get(world.obs.h2.observation_id), "squad_history_selected");
  assert.equal(roleOf.get(world.obs.h3.observation_id), "squad_history_selected");
  assert.equal(roleOf.has(world.obs.backfilled.observation_id), false);
  assert.equal(roleOf.has(world.obs.unrelated.observation_id), false);
  assert.equal(ledger.rows.length, inputs.history.length);

  // Memberships and tenures: the subject team's as-of rows only.
  const memberships = await db.query<{ membership_id: string; input_role: string }>(
    "select membership_id, input_role from public.prediction_membership_inputs where snapshot_id = $1 order by membership_id",
    [recorded.snapshot_id],
  );
  assert.deepEqual(memberships.rows.map((r) => r.membership_id), [world.members.homeKeeper.id, world.members.homeSigning.id].sort());
  assert.ok(memberships.rows.every((r) => r.input_role === "squad_membership"));
  const tenures = await db.query<{ tenure_id: string; input_role: string }>(
    "select tenure_id, input_role from public.prediction_tenure_inputs where snapshot_id = $1",
    [recorded.snapshot_id],
  );
  assert.deepEqual(tenures.rows, [{ tenure_id: world.tenures.home, input_role: "squad_coach_tenure" }]);

  // Claims: each with the exact resolution version seen at the cutoff.
  const claims = await db.query<{ claim_id: string; resolution_id: string | null; resolution_status: string; input_role: string }>(
    "select claim_id, resolution_id, resolution_status, input_role from public.prediction_claim_inputs where snapshot_id = $1 order by input_role, claim_id",
    [recorded.snapshot_id],
  );
  const claimRow = (id: string) => claims.rows.find((r) => r.claim_id === id);
  assert.deepEqual(claimRow(world.claims.doubtful.claimId), {
    claim_id: world.claims.doubtful.claimId, resolution_id: world.claims.doubtful.resolutionId, resolution_status: "verified", input_role: "squad_availability_claim",
  });
  assert.equal(claimRow(world.claims.starts.claimId)?.input_role, "squad_lineup_claim");
  assert.equal(claimRow(world.claims.benched.claimId)?.resolution_status, "verified_degraded");
  assert.equal(claimRow(world.claims.away.claimId), undefined);
  assert.equal(claimRow(world.claims.late.claimId), undefined);
  assert.equal(claims.rows.length, inputs.claims.length);

  // Identity bindings: the subject team, every output player, coach candidates.
  const bindings = await db.query<{ entity_type: string; binding_role: string; n: number }>(
    "select entity_type, binding_role, count(*)::int as n from public.prediction_identity_bindings where snapshot_id = $1 group by 1, 2 order by 1, 2",
    [recorded.snapshot_id],
  );
  assert.deepEqual(bindings.rows, [
    { entity_type: "coach", binding_role: "lineup_coach_candidate", n: state.coach.candidate_coach_ids.length },
    { entity_type: "player", binding_role: "lineup_candidate", n: output.players.length },
    { entity_type: "team", binding_role: "lineup_subject_team", n: 1 },
  ]);

  // The reconstruction context and the squad-state hash.
  const context = (await db.query<Payload>("select * from public.prediction_squad_state_context where snapshot_id = $1", [recorded.snapshot_id])).rows[0];
  assert.equal(context.subject_team_id, home.teamId);
  assert.deepEqual(context.provider_priority, ["sportmonks", "api_football"]);
  assert.equal(context.history_max_fixtures, 10);
  assert.equal(context.target_date_policy, "kapiloto-target-date-utc-v1");
  assert.equal(context.squad_state_sha256, squadStateSha256(state));
  assert.equal(context.squad_state_sha256, row.payload.lineup_estimate.squad_state_sha256);

  // The stored bundle hash is the V2 canonical hash of exactly these inputs.
  const sent = v2Payload(snapshot);
  const expected = await db.query<{ v: string }>("select private.prediction_input_bundle_sha256_v2($1::jsonb) as v", [JSON.stringify(sent.inputs)]);
  assert.equal(recorded.input_bundle_sha256, expected.rows[0].v);

  // Reconstruction: the same as-of read later (after late rows arrived)
  // rebuilds the identical state; the frozen links are exactly its inputs.
  const reloaded = await loadSquadStateInputs(world.rpc, { fixtureId: world.target.fixtureId, teamId: home.teamId, cutoff: LINEUP_CUTOFF });
  assert.ok(verifySquadStateReconstruction(reloaded, LINEUP_POLICY, context.squad_state_sha256));
  assert.deepEqual(reloaded.history.map((o) => o.observation_id).sort(), ledger.rows.map((r) => r.ledger_observation_id).sort());
  assert.deepEqual(reloaded.memberships.map((m) => m.membership_id).sort(), memberships.rows.map((r) => r.membership_id));
  assert.deepEqual(reloaded.tenures.map((t) => t.tenure_id), tenures.rows.map((r) => r.tenure_id));
  assert.deepEqual(reloaded.claims.map((c) => [c.resolution_claim_id ?? c.claim_id, c.resolution_id]).sort(), claims.rows.map((r) => [r.claim_id, r.resolution_id]).sort());
  // A different provider priority builds a different state (and hash).
  const reordered = buildFixtureSquadState(reloaded, { ...LINEUP_POLICY, providerPriority: ["api_football", "sportmonks"] });
  assert.notEqual(squadStateSha256(reordered), context.squad_state_sha256);

  // Exact replay.
  const replay = await recordPredictionV2(db, snapshot, "2026-10-30T12:12:00.000Z");
  assert.equal(replay.status, "unchanged");
  assert.equal(replay.snapshot_id, recorded.snapshot_id);

  // One forecast per team: the away team's forecast is its own snapshot,
  // persisted through the TypeScript layer (validate, then the V2 RPC).
  const awayForecast = await forecastSnapshot(world, world.away.teamId, { idempotencyKey: "lineup-away-1" });
  const rpc: PredictionRegistryV2Rpc = async (fn, args) =>
    (await db.query<{ r: unknown }>(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(args.p_snapshot)])).rows[0].r;
  await assert.rejects(recordLineupForecastSnapshot(rpc, { ...awayForecast.snapshot, subjectTeamId: null }), /needs a subject team/);
  await setClock(db, LINEUP_RECORDED);
  const away = await recordLineupForecastSnapshot(rpc, awayForecast.snapshot);
  assert.notEqual(away.snapshot_id, recorded.snapshot_id);
  const awayMemberships = await db.query<{ membership_id: string }>("select membership_id from public.prediction_membership_inputs where snapshot_id = $1", [away.snapshot_id]);
  assert.deepEqual(awayMemberships.rows.map((r) => r.membership_id), [world.members.awayKeeper.id]);
  await db.close();
});
