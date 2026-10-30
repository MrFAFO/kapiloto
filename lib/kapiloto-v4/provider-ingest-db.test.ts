import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { buildMatchLedgerObservationPayload, buildMatchLedgerWithdrawalPayload } from "./match-ledger";
import { buildProviderMatchObservationPayload, recordProviderIngestFailure, recordProviderMatchObservation } from "./provider-ingest";
import { createLedgerDatabase, recordObservation, setClock } from "./test-support/ledger-fixtures";
import {
  MINT_BEFORE,
  countRows,
  createIngestRun,
  ingest,
  observationFrom,
  pgliteRpc,
  seedIngestIdentities,
  syntheticCapture,
  writeFootprint,
  type IngestSeed,
  type SyntheticCaptureOptions,
} from "./test-support/provider-ingest-fixtures";

/** public.match_ledger_ingest_provider_fixture on SYNTHETIC captures (no provider calls). */

const KICKOFF = "2026-08-15T18:00:00.000Z";
const CAPTURED = "2026-10-30T08:59:00.000Z";
const SEEN = "2026-10-30T09:00:00.000Z";
const LATER = "2026-10-30T10:00:00.000Z";

let scenarioCounter = 0;

/** One canonical competition + two teams mapped to their own synthetic Sportmonks ids. */
async function scenario(db: PGlite, options: { mapCompetition?: boolean; mapTeams?: boolean } = {}) {
  scenarioCounter += 1;
  const n = scenarioCounter;
  const ids = { leagueId: String(9000 + n), homeTeamId: String(95_000 + n * 2), awayTeamId: String(95_001 + n * 2) };
  const seed = await seedIngestIdentities(db, { ...ids, ...options });
  const providerFixtureId = String(19_000_000 + n);
  const homeBase = 3_000_000 + n * 100;
  const capture = (overrides: Partial<SyntheticCaptureOptions> = {}) =>
    syntheticCapture({
      ...ids,
      providerFixtureId,
      playerIdBase: [homeBase, 4_000_000 + n * 100],
      kickoffAt: KICKOFF,
      capturedAt: CAPTURED,
      ...overrides,
    });
  return { seed, ids, capture, providerFixtureId, homeBase };
}

async function canonicalFixture(
  db: PGlite,
  seed: IngestSeed,
  kickoffAt: string,
  options: { status?: string; competitionId?: string | null; swap?: boolean } = {},
): Promise<string> {
  const [home, away] = options.swap ? [seed.awayTeamId, seed.homeTeamId] : [seed.homeTeamId, seed.awayTeamId];
  const result = await db.query<{ id: string }>(
    `insert into public.fixtures (competition_id, home_team_id, away_team_id, kickoff_at, status)
     values ($1, $2, $3, $4, $5) returning id`,
    [options.competitionId === undefined ? seed.competitionId : options.competitionId, home, away, kickoffAt, options.status ?? "upcoming"],
  );
  return result.rows[0].id;
}

async function mapFixture(
  db: PGlite,
  fixtureId: string,
  providerFixtureId: string,
  status = "confirmed",
  confidence: number | null = 1,
): Promise<void> {
  await db.query(
    "insert into public.provider_fixture_mappings (fixture_id, provider, provider_fixture_id, mapping_status, mapping_confidence) values ($1, 'sportmonks', $2, $3, $4)",
    [fixtureId, providerFixtureId, status, confidence],
  );
}

function delta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.keys(after).filter((k) => after[k] !== before[k]).map((k) => [k, after[k] - before[k]]));
}

const hoursFrom = (iso: string, hours: number) => new Date(Date.parse(iso) + hours * 3_600_000).toISOString();

test("an unknown finished fixture is minted under the caller policy; competitions and teams are never created", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const before = await writeFootprint(db);

  const result = await ingest(db, observationFrom(s.capture()), SEEN);
  assert.equal(result.status, "recorded");
  assert.equal(result.reason_code, null);
  assert.equal(result.fixture_resolution, "minted");
  assert.equal(result.observation_version, 1);
  assert.equal(result.provider_refs_status, "recorded");
  assert.equal(result.players_minted, 28);
  assert.equal(result.attempt_no, null);
  assert.deepEqual(delta(before, await writeFootprint(db)), {
    fixtures: 1,
    provider_fixture_mappings: 1,
    match_ledger_fixture_mints: 1,
    players: 28,
    provider_player_mappings: 28,
    player_aliases: 28,
    match_ledger_observations: 1,
    match_ledger_team_records: 2,
    match_ledger_players: 28,
    match_ledger_team_stats: 14,
    match_ledger_observation_provider_refs: 4,
    match_ledger_observation_family_fetches: 4,
  });

  const fixture = (
    await db.query<{ competition_id: string; home_team_id: string; away_team_id: string; status: string; home_score: number; away_score: number; neutral_venue: boolean; kickoff_at: Date }>(
      "select * from public.fixtures where id = $1",
      [result.fixture_id],
    )
  ).rows[0];
  assert.deepEqual(
    [fixture.competition_id, fixture.home_team_id, fixture.away_team_id, fixture.status, fixture.home_score, fixture.away_score, fixture.neutral_venue],
    [s.seed.competitionId, s.seed.homeTeamId, s.seed.awayTeamId, "finished", 2, 1, false],
  );
  assert.equal(fixture.kickoff_at.toISOString(), KICKOFF);
  const mapping = (
    await db.query<{ mapping_status: string; mapping_confidence: string; round_game_id: string | null }>(
      "select * from public.provider_fixture_mappings where provider = 'sportmonks' and provider_fixture_id = $1",
      [s.providerFixtureId],
    )
  ).rows[0];
  assert.deepEqual([mapping.mapping_status, Number(mapping.mapping_confidence), mapping.round_game_id], ["confirmed", 1, null]);
  const mint = (await db.query<{ kickoff_before: Date; minted_at: Date }>("select * from public.match_ledger_fixture_mints where fixture_id = $1", [result.fixture_id])).rows[0];
  assert.equal(mint.kickoff_before.toISOString(), MINT_BEFORE);
  assert.equal(mint.minted_at.toISOString(), SEEN);

  const observation = (
    await db.query<{ ingest_version: string; raw_payload_sha256: string | null; capture_mode: string; first_seen_at: Date; provider_endpoint: string }>(
      "select * from public.match_ledger_observations where id = $1",
      [result.observation_id],
    )
  ).rows[0];
  assert.deepEqual(
    [observation.ingest_version, observation.raw_payload_sha256, observation.capture_mode, observation.provider_endpoint],
    ["kapiloto-sportmonks-ledger-mapping-v1", null, "backfill", "fixtures/{id}"],
  );
  assert.equal(observation.first_seen_at.toISOString(), SEEN);
  const refs = await db.query<{ ref_kind: string; provider_ref: string }>(
    "select ref_kind, provider_ref from public.match_ledger_observation_provider_refs where observation_id = $1 order by ref_kind",
    [result.observation_id],
  );
  assert.deepEqual(refs.rows.map((r) => [r.ref_kind, r.provider_ref]), [
    ["league", s.ids.leagueId],
    ["season", "99001"],
    ["team_away", s.ids.awayTeamId],
    ["team_home", s.ids.homeTeamId],
  ]);
  const families = await db.query<{ family: string; fetch_status: string }>(
    "select family, fetch_status from public.match_ledger_observation_family_fetches where observation_id = $1 order by family",
    [result.observation_id],
  );
  assert.deepEqual(families.rows.map((r) => [r.family, r.fetch_status]), [["formations", "fetched"], ["lineups", "fetched"], ["statistics", "fetched"], ["xg", "fetched"]]);

  const bootstrapped = await db.query<{ mapping_basis: string; mapping_status: string; mapping_confidence: string; canonical_name: string; provider_name: string }>(
    `select m.mapping_basis, m.mapping_status, m.mapping_confidence, p.canonical_name, m.provider_name
     from public.provider_player_mappings m join public.players p on p.id = m.player_id
     where m.provider = 'sportmonks' and m.provider_player_id = $1`,
    [String(s.homeBase)],
  );
  assert.deepEqual(
    [bootstrapped.rows[0].mapping_basis, bootstrapped.rows[0].mapping_status, Number(bootstrapped.rows[0].mapping_confidence), bootstrapped.rows[0].canonical_name],
    ["provider_native_bootstrap", "confirmed", 1, "Synthetic Home 1"],
  );
  assert.equal(await countRows(db, "provider_player_mappings", "mapping_basis = 'provider_native_bootstrap'"), 28);
  assert.equal(await countRows(db, "player_aliases", "alias_kind = 'provider_spelling' and source = 'sportmonks_bootstrap'"), 28);

  // Idempotent: the same capture is unchanged and writes nothing.
  const middle = await writeFootprint(db);
  const again = await ingest(db, observationFrom(s.capture()), LATER);
  assert.equal(again.status, "unchanged");
  assert.equal(again.observation_id, result.observation_id);
  assert.equal(again.fixture_resolution, "existing_mapping");
  assert.equal(again.provider_refs_status, "matched");
  assert.equal(again.players_minted, 0);
  assert.deepEqual(delta(middle, await writeFootprint(db)), {});
  await db.close();
});

test("a single unmapped canonical candidate is attached without touching the V3 fixture row", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const fixtureId = await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, 1));
  // Another provider's mapping does not make it ineligible.
  await db.query("insert into public.provider_fixture_mappings (fixture_id, provider, provider_fixture_id) values ($1, 'api_football', 'af-77')", [fixtureId]);
  const v3Before = (await db.query("select * from public.fixtures where id = $1", [fixtureId])).rows[0];
  const before = await writeFootprint(db);

  const result = await ingest(db, observationFrom(s.capture()), SEEN);
  assert.equal(result.status, "recorded");
  assert.equal(result.fixture_resolution, "attached");
  assert.equal(result.fixture_id, fixtureId);
  const changes = delta(before, await writeFootprint(db));
  assert.equal(changes.fixtures, undefined);
  assert.equal(changes.match_ledger_fixture_mints, undefined);
  assert.equal(changes.provider_fixture_mappings, 1);
  assert.deepEqual((await db.query("select * from public.fixtures where id = $1", [fixtureId])).rows[0], v3Before);
  await db.close();
});

test("an existing provider fixture mapping wins, but only when authoritative and consistent", async () => {
  const db = await createLedgerDatabase();

  const mapped = await scenario(db);
  const far = await canonicalFixture(db, mapped.seed, "2026-08-25T18:00:00.000Z");
  await mapFixture(db, far, mapped.providerFixtureId);
  const wins = await ingest(db, observationFrom(mapped.capture()), SEEN);
  assert.deepEqual([wins.status, wins.fixture_resolution, wins.fixture_id], ["recorded", "existing_mapping", far]);

  const quarantines: Array<[string, (s: Awaited<ReturnType<typeof scenario>>) => Promise<void>]> = [
    ["fixture_mapping_conflict", async (s) => mapFixture(db, await canonicalFixture(db, s.seed, KICKOFF, { swap: true }), s.providerFixtureId)],
    ["fixture_mapping_unverified", async (s) => mapFixture(db, await canonicalFixture(db, s.seed, KICKOFF), s.providerFixtureId, "unverified")],
    [
      "fixture_mapping_conflict",
      async (s) => {
        const other = await seedIngestIdentities(db, { mapCompetition: false, mapTeams: false });
        await mapFixture(db, await canonicalFixture(db, s.seed, KICKOFF, { competitionId: other.competitionId }), s.providerFixtureId);
      },
    ],
  ];
  for (const [code, arrange] of quarantines) {
    const s = await scenario(db);
    await arrange(s);
    const before = await writeFootprint(db);
    const result = await ingest(db, observationFrom(s.capture()), SEEN);
    assert.deepEqual([result.status, result.reason_code], ["quarantined", code]);
    assert.deepEqual(delta(before, await writeFootprint(db)), {}, code);
  }
  await db.close();
});

test("canonical fixture search fails closed on ambiguity, unknown competitions, postponements and reschedules", async () => {
  const db = await createLedgerDatabase();
  const cases: Array<[string, (s: Awaited<ReturnType<typeof scenario>>) => Promise<void>, { mint?: boolean; kickoffBefore?: string }?]> = [
    ["fixture_candidate_ambiguous", async (s) => { await canonicalFixture(db, s.seed, KICKOFF); await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, 3)); }],
    ["fixture_competition_unknown", async (s) => { await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, 48), { competitionId: null }); }],
    ["fixture_possible_postponement", async (s) => { await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, -24 * 60), { status: "postponed" }); }],
    ["fixture_possible_reschedule", async (s) => { await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, 24 * 7)); }],
    // One exact candidate is still not attached while a reschedule candidate exists.
    ["fixture_possible_reschedule", async (s) => { await canonicalFixture(db, s.seed, KICKOFF); await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, 24 * 10)); }],
    ["fixture_mint_not_permitted", async () => {}, { mint: false }],
    ["fixture_mint_not_permitted", async () => {}, { kickoffBefore: KICKOFF }],
  ];
  for (const [code, arrange, mint] of cases) {
    const s = await scenario(db);
    await arrange(s);
    const before = await writeFootprint(db);
    const result = await ingest(db, observationFrom(s.capture(), mint), SEEN);
    assert.deepEqual([result.status, result.reason_code, result.fixture_id], ["quarantined", code, null], code);
    assert.deepEqual(delta(before, await writeFootprint(db)), {}, code);
  }

  // Outside every window (20 days, not postponed) nothing blocks a mint.
  const clear = await scenario(db);
  await canonicalFixture(db, clear.seed, hoursFrom(KICKOFF, 24 * 20));
  assert.equal((await ingest(db, observationFrom(clear.capture()), SEEN)).fixture_resolution, "minted");
  await db.close();
});

test("historical trust boundary: teams need manual_override or confirmed at confidence 1, competitions manual_override; nothing is created", async () => {
  const db = await createLedgerDatabase();
  const teamsBefore = await countRows(db, "teams");
  const check = async (s: Awaited<ReturnType<typeof scenario>>, code: string, label = code) => {
    const before = await writeFootprint(db);
    const result = await ingest(db, observationFrom(s.capture()), SEEN);
    assert.deepEqual([result.status, result.reason_code], ["quarantined", code], label);
    assert.deepEqual(delta(before, await writeFootprint(db)), {}, label);
  };
  type Mapping = [status: string, confidence: number | null];
  const mapTeams = (s: Awaited<ReturnType<typeof scenario>>, home: Mapping, away: Mapping) =>
    db.query(
      `insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_status, mapping_confidence)
       values ('sportmonks', $1, $2, $3, $4), ('sportmonks', $5, $6, $7, $8)`,
      [s.ids.homeTeamId, s.seed.homeTeamId, ...home, s.ids.awayTeamId, s.seed.awayTeamId, ...away],
    );

  // The exact rule, as the database evaluates it everywhere it applies.
  const trusted = async (status: string | null, confidence: number | null) =>
    (await db.query<{ t: boolean }>("select private.provider_mapping_trusted($1, $2) as t", [status, confidence])).rows[0].t;
  assert.deepEqual(
    [await trusted("manual_override", null), await trusted("manual_override", 0.5), await trusted("confirmed", 1), await trusted("confirmed", 0.9999),
     await trusted("confirmed", null), await trusted("unverified", 1), await trusted(null, 1)],
    [true, true, true, false, false, false, false],
  );
  const competitionTrusted = async (status: string | null) =>
    (await db.query<{ t: boolean }>("select private.provider_competition_mapping_trusted($1) as t", [status])).rows[0].t;
  assert.deepEqual([await competitionTrusted("manual_override"), await competitionTrusted("confirmed"), await competitionTrusted("unverified"), await competitionTrusted(null)], [true, false, false, false]);

  // Accepted: confirmed at confidence 1 (the seed, as V3 writes provided ids) and manual_override at any confidence.
  const confirmedOne = await scenario(db);
  assert.equal((await ingest(db, observationFrom(confirmedOne.capture()), SEEN)).status, "recorded");
  const manual = await scenario(db, { mapTeams: false });
  await mapTeams(manual, ["manual_override", null], ["manual_override", 0.5]);
  assert.equal((await ingest(db, observationFrom(manual.capture()), SEEN)).status, "recorded");

  // Rejected: what V3 writes for name-resolved identities, and anything unverified.
  const untrustedTeams: Array<[string, Mapping, Mapping]> = [
    ["confirmed at confidence 0.9", ["confirmed", 0.9], ["confirmed", 1]],
    ["confirmed without confidence", ["confirmed", 1], ["confirmed", null]],
    ["unverified", ["unverified", 1], ["confirmed", 1]],
  ];
  for (const [label, home, away] of untrustedTeams) {
    const s = await scenario(db, { mapTeams: false });
    await mapTeams(s, home, away);
    await check(s, "team_untrusted", label);
  }
  await check(await scenario(db, { mapTeams: false }), "team_unmapped");
  const sameTeam = await scenario(db, { mapTeams: false });
  await db.query(
    "insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_confidence) values ('sportmonks', $1, $3, 1), ('sportmonks', $2, $3, 1)",
    [sameTeam.ids.homeTeamId, sameTeam.ids.awayTeamId, sameTeam.seed.homeTeamId],
  );
  await check(sameTeam, "team_identity_conflict");

  // Competitions: only manual_override (the table has no confidence column).
  await check(await scenario(db, { mapCompetition: false }), "competition_unmapped");
  for (const status of ["confirmed", "unverified"]) {
    const s = await scenario(db, { mapCompetition: false });
    await db.query(
      "insert into public.provider_competition_mappings (provider, provider_competition_id, competition_id, mapping_status) values ('sportmonks', $1, $2, $3)",
      [s.ids.leagueId, s.seed.competitionId, status],
    );
    await check(s, "competition_untrusted", status);
  }
  // Mappings are never promoted by ingest.
  assert.equal(await countRows(db, "provider_competition_mappings", "mapping_status = 'confirmed'"), 1);
  assert.equal(await countRows(db, "provider_team_mappings", "mapping_status = 'confirmed' and mapping_confidence = 0.9"), 1);
  // Only the test seeds created teams (2 per scenario).
  assert.equal(await countRows(db, "teams"), teamsBefore + 20);
  await db.close();
});

test("an existing fixture mapping pins history only when trusted: manual_override or confirmed at confidence 1", async () => {
  const db = await createLedgerDatabase();
  const cases: Array<[string, string, number | null, string | null]> = [
    ["confirmed at confidence 0.9 (V3 name resolution)", "confirmed", 0.9, "fixture_mapping_untrusted"],
    ["confirmed without confidence", "confirmed", null, "fixture_mapping_untrusted"],
    ["unverified", "unverified", 1, "fixture_mapping_unverified"],
    ["manual_override", "manual_override", null, null],
    ["confirmed at confidence 1", "confirmed", 1, null],
  ];
  for (const [label, status, confidence, code] of cases) {
    const s = await scenario(db);
    const fixtureId = await canonicalFixture(db, s.seed, KICKOFF);
    await mapFixture(db, fixtureId, s.providerFixtureId, status, confidence);
    const before = await writeFootprint(db);
    const result = await ingest(db, observationFrom(s.capture()), SEEN);
    if (code === null) {
      assert.deepEqual([result.status, result.fixture_resolution, result.fixture_id], ["recorded", "existing_mapping", fixtureId], label);
    } else {
      assert.deepEqual([result.status, result.reason_code, result.fixture_id], ["quarantined", code, fixtureId], label);
      assert.deepEqual(delta(before, await writeFootprint(db)), {}, label);
    }
  }
  await db.close();
});

test("player mappings: confirmed and manual_override are reused (merge-aware), missing ones bootstrap, unverified ones quarantine", async () => {
  const db = await createLedgerDatabase();
  const ledgerPlayer = async (observationId: string, providerPlayerId: string) =>
    (
      await db.query<{ player_id: string }>(
        "select player_id from public.match_ledger_players where observation_id = $1 and provider_player_id = $2",
        [observationId, providerPlayerId],
      )
    ).rows[0].player_id;

  // Confirmed mapping reused.
  const confirmed = await scenario(db);
  const known = "00000090-0000-4000-8000-000000000001";
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Known Player')", [known]);
  await db.query("insert into public.provider_player_mappings (provider, provider_player_id, player_id, mapping_status) values ('sportmonks', $1, $2, 'confirmed')", [
    String(confirmed.homeBase),
    known,
  ]);
  const reused = await ingest(db, observationFrom(confirmed.capture()), SEEN);
  assert.equal(reused.players_minted, 27);
  assert.equal(await ledgerPlayer(reused.observation_id!, String(confirmed.homeBase)), known);
  assert.equal(await countRows(db, "provider_player_mappings", "provider_player_id = $1", [String(confirmed.homeBase)]), 1);

  // manual_override reused, resolved to the current survivor of a merge.
  const manual = await scenario(db);
  const duplicate = "00000090-0000-4000-8000-000000000002";
  const survivor = "00000090-0000-4000-8000-000000000003";
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Duplicate'), ($2, 'Survivor')", [duplicate, survivor]);
  await db.query("insert into public.provider_player_mappings (provider, provider_player_id, player_id, mapping_status) values ('sportmonks', $1, $2, 'manual_override')", [
    String(manual.homeBase),
    duplicate,
  ]);
  await db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [duplicate, survivor]);
  const merged = await ingest(db, observationFrom(manual.capture()), SEEN);
  assert.equal(merged.players_minted, 27);
  assert.equal(await ledgerPlayer(merged.observation_id!, String(manual.homeBase)), survivor);

  // Unverified mapping: quarantine, no writes, no promotion, no second mapping.
  const unverified = await scenario(db);
  const suspect = "00000090-0000-4000-8000-000000000004";
  const suspectProviderId = String(unverified.homeBase + 5);
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Suspect')", [suspect]);
  await db.query("insert into public.provider_player_mappings (provider, provider_player_id, player_id, mapping_status) values ('sportmonks', $1, $2, 'unverified')", [
    suspectProviderId,
    suspect,
  ]);
  const before = await writeFootprint(db);
  const quarantined = await ingest(db, observationFrom(unverified.capture()), SEEN);
  assert.deepEqual([quarantined.status, quarantined.reason_code], ["quarantined", "player_mapping_unverified"]);
  assert.deepEqual(delta(before, await writeFootprint(db)), {});
  const suspectMappings = await db.query<{ mapping_status: string }>(
    "select mapping_status from public.provider_player_mappings where provider_player_id = $1 or player_id = $2",
    [suspectProviderId, suspect],
  );
  assert.deepEqual(suspectMappings.rows.map((r) => r.mapping_status), ["unverified"]);

  // After an explicit operator promotion the same capture ingests.
  await db.query("update public.provider_player_mappings set mapping_status = 'confirmed' where provider = 'sportmonks' and provider_player_id = $1", [suspectProviderId]);
  const promoted = await ingest(db, observationFrom(unverified.capture()), LATER);
  assert.equal(promoted.status, "recorded");
  assert.equal(promoted.players_minted, 27);
  assert.equal(await ledgerPlayer(promoted.observation_id!, suspectProviderId), suspect);
  await db.close();
});

test("identity-critical provider refs are sealed per version; drift quarantines; a withdrawal resets", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const first = await ingest(db, observationFrom(s.capture()), SEEN);
  assert.equal(first.status, "recorded");

  let before = await writeFootprint(db);
  const seasonDrift = await ingest(db, observationFrom(s.capture({ seasonId: "99999" })), LATER);
  assert.deepEqual([seasonDrift.status, seasonDrift.reason_code, seasonDrift.provider_refs_status, seasonDrift.observation_id], ["quarantined", "provider_ref_drift", "drift", first.observation_id]);
  assert.deepEqual(delta(before, await writeFootprint(db)), {});

  // A second provider team id mapped to the same canonical team is still drift.
  await db.query("insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_confidence) values ('sportmonks', '96001', $1, 1)", [s.seed.homeTeamId]);
  before = await writeFootprint(db);
  const teamDrift = await ingest(db, observationFrom(s.capture({ homeTeamId: "96001" })), LATER);
  assert.deepEqual([teamDrift.status, teamDrift.reason_code], ["quarantined", "provider_ref_drift"]);
  assert.deepEqual(delta(before, await writeFootprint(db)), {});

  // A withdrawal hides the attachment; the next observation is a new attachment.
  await recordObservation(
    db,
    buildMatchLedgerWithdrawalPayload({
      fixtureId: first.fixture_id!,
      provider: "sportmonks",
      providerFixtureId: s.providerFixtureId,
      captureMode: "backfill",
      ingestVersion: "test",
      retrievedAt: LATER,
      withdrawalReason: "synthetic withdrawal",
    }),
    LATER,
  );
  const reattached = await ingest(db, observationFrom(s.capture({ seasonId: "99999" })), "2026-10-30T11:00:00.000Z");
  assert.deepEqual([reattached.status, reattached.observation_version, reattached.provider_refs_status], ["recorded", 3, "recorded"]);

  // A latest version written without annotations (plain 1A write) cannot be compared.
  const plain = await scenario(db);
  const fixtureId = await canonicalFixture(db, plain.seed, KICKOFF, { status: "finished" });
  await mapFixture(db, fixtureId, plain.providerFixtureId);
  await recordObservation(
    db,
    buildMatchLedgerObservationPayload({
      fixtureId,
      provider: "sportmonks",
      providerFixtureId: plain.providerFixtureId,
      captureMode: "scheduled_sync",
      ingestVersion: "v3-structured-sync",
      retrievedAt: CAPTURED,
      kickoffAt: KICKOFF,
      matchStatus: "finished",
      homeGoals90: 2,
      awayGoals90: 1,
      teams: [
        { teamId: plain.seed.homeTeamId, side: "home", lineupStatus: "not_provided", substitutionsStatus: "not_provided", eventsStatus: "not_provided", statisticsStatus: "not_provided" },
        { teamId: plain.seed.awayTeamId, side: "away", lineupStatus: "not_provided", substitutionsStatus: "not_provided", eventsStatus: "not_provided", statisticsStatus: "not_provided" },
      ],
    }),
    SEEN,
  );
  before = await writeFootprint(db);
  const unrecorded = await ingest(db, observationFrom(plain.capture()), LATER);
  assert.deepEqual([unrecorded.status, unrecorded.reason_code, unrecorded.provider_refs_status], ["quarantined", "provider_refs_unrecorded", "unrecorded"]);
  assert.deepEqual(delta(before, await writeFootprint(db)), {});
  await db.close();
});

test("family fetch status: failed quarantines, downgrades quarantine, upgrades version only with new content", async () => {
  const db = await createLedgerDatabase();
  const run = await createIngestRun(db);

  const failed = await scenario(db);
  let before = await writeFootprint(db);
  const failedResult = await ingest(db, observationFrom(failed.capture({ families: { xg: "failed" } })), SEEN);
  assert.deepEqual([failedResult.status, failedResult.reason_code], ["quarantined", "family_fetch_failed"]);
  assert.deepEqual(delta(before, await writeFootprint(db)), {});

  const downgrade = await scenario(db);
  await ingest(db, observationFrom(downgrade.capture()), SEEN);
  before = await writeFootprint(db);
  const downgraded = await ingest(db, observationFrom(downgrade.capture({ families: { xg: "not_requested" } })), LATER);
  assert.deepEqual([downgraded.status, downgraded.reason_code], ["quarantined", "family_status_downgrade"]);
  assert.deepEqual(delta(before, await writeFootprint(db)), {});

  const upgrade = await scenario(db);
  const v1 = await ingest(db, observationFrom(upgrade.capture({ families: { xg: "not_requested" } })), SEEN);
  const v2 = await ingest(db, observationFrom(upgrade.capture()), LATER);
  assert.deepEqual([v2.status, v2.observation_version, v2.provider_refs_status], ["recorded", 2, "matched"]);
  const xgStatus = async (observationId: string) =>
    (await db.query<{ fetch_status: string }>("select fetch_status from public.match_ledger_observation_family_fetches where observation_id = $1 and family = 'xg'", [observationId]))
      .rows[0].fetch_status;
  assert.equal(await xgStatus(v1.observation_id!), "not_requested");
  assert.equal(await xgStatus(v2.observation_id!), "fetched");

  // Same canonical content, new family status: cannot be a new version -> quarantine, nothing kept.
  const drift = await scenario(db);
  await ingest(db, observationFrom(drift.capture({ families: { xg: "not_requested" } })), SEEN);
  const emptyXg = drift.capture();
  emptyXg.families.xg.rows = [];
  before = await writeFootprint(db);
  const drifted = await ingest(db, observationFrom(emptyXg, { runId: run }), LATER);
  assert.deepEqual([drifted.status, drifted.reason_code, drifted.attempt_no], ["quarantined", "family_status_drift", 1]);
  assert.deepEqual(delta(before, await writeFootprint(db)), {});
  const item = (await db.query<{ status: string; reason_code: string }>("select status, reason_code from public.provider_ingest_items where run_id = $1", [run])).rows;
  assert.deepEqual(item, [{ status: "quarantined", reason_code: "family_status_drift" }]);
  await db.close();
});

test("unfinished or implausibly early finished matches are quarantined, not written", async () => {
  const db = await createLedgerDatabase();
  const notFinished = await scenario(db);
  let before = await writeFootprint(db);
  assert.equal((await ingest(db, observationFrom(notFinished.capture({ state: "POSTPONED" })), SEEN)).reason_code, "not_finished");
  assert.deepEqual(delta(before, await writeFootprint(db)), {});

  const early = await scenario(db);
  before = await writeFootprint(db);
  const result = await ingest(db, observationFrom(early.capture({ kickoffAt: hoursFrom(SEEN, -1) }), { kickoffBefore: SEEN }), SEEN);
  assert.equal(result.reason_code, "finished_too_early");
  assert.deepEqual(delta(before, await writeFootprint(db)), {});
  await db.close();
});

test("a failure anywhere in the write phase rolls back mints, players and the ledger write", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const before = await writeFootprint(db);

  const unknownStat = buildProviderMatchObservationPayload(observationFrom(s.capture())) as any;
  unknownStat.team_stats[0].provider_stat_type = "99999";
  await assert.rejects(ingest(db, unknownStat, SEEN), /unknown stat definition/);
  assert.deepEqual(delta(before, await writeFootprint(db)), {});

  // The 1A ledger write itself fails (two starters in one formation slot).
  const slotClash = buildProviderMatchObservationPayload(observationFrom(s.capture())) as any;
  slotClash.players[1].formation_position = 1;
  await assert.rejects(ingest(db, slotClash, SEEN));
  assert.deepEqual(delta(before, await writeFootprint(db)), {});

  assert.equal((await ingest(db, observationFrom(s.capture()), SEEN)).status, "recorded");
  await db.close();
});

async function advisoryLockModes(db: PGlite, key: string): Promise<string[]> {
  const result = await db.query<{ mode: string }>(
    `select mode from pg_locks
     where locktype = 'advisory' and objsubid = 1
       and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return result.rows.map((row) => row.mode).sort();
}

test("lock order: provider fixture, canonical team pair, fixture/provider, players identity; READ COMMITTED only", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const payload = JSON.stringify(buildProviderMatchObservationPayload(observationFrom(s.capture())));
  await setClock(db, SEEN);

  await db.exec("begin");
  const result = (await db.query<{ r: { fixture_id: string } }>("select public.match_ledger_ingest_provider_fixture($1::jsonb) as r", [payload])).rows[0].r;
  assert.deepEqual(await advisoryLockModes(db, `kapiloto_match_ledger_provider_fixture:sportmonks:${s.providerFixtureId}`), ["ExclusiveLock"]);
  assert.deepEqual(await advisoryLockModes(db, pairKey(s.seed)), ["ExclusiveLock"]);
  assert.deepEqual(await advisoryLockModes(db, `kapiloto_match_ledger_fixture:${result.fixture_id}:sportmonks`), ["ExclusiveLock"]);
  assert.ok((await advisoryLockModes(db, "kapiloto_identity:players")).includes("ExclusiveLock"));
  await db.exec("rollback");

  // A quarantine decided in phase 1 holds only the provider-fixture lock.
  const unmapped = await scenario(db, { mapTeams: false });
  await db.exec("begin");
  await db.query("select public.match_ledger_ingest_provider_fixture($1::jsonb)", [
    JSON.stringify(buildProviderMatchObservationPayload(observationFrom(unmapped.capture()))),
  ]);
  assert.deepEqual(await advisoryLockModes(db, `kapiloto_match_ledger_provider_fixture:sportmonks:${unmapped.providerFixtureId}`), ["ExclusiveLock"]);
  assert.deepEqual(await advisoryLockModes(db, "kapiloto_identity:players"), []);
  await db.exec("rollback");

  await db.exec("begin isolation level repeatable read");
  await assert.rejects(db.query("select public.match_ledger_ingest_provider_fixture($1::jsonb)", [payload]), /READ COMMITTED/);
  await db.exec("rollback");
  await db.close();
});

test("ingest audit: append-only attempts, failures, run binding and immutability", async () => {
  const db = await createLedgerDatabase();
  const rpc = pgliteRpc(db);
  const run = await createIngestRun(db);

  const unmapped = await scenario(db, { mapTeams: false });
  await setClock(db, SEEN);
  const first = await recordProviderMatchObservation(rpc, observationFrom(unmapped.capture(), { runId: run }));
  const second = await recordProviderMatchObservation(rpc, observationFrom(unmapped.capture(), { runId: run }));
  assert.deepEqual([first.status, first.reason_code, first.attempt_no, second.attempt_no], ["quarantined", "team_unmapped", 1, 2]);

  const good = await scenario(db);
  const recorded = await recordProviderMatchObservation(rpc, observationFrom(good.capture(), { runId: run }));
  assert.deepEqual([recorded.status, recorded.attempt_no], ["recorded", 1]);
  const failure = await recordProviderIngestFailure(rpc, {
    runId: run,
    provider: "sportmonks",
    providerFixtureId: good.providerFixtureId,
    reasonCode: "capture_parse_error",
    detail: { code: "score_90_unavailable" },
  });
  assert.deepEqual([failure.status, failure.reason_code, failure.attempt_no], ["failed", "capture_parse_error", 2]);
  const items = await db.query<{ provider_fixture_id: string; attempt_no: number; status: string; reason_code: string | null; observation_id: string | null; detail: Record<string, unknown> }>(
    "select provider_fixture_id, attempt_no, status, reason_code, observation_id, detail from public.provider_ingest_items where run_id = $1 order by provider_fixture_id, attempt_no",
    [run],
  );
  assert.deepEqual(items.rows.map((r) => [r.provider_fixture_id, r.attempt_no, r.status, r.reason_code]), [
    [unmapped.providerFixtureId, 1, "quarantined", "team_unmapped"],
    [unmapped.providerFixtureId, 2, "quarantined", "team_unmapped"],
    [good.providerFixtureId, 1, "recorded", null],
    [good.providerFixtureId, 2, "failed", "capture_parse_error"],
  ]);
  assert.equal(items.rows[2].observation_id, recorded.observation_id);
  assert.equal(items.rows[2].detail.fixture_resolution, "minted");

  await assert.rejects(db.query("update public.provider_ingest_items set status = 'recorded'"), /immutable/);
  await assert.rejects(db.query("delete from public.provider_ingest_runs"), /immutable/);
  await assert.rejects(
    recordProviderMatchObservation(rpc, { ...observationFrom(good.capture()), rawPayloadSha256: "x" }),
    /invalid provider match observation/,
  );

  const otherProvider = await createIngestRun(db, { provider: "api_football" });
  await assert.rejects(ingest(db, observationFrom((await scenario(db, { mapTeams: false })).capture(), { runId: otherProvider }), SEEN), /belongs to provider/);

  const capped = await createIngestRun(db, { fixtureMintKickoffBefore: "2026-08-01T00:00:00.000Z" });
  await assert.rejects(ingest(db, observationFrom((await scenario(db)).capture(), { runId: capped }), SEEN), /exceeds the bound/);
  await db.close();
});

test("observation annotations are sealed to their writing statement and immutable", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const result = await ingest(db, observationFrom(s.capture()), SEEN);
  await assert.rejects(
    db.query("insert into public.match_ledger_observation_provider_refs (observation_id, ref_kind, provider_ref) values ($1, 'league', '1')", [result.observation_id]),
    /sealed/,
  );
  await assert.rejects(
    db.query("insert into public.match_ledger_observation_family_fetches (observation_id, family, fetch_status) values ($1, 'xg', 'fetched')", [result.observation_id]),
    /sealed/,
  );
  await assert.rejects(db.query("update public.match_ledger_observation_provider_refs set provider_ref = '1'"), /immutable/);
  await assert.rejects(db.query("delete from public.match_ledger_observation_family_fetches"), /immutable/);
  await assert.rejects(db.query("update public.match_ledger_fixture_mints set kickoff_before = now()"), /immutable/);
  await assert.rejects(db.query("truncate public.match_ledger_fixture_mints"), /immutable/);
  await assert.rejects(
    db.query("insert into public.match_ledger_fixture_mints (fixture_id, provider, provider_fixture_id, kickoff_before) values ($1, 'sportmonks', 'nope', now())", [result.fixture_id]),
  );
  await db.close();
});

// ---------------------------------------------------------------------------
// Canonical fixture identity: a fixture already identified with another
// provider fixture id never disappears from the attach/mint decision.
// ---------------------------------------------------------------------------

const otherId = (s: Awaited<ReturnType<typeof scenario>>, k = 1) => String(Number(s.providerFixtureId) + 500_000 * k);
const pairKey = (seed: IngestSeed) => `kapiloto_canonical_fixture_pair:${[seed.homeTeamId, seed.awayTeamId].sort().join(":")}`;

async function sportmonksMappings(db: PGlite, fixtureId: string) {
  return (
    await db.query<{ provider_fixture_id: string; mapping_status: string }>(
      "select provider_fixture_id, mapping_status from public.provider_fixture_mappings where provider = 'sportmonks' and fixture_id = $1",
      [fixtureId],
    )
  ).rows;
}

test("a second provider fixture id for an attached match is quarantined even when minting is allowed", async () => {
  const db = await createLedgerDatabase();
  const run = await createIngestRun(db);
  const s = await scenario(db);
  const fixtureId = await canonicalFixture(db, s.seed, KICKOFF);
  const x = await ingest(db, observationFrom(s.capture()), SEEN);
  assert.deepEqual([x.status, x.fixture_resolution, x.fixture_id], ["recorded", "attached", fixtureId]);

  const before = await writeFootprint(db);
  const y = await ingest(db, observationFrom(s.capture({ providerFixtureId: otherId(s) }), { mint: true, runId: run }), LATER);
  assert.deepEqual([y.status, y.reason_code, y.fixture_id], ["quarantined", "fixture_provider_identity_conflict", null]);
  assert.deepEqual(delta(before, await writeFootprint(db)), {});
  assert.deepEqual(await sportmonksMappings(db, fixtureId), [{ provider_fixture_id: s.providerFixtureId, mapping_status: "confirmed" }]);
  assert.equal(await countRows(db, "provider_fixture_mappings", "provider_fixture_id = $1", [otherId(s)]), 0);
  assert.equal(await countRows(db, "match_ledger_observations", "provider_fixture_id = $1", [otherId(s)]), 0);
  const detail = (await db.query<{ detail: Record<string, unknown> }>("select detail from public.provider_ingest_items where run_id = $1", [run])).rows[0].detail;
  assert.deepEqual(detail.conflicting_provider_fixture_ids, [s.providerFixtureId]);
  assert.equal(detail.attach_window, 1);
  await db.close();
});

test("a second provider fixture id for a match the first one minted is quarantined; only one canonical fixture exists", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const x = await ingest(db, observationFrom(s.capture()), SEEN);
  assert.equal(x.fixture_resolution, "minted");
  const before = await writeFootprint(db);
  const y = await ingest(db, observationFrom(s.capture({ providerFixtureId: otherId(s), kickoffAt: hoursFrom(KICKOFF, 2) }), { mint: true }), LATER);
  assert.deepEqual([y.status, y.reason_code], ["quarantined", "fixture_provider_identity_conflict"]);
  assert.deepEqual(delta(before, await writeFootprint(db)), {});
  assert.equal(await countRows(db, "fixtures", "home_team_id = $1 and away_team_id = $2", [s.seed.homeTeamId, s.seed.awayTeamId]), 1);
  await db.close();
});

test("fixtures identified with another provider fixture id participate in every guard window", async () => {
  const db = await createLedgerDatabase();
  const cases: Array<[string, string, (s: Awaited<ReturnType<typeof scenario>>) => Promise<void>]> = [
    ["attach window", "fixture_provider_identity_conflict", async (s) => mapFixture(db, await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, 1)), otherId(s))],
    ["reschedule window", "fixture_provider_identity_conflict", async (s) => mapFixture(db, await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, 24 * 7)), otherId(s))],
    ["postponement window", "fixture_provider_identity_conflict", async (s) => mapFixture(db, await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, -24 * 60), { status: "postponed" }), otherId(s))],
    ["unknown competition", "fixture_provider_identity_conflict", async (s) => mapFixture(db, await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, 48), { competitionId: null }), otherId(s))],
    ["unverified mapping", "fixture_provider_identity_conflict", async (s) => mapFixture(db, await canonicalFixture(db, s.seed, KICKOFF), otherId(s), "unverified")],
    [
      "ledger history without a mapping",
      "fixture_provider_identity_conflict",
      async (s) => {
        await canonicalFixture(db, s.seed, KICKOFF);
        await ingest(db, observationFrom(s.capture({ providerFixtureId: otherId(s) })), SEEN);
        await db.query("delete from public.provider_fixture_mappings where provider = 'sportmonks' and provider_fixture_id = $1", [otherId(s)]);
      },
    ],
    // A mapped candidate plus an unmapped one: the identity conflict is reported first.
    [
      "mapped and unmapped candidates",
      "fixture_provider_identity_conflict",
      async (s) => {
        await mapFixture(db, await canonicalFixture(db, s.seed, KICKOFF), otherId(s));
        await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, 2));
      },
    ],
  ];
  for (const [label, code, arrange] of cases) {
    const s = await scenario(db);
    await arrange(s);
    const before = await writeFootprint(db);
    const result = await ingest(db, observationFrom(s.capture(), { mint: true }), LATER);
    assert.deepEqual([result.status, result.reason_code, result.fixture_id], ["quarantined", code, null], label);
    assert.deepEqual(delta(before, await writeFootprint(db)), {}, label);
  }

  // Outside every window a fixture mapped to another id is a different match.
  const far = await scenario(db);
  await mapFixture(db, await canonicalFixture(db, far.seed, hoursFrom(KICKOFF, 24 * 20)), otherId(far));
  assert.equal((await ingest(db, observationFrom(far.capture()), LATER)).fixture_resolution, "minted");
  await db.close();
});

test("reversed orientation and other competitions within 48 hours block attach and mint; legs a week apart do not", async () => {
  const db = await createLedgerDatabase();
  const cases: Array<[string, string, (s: Awaited<ReturnType<typeof scenario>>) => Promise<void>]> = [
    ["reversed orientation", "fixture_orientation_conflict", async (s) => void (await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, 1), { swap: true }))],
    [
      "other competition",
      "fixture_competition_conflict",
      async (s) => {
        const other = await seedIngestIdentities(db, { mapCompetition: false, mapTeams: false });
        await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, 1), { competitionId: other.competitionId });
      },
    ],
    ["reversed and mapped", "fixture_provider_identity_conflict", async (s) => mapFixture(db, await canonicalFixture(db, s.seed, KICKOFF, { swap: true }), otherId(s))],
  ];
  for (const [label, code, arrange] of cases) {
    const s = await scenario(db);
    await arrange(s);
    const before = await writeFootprint(db);
    const result = await ingest(db, observationFrom(s.capture()), LATER);
    assert.deepEqual([result.status, result.reason_code], ["quarantined", code], label);
    assert.deepEqual(delta(before, await writeFootprint(db)), {}, label);
  }
  const secondLeg = await scenario(db);
  await canonicalFixture(db, secondLeg.seed, hoursFrom(KICKOFF, -24 * 7), { swap: true });
  assert.equal((await ingest(db, observationFrom(secondLeg.capture()), LATER)).fixture_resolution, "minted");
  const otherCompetitionLater = await scenario(db);
  const other = await seedIngestIdentities(db, { mapCompetition: false, mapTeams: false });
  await canonicalFixture(db, otherCompetitionLater.seed, hoursFrom(KICKOFF, 24 * 4), { competitionId: other.competitionId });
  assert.equal((await ingest(db, observationFrom(otherCompetitionLater.capture()), LATER)).fixture_resolution, "minted");
  await db.close();
});

test("an authoritative mapping still wins next to another candidate; a re-pointed mapping cannot continue another id's chain", async () => {
  const db = await createLedgerDatabase();

  const s = await scenario(db);
  const mapped = await canonicalFixture(db, s.seed, KICKOFF);
  await canonicalFixture(db, s.seed, hoursFrom(KICKOFF, 3));
  await mapFixture(db, mapped, s.providerFixtureId);
  const x = await ingest(db, observationFrom(s.capture()), SEEN);
  assert.deepEqual([x.status, x.fixture_resolution, x.fixture_id], ["recorded", "existing_mapping", mapped]);
  assert.equal((await ingest(db, observationFrom(s.capture({ providerFixtureId: otherId(s) })), LATER)).reason_code, "fixture_provider_identity_conflict");

  // A V3-style upsert re-points F's mapping from Z to X.
  const r = await scenario(db);
  const fixtureId = await canonicalFixture(db, r.seed, KICKOFF);
  const z = await ingest(db, observationFrom(r.capture()), SEEN);
  assert.equal(z.fixture_resolution, "attached");
  await db.query("update public.provider_fixture_mappings set provider_fixture_id = $1 where provider = 'sportmonks' and fixture_id = $2", [otherId(r), fixtureId]);
  const before = await writeFootprint(db);
  const repointed = await ingest(db, observationFrom(r.capture({ providerFixtureId: otherId(r) })), LATER);
  assert.deepEqual([repointed.status, repointed.reason_code, repointed.fixture_id, repointed.observation_id], ["quarantined", "provider_fixture_id_drift", fixtureId, z.observation_id]);
  const orphan = await ingest(db, observationFrom(r.capture()), LATER);
  assert.deepEqual([orphan.status, orphan.reason_code], ["quarantined", "fixture_provider_identity_conflict"]);
  assert.deepEqual(delta(before, await writeFootprint(db)), {});
  await db.close();
});

test("interleaving: the unordered team-pair lock covers search, decision and write; the next caller sees the committed mapping", async () => {
  const db = await createLedgerDatabase();
  const s = await scenario(db);
  const key = pairKey(s.seed);
  const payload = (overrides: Partial<SyntheticCaptureOptions>) => JSON.stringify(buildProviderMatchObservationPayload(observationFrom(s.capture(overrides), { mint: true })));
  await setClock(db, SEEN);

  // First caller: decides and mints while holding the pair lock.
  await db.exec("begin");
  const x = (await db.query<{ r: { status: string; fixture_resolution: string; fixture_id: string } }>("select public.match_ledger_ingest_provider_fixture($1::jsonb) as r", [payload({})])).rows[0].r;
  assert.deepEqual([x.status, x.fixture_resolution], ["recorded", "minted"]);
  assert.deepEqual(await advisoryLockModes(db, key), ["ExclusiveLock"]);
  assert.equal(await countRows(db, "provider_fixture_mappings", "provider_fixture_id = $1 and fixture_id = $2", [s.providerFixtureId, x.fixture_id]), 1);
  await db.exec("commit");
  assert.deepEqual(await advisoryLockModes(db, key), []);

  // Second caller: same pair key; its candidate query runs after the lock and sees the committed mapping.
  await db.exec("begin");
  const y = (await db.query<{ r: { status: string; reason_code: string } }>("select public.match_ledger_ingest_provider_fixture($1::jsonb) as r", [payload({ providerFixtureId: otherId(s) })])).rows[0].r;
  assert.deepEqual([y.status, y.reason_code], ["quarantined", "fixture_provider_identity_conflict"]);
  assert.deepEqual(await advisoryLockModes(db, key), ["ExclusiveLock"]);
  await db.exec("commit");

  // Reversed orientation (and any competition) serializes on the same key.
  await db.exec("begin");
  await db.query("select public.match_ledger_ingest_provider_fixture($1::jsonb)", [
    payload({ providerFixtureId: otherId(s, 2), homeTeamId: s.ids.awayTeamId, awayTeamId: s.ids.homeTeamId }),
  ]);
  assert.deepEqual(await advisoryLockModes(db, key), ["ExclusiveLock"]);
  await db.exec("rollback");
  assert.equal(await countRows(db, "fixtures", "(home_team_id = $1 and away_team_id = $2) or (home_team_id = $2 and away_team_id = $1)", [s.seed.homeTeamId, s.seed.awayTeamId]), 1);
  await db.close();
});

// ---------------------------------------------------------------------------
// Capture quality flags: per-attempt audit metadata, never ledger content.
// ---------------------------------------------------------------------------

test("capture quality flags are stored on every run-bound attempt and never change ledger content", async () => {
  const db = await createLedgerDatabase();
  const run = await createIngestRun(db);
  const s = await scenario(db);
  const items = async () =>
    (
      await db.query<{ status: string; reason_code: string | null; detail: Record<string, unknown> }>(
        "select status, reason_code, detail from public.provider_ingest_items where run_id = $1 order by created_at, attempt_no",
        [run],
      )
    ).rows;

  const clean = await ingest(db, observationFrom(s.capture(), { runId: run }), SEEN);
  // Same football content, one ignored out-of-family row: unchanged, new flags.
  const outside = s.capture();
  outside.families.statistics.rows.push({ type_id: 5304, participant_id: Number(s.ids.homeTeamId), data: { value: 9 }, type: { developer_name: "EXPECTED_GOALS" } });
  const flagged = await ingest(db, observationFrom(outside, { runId: run }), LATER);
  assert.equal(clean.status, "recorded");
  assert.deepEqual([flagged.status, flagged.observation_id, flagged.observation_version], ["unchanged", clean.observation_id, 1]);
  assert.equal(await countRows(db, "match_ledger_observations", "fixture_id = $1", [clean.fixture_id]), 1);

  const unmapped = await scenario(db, { mapTeams: false });
  const duplicateShirt = unmapped.capture();
  (duplicateShirt.families.lineups.rows[1] as { jersey_number: number }).jersey_number = 1;
  const quarantined = await ingest(db, observationFrom(duplicateShirt, { runId: run }), LATER);
  assert.equal(quarantined.reason_code, "team_unmapped");
  await recordProviderIngestFailure(pgliteRpc(db), { runId: run, provider: "sportmonks", providerFixtureId: "1", reasonCode: "capture_parse_error" });

  const stored = await items();
  assert.deepEqual(
    stored.map((i) => [i.status, i.reason_code, i.detail.capture_quality_flags ?? "absent"]),
    [
      ["recorded", null, []],
      ["unchanged", null, ["stat_type_outside_family"]],
      ["quarantined", "team_unmapped", ["duplicate_shirt_number"]],
      ["failed", "capture_parse_error", "absent"],
    ],
  );
  await db.close();
});

test("the ingest RPC accepts only a bounded array of known capture quality flags and stores it sorted", async () => {
  const db = await createLedgerDatabase();
  const run = await createIngestRun(db);
  const s = await scenario(db, { mapTeams: false });
  const base = buildProviderMatchObservationPayload(observationFrom(s.capture(), { runId: run })) as Record<string, unknown>;
  const withFlags = (flags: unknown) => ({ ...base, capture_quality_flags: flags });
  const { capture_quality_flags: _omitted, ...missing } = base;

  await assert.rejects(ingest(db, withFlags(["type_drift"]), SEEN), /capture_quality_flags/);
  await assert.rejects(ingest(db, withFlags("formation_invalid"), SEEN), /capture_quality_flags/);
  await assert.rejects(ingest(db, withFlags([1]), SEEN), /capture_quality_flags/);
  await assert.rejects(ingest(db, withFlags(Array.from({ length: 33 }, () => "formation_invalid")), SEEN), /capture_quality_flags/);
  await assert.rejects(ingest(db, missing, SEEN), /capture_quality_flags/);
  assert.equal(await countRows(db, "provider_ingest_items", "run_id = $1", [run]), 0);

  await ingest(db, withFlags(["formation_invalid", "duplicate_shirt_number", "formation_invalid"]), SEEN);
  const detail = (await db.query<{ detail: Record<string, unknown> }>("select detail from public.provider_ingest_items where run_id = $1", [run])).rows[0].detail;
  assert.deepEqual(detail.capture_quality_flags, ["duplicate_shirt_number", "formation_invalid"]);
  await db.close();
});
