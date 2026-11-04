import { canonicalSha256 } from "./canonical-json";
import { PROVIDER_DATA_FAMILIES, type ProviderDataFamily } from "./provider-ingest";
import { SPORTMONKS_LEDGER_STAT_TYPES, type SportmonksLedgerCaptureV1 } from "./sportmonks-ledger";
import { SPORTMONKS_LEDGER_CAPTURE_CONTRACT_VERSION } from "./versions";

/**
 * Read-only Sportmonks A2-B provider pilot (D-056 pilot gates, amended per
 * the PR #19 review; supersedes PR #30, current-main port).
 *
 * Operator-run evidence producer only. Nothing here or in the operator tool
 * (tools/kapiloto-v4-sportmonks-pilot.ts) writes to Supabase, creates a
 * provider_ingest_run, calls an ingest / attestation RPC, mints a fixture,
 * writes a Match Ledger observation or changes any identity mapping. It does
 * not decide whether a historical backfill is approved: the report always
 * carries backfillApproval.approved = false.
 *
 * Evidence is kept in deliberately separate classes:
 *  - competition identity / entitlement (per reviewed target league);
 *  - provider-wide field semantics (what a Sportmonks field means);
 *  - per-competition and per-season family / stat coverage.
 *
 * An observed contradiction fails. Optional or absent data stays missing: it
 * is reported as unverified or as coverage, never turned into zero, never
 * pooled into a pass, and never borrowed from another competition or season.
 * An explicit zero is evidence about provider zero semantics, not a gate.
 */

// ---------------------------------------------------------------------------
// Contracts and reviewed targets
// ---------------------------------------------------------------------------

/** pilot-report.json written by the operator tool. */
export const SPORTMONKS_A2B_PILOT_REPORT_VERSION = "kapiloto-sportmonks-a2b-pilot-report-v1";
/** raw-index.json: one entry per archived HTTP response body. */
export const SPORTMONKS_A2B_RAW_INDEX_VERSION = "kapiloto-sportmonks-a2b-raw-index-v1";
/**
 * Hash of the full normalized entitlement rows (id, name, country, type,
 * sub_type, active). The A2-A entitlement snapshot hash
 * (kapiloto-provider-entitlement-snapshot-v1, id + name) is unchanged and
 * reported next to it.
 */
export const SPORTMONKS_A2B_ENTITLEMENT_DETAILS_VERSION = "kapiloto-sportmonks-a2b-entitlement-details-v1";

/**
 * Reviewed D-059 launch competitions. `expectedCountry` is the Sportmonks
 * country name observed in the 2026-11-02 readiness run (41421166450).
 * `expectedCountryIso2` is the reviewed ISO2 expectation carried over from
 * PR #30; it has not yet been observed on a real payload, so a mismatch fails
 * closed and is resolved only by a reviewed change backed by archived raw
 * evidence, never by loosening the check.
 */
export const SPORTMONKS_A2B_TARGET_LEAGUES = [
  { providerLeagueId: "8", expectedName: "Premier League", expectedCountry: "England", expectedCountryIso2: "GB", expectedType: "league", expectedSubType: "domestic" },
  { providerLeagueId: "82", expectedName: "Bundesliga", expectedCountry: "Germany", expectedCountryIso2: "DE", expectedType: "league", expectedSubType: "domestic" },
  { providerLeagueId: "564", expectedName: "La Liga", expectedCountry: "Spain", expectedCountryIso2: "ES", expectedType: "league", expectedSubType: "domestic" },
  { providerLeagueId: "384", expectedName: "Serie A", expectedCountry: "Italy", expectedCountryIso2: "IT", expectedType: "league", expectedSubType: "domestic" },
  { providerLeagueId: "372", expectedName: "Ligat ha'Al", expectedCountry: "Israel", expectedCountryIso2: "IL", expectedType: "league", expectedSubType: "domestic" },
] as const;

export type SportmonksTargetLeague = (typeof SPORTMONKS_A2B_TARGET_LEAGUES)[number];

export const SPORTMONKS_A2B_FIXTURE_INCLUDE =
  "participants;scores;state;lineups;formations;statistics.type;xgfixture.type";
export const SPORTMONKS_A2B_LEAGUE_DETAIL_INCLUDE = "country;currentSeason;seasons";
export const SPORTMONKS_A2B_ENTITLEMENT_INCLUDE = "country";

/**
 * The only fixture-mint policy the pilot ever hands the offline parser. The
 * parser output is audited and discarded; nothing is ingested.
 */
export const SPORTMONKS_A2B_PARSER_FIXTURE_MINT = Object.freeze({ allowed: false as const, kickoffBefore: null });

/** Sportmonks fixture state ids for FT, AET and FT_PEN (schedule rows may omit the state include). */
const FINISHED_STATE_NAMES = new Set(["FT", "AET", "FT_PEN"]);
const FINISHED_STATE_IDS = new Set([5, 7, 8]);

export type PilotGateStatus = "pass" | "fail" | "unverified";

export type PilotGate = {
  status: PilotGateStatus;
  detail: string;
};

type RecordLike = Record<string, unknown>;

const ALLOWLISTED_STAT_TYPES: readonly string[] = SPORTMONKS_LEDGER_STAT_TYPES.map((row) => row.typeId);
const ALLOWLISTED_STAT_TYPE_SET = new Set<string>(ALLOWLISTED_STAT_TYPES);
const EXPECTED_LINEUP_TYPES = [11, 12] as const;
const EXPECTED_POSITIONS = [24, 25, 26, 27] as const;
const FORMATION_PATTERN = /^[1-6](-[1-6]){1,5}$/;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asProviderId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  return null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function compareProviderIds(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function sportmonksLeagueNameMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  return normalizeName(actual) === normalizeName(expected);
}

const pass = (detail: string): PilotGate => ({ status: "pass", detail });
const fail = (detail: string): PilotGate => ({ status: "fail", detail });
const unverified = (detail: string): PilotGate => ({ status: "unverified", detail });

// ---------------------------------------------------------------------------
// Operator arguments
// ---------------------------------------------------------------------------

export type SportmonksA2BRequiredSeason = {
  providerLeagueId: string;
  providerSeasonId: string;
};

export type SportmonksA2BPilotArgs = {
  out: string;
  seasonsPerLeague: number;
  fixturesPerSeason: number;
  requiredSeasons: SportmonksA2BRequiredSeason[];
};

export const SPORTMONKS_A2B_DEFAULT_OUT = "artifacts/kapiloto-v4-a2b";

function parseRequiredSeason(value: string): SportmonksA2BRequiredSeason {
  const match = /^([1-9][0-9]{0,18}):([1-9][0-9]{0,18})$/.exec(value.trim());
  if (!match) throw new Error(`required season must be LEAGUE_ID:SEASON_ID, got ${JSON.stringify(value)}`);
  return { providerLeagueId: match[1], providerSeasonId: match[2] };
}

function integerArg(name: string, raw: string | undefined, min: number, max: number): number {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/**
 * Strict CLI parsing: an unknown flag is an error rather than silently
 * ignored, so an outdated workflow cannot run with defaults it did not ask
 * for. Each required season (LEAGUE_ID:SEASON_ID) must belong to a reviewed
 * target league and appear at most once.
 */
export function parseSportmonksA2BPilotArgs(argv: readonly string[]): SportmonksA2BPilotArgs {
  const result: SportmonksA2BPilotArgs = {
    out: SPORTMONKS_A2B_DEFAULT_OUT,
    seasonsPerLeague: 3,
    fixturesPerSeason: 2,
    requiredSeasons: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string | undefined => {
      i += 1;
      return argv[i];
    };
    if (arg === "--out") {
      const value = next();
      if (!value || value.trim() === "") throw new Error("--out requires a directory.");
      result.out = value;
    } else if (arg === "--seasons-per-league") {
      result.seasonsPerLeague = integerArg("--seasons-per-league", next(), 1, 6);
    } else if (arg === "--fixtures-per-season") {
      result.fixturesPerSeason = integerArg("--fixtures-per-season", next(), 1, 5);
    } else if (arg === "--required-season") {
      result.requiredSeasons.push(parseRequiredSeason(next() ?? ""));
    } else if (arg === "--required-seasons") {
      const raw = next();
      if (raw === undefined) throw new Error("--required-seasons requires a value (it may be empty).");
      for (const value of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
        result.requiredSeasons.push(parseRequiredSeason(value));
      }
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(arg)}.`);
    }
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

// ---------------------------------------------------------------------------
// Credentials, endpoints and pagination
// ---------------------------------------------------------------------------

export type SportmonksA2BCredentialGuard = {
  /**
   * True when the text or bytes contain the credential, literally or behind
   * JSON (\uXXXX, \/) or URL percent escapes.
   */
  contains(value: string | Uint8Array): boolean;
  /** Replaces every literal occurrence of the credential with [REDACTED]. */
  redact(text: string): string;
};

/**
 * Only alphanumeric tokens are guarded. For them the literal, percent-encoded
 * (encodeURIComponent or URLSearchParams form encoding) and JSON-escaped forms
 * are the same string, so no serialization of the request URL can carry the
 * token past the guard. A token with any other character fails before any
 * request is made.
 */
const GUARDED_TOKEN_PATTERN = /^[A-Za-z0-9]+$/;

/**
 * Undoes the escapes a provider body can carry around an echoed token: JSON
 * \uXXXX and \/ escapes and URL percent escapes in either hex case, repeated
 * so double encoding is undone too. Used for detection only; archived bytes
 * are never altered.
 */
function unescapeForCredentialScan(text: string): string {
  let current = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = current
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\\//g, "/")
      .replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * The raw archive keeps exact response bytes, so a response that echoed the
 * credential cannot be redacted without breaking its hash. The guard detects
 * it instead; the caller then refuses to archive and aborts the run.
 */
export function createSportmonksA2BCredentialGuard(token: string): SportmonksA2BCredentialGuard {
  if (typeof token !== "string" || token.length < 16 || /\s/.test(token)) {
    throw new Error("SPORTMONKS_API_TOKEN must be at least 16 characters without whitespace to be guarded.");
  }
  if (!GUARDED_TOKEN_PATTERN.test(token)) {
    throw new Error("SPORTMONKS_API_TOKEN must contain only the letters A-Z, a-z and the digits 0-9 to be guarded.");
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return {
    contains(value) {
      const text = typeof value === "string" ? value : decoder.decode(value);
      return text.includes(token) || unescapeForCredentialScan(text).includes(token);
    },
    redact(text) {
      return text.split(token).join("[REDACTED]");
    },
  };
}

/**
 * Endpoint as archived and as the capture's provider_endpoint: path plus the
 * sorted query without api_token. Never contains the credential.
 */
export function sanitizeSportmonksEndpoint(url: URL): string {
  const params = [...url.searchParams.entries()]
    .filter(([key]) => key.toLowerCase() !== "api_token")
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
    );
  const query = new URLSearchParams(params).toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

/**
 * Exhaustive list reads fail closed: reaching the hard cap while the provider
 * still reports has_more = true refuses a partial snapshot.
 */
export function assertSportmonksA2BPaginationComplete(input: {
  label: string;
  page: number;
  cap: number;
  hasMore: boolean;
}): void {
  if (!Number.isInteger(input.page) || !Number.isInteger(input.cap) || input.page < 1 || input.cap < 1) {
    throw new Error("pagination page/cap must be positive integers");
  }
  if (input.page > input.cap) {
    throw new Error(`${input.label} pagination page ${input.page} is beyond hard cap ${input.cap}`);
  }
  if (input.page >= input.cap && input.hasMore) {
    throw new Error(
      `${input.label} pagination reached hard cap ${input.cap} while has_more=true; refusing a partial snapshot`,
    );
  }
}

/**
 * One page of an exhaustive list read (the league entitlement). The page must
 * carry a data array and pagination metadata that names this page and says
 * whether more pages follow. Missing or malformed metadata refuses the
 * snapshot instead of being read as the last page, a provider that ignores
 * the page parameter is caught by current_page, and an empty page that
 * announces more is refused at once.
 */
export function readSportmonksA2BListPage(input: {
  label: string;
  page: number;
  cap: number;
  body: unknown;
}): { rows: unknown[]; hasMore: boolean } {
  const refuse = (why: string): never => {
    throw new Error(`${input.label} page ${input.page} ${why}; refusing a partial snapshot`);
  };
  const body = isRecord(input.body) ? input.body : null;
  if (!body || !Array.isArray(body.data)) return refuse("has no data array");
  const pagination = body.pagination;
  if (!isRecord(pagination)) return refuse("has no pagination metadata");
  if (typeof pagination.has_more !== "boolean") return refuse("has a non-boolean or missing pagination.has_more");
  if (pagination.current_page !== input.page) {
    const observed = typeof pagination.current_page === "number" ? String(pagination.current_page) : typeof pagination.current_page;
    return refuse(`reported current_page ${observed}`);
  }
  if (pagination.has_more && body.data.length === 0) return refuse("is empty while has_more=true");
  assertSportmonksA2BPaginationComplete({ label: input.label, page: input.page, cap: input.cap, hasMore: pagination.has_more });
  return { rows: body.data, hasMore: pagination.has_more };
}

/**
 * A response read as one complete document (league detail, season schedule,
 * fixture detail) must not announce more pages. These endpoints normally
 * carry no pagination at all; metadata that is present but malformed (not an
 * object, or a has_more that is not a boolean) is refused rather than read as
 * "no more pages".
 */
export function assertSportmonksA2BSinglePage(label: string, pagination: unknown): void {
  if (pagination === undefined || pagination === null) return;
  if (!isRecord(pagination) || (pagination.has_more !== undefined && typeof pagination.has_more !== "boolean")) {
    throw new Error(`${label} carried malformed pagination metadata; refusing a partial read`);
  }
  if (pagination.has_more === true) {
    throw new Error(`${label} unexpectedly reported has_more=true; refusing a partial read`);
  }
}

// ---------------------------------------------------------------------------
// Entitlement and competition identity
// ---------------------------------------------------------------------------

export type SportmonksA2BEntitlementRow = {
  providerLeagueId: string;
  name: string | null;
  countryId: string | null;
  countryName: string | null;
  countryIso2: string | null;
  type: string | null;
  subType: string | null;
  active: boolean | null;
};

function iso2(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toUpperCase() : null;
}

/** One /leagues row (include=country). Rows without a valid id return null. */
export function parseSportmonksA2BEntitlementRow(raw: unknown): SportmonksA2BEntitlementRow | null {
  if (!isRecord(raw)) return null;
  const id = asProviderId(raw.id);
  if (!id) return null;
  const country = isRecord(raw.country) ? raw.country : null;
  return {
    providerLeagueId: id,
    name: asString(raw.name),
    countryId: asProviderId(raw.country_id),
    countryName: country ? asString(country.name) : null,
    countryIso2: country ? iso2(country.iso2) : null,
    type: asString(raw.type),
    subType: asString(raw.sub_type),
    active: typeof raw.active === "boolean" ? raw.active : null,
  };
}

/**
 * Deduplicates entitlement rows seen across pages. An identical repeat is
 * folded; a repeat with different content means the listing shifted under
 * pagination, so the snapshot is refused.
 */
export function mergeSportmonksA2BEntitlementRows(
  rows: readonly SportmonksA2BEntitlementRow[],
): SportmonksA2BEntitlementRow[] {
  const byId = new Map<string, SportmonksA2BEntitlementRow>();
  for (const row of rows) {
    const existing = byId.get(row.providerLeagueId);
    if (existing && canonicalSha256(existing) !== canonicalSha256(row)) {
      throw new Error(
        `entitlement league ${row.providerLeagueId} appeared twice with different details; refusing an inconsistent snapshot`,
      );
    }
    byId.set(row.providerLeagueId, row);
  }
  return [...byId.values()].sort((a, b) => compareProviderIds(a.providerLeagueId, b.providerLeagueId));
}

export function sportmonksA2BEntitlementDetailsSha256(input: {
  capturedAt: string;
  source: string;
  rows: readonly SportmonksA2BEntitlementRow[];
}): string {
  return canonicalSha256({
    contract_version: SPORTMONKS_A2B_ENTITLEMENT_DETAILS_VERSION,
    provider: "sportmonks",
    captured_at: new Date(input.capturedAt).toISOString(),
    source: input.source,
    competitions: [...input.rows]
      .sort((a, b) => compareProviderIds(a.providerLeagueId, b.providerLeagueId))
      .map((row) => ({
        provider_league_id: row.providerLeagueId,
        name: row.name,
        country_id: row.countryId,
        country_name: row.countryName,
        country_iso2: row.countryIso2,
        type: row.type,
        sub_type: row.subType,
        active: row.active,
      })),
  });
}

export type SportmonksA2BSeason = {
  id: string;
  name: string | null;
  leagueId: string;
  isCurrent: boolean;
  startingAt: string | null;
  endingAt: string | null;
};

function dateValue(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value : null;
}

function seasonRow(raw: unknown): SportmonksA2BSeason | null {
  if (!isRecord(raw)) return null;
  const id = asProviderId(raw.id);
  const leagueId = asProviderId(raw.league_id);
  if (!id || !leagueId) return null;
  return {
    id,
    name: asString(raw.name),
    leagueId,
    isCurrent: raw.is_current === true,
    startingAt: dateValue(raw.starting_at),
    endingAt: dateValue(raw.ending_at),
  };
}

/**
 * Seasons from a league detail (include=currentSeason;seasons), current
 * first, then most recent by ending/starting date, then by id. Rows without a
 * valid id or league id are counted, not silently dropped.
 */
export function parseSportmonksA2BLeagueSeasons(detail: unknown): {
  seasons: SportmonksA2BSeason[];
  malformedRows: number;
} {
  const league = isRecord(detail) ? detail : {};
  const byId = new Map<string, SportmonksA2BSeason>();
  let malformedRows = 0;
  for (const value of asArray(league.seasons)) {
    const row = seasonRow(value);
    if (!row) {
      malformedRows += 1;
      continue;
    }
    byId.set(row.id, row);
  }
  const currentRaw = isRecord(league.currentseason)
    ? league.currentseason
    : isRecord(league.currentSeason)
      ? league.currentSeason
      : null;
  if (currentRaw) {
    const current = seasonRow(currentRaw);
    if (current) byId.set(current.id, current);
    else malformedRows += 1;
  }
  const seasons = [...byId.values()].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const aDate = a.endingAt ?? a.startingAt ?? "";
    const bDate = b.endingAt ?? b.startingAt ?? "";
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    return compareProviderIds(b.id, a.id);
  });
  return { seasons, malformedRows };
}

export const SPORTMONKS_A2B_LEAGUE_IDENTITY_GATES = [
  "entitled",
  "id",
  "name",
  "country",
  "countryIso2",
  "type",
  "currentSeason",
  "seasonLeague",
] as const;
export type SportmonksA2BLeagueIdentityGateName = (typeof SPORTMONKS_A2B_LEAGUE_IDENTITY_GATES)[number];

export type SportmonksA2BLeagueIdentity = {
  providerLeagueId: string;
  identityStatus: "pass" | "fail";
  gates: Record<SportmonksA2BLeagueIdentityGateName, PilotGate>;
  observed: {
    entitlement: SportmonksA2BEntitlementRow | null;
    detail: {
      id: string | null;
      name: string | null;
      countryName: string | null;
      countryIso2: string | null;
      type: string | null;
      subType: string | null;
      currentSeasonId: string | null;
      currentSeasonLeagueId: string | null;
      currentSeasonName: string | null;
      currentSeasonIsCurrent: boolean | null;
      seasonCount: number;
      malformedSeasonRows: number;
      foreignSeasonIds: string[];
    } | null;
  };
};

/**
 * Competition identity for one reviewed target. Both the subscription row
 * (/leagues, include=country) and the league detail (/leagues/{id},
 * include=country;currentSeason;seasons) must agree with the reviewed id,
 * name, country name, country ISO2 and league/domestic type; the current
 * season and every listed season must belong to the league. Every gate is
 * pass or fail; a missing source fails.
 */
export function auditSportmonksA2BLeagueIdentity(input: {
  target: SportmonksTargetLeague;
  entitlement: SportmonksA2BEntitlementRow | null;
  detail: unknown;
}): SportmonksA2BLeagueIdentity {
  const { target, entitlement } = input;
  const detail = isRecord(input.detail) ? input.detail : null;
  const country = detail && isRecord(detail.country) ? detail.country : null;
  const currentRaw = detail
    ? isRecord(detail.currentseason)
      ? detail.currentseason
      : isRecord(detail.currentSeason)
        ? detail.currentSeason
        : null
    : null;
  const parsedSeasons = detail ? parseSportmonksA2BLeagueSeasons(detail) : { seasons: [], malformedRows: 0 };
  const observedDetail: SportmonksA2BLeagueIdentity["observed"]["detail"] = detail
    ? {
        id: asProviderId(detail.id),
        name: asString(detail.name),
        countryName: country ? asString(country.name) : null,
        countryIso2: country ? iso2(country.iso2) : null,
        type: asString(detail.type),
        subType: asString(detail.sub_type),
        currentSeasonId: currentRaw ? asProviderId(currentRaw.id) : null,
        currentSeasonLeagueId: currentRaw ? asProviderId(currentRaw.league_id) : null,
        currentSeasonName: currentRaw ? asString(currentRaw.name) : null,
        currentSeasonIsCurrent: currentRaw && typeof currentRaw.is_current === "boolean" ? currentRaw.is_current : null,
        seasonCount: parsedSeasons.seasons.length,
        malformedSeasonRows: parsedSeasons.malformedRows,
        foreignSeasonIds: parsedSeasons.seasons
          .filter((season) => season.leagueId !== target.providerLeagueId)
          .map((season) => season.id)
          .sort(compareProviderIds),
      }
    : null;

  const missing = (what: string): PilotGate => {
    const reasons = [
      entitlement ? null : "league is not in the subscription",
      observedDetail ? null : "league detail unavailable",
    ].filter((reason): reason is string => reason !== null);
    return fail(`${what} cannot be verified: ${reasons.join("; ")}.`);
  };

  const gates: Record<SportmonksA2BLeagueIdentityGateName, PilotGate> = {
    entitled: entitlement
      ? pass(`League ${target.providerLeagueId} is in the subscription.`)
      : fail(`League ${target.providerLeagueId} is not in the subscription.`),
    id:
      entitlement && observedDetail
        ? entitlement.providerLeagueId === target.providerLeagueId && observedDetail.id === target.providerLeagueId
          ? pass(`League id is ${target.providerLeagueId} in both the subscription and the league detail.`)
          : fail(`Expected league id ${target.providerLeagueId}; subscription ${entitlement.providerLeagueId}, detail ${observedDetail.id ?? "none"}.`)
        : missing("league id"),
    name:
      entitlement && observedDetail
        ? sportmonksLeagueNameMatches(entitlement.name, target.expectedName) &&
          sportmonksLeagueNameMatches(observedDetail.name, target.expectedName)
          ? pass(`League name matches ${target.expectedName}.`)
          : fail(`Expected ${target.expectedName}; subscription ${entitlement.name ?? "none"}, detail ${observedDetail.name ?? "none"}.`)
        : missing("league name"),
    country:
      entitlement && observedDetail
        ? sportmonksLeagueNameMatches(entitlement.countryName, target.expectedCountry) &&
          sportmonksLeagueNameMatches(observedDetail.countryName, target.expectedCountry)
          ? pass(`Country is ${target.expectedCountry}.`)
          : fail(`Expected country ${target.expectedCountry}; subscription ${entitlement.countryName ?? "none"}, detail ${observedDetail.countryName ?? "none"}.`)
        : missing("country"),
    countryIso2:
      entitlement && observedDetail
        ? entitlement.countryIso2 === target.expectedCountryIso2 && observedDetail.countryIso2 === target.expectedCountryIso2
          ? pass(`Country ISO2 is ${target.expectedCountryIso2}.`)
          : fail(`Expected country ISO2 ${target.expectedCountryIso2}; subscription ${entitlement.countryIso2 ?? "none"}, detail ${observedDetail.countryIso2 ?? "none"}.`)
        : missing("country ISO2"),
    type:
      entitlement && observedDetail
        ? entitlement.type === target.expectedType &&
          entitlement.subType === target.expectedSubType &&
          observedDetail.type === target.expectedType &&
          observedDetail.subType === target.expectedSubType
          ? pass(`Competition type is ${target.expectedType}/${target.expectedSubType}.`)
          : fail(
              `Expected ${target.expectedType}/${target.expectedSubType}; subscription ${entitlement.type ?? "none"}/${entitlement.subType ?? "none"}, detail ${observedDetail.type ?? "none"}/${observedDetail.subType ?? "none"}.`,
            )
        : missing("competition type"),
    currentSeason: observedDetail
      ? observedDetail.currentSeasonId &&
        observedDetail.currentSeasonLeagueId === target.providerLeagueId &&
        observedDetail.currentSeasonIsCurrent === true
        ? pass(`Current season ${observedDetail.currentSeasonId} (${observedDetail.currentSeasonName ?? "unnamed"}) belongs to the target league.`)
        : fail(
            `Current-season identity mismatch: id=${observedDetail.currentSeasonId ?? "none"}, league_id=${observedDetail.currentSeasonLeagueId ?? "none"}, is_current=${String(observedDetail.currentSeasonIsCurrent)}.`,
          )
      : fail("League detail unavailable."),
    seasonLeague: observedDetail
      ? observedDetail.foreignSeasonIds.length === 0 && observedDetail.malformedSeasonRows === 0 && observedDetail.seasonCount > 0
        ? pass(`All ${observedDetail.seasonCount} listed seasons belong to the target league.`)
        : fail(
            `Season list mismatch: seasons=${observedDetail.seasonCount}, foreign=${observedDetail.foreignSeasonIds.join(",") || "none"}, malformed=${observedDetail.malformedSeasonRows}.`,
          )
      : fail("League detail unavailable."),
  };

  return {
    providerLeagueId: target.providerLeagueId,
    identityStatus: SPORTMONKS_A2B_LEAGUE_IDENTITY_GATES.every((gate) => gates[gate].status === "pass") ? "pass" : "fail",
    gates,
    observed: { entitlement, detail: observedDetail },
  };
}

/**
 * The seasons to sample for one league: the most recent `seasonsPerLeague`
 * accessible seasons plus every explicitly required season. A required season
 * must appear in the league's own season list; it is never assumed.
 */
export function selectSportmonksA2BSeasons(input: {
  providerLeagueId: string;
  seasons: readonly SportmonksA2BSeason[];
  seasonsPerLeague: number;
  requiredSeasons: readonly SportmonksA2BRequiredSeason[];
}): {
  selected: Array<{ season: SportmonksA2BSeason; reasons: Array<"most_recent" | "required"> }>;
  missingRequiredSeasonIds: string[];
  historyDepthInsufficient: boolean;
} {
  const own = input.seasons.filter((season) => season.leagueId === input.providerLeagueId);
  const selected = new Map<string, { season: SportmonksA2BSeason; reasons: Array<"most_recent" | "required"> }>();
  for (const season of own.slice(0, input.seasonsPerLeague)) {
    selected.set(season.id, { season, reasons: ["most_recent"] });
  }
  const missingRequiredSeasonIds: string[] = [];
  for (const required of input.requiredSeasons) {
    if (required.providerLeagueId !== input.providerLeagueId) continue;
    const season = own.find((row) => row.id === required.providerSeasonId);
    if (!season) {
      missingRequiredSeasonIds.push(required.providerSeasonId);
      continue;
    }
    const existing = selected.get(season.id);
    if (existing) {
      if (!existing.reasons.includes("required")) existing.reasons.push("required");
    } else {
      selected.set(season.id, { season, reasons: ["required"] });
    }
  }
  return {
    selected: [...selected.values()],
    missingRequiredSeasonIds: missingRequiredSeasonIds.sort(compareProviderIds),
    historyDepthInsufficient: own.length < input.seasonsPerLeague,
  };
}

// ---------------------------------------------------------------------------
// Season fixture discovery (/schedules/seasons/{id})
// ---------------------------------------------------------------------------

/** Fixtures nested in a season schedule (stages[].fixtures and stages[].rounds[].fixtures). */
export function extractSportmonksScheduleFixtures(stages: unknown): RecordLike[] {
  const rows: RecordLike[] = [];
  const addFixtures = (value: unknown): void => {
    for (const fixture of asArray(value)) if (isRecord(fixture)) rows.push(fixture);
  };
  for (const stage of asArray(stages)) {
    if (!isRecord(stage)) continue;
    addFixtures(stage.fixtures);
    for (const round of asArray(stage.rounds)) if (isRecord(round)) addFixtures(round.fixtures);
  }
  return [...new Map(rows.map((row) => [asProviderId(row.id) ?? JSON.stringify(row), row] as const)).values()];
}

export function isSportmonksFinishedFixtureRow(row: RecordLike): boolean {
  const state = isRecord(row.state) ? row.state.developer_name : null;
  if (typeof state === "string") return FINISHED_STATE_NAMES.has(state);
  const stateId = typeof row.state_id === "number" ? row.state_id : typeof row.state_id === "string" ? Number(row.state_id) : Number.NaN;
  return FINISHED_STATE_IDS.has(stateId);
}

export function sportmonksFixtureKickoffMs(row: RecordLike): number {
  if (typeof row.starting_at_timestamp === "number") return row.starting_at_timestamp * 1000;
  if (typeof row.starting_at === "string") {
    const normalized = row.starting_at.includes("T") ? row.starting_at : row.starting_at.replace(" ", "T");
    return Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`);
  }
  return Number.NaN;
}

/** The most recent finished fixtures of exactly this league and season. */
export function selectSportmonksFinishedSeasonFixtures(input: {
  stages: unknown;
  providerLeagueId: string;
  providerSeasonId: string;
  limit: number;
}): RecordLike[] {
  return extractSportmonksScheduleFixtures(input.stages)
    .filter(
      (row) =>
        String(row.league_id) === input.providerLeagueId &&
        String(row.season_id) === input.providerSeasonId &&
        isSportmonksFinishedFixtureRow(row) &&
        Number.isFinite(sportmonksFixtureKickoffMs(row)),
    )
    .sort((a, b) => sportmonksFixtureKickoffMs(b) - sportmonksFixtureKickoffMs(a))
    .slice(0, input.limit);
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export function buildSportmonksA2BCapture(input: {
  fixture: unknown;
  capturedAt: string;
  rawPayloadSha256: string;
  providerEndpoint: string;
}): SportmonksLedgerCaptureV1 {
  if (!isRecord(input.fixture)) throw new Error("Sportmonks fixture payload must be an object.");
  if (!/^[0-9a-f]{64}$/.test(input.rawPayloadSha256)) {
    throw new Error("rawPayloadSha256 must be a lowercase SHA-256.");
  }

  const fixture = input.fixture;
  const familyRows = {
    lineups: asArray(fixture.lineups),
    formations: asArray(fixture.formations),
    statistics: asArray(fixture.statistics),
    xg: asArray(fixture.xgfixture),
  } as const;

  return {
    contract_version: SPORTMONKS_LEDGER_CAPTURE_CONTRACT_VERSION,
    captured_at: input.capturedAt,
    capture_mode: "backfill",
    provider_endpoint: input.providerEndpoint,
    raw_payload_sha256: input.rawPayloadSha256,
    fixture: {
      id: fixture.id as number | string,
      league_id: fixture.league_id as number | string,
      season_id: fixture.season_id as number | string,
      starting_at_timestamp: typeof fixture.starting_at_timestamp === "number" ? fixture.starting_at_timestamp : null,
      starting_at: typeof fixture.starting_at === "string" ? fixture.starting_at : null,
      state: isRecord(fixture.state)
        ? { developer_name: typeof fixture.state.developer_name === "string" ? fixture.state.developer_name : null }
        : null,
      participants: asArray(fixture.participants).map((participant) => {
        const row = isRecord(participant) ? participant : {};
        const meta = isRecord(row.meta) ? row.meta : {};
        return {
          id: row.id as number | string,
          name: typeof row.name === "string" ? row.name : null,
          meta: { location: typeof meta.location === "string" ? meta.location : null },
        };
      }),
      scores: asArray(fixture.scores) as SportmonksLedgerCaptureV1["fixture"]["scores"],
      neutral_venue: typeof fixture.neutral_venue === "boolean" ? fixture.neutral_venue : null,
    },
    families: {
      lineups: { fetch_status: "fetched", rows: familyRows.lineups, raw_response_sha256: input.rawPayloadSha256 },
      formations: { fetch_status: "fetched", rows: familyRows.formations, raw_response_sha256: input.rawPayloadSha256 },
      statistics: { fetch_status: "fetched", rows: familyRows.statistics, raw_response_sha256: input.rawPayloadSha256 },
      xg: { fetch_status: "fetched", rows: familyRows.xg, raw_response_sha256: input.rawPayloadSha256 },
    },
  };
}

// ---------------------------------------------------------------------------
// Per-fixture audit
// ---------------------------------------------------------------------------

export const SPORTMONKS_A2B_GATE_NAMES = [
  "participantLocations",
  "scoreSemantics",
  "lineupTypes",
  "lineupParticipants",
  "broadPositions",
  "formationSemantics",
  "possessionSum",
  "shotsOnTarget",
  "nonPenaltyXg",
] as const;
export type SportmonksA2BGateName = (typeof SPORTMONKS_A2B_GATE_NAMES)[number];

export type SportmonksA2BFixtureAudit = {
  providerFixtureId: string;
  providerLeagueId: string;
  providerSeasonId: string;
  gates: Record<SportmonksA2BGateName, PilotGate>;
  observed: {
    familyRows: Record<ProviderDataFamily, number>;
    lineupTypeIds: number[];
    positionIds: number[];
    lineupStarterCounts: { home: number; away: number };
    lineupBenchCounts: { home: number; away: number };
    explicitZeroStatTypes: string[];
    omittedAllowlistedStatTypes: string[];
    presentAllowlistedStatTypes: string[];
    /** True only for a passing FT fixture whose non-zero first half tells a cumulative 2ND_HALF apart. */
    cumulativeSecondHalfDiscriminated: boolean;
  };
};

type ScorePair = { pair: { home: number; away: number } | null; conflict: boolean };

function scorePair(scores: unknown[], description: string): ScorePair {
  const pair: Partial<Record<"home" | "away", number>> = {};
  let conflict = false;
  for (const value of scores) {
    if (!isRecord(value) || String(value.description ?? "").toUpperCase() !== description || !isRecord(value.score)) continue;
    const side = value.score.participant;
    const goals = value.score.goals;
    if ((side === "home" || side === "away") && typeof goals === "number" && Number.isInteger(goals) && goals >= 0) {
      if (pair[side] !== undefined && pair[side] !== goals) conflict = true;
      pair[side] = goals;
    }
  }
  return {
    pair: !conflict && typeof pair.home === "number" && typeof pair.away === "number" ? { home: pair.home, away: pair.away } : null,
    conflict,
  };
}

function relationGate(checks: Array<boolean | null>, passDetail: string, failDetail: string, unverifiedDetail: string): PilotGate {
  if (checks.some((value) => value === false)) return fail(failDetail);
  if (checks.some((value) => value === true)) return pass(passDetail);
  return unverified(unverifiedDetail);
}

function statRows(capture: SportmonksLedgerCaptureV1): RecordLike[] {
  return (["statistics", "xg"] as const).flatMap((family) => capture.families[family].rows.filter(isRecord));
}

function sideByParticipant(capture: SportmonksLedgerCaptureV1): Map<string, "home" | "away"> {
  const result = new Map<string, "home" | "away">();
  for (const participant of capture.fixture.participants) {
    const id = asProviderId(participant.id);
    const location = participant.meta?.location;
    if (id && (location === "home" || location === "away")) result.set(id, location);
  }
  return result;
}

function valuesBySideAndType(capture: SportmonksLedgerCaptureV1, sides: Map<string, "home" | "away">): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of statRows(capture)) {
    const participant = asProviderId(row.participant_id);
    const side = participant ? sides.get(participant) : undefined;
    const typeId = asProviderId(row.type_id);
    const value = asFiniteNumber(isRecord(row.data) ? row.data.value : undefined);
    if (side && typeId && value !== null) result.set(`${side}:${typeId}`, value);
  }
  return result;
}

type ScoreSemantics = { gate: PilotGate; cumulativeSecondHalfDiscriminated: boolean };

/**
 * Finished-score semantics of one fixture.
 *
 * 1ST_HALF is used twice. A first-half score above a later cumulative score
 * is a contradiction (goals never decrease). A non-zero first half is also
 * what lets an FT fixture discriminate a cumulative 2ND_HALF from a
 * second-half-only one: after a 0-0 first half both read the same, so such a
 * fixture is consistent but proves nothing about the field's meaning. The
 * provider-wide summary therefore needs at least one discriminating fixture.
 *
 * Extra-time states pass only when the pairs themselves discriminate:
 * - AET passes only when an extra-time goal separates the 90-minute 2ND_HALF
 *   from CURRENT; without one it stays unverified;
 * - FT_PEN never passes here. Whether CURRENT excludes the shootout cannot be
 *   told from these pairs (a two-legged tie need not be level on the night).
 */
function scoreSemanticsGate(state: string, scores: unknown[]): ScoreSemantics {
  const result = (gate: PilotGate, cumulativeSecondHalfDiscriminated = false): ScoreSemantics => ({
    gate,
    cumulativeSecondHalfDiscriminated,
  });
  const firstHalf = scorePair(scores, "1ST_HALF");
  const secondHalf = scorePair(scores, "2ND_HALF");
  const current = scorePair(scores, "CURRENT");
  if (firstHalf.conflict || secondHalf.conflict || current.conflict) {
    return result(fail("A score pair carries two different values for the same side."));
  }
  const fh = firstHalf.pair;
  const sh = secondHalf.pair;
  const cur = current.pair;
  const exceeds = (low: typeof fh, high: typeof fh) => low !== null && high !== null && (low.home > high.home || low.away > high.away);
  if (state === "FT") {
    if (!sh && !cur) return result(fail("FT fixture exposes neither a 2ND_HALF nor a CURRENT score pair."));
    if (exceeds(fh, sh) || exceeds(fh, cur)) return result(fail("FT 1ST_HALF score exceeds the full-time score; goals cannot decrease."));
    if (!sh || !cur) {
      return result(unverified(`FT exposes only ${sh ? "2ND_HALF" : "CURRENT"}; cumulative 2ND_HALF semantics are not discriminated.`));
    }
    if (sh.home !== cur.home || sh.away !== cur.away) return result(fail("FT 2ND_HALF and CURRENT scores disagree."));
    if (fh && (fh.home > 0 || fh.away > 0)) {
      return result(pass("FT has equal 2ND_HALF and CURRENT scores after a scoring first half, so 2ND_HALF is cumulative."), true);
    }
    return result(
      pass(
        `FT has equal 2ND_HALF and CURRENT scores; ${fh ? "a 0-0 first half" : "without a 1ST_HALF pair the fixture"} does not discriminate a cumulative 2ND_HALF on its own.`,
      ),
    );
  }
  if (state === "AET" || state === "FT_PEN") {
    if (!sh || !cur) return result(fail(`${state} requires both the 90-minute 2ND_HALF and the after-extra-time CURRENT score pairs.`));
    if (exceeds(fh, sh)) return result(fail(`${state} 1ST_HALF score exceeds the 90-minute 2ND_HALF score; goals cannot decrease.`));
    if (exceeds(sh, cur)) return result(fail(`${state} CURRENT score is lower than the cumulative 90-minute 2ND_HALF score.`));
    if (state === "FT_PEN") {
      return result(unverified("FT_PEN: whether CURRENT excludes the penalty shootout cannot be discriminated from the score pairs."));
    }
    if (sh.home === cur.home && sh.away === cur.away) {
      return result(unverified("AET without an extra-time goal: whether 2ND_HALF excludes extra time is not discriminated."));
    }
    return result(pass("AET: extra-time goals separate the 90-minute 2ND_HALF from the after-extra-time CURRENT."));
  }
  return result(unverified(`Fixture state ${state || "unknown"} is not a finished pilot state.`));
}

export function auditSportmonksA2BCapture(capture: SportmonksLedgerCaptureV1): SportmonksA2BFixtureAudit {
  const sides = sideByParticipant(capture);
  const locations = capture.fixture.participants
    .map((participant) => participant.meta?.location)
    .filter((value): value is string => typeof value === "string")
    .sort();

  const participantLocations =
    capture.fixture.participants.length === 2 && locations.join(",") === "away,home" && sides.size === 2
      ? pass("Exactly one home and one away participant with distinct provider ids.")
      : fail(`Expected exactly one home and one away participant; observed ${locations.join(",") || "none"}.`);

  const score = scoreSemanticsGate(capture.fixture.state?.developer_name ?? "", capture.fixture.scores as unknown[]);
  const scoreSemantics = score.gate;

  const lineupRows = capture.families.lineups.rows.filter(isRecord);
  const lineupTypeIds = [
    ...new Set(lineupRows.map((row) => (typeof row.type_id === "number" && Number.isInteger(row.type_id) ? row.type_id : null)).filter((value): value is number => value !== null)),
  ].sort((a, b) => a - b);
  const unknownLineupTypes = lineupTypeIds.filter((id) => !(EXPECTED_LINEUP_TYPES as readonly number[]).includes(id));
  const starterCounts = { home: 0, away: 0 };
  const benchCounts = { home: 0, away: 0 };
  const seenPlayers = new Set<string>();
  let lineupUnknownTeam = false;
  let duplicatePlayer = false;
  for (const row of lineupRows) {
    const playerId = asProviderId(row.player_id);
    if (playerId) {
      if (seenPlayers.has(playerId)) duplicatePlayer = true;
      seenPlayers.add(playerId);
    }
    const teamId = asProviderId(row.team_id);
    const side = teamId ? sides.get(teamId) : undefined;
    if (!side) {
      lineupUnknownTeam = true;
      continue;
    }
    if (row.type_id === 11) starterCounts[side] += 1;
    if (row.type_id === 12) benchCounts[side] += 1;
  }

  // PR #30 semantics, kept: a returned lineup must discriminate 11 starters
  // (type 11) and bench rows (type 12) on both sides.
  const lineupTypes: PilotGate =
    lineupUnknownTeam || unknownLineupTypes.length > 0
      ? fail(`Unexpected lineup team/type ids: ${unknownLineupTypes.join(",") || "unknown participant"}.`)
      : lineupRows.length === 0
        ? unverified("No lineup rows were returned.")
        : starterCounts.home === 11 && starterCounts.away === 11 && benchCounts.home > 0 && benchCounts.away > 0
          ? pass("Both teams expose exactly 11 type_id=11 starters and one or more type_id=12 bench players.")
          : fail(
              `Expected 11 starters and bench rows per side; observed starters ${starterCounts.home}/${starterCounts.away}, bench ${benchCounts.home}/${benchCounts.away}.`,
            );

  const lineupParticipants: PilotGate =
    lineupRows.length === 0
      ? unverified("No lineup rows were returned.")
      : lineupUnknownTeam || duplicatePlayer
        ? fail(`Lineup integrity failure: unknownTeam=${lineupUnknownTeam}, duplicatePlayer=${duplicatePlayer}.`)
        : pass("All lineup rows belong to fixture participants and provider player ids are unique.");

  const positionIds = [
    ...new Set(lineupRows.map((row) => (typeof row.position_id === "number" && Number.isInteger(row.position_id) ? row.position_id : null)).filter((value): value is number => value !== null)),
  ].sort((a, b) => a - b);
  const unknownPositions = positionIds.filter((id) => !(EXPECTED_POSITIONS as readonly number[]).includes(id));
  const broadPositions: PilotGate =
    unknownPositions.length > 0
      ? fail(`Unexpected broad position ids: ${unknownPositions.join(",")}.`)
      : positionIds.length === 0
        ? unverified("No broad position ids were observed.")
        : EXPECTED_POSITIONS.every((id) => positionIds.includes(id))
          ? pass("Observed all broad position ids 24/25/26/27 and nothing else.")
          : unverified(`Observed only ${positionIds.join(",")}; not all of 24/25/26/27.`);

  const formationRows = capture.families.formations.rows.filter(isRecord);
  let invalidFormation = false;
  const formationSides = new Set<"home" | "away">();
  for (const row of formationRows) {
    const participantId = asProviderId(row.participant_id);
    const side = participantId ? sides.get(participantId) : undefined;
    if (!side || typeof row.formation !== "string" || !FORMATION_PATTERN.test(row.formation)) {
      invalidFormation = true;
      continue;
    }
    formationSides.add(side);
  }
  const formationSemantics: PilotGate =
    formationRows.length === 0
      ? unverified("No formation rows were returned.")
      : invalidFormation
        ? fail("Formation rows contain an unknown participant or an invalid formation string.")
        : formationSides.size === 2
          ? pass("Valid nominal formations were returned for both participants.")
          : unverified("Valid formation data was returned for only one participant.");

  const values = valuesBySideAndType(capture, sides);
  const possession = (["home", "away"] as const).map((side) => values.get(`${side}:45`) ?? null);
  const possessionTotal = possession[0] !== null && possession[1] !== null ? possession[0] + possession[1] : null;
  const possessionSum: PilotGate =
    possessionTotal === null
      ? unverified("Possession was not present for both sides.")
      : possessionTotal >= 98 && possessionTotal <= 102
        ? pass(`Possession sums to ${possessionTotal}.`)
        : fail(`Possession sums to ${possessionTotal}, outside 98-102.`);

  const shotsOnTarget = relationGate(
    (["home", "away"] as const).map((side) => {
      const total = values.get(`${side}:42`);
      const onTarget = values.get(`${side}:86`);
      return total === undefined || onTarget === undefined ? null : onTarget <= total;
    }),
    "Observed shots_on_target <= shots_total.",
    "Observed shots_on_target > shots_total.",
    "Could not compare shots_on_target with shots_total.",
  );

  const nonPenaltyXg = relationGate(
    (["home", "away"] as const).map((side) => {
      const xg = values.get(`${side}:5304`);
      const npxg = values.get(`${side}:7943`);
      return xg === undefined || npxg === undefined ? null : npxg <= xg + 1e-9;
    }),
    "Observed non-penalty xG <= xG.",
    "Observed non-penalty xG > xG.",
    "Could not compare non-penalty xG with xG.",
  );

  const presentKeys = new Set<string>();
  const presentAllowlistedStatTypes = new Set<string>();
  const explicitZeroStatTypes = new Set<string>();
  for (const row of statRows(capture)) {
    const team = asProviderId(row.participant_id);
    const side = team ? sides.get(team) : undefined;
    const typeId = asProviderId(row.type_id);
    if (!side || !typeId || !ALLOWLISTED_STAT_TYPE_SET.has(typeId)) continue;
    presentKeys.add(`${side}:${typeId}`);
    presentAllowlistedStatTypes.add(typeId);
    if (asFiniteNumber(isRecord(row.data) ? row.data.value : undefined) === 0) explicitZeroStatTypes.add(typeId);
  }
  const omittedAllowlistedStatTypes = new Set<string>();
  for (const side of ["home", "away"] as const) {
    for (const typeId of ALLOWLISTED_STAT_TYPES) if (!presentKeys.has(`${side}:${typeId}`)) omittedAllowlistedStatTypes.add(typeId);
  }

  return {
    providerFixtureId: String(capture.fixture.id),
    providerLeagueId: String(capture.fixture.league_id),
    providerSeasonId: String(capture.fixture.season_id),
    gates: {
      participantLocations,
      scoreSemantics,
      lineupTypes,
      lineupParticipants,
      broadPositions,
      formationSemantics,
      possessionSum,
      shotsOnTarget,
      nonPenaltyXg,
    },
    observed: {
      familyRows: Object.fromEntries(
        PROVIDER_DATA_FAMILIES.map((family) => [family, capture.families[family].rows.length]),
      ) as Record<ProviderDataFamily, number>,
      lineupTypeIds,
      positionIds,
      lineupStarterCounts: starterCounts,
      lineupBenchCounts: benchCounts,
      explicitZeroStatTypes: [...explicitZeroStatTypes].sort(compareProviderIds),
      omittedAllowlistedStatTypes: [...omittedAllowlistedStatTypes].sort(compareProviderIds),
      presentAllowlistedStatTypes: [...presentAllowlistedStatTypes].sort(compareProviderIds),
      cumulativeSecondHalfDiscriminated: score.cumulativeSecondHalfDiscriminated,
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence summaries: strict, never pooled
// ---------------------------------------------------------------------------

export type GateEvidence = {
  status: PilotGateStatus;
  passFixtures: number;
  failFixtures: number;
  unverifiedFixtures: number;
};

function summarizeOneGate(audits: readonly SportmonksA2BFixtureAudit[], name: SportmonksA2BGateName): GateEvidence {
  const statuses = audits.map((audit) => audit.gates[name].status);
  const passFixtures = statuses.filter((status) => status === "pass").length;
  const failFixtures = statuses.filter((status) => status === "fail").length;
  const unverifiedFixtures = statuses.filter((status) => status === "unverified").length;
  // Any contradiction fails; pass + unverified stays unverified.
  const status: PilotGateStatus = failFixtures > 0 ? "fail" : passFixtures > 0 && unverifiedFixtures === 0 ? "pass" : "unverified";
  return { status, passFixtures, failFixtures, unverifiedFixtures };
}

export function summarizeSportmonksA2BGateEvidence(
  audits: readonly SportmonksA2BFixtureAudit[],
): Record<SportmonksA2BGateName, GateEvidence> {
  return Object.fromEntries(SPORTMONKS_A2B_GATE_NAMES.map((name) => [name, summarizeOneGate(audits, name)])) as Record<
    SportmonksA2BGateName,
    GateEvidence
  >;
}

export type SportmonksA2BContradiction = { fixtureId: string; gate: SportmonksA2BGateName; detail: string };

function contradictionsOf(audits: readonly SportmonksA2BFixtureAudit[]): SportmonksA2BContradiction[] {
  return audits.flatMap((audit) =>
    SPORTMONKS_A2B_GATE_NAMES.flatMap((gate) =>
      audit.gates[gate].status === "fail" ? [{ fixtureId: audit.providerFixtureId, gate, detail: audit.gates[gate].detail }] : [],
    ),
  );
}

export type SportmonksA2BProviderSemantics = {
  status: PilotGateStatus;
  blockers: string[];
  gateEvidence: Record<SportmonksA2BGateName, GateEvidence>;
  lineupTypeIds: number[];
  positionIds: number[];
  /** FT fixtures whose scoring first half discriminated a cumulative 2ND_HALF. */
  cumulativeSecondHalfDiscriminatingFixtures: number;
};

/**
 * Provider-wide semantics are evidence about field meanings only: not a
 * per-competition coverage signal and not backfill approval. A field meaning
 * counts as verified only when some fixture discriminated it: a sample made
 * only of 0-0 first halves leaves cumulative 2ND_HALF unproven.
 */
export function summarizeSportmonksA2BProviderSemantics(
  audits: readonly SportmonksA2BFixtureAudit[],
): SportmonksA2BProviderSemantics {
  const gateEvidence = summarizeSportmonksA2BGateEvidence(audits);
  const lineupTypeIds = [...new Set(audits.flatMap((audit) => audit.observed.lineupTypeIds))].sort((a, b) => a - b);
  const positionIds = [...new Set(audits.flatMap((audit) => audit.observed.positionIds))].sort((a, b) => a - b);
  const blockers: string[] = [];

  if (audits.length === 0) blockers.push("no audited fixtures");
  for (const name of SPORTMONKS_A2B_GATE_NAMES) {
    if (gateEvidence[name].failFixtures > 0) blockers.push(`${name} has contradictory observations`);
  }
  if (gateEvidence.participantLocations.unverifiedFixtures > 0) {
    blockers.push("participant location semantics are unverified on one or more sampled fixtures");
  }
  if (gateEvidence.scoreSemantics.unverifiedFixtures > 0) {
    blockers.push("finished-score semantics are unverified on one or more sampled fixtures");
  }
  const cumulativeSecondHalfDiscriminatingFixtures = audits.filter((audit) => audit.observed.cumulativeSecondHalfDiscriminated).length;
  if (audits.length > 0 && cumulativeSecondHalfDiscriminatingFixtures === 0) {
    blockers.push("no sampled FT fixture discriminated cumulative 2ND_HALF semantics (every first half was 0-0 or had no 1ST_HALF pair)");
  }
  const unknownLineupTypes = lineupTypeIds.filter((id) => !(EXPECTED_LINEUP_TYPES as readonly number[]).includes(id));
  if (unknownLineupTypes.length > 0) blockers.push(`unknown lineup type ids: ${unknownLineupTypes.join(",")}`);
  if (!EXPECTED_LINEUP_TYPES.every((id) => lineupTypeIds.includes(id))) {
    blockers.push("provider-wide sample did not discriminate both lineup type ids 11/12");
  }
  const unknownPositions = positionIds.filter((id) => !(EXPECTED_POSITIONS as readonly number[]).includes(id));
  if (unknownPositions.length > 0) blockers.push(`unknown broad position ids: ${unknownPositions.join(",")}`);
  if (!EXPECTED_POSITIONS.every((id) => positionIds.includes(id))) {
    blockers.push("provider-wide sample did not cover broad position ids 24/25/26/27");
  }

  return {
    status: blockers.length > 0 ? "fail" : "pass",
    blockers,
    gateEvidence,
    lineupTypeIds,
    positionIds,
    cumulativeSecondHalfDiscriminatingFixtures,
  };
}

export type SportmonksA2BFamilyCoverage = {
  fetchedFixtures: number;
  nonEmptyFixtures: number;
  totalRows: number;
  /** null when nothing was sampled: no evidence is not 0% coverage. */
  coverageRatio: number | null;
};

function familyCoverage(audits: readonly SportmonksA2BFixtureAudit[]): Record<ProviderDataFamily, SportmonksA2BFamilyCoverage> {
  return Object.fromEntries(
    PROVIDER_DATA_FAMILIES.map((family) => {
      const rowCounts = audits.map((audit) => audit.observed.familyRows[family]);
      const nonEmptyFixtures = rowCounts.filter((rows) => rows > 0).length;
      return [
        family,
        {
          fetchedFixtures: audits.length,
          nonEmptyFixtures,
          totalRows: rowCounts.reduce((sum, rows) => sum + rows, 0),
          coverageRatio: audits.length === 0 ? null : Number((nonEmptyFixtures / audits.length).toFixed(4)),
        },
      ];
    }),
  ) as Record<ProviderDataFamily, SportmonksA2BFamilyCoverage>;
}

function statTypeCoverage(audits: readonly SportmonksA2BFixtureAudit[]): Record<string, { fixturesPresent: number; fixturesExplicitZero: number }> {
  return Object.fromEntries(
    ALLOWLISTED_STAT_TYPES.map((typeId) => [
      typeId,
      {
        fixturesPresent: audits.filter((audit) => audit.observed.presentAllowlistedStatTypes.includes(typeId)).length,
        fixturesExplicitZero: audits.filter((audit) => audit.observed.explicitZeroStatTypes.includes(typeId)).length,
      },
    ]),
  );
}

export type SportmonksA2BCompetitionProfile = {
  providerLeagueId: string;
  fixtures: number;
  seasonsObserved: string[];
  gateEvidence: Record<SportmonksA2BGateName, GateEvidence>;
  familyCoverage: Record<ProviderDataFamily, SportmonksA2BFamilyCoverage>;
  statTypeCoverage: Record<string, { fixturesPresent: number; fixturesExplicitZero: number }>;
  completeLineupFixtures: number;
  lineupTypeIds: number[];
  positionIds: number[];
  contradictions: SportmonksA2BContradiction[];
};

/** Coverage of exactly one competition: audits of any other league are ignored. */
export function buildSportmonksA2BCompetitionProfile(
  providerLeagueId: string,
  audits: readonly SportmonksA2BFixtureAudit[],
): SportmonksA2BCompetitionProfile {
  const own = audits.filter((audit) => audit.providerLeagueId === providerLeagueId);
  return {
    providerLeagueId,
    fixtures: own.length,
    seasonsObserved: [...new Set(own.map((audit) => audit.providerSeasonId))].sort(compareProviderIds),
    gateEvidence: summarizeSportmonksA2BGateEvidence(own),
    familyCoverage: familyCoverage(own),
    statTypeCoverage: statTypeCoverage(own),
    completeLineupFixtures: own.filter((audit) => audit.gates.lineupTypes.status === "pass").length,
    lineupTypeIds: [...new Set(own.flatMap((audit) => audit.observed.lineupTypeIds))].sort((a, b) => a - b),
    positionIds: [...new Set(own.flatMap((audit) => audit.observed.positionIds))].sort((a, b) => a - b),
    contradictions: contradictionsOf(own),
  };
}

export type SportmonksA2BSampleResult = {
  providerFixtureId: string;
  parseStatus: "pass" | "fail";
  /** null when no capture could be built (detail missing or identity drift). */
  audit: SportmonksA2BFixtureAudit | null;
};

export type SportmonksA2BSeasonProfile = {
  providerLeagueId: string;
  providerSeasonId: string;
  seasonName: string | null;
  sampleReasons: Array<"most_recent" | "required">;
  requestedFixtures: number;
  sampledFixtures: number;
  auditedFixtures: number;
  parsePasses: number;
  parseFailures: number;
  gateEvidence: Record<SportmonksA2BGateName, GateEvidence>;
  familyCoverage: Record<ProviderDataFamily, SportmonksA2BFamilyCoverage>;
  completeLineupFixtures: number;
  pairedFormationFixtures: number;
  contradictions: SportmonksA2BContradiction[];
  blockers: string[];
  /** Evidence about this one season's sample; never backfill approval. */
  seasonSampleStatus: "sample_clean" | "blocked";
};

/**
 * Profile of one sampled season. Results whose audit belongs to another
 * league, season or fixture are refused: a season never inherits another's
 * evidence. A fixture sampled twice blocks instead of counting twice.
 */
export function buildSportmonksA2BSeasonProfile(input: {
  providerLeagueId: string;
  providerSeasonId: string;
  seasonName: string | null;
  sampleReasons: Array<"most_recent" | "required">;
  requestedFixtures: number;
  results: readonly SportmonksA2BSampleResult[];
}): SportmonksA2BSeasonProfile {
  for (const result of input.results) {
    if (result.audit && (result.audit.providerLeagueId !== input.providerLeagueId || result.audit.providerSeasonId !== input.providerSeasonId)) {
      throw new Error(
        `season profile ${input.providerLeagueId}:${input.providerSeasonId} received fixture ${result.providerFixtureId} of ${result.audit.providerLeagueId}:${result.audit.providerSeasonId}`,
      );
    }
    if (result.audit && result.audit.providerFixtureId !== result.providerFixtureId) {
      throw new Error(
        `season profile ${input.providerLeagueId}:${input.providerSeasonId} sample ${result.providerFixtureId} carries the audit of fixture ${result.audit.providerFixtureId}`,
      );
    }
  }
  const audits = input.results.flatMap((result) => (result.audit ? [result.audit] : []));
  const gateEvidence = summarizeSportmonksA2BGateEvidence(audits);
  const contradictions = contradictionsOf(audits);
  const parseFailures = input.results.filter((result) => result.parseStatus === "fail").length;
  const sampledIds = input.results.map((result) => result.providerFixtureId);
  const duplicateIds = [...new Set(sampledIds.filter((id, index) => sampledIds.indexOf(id) !== index))].sort(compareProviderIds);
  const blockers: string[] = [];
  if (input.results.length < input.requestedFixtures) {
    blockers.push(`sampled ${input.results.length} of ${input.requestedFixtures} requested finished fixtures`);
  }
  if (duplicateIds.length > 0) blockers.push(`fixture(s) sampled more than once: ${duplicateIds.join(",")}`);
  if (parseFailures > 0) blockers.push(`${parseFailures} fixture(s) failed capture or parse`);
  if (contradictions.length > 0) blockers.push(`${contradictions.length} contradictory gate observation(s)`);
  if (gateEvidence.participantLocations.status !== "pass") blockers.push("participant locations not verified on every sampled fixture");
  if (gateEvidence.scoreSemantics.status !== "pass") blockers.push("finished-score semantics not verified on every sampled fixture");

  return {
    providerLeagueId: input.providerLeagueId,
    providerSeasonId: input.providerSeasonId,
    seasonName: input.seasonName,
    sampleReasons: [...input.sampleReasons],
    requestedFixtures: input.requestedFixtures,
    sampledFixtures: input.results.length,
    auditedFixtures: audits.length,
    parsePasses: input.results.filter((result) => result.parseStatus === "pass").length,
    parseFailures,
    gateEvidence,
    familyCoverage: familyCoverage(audits),
    completeLineupFixtures: audits.filter((audit) => audit.gates.lineupTypes.status === "pass").length,
    pairedFormationFixtures: audits.filter((audit) => audit.gates.formationSemantics.status === "pass").length,
    contradictions,
    blockers,
    seasonSampleStatus: blockers.length === 0 ? "sample_clean" : "blocked",
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type SportmonksA2BBlockingError = { code: string } & Record<string, unknown>;

export type SportmonksA2BRawIndexEntry = {
  sha256: string;
  endpoint: string;
  status: number;
  contentType: string | null;
  bytes: number;
};

export type SportmonksA2BLeagueReport = {
  target: SportmonksTargetLeague;
  identity: SportmonksA2BLeagueIdentity;
  leagueDetailRawSha256: string | null;
  sampledSeasons: SportmonksA2BSeasonProfile[];
  competitionProfile: SportmonksA2BCompetitionProfile;
};

export type SportmonksA2BPilotReport = ReturnType<typeof buildSportmonksA2BPilotReport>;

/**
 * Assembles pilot-report.json. The approval and identity-readiness fields are
 * constants, not inputs: no evidence, however clean, turns the A2-B report
 * into backfill approval, an ingest allowance or a team identity verdict.
 */
export function buildSportmonksA2BPilotReport(input: {
  generatedAt: string;
  capturedAt: string;
  config: {
    seasonsPerLeague: number;
    fixturesPerSeason: number;
    requiredSeasons: readonly SportmonksA2BRequiredSeason[];
    entitlementPageCap: number;
    perPage: number;
  };
  entitlement: {
    source: string;
    competitionCount: number;
    snapshotSha256: string;
    detailsSha256: string;
    rawPageSha256: readonly string[];
  };
  leagues: readonly SportmonksA2BLeagueReport[];
  providerSemantics: SportmonksA2BProviderSemantics;
  blockingErrors: readonly SportmonksA2BBlockingError[];
  rawResponseIndex: readonly SportmonksA2BRawIndexEntry[];
  captureCount: number;
}) {
  const blockingErrors = [...input.blockingErrors];
  if (input.providerSemantics.status !== "pass" && !blockingErrors.some((error) => error.code === "provider_semantics_failed")) {
    blockingErrors.push({ code: "provider_semantics_failed", blockers: [...input.providerSemantics.blockers] });
  }
  return {
    contract_version: SPORTMONKS_A2B_PILOT_REPORT_VERSION,
    generatedAt: input.generatedAt,
    capturedAt: input.capturedAt,
    provider: "sportmonks" as const,
    purpose: "a2b_provider_semantics_and_history_pilot" as const,
    evidenceStatus: (blockingErrors.length === 0 ? "clean" : "blocked") as "clean" | "blocked",
    backfillApproval: {
      approved: false as const,
      reason:
        "A2-B verifies provider semantics, competition identity and scoped family coverage only. Backfill approval is a separate reviewed decision; no A2-B result creates a provider_ingest_run, grants ingest, mints a fixture or writes a Match Ledger observation.",
    },
    teamIdentityReadiness: {
      assessed: false as const,
      reason:
        "A2-B does not read or change team identity. Team mapping/attestation completeness comes from the D-058 readiness reports and the onboarding records; a sampled fixture between unattested teams is not evidence that their identities are ready.",
    },
    fixtureMint: {
      allowed: false as const,
      parserPolicy: SPORTMONKS_A2B_PARSER_FIXTURE_MINT,
      note: "A2-B never mints and records no run mint bound; a later reviewed ingest run derives its own bound with fixtureMintKickoffBefore.",
    },
    config: {
      seasonsPerLeague: input.config.seasonsPerLeague,
      fixturesPerSeason: input.config.fixturesPerSeason,
      requiredSeasons: input.config.requiredSeasons.map((season) => ({ ...season })),
      entitlementPageCap: input.config.entitlementPageCap,
      perPage: input.config.perPage,
    },
    entitlement: { ...input.entitlement, rawPageSha256: [...input.entitlement.rawPageSha256] },
    note:
      "No pooled global PASS is emitted. Provider-wide field semantics, competition identity and per-competition/per-season coverage are separate. explicitZero is reported as coverage only. Missing optional families stay missing.",
    providerSemantics: input.providerSemantics,
    leagues: input.leagues.map((league) => ({ ...league })),
    blockingErrors,
    captureCount: input.captureCount,
    rawResponseIndex: input.rawResponseIndex.map((entry) => ({ ...entry })),
  };
}
