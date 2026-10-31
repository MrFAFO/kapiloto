import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_SHADOW_CYCLE_CONFIG } from "../lib/evaluation/shadow-cycle";
import {
  fixtureMintKickoffBefore,
  providerEntitlementSnapshotSha256,
  type ProviderEntitlementSnapshot,
} from "../lib/kapiloto-v4/provider-ingest";
import {
  assertSportmonksA2BPaginationComplete,
  auditSportmonksA2BCapture,
  auditSportmonksA2BLeagueIdentity,
  buildSportmonksA2BCapture,
  buildSportmonksA2BCompetitionProfile,
  SPORTMONKS_A2B_FIXTURE_INCLUDE,
  SPORTMONKS_A2B_TARGET_LEAGUES,
  summarizeSportmonksA2BProviderSemantics,
} from "../lib/kapiloto-v4/sportmonks-pilot";
import {
  parseSportmonksLedgerCapture,
  SportmonksLedgerParseError,
} from "../lib/kapiloto-v4/sportmonks-ledger";

const FOOTBALL_BASE = "https://api.sportmonks.com/v3/football";
const ENTITLEMENT_PAGE_CAP = 200;
const FIXTURE_DISCOVERY_PAGE_CAP = 50;
const SEASON_SAMPLE_PAGE_CAP = 20;

type Envelope<T> = {
  data?: T;
  message?: string;
  pagination?: {
    has_more?: boolean;
    current_page?: number;
    next_page?: number | string | null;
  };
};

type RequiredSeason = {
  providerLeagueId: string;
  providerSeasonId: string;
};

type Args = {
  out: string;
  days: number;
  fixturesPerLeague: number;
  requiredSeasons: RequiredSeason[];
};

type RawResponseIndexEntry = {
  sha256: string;
  endpoint: string;
  status: number;
  contentType: string | null;
  bytes: number;
};

type LeagueEntitlement = {
  providerLeagueId: string;
  name: string | null;
  countryId: string | null;
  countryIso2: string | null;
  type: string | null;
  subType: string | null;
  active: boolean | null;
};

type SelectedFixture = {
  row: Record<string, unknown>;
  reasons: string[];
};

function parseRequiredSeason(value: string): RequiredSeason {
  const match = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(value.trim());
  if (!match) throw new Error(`required season must be LEAGUE_ID:SEASON_ID, got ${JSON.stringify(value)}`);
  return { providerLeagueId: match[1], providerSeasonId: match[2] };
}

function parseArgs(argv: string[]): Args {
  const result: Args = {
    out: "artifacts/kapiloto-v4-a2b",
    days: 45,
    fixturesPerLeague: 2,
    requiredSeasons: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") result.out = argv[++i] ?? result.out;
    else if (arg === "--days") result.days = Number(argv[++i] ?? result.days);
    else if (arg === "--fixtures-per-league") result.fixturesPerLeague = Number(argv[++i] ?? result.fixturesPerLeague);
    else if (arg === "--required-season") result.requiredSeasons.push(parseRequiredSeason(argv[++i] ?? ""));
    else if (arg === "--required-seasons") {
      const raw = argv[++i] ?? "";
      for (const value of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
        result.requiredSeasons.push(parseRequiredSeason(value));
      }
    }
  }
  if (!Number.isInteger(result.days) || result.days < 7 || result.days > 180) {
    throw new Error("--days must be an integer between 7 and 180.");
  }
  if (!Number.isInteger(result.fixturesPerLeague) || result.fixturesPerLeague < 1 || result.fixturesPerLeague > 5) {
    throw new Error("--fixtures-per-league must be an integer between 1 and 5.");
  }
  const seen = new Set<string>();
  for (const season of result.requiredSeasons) {
    const key = `${season.providerLeagueId}:${season.providerSeasonId}`;
    if (seen.has(key)) throw new Error(`duplicate required season ${key}`);
    seen.add(key);
    if (!SPORTMONKS_A2B_TARGET_LEAGUES.some((target) => target.providerLeagueId === season.providerLeagueId)) {
      throw new Error(`required season ${key} is outside the five reviewed target leagues`);
    }
  }
  return result;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cleanEndpoint(url: URL): string {
  const params = [...url.searchParams.entries()]
    .filter(([key]) => key !== "api_token")
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
    );
  const query = new URLSearchParams(params).toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asProviderId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  return null;
}

class RawArchive {
  private readonly entries: RawResponseIndexEntry[] = [];
  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(path.join(this.root, "raw"), { recursive: true });
    await this.flush();
  }

  async record(input: {
    bytes: Uint8Array;
    hash: string;
    endpoint: string;
    status: number;
    contentType: string | null;
  }): Promise<void> {
    await writeFile(path.join(this.root, "raw", `${input.hash}.bin`), input.bytes);
    this.entries.push({
      sha256: input.hash,
      endpoint: input.endpoint,
      status: input.status,
      contentType: input.contentType,
      bytes: input.bytes.byteLength,
    });
    await this.flush();
  }

  snapshot(): RawResponseIndexEntry[] {
    return [...this.entries];
  }

  private async flush(): Promise<void> {
    await writeFile(
      path.join(this.root, "raw-index.json"),
      JSON.stringify({ contract: "kapiloto-sportmonks-a2b-raw-index-v1", responses: this.entries }, null, 2) + "\n",
      "utf8",
    );
  }
}

async function requestRaw<T>(
  token: string,
  base: string,
  endpoint: string,
  archive: RawArchive,
  params: Record<string, string | number | undefined> = {},
): Promise<{ body: Envelope<T>; hash: string; endpoint: string }> {
  const url = new URL(`${base}${endpoint}`);
  url.searchParams.set("api_token", token);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/json" },
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = sha256(bytes);
  const sanitizedEndpoint = cleanEndpoint(url);
  await archive.record({
    bytes,
    hash,
    endpoint: sanitizedEndpoint,
    status: response.status,
    contentType: response.headers.get("content-type"),
  });

  let body: Envelope<T>;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Envelope<T>;
  } catch {
    throw new Error(`Sportmonks returned non-JSON for ${url.pathname} (${response.status}); raw SHA-256 ${hash}.`);
  }
  if (!response.ok) {
    throw new Error(
      `Sportmonks HTTP ${response.status} for ${url.pathname}: ${String(body.message ?? "request failed").slice(0, 200)}; raw SHA-256 ${hash}`,
    );
  }
  return { body, hash, endpoint: sanitizedEndpoint };
}

async function loadEntitlement(token: string, archive: RawArchive): Promise<LeagueEntitlement[]> {
  const competitions: LeagueEntitlement[] = [];
  for (let page = 1; page <= ENTITLEMENT_PAGE_CAP; page += 1) {
    const response = await requestRaw<Array<Record<string, unknown>>>(
      token,
      FOOTBALL_BASE,
      "/leagues",
      archive,
      { include: "country", page, per_page: 50 },
    );
    for (const row of response.body.data ?? []) {
      const id = asProviderId(row.id);
      if (!id) continue;
      const country = isRecord(row.country) ? row.country : null;
      competitions.push({
        providerLeagueId: id,
        name: typeof row.name === "string" ? row.name : null,
        countryId: asProviderId(row.country_id),
        countryIso2: country && typeof country.iso2 === "string" ? country.iso2.toUpperCase() : null,
        type: typeof row.type === "string" ? row.type : null,
        subType: typeof row.sub_type === "string" ? row.sub_type : null,
        active: typeof row.active === "boolean" ? row.active : null,
      });
    }
    const hasMore = response.body.pagination?.has_more === true;
    assertSportmonksA2BPaginationComplete({ label: "league entitlement", page, cap: ENTITLEMENT_PAGE_CAP, hasMore });
    if (!hasMore) break;
  }
  return [...new Map(competitions.map((row) => [row.providerLeagueId, row])).values()]
    .sort((a, b) => a.providerLeagueId.localeCompare(b.providerLeagueId, "en", { numeric: true }));
}

function finishedState(row: Record<string, unknown>): boolean {
  const state = row.state;
  const value = state && typeof state === "object" && !Array.isArray(state)
    ? (state as Record<string, unknown>).developer_name
    : null;
  return value === "FT" || value === "AET" || value === "FT_PEN";
}

function kickoffMs(row: Record<string, unknown>): number {
  if (typeof row.starting_at_timestamp === "number") return row.starting_at_timestamp * 1000;
  if (typeof row.starting_at === "string") return Date.parse(`${row.starting_at.replace(" ", "T")}Z`);
  return Number.NaN;
}

async function findPilotFixtures(
  token: string,
  archive: RawArchive,
  leagueId: string,
  startDate: string,
  endDate: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= FIXTURE_DISCOVERY_PAGE_CAP; page += 1) {
    const response = await requestRaw<Record<string, unknown>[]>(
      token,
      FOOTBALL_BASE,
      `/fixtures/between/${startDate}/${endDate}`,
      archive,
      {
        include: "state;participants;scores",
        filters: `fixtureLeagues:${leagueId}`,
        per_page: 50,
        page,
      },
    );
    rows.push(...(response.body.data ?? []).filter((row) => String(row.league_id) === leagueId && finishedState(row)));
    const hasMore = response.body.pagination?.has_more === true;
    assertSportmonksA2BPaginationComplete({ label: `fixture discovery league ${leagueId}`, page, cap: FIXTURE_DISCOVERY_PAGE_CAP, hasMore });
    if (!hasMore) break;
  }
  return rows
    .filter((row) => Number.isFinite(kickoffMs(row)))
    .sort((a, b) => kickoffMs(b) - kickoffMs(a))
    .slice(0, limit);
}

async function findSeasonSample(
  token: string,
  archive: RawArchive,
  required: RequiredSeason,
): Promise<Record<string, unknown> | null> {
  for (let page = 1; page <= SEASON_SAMPLE_PAGE_CAP; page += 1) {
    const response = await requestRaw<Record<string, unknown>[]>(
      token,
      FOOTBALL_BASE,
      `/fixtures/seasons/${required.providerSeasonId}`,
      archive,
      { include: "state;participants;scores", per_page: 50, page },
    );
    const rows = response.body.data ?? [];
    const matching = rows
      .filter((row) =>
        String(row.league_id) === required.providerLeagueId &&
        String(row.season_id) === required.providerSeasonId &&
        finishedState(row) &&
        Number.isFinite(kickoffMs(row)),
      )
      .sort((a, b) => kickoffMs(b) - kickoffMs(a));
    if (matching.length > 0) return matching[0];

    const hasMore = response.body.pagination?.has_more === true;
    assertSportmonksA2BPaginationComplete({
      label: `season sample ${required.providerLeagueId}:${required.providerSeasonId}`,
      page,
      cap: SEASON_SAMPLE_PAGE_CAP,
      hasMore,
    });
    if (!hasMore) return null;
  }
  return null;
}

function selectFixture(
  selected: Map<string, SelectedFixture>,
  leagueId: string,
  row: Record<string, unknown>,
  reason: string,
): void {
  const fixtureId = asProviderId(row.id);
  if (!fixtureId) throw new Error(`selected fixture in league ${leagueId} has no valid id`);
  const key = `${leagueId}:${fixtureId}`;
  const existing = selected.get(key);
  if (existing) {
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    return;
  }
  selected.set(key, { row, reasons: [reason] });
}

async function ensureEmptyOutputDirectory(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root);
  if (entries.length > 0) {
    throw new Error(
      `A2-B output directory must be empty before a run: ${root} contains ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.SPORTMONKS_API_TOKEN?.trim();
  if (!token) throw new Error("SPORTMONKS_API_TOKEN is required.");

  const capturedAt = new Date().toISOString();
  const now = new Date(capturedAt);
  const start = new Date(now.getTime() - args.days * 86_400_000);
  const startDate = isoDate(start);
  const endDate = isoDate(now);
  const mintBound = fixtureMintKickoffBefore(capturedAt, DEFAULT_SHADOW_CYCLE_CONFIG.scoringLookbackDays);

  await ensureEmptyOutputDirectory(args.out);
  await mkdir(path.join(args.out, "captures"), { recursive: true });
  const archive = new RawArchive(args.out);
  await archive.init();

  const entitlement = await loadEntitlement(token, archive);
  const entitlementSnapshot: ProviderEntitlementSnapshot = {
    provider: "sportmonks",
    capturedAt,
    source: "sportmonks_all_leagues_subscription",
    competitions: entitlement.map((row) => ({ providerLeagueId: row.providerLeagueId, name: row.name })),
  };
  const entitlementSha256 = providerEntitlementSnapshotSha256(entitlementSnapshot);
  const entitlementDetailsSha256 = sha256(
    new TextEncoder().encode(JSON.stringify(entitlement)),
  );
  await writeFile(
    path.join(args.out, "entitlement.json"),
    JSON.stringify(
      {
        ...entitlementSnapshot,
        details: entitlement,
        sha256: entitlementSha256,
        details_sha256: entitlementDetailsSha256,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const entitlementById = new Map(entitlement.map((row) => [row.providerLeagueId, row]));
  const targets = SPORTMONKS_A2B_TARGET_LEAGUES.map((target) => ({
    ...target,
    ...auditSportmonksA2BLeagueIdentity({
      expectedName: target.expectedName,
      expectedCountryIso2: target.expectedCountryIso2,
      expectedType: target.expectedType,
      expectedSubType: target.expectedSubType,
      actual: entitlementById.get(target.providerLeagueId) ?? null,
    }),
  }));

  const selected = new Map<string, SelectedFixture>();
  const recentCounts: Record<string, number> = {};

  for (const target of targets) {
    if (target.identityStatus !== "pass") {
      recentCounts[target.providerLeagueId] = 0;
      continue;
    }
    const recent = await findPilotFixtures(
      token,
      archive,
      target.providerLeagueId,
      startDate,
      endDate,
      args.fixturesPerLeague,
    );
    recentCounts[target.providerLeagueId] = recent.length;
    for (const row of recent) selectFixture(selected, target.providerLeagueId, row, "recent_window");
  }

  const seasonSamples: Array<{
    providerLeagueId: string;
    providerSeasonId: string;
    fixtureId: string | null;
    status: "sampled" | "missing";
  }> = [];
  for (const required of args.requiredSeasons) {
    const target = targets.find((row) => row.providerLeagueId === required.providerLeagueId);
    if (!target || target.identityStatus !== "pass") {
      seasonSamples.push({ ...required, fixtureId: null, status: "missing" });
      continue;
    }
    const sample = await findSeasonSample(token, archive, required);
    if (!sample) {
      seasonSamples.push({ ...required, fixtureId: null, status: "missing" });
      continue;
    }
    const fixtureId = asProviderId(sample.id);
    if (!fixtureId) throw new Error(`season sample ${required.providerLeagueId}:${required.providerSeasonId} returned an invalid fixture id`);
    selectFixture(selected, required.providerLeagueId, sample, `required_season:${required.providerSeasonId}`);
    seasonSamples.push({ ...required, fixtureId, status: "sampled" });
  }

  const captures: Array<{
    leagueId: string;
    fixtureId: string;
    sampleReasons: string[];
    parseStatus: "pass" | "fail";
    parseError: string | null;
    audit: ReturnType<typeof auditSportmonksA2BCapture> | null;
    flags: string[];
  }> = [];

  for (const [key, selectedFixture] of [...selected.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))) {
    const [leagueId, fixtureId] = key.split(":");
    process.stderr.write(`A2-B pilot: league ${leagueId}, fixture ${fixtureId}, reasons ${selectedFixture.reasons.join(",")}\n`);
    const response = await requestRaw<Record<string, unknown>>(
      token,
      FOOTBALL_BASE,
      `/fixtures/${fixtureId}`,
      archive,
      { include: SPORTMONKS_A2B_FIXTURE_INCLUDE },
    );
    const fixture = response.body.data;
    if (!fixture) {
      captures.push({
        leagueId,
        fixtureId,
        sampleReasons: selectedFixture.reasons,
        parseStatus: "fail",
        parseError: "fixture detail returned no data",
        audit: null,
        flags: [],
      });
      continue;
    }
    if (String(fixture.league_id) !== leagueId) {
      captures.push({
        leagueId,
        fixtureId,
        sampleReasons: selectedFixture.reasons,
        parseStatus: "fail",
        parseError: `fixture detail league drift: expected ${leagueId}, got ${String(fixture.league_id)}`,
        audit: null,
        flags: [],
      });
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

    captures.push({
      leagueId,
      fixtureId,
      sampleReasons: selectedFixture.reasons,
      parseStatus,
      parseError,
      audit,
      flags,
    });
    await writeFile(
      path.join(args.out, "captures", `${leagueId}-${fixtureId}.json`),
      JSON.stringify(capture, null, 2) + "\n",
      "utf8",
    );
  }

  const audits = captures.flatMap((item) => (item.audit ? [item.audit] : []));
  const providerSemanticEvidence = summarizeSportmonksA2BProviderSemantics(audits);
  const competitionProfiles = Object.fromEntries(
    SPORTMONKS_A2B_TARGET_LEAGUES.map((target) => [
      target.providerLeagueId,
      buildSportmonksA2BCompetitionProfile(target.providerLeagueId, audits),
    ]),
  );

  const report = {
    generatedAt: new Date().toISOString(),
    provider: "sportmonks",
    purpose: "a2b_real_payload_pilot",
    backfillApproval: {
      approved: false,
      reason: "A2-B verifies provider semantics, competition identity and scoped coverage; backfill approval is a separate reviewed decision.",
    },
    range: { startDate, endDate, days: args.days },
    fixturesPerLeague: args.fixturesPerLeague,
    requiredSeasons: args.requiredSeasons,
    seasonSamples,
    scoringLookbackDays: DEFAULT_SHADOW_CYCLE_CONFIG.scoringLookbackDays,
    fixtureMintKickoffBefore: mintBound,
    entitlementSnapshotSha256: entitlementSha256,
    entitlementDetailsSha256,
    targets,
    recentCounts,
    providerSemanticEvidence,
    competitionProfiles,
    captures,
    rawResponseIndex: archive.snapshot(),
  };
  await writeFile(path.join(args.out, "pilot-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  const identityFailures = targets.filter((target) => target.identityStatus !== "pass");
  const insufficientRecentSamples = targets.filter(
    (target) => target.identityStatus === "pass" && (recentCounts[target.providerLeagueId] ?? 0) < args.fixturesPerLeague,
  );
  const missingSeasonSamples = seasonSamples.filter((sample) => sample.status !== "sampled");
  const parseFailures = captures.filter((item) => item.parseStatus === "fail");

  process.stdout.write(JSON.stringify({
    identity: targets,
    recentCounts,
    seasonSamples,
    providerSemanticEvidence,
    competitionProfiles,
    parseFailures: parseFailures.map((item) => ({
      leagueId: item.leagueId,
      fixtureId: item.fixtureId,
      error: item.parseError,
    })),
    rawResponses: archive.snapshot().length,
    entitlementSnapshotSha256: entitlementSha256,
    entitlementDetailsSha256,
    mintBound,
    backfillApproved: false,
  }, null, 2) + "\n");

  if (
    identityFailures.length > 0 ||
    insufficientRecentSamples.length > 0 ||
    missingSeasonSamples.length > 0 ||
    parseFailures.length > 0 ||
    providerSemanticEvidence.status !== "pass"
  ) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
