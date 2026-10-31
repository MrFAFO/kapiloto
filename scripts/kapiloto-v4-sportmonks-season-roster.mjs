#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const API_BASE = "https://api.sportmonks.com/v3/football";

function parseArgs(argv) {
  const out = {
    leagueId: null,
    expectedTeamCount: null,
    outDir: "artifacts/kapiloto-v4-season-roster",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--league-id") {
      out.leagueId = Number(argv[++i]);
    } else if (arg === "--expected-team-count") {
      out.expectedTeamCount = Number(argv[++i]);
    } else if (arg === "--out") {
      out.outDir = argv[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(out.leagueId) || out.leagueId <= 0) {
    throw new Error("--league-id must be a positive integer");
  }
  if (
    out.expectedTeamCount !== null &&
    (!Number.isInteger(out.expectedTeamCount) || out.expectedTeamCount <= 0)
  ) {
    throw new Error("--expected-team-count must be a positive integer");
  }
  if (!out.outDir) {
    throw new Error("--out must not be empty");
  }

  return out;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

async function fetchRaw(endpoint, token, params = {}) {
  const url = new URL(`${API_BASE}${endpoint}`);
  url.searchParams.set("api_token", token);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  const bytes = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    throw new Error(
      `Sportmonks ${endpoint} returned HTTP ${response.status}: ${bytes
        .toString("utf8")
        .slice(0, 500)}`,
    );
  }

  return {
    bytes,
    json: JSON.parse(bytes.toString("utf8")),
    endpoint,
    status: response.status,
  };
}

function getCurrentSeason(league) {
  const candidates = [
    league?.currentseason,
    league?.current_season,
    league?.currentSeason,
  ].filter(Boolean);

  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one current-season include, found ${candidates.length}`,
    );
  }

  const season = candidates[0];
  if (!Number.isInteger(season.id) || season.id <= 0) {
    throw new Error("current season is missing a valid id");
  }
  if (season.is_current !== true) {
    throw new Error(`season ${season.id} is not marked current`);
  }

  return season;
}

async function main() {
  const { leagueId, expectedTeamCount, outDir } = parseArgs(
    process.argv.slice(2),
  );
  const token = process.env.SPORTMONKS_API_TOKEN?.trim();
  if (!token) {
    throw new Error("SPORTMONKS_API_TOKEN is required");
  }

  const rawDir = path.join(outDir, "raw");
  await mkdir(rawDir, { recursive: true });

  const capturedAt = new Date().toISOString();
  const leagueResponse = await fetchRaw(
    `/leagues/${leagueId}`,
    token,
    { include: "currentSeason" },
  );
  const leagueRawSha256 = sha256(leagueResponse.bytes);
  await writeFile(
    path.join(rawDir, `league-${leagueId}-${leagueRawSha256}.json`),
    leagueResponse.bytes,
  );

  const league = leagueResponse.json?.data;
  if (!league || Number(league.id) !== leagueId) {
    throw new Error(
      `league response did not resolve requested league ${leagueId}`,
    );
  }

  const season = getCurrentSeason(league);
  if (Number(season.league_id) !== leagueId) {
    throw new Error(
      `current season ${season.id} belongs to league ${season.league_id}, not ${leagueId}`,
    );
  }

  const pageRecords = [];
  const teams = [];
  const seenIds = new Set();
  const maxPages = 5;

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchRaw(
      `/teams/seasons/${season.id}`,
      token,
      { per_page: 50, page },
    );
    const rawSha256 = sha256(response.bytes);
    await writeFile(
      path.join(
        rawDir,
        `teams-season-${season.id}-page-${page}-${rawSha256}.json`,
      ),
      response.bytes,
    );

    const pageTeams = response.json?.data;
    if (!Array.isArray(pageTeams)) {
      throw new Error(`season-team page ${page} did not return a data array`);
    }

    for (const team of pageTeams) {
      if (!Number.isInteger(team?.id) || team.id <= 0) {
        throw new Error(`season-team page ${page} contains an invalid team id`);
      }
      if (typeof team.name !== "string" || !team.name.trim()) {
        throw new Error(`team ${team.id} is missing a non-empty name`);
      }
      if (seenIds.has(team.id)) {
        throw new Error(`duplicate Sportmonks team id ${team.id} across pages`);
      }
      seenIds.add(team.id);
      teams.push({
        id: team.id,
        name: team.name,
        short_code: team.short_code ?? null,
        country_id: team.country_id ?? null,
        venue_id: team.venue_id ?? null,
        gender: team.gender ?? null,
        type: team.type ?? null,
        placeholder: team.placeholder ?? null,
      });
    }

    const pagination = response.json?.pagination ?? null;
    pageRecords.push({
      page,
      raw_sha256: rawSha256,
      count: pageTeams.length,
      pagination,
    });

    if (pagination?.has_more === true) {
      continue;
    }

    if (pagination?.has_more !== false && pageTeams.length === 50) {
      throw new Error(
        `page ${page} returned 50 teams without explicit pagination.has_more=false`,
      );
    }
    break;
  }

  if (pageRecords.at(-1)?.pagination?.has_more === true) {
    throw new Error(`season roster exceeded fail-closed page cap of ${maxPages}`);
  }

  teams.sort((a, b) => a.id - b.id);

  if (expectedTeamCount !== null && teams.length !== expectedTeamCount) {
    throw new Error(
      `expected ${expectedTeamCount} teams for league ${leagueId}, received ${teams.length}`,
    );
  }

  const duplicateNames = [];
  const nameToIds = new Map();
  for (const team of teams) {
    const key = team.name.trim().toLocaleLowerCase("en-US");
    const ids = nameToIds.get(key) ?? [];
    ids.push(team.id);
    nameToIds.set(key, ids);
  }
  for (const [name, ids] of nameToIds) {
    if (ids.length > 1) {
      duplicateNames.push({ name, ids });
    }
  }

  const teamSetSha256 = sha256(
    Buffer.from(JSON.stringify(teams), "utf8"),
  );

  const report = {
    contract_version: "kapiloto-v4-sportmonks-season-roster-capture-v1",
    captured_at: capturedAt,
    provider: "sportmonks",
    league: {
      id: leagueId,
      name: league.name ?? null,
      raw_sha256: leagueRawSha256,
    },
    season: {
      id: season.id,
      name: season.name ?? null,
      league_id: season.league_id,
      is_current: season.is_current,
      starting_at: season.starting_at ?? null,
      ending_at: season.ending_at ?? null,
    },
    pages: pageRecords,
    expected_team_count: expectedTeamCount,
    team_count: teams.length,
    team_set_sha256: teamSetSha256,
    duplicate_names: duplicateNames,
    teams,
  };

  await writeFile(
    path.join(outDir, "roster-report.json"),
    stableJson(report),
    "utf8",
  );

  process.stdout.write(stableJson(report));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
