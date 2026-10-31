import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { buildMatchLedgerObservationPayload } from "./match-ledger";
import { recordProviderMatchObservationV2 } from "./provider-ingest";
import { createLedgerDatabase, recordObservation, realisticObservation, resultOnlyObservation, seedLedger, createFixture, setClock } from "./test-support/ledger-fixtures";
import {
  attestCompetition,
  attestTeam,
  attestedWorld,
  canonicalFixtureFor,
  createScopedRun,
  ingestV2,
  mapProviderFixture,
  operatorSql,
  revokeCompetition,
  revokeTeam,
  type AttestedWorld,
} from "./test-support/attestation-fixtures";
import { countRows, pgliteRpc, writeFootprint } from "./test-support/provider-ingest-fixtures";

/** public.match_ledger_ingest_provider_fixture_v2 (D-058) on SYNTHETIC captures (no provider calls). */

const KICKOFF = "2026-08-15T18:00:00.000Z";
const CAPTURED = "2026-10-30T08:59:00.000Z";
const SEEN = "2026-10-30T09:00:00.000Z";
const LATER = "2026-10-30T10:00:00.000Z";
const HOUR = 3_600_000;

const at = (offsetMs: number) => new Date(Date.parse(KICKOFF) + offsetMs).toISOString();
const world = (db: PGlite, options: { attest?: boolean } = {}) => attestedWorld(db, { kickoffAt: KICKOFF, capturedAt: CAPTURED, ...options });

async function quarantined(db: PGlite, w: AttestedWorld, code: string, overrides: Parameters<AttestedWorld["observation"]>[0] = {}) {
  const before = await writeFootprint(db);
  const result = await ingestV2(db, w.observation(overrides), SEEN);
  assert.deepEqual([result.status, result.reason_code], ["quarantined", code]);
  assert.deepEqual(await writeFootprint(db), before, code);
  return result;
}

test("V2 mints under attested identities, seals the exact attestation event/generation per ref, and keeps A2-A player bootstrap", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  const result = await ingestV2(db, w.observation(), SEEN);
  assert.deepEqual([result.status, result.fixture_resolution, result.observation_version, result.players_minted], ["recorded", "minted", 1, 28]);

  const sidecars = await db.query<{ ref_kind: string; provider_ref: string; canonical_id: string; attestation_generation_id: string; team_attestation_event_id: string | null; competition_attestation_event_id: string | null }>(
    "select * from public.match_ledger_observation_identity_attestations where observation_id = $1 order by ref_kind",
    [result.observation_id],
  );
  const projections = await db.query<{ ref: string; generation: string; event: string; canonical: string }>(
    `select provider_competition_id as ref, attestation_generation_id as generation, latest_event_id as event, competition_id as canonical
       from private.provider_competition_identity_attestations where provider_competition_id = $1
     union all
     select provider_team_id, attestation_generation_id, latest_event_id, team_id
       from private.provider_team_identity_attestations where provider_team_id in ($2, $3)`,
    [w.ids.leagueId, w.ids.homeTeamId, w.ids.awayTeamId],
  );
  const byRef = new Map(projections.rows.map((p) => [p.ref, p]));
  assert.deepEqual(sidecars.rows.map((s) => s.ref_kind), ["league", "team_away", "team_home"]);
  for (const s of sidecars.rows) {
    const p = byRef.get(s.provider_ref)!;
    assert.deepEqual([s.attestation_generation_id, s.canonical_id, s.team_attestation_event_id ?? s.competition_attestation_event_id], [p.generation, p.canonical, p.event], s.ref_kind);
    assert.equal(s.ref_kind === "league", s.competition_attestation_event_id !== null);
  }
  assert.deepEqual(result.attestation_generations, {
    league: byRef.get(w.ids.leagueId)!.generation,
    team_home: byRef.get(w.ids.homeTeamId)!.generation,
    team_away: byRef.get(w.ids.awayTeamId)!.generation,
  });

  // Players: exactly the A2-A provider-native bootstrap.
  assert.equal(await countRows(db, "provider_player_mappings", "provider = 'sportmonks' and mapping_basis = 'provider_native_bootstrap' and mapping_status = 'confirmed'"), 28);
  // Identical content under the same generations: unchanged.
  const again = await ingestV2(db, w.observation(), LATER);
  assert.deepEqual([again.status, again.observation_id, again.provider_refs_status], ["unchanged", result.observation_id, "matched"]);
  await db.close();
});

test("run scope: a run is mandatory, must belong to the provider and allow-list provider fixture ids; an unlisted fixture is an audited quarantine", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  await assert.rejects(ingestV2(db, w.observation({}, { runId: null }), SEEN), /requires a run_id/);
  await assert.rejects(ingestV2(db, w.observation({}, { runId: "00000000-0000-4000-8000-0000000000ff" }), SEEN), /provider ingest run .* not found/);
  const otherProvider = await createScopedRun(db, [w.providerFixtureId], { provider: "api_football" });
  await assert.rejects(ingestV2(db, w.observation({}, { runId: otherProvider }), SEEN), /belongs to provider api_football/);
  for (const scope of [undefined, [], [""], [123], "x"]) {
    const run = await createScopedRun(db, scope);
    await assert.rejects(ingestV2(db, w.observation({}, { runId: run }), SEEN), /needs scope\.provider_fixture_ids/, JSON.stringify(scope));
  }

  const elsewhere = await createScopedRun(db, ["99999999"]);
  const before = await writeFootprint(db);
  const outside = await ingestV2(db, w.observation({}, { runId: elsewhere }), SEEN);
  assert.deepEqual([outside.status, outside.reason_code, outside.attempt_no], ["quarantined", "fixture_outside_run_scope", 1]);
  assert.deepEqual(await writeFootprint(db), before);
  const item = await db.query<{ reason_code: string; detail: { run_id: string } }>("select reason_code, detail from public.provider_ingest_items where run_id = $1", [elsewhere]);
  assert.deepEqual([item.rows[0].reason_code, item.rows[0].detail.run_id], ["fixture_outside_run_scope", elsewhere]);
  // The run row is immutable, so its allowlist cannot be widened after review.
  await assert.rejects(db.query("update public.provider_ingest_runs set scope = '{\"provider_fixture_ids\": [\"x\"]}' where id = $1", [elsewhere]), /immutable/);

  // The TypeScript wrapper refuses a missing run before calling.
  await assert.rejects(recordProviderMatchObservationV2(pgliteRpc(db) as never, w.observation({}, { runId: null })), /V2 ingest requires a runId/);
  assert.equal((await recordProviderMatchObservationV2(pgliteRpc(db) as never, w.observation())).status, "recorded");
  await db.close();
});

test("competition trust: manual_override mapping AND agreeing active attestation; nothing else counts", async () => {
  const db = await createLedgerDatabase();
  const unmapped = await world(db);
  await db.query("delete from public.provider_competition_mappings where provider = 'sportmonks' and provider_competition_id = $1", [unmapped.ids.leagueId]);
  await quarantined(db, unmapped, "competition_unmapped");

  const demoted = await world(db);
  await operatorSql(db, "update public.provider_competition_mappings set mapping_status = 'confirmed' where provider = 'sportmonks' and provider_competition_id = $1", [demoted.ids.leagueId]);
  await quarantined(db, demoted, "competition_mapping_not_manual_override");

  // manual_override alone is not trust.
  const unattested = await world(db, { attest: false });
  await attestTeam(db, unattested.ids.homeTeamId, unattested.seed.homeTeamId);
  await attestTeam(db, unattested.ids.awayTeamId, unattested.seed.awayTeamId);
  await quarantined(db, unattested, "competition_attestation_missing");

  const repointed = await world(db);
  const other = (await db.query<{ id: string }>("insert into public.competitions (canonical_name) values ('Synthetic Other League') returning id")).rows[0].id;
  await operatorSql(db, "update public.provider_competition_mappings set competition_id = $2 where provider = 'sportmonks' and provider_competition_id = $1", [repointed.ids.leagueId, other]);
  await quarantined(db, repointed, "competition_attestation_mismatch");
  await db.close();
});

test("team trust: V3 confirmed rows (even at confidence 1), delete + V3 reinsert and unverified rows never regain trust", async () => {
  const db = await createLedgerDatabase();
  const unmapped = await world(db);
  await db.query("delete from public.provider_team_mappings where provider = 'sportmonks' and provider_team_id = $1", [unmapped.ids.awayTeamId]);
  await quarantined(db, unmapped, "team_unmapped");

  // The A2-A trust rule (confirmed at confidence 1) is gone.
  const confirmedOne = await world(db, { attest: false });
  await attestCompetition(db, confirmedOne.ids.leagueId, confirmedOne.seed.competitionId);
  await operatorSql(db, "update public.provider_team_mappings set mapping_status = 'confirmed', mapping_confidence = 1 where provider = 'sportmonks' and provider_team_id in ($1, $2)", [confirmedOne.ids.homeTeamId, confirmedOne.ids.awayTeamId]);
  await quarantined(db, confirmedOne, "team_mapping_not_manual_override");

  const unattested = await world(db, { attest: false });
  await attestCompetition(db, unattested.ids.leagueId, unattested.seed.competitionId);
  await attestTeam(db, unattested.ids.homeTeamId, unattested.seed.homeTeamId);
  await quarantined(db, unattested, "team_attestation_missing");

  const repointed = await world(db);
  const other = (await db.query<{ id: string }>("insert into public.teams (canonical_name) values ('Synthetic Repointed') returning id")).rows[0].id;
  await operatorSql(db, "update public.provider_team_mappings set team_id = $2 where provider = 'sportmonks' and provider_team_id = $1", [repointed.ids.homeTeamId, other]);
  await quarantined(db, repointed, "team_attestation_mismatch");

  // Deleting an attested mapping and letting V3 bootstrap it again (insert-only,
  // confirmed at 0.9) cannot restore trust, although the attestation agrees.
  const reinserted = await world(db);
  await db.query("delete from public.provider_team_mappings where provider = 'sportmonks' and provider_team_id = $1", [reinserted.ids.homeTeamId]);
  await db.query(
    `insert into public.provider_team_mappings (provider, provider_team_id, team_id, provider_name, mapping_status, mapping_confidence)
     values ('sportmonks', $1, $2, 'Synthetic Home FC', 'confirmed', 0.9) on conflict do nothing`,
    [reinserted.ids.homeTeamId, reinserted.seed.homeTeamId],
  );
  await quarantined(db, reinserted, "team_mapping_not_manual_override");

  const unverified = await world(db);
  await operatorSql(db, "update public.provider_team_mappings set mapping_status = 'unverified' where provider = 'sportmonks' and provider_team_id = $1", [unverified.ids.awayTeamId]);
  await quarantined(db, unverified, "team_mapping_not_manual_override");
  await db.close();
});

test("a valid existing fixture mapping succeeds whatever its V3 status/confidence: it is the unique N candidate, never a conflict with itself", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  const fixture = await canonicalFixtureFor(db, w.seed, KICKOFF);
  await mapProviderFixture(db, fixture, w.providerFixtureId, "confirmed", 0.9);
  const result = await ingestV2(db, w.observation(), SEEN);
  assert.deepEqual([result.status, result.fixture_resolution, result.fixture_id], ["recorded", "existing_mapping", fixture]);

  // Kickoff exactly 48 h away is inside the window; one second more is not.
  const edge = await world(db);
  const edgeFixture = await canonicalFixtureFor(db, edge.seed, at(48 * HOUR));
  await mapProviderFixture(db, edgeFixture, edge.providerFixtureId);
  assert.equal((await ingestV2(db, edge.observation(), SEEN)).fixture_resolution, "existing_mapping");
  const beyond = await world(db);
  await mapProviderFixture(db, await canonicalFixtureFor(db, beyond.seed, at(48 * HOUR + 1000)), beyond.providerFixtureId);
  await quarantined(db, beyond, "fixture_mapping_kickoff_conflict");
  await db.close();
});

test("an orphaned Toto-reschedule fixture keeps its insert-only mapping but can never be accepted, and nothing falls back to the new fixture", async () => {
  const db = await createLedgerDatabase();
  // Toto imported Saturday 20:00 (F1) and V3 mapped the Sportmonks id to it;
  // the match moved to Sunday 18:00, Toto inserted F2, and V3's insert-only
  // upsert could not move the mapping.
  const moved = await world(db);
  const stale = await canonicalFixtureFor(db, moved.seed, at(-22 * HOUR));
  const fresh = await canonicalFixtureFor(db, moved.seed, KICKOFF, { status: "finished" });
  await mapProviderFixture(db, stale, moved.providerFixtureId);
  await quarantined(db, moved, "fixture_mapping_candidate_ambiguous");
  assert.equal(await countRows(db, "provider_fixture_mappings", "fixture_id = $1", [fresh]), 0);

  // Moved by more than 48 h: the mapped row itself fails the kickoff check.
  const far = await world(db);
  const farStale = await canonicalFixtureFor(db, far.seed, at(-4 * 24 * HOUR));
  await canonicalFixtureFor(db, far.seed, KICKOFF);
  await mapProviderFixture(db, farStale, far.providerFixtureId);
  await quarantined(db, far, "fixture_mapping_kickoff_conflict");

  // Sportmonks issued a new id for the moved match: the old fixture still
  // carries the old id, a provider-identity conflict within 48 h.
  const newId = await world(db);
  const oldRow = await canonicalFixtureFor(db, newId.seed, at(-22 * HOUR));
  const newRow = await canonicalFixtureFor(db, newId.seed, KICKOFF);
  await mapProviderFixture(db, oldRow, "old-sportmonks-id");
  await mapProviderFixture(db, newRow, newId.providerFixtureId);
  await quarantined(db, newId, "fixture_mapping_provider_identity_conflict");
  await db.close();
});

test("the mapped fixture's own facts: unverified, team pair, orientation, competition (null or other) and postponed-like status quarantine", async () => {
  const db = await createLedgerDatabase();
  const unverified = await world(db);
  await mapProviderFixture(db, await canonicalFixtureFor(db, unverified.seed, KICKOFF), unverified.providerFixtureId, "unverified");
  await quarantined(db, unverified, "fixture_mapping_unverified");

  const reversed = await world(db);
  await mapProviderFixture(db, await canonicalFixtureFor(db, reversed.seed, KICKOFF, { swap: true }), reversed.providerFixtureId);
  await quarantined(db, reversed, "fixture_mapping_orientation_conflict");

  const wrongPair = await world(db);
  const strangers = await world(db);
  await mapProviderFixture(db, await canonicalFixtureFor(db, strangers.seed, KICKOFF), wrongPair.providerFixtureId);
  await quarantined(db, wrongPair, "fixture_mapping_team_conflict");

  const nullCompetition = await world(db);
  await mapProviderFixture(db, await canonicalFixtureFor(db, nullCompetition.seed, KICKOFF, { competitionId: null }), nullCompetition.providerFixtureId);
  await quarantined(db, nullCompetition, "fixture_mapping_competition_conflict");

  const otherCompetition = await world(db);
  const cup = (await db.query<{ id: string }>("insert into public.competitions (canonical_name) values ('Synthetic Cup') returning id")).rows[0].id;
  await mapProviderFixture(db, await canonicalFixtureFor(db, otherCompetition.seed, KICKOFF, { competitionId: cup }), otherCompetition.providerFixtureId);
  await quarantined(db, otherCompetition, "fixture_mapping_competition_conflict");

  for (const status of ["postponed", "suspended", "cancelled", "under_review"]) {
    const w = await world(db);
    await mapProviderFixture(db, await canonicalFixtureFor(db, w.seed, KICKOFF, { status }), w.providerFixtureId);
    await quarantined(db, w, "fixture_mapping_status_conflict");
  }
  await db.close();
});

test("every other guarded candidate blocks an existing mapping (R, X, U, P, W), and a bad mapping never falls back to a candidate", async () => {
  const db = await createLedgerDatabase();
  const cases: Array<[string, (w: AttestedWorld) => Promise<unknown>]> = [
    ["fixture_mapping_orientation_conflict", (w) => canonicalFixtureFor(db, w.seed, at(24 * HOUR), { swap: true })],
    ["fixture_mapping_competition_conflict", async (w) => {
      const cup = (await db.query<{ id: string }>("insert into public.competitions (canonical_name) values ('Synthetic X Cup') returning id")).rows[0].id;
      return canonicalFixtureFor(db, w.seed, at(24 * HOUR), { competitionId: cup });
    }],
    ["fixture_mapping_competition_unknown", (w) => canonicalFixtureFor(db, w.seed, at(7 * 24 * HOUR), { competitionId: null })],
    ["fixture_mapping_possible_postponement", (w) => canonicalFixtureFor(db, w.seed, at(60 * 24 * HOUR), { status: "postponed" })],
    ["fixture_mapping_reschedule_conflict", (w) => canonicalFixtureFor(db, w.seed, at(10 * 24 * HOUR))],
  ];
  for (const [code, other] of cases) {
    const w = await world(db);
    await mapProviderFixture(db, await canonicalFixtureFor(db, w.seed, KICKOFF), w.providerFixtureId);
    await other(w);
    await quarantined(db, w, code);
  }

  // A contradictory mapping next to a perfectly attachable candidate: still a quarantine.
  const w = await world(db);
  const attachable = await canonicalFixtureFor(db, w.seed, KICKOFF);
  await mapProviderFixture(db, await canonicalFixtureFor(db, w.seed, KICKOFF, { swap: true }), w.providerFixtureId);
  const result = await quarantined(db, w, "fixture_mapping_orientation_conflict");
  assert.notEqual(result.fixture_id, attachable);
  assert.equal(await countRows(db, "provider_fixture_mappings", "fixture_id = $1", [attachable]), 0);
  await db.close();
});

test("without an existing mapping the A2-A attach/mint guards are preserved after the attestation checks", async () => {
  const db = await createLedgerDatabase();
  const attach = await world(db);
  const target = await canonicalFixtureFor(db, attach.seed, at(3 * HOUR));
  const attached = await ingestV2(db, attach.observation(), SEEN);
  assert.deepEqual([attached.status, attached.fixture_resolution, attached.fixture_id], ["recorded", "attached", target]);

  const ambiguous = await world(db);
  await canonicalFixtureFor(db, ambiguous.seed, KICKOFF);
  await canonicalFixtureFor(db, ambiguous.seed, at(5 * HOUR));
  await quarantined(db, ambiguous, "fixture_candidate_ambiguous");

  const reversed = await world(db);
  await canonicalFixtureFor(db, reversed.seed, at(20 * HOUR), { swap: true });
  await quarantined(db, reversed, "fixture_orientation_conflict");

  const noMint = await world(db);
  const before = await writeFootprint(db);
  const refused = await ingestV2(db, noMint.observation({}, { mint: false }), SEEN);
  assert.deepEqual([refused.status, refused.reason_code], ["quarantined", "fixture_mint_not_permitted"]);
  assert.deepEqual(await writeFootprint(db), before);
  await db.close();
});

test("unchanged football content under a stale attestation generation quarantines attestation_generation_stale instead of returning unchanged", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  // xg not requested at first, so a later xg fetch can be a pure family upgrade.
  const base = { families: { xg: "not_requested" as const } };
  const v1 = await ingestV2(db, w.observation(base), SEEN);
  assert.equal(v1.status, "recorded");

  // Revoked and not re-attested: no trust at all.
  await revokeTeam(db, w.ids.homeTeamId, w.seed.homeTeamId, "synthetic doubt");
  await quarantined(db, w, "team_attestation_missing", base);

  // Re-attested (same canonical team, new generation): identical content is
  // NOT "unchanged" - the latest version is sealed under the revoked generation.
  await attestTeam(db, w.ids.homeTeamId, w.seed.homeTeamId);
  const before = await writeFootprint(db);
  const stale = await ingestV2(db, w.observation(base), LATER);
  assert.deepEqual([stale.status, stale.reason_code, stale.fixture_id], ["quarantined", "attestation_generation_stale", v1.fixture_id]);
  assert.deepEqual(await writeFootprint(db), before);

  // A family upgrade that carries no new content is the A2-A family_status_drift
  // quarantine, which takes precedence over the stale generation; neither writes.
  const upgraded = await ingestV2(db, w.observation({ families: { xg: "fetched" }, omitStatTypes: [5304, 5305, 7943] }), "2026-10-30T10:30:00.000Z");
  assert.deepEqual([upgraded.status, upgraded.reason_code], ["quarantined", "family_status_drift"]);
  assert.deepEqual(await writeFootprint(db), before);

  // Changed football content records a new version sealed under the new generation.
  const corrected = await ingestV2(db, w.observation({ ...base, score90: [3, 1] }), "2026-10-30T11:00:00.000Z");
  assert.deepEqual([corrected.status, corrected.observation_version], ["recorded", 2]);
  const generation = (await db.query<{ g: string }>("select attestation_generation_id as g from private.provider_team_identity_attestations where provider_team_id = $1", [w.ids.homeTeamId])).rows[0].g;
  assert.equal(await countRows(db, "match_ledger_observation_identity_attestations", "observation_id = $1 and ref_kind = 'team_home' and attestation_generation_id = $2", [corrected.observation_id, generation]), 1);
  assert.equal((await ingestV2(db, w.observation({ ...base, score90: [3, 1] }), "2026-10-30T12:00:00.000Z")).status, "unchanged");
  await db.close();
});

test("an unverified player mapping still quarantines and confirmed players resolve to survivors (A2-A semantics unchanged)", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  const capture = w.capture();
  const firstPlayer = String(capture.families.lineups.rows[0] && (capture.families.lineups.rows[0] as { player_id: number }).player_id);
  const player = (await db.query<{ id: string }>("insert into public.players (canonical_name) values ('Synthetic Unverified') returning id")).rows[0].id;
  await db.query("insert into public.provider_player_mappings (provider, provider_player_id, player_id, mapping_status) values ('sportmonks', $1, $2, 'unverified')", [firstPlayer, player]);
  await quarantined(db, w, "player_mapping_unverified");
  await db.query("update public.provider_player_mappings set mapping_status = 'confirmed' where provider_player_id = $1", [firstPlayer]);
  const result = await ingestV2(db, w.observation(), SEEN);
  assert.deepEqual([result.status, result.players_minted], ["recorded", 27]);
  await db.close();
});

test("sidecar rows are written only by V2 ingest: flag, shared lock, sealed refs, typed current event and generation are all enforced", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  const recorded = await ingestV2(db, w.observation(), SEEN);
  const projection = async (ref: string) =>
    (await db.query<{ generation: string; event: string; team: string }>(
      "select attestation_generation_id as generation, latest_event_id as event, team_id as team from private.provider_team_identity_attestations where provider_team_id = $1",
      [ref],
    )).rows[0];
  const home = await projection(w.ids.homeTeamId);
  const sidecar = "insert into public.match_ledger_observation_identity_attestations (observation_id, ref_kind, team_attestation_event_id, attestation_generation_id, provider_ref, canonical_id) values ($1, 'team_home', $2, $3, $4, $5)";

  // Plain 1A observation: no refs, no flag, no lock.
  const ledger = await seedLedger(db, ["Forge Home", "Forge Away"]);
  const fixture = await createFixture(db, ledger, "2024-03-02T18:00:00.000Z");
  const plain = await recordObservation(db, realisticObservation(ledger, fixture, { kickoffAt: "2024-03-02T18:00:00.000Z", retrievedAt: "2024-03-03T00:00:00.000Z" }), "2024-03-03T00:00:00.000Z");
  await assert.rejects(db.query(sidecar, [plain.observation_id, home.event, home.generation, w.ids.homeTeamId, home.team]), /written only by the V2 provider ingest/);

  // Flag + shared lock in a later statement: refs do not match (plain), or the version is sealed (V2).
  const withGuards = (sql: string, params: unknown[]) =>
    db.transaction(async (tx) => {
      await tx.query("select set_config('kapiloto.provider_ingest_v2', 'on', true)");
      await tx.query("select pg_advisory_xact_lock_shared(hashtextextended('kapiloto_v4_provider_identity:sportmonks', 0))");
      await tx.query(sql, params);
    });
  await assert.rejects(withGuards(sidecar, [plain.observation_id, home.event, home.generation, w.ids.homeTeamId, home.team]), /does not match its sealed provider ref/);
  await assert.rejects(withGuards(sidecar, [recorded.observation_id, home.event, home.generation, w.ids.homeTeamId, home.team]), /is sealed/);
  // The flag without the shared lock is refused before anything else.
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query("select set_config('kapiloto.provider_ingest_v2', 'on', true)");
      await tx.query(sidecar, [recorded.observation_id, home.event, home.generation, w.ids.homeTeamId, home.team]);
    }),
    /written only by the V2 provider ingest/,
  );

  // Same-statement forgery: a fresh 1A write on the ATTESTED teams plus its
  // refs and one sidecar row, with the flag and the shared lock held. Each
  // case differs from a fully consistent row in exactly one property, so a
  // refusal is attributable to that property.
  await db.exec(`
    create function public.test_forge_sidecar(
      p_payload jsonb, p_competition uuid, p_league_ref text, p_home_ref text, p_away_ref text,
      p_kind text, p_team_event uuid, p_comp_event uuid, p_generation uuid)
    returns void language plpgsql as $$
    declare v_obs uuid;
    begin
      v_obs := (public.match_ledger_record_observation(p_payload)->>'observation_id')::uuid;
      insert into public.match_ledger_observation_provider_refs (observation_id, ref_kind, provider_ref, canonical_id)
      select v_obs, x.kind, x.ref, x.canonical
      from (values
        ('league', p_league_ref, p_competition),
        ('season', 's', null::uuid),
        ('team_home', p_home_ref, (select tr.team_id from public.match_ledger_team_records tr where tr.observation_id = v_obs and tr.side = 'home')),
        ('team_away', p_away_ref, (select tr.team_id from public.match_ledger_team_records tr where tr.observation_id = v_obs and tr.side = 'away'))
      ) x(kind, ref, canonical);
      perform set_config('kapiloto.provider_ingest_v2', 'on', true);
      perform pg_advisory_xact_lock_shared(hashtextextended('kapiloto_v4_provider_identity:sportmonks', 0));
      insert into public.match_ledger_observation_identity_attestations
        (observation_id, ref_kind, team_attestation_event_id, competition_attestation_event_id, attestation_generation_id, provider_ref, canonical_id)
      select v_obs, p_kind, p_team_event, p_comp_event, p_generation, pr.provider_ref, pr.canonical_id
      from public.match_ledger_observation_provider_refs pr where pr.observation_id = v_obs and pr.ref_kind = p_kind;
    end $$;
  `);
  let k = 0;
  const forge = async (o: { kind?: "team_home" | "league"; competition?: string; homeRef?: string; awayRef?: string; teamEvent: string | null; compEvent?: string | null; generation: string }) => {
    k += 1;
    const kickoff = `2026-07-${String(k).padStart(2, "0")}T18:00:00.000Z`;
    const fixtureId = await canonicalFixtureFor(db, w.seed, kickoff);
    const payload = buildMatchLedgerObservationPayload(
      resultOnlyObservation({ fixtureId, providerFixtureId: `forge-${k}` }, w.seed.homeTeamId, w.seed.awayTeamId, { kickoffAt: kickoff, retrievedAt: SEEN, homeGoals: 1, awayGoals: 0 }),
    );
    await setClock(db, SEEN);
    return db.query("select public.test_forge_sidecar($1::jsonb, $2, $3, $4, $5, $9, $6, $7, $8)", [
      JSON.stringify(payload),
      o.competition ?? w.seed.competitionId,
      w.ids.leagueId,
      o.homeRef ?? w.ids.homeTeamId,
      o.awayRef ?? w.ids.awayTeamId,
      o.teamEvent,
      o.compEvent ?? null,
      o.generation,
      o.kind ?? "team_home",
    ]);
  };
  const league = (await db.query<{ generation: string; event: string }>("select attestation_generation_id as generation, latest_event_id as event from private.provider_competition_identity_attestations where provider_competition_id = $1", [w.ids.leagueId])).rows[0];
  // Control: a fully consistent row is accepted. This is the documented limit
  // of the threat model - a deliberate same-statement forgery by a malicious
  // service_role that names the current event, generation and canonical ids is
  // not prevented; the guards stop accidents and every inconsistency below.
  await forge({ teamEvent: home.event, generation: home.generation });
  // Wrong typed event: a competition event on a team ref (typed check constraint).
  await assert.rejects(forge({ teamEvent: null, compEvent: league.event, generation: home.generation }), /violates check constraint|names a team attestation event/);
  // Another generation than the event's and the current projection's.
  await assert.rejects(forge({ teamEvent: home.event, generation: league.generation }), /does not name the current team attestation event/);
  // The event of a different provider ref (sealed refs swapped, canonical ids unchanged).
  await assert.rejects(forge({ homeRef: w.ids.awayTeamId, awayRef: w.ids.homeTeamId, teamEvent: home.event, generation: home.generation }), /does not name the current team attestation event/);
  // A superseded event of the right generation (after an evidence refresh) is not the current event.
  await attestTeam(db, w.ids.homeTeamId, w.seed.homeTeamId, { evidence: { contract_version: "kapiloto-provider-identity-attestation-evidence-v1", sources: ["synthetic:refresh"], reviewed_by: "r", duplicate_audit_sha256: "a".repeat(64) } });
  await assert.rejects(forge({ teamEvent: home.event, generation: home.generation }), /does not name the current team attestation event/);

  // League refs: the same checks against the competition projection.
  await forge({ kind: "league", teamEvent: null, compEvent: league.event, generation: league.generation });
  await assert.rejects(forge({ kind: "league", teamEvent: home.event, compEvent: null, generation: league.generation }), /violates check constraint|names a competition attestation event/);
  await assert.rejects(forge({ kind: "league", teamEvent: null, compEvent: league.event, generation: home.generation }), /does not name the current competition attestation event/);
  const otherCompetition = (await db.query<{ id: string }>("insert into public.competitions (canonical_name) values ('Synthetic Forge League') returning id")).rows[0].id;
  await assert.rejects(forge({ kind: "league", competition: otherCompetition, teamEvent: null, compEvent: league.event, generation: league.generation }), /does not name the current competition attestation event/);
  await revokeCompetition(db, w.ids.leagueId, w.seed.competitionId, "closing the generation");
  await assert.rejects(forge({ kind: "league", teamEvent: null, compEvent: league.event, generation: league.generation }), /does not name the current competition attestation event/);

  for (const sql of ["update public.match_ledger_observation_identity_attestations set provider_ref = 'x'", "delete from public.match_ledger_observation_identity_attestations"]) {
    await assert.rejects(db.query(sql), /immutable/, sql);
  }
  await assert.rejects(db.query("truncate public.match_ledger_observation_identity_attestations"), /immutable/);
  await db.close();
});
