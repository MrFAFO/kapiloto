import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseSportmonksLedgerCapture } from "./sportmonks-ledger";
import {
  assertSportmonksA2BPaginationComplete,
  assertSportmonksA2BSinglePage,
  auditSportmonksA2BCapture,
  auditSportmonksA2BLeagueIdentity,
  buildSportmonksA2BCapture,
  buildSportmonksA2BCompetitionProfile,
  buildSportmonksA2BPilotReport,
  buildSportmonksA2BSeasonProfile,
  createSportmonksA2BCredentialGuard,
  extractSportmonksScheduleFixtures,
  isSportmonksFinishedFixtureRow,
  mergeSportmonksA2BEntitlementRows,
  parseSportmonksA2BEntitlementRow,
  parseSportmonksA2BLeagueSeasons,
  parseSportmonksA2BPilotArgs,
  sanitizeSportmonksEndpoint,
  selectSportmonksA2BSeasons,
  selectSportmonksFinishedSeasonFixtures,
  sportmonksA2BEntitlementDetailsSha256,
  sportmonksLeagueNameMatches,
  SPORTMONKS_A2B_GATE_NAMES,
  SPORTMONKS_A2B_PARSER_FIXTURE_MINT,
  SPORTMONKS_A2B_TARGET_LEAGUES,
  summarizeSportmonksA2BGateEvidence,
  summarizeSportmonksA2BProviderSemantics,
  type SportmonksA2BEntitlementRow,
} from "./sportmonks-pilot";
import {
  ensureEmptySportmonksA2BOutputDirectory,
  scrubSportmonksA2BOutputIfCredentialPresent,
  sha256Bytes,
  SportmonksA2BCredentialEchoError,
  SportmonksA2BRawArchive,
} from "./sportmonks-pilot-io";

const hash = "a".repeat(64);
const TOKEN = "TestToken0123456789abcdefABCDEF";

function stat(participant_id: number, type_id: number, developer_name: string, value: number | null) {
  return { participant_id, type_id, type: { developer_name }, data: { value } };
}

function lineup(teamId: number, firstPlayerId: number) {
  const positions = [24, 25, 25, 25, 25, 26, 26, 26, 27, 27, 27];
  return [
    ...positions.map((position_id, index) => ({
      player_id: firstPlayerId + index,
      team_id: teamId,
      type_id: 11,
      position_id,
      formation_position: index + 1,
      formation_field: `${Math.min(4, Math.floor(index / 3) + 1)}:${(index % 4) + 1}`,
      player_name: `Starter ${firstPlayerId + index}`,
      jersey_number: index + 1,
    })),
    {
      player_id: firstPlayerId + 50,
      team_id: teamId,
      type_id: 12,
      position_id: 26,
      formation_position: null,
      formation_field: null,
      player_name: `Bench ${firstPlayerId + 50}`,
      jersey_number: 20,
    },
  ];
}

function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9001,
    league_id: 8,
    season_id: 28083,
    starting_at_timestamp: 1790708400,
    state: { developer_name: "FT" },
    participants: [
      { id: 100, name: "Home FC", meta: { location: "home" } },
      { id: 200, name: "Away FC", meta: { location: "away" } },
    ],
    scores: [
      { description: "2ND_HALF", score: { goals: 2, participant: "home" } },
      { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
      { description: "CURRENT", score: { goals: 2, participant: "home" } },
      { description: "CURRENT", score: { goals: 1, participant: "away" } },
    ],
    lineups: [...lineup(100, 1), ...lineup(200, 101)],
    formations: [
      { participant_id: 100, formation: "4-3-3" },
      { participant_id: 200, formation: "4-4-2" },
    ],
    statistics: [
      stat(100, 45, "BALL_POSSESSION", 55),
      stat(200, 45, "BALL_POSSESSION", 45),
      stat(100, 42, "SHOTS_TOTAL", 14),
      stat(100, 86, "SHOTS_ON_TARGET", 6),
      stat(200, 42, "SHOTS_TOTAL", 8),
      stat(200, 86, "SHOTS_ON_TARGET", 3),
      stat(100, 34, "CORNERS", 0),
      stat(200, 34, "CORNERS", 4),
    ],
    xgfixture: [
      stat(100, 5304, "EXPECTED_GOALS", 1.8),
      stat(100, 7943, "EXPECTED_NON_PENALTY_GOALS", 1.6),
      stat(200, 5304, "EXPECTED_GOALS", 0.8),
      stat(200, 7943, "EXPECTED_NON_PENALTY_GOALS", 0.8),
    ],
    ...overrides,
  };
}

function capture(value: Record<string, unknown> = fixture()) {
  return buildSportmonksA2BCapture({
    fixture: value,
    capturedAt: "2026-11-04T06:00:00.000Z",
    rawPayloadSha256: hash,
    providerEndpoint: "/v3/football/fixtures/9001",
  });
}

function audit(overrides: Record<string, unknown> = {}) {
  return auditSportmonksA2BCapture(capture(fixture(overrides)));
}

const PL = SPORTMONKS_A2B_TARGET_LEAGUES[0];

function plEntitlement(overrides: Partial<SportmonksA2BEntitlementRow> = {}): SportmonksA2BEntitlementRow {
  return {
    providerLeagueId: "8",
    name: "Premier League",
    countryId: "462",
    countryName: "England",
    countryIso2: "GB",
    type: "league",
    subType: "domestic",
    active: true,
    ...overrides,
  };
}

function plDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 8,
    name: "Premier League",
    type: "league",
    sub_type: "domestic",
    country: { name: "England", iso2: "GB" },
    currentseason: { id: 28083, league_id: 8, name: "2026/2027", is_current: true, starting_at: "2026-08-14", ending_at: "2027-05-23" },
    seasons: [
      { id: 25583, league_id: 8, name: "2025/2026", is_current: false, starting_at: "2025-08-15", ending_at: "2026-05-24" },
      { id: 23614, league_id: 8, name: "2024/2025", is_current: false, starting_at: "2024-08-16", ending_at: "2025-05-25" },
      { id: 28083, league_id: 8, name: "2026/2027", is_current: true, starting_at: "2026-08-14", ending_at: "2027-05-23" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

test("builds an A2-B capture with the exact response hash on every requested family", () => {
  const built = capture();
  assert.equal(built.raw_payload_sha256, hash);
  assert.equal(built.capture_mode, "backfill");
  assert.equal(built.fixture.league_id, 8);
  assert.equal(built.fixture.season_id, 28083);
  assert.deepEqual(Object.values(built.families).map((family) => family.fetch_status), ["fetched", "fetched", "fetched", "fetched"]);
  assert.ok(Object.values(built.families).every((family) => family.raw_response_sha256 === hash));
});

test("the offline parser accepts the coherent fixture only under the no-mint policy", () => {
  assert.deepEqual({ ...SPORTMONKS_A2B_PARSER_FIXTURE_MINT }, { allowed: false, kickoffBefore: null });
  assert.ok(Object.isFrozen(SPORTMONKS_A2B_PARSER_FIXTURE_MINT));
  const parsed = parseSportmonksLedgerCapture(capture(), { fixtureMint: SPORTMONKS_A2B_PARSER_FIXTURE_MINT, runId: null });
  assert.deepEqual(parsed.observation.fixtureMint, { allowed: false, kickoffBefore: null });
});

// ---------------------------------------------------------------------------
// Fixture audit
// ---------------------------------------------------------------------------

test("a coherent full-family fixture passes every discriminating gate", () => {
  const result = audit();
  for (const gate of SPORTMONKS_A2B_GATE_NAMES) assert.equal(result.gates[gate].status, "pass", gate);
  assert.deepEqual(result.observed.lineupStarterCounts, { home: 11, away: 11 });
  assert.deepEqual(result.observed.lineupBenchCounts, { home: 1, away: 1 });
  assert.deepEqual(result.observed.explicitZeroStatTypes, ["34"]);
});

test("explicit zero is coverage evidence, never a gate", () => {
  const noZero = audit({ statistics: (fixture().statistics as Array<{ type_id: number }>).filter((row) => row.type_id !== 34) });
  assert.deepEqual(noZero.observed.explicitZeroStatTypes, []);
  assert.ok(!("explicitZero" in noZero.gates));
  assert.ok(!(SPORTMONKS_A2B_GATE_NAMES as readonly string[]).includes("explicitZero"));
  for (const gate of SPORTMONKS_A2B_GATE_NAMES) assert.notEqual(noZero.gates[gate].status, "fail", gate);
});

test("contradictory provider semantics fail instead of being normalized away", () => {
  const broken = audit({
    scores: [
      { description: "2ND_HALF", score: { goals: 2, participant: "home" } },
      { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
      { description: "CURRENT", score: { goals: 3, participant: "home" } },
      { description: "CURRENT", score: { goals: 1, participant: "away" } },
    ],
    lineups: [...lineup(100, 1), ...lineup(200, 101), { player_id: 999, team_id: 100, type_id: 99, position_id: 99 }],
    statistics: [
      stat(100, 45, "BALL_POSSESSION", 70),
      stat(200, 45, "BALL_POSSESSION", 40),
      stat(100, 42, "SHOTS_TOTAL", 2),
      stat(100, 86, "SHOTS_ON_TARGET", 3),
    ],
    xgfixture: [stat(100, 5304, "EXPECTED_GOALS", 0.5), stat(100, 7943, "EXPECTED_NON_PENALTY_GOALS", 0.7)],
  });
  for (const gate of ["scoreSemantics", "lineupTypes", "broadPositions", "possessionSum", "shotsOnTarget", "nonPenaltyXg"] as const) {
    assert.equal(broken.gates[gate].status, "fail", gate);
  }
});

test("unknown lineup participants and duplicate players fail", () => {
  const rows = fixture().lineups as Array<Record<string, unknown>>;
  rows[0] = { ...rows[0], position_id: 999 };
  rows[1] = { ...rows[1], team_id: 9999 };
  const result = audit({ lineups: rows });
  assert.equal(result.gates.broadPositions.status, "fail");
  assert.equal(result.gates.lineupParticipants.status, "fail");
  assert.equal(result.gates.lineupTypes.status, "fail");

  const duplicate = fixture().lineups as Array<Record<string, unknown>>;
  duplicate[12] = { ...duplicate[12], player_id: 1 };
  assert.equal(audit({ lineups: duplicate }).gates.lineupParticipants.status, "fail");
});

test("a returned lineup must discriminate 11 starters and bench rows on both sides (PR #30 semantics)", () => {
  const noBench = (fixture().lineups as Array<{ type_id: number }>).filter((row) => row.type_id !== 12);
  assert.equal(audit({ lineups: noBench }).gates.lineupTypes.status, "fail");
  const tenStarters = (fixture().lineups as Array<Record<string, unknown>>).slice(1);
  assert.equal(audit({ lineups: tenStarters }).gates.lineupTypes.status, "fail");
  assert.equal(audit({ lineups: [] }).gates.lineupTypes.status, "unverified");
});

test("regression (main 2b2aa7c): a bench row without a player id neither fails the audit nor the parser", () => {
  const rows = [...(fixture().lineups as Array<Record<string, unknown>>), { player_id: null, team_id: 200, type_id: 12, position_id: 25 }];
  const value = fixture({ lineups: rows });
  const result = audit({ lineups: rows });
  assert.equal(result.gates.lineupParticipants.status, "pass");
  assert.equal(result.gates.lineupTypes.status, "pass");
  assert.deepEqual(result.observed.lineupBenchCounts, { home: 1, away: 2 });
  assert.doesNotThrow(() => parseSportmonksLedgerCapture(capture(value), { fixtureMint: SPORTMONKS_A2B_PARSER_FIXTURE_MINT, runId: null }));
});

test("broad positions pass only when all of 24-27 are observed and nothing else", () => {
  const gkOnly = (fixture().lineups as Array<Record<string, unknown>>).map((row) => ({ ...row, position_id: 24 }));
  assert.equal(audit({ lineups: gkOnly }).gates.broadPositions.status, "unverified");
  const noPositions = (fixture().lineups as Array<Record<string, unknown>>).map((row) => ({ ...row, position_id: null }));
  assert.equal(audit({ lineups: noPositions }).gates.broadPositions.status, "unverified");
});

test("regression (main vs PR #30): FT with one score pair is unverified, not a pass", () => {
  const onePair = audit({
    scores: [
      { description: "2ND_HALF", score: { goals: 2, participant: "home" } },
      { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
    ],
  });
  assert.equal(onePair.gates.scoreSemantics.status, "unverified");
  assert.equal(audit({ scores: [] }).gates.scoreSemantics.status, "fail");
  const conflicting = audit({
    scores: [
      ...(fixture().scores as unknown[]),
      { description: "CURRENT", score: { goals: 5, participant: "home" } },
    ],
  });
  assert.equal(conflicting.gates.scoreSemantics.status, "fail");
});

test("extra-time semantics require both pairs and a CURRENT score no lower than 90 minutes", () => {
  const aet = (sh: [number, number], cur: [number, number] | null) => [
    { description: "2ND_HALF", score: { goals: sh[0], participant: "home" } },
    { description: "2ND_HALF", score: { goals: sh[1], participant: "away" } },
    ...(cur
      ? [
          { description: "CURRENT", score: { goals: cur[0], participant: "home" } },
          { description: "CURRENT", score: { goals: cur[1], participant: "away" } },
        ]
      : []),
  ];
  assert.equal(audit({ state: { developer_name: "AET" }, scores: aet([1, 1], [2, 1]) }).gates.scoreSemantics.status, "pass");
  assert.equal(audit({ state: { developer_name: "AET" }, scores: aet([2, 1], [1, 1]) }).gates.scoreSemantics.status, "fail");
  assert.equal(audit({ state: { developer_name: "FT_PEN" }, scores: aet([1, 1], null) }).gates.scoreSemantics.status, "fail");
});

test("formations fail on an unknown participant or an invalid string", () => {
  assert.equal(audit({ formations: [{ participant_id: 100, formation: "4-3-3" }, { participant_id: 999, formation: "4-4-2" }] }).gates.formationSemantics.status, "fail");
  assert.equal(audit({ formations: [{ participant_id: 100, formation: "4-3-3" }, { participant_id: 200, formation: "442" }] }).gates.formationSemantics.status, "fail");
  assert.equal(audit({ formations: [{ participant_id: 100, formation: "4-3-3" }] }).gates.formationSemantics.status, "unverified");
  assert.equal(audit({ formations: [] }).gates.formationSemantics.status, "unverified");
});

test("missing optional stats stay unverified and are never counted as zero", () => {
  const missing = audit({ statistics: [], xgfixture: [] });
  assert.equal(missing.gates.possessionSum.status, "unverified");
  assert.equal(missing.gates.shotsOnTarget.status, "unverified");
  assert.equal(missing.gates.nonPenaltyXg.status, "unverified");
  assert.deepEqual(missing.observed.explicitZeroStatTypes, []);
  assert.deepEqual(missing.observed.presentAllowlistedStatTypes, []);
  assert.deepEqual(missing.observed.omittedAllowlistedStatTypes, ["34", "42", "45", "86", "5304", "5305", "7943"]);
  const nullValue = audit({ xgfixture: [stat(100, 5304, "EXPECTED_GOALS", null), stat(100, 7943, "EXPECTED_NON_PENALTY_GOALS", 0.4)] });
  assert.equal(nullValue.gates.nonPenaltyXg.status, "unverified");
  assert.ok(!nullValue.observed.explicitZeroStatTypes.includes("5304"));
});

// ---------------------------------------------------------------------------
// Evidence summaries
// ---------------------------------------------------------------------------

test("strict gate evidence never upgrades pass+unverified into a pooled pass", () => {
  const evidence = summarizeSportmonksA2BGateEvidence([audit(), audit({ id: 9002, xgfixture: [] })]);
  assert.deepEqual(evidence.nonPenaltyXg, { status: "unverified", passFixtures: 1, failFixtures: 0, unverifiedFixtures: 1 });
  assert.equal(summarizeSportmonksA2BGateEvidence([]).participantLocations.status, "unverified");
});

test("provider semantics separate optional coverage from contradictions", () => {
  const summary = summarizeSportmonksA2BProviderSemantics([audit(), audit({ id: 9002, xgfixture: [] })]);
  assert.equal(summary.status, "pass");
  assert.equal(summary.gateEvidence.nonPenaltyXg.status, "unverified");

  const failed = summarizeSportmonksA2BProviderSemantics([audit(), audit({ id: 9003, scores: [{ description: "2ND_HALF", score: { goals: 1, participant: "home" } }] })]);
  assert.equal(failed.status, "fail");
  assert.ok(failed.blockers.some((item) => item.includes("score")));

  assert.equal(summarizeSportmonksA2BProviderSemantics([]).status, "fail");
  const starterOnly = (fixture().lineups as Array<{ type_id: number }>).filter((row) => row.type_id === 11);
  const noBenchSample = summarizeSportmonksA2BProviderSemantics([audit({ lineups: starterOnly })]);
  assert.ok(noBenchSample.blockers.some((item) => item.includes("11/12")));
});

test("competition profiles keep coverage per league and ignore every other league", () => {
  const ligat = audit({ id: 9100, league_id: 372, season_id: 25000, xgfixture: [] });
  const pl = [audit(), audit({ id: 9002, xgfixture: [] })];
  const profile = buildSportmonksA2BCompetitionProfile("8", [...pl, ligat]);
  assert.equal(profile.fixtures, 2);
  assert.equal(profile.familyCoverage.xg.nonEmptyFixtures, 1);
  assert.equal(profile.familyCoverage.xg.coverageRatio, 0.5);
  assert.equal(profile.statTypeCoverage["5304"].fixturesPresent, 1);
  assert.equal(profile.statTypeCoverage["34"].fixturesExplicitZero, 2);
  assert.deepEqual(profile.contradictions, []);

  // Ligat ha'Al's missing xG is never filled from another competition.
  const ligatProfile = buildSportmonksA2BCompetitionProfile("372", [...pl, ligat]);
  assert.equal(ligatProfile.fixtures, 1);
  assert.equal(ligatProfile.familyCoverage.xg.nonEmptyFixtures, 0);
  assert.equal(ligatProfile.familyCoverage.xg.coverageRatio, 0);
  assert.equal(ligatProfile.gateEvidence.nonPenaltyXg.status, "unverified");

  const empty = buildSportmonksA2BCompetitionProfile("564", [...pl, ligat]);
  assert.equal(empty.fixtures, 0);
  assert.equal(empty.familyCoverage.lineups.coverageRatio, null);
  assert.equal(empty.gateEvidence.participantLocations.status, "unverified");
});

test("regression (main readiness): an unsampled season reports no coverage ratio instead of 0", () => {
  const profile = buildSportmonksA2BSeasonProfile({
    providerLeagueId: "8",
    providerSeasonId: "28083",
    seasonName: "2026/2027",
    sampleReasons: ["most_recent"],
    requestedFixtures: 2,
    results: [],
  });
  assert.equal(profile.familyCoverage.xg.coverageRatio, null);
  assert.equal(profile.seasonSampleStatus, "blocked");
  assert.ok(profile.blockers.some((item) => item.includes("0 of 2")));
});

test("regression (main readiness): a season is never sample_clean on pooled pass+unverified score evidence", () => {
  const onePair = audit({ id: 9002, scores: [{ description: "CURRENT", score: { goals: 1, participant: "home" } }, { description: "CURRENT", score: { goals: 0, participant: "away" } }] });
  const profile = buildSportmonksA2BSeasonProfile({
    providerLeagueId: "8",
    providerSeasonId: "28083",
    seasonName: null,
    sampleReasons: ["most_recent"],
    requestedFixtures: 2,
    results: [
      { providerFixtureId: "9001", parseStatus: "pass", audit: audit() },
      { providerFixtureId: "9002", parseStatus: "pass", audit: onePair },
    ],
  });
  assert.equal(profile.gateEvidence.scoreSemantics.status, "unverified");
  assert.equal(profile.seasonSampleStatus, "blocked");

  const clean = buildSportmonksA2BSeasonProfile({
    providerLeagueId: "8",
    providerSeasonId: "28083",
    seasonName: null,
    sampleReasons: ["most_recent", "required"],
    requestedFixtures: 2,
    results: [
      { providerFixtureId: "9001", parseStatus: "pass", audit: audit() },
      { providerFixtureId: "9002", parseStatus: "pass", audit: audit({ id: 9002, xgfixture: [] }) },
    ],
  });
  assert.equal(clean.seasonSampleStatus, "sample_clean");
  // Missing optional xG is coverage, not a blocker.
  assert.equal(clean.familyCoverage.xg.coverageRatio, 0.5);
});

test("a season profile refuses another season's or league's fixture", () => {
  assert.throws(
    () =>
      buildSportmonksA2BSeasonProfile({
        providerLeagueId: "8",
        providerSeasonId: "25583",
        seasonName: null,
        sampleReasons: ["required"],
        requestedFixtures: 1,
        results: [{ providerFixtureId: "9001", parseStatus: "pass", audit: audit() }],
      }),
    /received fixture 9001 of 8:28083/,
  );
  const failedDetail = buildSportmonksA2BSeasonProfile({
    providerLeagueId: "8",
    providerSeasonId: "28083",
    seasonName: null,
    sampleReasons: ["required"],
    requestedFixtures: 1,
    results: [{ providerFixtureId: "9001", parseStatus: "fail", audit: null }],
  });
  assert.equal(failedDetail.seasonSampleStatus, "blocked");
  assert.equal(failedDetail.auditedFixtures, 0);
});

// ---------------------------------------------------------------------------
// Competition identity
// ---------------------------------------------------------------------------

test("league-name comparison is case, accent and punctuation insensitive", () => {
  assert.equal(sportmonksLeagueNameMatches("Ligat Ha'Al", "Ligat ha'Al"), true);
  assert.equal(sportmonksLeagueNameMatches("Premier League", "La Liga"), false);
  assert.equal(sportmonksLeagueNameMatches(null, "La Liga"), false);
});

test("league identity passes only when subscription and detail agree on id, name, country, ISO2, type and seasons", () => {
  const good = auditSportmonksA2BLeagueIdentity({ target: PL, entitlement: plEntitlement(), detail: plDetail() });
  assert.equal(good.identityStatus, "pass");
  assert.ok(Object.values(good.gates).every((gate) => gate.status === "pass"));

  const cases: Array<[string, SportmonksA2BEntitlementRow | null, Record<string, unknown> | null, string]> = [
    ["not entitled", null, plDetail(), "entitled"],
    ["no detail", plEntitlement(), null, "currentSeason"],
    ["subscription ISO2", plEntitlement({ countryIso2: "US" }), plDetail(), "countryIso2"],
    ["detail ISO2", plEntitlement(), plDetail({ country: { name: "England", iso2: "ES" } }), "countryIso2"],
    ["subscription country missing", plEntitlement({ countryName: null, countryIso2: null }), plDetail(), "countryIso2"],
    ["detail country name", plEntitlement(), plDetail({ country: { name: "Spain", iso2: "GB" } }), "country"],
    ["subscription name", plEntitlement({ name: "La Liga" }), plDetail(), "name"],
    ["detail id", plEntitlement(), plDetail({ id: 9 }), "id"],
    ["subscription sub_type", plEntitlement({ subType: "cup_international" }), plDetail(), "type"],
    ["detail type", plEntitlement(), plDetail({ type: "cup" }), "type"],
    ["current season of another league", plEntitlement(), plDetail({ currentseason: { id: 28083, league_id: 9, is_current: true } }), "currentSeason"],
    ["current season not current", plEntitlement(), plDetail({ currentseason: { id: 28083, league_id: 8, is_current: false } }), "currentSeason"],
    ["foreign season", plEntitlement(), plDetail({ seasons: [{ id: 1, league_id: 564, name: "x" }] }), "seasonLeague"],
    ["malformed season", plEntitlement(), plDetail({ seasons: [{ id: 1, name: "no league id" }] }), "seasonLeague"],
  ];
  for (const [label, entitlement, detail, gate] of cases) {
    const result = auditSportmonksA2BLeagueIdentity({ target: PL, entitlement, detail });
    assert.equal(result.identityStatus, "fail", label);
    assert.equal(result.gates[gate as keyof typeof result.gates].status, "fail", `${label}: ${gate}`);
  }
});

test("entitlement rows are normalized, deduplicated and refused when a repeat disagrees", () => {
  const row = parseSportmonksA2BEntitlementRow({ id: 8, name: "Premier League", country_id: 462, country: { name: "England", iso2: "gb" }, type: "league", sub_type: "domestic", active: true });
  assert.deepEqual(row, plEntitlement());
  assert.equal(parseSportmonksA2BEntitlementRow({ id: "x" }), null);
  const merged = mergeSportmonksA2BEntitlementRows([plEntitlement({ providerLeagueId: "82", name: "Bundesliga" }), plEntitlement(), plEntitlement()]);
  assert.deepEqual(merged.map((r) => r.providerLeagueId), ["8", "82"]);
  assert.throws(() => mergeSportmonksA2BEntitlementRows([plEntitlement(), plEntitlement({ countryIso2: "US" })]), /different details/);
});

test("the entitlement details hash binds country, type and sub_type", () => {
  const base = { capturedAt: "2026-11-04T06:00:00.000Z", source: "sportmonks_all_leagues_subscription", rows: [plEntitlement()] };
  const first = sportmonksA2BEntitlementDetailsSha256(base);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(sportmonksA2BEntitlementDetailsSha256({ ...base, rows: [plEntitlement()] }), first);
  for (const change of [{ countryIso2: "US" }, { type: "cup" }, { subType: "international" }, { active: false }] as const) {
    assert.notEqual(sportmonksA2BEntitlementDetailsSha256({ ...base, rows: [plEntitlement(change)] }), first);
  }
});

// ---------------------------------------------------------------------------
// Season selection and discovery
// ---------------------------------------------------------------------------

test("seasons are ordered current first, then most recent", () => {
  const { seasons, malformedRows } = parseSportmonksA2BLeagueSeasons(plDetail());
  assert.deepEqual(seasons.map((season) => season.id), ["28083", "25583", "23614"]);
  assert.equal(malformedRows, 0);
});

test("required seasons are sampled explicitly and must belong to the league", () => {
  const { seasons } = parseSportmonksA2BLeagueSeasons(plDetail());
  const selection = selectSportmonksA2BSeasons({
    providerLeagueId: "8",
    seasons,
    seasonsPerLeague: 1,
    requiredSeasons: [
      { providerLeagueId: "8", providerSeasonId: "23614" },
      { providerLeagueId: "8", providerSeasonId: "28083" },
      { providerLeagueId: "8", providerSeasonId: "11111" },
      { providerLeagueId: "564", providerSeasonId: "25583" },
    ],
  });
  assert.deepEqual(
    selection.selected.map(({ season, reasons }) => [season.id, reasons]),
    [
      ["28083", ["most_recent", "required"]],
      ["23614", ["required"]],
    ],
  );
  assert.deepEqual(selection.missingRequiredSeasonIds, ["11111"]);
  assert.equal(selection.historyDepthInsufficient, false);
  assert.equal(selectSportmonksA2BSeasons({ providerLeagueId: "8", seasons, seasonsPerLeague: 4, requiredSeasons: [] }).historyDepthInsufficient, true);
});

test("season schedules yield the most recent finished fixtures of exactly that league and season", () => {
  const stages = [
    {
      fixtures: [{ id: 1, league_id: 8, season_id: 28083, state_id: 5, starting_at: "2026-10-01 14:00:00" }],
      rounds: [
        {
          fixtures: [
            { id: 2, league_id: 8, season_id: 28083, state: { developer_name: "AET" }, starting_at_timestamp: 1790000000 },
            { id: 3, league_id: 8, season_id: 28083, state: { developer_name: "NS" }, state_id: 5, starting_at: "2026-11-30 14:00:00" },
            { id: 4, league_id: 8, season_id: 25583, state_id: 5, starting_at: "2026-10-20 14:00:00" },
            { id: 5, league_id: 564, season_id: 28083, state_id: 5, starting_at: "2026-10-21 14:00:00" },
            { id: 1, league_id: 8, season_id: 28083, state_id: 5, starting_at: "2026-10-01 14:00:00" },
          ],
        },
      ],
    },
  ];
  assert.equal(extractSportmonksScheduleFixtures(stages).length, 5);
  assert.equal(isSportmonksFinishedFixtureRow({ state: { developer_name: "NS" }, state_id: 5 }), false);
  assert.equal(isSportmonksFinishedFixtureRow({ state_id: "8" }), true);
  const picked = selectSportmonksFinishedSeasonFixtures({ stages, providerLeagueId: "8", providerSeasonId: "28083", limit: 5 });
  assert.deepEqual(picked.map((row) => row.id), [1, 2]);
});

// ---------------------------------------------------------------------------
// Arguments, pagination, credentials
// ---------------------------------------------------------------------------

test("CLI arguments are strict", () => {
  assert.deepEqual(parseSportmonksA2BPilotArgs([]), { out: "artifacts/kapiloto-v4-a2b", seasonsPerLeague: 3, fixturesPerSeason: 2, requiredSeasons: [] });
  const parsed = parseSportmonksA2BPilotArgs(["--out", "x", "--seasons-per-league", "2", "--fixtures-per-season", "1", "--required-seasons", "8:23614, 564:23621", "--required-season", "372:1"]);
  assert.deepEqual(parsed.requiredSeasons, [
    { providerLeagueId: "8", providerSeasonId: "23614" },
    { providerLeagueId: "564", providerSeasonId: "23621" },
    { providerLeagueId: "372", providerSeasonId: "1" },
  ]);
  assert.deepEqual(parseSportmonksA2BPilotArgs(["--required-seasons", ""]).requiredSeasons, []);
  assert.throws(() => parseSportmonksA2BPilotArgs(["--days", "45"]), /Unknown argument/);
  assert.throws(() => parseSportmonksA2BPilotArgs(["--seasons-per-league", "7"]), /between 1 and 6/);
  assert.throws(() => parseSportmonksA2BPilotArgs(["--fixtures-per-season", "1.5"]), /between 1 and 5/);
  assert.throws(() => parseSportmonksA2BPilotArgs(["--required-seasons", "8:1,8:1"]), /duplicate required season/);
  assert.throws(() => parseSportmonksA2BPilotArgs(["--required-seasons", "2:1"]), /outside the five reviewed target leagues/);
  assert.throws(() => parseSportmonksA2BPilotArgs(["--required-seasons", "8-1"]), /LEAGUE_ID:SEASON_ID/);
});

test("pagination caps fail closed when the provider says more pages exist", () => {
  assert.doesNotThrow(() => assertSportmonksA2BPaginationComplete({ label: "entitlement", page: 99, cap: 100, hasMore: true }));
  assert.throws(() => assertSportmonksA2BPaginationComplete({ label: "entitlement", page: 100, cap: 100, hasMore: true }), /refusing a partial snapshot/);
  assert.doesNotThrow(() => assertSportmonksA2BPaginationComplete({ label: "entitlement", page: 100, cap: 100, hasMore: false }));
  assert.throws(() => assertSportmonksA2BPaginationComplete({ label: "entitlement", page: 0, cap: 100, hasMore: false }), /positive integers/);
  assert.throws(() => assertSportmonksA2BSinglePage("season schedule", { has_more: true }), /refusing a partial read/);
  assert.doesNotThrow(() => assertSportmonksA2BSinglePage("season schedule", undefined));
  assert.doesNotThrow(() => assertSportmonksA2BSinglePage("season schedule", { has_more: false }));
});

test("sanitized endpoints never carry the API token", () => {
  const url = new URL("https://api.sportmonks.com/v3/football/fixtures/9001");
  url.searchParams.set("include", "participants;scores");
  url.searchParams.set("api_token", TOKEN);
  url.searchParams.set("API_TOKEN", TOKEN);
  const sanitized = sanitizeSportmonksEndpoint(url);
  assert.equal(sanitized, "/v3/football/fixtures/9001?include=participants%3Bscores");
  assert.ok(!sanitized.includes(TOKEN));
});

test("the credential guard detects raw and percent-encoded tokens and refuses weak tokens", () => {
  const guard = createSportmonksA2BCredentialGuard(TOKEN);
  assert.equal(guard.contains(`{"next_page":"https://x/?api_token=${TOKEN}&page=2"}`), true);
  assert.equal(guard.contains(new TextEncoder().encode(`x${TOKEN}x`)), true);
  assert.equal(guard.contains("{}"), false);
  assert.equal(guard.redact(`a ${TOKEN} b ${TOKEN}`), "a [REDACTED] b [REDACTED]");
  const special = "abc/def+ghi=jkl0123456";
  assert.equal(createSportmonksA2BCredentialGuard(special).contains(`?api_token=${encodeURIComponent(special)}`), true);
  assert.throws(() => createSportmonksA2BCredentialGuard("short"), /at least 16/);
  assert.throws(() => createSportmonksA2BCredentialGuard("has whitespace 0123456789"), /without whitespace/);
});

// ---------------------------------------------------------------------------
// Output directory, raw archive and scrub
// ---------------------------------------------------------------------------

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "kapiloto-a2b-"));
}

test("the output directory must be empty or absent", async () => {
  const root = await tempDir();
  try {
    await ensureEmptySportmonksA2BOutputDirectory(path.join(root, "fresh"));
    await writeFile(path.join(root, "fresh", "pilot-report.json"), "{}");
    await assert.rejects(ensureEmptySportmonksA2BOutputDirectory(path.join(root, "fresh")), /must be empty/);
    await writeFile(path.join(root, "file"), "x");
    await assert.rejects(ensureEmptySportmonksA2BOutputDirectory(path.join(root, "file")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the raw archive stores exact bytes by SHA-256 with a sanitized index, and refuses credential echoes", async () => {
  const root = await tempDir();
  try {
    const archive = new SportmonksA2BRawArchive(root, createSportmonksA2BCredentialGuard(TOKEN));
    await archive.init();
    const bytes = new TextEncoder().encode('{"data":[],"pagination":{"has_more":false}}');
    const recorded = await archive.record({ bytes, endpoint: "/v3/football/leagues?page=1", status: 200, contentType: "application/json" });
    assert.equal(recorded, sha256Bytes(bytes));
    assert.deepEqual(new Uint8Array(await readFile(path.join(root, "raw", `${recorded}.bin`))), bytes);
    // Same bytes from another endpoint: one file, two index entries.
    await archive.record({ bytes, endpoint: "/v3/football/leagues?page=2", status: 200, contentType: "application/json" });
    const index = JSON.parse(await readFile(path.join(root, "raw-index.json"), "utf8"));
    assert.equal(index.contract_version, "kapiloto-sportmonks-a2b-raw-index-v1");
    assert.deepEqual(index.responses.map((entry: { endpoint: string }) => entry.endpoint), ["/v3/football/leagues?page=1", "/v3/football/leagues?page=2"]);
    assert.deepEqual(await readdir(path.join(root, "raw")), [`${recorded}.bin`]);

    const echo = new TextEncoder().encode(`{"pagination":{"next_page":"https://api.sportmonks.com/v3/football/leagues?api_token=${TOKEN}&page=2"}}`);
    await assert.rejects(
      archive.record({ bytes: echo, endpoint: "/v3/football/leagues?page=3", status: 200, contentType: "application/json" }),
      SportmonksA2BCredentialEchoError,
    );
    await assert.rejects(archive.record({ bytes, endpoint: `/v3/football/leagues?api_token=${TOKEN}`, status: 200, contentType: null }), /still contains the API credential/);
    assert.deepEqual(await readdir(path.join(root, "raw")), [`${recorded}.bin`]);
    assert.equal(archive.snapshot().length, 2);
    assert.ok(!(await readFile(path.join(root, "raw-index.json"), "utf8")).includes(TOKEN));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the final scrub empties an output directory that contains the credential anywhere", async () => {
  const root = await tempDir();
  try {
    const guard = createSportmonksA2BCredentialGuard(TOKEN);
    await mkdir(path.join(root, "captures"), { recursive: true });
    await writeFile(path.join(root, "pilot-report.json"), "{}");
    assert.deepEqual(await scrubSportmonksA2BOutputIfCredentialPresent(root, guard), []);
    assert.deepEqual((await readdir(root)).sort(), ["captures", "pilot-report.json"]);

    await writeFile(path.join(root, "captures", "8-1-2.json"), JSON.stringify({ provider_endpoint: `/x?api_token=${TOKEN}` }));
    assert.deepEqual(await scrubSportmonksA2BOutputIfCredentialPresent(root, guard), ["captures/8-1-2.json"]);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function reportFor(blockingErrors: Array<{ code: string }> = []) {
  const audits = [audit(), audit({ id: 9002 })];
  const identity = auditSportmonksA2BLeagueIdentity({ target: PL, entitlement: plEntitlement(), detail: plDetail() });
  const season = buildSportmonksA2BSeasonProfile({
    providerLeagueId: "8",
    providerSeasonId: "28083",
    seasonName: "2026/2027",
    sampleReasons: ["most_recent"],
    requestedFixtures: 2,
    results: audits.map((a) => ({ providerFixtureId: a.providerFixtureId, parseStatus: "pass" as const, audit: a })),
  });
  return buildSportmonksA2BPilotReport({
    generatedAt: "2026-11-04T06:05:00.000Z",
    capturedAt: "2026-11-04T06:00:00.000Z",
    config: { seasonsPerLeague: 1, fixturesPerSeason: 2, requiredSeasons: [], entitlementPageCap: 100, perPage: 50 },
    entitlement: { source: "sportmonks_all_leagues_subscription", competitionCount: 1, snapshotSha256: hash, detailsSha256: hash, rawPageSha256: [hash] },
    leagues: [{ target: PL, identity, leagueDetailRawSha256: hash, sampledSeasons: [season], competitionProfile: buildSportmonksA2BCompetitionProfile("8", audits) }],
    providerSemantics: summarizeSportmonksA2BProviderSemantics(audits),
    blockingErrors,
    rawResponseIndex: [],
    captureCount: 2,
  });
}

function keysAndStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) keysAndStrings(item, out);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      keysAndStrings(item, out);
    }
  }
  return out;
}

test("the report never represents A2-B as backfill approval, ingest, a mint or team identity readiness", () => {
  const clean = reportFor();
  assert.equal(clean.evidenceStatus, "clean");
  assert.equal(clean.backfillApproval.approved, false);
  assert.equal(clean.teamIdentityReadiness.assessed, false);
  assert.equal(clean.fixtureMint.allowed, false);
  assert.deepEqual(clean.fixtureMint.parserPolicy, { allowed: false, kickoffBefore: null });
  const words = keysAndStrings(clean);
  assert.ok(!words.includes("supported"), "no competition is marked supported");
  assert.ok(!words.some((word) => /identityComplete|backfillApproved|ingestAllowed/i.test(word)));
  assert.ok(!JSON.stringify(clean).includes('"approved":true'));

  const blocked = reportFor([{ code: "history_depth_insufficient" }]);
  assert.equal(blocked.evidenceStatus, "blocked");
  assert.equal(blocked.backfillApproval.approved, false);
});

test("a provider-semantics failure always blocks the report", () => {
  const report = buildSportmonksA2BPilotReport({
    ...{
      generatedAt: "2026-11-04T06:05:00.000Z",
      capturedAt: "2026-11-04T06:00:00.000Z",
      config: { seasonsPerLeague: 1, fixturesPerSeason: 2, requiredSeasons: [], entitlementPageCap: 100, perPage: 50 },
      entitlement: { source: "s", competitionCount: 0, snapshotSha256: hash, detailsSha256: hash, rawPageSha256: [] },
      leagues: [],
      rawResponseIndex: [],
      captureCount: 0,
    },
    providerSemantics: summarizeSportmonksA2BProviderSemantics([]),
    blockingErrors: [],
  });
  assert.equal(report.evidenceStatus, "blocked");
  assert.deepEqual(report.blockingErrors.map((error) => error.code), ["provider_semantics_failed"]);
});
