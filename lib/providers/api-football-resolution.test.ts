import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ApiFootballClient } from "./api-football";
import { kickoffWindowDates, selectApiFootballFixture } from "./api-football-resolution";
import {
  API_FOOTBALL_COMPETITIONS,
  ROUND_264201,
  type VerifiedGame,
} from "./test-fixtures/api-football-round-264201";
import type { ProviderFixture, ProviderSpikeFixtureInput } from "./types";

function fixture(
  id: string,
  home: [string, string],
  away: [string, string],
  overrides: Partial<ProviderFixture> = {},
): ProviderFixture {
  return {
    provider: "api-football",
    providerFixtureId: id,
    kickoffAt: "2026-10-24T15:45:00+00:00",
    status: "NS",
    season: 2026,
    competition: { id: "383", name: "Ligat Ha'al", country: "Israel", round: null },
    home: { id: home[0], name: home[1] },
    away: { id: away[0], name: away[1] },
    ...overrides,
  };
}

const KATAMON = fixture("1555528", ["4486", "Hapoel Katamon"], ["4501", "Hapoel Tel Aviv"]);
const SHMONA = fixture("1555532", ["4510", "Ironi Kiryat Shmona"], ["4481", "Bnei Sakhnin"]);

function hapoelJerusalemInput(overrides: Partial<ProviderSpikeFixtureInput> = {}): ProviderSpikeFixtureInput {
  return {
    gameNumber: 2,
    homeTeam: "הפועל ירושלים",
    awayTeam: "הפועל תל אביב",
    kickoffAt: "2026-10-24T15:45:00Z",
    competition: "Ligat Ha'al",
    aliases: { home: ["Hapoel Jerusalem"], away: ["Hapoel Tel Aviv"] },
    ...overrides,
  };
}

test("Hebrew canonical names resolve through confirmed provider team ids", () => {
  const selection = selectApiFootballFixture(
    hapoelJerusalemInput({ aliases: undefined, providerTeamIds: { home: "4486", away: "4501" } }),
    [SHMONA, KATAMON],
  );
  assert.equal(selection.resolution, "provider_team_ids");
  assert.equal(selection.fixture?.providerFixtureId, "1555528");
});

test("a mapped provider team id bypasses name matching entirely", () => {
  const decoy = fixture("999", ["1", "Hapoel Jerusalem"], ["2", "Hapoel Tel Aviv"]);
  const renamed = fixture("1555528", ["4486", "Completely Different FC"], ["4501", "Another Name"]);
  const selection = selectApiFootballFixture(
    hapoelJerusalemInput({ providerTeamIds: { home: "4486", away: "4501" } }),
    [decoy, renamed],
  );
  assert.equal(selection.resolution, "provider_team_ids");
  assert.equal(selection.fixture?.providerFixtureId, "1555528");
});

test("mapped team ids are authoritative: no fixture with those ids is not_found, not a name guess", () => {
  const selection = selectApiFootballFixture(
    hapoelJerusalemInput({ aliases: { home: ["Hapoel Katamon"], away: ["Hapoel Tel Aviv"] }, providerTeamIds: { home: "7", away: "8" } }),
    [KATAMON],
  );
  assert.deepEqual(selection, { fixture: null, resolution: "not_found" });
});

test("one mapped id still needs the other side to pass the name threshold", () => {
  const input = hapoelJerusalemInput({ providerTeamIds: { home: "4486" } });
  assert.equal(selectApiFootballFixture(input, [KATAMON]).resolution, "provider_team_ids");
  const wrongOpponent = fixture("5", ["4486", "Hapoel Katamon"], ["4495", "Maccabi Petah Tikva"]);
  assert.equal(selectApiFootballFixture(input, [wrongOpponent]).resolution, "not_found");
});

test("regression: Hapoel Jerusalem is listed by API-Football as Hapoel Katamon", () => {
  // Hebrew name plus the Sportmonks English name is not enough on its own.
  assert.equal(selectApiFootballFixture(hapoelJerusalemInput(), [KATAMON]).resolution, "not_found");

  // The explicit provider alias bootstraps the match ...
  const viaAlias = selectApiFootballFixture(
    hapoelJerusalemInput({ aliases: { home: ["Hapoel Jerusalem", "Hapoel Katamon"], away: ["Hapoel Tel Aviv"] } }),
    [SHMONA, KATAMON],
  );
  assert.equal(viaAlias.resolution, "name_match");
  assert.equal(viaAlias.fixture?.home.id, "4486");

  // ... and the persisted id mapping makes it name-independent.
  const viaId = selectApiFootballFixture(
    hapoelJerusalemInput({ providerTeamIds: { home: "4486", away: "4501" } }),
    [KATAMON],
  );
  assert.equal(viaId.resolution, "provider_team_ids");
});

test("a fixture listed with home and away reversed is rejected, never matched", () => {
  const reversed = fixture("1555528", ["4501", "Hapoel Tel Aviv"], ["4486", "Hapoel Katamon"]);
  const byIds = hapoelJerusalemInput({ providerTeamIds: { home: "4486", away: "4501" } });
  assert.deepEqual(selectApiFootballFixture(byIds, [reversed]), { fixture: null, resolution: "orientation_mismatch" });

  const oneId = hapoelJerusalemInput({ providerTeamIds: { home: "4486" } });
  assert.equal(selectApiFootballFixture(oneId, [reversed]).resolution, "orientation_mismatch");

  const byNames = hapoelJerusalemInput({ aliases: { home: ["Hapoel Katamon"], away: ["Hapoel Tel Aviv"] } });
  assert.deepEqual(selectApiFootballFixture(byNames, [reversed]), { fixture: null, resolution: "orientation_mismatch" });
});

test("ambiguous name candidates are rejected instead of guessed", () => {
  const twin = fixture("777", ["9001", "Hapoel Katamon"], ["9002", "Hapoel Tel Aviv"]);
  const byNames = hapoelJerusalemInput({ aliases: { home: ["Hapoel Katamon"], away: ["Hapoel Tel Aviv"] } });
  assert.deepEqual(selectApiFootballFixture(byNames, [KATAMON, twin]), { fixture: null, resolution: "ambiguous" });

  const duplicateIds = fixture("778", ["4486", "Hapoel Katamon"], ["4501", "Hapoel Tel Aviv"]);
  const byIds = hapoelJerusalemInput({ providerTeamIds: { home: "4486", away: "4501" } });
  assert.equal(selectApiFootballFixture(byIds, [KATAMON, duplicateIds]).resolution, "ambiguous");
});

test("kickoff outside the tolerance is not matched even with perfect names", () => {
  const later = fixture("1555528", ["4486", "Hapoel Katamon"], ["4501", "Hapoel Tel Aviv"], {
    kickoffAt: "2026-10-24T20:00:00+00:00",
  });
  const input = hapoelJerusalemInput({ providerTeamIds: { home: "4486", away: "4501" } });
  assert.equal(selectApiFootballFixture(input, [later]).resolution, "not_found");
});

test("a mapped competition excludes same-named teams in another league", () => {
  const women = fixture("555", ["7001", "Hapoel Katamon W"], ["7002", "Hapoel Tel Aviv W"], {
    competition: { id: "999", name: "Ligat Nashim", country: "Israel", round: null },
  });
  const input = hapoelJerusalemInput({
    aliases: { home: ["Hapoel Katamon"], away: ["Hapoel Tel Aviv"] },
    providerCompetitionId: "383",
  });
  const selection = selectApiFootballFixture(input, [women, KATAMON]);
  assert.equal(selection.resolution, "name_match");
  assert.equal(selection.fixture?.providerFixtureId, "1555528");
});

// ---------------------------------------------------------------------------
// Round 264201 as actually observed at API-Football on 2026-10-24.
// ---------------------------------------------------------------------------

function providerList(): ProviderFixture[] {
  const real = ROUND_264201.filter((game) => game.apiFootballFixtureId).map((game) => {
    const competition = API_FOOTBALL_COMPETITIONS[game.competitionId];
    return fixture(
      game.apiFootballFixtureId as string,
      [game.home.apiFootball!.id, game.home.apiFootball!.name],
      [game.away.apiFootball!.id, game.away.apiFootball!.name],
      {
        kickoffAt: game.kickoffAt,
        competition: { id: competition.id, name: competition.name, country: competition.country, round: null },
      },
    );
  });
  // Same-day decoys from the real provider list: other clubs sharing a city or prefix.
  const decoys = [
    fixture("d1", ["4482", "Beitar Jerusalem"], ["4497", "Maccabi Tel Aviv"]),
    fixture("d2", ["4500", "Hapoel Haifa"], ["4502", "Hapoel Petah Tikva"], { kickoffAt: "2026-10-24T16:00:00+00:00" }),
    fixture("d3", ["48", "West Ham"], ["49", "Chelsea"], {
      kickoffAt: "2026-10-24T14:00:00+00:00",
      competition: { id: "39", name: "Premier League", country: "England", round: null },
    }),
  ];
  return [...real, ...decoys];
}

function inputFor(game: VerifiedGame, mode: "ids" | "names" | "hebrew-only"): ProviderSpikeFixtureInput {
  const katamon = game.home.apiFootball?.name === "Hapoel Katamon" ? ["Hapoel Katamon"] : [];
  return {
    gameNumber: game.gameNumber,
    homeTeam: game.home.hebrew,
    awayTeam: game.away.hebrew,
    kickoffAt: game.kickoffAt,
    competition: game.competitionName,
    aliases:
      mode === "hebrew-only"
        ? undefined
        : { home: [game.home.sportmonksName, ...katamon], away: [game.away.sportmonksName] },
    providerTeamIds:
      mode === "ids" ? { home: game.home.apiFootball?.id, away: game.away.apiFootball?.id } : undefined,
    providerCompetitionId: API_FOOTBALL_COMPETITIONS[game.competitionId].id,
  };
}

const VERIFIED = ROUND_264201.filter((game) => game.apiFootballFixtureId);

test("every currently known Toto team with a verified mapping resolves by provider id", () => {
  assert.equal(VERIFIED.length, 15);
  for (const game of VERIFIED) {
    const selection = selectApiFootballFixture(inputFor(game, "ids"), providerList());
    assert.equal(selection.resolution, "provider_team_ids", `game ${game.gameNumber}`);
    assert.equal(selection.fixture?.providerFixtureId, game.apiFootballFixtureId, `game ${game.gameNumber}`);
  }
});

test("name bootstrap from Hebrew + Sportmonks English names + provider aliases resolves the same fixtures", () => {
  for (const game of VERIFIED) {
    const selection = selectApiFootballFixture(inputFor(game, "names"), providerList());
    assert.equal(selection.resolution, "name_match", `game ${game.gameNumber}`);
    assert.equal(selection.fixture?.providerFixtureId, game.apiFootballFixtureId, `game ${game.gameNumber}`);
  }
});

test("Hebrew names alone never resolve to a wrong fixture", () => {
  for (const game of VERIFIED) {
    const selection = selectApiFootballFixture(inputFor(game, "hebrew-only"), providerList());
    if (selection.fixture) {
      assert.equal(selection.fixture.providerFixtureId, game.apiFootballFixtureId, `game ${game.gameNumber}`);
    }
  }
});

test("the seed migration contains exactly the verified mappings and nothing for unverified game 1", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "20261024130000_api_football_verified_mappings_round_264201_v1.sql"),
    "utf8",
  );
  const tuple = /\('([^']+)', '([0-9a-f-]{36})'::uuid, '((?:[^']|'')+)'\)/g;
  const rows = [...sql.matchAll(tuple)].map((match) => `${match[1]}|${match[2]}|${match[3].replace(/''/g, "'")}`);

  const expectedTeams = VERIFIED.flatMap((game) => [game.home, game.away]).map(
    (team) => `${team.apiFootball!.id}|${team.teamId}|${team.apiFootball!.name}`,
  );
  const expectedCompetitions = Object.entries(API_FOOTBALL_COMPETITIONS).map(
    ([competitionId, competition]) => `${competition.id}|${competitionId}|${competition.name}`,
  );
  assert.deepEqual([...rows].sort(), [...expectedTeams, ...expectedCompetitions].sort());

  const game1 = ROUND_264201[0];
  assert.ok(!sql.includes(game1.home.teamId) && !sql.includes(game1.away.teamId));
  assert.match(sql, /'449dd8ed-10e5-4e55-a095-bb2202c6c9ce'::uuid, 'Hapoel Katamon'\)\s*\) as v\(team_id, alias\)/);
  assert.doesNotMatch(sql, /\b(update|delete|drop|alter|truncate)\b/i);
});

// ---------------------------------------------------------------------------
// Kickoff windows that cross UTC midnight. Provider ids below are synthetic.
// ---------------------------------------------------------------------------

test("kickoff window dates include the adjacent UTC date only when the window crosses midnight", () => {
  assert.deepEqual(kickoffWindowDates("2026-10-25T14:00:00Z"), ["2026-10-25"]);
  assert.deepEqual(kickoffWindowDates("2026-10-25T23:30:00Z"), ["2026-10-25", "2026-10-26"]);
  assert.deepEqual(kickoffWindowDates("2026-10-26T01:00:00Z"), ["2026-10-26", "2026-10-25"]);
  // The tolerance is inclusive, so 21:00 reaches 00:00 of the next day.
  assert.deepEqual(kickoffWindowDates("2026-10-25T20:59:00Z"), ["2026-10-25"]);
  assert.deepEqual(kickoffWindowDates("2026-10-25T21:00:00Z"), ["2026-10-25", "2026-10-26"]);
  assert.deepEqual(kickoffWindowDates("2026-10-25T02:59:00Z"), ["2026-10-25", "2026-10-24"]);
  assert.deepEqual(kickoffWindowDates("2026-10-25T03:00:00Z"), ["2026-10-25"]);
  assert.deepEqual(kickoffWindowDates("not a date"), []);
});

type DayListing = ProviderFixture[] | "refused";

function rowFor(item: ProviderFixture) {
  return {
    fixture: { id: Number(item.providerFixtureId), date: item.kickoffAt, status: { short: "NS" } },
    league: { id: Number(item.competition.id), name: item.competition.name, country: item.competition.country, season: 2026 },
    teams: { home: { id: Number(item.home.id), name: item.home.name }, away: { id: Number(item.away.id), name: item.away.name } },
  };
}

async function withProvider<T>(days: Record<string, DayListing>, run: (client: ApiFootballClient, requested: string[]) => Promise<T>): Promise<T> {
  const requested: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const date = url.searchParams.get("date") ?? "";
    requested.push(date);
    const listing = days[date] ?? [];
    const body = listing === "refused"
      ? { errors: { plan: "Free plans do not have access to this date." }, response: [] }
      : { errors: [], response: listing.map(rowFor) };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await run(new ApiFootballClient("test-key", { minRequestIntervalMs: 0 }), requested);
  } finally {
    globalThis.fetch = original;
  }
}

const LATE = {
  gameNumber: 1, homeTeam: "מכבי חיפה", awayTeam: "הפועל באר שבע", kickoffAt: "2026-10-25T23:30:00Z",
  competition: "Ligat Ha'al", aliases: { home: ["Maccabi Haifa"], away: ["Hapoel Be'er Sheva"] },
} satisfies ProviderSpikeFixtureInput;
const AFTER_MIDNIGHT = fixture("2001", ["4195", "Maccabi Haifa"], ["563", "Hapoel Beer Sheva"], { kickoffAt: "2026-10-26T00:15:00+00:00" });

test("a fixture listed just after UTC midnight is found through the adjacent date", async () => {
  await withProvider({ "2026-10-25": [SHMONA], "2026-10-26": [AFTER_MIDNIGHT] }, async (client, requested) => {
    const byIds = await client.resolveFixture({ ...LATE, providerTeamIds: { home: "4195", away: "563" }, providerCompetitionId: "383" });
    assert.equal(byIds.resolution, "provider_team_ids");
    assert.equal(byIds.fixture?.providerFixtureId, "2001");
    const byNames = await client.resolveFixture(LATE);
    assert.equal(byNames.resolution, "name_match");
    assert.equal(byNames.fixture?.providerFixtureId, "2001");
    assert.deepEqual(requested, ["2026-10-25", "2026-10-26"], "each provider day is fetched once");
  });
});

test("a daytime kickoff still costs exactly one provider day", async () => {
  await withProvider({ "2026-10-24": [KATAMON] }, async (client, requested) => {
    const selection = await client.resolveFixture(hapoelJerusalemInput({ providerTeamIds: { home: "4486", away: "4501" } }));
    assert.equal(selection.resolution, "provider_team_ids");
    assert.deepEqual(requested, ["2026-10-24"]);
  });
});

test("across midnight, competition filtering, orientation and ambiguity rules still hold", async () => {
  const reversed = fixture("2002", ["563", "Hapoel Beer Sheva"], ["4195", "Maccabi Haifa"], { kickoffAt: "2026-10-26T00:15:00+00:00" });
  await withProvider({ "2026-10-25": [], "2026-10-26": [reversed] }, async (client) => {
    assert.equal((await client.resolveFixture({ ...LATE, providerTeamIds: { home: "4195", away: "563" } })).resolution, "orientation_mismatch");
    assert.equal((await client.resolveFixture(LATE)).resolution, "orientation_mismatch");
  });

  const twinBefore = fixture("2003", ["9001", "Maccabi Haifa"], ["9002", "Hapoel Beer Sheva"], { kickoffAt: "2026-10-25T23:30:00+00:00" });
  await withProvider({ "2026-10-25": [twinBefore], "2026-10-26": [AFTER_MIDNIGHT] }, async (client) => {
    assert.equal((await client.resolveFixture(LATE)).resolution, "ambiguous");
  });

  const otherLeague = fixture("2004", ["7001", "Maccabi Haifa"], ["7002", "Hapoel Beer Sheva"], {
    kickoffAt: "2026-10-25T23:00:00+00:00",
    competition: { id: "384", name: "Liga Leumit", country: "Israel", round: null },
  });
  await withProvider({ "2026-10-25": [otherLeague], "2026-10-26": [AFTER_MIDNIGHT] }, async (client) => {
    const selection = await client.resolveFixture({ ...LATE, providerCompetitionId: "383" });
    assert.equal(selection.resolution, "name_match");
    assert.equal(selection.fixture?.providerFixtureId, "2001");
  });
});

test("an unreadable adjacent date allows only provider-id matches, and the refusal is not re-requested", async () => {
  const sameDay = fixture("2005", ["4195", "Maccabi Haifa"], ["563", "Hapoel Beer Sheva"], { kickoffAt: "2026-10-25T23:30:00+00:00" });
  await withProvider({ "2026-10-25": [sameDay], "2026-10-26": "refused" }, async (client, requested) => {
    const byIds = await client.resolveFixture({ ...LATE, providerTeamIds: { home: "4195", away: "563" } });
    assert.equal(byIds.resolution, "provider_team_ids");
    assert.equal(byIds.fixture?.providerFixtureId, "2005");
    assert.deepEqual(await client.resolveFixture(LATE), { fixture: null, resolution: "ambiguous" });
    assert.deepEqual(requested, ["2026-10-25", "2026-10-26"]);
  });
});

test("a refused kickoff date is still an explicit error", async () => {
  await withProvider({ "2026-10-25": "refused" }, async (client) => {
    await assert.rejects(client.resolveFixture(LATE), /Free plans do not have access/);
  });
});
