import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { buildMatchLedgerWithdrawalPayload, type MatchLedgerObservationInput } from "./match-ledger";
import {
  buildFixtureSquadState,
  historySelectionPolicy,
  loadSquadStateInputs,
  type SquadCandidate,
  type SquadStateRpc,
} from "./squad-state";
import { createFixture, createLedgerDatabase, realisticObservation, recordObservation, seedLedger, setClock } from "./test-support/ledger-fixtures";
import { addObservation, articleInput, recordClaim, recordDocument, recordResolution } from "./test-support/knowledge-fixtures";
import { insertMembership, membershipKey } from "./test-support/roster-fixtures";
import type { ResolutionStatus } from "./claims";

/**
 * End to end: cutoff-filtered inputs from public.squad_state_inputs_as_of,
 * then the pure builder. Proves provider fusion, candidate universe,
 * evidence semantics, coach state and leakage boundaries against the
 * database.
 */

const KICKOFF = "2026-11-02T18:00:00.000Z";
const CUTOFF = "2026-10-30T12:00:00.000Z";
const POLICY = historySelectionPolicy(["sportmonks", "api_football"]);

const player = (n: number) => `63000000-0000-4000-8000-0000000e${String(n).padStart(4, "0")}`;

function asProvider(input: MatchLedgerObservationInput, provider: string, providerFixtureId: string): MatchLedgerObservationInput {
  input.provider = provider;
  input.providerFixtureId = providerFixtureId;
  input.teamStats = [];
  for (const team of input.teams) team.statisticsStatus = "not_provided";
  return input;
}

function swapPlayer(input: MatchLedgerObservationInput, from: string, to: string): MatchLedgerObservationInput {
  for (const p of input.players ?? []) if (p.playerId === from) p.playerId = to;
  for (const s of input.substitutions ?? []) {
    if (s.playerOffId === from) s.playerOffId = to;
    if (s.playerOnId === from) s.playerOnId = to;
  }
  for (const e of input.events ?? []) {
    if (e.playerId === from) e.playerId = to;
    if (e.relatedPlayerId === from) e.relatedPlayerId = to;
  }
  return input;
}

async function setup() {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const home = seed.home;
  const target = await createFixture(db, seed, KICKOFF);
  const rpc: SquadStateRpc = async (fn, args) =>
    (await db.query<{ r: unknown }>(`select public.${fn}($1, $2, $3, $4) as r`, [args.p_fixture_id, args.p_team_id, args.p_cutoff, args.p_history_fixture_limit ?? 30])).rows[0].r;

  const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T18:00:00.000Z`;
  const seen = (d: number) => `2026-10-${String(d + 1).padStart(2, "0")}T09:00:00.000Z`;
  const retrieved = (d: number) => `2026-10-${String(d + 1).padStart(2, "0")}T08:59:00.000Z`;
  const base = async (d: number) => {
    const fixture = await createFixture(db, seed, day(d));
    return { fixture, make: () => realisticObservation(seed, fixture, { kickoffAt: day(d), retrievedAt: retrieved(d) }) };
  };

  // H1 (Oct 25): both providers complete -> provider priority (sportmonks).
  const h1 = await base(25);
  const h1sm = await recordObservation(db, h1.make(), seen(25));
  const h1af = await recordObservation(db, asProvider(h1.make(), "api_football", "af-h1"), seen(25));
  // H2 (Oct 18): sportmonks partial, api_football complete -> complete wins.
  // The api_football squad lists M (a duplicate record of bench player 16).
  const m = player(1);
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Bench 16 (duplicate record)')", [m]);
  const h2 = await base(18);
  const partial = h2.make();
  partial.teams[0].lineupStatus = "partial";
  const h2sm = await recordObservation(db, partial, seen(18));
  const h2af = await recordObservation(db, swapPlayer(asProvider(h2.make(), "api_football", "af-h2"), home.playerIds[16], m), seen(18));
  // H3 (Oct 11): sportmonks recorded then withdrawn -> api_football only.
  const h3 = await base(11);
  const h3sm = await recordObservation(db, h3.make(), seen(11));
  await recordObservation(db, buildMatchLedgerWithdrawalPayload({
    fixtureId: h3.fixture.fixtureId,
    provider: "sportmonks",
    providerFixtureId: h3.fixture.providerFixtureId,
    captureMode: "manual_import",
    ingestVersion: "test",
    retrievedAt: "2026-10-13T09:00:00.000Z",
    withdrawalReason: "attached to the wrong fixture",
  }) as unknown as Record<string, unknown>, "2026-10-13T09:00:00.000Z");
  const h3af = await recordObservation(db, asProvider(h3.make(), "api_football", "af-h3"), seen(11));
  // H4 (Oct 4): backfilled on Nov 1, after the cutoff.
  const h4 = await base(4);
  const h4sm = await recordObservation(db, h4.make(), "2026-11-01T09:00:00.000Z");

  // Memberships.
  const rosterOnly = player(2);
  const formerPlayer = player(3);
  await db.query("insert into public.players (id, canonical_name) values ($1, 'New signing'), ($2, 'Left in September')", [rosterOnly, formerPlayer]);
  const sep1 = "2026-09-01T00:00:00.000Z";
  const memberH0 = await insertMembership(db, { membership_key: membershipKey(), team_id: home.teamId, player_id: home.playerIds[0], shirt_number: 1 }, sep1);
  const memberRoster = await insertMembership(db, { membership_key: membershipKey(), team_id: home.teamId, player_id: rosterOnly, starts_on_earliest: "2026-10-20", starts_on_latest: "2026-10-28", shirt_number: 44 }, "2026-10-28T10:00:00.000Z");
  await insertMembership(db, { membership_key: membershipKey(), team_id: home.teamId, player_id: formerPlayer, ends_on_earliest: "2026-09-30", ends_on_latest: "2026-09-30" }, sep1);
  const memberM = await insertMembership(db, { membership_key: membershipKey(), team_id: home.teamId, player_id: m, squad_group: "reserve" }, sep1);
  // A membership first stored after the cutoff is invisible.
  const lateSigning = player(4);
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Late signing')", [lateSigning]);
  await insertMembership(db, { membership_key: membershipKey(), team_id: home.teamId, player_id: lateSigning }, "2026-10-31T00:00:00.000Z");

  // Target-fixture claims with evidence and as-of beliefs.
  const claimOnly = player(5);
  const unattributedPlayer = player(6);
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Academy call-up'), ($2, 'Unknown team player')", [claimOnly, unattributedPlayer]);
  const claimAt = "2026-10-28T09:00:00.000Z";
  let docCounter = 0;
  const claim = async (
    playerId: string,
    claimType: "player_availability" | "expected_lineup",
    value: { status?: string; predicate?: string },
    status: ResolutionStatus | null,
    options: { teamId?: string | null; flags?: string[]; at?: string; resolvedAt?: string } = {},
  ) => {
    const at = options.at ?? claimAt;
    const recorded = await recordClaim(db, {
      claimKind: "reported_expectation",
      claimType,
      predicate: claimType === "player_availability" ? "availability_status" : value.predicate!,
      fixtureId: target.fixtureId,
      teamId: options.teamId === undefined ? home.teamId : options.teamId,
      playerId,
      objectValue: value.status ? { status: value.status } : {},
      temporalScope: "fixture",
    }, at);
    docCounter += 1;
    const doc = await recordDocument(db, articleInput({ extractedText: `Report ${docCounter}.`, retrievedAt: at }), at);
    const observation = await addObservation(db, { claimId: recorded.claim_id, documentVersionId: doc.document_version_id, relationship: "supports" }, at);
    if (status) {
      await recordResolution(db, {
        claimId: recorded.claim_id,
        status,
        resolverKind: "grounding",
        resolverVersion: "g1",
        reasonCode: "test_resolution",
        qualityFlags: options.flags ?? (status === "verified_degraded" ? ["missing_author"] : []),
        evidence: ["unresolved", "quarantined"].includes(status) ? [] : [{ evidenceRole: "supporting", claimObservationId: observation.id }],
      }, options.resolvedAt ?? "2026-10-29T09:00:00.000Z");
    }
    return recorded.claim_id;
  };
  const claims = {
    doubtful: await claim(home.playerIds[3], "player_availability", { status: "doubtful" }, "verified"),
    degradedOut: await claim(home.playerIds[4], "player_availability", { status: "out" }, "verified_degraded", { flags: ["missing_published_at"] }),
    unresolved: await claim(home.playerIds[5], "player_availability", { status: "injured" }, "unresolved"),
    contradicted: await claim(home.playerIds[6], "player_availability", { status: "out" }, "contradicted"),
    conflictFit: await claim(home.playerIds[7], "player_availability", { status: "fit" }, "verified"),
    conflictOut: await claim(home.playerIds[7], "player_availability", { status: "out" }, "verified"),
    startsReport: await claim(home.playerIds[8], "expected_lineup", { predicate: "starts" }, "verified"),
    notInSquad: await claim(home.playerIds[9], "expected_lineup", { predicate: "not_in_squad" }, "unresolved"),
    claimOnly: await claim(claimOnly, "player_availability", { status: "returning" }, "verified"),
    unattributed: await claim(unattributedPlayer, "player_availability", { status: "out" }, "verified", { teamId: null }),
    late: await claim(home.playerIds[10], "player_availability", { status: "out" }, "verified", { at: "2026-10-31T09:00:00.000Z", resolvedAt: "2026-10-31T10:00:00.000Z" }),
  };
  // After the cutoff the "doubtful" claim is contradicted; earlier reads must
  // not see it.
  const lateDoc = await recordDocument(db, articleInput({ extractedText: "He trained fully.", retrievedAt: "2026-10-31T09:00:00.000Z" }), "2026-10-31T09:00:00.000Z");
  const lateObs = await addObservation(db, { claimId: claims.doubtful, documentVersionId: lateDoc.document_version_id, relationship: "contradicts" }, "2026-10-31T09:00:00.000Z");
  await recordResolution(db, { claimId: claims.doubtful, status: "contradicted", resolverKind: "grounding", resolverVersion: "g1", reasonCode: "trained_fully", evidence: [{ evidenceRole: "contradicting", claimObservationId: lateObs.id }] }, "2026-10-31T10:00:00.000Z");

  // Coach tenure for the home coach (agrees with the ledger).
  await setClock(db, sep1);
  await db.query(
    `insert into public.team_coach_tenures (tenure_key, team_id, coach_id, starts_on_earliest, starts_on_latest, source_kind, ingest_version)
     values ('92000000-0000-4000-8000-000000000001', $1, $2, '2026-07-01', '2026-07-01', 'official_club', 'test')`,
    [home.teamId, home.coachId],
  );

  // The duplicate M is discovered: M -> bench player 16.
  await db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [m, home.playerIds[16]]);

  return {
    db, seed, home, target, rpc, m, rosterOnly, formerPlayer, lateSigning, claimOnly, claims,
    obs: { h1sm, h1af, h2sm, h2af, h3sm, h3af, h4sm },
    fixtures: { h1: h1.fixture, h2: h2.fixture, h3: h3.fixture, h4: h4.fixture },
    members: { memberH0, memberRoster, memberM },
  };
}

const byPlayer = (candidates: SquadCandidate[], id: string) => candidates.find((c) => c.canonical_player_id === id);

test("squad state selects one observation per fixture and keeps every evidence layer distinct", async () => {
  const ctx = await setup();
  const { db, home } = ctx;
  const inputs = await loadSquadStateInputs(ctx.rpc, { fixtureId: ctx.target.fixtureId, teamId: home.teamId, cutoff: CUTOFF });
  const state = buildFixtureSquadState(inputs, POLICY);

  // Provider fusion: one observation per fixture, never two; H4 (backfilled
  // after the cutoff) and the withdrawn sportmonks H3 are invisible.
  assert.deepEqual(
    state.history_selection.map((s) => [s.fixture_id, s.provider, s.reason, s.provider_fallback]),
    [
      [ctx.fixtures.h1.fixtureId, "sportmonks", "provider_priority", false],
      [ctx.fixtures.h2.fixtureId, "api_football", "complete_over_partial", true],
      [ctx.fixtures.h3.fixtureId, "api_football", "only_usable_observation", false],
    ],
  );
  assert.equal(new Set(state.history_selection.map((s) => s.fixture_id)).size, 3);
  assert.ok(!state.provenance.considered_observation_ids.includes(ctx.obs.h4sm.observation_id));
  assert.ok(!state.provenance.considered_observation_ids.includes(ctx.obs.h3sm.observation_id));
  assert.deepEqual(state.provenance.ledger_observation_ids, [ctx.obs.h1sm.observation_id, ctx.obs.h2af.observation_id, ctx.obs.h3af.observation_id]);
  assert.deepEqual([state.quality.usable_history_matches, state.quality.complete_history_matches, state.quality.provider_fallback_count], [3, 3, 1]);

  // Candidate universe: union of roster, history and attributable claims.
  const presence = (id: string) => byPlayer(state.candidates, id)?.presence;
  assert.equal(presence(home.playerIds[0]), "roster_and_history");
  assert.equal(presence(ctx.rosterOnly), "roster_only");
  assert.equal(presence(home.playerIds[12]), "historical_only");
  assert.equal(presence(ctx.claimOnly), "claim_only");
  assert.equal(presence(ctx.formerPlayer), undefined); // membership outside the date
  assert.equal(presence(ctx.lateSigning), undefined); // first seen after the cutoff
  assert.deepEqual(state.quality.unattributed_claim_ids, [ctx.claims.unattributed]);
  // The merged duplicate is one candidate with both observed ids.
  const bench16 = byPlayer(state.candidates, home.playerIds[16])!;
  assert.deepEqual(bench16.observed_player_ids, [home.playerIds[16], ctx.m].sort());
  assert.equal(bench16.presence, "roster_and_history");
  assert.deepEqual(bench16.roster.membership_ids, [ctx.members.memberM.id]);
  assert.equal(bench16.history.squad_appearances, 3);
  assert.equal(state.candidates.filter((c) => c.canonical_player_id === ctx.m).length, 0);
  // The raw ledger row still says M.
  const raw = await db.query("select count(*)::int as n from public.match_ledger_players where player_id = $1", [ctx.m]);
  assert.deepEqual(raw.rows, [{ n: 1 }]);

  // Availability: accepted, degraded, unresolved, audit-only and conflict.
  const availability = (id: string) => byPlayer(state.candidates, id)!.availability;
  assert.equal(availability(home.playerIds[3]).accepted_category, "doubtful"); // later contradiction invisible
  assert.equal(availability(home.playerIds[4]).accepted_category, "unavailable");
  assert.deepEqual(availability(home.playerIds[4]).accepted[0].quality_flags, ["missing_published_at"]);
  assert.deepEqual([availability(home.playerIds[5]).accepted_category, availability(home.playerIds[5]).unresolved.length], [null, 1]);
  assert.deepEqual([availability(home.playerIds[6]).accepted_category, availability(home.playerIds[6]).audit_only[0].resolution_status], [null, "contradicted"]);
  assert.deepEqual([availability(home.playerIds[7]).availability_conflict, availability(home.playerIds[7]).accepted_category, availability(home.playerIds[7]).accepted.length], [true, null, 2]);
  assert.equal(availability(ctx.claimOnly).accepted_category, "returning");
  assert.deepEqual([availability(home.playerIds[10]).accepted.length, availability(home.playerIds[10]).unresolved.length], [0, 0]); // claim after cutoff
  assert.deepEqual([state.quality.availability_conflicts, state.quality.unresolved_availability_claims], [1, 1]);

  // Reported lineups stay evidence; there is no selected lineup anywhere.
  assert.deepEqual(byPlayer(state.candidates, home.playerIds[8])!.reported_lineup.accepted.map((e) => e.predicate), ["starts"]);
  assert.deepEqual(byPlayer(state.candidates, home.playerIds[9])!.reported_lineup.unresolved.map((e) => e.predicate), ["not_in_squad"]);
  // The "not in squad" report does not silently override his three starts.
  assert.equal(byPlayer(state.candidates, home.playerIds[9])!.history.starts, 3);
  assert.ok(!JSON.stringify(state).includes("probability"));

  // Coach: tenure and ledger agree.
  assert.deepEqual([state.coach.provenance, state.coach.current_coach_id, state.coach.coach_conflict], ["ledger_and_tenure", home.coachId, false]);
  assert.deepEqual(state.coach.history_coaches.map((c) => [c.canonical_coach_id, c.matches]), [[home.coachId, 3]]);

  // Exact provenance for a future registry.
  assert.ok(state.provenance.membership_ids.includes(ctx.members.memberH0.id));
  assert.ok(state.provenance.canonical_claim_ids.includes(ctx.claims.doubtful));
  assert.ok(!state.provenance.canonical_claim_ids.includes(ctx.claims.late));
  assert.equal(state.provenance.tenure_ids.length, 1);
  await db.close();
});

test("the target match's own data, later corrections and invalid requests never reach the state", async () => {
  const ctx = await setup();
  const { db, home, seed } = ctx;
  // The target fixture is played and recorded; a later "better" observation
  // of H2 arrives after the cutoff.
  await recordObservation(db, realisticObservation(seed, ctx.target, { kickoffAt: KICKOFF, retrievedAt: "2026-11-02T20:59:00.000Z" }), "2026-11-02T21:00:00.000Z");
  const lateH2 = realisticObservation(seed, ctx.fixtures.h2, { kickoffAt: "2026-10-18T18:00:00.000Z", retrievedAt: "2026-10-31T08:59:00.000Z" });
  lateH2.homeGoals90 = 3;
  await recordObservation(db, lateH2, "2026-10-31T09:00:00.000Z");

  // At the cutoff, H2 is still the api_football complete version.
  const atCutoff = buildFixtureSquadState(await loadSquadStateInputs(ctx.rpc, { fixtureId: ctx.target.fixtureId, teamId: home.teamId, cutoff: CUTOFF }), POLICY);
  assert.equal(atCutoff.history_selection.find((s) => s.fixture_id === ctx.fixtures.h2.fixtureId)!.provider, "api_football");
  // Even at kickoff, the target's result (first seen after it) is invisible
  // and the target fixture is never history.
  const atKickoff = await loadSquadStateInputs(ctx.rpc, { fixtureId: ctx.target.fixtureId, teamId: home.teamId, cutoff: KICKOFF });
  assert.ok(atKickoff.history.every((o) => o.fixture_id !== ctx.target.fixtureId));
  // After the late complete sportmonks version, H2 switches provider, but
  // still counts once.
  const later = buildFixtureSquadState(atKickoff, POLICY);
  assert.deepEqual(later.history_selection.filter((s) => s.fixture_id === ctx.fixtures.h2.fixtureId).map((s) => s.provider), ["sportmonks"]);

  // Fail closed only on invalid requests.
  await assert.rejects(loadSquadStateInputs(ctx.rpc, { fixtureId: ctx.target.fixtureId, teamId: home.teamId, cutoff: "2026-11-02T18:00:01.000Z" }), /after the fixture kickoff/);
  const stranger = "61000000-0000-4000-8000-0000000000ff";
  await db.query("insert into public.teams (id, canonical_name) values ($1, 'Not playing')", [stranger]);
  await assert.rejects(loadSquadStateInputs(ctx.rpc, { fixtureId: ctx.target.fixtureId, teamId: stranger, cutoff: CUTOFF }), /does not play fixture/);
  assert.throws(() => buildFixtureSquadState({ ...atKickoff, cutoff: "2026-11-03T00:00:00.000Z" }, POLICY), /after the fixture kickoff/);

  // A team with no roster, claims or tenures still gets a state.
  const away = buildFixtureSquadState(await loadSquadStateInputs(ctx.rpc, { fixtureId: ctx.target.fixtureId, teamId: seed.away.teamId, cutoff: CUTOFF }), POLICY);
  assert.deepEqual([away.quality.active_roster_assertions, away.coach.provenance, away.quality.usable_history_matches], [0, "ledger_only", 3]);
  assert.ok(away.candidates.every((c) => c.presence === "historical_only"));
  await db.close();
});
