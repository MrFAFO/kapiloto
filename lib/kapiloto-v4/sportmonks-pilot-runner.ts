/**
 * Orchestration of the operator-run, read-only Sportmonks A2-B pilot
 * (provider semantics plus per-league family/history readiness).
 *
 * Entry point: tools/kapiloto-v4-sportmonks-pilot.ts, run only from the
 * workflow_dispatch workflow
 * .github/workflows/kapiloto-v4-sportmonks-a2b-readiness.yml or by hand. It
 * reads the Sportmonks API and writes files under --out. It has no Supabase
 * client, calls no ingest / attestation RPC, creates no provider_ingest_run,
 * mints no fixture, writes no Match Ledger observation and changes no
 * identity mapping. Its report always says backfillApproval.approved = false.
 *
 * The HTTP transport is injected only so the offline rehearsal test can
 * replay recorded-shape Sportmonks responses; the tool passes the global
 * fetch. Every URL is built from SPORTMONKS_FOOTBALL_BASE.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  providerEntitlementSnapshotSha256,
  type ProviderEntitlementSnapshot,
} from "./provider-ingest";
import {
  parseSportmonksLedgerCapture,
  SportmonksLedgerParseError,
} from "./sportmonks-ledger";
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
  mergeSportmonksA2BEntitlementRows,
  parseSportmonksA2BEntitlementRow,
  parseSportmonksA2BLeagueSeasons,
  parseSportmonksA2BPilotArgs,
  sanitizeSportmonksEndpoint,
  selectSportmonksA2BSeasons,
  selectSportmonksFinishedSeasonFixtures,
  SPORTMONKS_A2B_ENTITLEMENT_INCLUDE,
  SPORTMONKS_A2B_FIXTURE_INCLUDE,
  SPORTMONKS_A2B_LEAGUE_DETAIL_INCLUDE,
  SPORTMONKS_A2B_PARSER_FIXTURE_MINT,
  SPORTMONKS_A2B_TARGET_LEAGUES,
  sportmonksA2BEntitlementDetailsSha256,
  summarizeSportmonksA2BProviderSemantics,
  type SportmonksA2BBlockingError,
  type SportmonksA2BCredentialGuard,
  type SportmonksA2BEntitlementRow,
  type SportmonksA2BPilotArgs,
  type SportmonksA2BFixtureAudit,
  type SportmonksA2BLeagueReport,
  type SportmonksA2BSampleResult,
  type SportmonksA2BSeasonProfile,
} from "./sportmonks-pilot";
import {
  ensureEmptySportmonksA2BOutputDirectory,
  scrubSportmonksA2BOutputIfCredentialPresent,
  SportmonksA2BRawArchive,
} from "./sportmonks-pilot-io";

export const SPORTMONKS_FOOTBALL_BASE = "https://api.sportmonks.com/v3/football";
export const SPORTMONKS_A2B_ENTITLEMENT_PAGE_CAP = 100;
const ENTITLEMENT_PAGE_CAP = SPORTMONKS_A2B_ENTITLEMENT_PAGE_CAP;
const PER_PAGE = 50;
const ENTITLEMENT_SOURCE = "sportmonks_all_leagues_subscription";

export type SportmonksA2BFetch = (url: URL, init: RequestInit) => Promise<Response>;

export type SportmonksA2BPilotIo = {
  fetch: SportmonksA2BFetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

type Envelope<T> = {
  data?: T;
  message?: string;
  pagination?: { has_more?: boolean; current_page?: number; next_page?: number | string | null };
};

type RawResponse<T> = { body: Envelope<T>; hash: string; endpoint: string; status: number };

function asProviderId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  return null;
}

class SportmonksReader {
  constructor(
    private readonly token: string,
    private readonly archive: SportmonksA2BRawArchive,
    private readonly fetchImpl: SportmonksA2BFetch,
  ) {}

  /**
   * GET one Sportmonks resource. The exact body bytes are archived (and
   * checked for the credential) before JSON parsing; errors name only the
   * path and the raw hash, never the query.
   */
  async get<T>(endpoint: string, params: Record<string, string | number | undefined> = {}): Promise<RawResponse<T>> {
    const url = new URL(`${SPORTMONKS_FOOTBALL_BASE}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const sanitized = sanitizeSportmonksEndpoint(url);
    url.searchParams.set("api_token", this.token);

    const response = await this.fetchImpl(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: "application/json" },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = await this.archive.record({
      bytes,
      endpoint: sanitized,
      status: response.status,
      contentType: response.headers.get("content-type"),
    });

    let body: Envelope<T>;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as Envelope<T>;
    } catch {
      throw new Error(`Sportmonks returned non-JSON for ${url.pathname} (${response.status}); raw=${hash}.`);
    }
    if (!response.ok) {
      throw new Error(
        `Sportmonks HTTP ${response.status} for ${url.pathname}: ${String(body.message ?? "request failed").slice(0, 200)}; raw=${hash}.`,
      );
    }
    return { body, hash, endpoint: sanitized, status: response.status };
  }
}

async function loadEntitlement(reader: SportmonksReader): Promise<{ rows: SportmonksA2BEntitlementRow[]; pageHashes: string[] }> {
  const rows: SportmonksA2BEntitlementRow[] = [];
  const pageHashes: string[] = [];
  for (let page = 1; page <= ENTITLEMENT_PAGE_CAP; page += 1) {
    const response = await reader.get<unknown[]>("/leagues", {
      include: SPORTMONKS_A2B_ENTITLEMENT_INCLUDE,
      page,
      per_page: PER_PAGE,
    });
    pageHashes.push(response.hash);
    for (const raw of Array.isArray(response.body.data) ? response.body.data : []) {
      const row = parseSportmonksA2BEntitlementRow(raw);
      if (row) rows.push(row);
    }
    const hasMore = response.body.pagination?.has_more === true;
    assertSportmonksA2BPaginationComplete({ label: "league entitlement", page, cap: ENTITLEMENT_PAGE_CAP, hasMore });
    if (!hasMore) return { rows: mergeSportmonksA2BEntitlementRows(rows), pageHashes };
  }
  throw new Error("Entitlement pagination terminated unexpectedly.");
}

function errorText(error: unknown): string {
  return error instanceof SportmonksLedgerParseError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}

async function run(
  args: SportmonksA2BPilotArgs,
  token: string,
  guard: SportmonksA2BCredentialGuard,
  io: SportmonksA2BPilotIo,
): Promise<number> {
  const capturedAt = new Date().toISOString();
  const outDir = args.out;
  const captureDir = path.join(outDir, "captures");

  await mkdir(captureDir, { recursive: true });
  const archive = new SportmonksA2BRawArchive(outDir, guard);
  await archive.init();
  const reader = new SportmonksReader(token, archive, io.fetch);

  const entitlement = await loadEntitlement(reader);
  const entitlementSnapshot: ProviderEntitlementSnapshot = {
    provider: "sportmonks",
    capturedAt,
    source: ENTITLEMENT_SOURCE,
    competitions: entitlement.rows.map((row) => ({ providerLeagueId: row.providerLeagueId, name: row.name })),
  };
  const entitlementSnapshotSha256 = providerEntitlementSnapshotSha256(entitlementSnapshot);
  const entitlementDetailsSha256 = sportmonksA2BEntitlementDetailsSha256({
    capturedAt,
    source: ENTITLEMENT_SOURCE,
    rows: entitlement.rows,
  });
  await writeFile(
    path.join(outDir, "entitlement.json"),
    JSON.stringify(
      {
        ...entitlementSnapshot,
        details: entitlement.rows,
        sha256: entitlementSnapshotSha256,
        details_sha256: entitlementDetailsSha256,
        rawPageSha256: entitlement.pageHashes,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const entitlementById = new Map(entitlement.rows.map((row) => [row.providerLeagueId, row] as const));
  const blockingErrors: SportmonksA2BBlockingError[] = [];
  const allAudits: SportmonksA2BFixtureAudit[] = [];
  const leagueReports: SportmonksA2BLeagueReport[] = [];
  let captureCount = 0;

  for (const target of SPORTMONKS_A2B_TARGET_LEAGUES) {
    const entitled = entitlementById.get(target.providerLeagueId) ?? null;
    let detail: unknown = null;
    let leagueDetailRawSha256: string | null = null;
    if (entitled) {
      const response = await reader.get<Record<string, unknown>>(`/leagues/${target.providerLeagueId}`, {
        include: SPORTMONKS_A2B_LEAGUE_DETAIL_INCLUDE,
      });
      assertSportmonksA2BSinglePage(`league detail ${target.providerLeagueId}`, response.body.pagination);
      detail = response.body.data ?? null;
      leagueDetailRawSha256 = response.hash;
    } else {
      blockingErrors.push({ code: "target_not_entitled", leagueId: target.providerLeagueId, expectedName: target.expectedName });
    }

    const identity = auditSportmonksA2BLeagueIdentity({ target, entitlement: entitled, detail });
    const sampledSeasons: SportmonksA2BSeasonProfile[] = [];
    const leagueAudits: SportmonksA2BFixtureAudit[] = [];

    if (identity.identityStatus !== "pass") {
      if (entitled) {
        blockingErrors.push({
          code: "competition_identity_failed",
          leagueId: target.providerLeagueId,
          failures: Object.entries(identity.gates).filter(([, gate]) => gate.status !== "pass").map(([gate]) => gate),
        });
      }
      for (const required of args.requiredSeasons.filter((season) => season.providerLeagueId === target.providerLeagueId)) {
        blockingErrors.push({ code: "required_season_not_sampled", leagueId: target.providerLeagueId, seasonId: required.providerSeasonId, reason: "competition identity failed" });
      }
    } else {
      const { seasons } = parseSportmonksA2BLeagueSeasons(detail);
      const selection = selectSportmonksA2BSeasons({
        providerLeagueId: target.providerLeagueId,
        seasons,
        seasonsPerLeague: args.seasonsPerLeague,
        requiredSeasons: args.requiredSeasons,
      });
      if (selection.historyDepthInsufficient) {
        blockingErrors.push({
          code: "history_depth_insufficient",
          leagueId: target.providerLeagueId,
          requestedSeasons: args.seasonsPerLeague,
          accessibleSeasons: seasons.length,
        });
      }
      for (const seasonId of selection.missingRequiredSeasonIds) {
        blockingErrors.push({ code: "required_season_not_in_league", leagueId: target.providerLeagueId, seasonId });
      }

      for (const { season, reasons } of selection.selected) {
        const schedule = await reader.get<unknown[]>(`/schedules/seasons/${season.id}`);
        assertSportmonksA2BSinglePage(`season schedule ${target.providerLeagueId}:${season.id}`, schedule.body.pagination);
        const candidates = selectSportmonksFinishedSeasonFixtures({
          stages: schedule.body.data ?? [],
          providerLeagueId: target.providerLeagueId,
          providerSeasonId: season.id,
          limit: args.fixturesPerSeason,
        });

        const results: SportmonksA2BSampleResult[] = [];
        for (const candidate of candidates) {
          const fixtureId = asProviderId(candidate.id);
          if (!fixtureId) {
            throw new Error(`Season schedule ${target.providerLeagueId}:${season.id} contained a finished fixture without a valid id.`);
          }
          io.stderr(`A2-B pilot: league ${target.providerLeagueId}, season ${season.id}, fixture ${fixtureId}\n`);
          const response = await reader.get<Record<string, unknown>>(`/fixtures/${fixtureId}`, {
            include: SPORTMONKS_A2B_FIXTURE_INCLUDE,
          });
          assertSportmonksA2BSinglePage(`fixture detail ${fixtureId}`, response.body.pagination);
          const fixture = response.body.data;
          if (!fixture || String(fixture.league_id) !== target.providerLeagueId || String(fixture.season_id) !== season.id) {
            blockingErrors.push({
              code: fixture ? "fixture_identity_mismatch" : "fixture_detail_missing",
              leagueId: target.providerLeagueId,
              seasonId: season.id,
              fixtureId,
              observed: fixture ? { leagueId: String(fixture.league_id), seasonId: String(fixture.season_id) } : null,
              rawSha256: response.hash,
            });
            results.push({ providerFixtureId: fixtureId, parseStatus: "fail", audit: null });
            continue;
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
            // Offline parse only, to prove the A2-A contract accepts the real
            // payload. The result is discarded: nothing is ingested.
            const parsed = parseSportmonksLedgerCapture(capture, {
              fixtureMint: SPORTMONKS_A2B_PARSER_FIXTURE_MINT,
              runId: null,
            });
            flags = [...parsed.flags];
          } catch (error) {
            parseStatus = "fail";
            parseError = errorText(error);
          }
          results.push({ providerFixtureId: fixtureId, parseStatus, audit });
          leagueAudits.push(audit);
          allAudits.push(audit);
          captureCount += 1;
          await writeFile(
            path.join(captureDir, `${target.providerLeagueId}-${season.id}-${fixtureId}.json`),
            JSON.stringify({ capture, audit, parseStatus, parseError, flags, rawSha256: response.hash }, null, 2) + "\n",
            "utf8",
          );
          if (parseStatus === "fail") {
            blockingErrors.push({ code: "fixture_parse_failure", leagueId: target.providerLeagueId, seasonId: season.id, fixtureId, error: parseError });
          }
        }

        const profile = buildSportmonksA2BSeasonProfile({
          providerLeagueId: target.providerLeagueId,
          providerSeasonId: season.id,
          seasonName: season.name,
          sampleReasons: reasons,
          requestedFixtures: args.fixturesPerSeason,
          results,
        });
        if (profile.seasonSampleStatus !== "sample_clean") {
          blockingErrors.push({
            code: "season_sample_blocked",
            leagueId: target.providerLeagueId,
            seasonId: season.id,
            required: reasons.includes("required"),
            blockers: profile.blockers,
            scheduleRawSha256: schedule.hash,
          });
        }
        sampledSeasons.push(profile);
      }
    }

    leagueReports.push({
      target,
      identity,
      leagueDetailRawSha256,
      sampledSeasons,
      competitionProfile: buildSportmonksA2BCompetitionProfile(target.providerLeagueId, leagueAudits),
    });
  }

  const report = buildSportmonksA2BPilotReport({
    generatedAt: new Date().toISOString(),
    capturedAt,
    config: {
      seasonsPerLeague: args.seasonsPerLeague,
      fixturesPerSeason: args.fixturesPerSeason,
      requiredSeasons: args.requiredSeasons,
      entitlementPageCap: ENTITLEMENT_PAGE_CAP,
      perPage: PER_PAGE,
    },
    entitlement: {
      source: ENTITLEMENT_SOURCE,
      competitionCount: entitlement.rows.length,
      snapshotSha256: entitlementSnapshotSha256,
      detailsSha256: entitlementDetailsSha256,
      rawPageSha256: entitlement.pageHashes,
    },
    leagues: leagueReports,
    providerSemantics: summarizeSportmonksA2BProviderSemantics(allAudits),
    blockingErrors,
    rawResponseIndex: archive.snapshot(),
    captureCount,
  });
  await writeFile(path.join(outDir, "pilot-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  io.stdout(
    JSON.stringify(
      {
        evidenceStatus: report.evidenceStatus,
        backfillApproved: report.backfillApproval.approved,
        teamIdentityAssessed: report.teamIdentityReadiness.assessed,
        entitlementSnapshotSha256,
        entitlementDetailsSha256,
        captureCount,
        rawResponses: report.rawResponseIndex.length,
        providerSemantics: { status: report.providerSemantics.status, blockers: report.providerSemantics.blockers },
        leagues: report.leagues.map((league) => ({
          leagueId: league.target.providerLeagueId,
          identityStatus: league.identity.identityStatus,
          seasons: league.sampledSeasons.map((season) => ({
            seasonId: season.providerSeasonId,
            reasons: season.sampleReasons,
            seasonSampleStatus: season.seasonSampleStatus,
            familyCoverage: season.familyCoverage,
          })),
        })),
        blockingErrors: report.blockingErrors,
      },
      null,
      2,
    ) + "\n",
  );
  return report.evidenceStatus === "clean" ? 0 : 2;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

/**
 * The whole CLI: 0 = evidence clean, 2 = evidence blocked (report written),
 * 1 = aborted (bad arguments, token, non-empty --out, HTTP/pagination failure
 * or a credential echo). Error output never contains the token.
 */
export async function runSportmonksA2BPilotCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: SportmonksA2BPilotIo,
): Promise<number> {
  const token = env.SPORTMONKS_API_TOKEN?.trim() ?? "";
  const redactRaw = (text: string) => (token ? text.split(token).join("[REDACTED]").split(encodeURIComponent(token)).join("[REDACTED]") : text);

  let args: SportmonksA2BPilotArgs;
  let guard: SportmonksA2BCredentialGuard;
  try {
    args = parseSportmonksA2BPilotArgs(argv);
    if (!token) throw new Error("SPORTMONKS_API_TOKEN is required.");
    guard = createSportmonksA2BCredentialGuard(token);
    // Refuses a non-empty --out before any request. Only a directory verified
    // empty here is ever scrubbed below.
    await ensureEmptySportmonksA2BOutputDirectory(args.out);
  } catch (error) {
    io.stderr(`${redactRaw(messageOf(error))}\n`);
    return 1;
  }

  let exitCode = 1;
  try {
    exitCode = await run(args, token, guard, io);
  } catch (error) {
    io.stderr(`${guard.redact(messageOf(error))}\n`);
    exitCode = 1;
  } finally {
    const offenders = await scrubSportmonksA2BOutputIfCredentialPresent(args.out, guard);
    if (offenders.length > 0) {
      io.stderr(`A2-B output contained the API credential in ${offenders.length} file(s); the output directory was emptied.\n`);
      exitCode = 1;
    }
  }
  return exitCode;
}
