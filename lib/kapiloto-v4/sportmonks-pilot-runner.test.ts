import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SPORTMONKS_A2B_TARGET_LEAGUES } from "./sportmonks-pilot";
import { runSportmonksA2BPilotCli, SPORTMONKS_A2B_ENTITLEMENT_PAGE_CAP, type SportmonksA2BFetch } from "./sportmonks-pilot-runner";

/**
 * Offline rehearsal of the A2-B runner against an in-memory Sportmonks with
 * the response shapes the 2026-11-02 readiness run used. No network, no
 * Supabase: the transport is the only injected dependency.
 */

const TOKEN = "RehearsalToken0123456789abcdefXYZ";
const COUNTRY: Record<string, { name: string; iso2: string }> = {
  "8": { name: "England", iso2: "GB" },
  "82": { name: "Germany", iso2: "DE" },
  "564": { name: "Spain", iso2: "ES" },
  "384": { name: "Italy", iso2: "IT" },
  "372": { name: "Israel", iso2: "IL" },
};

type World = {
  leagues: Array<Record<string, unknown>>;
  details: Map<string, Record<string, unknown>>;
  schedules: Map<string, unknown[]>;
  fixtures: Map<string, Record<string, unknown>>;
};

function seasonIds(leagueId: string): string[] {
  return [1, 2, 3].map((n) => `${leagueId}0${n}`);
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
      player_name: `P${firstPlayerId + index}`,
      jersey_number: index + 1,
    })),
    { player_id: firstPlayerId + 50, team_id: teamId, type_id: 12, position_id: 26, player_name: `B${firstPlayerId}`, jersey_number: 30 },
    // A real 2026-11-02 edge case: a bench row without a provider player id.
    { player_id: null, team_id: teamId, type_id: 12, position_id: 25, player_name: null, jersey_number: null },
  ];
}

function stat(participant_id: number, type_id: number, developer_name: string, value: number) {
  return { participant_id, type_id, type: { developer_name }, data: { value } };
}

function fixtureDetail(id: number, leagueId: string, seasonId: string, withXg: boolean): Record<string, unknown> {
  const home = id * 10 + 1;
  const away = id * 10 + 2;
  return {
    id,
    league_id: Number(leagueId),
    season_id: Number(seasonId),
    starting_at_timestamp: 1_780_000_000 + id,
    state: { developer_name: "FT" },
    participants: [
      { id: home, name: `Home ${id}`, meta: { location: "home" } },
      { id: away, name: `Away ${id}`, meta: { location: "away" } },
    ],
    scores: [
      { description: "1ST_HALF", score: { goals: 1, participant: "home" } },
      { description: "1ST_HALF", score: { goals: 0, participant: "away" } },
      { description: "2ND_HALF", score: { goals: 2, participant: "home" } },
      { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
      { description: "CURRENT", score: { goals: 2, participant: "home" } },
      { description: "CURRENT", score: { goals: 1, participant: "away" } },
    ],
    lineups: [...lineup(home, id * 1000), ...lineup(away, id * 1000 + 100)],
    formations: [
      { participant_id: home, formation: "4-3-3" },
      { participant_id: away, formation: "4-4-2" },
    ],
    statistics: [
      stat(home, 45, "BALL_POSSESSION", 52),
      stat(away, 45, "BALL_POSSESSION", 48),
      stat(home, 42, "SHOTS_TOTAL", 12),
      stat(home, 86, "SHOTS_ON_TARGET", 5),
      stat(away, 42, "SHOTS_TOTAL", 9),
      stat(away, 86, "SHOTS_ON_TARGET", 2),
      stat(home, 34, "CORNERS", 0),
      stat(away, 34, "CORNERS", 3),
    ],
    xgfixture: withXg
      ? [
          stat(home, 5304, "EXPECTED_GOALS", 1.4),
          stat(home, 7943, "EXPECTED_NON_PENALTY_GOALS", 1.1),
          stat(away, 5304, "EXPECTED_GOALS", 0.9),
          stat(away, 7943, "EXPECTED_NON_PENALTY_GOALS", 0.9),
        ]
      : [],
  };
}

function world(): World {
  const leagues: Array<Record<string, unknown>> = [
    { id: 2, name: "Champions League", country_id: 41, country: { name: "Europe", iso2: null }, type: "league", sub_type: "cup_international", active: true },
  ];
  const details = new Map<string, Record<string, unknown>>();
  const schedules = new Map<string, unknown[]>();
  const fixtures = new Map<string, Record<string, unknown>>();
  for (const target of SPORTMONKS_A2B_TARGET_LEAGUES) {
    const id = target.providerLeagueId;
    const country = { name: COUNTRY[id].name, iso2: COUNTRY[id].iso2 };
    leagues.push({ id: Number(id), name: target.expectedName, country_id: Number(id) * 7, country, type: "league", sub_type: "domestic", active: true });
    const [current, previous, older] = seasonIds(id);
    const season = (sid: string, year: number, isCurrent: boolean) => ({
      id: Number(sid),
      league_id: Number(id),
      name: `${year}/${year + 1}`,
      is_current: isCurrent,
      starting_at: `${year}-08-01`,
      ending_at: `${year + 1}-05-31`,
    });
    details.set(id, {
      id: Number(id),
      name: target.expectedName,
      type: "league",
      sub_type: "domestic",
      country,
      currentseason: season(current, 2026, true),
      seasons: [season(older, 2024, false), season(current, 2026, true), season(previous, 2025, false)],
    });
    for (const [index, sid] of [current, previous, older].entries()) {
      const fixtureIds = [1, 2, 3].map((n) => Number(`${sid}${n}`));
      for (const fid of fixtureIds) fixtures.set(String(fid), fixtureDetail(fid, id, sid, id !== "372"));
      schedules.set(sid, [
        {
          id: Number(sid) * 10,
          rounds: [
            {
              fixtures: [
                { id: fixtureIds[0], league_id: Number(id), season_id: Number(sid), state_id: 5, starting_at: `202${4 + index}-10-01 14:00:00` },
                { id: fixtureIds[1], league_id: Number(id), season_id: Number(sid), state_id: 5, starting_at: `202${4 + index}-10-08 14:00:00` },
                { id: fixtureIds[2], league_id: Number(id), season_id: Number(sid), state_id: 1, starting_at: `202${4 + index}-12-01 14:00:00` },
              ],
            },
          ],
        },
      ]);
    }
  }
  return { leagues, details, schedules, fixtures };
}

type Calls = { urls: URL[] };

function sportmonks(w: World, calls: Calls, options: { echoTokenInNextPage?: boolean; alwaysMore?: boolean; failFixture?: string } = {}): SportmonksA2BFetch {
  return async (url) => {
    calls.urls.push(new URL(url));
    assert.equal(url.origin, "https://api.sportmonks.com");
    assert.equal(url.searchParams.get("api_token"), TOKEN);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const route = url.pathname.replace(/^\/v3\/football/, "");
    if (route === "/leagues") {
      const page = Number(url.searchParams.get("page"));
      assert.equal(url.searchParams.get("include"), "country");
      const half = Math.ceil(w.leagues.length / 2);
      const data = options.alwaysMore ? w.leagues.slice(0, 1) : page === 1 ? w.leagues.slice(0, half) : w.leagues.slice(half);
      const hasMore = options.alwaysMore ? true : page === 1;
      const nextPage = options.echoTokenInNextPage
        ? `https://api.sportmonks.com/v3/football/leagues?api_token=${TOKEN}&page=${page + 1}`
        : `https://api.sportmonks.com/v3/football/leagues?page=${page + 1}`;
      return json({ data, pagination: { count: data.length, per_page: 50, current_page: page, next_page: hasMore ? nextPage : null, has_more: hasMore } });
    }
    let match = /^\/leagues\/(\d+)$/.exec(route);
    if (match) {
      assert.equal(url.searchParams.get("include"), "country;currentSeason;seasons");
      return json({ data: w.details.get(match[1]) });
    }
    match = /^\/schedules\/seasons\/(\d+)$/.exec(route);
    if (match) return json({ data: w.schedules.get(match[1]) ?? [] });
    match = /^\/fixtures\/(\d+)$/.exec(route);
    if (match) {
      if (match[1] === options.failFixture) return json({ message: "Server Error" }, 500);
      assert.equal(url.searchParams.get("include"), "participants;scores;state;lineups;formations;statistics.type;xgfixture.type");
      return json({ data: w.fixtures.get(match[1]) });
    }
    return json({ message: "not found" }, 404);
  };
}

async function runIn(
  argv: string[],
  fetch: SportmonksA2BFetch,
  env: Record<string, string | undefined> = { SPORTMONKS_API_TOKEN: TOKEN },
): Promise<{ code: number; out: string; stdout: string; stderr: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "kapiloto-a2b-run-"));
  const out = path.join(root, "out");
  let stdout = "";
  let stderr = "";
  const code = await runSportmonksA2BPilotCli(["--out", out, ...argv], env, {
    fetch,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, out, stdout, stderr, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push(full);
  }
  return out;
}

async function assertNoToken(run: { out: string; stdout: string; stderr: string }): Promise<void> {
  assert.ok(!run.stdout.includes(TOKEN), "stdout");
  assert.ok(!run.stderr.includes(TOKEN), "stderr");
  for (const file of await filesUnder(run.out)) assert.ok(!(await readFile(file, "utf8")).includes(TOKEN), file);
}

test("a clean offline rehearsal archives exact raw bytes, samples every season and never approves anything", async () => {
  const w = world();
  const calls: Calls = { urls: [] };
  const [, , laLigaOldest] = seasonIds("564");
  const run = await runIn(["--seasons-per-league", "2", "--fixtures-per-season", "1", "--required-seasons", `564:${laLigaOldest}`], sportmonks(w, calls));
  try {
    assert.equal(run.code, 0, run.stderr);
    await assertNoToken(run);

    const report = JSON.parse(await readFile(path.join(run.out, "pilot-report.json"), "utf8"));
    assert.equal(report.contract_version, "kapiloto-sportmonks-a2b-pilot-report-v1");
    assert.equal(report.evidenceStatus, "clean");
    assert.deepEqual(report.blockingErrors, []);
    assert.equal(report.backfillApproval.approved, false);
    assert.equal(report.teamIdentityReadiness.assessed, false);
    assert.equal(report.fixtureMint.allowed, false);
    assert.equal(report.providerSemantics.status, "pass");
    // 5 leagues x 2 most-recent seasons x 1 fixture, plus the required La Liga season.
    assert.equal(report.captureCount, 11);
    assert.equal(report.entitlement.competitionCount, 6);
    assert.equal(report.entitlement.rawPageSha256.length, 2);

    const laLiga = report.leagues.find((league: { target: { providerLeagueId: string } }) => league.target.providerLeagueId === "564");
    assert.deepEqual(
      laLiga.sampledSeasons.map((season: { providerSeasonId: string; sampleReasons: string[] }) => [season.providerSeasonId, season.sampleReasons]),
      [
        ["56401", ["most_recent"]],
        ["56402", ["most_recent"]],
        ["56403", ["required"]],
      ],
    );
    for (const league of report.leagues) {
      assert.equal(league.identity.identityStatus, "pass", league.target.providerLeagueId);
      for (const season of league.sampledSeasons) assert.equal(season.seasonSampleStatus, "sample_clean");
    }
    // Ligat ha'Al without xG: explicit coverage 0 for its own fixtures only, not a blocker,
    // and not inherited from the other competitions.
    const ligat = report.leagues.find((league: { target: { providerLeagueId: string } }) => league.target.providerLeagueId === "372");
    assert.equal(ligat.competitionProfile.familyCoverage.xg.coverageRatio, 0);
    assert.equal(ligat.competitionProfile.gateEvidence.nonPenaltyXg.status, "unverified");
    const pl = report.leagues.find((league: { target: { providerLeagueId: string } }) => league.target.providerLeagueId === "8");
    assert.equal(pl.competitionProfile.familyCoverage.xg.coverageRatio, 1);

    // Every request is archived byte-exactly under its SHA-256, before parsing.
    const index = JSON.parse(await readFile(path.join(run.out, "raw-index.json"), "utf8"));
    assert.equal(index.responses.length, calls.urls.length);
    assert.equal(calls.urls.length, 2 + 5 + 11 + 11);
    for (const entry of index.responses) {
      const bytes = await readFile(path.join(run.out, "raw", `${entry.sha256}.bin`));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
      assert.equal(entry.bytes, bytes.byteLength);
      assert.ok(!entry.endpoint.includes("api_token"));
    }
    const captures = await readdir(path.join(run.out, "captures"));
    assert.equal(captures.length, 11);
    const first = JSON.parse(await readFile(path.join(run.out, "captures", captures[0]), "utf8"));
    assert.equal(first.parseStatus, "pass");
    assert.ok(index.responses.some((entry: { sha256: string }) => entry.sha256 === first.capture.raw_payload_sha256));
    assert.match(first.capture.provider_endpoint, /^\/v3\/football\/fixtures\/\d+\?include=/);

    const summary = JSON.parse(run.stdout);
    assert.equal(summary.backfillApproved, false);
    assert.equal(summary.teamIdentityAssessed, false);
  } finally {
    await run.cleanup();
  }
});

test("a response that echoes the token is never archived and the run aborts", async () => {
  const calls: Calls = { urls: [] };
  const run = await runIn([], sportmonks(world(), calls, { echoTokenInNextPage: true }));
  try {
    assert.equal(run.code, 1);
    assert.equal(calls.urls.length, 1);
    assert.match(run.stderr, /contains the API credential/);
    await assertNoToken(run);
    assert.deepEqual(await readdir(path.join(run.out, "raw")), []);
    assert.equal((await readdir(run.out)).includes("pilot-report.json"), false);
  } finally {
    await run.cleanup();
  }
});

test("entitlement pagination that never ends refuses a partial snapshot", async () => {
  const calls: Calls = { urls: [] };
  const run = await runIn([], sportmonks(world(), calls, { alwaysMore: true }));
  try {
    assert.equal(run.code, 1);
    assert.equal(calls.urls.length, SPORTMONKS_A2B_ENTITLEMENT_PAGE_CAP);
    assert.match(run.stderr, /refusing a partial snapshot/);
    await assertNoToken(run);
  } finally {
    await run.cleanup();
  }
});

test("a competition whose identity fails is not sampled and never borrows another league's evidence", async () => {
  const w = world();
  w.details.get("8")!.country = { name: "England", iso2: "EN" };
  const calls: Calls = { urls: [] };
  const run = await runIn(["--seasons-per-league", "1", "--fixtures-per-season", "1", "--required-seasons", "8:801"], sportmonks(w, calls));
  try {
    assert.equal(run.code, 2);
    await assertNoToken(run);
    const report = JSON.parse(await readFile(path.join(run.out, "pilot-report.json"), "utf8"));
    assert.equal(report.evidenceStatus, "blocked");
    assert.equal(report.backfillApproval.approved, false);
    const pl = report.leagues.find((league: { target: { providerLeagueId: string } }) => league.target.providerLeagueId === "8");
    assert.equal(pl.identity.identityStatus, "fail");
    assert.equal(pl.identity.gates.countryIso2.status, "fail");
    assert.deepEqual(pl.sampledSeasons, []);
    assert.equal(pl.competitionProfile.fixtures, 0);
    assert.equal(pl.competitionProfile.familyCoverage.lineups.coverageRatio, null);
    assert.deepEqual(
      report.blockingErrors.map((error: { code: string }) => error.code).sort(),
      ["competition_identity_failed", "required_season_not_sampled"],
    );
    assert.ok(!calls.urls.some((url) => /\/schedules\/seasons\/80\d$/.test(url.pathname)), "no PL season was requested");
    assert.equal(report.captureCount, 4);
  } finally {
    await run.cleanup();
  }
});

test("a required season outside the league's own season list blocks", async () => {
  const run = await runIn(["--seasons-per-league", "1", "--fixtures-per-season", "1", "--required-seasons", "564:999999"], sportmonks(world(), { urls: [] }));
  try {
    assert.equal(run.code, 2);
    const report = JSON.parse(await readFile(path.join(run.out, "pilot-report.json"), "utf8"));
    assert.deepEqual(report.blockingErrors, [{ code: "required_season_not_in_league", leagueId: "564", seasonId: "999999" }]);
  } finally {
    await run.cleanup();
  }
});

test("an HTTP error is archived before parsing, then aborts without leaking the token", async () => {
  const failFixture = `${seasonIds("8")[0]}2`;
  const run = await runIn(["--seasons-per-league", "1", "--fixtures-per-season", "1"], sportmonks(world(), { urls: [] }, { failFixture }));
  try {
    assert.equal(run.code, 1);
    assert.match(run.stderr, new RegExp(`Sportmonks HTTP 500 for /v3/football/fixtures/${failFixture}`));
    await assertNoToken(run);
    const index = JSON.parse(await readFile(path.join(run.out, "raw-index.json"), "utf8"));
    assert.equal(index.responses.at(-1).status, 500);
  } finally {
    await run.cleanup();
  }
});

test("bad arguments, a missing or weak token and a non-empty --out abort before any request", async () => {
  const calls: Calls = { urls: [] };
  const fetch = sportmonks(world(), calls);
  for (const [argv, env, pattern] of [
    [["--days", "45"], { SPORTMONKS_API_TOKEN: TOKEN }, /Unknown argument/],
    [[], {}, /SPORTMONKS_API_TOKEN is required/],
    [[], { SPORTMONKS_API_TOKEN: "short" }, /at least 16/],
  ] as const) {
    const run = await runIn([...argv], fetch, env);
    try {
      assert.equal(run.code, 1);
      assert.match(run.stderr, pattern);
    } finally {
      await run.cleanup();
    }
  }
  const root = await mkdtemp(path.join(tmpdir(), "kapiloto-a2b-run-"));
  try {
    await writeFile(path.join(root, "old-report.json"), "{}");
    let stderr = "";
    const code = await runSportmonksA2BPilotCli(["--out", root], { SPORTMONKS_API_TOKEN: TOKEN }, { fetch, stdout: () => {}, stderr: (text) => { stderr += text; } });
    assert.equal(code, 1);
    assert.match(stderr, /must be empty/);
    assert.deepEqual(await readdir(root), ["old-report.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(calls.urls.length, 0);
});
