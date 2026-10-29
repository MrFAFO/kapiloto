import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { canonicalJson, sha256Hex } from "./canonical-json";
import { buildLineupForecast, type LineupForecastOutput } from "./lineup-model";
import {
  lineupReplayInput,
  loadLineupSquadInputs,
  parseSquadStateArtifact,
  squadStateArtifact,
  verifySquadStateReconstruction,
} from "./lineup-snapshot";
import { buildPredictionSnapshotV2Payload, type PredictionSnapshotV2Input } from "./prediction-registry";
import type { FixtureSquadState } from "./squad-state";
import { createFixture, realisticObservation, recordObservation } from "./test-support/ledger-fixtures";
import { LINEUP_CUTOFF, LINEUP_POLICY, LINEUP_RECORDED, forecastSnapshot, recordPredictionV2, setupLineupWorld } from "./test-support/lineup-fixtures";
import { SQUAD_STATE_BUILDER_V2_VERSION, SQUAD_STATE_BUILDER_VERSION } from "./versions";

/**
 * Prediction Registry V2 with membership-aware squad features (D-055): V1
 * and V2 lineup forecasts from the same frozen raw inputs, version-label
 * integrity, complete capture and replay after a later identity merge.
 */

type Payload = Record<string, any>;
const V1 = SQUAD_STATE_BUILDER_VERSION;
const V2 = SQUAD_STATE_BUILDER_V2_VERSION;
const v2Payload = (snapshot: PredictionSnapshotV2Input): Payload => buildPredictionSnapshotV2Payload(snapshot) as Payload;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const count = async (db: PGlite, table: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n);
const startKnown = (state: FixtureSquadState, id: string) => state.candidates.find((c) => c.canonical_player_id === id)!.history.starts_last.last_10.available_matches;

test("V1 and V2 lineup forecasts from the same frozen raw inputs both record, each with its exact artifact", async () => {
  const world = await setupLineupWorld();
  const { db, home, signing } = world;
  const v1 = await forecastSnapshot(world, home.teamId, { idempotencyKey: "lineup-v1", builder: V1 });
  const v2 = await forecastSnapshot(world, home.teamId, { idempotencyKey: "lineup-v2", builder: V2 });
  assert.deepEqual(v2.inputs, v1.inputs); // one raw-input contract, two derivations

  // The new signing (membership asserted from Oct 20..28) is absent from the
  // complete Oct 11/18/25 lineups: V1 counts three non-starts, V2 none.
  assert.equal(startKnown(v1.state, signing), 3);
  assert.equal(startKnown(v2.state, signing), 0);
  const raw = (output: LineupForecastOutput) => output.players.find((p) => p.canonical_player_id === signing)!.raw_start_probability_bp;
  assert.deepEqual([raw(v1.output), raw(v2.output)], [2000, 5000]);
  // Every other candidate has rows in every selected match: identical history.
  const differing = v2.state.candidates.filter((c, i) => canonicalJson(c.history) !== canonicalJson(v1.state.candidates[i].history)).map((c) => c.canonical_player_id);
  assert.deepEqual(differing, [signing]);

  const r1 = await recordPredictionV2(db, v1.snapshot, LINEUP_RECORDED);
  const r2 = await recordPredictionV2(db, v2.snapshot, LINEUP_RECORDED);
  assert.deepEqual([r1.status, r2.status], ["recorded", "recorded"]);
  const context = async (id: string) => (await db.query<Payload>(
    "select squad_state_contract, squad_state_builder_version, squad_features_version, squad_state_sha256, squad_state_canonical_json from public.prediction_squad_state_context where snapshot_id = $1",
    [id],
  )).rows[0];
  const c1 = await context(r1.snapshot_id);
  const c2 = await context(r2.snapshot_id);
  assert.deepEqual([c1.squad_state_contract, c1.squad_state_builder_version, c1.squad_features_version], ["kapiloto-squad-state-v1", V1, "kapiloto-squad-features-v1"]);
  assert.deepEqual([c2.squad_state_contract, c2.squad_state_builder_version, c2.squad_features_version], ["kapiloto-squad-state-v1", V2, "kapiloto-squad-features-v2"]);
  assert.equal(c1.squad_state_canonical_json, squadStateArtifact(v1.state).canonicalJson);
  assert.equal(c2.squad_state_canonical_json, squadStateArtifact(v2.state).canonicalJson);
  assert.notEqual(c1.squad_state_sha256, c2.squad_state_sha256);
  // The header freezes the versions too; a V1 header is exactly as before.
  const header = async (id: string) => (await db.query<{ f: Payload }>("select feature_versions as f from public.prediction_snapshots where id = $1", [id])).rows[0].f;
  assert.deepEqual(await header(r1.snapshot_id), { squad_features: "kapiloto-squad-features-v1", history_selection: "kapiloto-history-selection-v1" });
  assert.deepEqual(await header(r2.snapshot_id), { squad_features: "kapiloto-squad-features-v2", squad_state_builder: V2, history_selection: "kapiloto-history-selection-v1" });
  // Complete capture is unchanged: both freeze exactly the same raw links.
  const links = async (id: string) => (await db.query<{ k: string }>(
    `select 'l:' || ledger_observation_id as k from public.prediction_ledger_inputs where snapshot_id = $1
     union all select 'm:' || membership_id from public.prediction_membership_inputs where snapshot_id = $1
     union all select 't:' || tenure_id from public.prediction_tenure_inputs where snapshot_id = $1
     union all select 'c:' || claim_id || ':' || coalesce(resolution_id::text, '') from public.prediction_claim_inputs where snapshot_id = $1
     order by 1`,
    [id],
  )).rows.map((r) => r.k);
  assert.deepEqual(await links(r2.snapshot_id), await links(r1.snapshot_id));
  // Each artifact is reproducible from the frozen raw inputs with its own builder, and only its own.
  assert.ok(verifySquadStateReconstruction(v1.inputs, LINEUP_POLICY, c1.squad_state_sha256, V1));
  assert.ok(verifySquadStateReconstruction(v2.inputs, LINEUP_POLICY, c2.squad_state_sha256, V2));
  assert.equal(verifySquadStateReconstruction(v2.inputs, LINEUP_POLICY, c2.squad_state_sha256, V1), false);
  // Exact replays stay idempotent.
  assert.equal((await recordPredictionV2(db, v1.snapshot, "2026-10-30T12:20:00.000Z")).status, "unchanged");
  assert.equal((await recordPredictionV2(db, v2.snapshot, "2026-10-30T12:20:00.000Z")).status, "unchanged");
  await db.close();
});

test("version labels must match the frozen artifact: relabels, mixed pairs and unknown versions are refused", async () => {
  const world = await setupLineupWorld();
  const { db, home } = world;
  const v1 = await forecastSnapshot(world, home.teamId, { builder: V1 });
  const v2 = await forecastSnapshot(world, home.teamId, { builder: V2 });
  let n = 0;
  const attempt = (base: Payload, mutate: (p: Payload) => void) => {
    n += 1;
    const payload = clone(base);
    payload.idempotency_key = `labels-${n}`;
    mutate(payload);
    return recordPredictionV2(db, payload, LINEUP_RECORDED);
  };
  const label = (p: Payload, builder: string, features: string) => {
    p.inputs.squad_state_context.squad_state_builder_version = builder;
    p.inputs.squad_state_context.squad_features_version = features;
  };
  // Re-hash an edited state consistently in the context and the payload.
  const rewrite = (p: Payload, state: FixtureSquadState, patch: Partial<Record<keyof FixtureSquadState, unknown>>) => {
    const text = canonicalJson({ ...state, ...patch });
    p.inputs.squad_state_context.squad_state_canonical_json = text;
    p.inputs.squad_state_context.squad_state_sha256 = sha256Hex(text);
    p.payload.lineup_estimate.squad_state_sha256 = sha256Hex(text);
  };

  // A V1 artifact relabelled V2 without recomputing it, and the reverse.
  await assert.rejects(attempt(v2Payload(v1.snapshot), (p) => label(p, V2, "kapiloto-squad-features-v2")), /does not describe this snapshot/);
  await assert.rejects(attempt(v2Payload(v2.snapshot), (p) => label(p, V1, "kapiloto-squad-features-v1")), /does not describe this snapshot/);
  // Declared V2 while the canonical state says V1 (and vice versa), consistently re-hashed.
  await assert.rejects(attempt(v2Payload(v2.snapshot), (p) => rewrite(p, v2.state, { builder_version: V1, features_version: "kapiloto-squad-features-v1" })), /does not describe this snapshot/);
  await assert.rejects(attempt(v2Payload(v1.snapshot), (p) => rewrite(p, v1.state, { builder_version: V2, features_version: "kapiloto-squad-features-v2" })), /does not describe this snapshot/);
  // A mixed pair, even when artifact and context agree.
  await assert.rejects(attempt(v2Payload(v2.snapshot), (p) => {
    rewrite(p, v2.state, { features_version: "kapiloto-squad-features-v1" });
    label(p, V2, "kapiloto-squad-features-v1");
  }), /prediction_squad_state_context_builder_features_check/);
  // An unsupported version, even when artifact and context agree.
  await assert.rejects(attempt(v2Payload(v2.snapshot), (p) => {
    rewrite(p, v2.state, { builder_version: "kapiloto-squad-state-builder-v3", features_version: "kapiloto-squad-features-v3" });
    label(p, "kapiloto-squad-state-builder-v3", "kapiloto-squad-features-v3");
  }), /prediction_squad_state_context_builder_(version|features)_check/);
  // Post-cutoff memberships stay invisible to V2 snapshots.
  await assert.rejects(attempt(v2Payload(v2.snapshot), (p) => p.inputs.memberships.push({ membership_id: world.members.homeLate.id, input_role: "squad_membership" })), /first seen after the prediction cutoff/);
  assert.equal(await count(db, "prediction_snapshots"), 0);

  // The database verifies consistency, not derivation: a V1 state whose
  // version fields are rewritten to V2 and consistently re-hashed is
  // indistinguishable to it. Rebuilding from the frozen raw inputs with the
  // declared builder exposes it (the signing's start knowledge differs).
  const forgedState = { ...v1.state, builder_version: V2, features_version: "kapiloto-squad-features-v2" } as FixtureSquadState;
  const forged = await attempt(v2Payload(v1.snapshot), (p) => { rewrite(p, v1.state, { builder_version: V2, features_version: "kapiloto-squad-features-v2" }); label(p, V2, "kapiloto-squad-features-v2"); });
  assert.equal(forged.status, "recorded");
  assert.equal(verifySquadStateReconstruction(v1.inputs, LINEUP_POLICY, squadStateArtifact(forgedState).sha256, V2), false);
  assert.ok(verifySquadStateReconstruction(v2.inputs, LINEUP_POLICY, squadStateArtifact(v2.state).sha256, V2));

  // V2 context rows are as immutable as V1 rows.
  await assert.rejects(db.query("update public.prediction_squad_state_context set squad_state_builder_version = $1", [V1]), /immutable/);
  await db.close();
});

test("V1 and V2 snapshots both replay exactly after a later identity merge", async () => {
  const world = await setupLineupWorld();
  const { db, seed, home } = world;
  // Before the cutoff, bench player 16 appears in one match under a duplicate record M.
  const p16 = home.playerIds[16];
  const m = "63000000-0000-4000-8000-0000000f00bb";
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Bench 16 (second record)')", [m]);
  const fixture = await createFixture(db, seed, "2026-10-27T18:00:00.000Z");
  const observation = realisticObservation(seed, fixture, { kickoffAt: "2026-10-27T18:00:00.000Z", retrievedAt: "2026-10-28T08:59:00.000Z" });
  for (const p of observation.players ?? []) if (p.playerId === p16) p.playerId = m;
  await recordObservation(db, observation, "2026-10-28T09:00:00.000Z");

  const recorded: { builder: typeof V1 | typeof V2; id: string }[] = [];
  for (const builder of [V1, V2] as const) {
    const live = await forecastSnapshot(world, home.teamId, { idempotencyKey: `merge-${builder}`, builder });
    assert.ok(live.output.players.some((p) => p.canonical_player_id === m));
    recorded.push({ builder, id: (await recordPredictionV2(db, live.snapshot, LINEUP_RECORDED)).snapshot_id });
  }
  // M is then discovered to be player 16.
  await db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [m, p16]);
  const today = await loadLineupSquadInputs(world.rpc, { fixtureId: world.target.fixtureId, teamId: home.teamId, cutoff: LINEUP_CUTOFF, policy: LINEUP_POLICY });

  for (const { builder, id } of recorded) {
    const frozen = (await db.query<{ t: string; sha: string; b: string }>(
      "select squad_state_canonical_json as t, squad_state_sha256 as sha, squad_state_builder_version as b from public.prediction_squad_state_context where snapshot_id = $1",
      [id],
    )).rows[0];
    const stored = (await db.query<{ e: LineupForecastOutput }>("select payload->'lineup_estimate' as e from public.prediction_snapshots where id = $1", [id])).rows[0].e;
    assert.equal(frozen.b, builder);
    const state = parseSquadStateArtifact(frozen.t, frozen.sha);
    assert.equal(state.builder_version, builder);
    assert.ok(state.candidates.some((c) => c.canonical_player_id === m), `${builder} artifact keeps M separate`);
    // Today's rebuild (survivor identities) differs on purpose ...
    assert.equal(verifySquadStateReconstruction(today, LINEUP_POLICY, frozen.sha, builder), false);
    // ... while the frozen artifact replays the stored forecast exactly.
    assert.deepEqual(buildLineupForecast(lineupReplayInput(state, frozen.sha, today.history), stored.parameters), stored, builder);
  }
  await db.close();
});
