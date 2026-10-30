import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProviderMatchObservationPayload,
  fixtureMintKickoffBefore,
  providerEntitlementSnapshotSha256,
  validateProviderMatchObservation,
} from "./provider-ingest";
import {
  SPORTMONKS_LEDGER_STAT_TYPES,
  SportmonksLedgerParseError,
  parseSportmonksLedgerCapture,
  type SportmonksLedgerCaptureV1,
} from "./sportmonks-ledger";
import { syntheticCapture } from "./test-support/provider-ingest-fixtures";

/** Offline parser tests on SYNTHETIC Sportmonks-shaped captures. */

const KICKOFF = "2026-08-15T18:00:00.000Z";
const CAPTURED = "2026-10-30T09:00:00.000Z";
const OPTIONS = { fixtureMint: { allowed: false, kickoffBefore: null }, runId: null };

const parse = (capture: SportmonksLedgerCaptureV1) => parseSportmonksLedgerCapture(capture, OPTIONS);

function parseError(capture: SportmonksLedgerCaptureV1): string {
  try {
    parse(capture);
  } catch (error) {
    assert.ok(error instanceof SportmonksLedgerParseError, String(error));
    return error.code;
  }
  assert.fail("expected a parse error");
}

function mutate(change: (capture: any) => void, options: Partial<Parameters<typeof syntheticCapture>[0]> = {}): SportmonksLedgerCaptureV1 {
  const capture = syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED, ...options }) as any;
  change(capture);
  return capture;
}

test("a full-time capture maps to a provider match observation", () => {
  const { observation, flags } = parse(syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED }));
  assert.deepEqual(flags, []);
  assert.equal(observation.provider, "sportmonks");
  assert.equal(observation.providerFixtureId, "19000001");
  assert.equal(observation.providerLeagueId, "9001");
  assert.equal(observation.providerSeasonId, "99001");
  assert.equal(observation.providerHomeTeamId, "9501");
  assert.equal(observation.providerAwayTeamId, "9502");
  assert.equal(observation.kickoffAt, KICKOFF);
  assert.equal(observation.retrievedAt, CAPTURED);
  assert.equal(observation.matchStatus, "finished");
  assert.equal(observation.ingestVersion, "kapiloto-sportmonks-ledger-mapping-v1");
  assert.deepEqual([observation.homeGoals90, observation.awayGoals90, observation.homeGoalsAet, observation.homePenalties], [2, 1, null, null]);
  assert.equal(observation.neutralVenue, null);
  assert.deepEqual(observation.teams, [
    { side: "home", formationNominal: "4-3-3", lineupStatus: "complete", statisticsStatus: "complete" },
    { side: "away", formationNominal: "4-4-2", lineupStatus: "complete", statisticsStatus: "complete" },
  ]);
  assert.equal(observation.players.length, 28);
  const keeper = observation.players.find((p) => p.providerPlayerId === "3100000")!;
  assert.deepEqual(keeper, {
    side: "home",
    providerPlayerId: "3100000",
    providerPlayerName: "Synthetic Home 1",
    lineupRole: "starter",
    appeared: true,
    positionCode: "GK",
    formationPosition: 1,
    formationField: "1:1",
    shirtNumber: 1,
  });
  const bench = observation.players.find((p) => p.providerPlayerId === "3100012")!;
  assert.deepEqual([bench.lineupRole, bench.appeared, bench.formationPosition], ["bench", null, null]);
  assert.equal(observation.teamStats.length, 14);
  assert.ok(observation.teamStats.every((s) => s.definitionVersion === "sm-2024-08"));
  assert.deepEqual(
    observation.teamStats.filter((s) => s.side === "home").map((s) => [s.providerStatType, s.family, s.value]).sort(),
    [["34", "statistics", 6], ["42", "statistics", 14], ["45", "statistics", 54], ["5304", "xg", 1.82], ["5305", "xg", 1.64], ["7943", "xg", 1.06], ["86", "statistics", 5]],
  );
  assert.deepEqual(observation.familyFetches, { lineups: "fetched", formations: "fetched", statistics: "fetched", xg: "fetched" });
  assert.deepEqual(validateProviderMatchObservation(observation), []);
});

test("the parser never manufactures raw_payload_sha256; a supplied hash passes through unchanged", () => {
  const withoutHash = parse(syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED }));
  assert.equal(withoutHash.observation.rawPayloadSha256, null);
  assert.equal(buildProviderMatchObservationPayload(withoutHash.observation).raw_payload_sha256, null);
  const supplied = "a".repeat(64);
  const withHash = parse(syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED, rawPayloadSha256: supplied }));
  assert.equal(withHash.observation.rawPayloadSha256, supplied);
  // Family response hashes stay audit-only and are never promoted to the raw hash.
  const familyHashes = mutate((c) => {
    c.families.lineups.raw_response_sha256 = "b".repeat(64);
  });
  const parsed = parse(familyHashes).observation;
  assert.equal(parsed.rawPayloadSha256, null);
  assert.equal(parsed.familyResponseSha256.lineups, "b".repeat(64));
  assert.equal(parseError(mutate((c) => (c.raw_payload_sha256 = "A".repeat(64)))), "raw_payload_sha256_invalid");
  assert.equal(parseError(mutate((c) => (c.raw_payload_sha256 = "not-a-hash"))), "raw_payload_sha256_invalid");
});

test("family fetch status is explicit: empty rows are never 'provided'", () => {
  const statisticsNotRequested = parse(syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED, families: { statistics: "not_requested" } })).observation;
  assert.equal(statisticsNotRequested.familyFetches.statistics, "not_requested");
  assert.deepEqual(statisticsNotRequested.teamStats.map((s) => s.family).filter((f) => f === "statistics"), []);
  assert.equal(statisticsNotRequested.teams[0].statisticsStatus, "partial");

  const fetchedEmpty = parse(mutate((c) => (c.families.xg.rows = []), { families: { statistics: "not_requested" } })).observation;
  assert.equal(fetchedEmpty.familyFetches.xg, "fetched");
  assert.equal(fetchedEmpty.teamStats.length, 0);
  assert.equal(fetchedEmpty.teams[0].statisticsStatus, "not_provided");

  const noLineups = parse(syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED, families: { lineups: "not_requested", formations: "not_requested" } })).observation;
  assert.equal(noLineups.players.length, 0);
  assert.deepEqual([noLineups.teams[0].lineupStatus, noLineups.teams[0].formationNominal], ["not_provided", null]);

  // A failed family is carried as failed (the ingest RPC quarantines it).
  const failed = parse(syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED, families: { xg: "failed" } })).observation;
  assert.equal(failed.familyFetches.xg, "failed");
  assert.ok(failed.teamStats.every((s) => s.family !== "xg"));

  assert.equal(parseError(mutate((c) => (c.families.xg.rows = [{ type_id: 5304 }]), { families: { xg: "not_requested" } })), "family_rows_without_fetch");
  assert.equal(parseError(mutate((c) => delete c.families.formations)), "family_invalid");
  assert.equal(parseError(mutate((c) => (c.families.odds = { fetch_status: "fetched", rows: [], raw_response_sha256: null }))), "family_invalid");
  assert.equal(parseError(mutate((c) => (c.families.lineups.fetch_status = "partial"))), "family_invalid");
});

test("score semantics: 2ND_HALF is the 90-minute score; CURRENT includes extra time; penalties are separate", () => {
  const aet = parse(syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED, state: "AET", score90: [1, 1], scoreAet: [2, 1] }));
  assert.deepEqual(
    [aet.observation.homeGoals90, aet.observation.awayGoals90, aet.observation.homeGoalsAet, aet.observation.awayGoalsAet, aet.observation.homePenalties],
    [1, 1, 2, 1, null],
  );
  // Whole-match stats of an extra-time match are not separable into 90 minutes.
  assert.equal(aet.observation.teamStats.length, 0);
  assert.deepEqual(aet.observation.teams.map((t) => t.statisticsStatus), ["not_provided", "not_provided"]);
  assert.deepEqual(aet.flags, ["stats_not_separable_extra_time"]);

  const pens = parse(syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED, state: "FT_PEN", score90: [0, 0], scoreAet: [1, 1], penalties: [4, 3] })).observation;
  assert.deepEqual([pens.homeGoals90, pens.homeGoalsAet, pens.awayGoalsAet, pens.homePenalties, pens.awayPenalties], [0, 1, 1, 4, 3]);
  const alias = mutate((c) => {
    for (const s of c.fixture.scores) if (s.description === "PENALTIES") s.description = "PENALTY_SHOOTOUT";
  }, { state: "FT_PEN", score90: [0, 0], scoreAet: [0, 0], penalties: [5, 4] });
  assert.deepEqual([parse(alias).observation.homePenalties, parse(alias).observation.awayPenalties], [5, 4]);

  assert.equal(parseError(mutate((c) => (c.fixture.scores = c.fixture.scores.filter((s: any) => s.description !== "2ND_HALF")), { state: "AET", score90: [1, 1], scoreAet: [2, 1] })), "score_90_unavailable");
  assert.equal(parseError(mutate((c) => (c.fixture.scores = c.fixture.scores.filter((s: any) => s.description !== "CURRENT")), { state: "AET", score90: [1, 1], scoreAet: [2, 1] })), "extra_time_score_unavailable");
  assert.equal(parseError(mutate((c) => (c.fixture.scores = c.fixture.scores.filter((s: any) => s.description === "1ST_HALF")))), "score_90_unavailable");
  assert.equal(parseError(mutate((c) => c.fixture.scores.find((s: any) => s.description === "CURRENT").score.goals++)), "score_inconsistent");
  assert.equal(parseError(mutate((c) => c.fixture.scores.push({ description: "2ND_HALF", score: { goals: 7, participant: "home" } }))), "score_duplicate");

  // FT with CURRENT only is acceptable.
  const currentOnly = parse(mutate((c) => (c.fixture.scores = c.fixture.scores.filter((s: any) => s.description === "CURRENT")))).observation;
  assert.deepEqual([currentOnly.homeGoals90, currentOnly.awayGoals90], [2, 1]);
});

test("Sportmonks states map to canonical statuses; awarded results are never finished", () => {
  for (const [state, status] of [
    ["NS", "upcoming"], ["INPLAY_2ND_HALF", "live"], ["HT", "halftime"], ["POSTPONED", "postponed"],
    ["SUSPENDED", "suspended"], ["ABANDONED", "cancelled"], ["AWARDED", "under_review"], ["WO", "under_review"],
  ] as const) {
    const observation = parse(syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED, state })).observation;
    assert.equal(observation.matchStatus, status, state);
    assert.equal(observation.homeGoals90, null, state);
  }
  assert.equal(parseError(syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED, state: "SOMETHING_NEW" })), "state_unknown");
  assert.equal(parseError(mutate((c) => delete c.fixture.state)), "state_unavailable");
  assert.equal(parseError(mutate((c) => { delete c.fixture.starting_at_timestamp; })), "kickoff_unavailable");
  const fromString = parse(mutate((c) => { delete c.fixture.starting_at_timestamp; c.fixture.starting_at = "2026-08-15 18:00:00"; })).observation;
  assert.equal(fromString.kickoffAt, KICKOFF);
});

test("stats are kept only for allow-listed types with the verified developer name", () => {
  const drift = parse(mutate((c) => (c.families.statistics.rows.find((r: any) => r.type_id === 42 && r.location === "home").type.developer_name = "SHOTS_OFF_TARGET")));
  assert.ok(drift.flags.includes("type_drift"));
  assert.equal(drift.observation.teamStats.filter((s) => s.side === "home" && s.providerStatType === "42").length, 0);
  assert.equal(drift.observation.teams[0].statisticsStatus, "partial");
  assert.equal(drift.observation.teams[1].statisticsStatus, "complete");

  const unverified = parse(mutate((c) => delete c.families.xg.rows[0].type));
  assert.ok(unverified.flags.includes("stat_type_unverified"));
  assert.equal(unverified.observation.teamStats.length, 13);

  const unknownType = parse(mutate((c) => c.families.statistics.rows.push({ type_id: 56, participant_id: 9501, data: { value: 12 }, type: { developer_name: "FOULS" } })));
  assert.equal(unknownType.observation.teamStats.length, 14);
  // An xG type inside the statistics family is not where it is verified to live.
  const wrongFamily = parse(mutate((c) => c.families.statistics.rows.push({ type_id: 5304, participant_id: 9501, data: { value: 9 }, type: { developer_name: "EXPECTED_GOALS" } })));
  assert.equal(wrongFamily.observation.teamStats.find((s) => s.side === "home" && s.providerStatType === "5304")!.value, 1.82);

  const invalid = parse(mutate((c) => (c.families.statistics.rows.find((r: any) => r.type_id === 45 && r.location === "home").data.value = 140)));
  assert.ok(invalid.flags.includes("stat_value_invalid"));
  const fractionalCount = parse(mutate((c) => (c.families.statistics.rows.find((r: any) => r.type_id === 34).data.value = 2.5)));
  assert.ok(fractionalCount.flags.includes("stat_value_invalid"));

  const duplicateSame = parse(mutate((c) => c.families.statistics.rows.push({ ...c.families.statistics.rows[0] })));
  assert.equal(duplicateSame.observation.teamStats.length, 14);
  assert.equal(parseError(mutate((c) => c.families.statistics.rows.push({ ...c.families.statistics.rows[0], data: { value: 99 } }))), "stat_duplicate_conflict");
  assert.equal(parseError(mutate((c) => (c.families.statistics.rows[0].participant_id = 777))), "stat_team_unknown");
  assert.equal(SPORTMONKS_LEDGER_STAT_TYPES.length, 7);
});

test("lineup rows: roles, positions, slots, and ambiguity handling", () => {
  assert.equal(parseError(mutate((c) => c.families.lineups.rows.push({ ...c.families.lineups.rows[0] }))), "lineup_duplicate_player");
  assert.equal(parseError(mutate((c) => (c.families.lineups.rows[12].type_id = 11))), "lineup_too_many_starters");
  assert.equal(parseError(mutate((c) => (c.families.lineups.rows[0].team_id = 777))), "lineup_team_unknown");
  assert.equal(parseError(mutate((c) => (c.families.lineups.rows[0].player_id = "abc"))), "lineup_row_invalid");

  const jerseys = parse(mutate((c) => (c.families.lineups.rows[1].jersey_number = 1)));
  assert.ok(jerseys.flags.includes("duplicate_shirt_number"));
  const home = jerseys.observation.players.filter((p) => p.side === "home");
  assert.deepEqual([home[0].shirtNumber, home[1].shirtNumber, home[2].shirtNumber], [null, null, 3]);

  const tenStarters = parse(mutate((c) => (c.families.lineups.rows[10].type_id = 99)));
  assert.equal(tenStarters.observation.teams[0].lineupStatus, "partial");
  assert.ok(tenStarters.flags.includes("lineup_role_unknown"));
  const unknownRole = tenStarters.observation.players.find((p) => p.providerPlayerId === "3100010")!;
  assert.deepEqual([unknownRole.lineupRole, unknownRole.appeared, unknownRole.formationPosition], ["unknown", null, null]);

  const odd = parse(mutate((c) => {
    c.families.lineups.rows[0].position_id = 999;
    c.families.lineups.rows[0].formation_field = "left";
    c.families.lineups.rows[13].formation_position = 4;
  })).observation;
  const keeper = odd.players[0];
  assert.deepEqual([keeper.positionCode, keeper.formationField], [null, null]);
  assert.equal(odd.players[13].formationPosition, null);
});

test("formations and participants are validated", () => {
  const invalid = parse(mutate((c) => (c.families.formations.rows[0].formation = "4-3-3-0")));
  assert.equal(invalid.observation.teams[0].formationNominal, null);
  assert.ok(invalid.flags.includes("formation_invalid"));
  assert.equal(parseError(mutate((c) => c.families.formations.rows.push({ participant_id: 9501, formation: "3-5-2" }))), "formation_row_invalid");
  assert.equal(parseError(mutate((c) => (c.fixture.participants[1].meta.location = "home"))), "participants_invalid");
  assert.equal(parseError(mutate((c) => c.fixture.participants.pop())), "participants_invalid");
  assert.equal(parseError(mutate((c) => (c.fixture.league_id = null))), "fixture_ref_invalid");
  assert.equal(parseError(mutate((c) => (c.contract_version = "kapiloto-sportmonks-ledger-capture-v2"))), "capture_invalid");
  assert.equal(parseError(mutate((c) => (c.capture_mode = "live"))), "capture_invalid");
});

test("the RPC payload carries exactly the provider-observation contract keys", () => {
  const payload = buildProviderMatchObservationPayload(parse(syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED })).observation);
  assert.deepEqual(Object.keys(payload).sort(), [
    "away_goals_90", "away_goals_aet", "away_penalties", "capture_mode", "contract_version", "family_fetches",
    "family_response_sha256", "fixture_mint", "home_goals_90", "home_goals_aet", "home_penalties", "ingest_version",
    "kickoff_at", "match_status", "neutral_venue", "players", "provider", "provider_away_team_id", "provider_endpoint",
    "provider_fixture_id", "provider_home_team_id", "provider_league_id", "provider_season_id", "raw_payload_sha256",
    "retrieved_at", "run_id", "team_stats", "teams",
  ]);
  assert.equal(payload.contract_version, "kapiloto-provider-match-observation-v1");
});

test("validation, mint bound and entitlement hash helpers", () => {
  const base = parse(syntheticCapture({ kickoffAt: KICKOFF, capturedAt: CAPTURED })).observation;
  assert.ok(validateProviderMatchObservation({ ...base, rawPayloadSha256: "x" }).some((i) => i.includes("raw_payload_sha256")));
  assert.ok(validateProviderMatchObservation({ ...base, familyFetches: { ...base.familyFetches, xg: "not_requested" } }).some((i) => i.includes("was not fetched")));
  assert.ok(validateProviderMatchObservation({ ...base, fixtureMint: { allowed: true, kickoffBefore: null } }).some((i) => i.includes("kickoffBefore")));
  assert.ok(validateProviderMatchObservation({ ...base, players: [...base.players, base.players[0]] }).some((i) => i.includes("more than once")));

  assert.equal(fixtureMintKickoffBefore("2026-10-30T00:00:00.000Z", 21), "2026-10-08T00:00:00.000Z");
  assert.throws(() => fixtureMintKickoffBefore("2026-10-30T00:00:00.000Z", 0));

  const snapshot = {
    provider: "sportmonks",
    capturedAt: "2026-10-30T08:00:00Z",
    source: "synthetic",
    competitions: [{ providerLeagueId: "8", name: "A" }, { providerLeagueId: "564", name: "B" }],
  };
  const hash = providerEntitlementSnapshotSha256(snapshot);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(providerEntitlementSnapshotSha256({ ...snapshot, competitions: [...snapshot.competitions].reverse() }), hash);
  assert.notEqual(providerEntitlementSnapshotSha256({ ...snapshot, competitions: snapshot.competitions.slice(1) }), hash);
  assert.throws(() => providerEntitlementSnapshotSha256({ ...snapshot, competitions: [...snapshot.competitions, snapshot.competitions[0]] }));
});
