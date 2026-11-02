import type { PGlite } from "@electric-sql/pglite";

import type { ResolutionStatus } from "../claims";
import { buildLineupForecast } from "../lineup-model";
import { buildLineupForecastSnapshot, lineupModelInput, loadLineupSquadInputs, type LineupSnapshotMeta } from "../lineup-snapshot";
import { buildPredictionSnapshotV2Payload, type PredictionSnapshotV2Input, type RecordPredictionSnapshotResult } from "../prediction-registry";
import {
  buildFixtureSquadStateFor,
  historySelectionPolicy,
  loadSquadStateInputs,
  type HistorySelectionPolicy,
  type SquadStateBuilderVersion,
  type SquadStateInputs,
  type SquadStateRpc,
} from "../squad-state";
import { SQUAD_STATE_BUILDER_VERSION, SQUAD_STATE_READ_V1_VERSION, SQUAD_STATE_READ_V2_VERSION, type SquadStateReadVersion } from "../versions";
import { attestTeam, canonicalFixtureFor, createScopedRun, ingestV2, seedAttestedIdentities, SYNTHETIC_ATTESTED_AT } from "./attestation-fixtures";
import { addObservation, articleInput, recordClaim, recordDocument, recordResolution } from "./knowledge-fixtures";
import { createFixture, createLedgerDatabase, realisticObservation, recordObservation, resultOnlyObservation, seedLedger, setClock, type LedgerSeed } from "./ledger-fixtures";
import { observationFrom, syntheticCapture } from "./provider-ingest-fixtures";
import { insertMembership, membershipKey } from "./roster-fixtures";

export const LINEUP_KICKOFF = "2026-11-02T18:00:00.000Z";
export const LINEUP_CUTOFF = "2026-10-30T12:00:00.000Z";
export const LINEUP_RECORDED = "2026-10-30T12:10:00.000Z";
export const LINEUP_POLICY = historySelectionPolicy(["sportmonks", "api_football"]);

export async function recordPredictionV2(
  db: PGlite,
  input: PredictionSnapshotV2Input | Record<string, unknown>,
  clock: string,
): Promise<RecordPredictionSnapshotResult> {
  await setClock(db, clock);
  const payload = "contract_version" in input ? input : buildPredictionSnapshotV2Payload(input as PredictionSnapshotV2Input);
  const result = await db.query<{ result: RecordPredictionSnapshotResult }>(
    "select public.prediction_record_snapshot_v2($1::jsonb) as result",
    [JSON.stringify(payload)],
  );
  return result.rows[0].result;
}

let tenureCounter = 0;

export async function insertTenure(db: PGlite, teamId: string, coachId: string, clock: string): Promise<string> {
  tenureCounter += 1;
  await setClock(db, clock);
  const result = await db.query<{ id: string }>(
    `insert into public.team_coach_tenures (tenure_key, team_id, coach_id, starts_on_earliest, starts_on_latest, source_kind, ingest_version)
     values ($1, $2, $3, '2026-07-01', '2026-07-01', 'official_club', 'test') returning id`,
    [`93000000-0000-4000-8000-${String(tenureCounter).padStart(12, "0")}`, teamId, coachId],
  );
  return result.rows[0].id;
}

function squadRpc(db: PGlite): SquadStateRpc {
  return async (fn, args) =>
    (await db.query<{ r: unknown }>(`select public.${fn}($1, $2, $3, $4) as r`, [args.p_fixture_id, args.p_team_id, args.p_cutoff, args.p_history_fixture_limit ?? 30])).rows[0].r;
}

type TeamPlayers = { teamId: string; playerIds: string[] };

let docCounter = 0;

/**
 * Target-fixture claims for a home-team forecast (doubtful, starts, benched,
 * a late one first seen after the cutoff, one about the opponent) and a
 * later resolution version of the "doubtful" belief.
 */
async function seedTargetClaims(db: PGlite, targetFixtureId: string, home: TeamPlayers, away: TeamPlayers) {
  const claim = async (
    playerId: string,
    teamId: string | null,
    claimType: "player_availability" | "expected_lineup",
    value: { status?: string; predicate?: string },
    status: ResolutionStatus | null,
    at = "2026-10-28T09:00:00.000Z",
    resolvedAt = "2026-10-29T09:00:00.000Z",
  ) => {
    const recorded = await recordClaim(db, {
      claimKind: "reported_expectation",
      claimType,
      predicate: claimType === "player_availability" ? "availability_status" : value.predicate!,
      fixtureId: targetFixtureId,
      teamId,
      playerId,
      objectValue: value.status ? { status: value.status } : {},
      temporalScope: "fixture",
    }, at);
    docCounter += 1;
    const doc = await recordDocument(db, articleInput({ extractedText: `Lineup report ${docCounter}.`, retrievedAt: at }), at);
    const observation = await addObservation(db, { claimId: recorded.claim_id, documentVersionId: doc.document_version_id, relationship: "supports" }, at);
    let resolutionId: string | null = null;
    if (status) {
      const resolution = await recordResolution(db, {
        claimId: recorded.claim_id,
        status,
        resolverKind: "grounding",
        resolverVersion: "g1",
        reasonCode: "test_resolution",
        qualityFlags: status === "verified_degraded" ? ["missing_author"] : [],
        evidence: [{ evidenceRole: "supporting", claimObservationId: observation.id }],
      }, resolvedAt);
      resolutionId = resolution.resolution_id;
    }
    return { claimId: recorded.claim_id, resolutionId, observationId: observation.id };
  };
  const claims = {
    doubtful: await claim(home.playerIds[3], home.teamId, "player_availability", { status: "doubtful" }, "verified"),
    starts: await claim(home.playerIds[12], home.teamId, "expected_lineup", { predicate: "starts" }, "verified"),
    benched: await claim(home.playerIds[2], home.teamId, "expected_lineup", { predicate: "on_bench" }, "verified_degraded"),
    away: await claim(away.playerIds[0], away.teamId, "player_availability", { status: "out" }, "verified"),
    late: await claim(home.playerIds[5], home.teamId, "player_availability", { status: "out" }, "verified", "2026-10-31T09:00:00.000Z", "2026-10-31T10:00:00.000Z"),
  };
  // After the cutoff, the "doubtful" belief gets a new resolution version.
  const lateResolution = await recordResolution(db, {
    claimId: claims.doubtful.claimId,
    status: "verified_degraded",
    resolverKind: "grounding",
    resolverVersion: "g2",
    reasonCode: "later_review",
    qualityFlags: ["missing_author"],
    evidence: [{ evidenceRole: "supporting", claimObservationId: claims.doubtful.observationId }],
  }, "2026-10-31T11:00:00.000Z");
  return { claims, lateResolutionId: lateResolution.resolution_id };
}

/**
 * One target fixture (home vs away) with everything a home-team lineup
 * forecast reads, plus the out-of-scope rows the registry must refuse:
 * opponent memberships/tenures/claims, rows first seen after the cutoff, a
 * later resolution version, a backfilled history observation and a match
 * that does not involve the home team.
 *
 * READ-V1 WORLD. Its history is plain 1A observations (rich lineups,
 * substitutions, coaches, two providers) with no sealed provider refs or
 * Stage 1 attestations, so only the frozen kapiloto-squad-state-read-v1 sees
 * it: forecasts here are explicitly read-v1. These tests cover the
 * registry's read-v1 branch (frozen and legacy snapshots, offline replay)
 * and the builder/registry guards on rich history. The trusted production
 * path is setupAttestedLineupWorld.
 */
export async function setupReadV1LineupWorld(options: { supabaseDefaultPrivileges?: boolean; exclude?: RegExp } = {}) {
  const db = await createLedgerDatabase(options);
  const seed = await seedLedger(db);
  const { home, away } = seed;
  const target = await createFixture(db, seed, LINEUP_KICKOFF);
  const rpc = squadRpc(db);

  const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T18:00:00.000Z`;
  const seen = (d: number) => `2026-10-${String(d + 1).padStart(2, "0")}T09:00:00.000Z`;
  const history = async (s: LedgerSeed, d: number, provider = "sportmonks", seenAt = seen(d)) => {
    const fixture = await createFixture(db, s, day(d));
    const observation = realisticObservation(s, fixture, { kickoffAt: day(d), retrievedAt: `2026-10-${String(d + 1).padStart(2, "0")}T08:59:00.000Z` });
    if (provider !== "sportmonks") {
      observation.provider = provider;
      observation.providerFixtureId = `${provider}-${fixture.providerFixtureId}`;
      observation.teamStats = [];
      for (const team of observation.teams) team.statisticsStatus = "not_provided";
    }
    return { fixture, recorded: await recordObservation(db, observation, seenAt) };
  };

  // History: H1 (both providers -> sportmonks selected, api_football an
  // alternative), H2 and H3 (sportmonks only).
  const h1 = await history(seed, 25);
  const h1af = await recordObservation(db, (() => {
    const o = realisticObservation(seed, h1.fixture, { kickoffAt: day(25), retrievedAt: "2026-10-26T08:59:00.000Z" });
    o.provider = "api_football";
    o.providerFixtureId = "af-h1";
    o.teamStats = [];
    for (const team of o.teams) team.statisticsStatus = "not_provided";
    return o;
  })(), seen(25));
  const h2 = await history(seed, 18);
  const h3 = await history(seed, 11);
  // Backfilled after the cutoff: invisible to the forecast.
  const backfilled = await history(seed, 4, "sportmonks", "2026-11-01T09:00:00.000Z");
  // A match between two other teams.
  const other = await seedLedger(db, ["Other Home FC", "Other Away FC"]);
  const unrelated = await history(other, 20);

  // Memberships and tenures.
  const sep1 = "2026-09-01T00:00:00.000Z";
  const signing = "63000000-0000-4000-8000-0000000f0001";
  await db.query("insert into public.players (id, canonical_name) values ($1, 'New signing')", [signing]);
  const members = {
    homeKeeper: await insertMembership(db, { membership_key: membershipKey(), team_id: home.teamId, player_id: home.playerIds[0], shirt_number: 1 }, sep1),
    homeSigning: await insertMembership(db, { membership_key: membershipKey(), team_id: home.teamId, player_id: signing, starts_on_earliest: "2026-10-20", starts_on_latest: "2026-10-28" }, "2026-10-28T10:00:00.000Z"),
    awayKeeper: await insertMembership(db, { membership_key: membershipKey(), team_id: away.teamId, player_id: away.playerIds[0] }, sep1),
    homeLate: await insertMembership(db, { membership_key: membershipKey(), team_id: home.teamId, player_id: home.playerIds[17] }, "2026-10-31T00:00:00.000Z"),
  };
  const tenures = {
    home: await insertTenure(db, home.teamId, home.coachId, sep1),
    away: await insertTenure(db, away.teamId, away.coachId, sep1),
    homeLate: await insertTenure(db, home.teamId, away.coachId, "2026-10-31T00:00:00.000Z"),
  };

  const { claims, lateResolutionId } = await seedTargetClaims(db, target.fixtureId, home, away);

  return {
    db, seed, home, away, target, rpc, signing, members, tenures, claims, lateResolutionId,
    read: SQUAD_STATE_READ_V1_VERSION as SquadStateReadVersion,
    fixtures: { h1: h1.fixture, unrelated: unrelated.fixture },
    obs: { h1: h1.recorded, h1af, h2: h2.recorded, h3: h3.recorded, backfilled: backfilled.recorded, unrelated: unrelated.recorded },
  };
}

export type LineupWorld = Awaited<ReturnType<typeof setupReadV1LineupWorld>>;

/** SYNTHETIC Sportmonks ids of the attested lineup world (nothing real is attested). */
export const ATTESTED_LINEUP_IDS = { leagueId: "8801", homeTeamId: "88010", awayTeamId: "88011" } as const;
const ATTESTED_OPPONENT_IDS = ["88021", "88022", "88023", "88024", "88025", "88026"] as const;
const ATTESTED_HOME_PLAYER_BASE = 8_800_000;
const ATTESTED_AWAY_PLAYER_BASE = 8_900_000;

/** A canonical team with a manual_override Sportmonks mapping and an active V4 attestation. */
async function attestedOpponent(db: PGlite, providerTeamId: string, index: number): Promise<string> {
  const teamId = `84000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  await db.query("insert into public.teams (id, canonical_name, country_code) values ($1, $2, 'IL')", [teamId, `Synthetic Opponent ${index}`]);
  await db.query(
    "insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_status, mapping_confidence) values ('sportmonks', $1, $2, 'manual_override', 1)",
    [providerTeamId, teamId],
  );
  await attestTeam(db, providerTeamId, teamId);
  return teamId;
}

async function providerPlayers(db: PGlite, base: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 14; i += 1) {
    const row = (await db.query<{ player_id: string }>(
      "select player_id from public.provider_player_mappings where provider = 'sportmonks' and provider_player_id = $1",
      [String(base + i)],
    )).rows[0];
    if (!row) throw new Error(`provider player ${base + i} was not ingested`);
    ids.push(row.player_id);
  }
  return ids;
}

/**
 * The trusted production lineup path (kapiloto-squad-state-read-v2): the same
 * target fixture, memberships, tenures and claims as the read-v1 world, with
 * home history ingested through match_ledger_ingest_provider_fixture_v2 under
 * active Stage 1 attestations (league, home and every opponent):
 *   T1 Oct 25 (vs O1), T2 Oct 18 (vs O2), T3 Oct 11 (vs O3), each trusted;
 *   AWAY Oct 24 (away team vs O4), trusted;
 *   BACKFILLED Oct 4 (vs O5), trusted but first seen after the cutoff;
 *   PLAIN Oct 21 (vs O6), a plain 1A Sportmonks observation (no sealed refs);
 *   AF, a plain 1A api_football observation of T1 (Stage 1 attests
 *   Sportmonks only, so API-Football history is never trusted).
 * read-v1 would see PLAIN and AF; read-v2 must not. Each history fixture has
 * its own opponent: V2 ingest quarantines a second provider fixture between
 * the same pair within 180 days. Ingested history has partial player rows
 * and no coaches or substitutions, as production provider ingest does.
 */
export async function setupAttestedLineupWorld(options: { supabaseDefaultPrivileges?: boolean } = {}) {
  const db = await createLedgerDatabase(options);
  await setClock(db, SYNTHETIC_ATTESTED_AT);
  const ids = ATTESTED_LINEUP_IDS;
  const seed = await seedAttestedIdentities(db, ids);
  const opponents: string[] = [];
  for (const [i, providerTeamId] of ATTESTED_OPPONENT_IDS.entries()) opponents.push(await attestedOpponent(db, providerTeamId, i + 1));

  const providerFixtureIds = { t1: "28800025", t2: "28800018", t3: "28800011", away: "28800024", backfilled: "28800004" };
  const runId = await createScopedRun(db, Object.values(providerFixtureIds));
  const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T18:00:00.000Z`;
  const ingestHistory = async (providerFixtureId: string, d: number, sides: [string, string], bases: [number, number], clock: string) => {
    const capture = syntheticCapture({
      leagueId: ids.leagueId,
      homeTeamId: sides[0],
      awayTeamId: sides[1],
      providerFixtureId,
      kickoffAt: day(d),
      capturedAt: new Date(Date.parse(clock) - 60_000).toISOString(),
      playerIdBase: bases,
    });
    const result = await ingestV2(db, observationFrom(capture, { mint: true, kickoffBefore: LINEUP_KICKOFF, runId }), clock);
    if (result.status !== "recorded") throw new Error(`attested history ${providerFixtureId} was ${result.status}: ${result.reason_code}`);
    return result;
  };
  const t3 = await ingestHistory(providerFixtureIds.t3, 11, [ids.homeTeamId, ATTESTED_OPPONENT_IDS[2]], [ATTESTED_HOME_PLAYER_BASE, 8_830_000], "2026-10-29T09:11:00.000Z");
  const t2 = await ingestHistory(providerFixtureIds.t2, 18, [ids.homeTeamId, ATTESTED_OPPONENT_IDS[1]], [ATTESTED_HOME_PLAYER_BASE, 8_820_000], "2026-10-29T09:18:00.000Z");
  const t1 = await ingestHistory(providerFixtureIds.t1, 25, [ids.homeTeamId, ATTESTED_OPPONENT_IDS[0]], [ATTESTED_HOME_PLAYER_BASE, 8_810_000], "2026-10-29T09:25:00.000Z");
  const awayHistory = await ingestHistory(providerFixtureIds.away, 24, [ids.awayTeamId, ATTESTED_OPPONENT_IDS[3]], [ATTESTED_AWAY_PLAYER_BASE, 8_840_000], "2026-10-29T09:24:00.000Z");
  const backfilled = await ingestHistory(providerFixtureIds.backfilled, 4, [ids.homeTeamId, ATTESTED_OPPONENT_IDS[4]], [ATTESTED_HOME_PLAYER_BASE, 8_850_000], "2026-10-31T09:00:00.000Z");

  // Untrusted rows the V1 read would return.
  const plainFixture = (await db.query<{ id: string }>(
    "insert into public.fixtures (competition_id, home_team_id, away_team_id, kickoff_at, status) values ($1, $2, $3, $4, 'finished') returning id",
    [seed.competitionId, seed.homeTeamId, opponents[5], day(21)],
  )).rows[0].id;
  const plain = await recordObservation(db, resultOnlyObservation(
    { fixtureId: plainFixture, providerFixtureId: "plain-untrusted-21" },
    seed.homeTeamId, opponents[5],
    { kickoffAt: day(21), retrievedAt: "2026-10-29T09:59:00.000Z", homeGoals: 1, awayGoals: 1 },
  ), "2026-10-29T10:00:00.000Z");
  const af = await recordObservation(db, resultOnlyObservation(
    { fixtureId: t1.fixture_id!, providerFixtureId: "af-t1" },
    seed.homeTeamId, opponents[0],
    { kickoffAt: day(25), retrievedAt: "2026-10-29T10:04:00.000Z", homeGoals: 2, awayGoals: 1, provider: "api_football" },
  ), "2026-10-29T10:05:00.000Z");

  const target = { fixtureId: await canonicalFixtureFor(db, seed, LINEUP_KICKOFF) };
  const home = { teamId: seed.homeTeamId, playerIds: await providerPlayers(db, ATTESTED_HOME_PLAYER_BASE) };
  const away = { teamId: seed.awayTeamId, playerIds: await providerPlayers(db, ATTESTED_AWAY_PLAYER_BASE) };

  const sep1 = "2026-09-01T00:00:00.000Z";
  const signing = "63000000-0000-4000-8000-0000000f0a01";
  await db.query("insert into public.players (id, canonical_name) values ($1, 'New signing')", [signing]);
  const members = {
    homeKeeper: await insertMembership(db, { membership_key: membershipKey(), team_id: home.teamId, player_id: home.playerIds[0], shirt_number: 1 }, sep1),
    homeSigning: await insertMembership(db, { membership_key: membershipKey(), team_id: home.teamId, player_id: signing, starts_on_earliest: "2026-10-20", starts_on_latest: "2026-10-28" }, "2026-10-28T10:00:00.000Z"),
    awayKeeper: await insertMembership(db, { membership_key: membershipKey(), team_id: away.teamId, player_id: away.playerIds[0] }, sep1),
    homeLate: await insertMembership(db, { membership_key: membershipKey(), team_id: home.teamId, player_id: home.playerIds[13] }, "2026-10-31T00:00:00.000Z"),
  };
  const coaches = { home: "62000000-0000-4000-8000-0000000a0001", away: "62000000-0000-4000-8000-0000000a0002" };
  await db.query("insert into public.coaches (id, canonical_name) values ($1, 'Synthetic Home Coach'), ($2, 'Synthetic Away Coach')", [coaches.home, coaches.away]);
  const tenures = {
    home: await insertTenure(db, home.teamId, coaches.home, sep1),
    away: await insertTenure(db, away.teamId, coaches.away, sep1),
  };

  const { claims, lateResolutionId } = await seedTargetClaims(db, target.fixtureId, home, away);

  return {
    db, seed, ids, opponents, runId, home, away, target, rpc: squadRpc(db), signing, members, tenures, claims, lateResolutionId,
    read: SQUAD_STATE_READ_V2_VERSION as SquadStateReadVersion,
    obs: { t1, t2, t3, away: awayHistory, backfilled, plain, af },
  };
}

export type AttestedLineupWorld = Awaited<ReturnType<typeof setupAttestedLineupWorld>>;

type ForecastWorld = { rpc: SquadStateRpc; target: { fixtureId: string }; read: SquadStateReadVersion };

/**
 * Squad inputs through the world's read: read-v2 is the production loader
 * (loadLineupSquadInputs); read-v1 is the frozen V1 read with the same window.
 */
export function loadForecastInputs(
  world: ForecastWorld,
  teamId: string,
  overrides: { cutoff?: string; policy?: HistorySelectionPolicy; read?: SquadStateReadVersion } = {},
): Promise<SquadStateInputs> {
  const policy = overrides.policy ?? LINEUP_POLICY;
  const cutoff = overrides.cutoff ?? LINEUP_CUTOFF;
  const read = overrides.read ?? world.read;
  return read === SQUAD_STATE_READ_V2_VERSION
    ? loadLineupSquadInputs(world.rpc, { fixtureId: world.target.fixtureId, teamId, cutoff, policy })
    : loadSquadStateInputs(world.rpc, { fixtureId: world.target.fixtureId, teamId, cutoff, historyFixtureLimit: policy.maxFixtures });
}

let snapshotCounter = 0;

/** The production layering: load -> state -> model -> snapshot (not persisted), through the world's read. */
export async function forecastSnapshot(
  world: ForecastWorld,
  teamId: string,
  overrides: Partial<LineupSnapshotMeta> & { cutoff?: string; policy?: HistorySelectionPolicy; builder?: SquadStateBuilderVersion; read?: SquadStateReadVersion } = {},
) {
  snapshotCounter += 1;
  const policy = overrides.policy ?? LINEUP_POLICY;
  const inputs = await loadForecastInputs(world, teamId, overrides);
  // Defaults to builder-v1 so the original 1D tests keep exercising the frozen V1 path.
  const state = buildFixtureSquadStateFor(overrides.builder ?? SQUAD_STATE_BUILDER_VERSION, inputs, policy);
  const output = buildLineupForecast(lineupModelInput(inputs, state));
  const snapshot = buildLineupForecastSnapshot({
    inputs,
    state,
    policy,
    output,
    meta: {
      idempotencyKey: overrides.idempotencyKey ?? `lineup-test-${snapshotCounter}`,
      purpose: overrides.purpose ?? "shadow",
      predictionProtocolVersion: overrides.predictionProtocolVersion ?? "kapiloto-v4-lineup-test-protocol",
      pipelineVersion: overrides.pipelineVersion ?? "pipeline-test-v1",
      codeRevision: overrides.codeRevision ?? "0123456789abcdef0123456789abcdef01234567",
      generatedAt: overrides.generatedAt ?? "2026-10-30T12:05:00.000Z",
    },
  });
  return { inputs, state, output, snapshot };
}
