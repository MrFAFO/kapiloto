import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  providerEntitlementSnapshotSha256,
  type ProviderEntitlementSnapshot,
} from "../lib/kapiloto-v4/provider-ingest";
import {
  auditSportmonksA2BCapture,
  auditSportmonksLeagueIdentity,
  buildSportmonksA2BCapture,
  buildSportmonksSeasonCoverageProfile,
  pilotAcceptanceFailures,
  SPORTMONKS_A2B_FIXTURE_INCLUDE,
  SPORTMONKS_A2B_TARGET_LEAGUES,
  type SportmonksA2BFixtureAudit,
  type SportmonksTargetLeague,
} from "../lib/kapiloto-v4/sportmonks-pilot";
import {
  parseSportmonksLedgerCapture,
  SportmonksLedgerParseError,
} from "../lib/kapiloto-v4/sportmonks-ledger";

const BASE = "https://api.sportmonks.com/v3/football";
const ENTITLEMENT_PAGE_CAP = 100;
const FIXTURE_PAGE_CAP = 100;
const PER_PAGE = 50;

type Envelope<T> = {
  data?: T;
  message?: string;
  pagination?: {
    has_more?: boolean;
    current_page?: number;
    next_page?: number | string | null;
  };
};

type Args = {
  out: string;
  seasonsPerLeague: number;
  fixturesPerSeason: number;
};

type RawResponse<T> = {
  body: Envelope<T>;
  hash: string;
  endpoint: string;
  status: number;
};

type SeasonRow = {
  id: string;
  name: string | null;
  leagueId: string;
  isCurrent: boolean;
  startingAt: string | null;
  endingAt: string | null;
};

type FixtureResult = {
  leagueId: string;
  seasonId: string;
  seasonName: string | null;
  fixtureId: string;
  parseStatus: "pass" | "fail";
  parseError: string | null;
  audit: SportmonksA2BFixtureAudit;
  flags: string[];
  rawSha256: string;
};

function parseArgs(argv: string[]): Args {
  const result: Args = {
    out: "artifacts/kapiloto-v4-a2b-readiness",
    seasonsPerLeague: 3,
    fixturesPerSeason: 2,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") result.out = argv[++i] ?? result.out;
    else if (arg === "--seasons-per-league") {
      result.seasonsPerLeague = Number(argv[++i] ?? result.seasonsPerLeague);
    } else if (arg === "--fixtures-per-season") {
      result.fixturesPerSeason = Number(argv[++i] ?? result.fixturesPerSeason);
    }
  }
  if (
    !Number.isInteger(result.seasonsPerLeague) ||
    result.seasonsPerLeague < 1 ||
    result.seasonsPerLeague > 6
  ) {
    throw new Error("--seasons-per-league must be an integer between 1 and 6.");
  }
  if (
    !Number.isInteger(result.fixturesPerSeason) ||
    result.fixturesPerSeason < 1 ||
    result.fixturesPerSeason > 5
  ) {
    throw new Error("--fixtures-per-season must be an integer between 1 and 5.");
  }
  return result;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cleanEndpoint(url: URL): string {
  const copy = new URL(url);
  copy.searchParams.delete("api_token");
  const query = copy.searchParams.toString();
  return `${copy.pathname}${query ? `?${query}` : ""}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asProviderId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  return null;
}

function dateValue(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value
    : null;
}

function finishedState(row: Record<string, unknown>): boolean {
  const state = asRecord(row.state);
  const value = state?.developer_name;
  return value === "FT" || value === "AET" || value === "FT_PEN";
}

function kickoffMs(row: Record<string, unknown>): number {
  if (typeof row.starting_at_timestamp === "number") {
    return row.starting_at_timestamp * 1000;
  }
  if (typeof row.starting_at === "string") {
    const normalized = row.starting_at.includes("T")
      ? row.starting_at
      : row.starting_at.replace(" ", "T");
    return Date.parse(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
  }
  return Number.NaN;
}

async function persistRaw(rawDir: string, bytes: Uint8Array, hash: string): Promise<void> {
  await writeFile(path.join(rawDir, `${hash}.raw`), bytes);
}

async function requestRaw<T>(
  token: string,
  rawDir: string,
  endpoint: string,
  params: Record<string, string | number | undefined> = {},
): Promise<RawResponse<T>> {
  const url = new URL(`${BASE}${endpoint}`);
  url.searchParams.set("api_token", token);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/json" },
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = sha256(bytes);
  await persistRaw(rawDir, bytes, hash);

  let body: Envelope<T>;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Envelope<T>;
  } catch {
    throw new Error(
      `Sportmonks returned non-JSON for ${url.pathname} (${response.status}); raw=${hash}.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Sportmonks HTTP ${response.status} for ${url.pathname}: ${String(body.message ?? "request failed").slice(0, 200)}; raw=${hash}.`,
    );
  }
  return {
    body,
    hash,
    endpoint: cleanEndpoint(url),
    status: response.status,
  };
}

async function loadEntitlement(
  token: string,
  rawDir: string,
): Promise<{
  competitions: Array<{ providerLeagueId: string; name: string | null }>;
  pageHashes: string[];
}> {
  const competitions: Array<{ providerLeagueId: string; name: string | null }> = [];
  const pageHashes: string[] = [];

  for (let page = 1; page <= ENTITLEMENT_PAGE_CAP; page += 1) {
    const response = await requestRaw<Array<Record<string, unknown>>>(
      token,
      rawDir,
      "/leagues",
      { page, per_page: PER_PAGE },
    );
    pageHashes.push(response.hash);
    for (const row of response.body.data ?? []) {
      const id = asProviderId(row.id);
      if (!id) continue;
      competitions.push({
        providerLeagueId: id,
        name: typeof row.name === "string" ? row.name : null,
      });
    }

    const hasMore = response.body.pagination?.has_more === true;
    if (!hasMore) {
      return {
        competitions: [
          ...new Map(
            competitions.map((row) => [row.providerLeagueId, row] as const),
          ).values(),
        ].sort((a, b) =>
          a.providerLeagueId.localeCompare(b.providerLeagueId, "en", {
            numeric: true,
          }),
        ),
        pageHashes,
      };
    }
    if (page === ENTITLEMENT_PAGE_CAP) {
      throw new Error(
        `Entitlement pagination exceeded hard cap ${ENTITLEMENT_PAGE_CAP}; refusing a partial subscription snapshot.`,
      );
    }
  }
  throw new Error("Entitlement pagination terminated unexpectedly.");
}

async function loadLeagueDetail(
  token: string,
  rawDir: string,
  target: SportmonksTargetLeague,
): Promise<{
  raw: Record<string, unknown>;
  rawSha256: string;
  seasons: SeasonRow[];
}> {
  const response = await requestRaw<Record<string, unknown>>(
    token,
    rawDir,
    `/leagues/${target.providerLeagueId}`,
    { include: "country;currentSeason;seasons" },
  );
  const raw = response.body.data;
  if (!raw) {
    throw new Error(`League ${target.providerLeagueId} returned no data.`);
  }

  const rows = Array.isArray(raw.seasons) ? raw.seasons : [];
  const current =
    asRecord(raw.currentseason) ?? asRecord(raw.currentSeason) ?? null;
  const byId = new Map<string, SeasonRow>();

  for (const value of rows) {
    const row = asRecord(value);
    if (!row) continue;
    const id = asProviderId(row.id);
    const leagueId = asProviderId(row.league_id);
    if (!id || !leagueId) continue;
    byId.set(id, {
      id,
      name: typeof row.name === "string" ? row.name : null,
      leagueId,
      isCurrent: row.is_current === true,
      startingAt: dateValue(row.starting_at),
      endingAt: dateValue(row.ending_at),
    });
  }
  if (current) {
    const id = asProviderId(current.id);
    const leagueId = asProviderId(current.league_id);
    if (id && leagueId) {
      byId.set(id, {
        id,
        name: typeof current.name === "string" ? current.name : null,
        leagueId,
        isCurrent: current.is_current === true,
        startingAt: dateValue(current.starting_at),
        endingAt: dateValue(current.ending_at),
      });
    }
  }

  const seasons = [...byId.values()].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const aDate = a.endingAt ?? a.startingAt ?? "";
    const bDate = b.endingAt ?? b.startingAt ?? "";
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    return b.id.localeCompare(a.id, "en", { numeric: true });
  });

  return { raw, rawSha256: response.hash, seasons };
}

async function loadFinishedFixturesForSeason(
  token: string,
  rawDir: string,
  target: SportmonksTargetLeague,
  season: SeasonRow,
  limit: number,
): Promise<{
  fixtures: Record<string, unknown>[];
  pageHashes: string[];
}> {
  const rows: Record<string, unknown>[] = [];
  const pageHashes: string[] = [];

  for (let page = 1; page <= FIXTURE_PAGE_CAP; page += 1) {
    const response = await requestRaw<Array<Record<string, unknown>>>(
      token,
      rawDir,
      `/fixtures/seasons/${season.id}`,
      {
        include: "state;participants;scores",
        page,
        per_page: PER_PAGE,
      },
    );
    pageHashes.push(response.hash);

    for (const row of response.body.data ?? []) {
      if (
        String(row.league_id) === target.providerLeagueId &&
        String(row.season_id) === season.id &&
        finishedState(row)
      ) {
        rows.push(row);
      }
    }

    const hasMore = response.body.pagination?.has_more === true;
    if (!hasMore) break;
    if (page === FIXTURE_PAGE_CAP) {
      throw new Error(
        `Fixture pagination exceeded hard cap ${FIXTURE_PAGE_CAP} for league ${target.providerLeagueId} season ${season.id}.`,
      );
    }
  }

  return {
    fixtures: rows
      .filter((row) => Number.isFinite(kickoffMs(row)))
      .sort((a, b) => kickoffMs(b) - kickoffMs(a))
      .slice(0, limit),
    pageHashes,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.SPORTMONKS_API_TOKEN?.trim();
  if (!token) throw new Error("SPORTMONKS_API_TOKEN is required.");

  const capturedAt = new Date().toISOString();
  const outDir = args.out;
  const rawDir = path.join(outDir, "raw");
  const captureDir = path.join(outDir, "captures");
  await mkdir(rawDir, { recursive: true });
  await mkdir(captureDir, { recursive: true });

  const entitlement = await loadEntitlement(token, rawDir);
  const entitlementSnapshot: ProviderEntitlementSnapshot = {
    provider: "sportmonks",
    capturedAt,
    source: "sportmonks_all_leagues_subscription",
    competitions: entitlement.competitions,
  };
  const entitlementSha256 =
    providerEntitlementSnapshotSha256(entitlementSnapshot);
  await writeFile(
    path.join(outDir, "entitlement.json"),
    JSON.stringify(
      {
        ...entitlementSnapshot,
        sha256: entitlementSha256,
        rawPageSha256: entitlement.pageHashes,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const entitlementById = new Map(
    entitlement.competitions.map((row) => [row.providerLeagueId, row] as const),
  );
  const fixtureResults: FixtureResult[] = [];
  const leagueReports: Array<Record<string, unknown>> = [];
  const blockingErrors: Array<Record<string, unknown>> = [];

  for (const target of SPORTMONKS_A2B_TARGET_LEAGUES) {
    const entitled = entitlementById.get(target.providerLeagueId) ?? null;
    if (!entitled) {
      blockingErrors.push({
        code: "target_not_entitled",
        leagueId: target.providerLeagueId,
        expectedName: target.expectedName,
      });
      leagueReports.push({
        target,
        entitled: false,
        identityAudit: null,
        seasons: [],
      });
      continue;
    }

    const detail = await loadLeagueDetail(token, rawDir, target);
    const identityAudit = auditSportmonksLeagueIdentity(detail.raw, target);
    const identityFailures = Object.entries(identityAudit.gates)
      .filter(([, gate]) => gate.status === "fail")
      .map(([gate]) => gate);

    const foreignSeasons = detail.seasons.filter(
      (season) => season.leagueId !== target.providerLeagueId,
    );
    if (foreignSeasons.length > 0) {
      identityFailures.push("seasonLeagueId");
    }

    if (identityFailures.length > 0) {
      blockingErrors.push({
        code: "competition_identity_failed",
        leagueId: target.providerLeagueId,
        failures: identityFailures,
      });
      leagueReports.push({
        target,
        entitled: true,
        entitlementName: entitled.name,
        leagueRawSha256: detail.rawSha256,
        identityAudit,
        accessibleSeasonCount: detail.seasons.length,
        seasons: [],
      });
      continue;
    }

    const selectedSeasons = detail.seasons.slice(0, args.seasonsPerLeague);
    if (selectedSeasons.length < args.seasonsPerLeague) {
      blockingErrors.push({
        code: "history_depth_insufficient",
        leagueId: target.providerLeagueId,
        requestedSeasons: args.seasonsPerLeague,
        accessibleSeasons: selectedSeasons.length,
      });
    }

    const seasonReports: Array<Record<string, unknown>> = [];

    for (const season of selectedSeasons) {
      const fixtureList = await loadFinishedFixturesForSeason(
        token,
        rawDir,
        target,
        season,
        args.fixturesPerSeason,
      );

      if (fixtureList.fixtures.length < args.fixturesPerSeason) {
        blockingErrors.push({
          code: "season_fixture_sample_insufficient",
          leagueId: target.providerLeagueId,
          seasonId: season.id,
          requestedFixtures: args.fixturesPerSeason,
          sampledFixtures: fixtureList.fixtures.length,
        });
      }

      const seasonResults: FixtureResult[] = [];
      for (const candidate of fixtureList.fixtures) {
        const fixtureId = asProviderId(candidate.id);
        if (!fixtureId) {
          throw new Error(
            `Fixture list for league ${target.providerLeagueId} season ${season.id} contained an invalid id.`,
          );
        }

        process.stderr.write(
          `A2-B readiness: league ${target.providerLeagueId}, season ${season.id}, fixture ${fixtureId}\n`,
        );
        const response = await requestRaw<Record<string, unknown>>(
          token,
          rawDir,
          `/fixtures/${fixtureId}`,
          { include: SPORTMONKS_A2B_FIXTURE_INCLUDE },
        );
        const fixture = response.body.data;
        if (!fixture) {
          throw new Error(
            `Fixture detail ${fixtureId} returned no data; raw=${response.hash}.`,
          );
        }
        if (
          String(fixture.league_id) !== target.providerLeagueId ||
          String(fixture.season_id) !== season.id
        ) {
          throw new Error(
            `Fixture ${fixtureId} identity mismatch: expected league/season ${target.providerLeagueId}/${season.id}, observed ${String(fixture.league_id)}/${String(fixture.season_id)}.`,
          );
        }

        const capture = buildSportmonksA2BCapture({
          fixture,
          capturedAt: new Date().toISOString(),
          rawPayloadSha256: response.hash,
          providerEndpoint: response.endpoint,
        });
        const audit = auditSportmonksA2BCapture(capture);

        let parseStatus: "pass" | "fail" = "pass";
        let parseError: string | null = null;
        let flags: string[] = [];
        try {
          const parsed = parseSportmonksLedgerCapture(capture, {
            fixtureMint: { allowed: false, kickoffBefore: null },
            runId: null,
          });
          flags = [...parsed.flags];
        } catch (error) {
          parseStatus = "fail";
          parseError =
            error instanceof SportmonksLedgerParseError
              ? `${error.code}: ${error.message}`
              : error instanceof Error
                ? error.message
                : String(error);
        }

        const result: FixtureResult = {
          leagueId: target.providerLeagueId,
          seasonId: season.id,
          seasonName: season.name,
          fixtureId,
          parseStatus,
          parseError,
          audit,
          flags,
          rawSha256: response.hash,
        };
        seasonResults.push(result);
        fixtureResults.push(result);

        await writeFile(
          path.join(
            captureDir,
            `${target.providerLeagueId}-${season.id}-${fixtureId}.json`,
          ),
          JSON.stringify(
            {
              capture,
              audit,
              parseStatus,
              parseError,
              flags,
              acceptanceFailures: pilotAcceptanceFailures(audit),
              rawSha256: response.hash,
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );
      }

      const profile = buildSportmonksSeasonCoverageProfile({
        providerLeagueId: target.providerLeagueId,
        providerSeasonId: season.id,
        seasonName: season.name,
        audits: seasonResults.map((result) => result.audit),
        parseStatuses: seasonResults.map((result) => result.parseStatus),
      });

      const semanticFailures = seasonResults.flatMap((result) =>
        pilotAcceptanceFailures(result.audit).map((gate) => ({
          fixtureId: result.fixtureId,
          gate,
        })),
      );
      if (profile.parseFailures > 0) {
        blockingErrors.push({
          code: "season_parse_failure",
          leagueId: target.providerLeagueId,
          seasonId: season.id,
          failures: seasonResults
            .filter((result) => result.parseStatus === "fail")
            .map((result) => ({
              fixtureId: result.fixtureId,
              error: result.parseError,
            })),
        });
      }
      if (semanticFailures.length > 0) {
        blockingErrors.push({
          code: "season_semantic_failure",
          leagueId: target.providerLeagueId,
          seasonId: season.id,
          failures: semanticFailures,
        });
      }

      seasonReports.push({
        season,
        fixtureListRawSha256: fixtureList.pageHashes,
        profile,
        backfillSampleStatus:
          profile.parseFailures === 0 &&
          profile.semanticFailures === 0 &&
          profile.sampledFixtures === args.fixturesPerSeason
            ? "sample_clean"
            : "blocked",
        fixtures: seasonResults.map((result) => ({
          fixtureId: result.fixtureId,
          rawSha256: result.rawSha256,
          parseStatus: result.parseStatus,
          parseError: result.parseError,
          flags: result.flags,
          acceptanceFailures: pilotAcceptanceFailures(result.audit),
          observed: result.audit.observed,
          gates: result.audit.gates,
        })),
      });
    }

    leagueReports.push({
      target,
      entitled: true,
      entitlementName: entitled.name,
      leagueRawSha256: detail.rawSha256,
      identityAudit,
      accessibleSeasonCount: detail.seasons.length,
      sampledSeasonIds: selectedSeasons.map((season) => season.id),
      seasons: seasonReports,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    provider: "sportmonks",
    purpose: "v4_provider_family_history_readiness",
    config: {
      seasonsPerLeague: args.seasonsPerLeague,
      fixturesPerSeason: args.fixturesPerSeason,
      entitlementPageCap: ENTITLEMENT_PAGE_CAP,
      fixturePageCap: FIXTURE_PAGE_CAP,
      perPage: PER_PAGE,
    },
    entitlementSnapshotSha256: entitlementSha256,
    entitlementRawPageSha256: entitlement.pageHashes,
    note:
      "No pooled global semantic PASS is emitted. Coverage and semantics are reported per competition and per sampled season. explicitZero is diagnostic and is not an acceptance gate.",
    leagues: leagueReports,
    blockingErrors,
    fixtureCount: fixtureResults.length,
  };

  await writeFile(
    path.join(outDir, "pilot-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );

  process.stdout.write(
    JSON.stringify(
      {
        entitlementSnapshotSha256: entitlementSha256,
        fixtureCount: fixtureResults.length,
        blockingErrors,
        leagues: leagueReports.map((league) => {
          const seasons = Array.isArray(league.seasons)
            ? (league.seasons as Array<Record<string, unknown>>)
            : [];
          return {
            target: league.target,
            entitled: league.entitled,
            accessibleSeasonCount: league.accessibleSeasonCount ?? null,
            sampledSeasonIds: league.sampledSeasonIds ?? [],
            seasonProfiles: seasons.map((season) => {
              const row = season.profile as Record<string, unknown> | undefined;
              return {
                season: season.season,
                backfillSampleStatus: season.backfillSampleStatus,
                profile: row ?? null,
              };
            }),
          };
        }),
      },
      null,
      2,
    ) + "\n",
  );

  if (blockingErrors.length > 0) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
