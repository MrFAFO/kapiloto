import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_SHADOW_CYCLE_CONFIG } from "../lib/evaluation/shadow-cycle";
import {
  fixtureMintKickoffBefore,
  providerEntitlementSnapshotSha256,
  type ProviderEntitlementSnapshot,
} from "../lib/kapiloto-v4/provider-ingest";
import {
  auditSportmonksA2BCapture,
  buildSportmonksA2BCapture,
  SPORTMONKS_A2B_FIXTURE_INCLUDE,
  SPORTMONKS_A2B_TARGET_LEAGUES,
  sportmonksLeagueNameMatches,
  summarizeSportmonksA2BGates,
} from "../lib/kapiloto-v4/sportmonks-pilot";
import {
  parseSportmonksLedgerCapture,
  SportmonksLedgerParseError,
} from "../lib/kapiloto-v4/sportmonks-ledger";

const BASE = "https://api.sportmonks.com/v3/football";

type Envelope<T> = {
  data?: T;
  message?: string;
  pagination?: { has_more?: boolean; current_page?: number; next_page?: number | string | null };
};

type Args = {
  out: string;
  days: number;
  fixturesPerLeague: number;
};

function parseArgs(argv: string[]): Args {
  const result: Args = {
    out: "artifacts/kapiloto-v4-a2b",
    days: 45,
    fixturesPerLeague: 2,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") result.out = argv[++i] ?? result.out;
    else if (arg === "--days") result.days = Number(argv[++i] ?? result.days);
    else if (arg === "--fixtures-per-league") result.fixturesPerLeague = Number(argv[++i] ?? result.fixturesPerLeague);
  }
  if (!Number.isInteger(result.days) || result.days < 7 || result.days > 180) {
    throw new Error("--days must be an integer between 7 and 180.");
  }
  if (!Number.isInteger(result.fixturesPerLeague) || result.fixturesPerLeague < 1 || result.fixturesPerLeague > 5) {
    throw new Error("--fixtures-per-league must be an integer between 1 and 5.");
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
  return `${url.pathname}${url.searchParams.has("include") ? `?include=${url.searchParams.get("include")}` : ""}`;
}

async function requestRaw<T>(
  token: string,
  base: string,
  endpoint: string,
  params: Record<string, string | number | undefined> = {},
): Promise<{ body: Envelope<T>; hash: string; endpoint: string }> {
  const url = new URL(`${base}${endpoint}`);
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
  let body: Envelope<T>;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Envelope<T>;
  } catch {
    throw new Error(`Sportmonks returned non-JSON for ${url.pathname} (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`Sportmonks HTTP ${response.status} for ${url.pathname}: ${String(body.message ?? "request failed").slice(0, 200)}`);
  }
  return { body, hash, endpoint: cleanEndpoint(url) };
}

async function loadEntitlement(token: string): Promise<Array<{ providerLeagueId: string; name: string | null }>> {
  const competitions: Array<{ providerLeagueId: string; name: string | null }> = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await requestRaw<Array<Record<string, unknown>>>(token, BASE, "/leagues", {
      page,
      per_page: 100,
    });
    for (const row of response.body.data ?? []) {
      const id = row.id;
      if ((typeof id !== "number" && typeof id !== "string") || String(id).trim() === "") continue;
      competitions.push({
        providerLeagueId: String(id),
        name: typeof row.name === "string" ? row.name : null,
      });
    }
    if (response.body.pagination?.has_more !== true) break;
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
  leagueId: string,
  startDate: string,
  endDate: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await requestRaw<Record<string, unknown>[]>(token, BASE, `/fixtures/between/${startDate}/${endDate}`, {
      include: "state;participants;scores",
      filters: `fixtureLeagues:${leagueId}`,
      per_page: 50,
      page,
    });
    rows.push(...(response.body.data ?? []).filter((row) => String(row.league_id) === leagueId && finishedState(row)));
    if (response.body.pagination?.has_more !== true) break;
  }
  return rows
    .filter((row) => Number.isFinite(kickoffMs(row)))
    .sort((a, b) => kickoffMs(b) - kickoffMs(a))
    .slice(0, limit);
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

  await mkdir(args.out, { recursive: true });
  await mkdir(path.join(args.out, "captures"), { recursive: true });

  const entitlement = await loadEntitlement(token);
  const entitlementSnapshot: ProviderEntitlementSnapshot = {
    provider: "sportmonks",
    capturedAt,
    source: "sportmonks_all_leagues_subscription",
    competitions: entitlement,
  };
  const entitlementSha256 = providerEntitlementSnapshotSha256(entitlementSnapshot);
  await writeFile(
    path.join(args.out, "entitlement.json"),
    JSON.stringify({ ...entitlementSnapshot, sha256: entitlementSha256 }, null, 2) + "\n",
    "utf8",
  );

  const entitlementById = new Map(entitlement.map((row) => [row.providerLeagueId, row]));
  const targets = SPORTMONKS_A2B_TARGET_LEAGUES.map((target) => {
    const actual = entitlementById.get(target.providerLeagueId) ?? null;
    return {
      ...target,
      entitled: actual !== null,
      providerName: actual?.name ?? null,
      nameMatches: sportmonksLeagueNameMatches(actual?.name ?? null, target.expectedName),
    };
  });

  const captures: Array<{
    leagueId: string;
    fixtureId: string;
    parseStatus: "pass" | "fail";
    parseError: string | null;
    audit: ReturnType<typeof auditSportmonksA2BCapture> | null;
    flags: string[];
  }> = [];

  for (const target of targets) {
    if (!target.entitled || !target.nameMatches) continue;
    const candidates = await findPilotFixtures(
      token,
      target.providerLeagueId,
      startDate,
      endDate,
      args.fixturesPerLeague,
    );
    for (const candidate of candidates) {
      const fixtureId = String(candidate.id);
      process.stderr.write(`A2-B pilot: league ${target.providerLeagueId}, fixture ${fixtureId}\n`);
      const response = await requestRaw<Record<string, unknown>>(
        token,
        BASE,
        `/fixtures/${fixtureId}`,
        { include: SPORTMONKS_A2B_FIXTURE_INCLUDE },
      );
      const fixture = response.body.data;
      if (!fixture) {
        captures.push({
          leagueId: target.providerLeagueId,
          fixtureId,
          parseStatus: "fail",
          parseError: "fixture detail returned no data",
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
        leagueId: target.providerLeagueId,
        fixtureId,
        parseStatus,
        parseError,
        audit,
        flags,
      });
      await writeFile(
        path.join(args.out, "captures", `${target.providerLeagueId}-${fixtureId}.json`),
        JSON.stringify(capture, null, 2) + "\n",
        "utf8",
      );
    }
  }

  const audits = captures.flatMap((item) => (item.audit ? [item.audit] : []));
  const gateSummary = summarizeSportmonksA2BGates(audits);
  const fixturesByLeague = Object.fromEntries(
    SPORTMONKS_A2B_TARGET_LEAGUES.map((target) => [
      target.providerLeagueId,
      captures.filter((item) => item.leagueId === target.providerLeagueId).length,
    ]),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    provider: "sportmonks",
    purpose: "a2b_real_payload_pilot",
    range: { startDate, endDate, days: args.days },
    fixturesPerLeague: args.fixturesPerLeague,
    scoringLookbackDays: DEFAULT_SHADOW_CYCLE_CONFIG.scoringLookbackDays,
    fixtureMintKickoffBefore: mintBound,
    entitlementSnapshotSha256: entitlementSha256,
    targets,
    fixturesByLeague,
    gateSummary,
    captures,
  };
  await writeFile(path.join(args.out, "pilot-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  const missingEntitlement = targets.filter((target) => !target.entitled || !target.nameMatches);
  const missingPilotFixtures = targets.filter(
    (target) =>
      target.entitled &&
      target.nameMatches &&
      (fixturesByLeague[target.providerLeagueId] ?? 0) === 0,
  );
  const parseFailures = captures.filter((item) => item.parseStatus === "fail");
  const semanticFailures = Object.entries(gateSummary).filter(([, status]) => status === "fail");

  process.stdout.write(JSON.stringify({
    entitlement: targets,
    fixturesByLeague,
    gateSummary,
    parseFailures: parseFailures.map((item) => ({
      leagueId: item.leagueId,
      fixtureId: item.fixtureId,
      error: item.parseError,
    })),
    mintBound,
  }, null, 2) + "\n");

  if (
    missingEntitlement.length > 0 ||
    missingPilotFixtures.length > 0 ||
    parseFailures.length > 0 ||
    semanticFailures.length > 0
  ) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});