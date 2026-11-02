import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { buildLineupForecast, type LineupForecastOutput } from "./lineup-model";
import {
  lineupReplayInput,
  parseSquadStateArtifact,
  recordLineupForecastSnapshot,
  verifySquadStateReconstruction,
  type PredictionRegistryV2Rpc,
} from "./lineup-snapshot";
import { buildPredictionSnapshotV2Payload, type PredictionSnapshotV2Input } from "./prediction-registry";
import { revokeTeam } from "./test-support/attestation-fixtures";
import { setClock } from "./test-support/ledger-fixtures";
import {
  LINEUP_POLICY,
  LINEUP_RECORDED,
  forecastSnapshot,
  loadForecastInputs,
  recordPredictionV2,
  setupAttestedLineupWorld,
  setupReadV1LineupWorld,
} from "./test-support/lineup-fixtures";
import { SQUAD_STATE_READ_V1_VERSION, SQUAD_STATE_READ_V2_VERSION } from "./versions";

/**
 * Lineup forecasts on the trusted production path
 * (kapiloto-squad-state-read-v2) and the registry's read-version binding:
 * the context freezes which squad-state read assembled the inputs, the
 * bundle hash commits to it (read-v1 implicit, so frozen hashes never move),
 * and the deferred check re-runs exactly that read.
 */

type Payload = Record<string, any>;
const v2Payload = (snapshot: PredictionSnapshotV2Input): Payload => buildPredictionSnapshotV2Payload(snapshot) as Payload;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const count = async (db: PGlite, table: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n);
const bundleSha = async (db: PGlite, inputs: unknown) =>
  (await db.query<{ v: string }>("select private.prediction_input_bundle_sha256_v2($1::jsonb) as v", [JSON.stringify(inputs)])).rows[0].v;
const sorted = (ids: (string | null | undefined)[]) => [...ids].map(String).sort();

test("an end-to-end lineup forecast records through the trusted read-v2 path", async () => {
  const world = await setupAttestedLineupWorld();
  const { db, home, obs } = world;
  const { inputs, state, output, snapshot } = await forecastSnapshot(world, home.teamId, { idempotencyKey: "read-v2-home" });

  // The read: exactly the trusted Sportmonks history, never the plain 1A
  // fixture, the API-Football alternative, the backfilled or the away match.
  assert.equal(inputs.read_version, SQUAD_STATE_READ_V2_VERSION);
  assert.deepEqual(sorted(inputs.history.map((h) => h.observation_id)), sorted([obs.t1.observation_id, obs.t2.observation_id, obs.t3.observation_id]));
  assert.equal(output.status, "projected");
  assert.equal(state.provenance.ledger_observation_ids.length, 3);
  assert.equal(snapshot.inputs.squadStateContext?.squadStateReadVersion, SQUAD_STATE_READ_V2_VERSION);

  // Persisted through the TypeScript layer (validate, then the V2 RPC).
  const rpc: PredictionRegistryV2Rpc = async (fn, args) =>
    (await db.query<{ r: unknown }>(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(args.p_snapshot)])).rows[0].r;
  await setClock(db, LINEUP_RECORDED);
  const recorded = await recordLineupForecastSnapshot(rpc, snapshot);
  assert.equal(recorded.status, "recorded");

  const ledger = await db.query<{ ledger_observation_id: string; input_role: string }>(
    "select ledger_observation_id, input_role from public.prediction_ledger_inputs where snapshot_id = $1",
    [recorded.snapshot_id],
  );
  assert.deepEqual(sorted(ledger.rows.map((r) => r.ledger_observation_id)), sorted([obs.t1.observation_id, obs.t2.observation_id, obs.t3.observation_id]));
  assert.ok(ledger.rows.every((r) => r.input_role === "squad_history_selected"));
  const context = (await db.query<Payload>("select * from public.prediction_squad_state_context where snapshot_id = $1", [recorded.snapshot_id])).rows[0];
  assert.equal(context.squad_state_read_version, SQUAD_STATE_READ_V2_VERSION);
  assert.equal(context.squad_state_inputs_contract, "kapiloto-squad-state-inputs-v1");
  assert.deepEqual(
    sorted((await db.query<{ membership_id: string }>("select membership_id from public.prediction_membership_inputs where snapshot_id = $1", [recorded.snapshot_id])).rows.map((r) => r.membership_id)),
    sorted([world.members.homeKeeper.id, world.members.homeSigning.id]),
  );
  assert.deepEqual(
    (await db.query<{ tenure_id: string }>("select tenure_id from public.prediction_tenure_inputs where snapshot_id = $1", [recorded.snapshot_id])).rows.map((r) => r.tenure_id),
    [world.tenures.home],
  );

  // The stored hash is the canonical hash of the sent inputs, and it commits
  // to the read: the same links declared read-v1 hash differently.
  const sent = v2Payload(snapshot);
  assert.equal(recorded.input_bundle_sha256, await bundleSha(db, sent.inputs));
  const asV1 = clone(sent.inputs);
  asV1.squad_state_context.squad_state_read_version = SQUAD_STATE_READ_V1_VERSION;
  assert.notEqual(await bundleSha(db, asV1), recorded.input_bundle_sha256);

  // Reconstruction through the same read rebuilds the frozen state; exact replay is unchanged.
  const reloaded = await loadForecastInputs(world, home.teamId);
  assert.ok(verifySquadStateReconstruction(reloaded, LINEUP_POLICY, context.squad_state_sha256));
  assert.equal((await recordPredictionV2(db, snapshot, "2026-10-30T12:12:00.000Z")).status, "unchanged");

  // The away team's forecast reads its own trusted history only.
  const awayForecast = await forecastSnapshot(world, world.away.teamId, { idempotencyKey: "read-v2-away" });
  assert.deepEqual(awayForecast.inputs.history.map((h) => h.observation_id), [obs.away.observation_id]);
  assert.equal((await recordPredictionV2(db, awayForecast.snapshot, LINEUP_RECORDED)).status, "recorded");
  await db.close();
});

test("the registry re-runs exactly the declared read: relabelled reads and untrusted inputs are refused", async () => {
  const world = await setupAttestedLineupWorld();
  const { db, home, obs } = world;
  const trusted = await forecastSnapshot(world, home.teamId);
  // The frozen V1 read over the same world also sees the untrusted rows.
  const legacy = await forecastSnapshot(world, home.teamId, { read: SQUAD_STATE_READ_V1_VERSION });
  assert.equal(legacy.inputs.read_version, undefined);
  assert.ok(legacy.inputs.history.some((h) => h.observation_id === obs.plain.observation_id));
  assert.ok(legacy.inputs.history.some((h) => h.observation_id === obs.af.observation_id));
  assert.equal(legacy.snapshot.inputs.squadStateContext?.squadStateReadVersion, SQUAD_STATE_READ_V1_VERSION);

  let n = 0;
  const attempt = (base: Payload, mutate: (p: Payload) => void) => {
    n += 1;
    const payload = clone(base);
    payload.idempotency_key = `read-binding-${n}`;
    mutate(payload);
    return recordPredictionV2(db, payload, LINEUP_RECORDED);
  };
  const relabel = (read: unknown) => (p: Payload) => { p.inputs.squad_state_context.squad_state_read_version = read; };

  // Trusted links declared read-v1: the V1 read returns more (plain + AF).
  await assert.rejects(attempt(v2Payload(trusted.snapshot), relabel(SQUAD_STATE_READ_V1_VERSION)), /does not freeze exactly the squad history/);
  // V1 links (with untrusted rows) declared read-v2: the V2 read returns less.
  await assert.rejects(attempt(v2Payload(legacy.snapshot), relabel(SQUAD_STATE_READ_V2_VERSION)), /does not freeze exactly the squad history/);
  // A read-v2 forecast that freezes an untrusted observation.
  await assert.rejects(attempt(v2Payload(trusted.snapshot), (p) => {
    p.inputs.ledger.push({ ledger_observation_id: obs.plain.observation_id, input_role: "squad_history_alternative" });
  }), /does not freeze exactly the squad history/);
  // Unknown or malformed read versions never fall back to read-v1.
  await assert.rejects(attempt(v2Payload(trusted.snapshot), relabel("kapiloto-squad-state-read-v3")), /unsupported squad-state read version/);
  await assert.rejects(attempt(v2Payload(trusted.snapshot), relabel(null)), /unsupported squad-state read version/);
  await assert.rejects(attempt(v2Payload(trusted.snapshot), relabel(2)), /unsupported squad-state read version/);
  assert.equal(await count(db, "prediction_snapshots"), 0);
  assert.equal(await count(db, "prediction_squad_state_context"), 0);

  // Honest labels both record (read-v1 here as the owner: offline replay of
  // frozen semantics; service_role is refused, see security.test.ts).
  const v2 = await recordPredictionV2(db, trusted.snapshot, LINEUP_RECORDED);
  const v1 = await recordPredictionV2(db, legacy.snapshot, LINEUP_RECORDED);
  const readOf = async (id: string) => (await db.query<{ r: string }>("select squad_state_read_version as r from public.prediction_squad_state_context where snapshot_id = $1", [id])).rows[0].r;
  assert.equal(await readOf(v2.snapshot_id), SQUAD_STATE_READ_V2_VERSION);
  assert.equal(await readOf(v1.snapshot_id), SQUAD_STATE_READ_V1_VERSION);

  // Canonical form: read-v1 explicit or absent is the same bytes; read-v2 is hashed.
  const base = v2Payload(legacy.snapshot).inputs;
  const absent = clone(base);
  delete absent.squad_state_context.squad_state_read_version;
  const asV2 = clone(base);
  asV2.squad_state_context.squad_state_read_version = SQUAD_STATE_READ_V2_VERSION;
  assert.equal(await bundleSha(db, base), await bundleSha(db, absent));
  assert.equal(await bundleSha(db, base), v1.input_bundle_sha256);
  assert.notEqual(await bundleSha(db, asV2), v1.input_bundle_sha256);
  await db.close();
});

test("trust is read at current state, but a frozen read-v2 forecast stays authoritative and replays from its artifact", async () => {
  const world = await setupAttestedLineupWorld();
  const { db, home } = world;
  const frozen = await forecastSnapshot(world, home.teamId, { idempotencyKey: "frozen-read-v2" });
  const recorded = await recordPredictionV2(db, frozen.snapshot, LINEUP_RECORDED);
  assert.equal(recorded.status, "recorded");

  // The home team's attestation is revoked later.
  await revokeTeam(db, world.ids.homeTeamId, home.teamId, "frozen replay control");
  // Today's trusted read at the same cutoff no longer sees that history ...
  const today = await loadForecastInputs(world, home.teamId);
  assert.deepEqual(today.history, []);
  // ... so the same forecast can no longer be recorded as a new snapshot ...
  const stale = clone(v2Payload(frozen.snapshot));
  stale.idempotency_key = "frozen-read-v2-restated";
  await assert.rejects(recordPredictionV2(db, stale, "2026-10-31T12:00:00.000Z"), /does not freeze exactly the squad history/);
  // ... while the frozen snapshot is untouched, replays idempotently without
  // re-reading, and its artifact reproduces the stored output exactly.
  assert.equal((await recordPredictionV2(db, frozen.snapshot, "2026-10-31T12:00:00.000Z")).status, "unchanged");
  const row = (await db.query<{ t: string; sha: string; r: string }>(
    "select squad_state_canonical_json as t, squad_state_sha256 as sha, squad_state_read_version as r from public.prediction_squad_state_context where snapshot_id = $1",
    [recorded.snapshot_id],
  )).rows[0];
  assert.equal(row.r, SQUAD_STATE_READ_V2_VERSION);
  const stored = (await db.query<{ e: LineupForecastOutput }>("select payload->'lineup_estimate' as e from public.prediction_snapshots where id = $1", [recorded.snapshot_id])).rows[0].e;
  const state = parseSquadStateArtifact(row.t, row.sha);
  // Offline replay reads the immutable frozen rows by id (as the owner); trust does not reinterpret them.
  const immutableRows = await loadForecastInputs(world, home.teamId, { read: SQUAD_STATE_READ_V1_VERSION });
  assert.deepEqual(buildLineupForecast(lineupReplayInput(state, row.sha, immutableRows.history), stored.parameters), stored);
  assert.equal(await count(db, "prediction_snapshots"), 1);
  await db.close();
});

test("a read-v1 lineup snapshot recorded before this migration keeps its bundle hash and replays idempotently after it", async () => {
  const migration = /_kapiloto_v4_attestation_aware_consumer_reads\.sql$/;
  const world = await setupReadV1LineupWorld({ exclude: migration });
  const { db, home } = world;
  const legacy = await forecastSnapshot(world, home.teamId, { idempotencyKey: "pre-migration-v1" });
  // The pre-migration payload contract has no read-version key.
  const frozenPayload = v2Payload(legacy.snapshot);
  delete frozenPayload.inputs.squad_state_context.squad_state_read_version;
  const before = await recordPredictionV2(db, frozenPayload, LINEUP_RECORDED);
  assert.equal(before.status, "recorded");

  const dir = join(process.cwd(), "supabase", "migrations");
  await db.exec(readFileSync(join(dir, readdirSync(dir).find((name) => migration.test(name))!), "utf8"));

  // The frozen row is backfilled as read-v1; its hash and replays are unchanged.
  const context = (await db.query<{ r: string }>("select squad_state_read_version as r from public.prediction_squad_state_context where snapshot_id = $1", [before.snapshot_id])).rows[0];
  assert.equal(context.r, SQUAD_STATE_READ_V1_VERSION);
  assert.equal(await bundleSha(db, frozenPayload.inputs), before.input_bundle_sha256);
  const replay = await recordPredictionV2(db, frozenPayload, "2026-10-30T12:20:00.000Z");
  assert.deepEqual([replay.status, replay.snapshot_id, replay.input_bundle_sha256], ["unchanged", before.snapshot_id, before.input_bundle_sha256]);
  const explicit = await recordPredictionV2(db, legacy.snapshot, "2026-10-30T12:21:00.000Z");
  assert.deepEqual([explicit.status, explicit.snapshot_id], ["unchanged", before.snapshot_id]);
  // The same key claiming the trusted read is a different snapshot.
  const relabelled = clone(frozenPayload);
  relabelled.inputs.squad_state_context.squad_state_read_version = SQUAD_STATE_READ_V2_VERSION;
  await assert.rejects(recordPredictionV2(db, relabelled, "2026-10-30T12:22:00.000Z"), /already used for a different snapshot/);

  // The registry's read-v1 branch still verifies new read-v1 snapshots for
  // the owner (offline replay environments) after the migration.
  const after = await forecastSnapshot(world, home.teamId, { idempotencyKey: "post-migration-v1" });
  const recorded = await recordPredictionV2(db, after.snapshot, LINEUP_RECORDED);
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.input_bundle_sha256, before.input_bundle_sha256);
  assert.equal(await count(db, "prediction_snapshots"), 2);
  await db.close();
});
