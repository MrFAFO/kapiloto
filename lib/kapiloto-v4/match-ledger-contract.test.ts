import assert from "node:assert/strict";
import test from "node:test";

import { latestProviderObservationsAsOf, tenuresAsOf } from "./as-of";
import {
  buildMatchLedgerObservationPayload,
  scoringTeamId,
  validateMatchLedgerObservation,
} from "./match-ledger";
import { realisticObservation, type LedgerSeed } from "./test-support/ledger-fixtures";
import { MATCH_LEDGER_OBSERVATION_CONTRACT_VERSION } from "./versions";

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`);
}

const seed: LedgerSeed = {
  competitionId: "c0000000-0000-4000-8000-000000000000",
  home: { teamId: "a0000000-0000-4000-8000-000000000001", coachId: "a1000000-0000-4000-8000-000000000001", playerIds: ids("a2000000", 18) },
  away: { teamId: "b0000000-0000-4000-8000-000000000001", coachId: "b1000000-0000-4000-8000-000000000001", playerIds: ids("b2000000", 18) },
  statDefinitionIds: {
    possession_pct: "d0000000-0000-4000-8000-000000000001",
    shots_total: "d0000000-0000-4000-8000-000000000002",
    shots_on_target: "d0000000-0000-4000-8000-000000000003",
    expected_goals: "d0000000-0000-4000-8000-000000000004",
    corners: "d0000000-0000-4000-8000-000000000005",
  },
};
const fixture = { fixtureId: "f0000000-0000-4000-8000-000000000001", providerFixtureId: "sm-1" };
const observation = () =>
  realisticObservation(seed, fixture, {
    kickoffAt: "2026-10-30T18:00:00.000Z",
    retrievedAt: "2026-11-03T08:59:00.000Z",
    withRedCard: true,
  });

test("a realistic observation bundle is internally consistent", () => {
  assert.deepEqual(validateMatchLedgerObservation(observation()), []);
});

test("payload builder emits the RPC contract with canonical id casing", () => {
  const input = observation();
  input.fixtureId = input.fixtureId.toUpperCase();
  const payload = buildMatchLedgerObservationPayload(input);
  assert.equal(payload.contract_version, MATCH_LEDGER_OBSERVATION_CONTRACT_VERSION);
  assert.equal(payload.fixture_id, fixture.fixtureId);
  assert.equal((payload.players as unknown[]).length, 36);
  assert.equal((payload.substitutions as unknown[]).length, 6);
  assert.ok(Object.keys(payload).every((key) => key === key.toLowerCase()));
});

test("validator reports bundle inconsistencies before the database does", () => {
  const twelveStarters = observation();
  twelveStarters.players![11].lineupRole = "starter";
  twelveStarters.players![11].formationPosition = 11;
  const issues = validateMatchLedgerObservation(twelveStarters);
  assert.ok(issues.some((issue) => issue.includes("more than 11 starters")));
  assert.ok(issues.some((issue) => issue.includes("repeats a formation position")));

  const starterOn = observation();
  starterOn.substitutions![0].playerOnId = seed.home.playerIds[1];
  assert.ok(validateMatchLedgerObservation(starterOn).some((issue) => issue.includes("starter cannot come on")));

  const foreignScorer = observation();
  foreignScorer.events![0].playerId = seed.away.playerIds[3];
  assert.ok(validateMatchLedgerObservation(foreignScorer).some((issue) => issue.includes("acting team's squad")));

  const badFormation = observation();
  badFormation.teams[0].formationNominal = "4-4-2-diamond";
  assert.ok(validateMatchLedgerObservation(badFormation).some((issue) => issue.includes("invalid nominal formation")));
});

test("validator mirrors the database completeness, staff and related-player rules", () => {
  const issuesFor = (mutate: (input: ReturnType<typeof observation>) => void) => {
    const input = observation();
    mutate(input);
    return validateMatchLedgerObservation(input);
  };
  assert.ok(issuesFor((i) => { i.homeGoals90 = null; i.awayGoals90 = null; }).some((x) => x.includes("90-minute score")));
  assert.ok(issuesFor((i) => { i.teams[1].substitutionsStatus = "not_provided"; }).some((x) => x.includes("substitutions are marked not_provided")));
  assert.ok(issuesFor((i) => { i.teams[0].eventsStatus = "not_provided"; }).some((x) => x.includes("events are marked not_provided")));
  assert.ok(issuesFor((i) => { i.teams[0].statisticsStatus = "not_provided"; }).some((x) => x.includes("statistics are marked not_provided")));
  assert.ok(issuesFor((i) => { i.events![7].staffRole = null; }).some((x) => x.includes("staffRole is required")));
  assert.ok(issuesFor((i) => { i.events![0].relatedPlayerId = "c9000000-0000-4000-8000-000000000001"; }).some((x) => x.includes("not in the matchday squad")));
  assert.ok(issuesFor((i) => { i.events![1].relatedPlayerId = seed.home.playerIds[2]; }).some((x) => x.includes("cannot name a related player")));
  // "complete" does not require at least one child.
  assert.deepEqual(issuesFor((i) => { i.substitutions = i.substitutions!.filter((s) => s.teamId !== seed.away.teamId);
    i.players!.filter((p) => p.teamId === seed.away.teamId && p.lineupRole === "bench").forEach((p) => { p.appeared = false; p.enteredMinute = null; });
  }), []);
});

test("provider-scoped as-of never returns one fixture twice", () => {
  const versions = [
    { fixtureId: "f1", provider: "sportmonks", observationVersion: 1, firstSeenAt: "2026-10-31T09:00:00Z" },
    { fixtureId: "f1", provider: "ifa", observationVersion: 1, firstSeenAt: "2026-10-31T10:00:00Z" },
  ];
  for (const provider of ["sportmonks", "ifa"]) {
    const rows = latestProviderObservationsAsOf(versions, provider, "2026-11-01T00:00:00Z");
    assert.deepEqual(rows.map((row) => `${row.fixtureId}:${row.provider}`), [`f1:${provider}`]);
  }
});

test("own goals credit the opponent of the acting team", () => {
  const record = { teamId: seed.away.teamId, opponentTeamId: seed.home.teamId };
  assert.equal(scoringTeamId({ eventType: "own_goal", teamId: seed.away.teamId }, record), seed.home.teamId);
  assert.equal(scoringTeamId({ eventType: "penalty_goal", teamId: seed.away.teamId }, record), seed.away.teamId);
  assert.equal(scoringTeamId({ eventType: "red_card", teamId: seed.away.teamId }, record), null);
});

test("in-memory as-of selection uses information time, not event time", () => {
  const versions = [
    { fixtureId: "f1", provider: "sportmonks", observationVersion: 1, firstSeenAt: "2026-10-31T09:00:00Z", kickoffAt: "2026-10-30T18:00:00Z" },
    { fixtureId: "f1", provider: "sportmonks", observationVersion: 2, firstSeenAt: "2026-11-03T09:00:00Z", kickoffAt: "2026-10-30T18:00:00Z" },
    { fixtureId: "f2", provider: "sportmonks", observationVersion: 1, firstSeenAt: "2026-11-03T09:00:00Z", kickoffAt: "2026-10-30T18:00:00Z" },
  ];
  const nov1 = latestProviderObservationsAsOf(versions, "sportmonks", "2026-11-01T00:00:00Z");
  assert.deepEqual(nov1.map((v) => `${v.fixtureId}:v${v.observationVersion}`), ["f1:v1"]);
  const nov4 = latestProviderObservationsAsOf(versions, "sportmonks", "2026-11-04T00:00:00Z");
  assert.deepEqual(nov4.map((v) => `${v.fixtureId}:v${v.observationVersion}`).sort(), ["f1:v2", "f2:v1"]);
  const withdrawn = [
    ...versions,
    { fixtureId: "f1", provider: "sportmonks", observationVersion: 3, firstSeenAt: "2026-11-05T09:00:00Z", kickoffAt: null, observationKind: "withdrawal" as const },
  ];
  assert.deepEqual(latestProviderObservationsAsOf(withdrawn, "sportmonks", "2026-11-04T00:00:00Z").length, 2);
  assert.deepEqual(latestProviderObservationsAsOf(withdrawn, "sportmonks", "2026-11-06T00:00:00Z").map((v) => v.fixtureId), ["f2"]);

  const tenures = [
    { tenureKey: "t", tenureVersion: 1, firstSeenAt: "2026-09-01T00:00:00Z", assertionStatus: "asserted", end: null },
    { tenureKey: "t", tenureVersion: 2, firstSeenAt: "2026-11-03T00:00:00Z", assertionStatus: "asserted", end: "2026-10-30" },
  ];
  assert.equal(tenuresAsOf(tenures, "2026-11-01T00:00:00Z")[0].end, null);
  assert.equal(tenuresAsOf(tenures, "2026-11-04T00:00:00Z")[0].end, "2026-10-30");
});
