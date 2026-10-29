import type { PGlite } from "@electric-sql/pglite";

import type { ResolutionStatus } from "../claims";
import { buildLineupForecast } from "../lineup-model";
import { buildLineupForecastSnapshot, lineupModelInput, loadLineupSquadInputs, type LineupSnapshotMeta } from "../lineup-snapshot";
import { buildPredictionSnapshotV2Payload, type PredictionSnapshotV2Input, type RecordPredictionSnapshotResult } from "../prediction-registry";
import { buildFixtureSquadStateFor, historySelectionPolicy, type HistorySelectionPolicy, type SquadStateBuilderVersion, type SquadStateRpc } from "../squad-state";
import { SQUAD_STATE_BUILDER_VERSION } from "../versions";
import { addObservation, articleInput, recordClaim, recordDocument, recordResolution } from "./knowledge-fixtures";
import { createFixture, createLedgerDatabase, realisticObservation, recordObservation, seedLedger, setClock, type LedgerSeed } from "./ledger-fixtures";
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

/**
 * One target fixture (home vs away) with everything a home-team lineup
 * forecast reads, plus the out-of-scope rows the registry must refuse:
 * opponent memberships/tenures/claims, rows first seen after the cutoff, a
 * later resolution version, a backfilled history observation and a match
 * that does not involve the home team.
 */
export async function setupLineupWorld(options: { supabaseDefaultPrivileges?: boolean } = {}) {
  const db = await createLedgerDatabase(options);
  const seed = await seedLedger(db);
  const { home, away } = seed;
  const target = await createFixture(db, seed, LINEUP_KICKOFF);
  const rpc: SquadStateRpc = async (fn, args) =>
    (await db.query<{ r: unknown }>(`select public.${fn}($1, $2, $3, $4) as r`, [args.p_fixture_id, args.p_team_id, args.p_cutoff, args.p_history_fixture_limit ?? 30])).rows[0].r;

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

  // Target-fixture claims.
  let docCounter = 0;
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
      fixtureId: target.fixtureId,
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

  return {
    db, seed, home, away, target, rpc, signing, members, tenures, claims,
    lateResolutionId: lateResolution.resolution_id,
    fixtures: { h1: h1.fixture, unrelated: unrelated.fixture },
    obs: { h1: h1.recorded, h1af, h2: h2.recorded, h3: h3.recorded, backfilled: backfilled.recorded, unrelated: unrelated.recorded },
  };
}

export type LineupWorld = Awaited<ReturnType<typeof setupLineupWorld>>;

let snapshotCounter = 0;

/** The production layering: load -> state -> model -> snapshot (not persisted). */
export async function forecastSnapshot(
  world: Pick<LineupWorld, "rpc" | "target">,
  teamId: string,
  overrides: Partial<LineupSnapshotMeta> & { cutoff?: string; policy?: HistorySelectionPolicy; builder?: SquadStateBuilderVersion } = {},
) {
  snapshotCounter += 1;
  const policy = overrides.policy ?? LINEUP_POLICY;
  const inputs = await loadLineupSquadInputs(world.rpc, { fixtureId: world.target.fixtureId, teamId, cutoff: overrides.cutoff ?? LINEUP_CUTOFF, policy });
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
