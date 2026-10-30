import {
  CAPTURE_MODES,
  FORMATION_PATTERN,
  type CaptureMode,
  type DataStatus,
  type LineupRole,
  type MatchStatus,
  type PositionCode,
  type TeamSide,
} from "./match-ledger";
import {
  FAMILY_FETCH_STATUSES,
  PROVIDER_DATA_FAMILIES,
  type CaptureQualityFlag,
  type FamilyFetchStatus,
  type FixtureMintPolicy,
  type ProviderDataFamily,
  type ProviderMatchObservation,
  type ProviderObservationPlayer,
  type ProviderObservationStat,
  type ProviderStatFamily,
} from "./provider-ingest";
import {
  SPORTMONKS_LEDGER_CAPTURE_CONTRACT_VERSION,
  SPORTMONKS_LEDGER_MAPPING_VERSION,
  SPORTMONKS_STAT_DEFINITION_VERSION,
} from "./versions";

/**
 * Sportmonks capture -> provider match observation
 * (kapiloto-sportmonks-ledger-mapping-v1). Pure and offline: the capture is
 * produced by an operator-run fetch (A2-B); this module never calls a
 * provider and never computes raw_payload_sha256 (only the capturer holds
 * the raw response bytes).
 *
 * Missingness is explicit. Each data family carries a fetch status; an empty
 * row list never means "provided". Stats are kept only from fetched families
 * and only for allow-listed type ids. Every allow-listed row must carry the
 * verified type.developer_name and a valid value: a different name
 * (stat_type_drift), a missing name or type include
 * (stat_type_metadata_missing) or an invalid value (stat_value_invalid) fails
 * the whole capture, so provider contract drift can never surface later as
 * ordinary missing data. Matches that went to extra time carry no team stats
 * (Sportmonks reports them for the whole match, not separable into 90
 * minutes), but their rows are still validated.
 */

/** Verified Sportmonks v3 type ids (fixture statistics and expected-value references). */
export const SPORTMONKS_LEDGER_STAT_TYPES = [
  { typeId: "5304", developerName: "EXPECTED_GOALS", statKey: "expected_goals", family: "xg", unit: "expected_goals" },
  { typeId: "5305", developerName: "EXPECTED_GOALS_ON_TARGET", statKey: "expected_goals_on_target", family: "xg", unit: "expected_goals" },
  { typeId: "7943", developerName: "EXPECTED_NON_PENALTY_GOALS", statKey: "expected_non_penalty_goals", family: "xg", unit: "expected_goals" },
  { typeId: "42", developerName: "SHOTS_TOTAL", statKey: "shots_total", family: "statistics", unit: "count" },
  { typeId: "86", developerName: "SHOTS_ON_TARGET", statKey: "shots_on_target", family: "statistics", unit: "count" },
  { typeId: "45", developerName: "BALL_POSSESSION", statKey: "possession_pct", family: "statistics", unit: "percent" },
  { typeId: "34", developerName: "CORNERS", statKey: "corners", family: "statistics", unit: "count" },
] as const satisfies ReadonlyArray<{
  typeId: string;
  developerName: string;
  statKey: string;
  family: ProviderStatFamily;
  unit: "expected_goals" | "count" | "percent";
}>;

/** Sportmonks fixture state developer_name -> canonical match status. */
export const SPORTMONKS_STATE_MAP: Readonly<Record<string, MatchStatus>> = {
  NS: "upcoming",
  TBA: "upcoming",
  DELAYED: "upcoming",
  INPLAY_1ST_HALF: "live",
  INPLAY_2ND_HALF: "live",
  BREAK: "live",
  INPLAY_ET: "live",
  INPLAY_ET_2ND_HALF: "live",
  EXTRA_TIME_BREAK: "live",
  INPLAY_PENALTIES: "live",
  PEN_BREAK: "live",
  HT: "halftime",
  FT: "finished",
  AET: "finished",
  FT_PEN: "finished",
  POSTPONED: "postponed",
  SUSPENDED: "suspended",
  INTERRUPTED: "suspended",
  CANCELLED: "cancelled",
  ABANDONED: "cancelled",
  // Not a field result: settlement-type outcomes are never "finished".
  AWARDED: "under_review",
  WO: "under_review",
  AWAITING_UPDATES: "under_review",
  PENDING: "under_review",
  DELETED: "under_review",
};

const SPORTMONKS_LINEUP_STARTER = 11;
const SPORTMONKS_LINEUP_BENCH = 12;
const SPORTMONKS_POSITIONS: Readonly<Record<number, PositionCode>> = { 24: "GK", 25: "DF", 26: "MF", 27: "FW" };

export type SportmonksLedgerFamilyCapture = {
  fetch_status: FamilyFetchStatus;
  /** Raw rows of the family; must be empty unless fetch_status is fetched. */
  rows: unknown[];
  raw_response_sha256: string | null;
};

export type SportmonksCapturedScore = {
  participant_id?: number | string;
  description: string;
  score: { goals: number; participant: "home" | "away" };
};

export type SportmonksCapturedFixture = {
  id: number | string;
  league_id: number | string;
  season_id: number | string;
  starting_at_timestamp?: number | null;
  starting_at?: string | null;
  state?: { developer_name?: string | null } | null;
  participants: Array<{ id: number | string; name?: string | null; meta?: { location?: string | null } | null }>;
  scores: SportmonksCapturedScore[];
  /** Only when the provider payload states it explicitly; otherwise unknown. */
  neutral_venue?: boolean | null;
};

export type SportmonksLedgerCaptureV1 = {
  contract_version: typeof SPORTMONKS_LEDGER_CAPTURE_CONTRACT_VERSION;
  captured_at: string;
  capture_mode: CaptureMode;
  provider_endpoint: string | null;
  /** SHA-256 of the single raw response body this capture was parsed from, or null. */
  raw_payload_sha256: string | null;
  fixture: SportmonksCapturedFixture;
  families: Record<ProviderDataFamily, SportmonksLedgerFamilyCapture>;
};

export const SPORTMONKS_PARSE_ERROR_CODES = [
  "capture_invalid",
  "family_invalid",
  "family_rows_without_fetch",
  "raw_payload_sha256_invalid",
  "fixture_ref_invalid",
  "participants_invalid",
  "kickoff_unavailable",
  "state_unavailable",
  "state_unknown",
  "score_duplicate",
  "score_90_unavailable",
  "score_inconsistent",
  "extra_time_score_unavailable",
  "lineup_row_invalid",
  "lineup_team_unknown",
  "lineup_duplicate_player",
  "lineup_too_many_starters",
  "formation_row_invalid",
  "stat_row_invalid",
  "stat_team_unknown",
  "stat_type_metadata_missing",
  "stat_type_drift",
  "stat_value_invalid",
  "stat_duplicate_conflict",
] as const;
export type SportmonksParseErrorCode = (typeof SPORTMONKS_PARSE_ERROR_CODES)[number];

export class SportmonksLedgerParseError extends Error {
  readonly code: SportmonksParseErrorCode;
  constructor(code: SportmonksParseErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SportmonksLedgerParseError";
    this.code = code;
  }
}

export type ParsedSportmonksLedgerCapture = {
  observation: ProviderMatchObservation;
  /** Same as observation.captureQualityFlags: sorted, recoverable, audit only. */
  flags: CaptureQualityFlag[];
};

const SHA256 = /^[0-9a-f]{64}$/;
const FORMATION_FIELD = /^[0-9]{1,2}:[0-9]{1,2}$/;

const fail = (code: SportmonksParseErrorCode, message: string): never => {
  throw new SportmonksLedgerParseError(code, message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function providerRef(value: unknown, code: SportmonksParseErrorCode, label: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  return fail(code, `${label} must be a positive provider id`);
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 160);
}

function kickoffIso(fixture: SportmonksCapturedFixture): string {
  if (typeof fixture.starting_at_timestamp === "number" && Number.isSafeInteger(fixture.starting_at_timestamp) && fixture.starting_at_timestamp > 0) {
    return new Date(fixture.starting_at_timestamp * 1000).toISOString();
  }
  // Sportmonks starting_at is UTC "YYYY-MM-DD HH:MM:SS".
  if (typeof fixture.starting_at === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(fixture.starting_at)) {
    const parsed = Date.parse(`${fixture.starting_at.replace(" ", "T")}Z`);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return fail("kickoff_unavailable", "fixture has no usable starting_at_timestamp or starting_at");
}

type ScorePair = { home: number; away: number };

function scorePairs(scores: unknown): Map<string, ScorePair> {
  if (!Array.isArray(scores)) return fail("capture_invalid", "fixture.scores must be an array");
  const partial = new Map<string, { home?: number; away?: number }>();
  for (const row of scores) {
    if (!isRecord(row) || typeof row.description !== "string" || !isRecord(row.score)) continue;
    const side = row.score.participant;
    const goals = row.score.goals;
    if ((side !== "home" && side !== "away") || typeof goals !== "number" || !Number.isInteger(goals) || goals < 0 || goals > 99) continue;
    // PENALTY_SHOOTOUT is an alias of PENALTIES.
    const description = row.description.toUpperCase() === "PENALTY_SHOOTOUT" ? "PENALTIES" : row.description.toUpperCase();
    const entry = partial.get(description) ?? {};
    if (entry[side] !== undefined) {
      if (entry[side] !== goals) fail("score_duplicate", `conflicting ${description} ${side} scores`);
      continue;
    }
    entry[side] = goals;
    partial.set(description, entry);
  }
  const pairs = new Map<string, ScorePair>();
  for (const [description, entry] of partial) {
    if (entry.home !== undefined && entry.away !== undefined) pairs.set(description, { home: entry.home, away: entry.away });
  }
  return pairs;
}

function familyCapture(capture: SportmonksLedgerCaptureV1, family: ProviderDataFamily): SportmonksLedgerFamilyCapture {
  const value = capture.families?.[family];
  if (!isRecord(value)) return fail("family_invalid", `family ${family} is missing`);
  if (!(FAMILY_FETCH_STATUSES as readonly string[]).includes(value.fetch_status as string)) fail("family_invalid", `family ${family} has no valid fetch_status`);
  if (!Array.isArray(value.rows)) fail("family_invalid", `family ${family} rows must be an array`);
  if (value.raw_response_sha256 !== null && !(typeof value.raw_response_sha256 === "string" && SHA256.test(value.raw_response_sha256))) {
    fail("family_invalid", `family ${family} raw_response_sha256 must be a lowercase SHA-256 or null`);
  }
  const rows = value.rows as unknown[];
  if (value.fetch_status !== "fetched" && rows.length > 0) fail("family_rows_without_fetch", `family ${family} has rows but was not fetched`);
  return value as SportmonksLedgerFamilyCapture;
}

/**
 * Parses one captured Sportmonks fixture bundle. Throws
 * SportmonksLedgerParseError (with a closed code) on malformed captures; the
 * caller records that as a 'failed' ingest item. Data-quality issues that do
 * not make the capture ambiguous become flags.
 */
export function parseSportmonksLedgerCapture(
  capture: SportmonksLedgerCaptureV1,
  options: { fixtureMint: FixtureMintPolicy; runId: string | null },
): ParsedSportmonksLedgerCapture {
  if (!isRecord(capture) || capture.contract_version !== SPORTMONKS_LEDGER_CAPTURE_CONTRACT_VERSION) {
    fail("capture_invalid", "unsupported Sportmonks ledger capture contract");
  }
  if (typeof capture.captured_at !== "string" || Number.isNaN(Date.parse(capture.captured_at)) || !/^\d{4}-\d{2}-\d{2}T/.test(capture.captured_at)) {
    fail("capture_invalid", "captured_at must be an ISO instant");
  }
  if (!(CAPTURE_MODES as readonly string[]).includes(capture.capture_mode)) fail("capture_invalid", "invalid capture_mode");
  if (capture.provider_endpoint !== null && (typeof capture.provider_endpoint !== "string" || capture.provider_endpoint.length > 200)) {
    fail("capture_invalid", "provider_endpoint must be a string of at most 200 characters or null");
  }
  if (capture.raw_payload_sha256 !== null && !(typeof capture.raw_payload_sha256 === "string" && SHA256.test(capture.raw_payload_sha256))) {
    fail("raw_payload_sha256_invalid", "raw_payload_sha256 must be a lowercase SHA-256 of the raw response bytes or null");
  }
  if (!isRecord(capture.families) || Object.keys(capture.families).some((key) => !(PROVIDER_DATA_FAMILIES as readonly string[]).includes(key))) {
    fail("family_invalid", "families must contain only lineups, formations, statistics and xg");
  }
  const families = Object.fromEntries(PROVIDER_DATA_FAMILIES.map((family) => [family, familyCapture(capture, family)])) as Record<
    ProviderDataFamily,
    SportmonksLedgerFamilyCapture
  >;

  const fixture = capture.fixture;
  if (!isRecord(fixture)) fail("capture_invalid", "fixture must be an object");
  const providerFixtureId = providerRef(fixture.id, "fixture_ref_invalid", "fixture.id");
  const providerLeagueId = providerRef(fixture.league_id, "fixture_ref_invalid", "fixture.league_id");
  const providerSeasonId = providerRef(fixture.season_id, "fixture_ref_invalid", "fixture.season_id");

  if (!Array.isArray(fixture.participants) || fixture.participants.length !== 2) fail("participants_invalid", "fixture needs exactly two participants");
  const sideByTeam = new Map<string, TeamSide>();
  const teamBySide = new Map<TeamSide, string>();
  for (const participant of fixture.participants) {
    if (!isRecord(participant)) fail("participants_invalid", "participant must be an object");
    const location = isRecord(participant.meta) ? participant.meta.location : undefined;
    if (location !== "home" && location !== "away") fail("participants_invalid", "participant needs meta.location home or away");
    const teamId = providerRef(participant.id, "participants_invalid", "participant.id");
    if (teamBySide.has(location as TeamSide) || sideByTeam.has(teamId)) fail("participants_invalid", "participants must be one home and one away team");
    sideByTeam.set(teamId, location as TeamSide);
    teamBySide.set(location as TeamSide, teamId);
  }

  const kickoffAt = kickoffIso(fixture);
  const stateName = isRecord(fixture.state) && typeof fixture.state.developer_name === "string" ? fixture.state.developer_name : null;
  if (stateName === null) fail("state_unavailable", "fixture.state.developer_name is required");
  const matchStatus = SPORTMONKS_STATE_MAP[stateName as string] ?? fail("state_unknown", `unknown Sportmonks state ${stateName}`);
  const extraTime = stateName === "AET" || stateName === "FT_PEN";

  const pairs = scorePairs(fixture.scores);
  let goals90: ScorePair | null = null;
  let goalsAet: ScorePair | null = null;
  let penalties: ScorePair | null = null;
  if (matchStatus === "finished") {
    const second = pairs.get("2ND_HALF") ?? null;
    const current = pairs.get("CURRENT") ?? null;
    if (extraTime) {
      // CURRENT includes extra time (never penalties); 2ND_HALF is cumulative at 90'.
      goals90 = second ?? fail("score_90_unavailable", "a match that went to extra time needs the 2ND_HALF score");
      goalsAet = current ?? fail("extra_time_score_unavailable", "a match that went to extra time needs the CURRENT score");
      penalties = pairs.get("PENALTIES") ?? null;
    } else {
      goals90 = second ?? current ?? fail("score_90_unavailable", "a finished match needs a 2ND_HALF or CURRENT score");
      if (second && current && (second.home !== current.home || second.away !== current.away)) {
        fail("score_inconsistent", "2ND_HALF and CURRENT disagree for a match decided in 90 minutes");
      }
    }
  }

  const flags = new Set<CaptureQualityFlag>();

  // Lineups.
  const players: ProviderObservationPlayer[] = [];
  if (families.lineups.fetch_status === "fetched") {
    const seen = new Set<string>();
    for (const row of families.lineups.rows) {
      if (!isRecord(row)) fail("lineup_row_invalid", "lineup row must be an object");
      const record = row as Record<string, unknown>;
      const providerPlayerId = providerRef(record.player_id, "lineup_row_invalid", "lineup player_id");
      const teamId = providerRef(record.team_id, "lineup_row_invalid", "lineup team_id");
      const side = sideByTeam.get(teamId) ?? fail("lineup_team_unknown", `lineup team ${teamId} is not a participant`);
      if (seen.has(providerPlayerId)) fail("lineup_duplicate_player", `player ${providerPlayerId} appears more than once`);
      seen.add(providerPlayerId);
      const lineupRole: LineupRole =
        record.type_id === SPORTMONKS_LINEUP_STARTER ? "starter" : record.type_id === SPORTMONKS_LINEUP_BENCH ? "bench" : "unknown";
      if (lineupRole === "unknown") flags.add("lineup_role_unknown");
      const position = typeof record.position_id === "number" ? SPORTMONKS_POSITIONS[record.position_id] ?? null : null;
      const formationPosition =
        lineupRole === "starter" && typeof record.formation_position === "number" && Number.isInteger(record.formation_position) &&
        record.formation_position >= 1 && record.formation_position <= 11
          ? record.formation_position
          : null;
      const formationField = typeof record.formation_field === "string" && FORMATION_FIELD.test(record.formation_field) ? record.formation_field : null;
      const shirt =
        typeof record.jersey_number === "number" && Number.isInteger(record.jersey_number) && record.jersey_number >= 0 && record.jersey_number <= 99
          ? record.jersey_number
          : null;
      players.push({
        side,
        providerPlayerId,
        providerPlayerName: cleanName(record.player_name),
        lineupRole,
        appeared: lineupRole === "starter" ? true : null,
        positionCode: position,
        formationPosition,
        formationField,
        shirtNumber: shirt,
      });
    }
    for (const side of ["home", "away"] as const) {
      const team = players.filter((p) => p.side === side);
      if (team.filter((p) => p.lineupRole === "starter").length > 11) fail("lineup_too_many_starters", `${side} lists more than 11 starters`);
      // An ambiguous shirt number or grid slot is dropped, never guessed.
      for (const field of ["shirtNumber", "formationPosition"] as const) {
        const counts = new Map<number, number>();
        for (const p of team) if (p[field] !== null) counts.set(p[field] as number, (counts.get(p[field] as number) ?? 0) + 1);
        for (const p of team) {
          if (p[field] !== null && (counts.get(p[field] as number) ?? 0) > 1) {
            p[field] = null;
            flags.add(field === "shirtNumber" ? "duplicate_shirt_number" : "duplicate_formation_position");
          }
        }
      }
    }
  }

  // Formations.
  const formations = new Map<TeamSide, string>();
  if (families.formations.fetch_status === "fetched") {
    for (const row of families.formations.rows) {
      if (!isRecord(row)) fail("formation_row_invalid", "formation row must be an object");
      const record = row as Record<string, unknown>;
      const teamId = providerRef(record.participant_id, "formation_row_invalid", "formation participant_id");
      const side = sideByTeam.get(teamId) ?? fail("formation_row_invalid", `formation team ${teamId} is not a participant`);
      if (typeof record.formation !== "string" || !FORMATION_PATTERN.test(record.formation)) {
        flags.add("formation_invalid");
        continue;
      }
      const existing = formations.get(side);
      if (existing !== undefined && existing !== record.formation) fail("formation_row_invalid", `conflicting ${side} formations`);
      formations.set(side, record.formation);
    }
  }

  // Team statistics (statistics and xg families). Every allow-listed row is
  // checked against its verified definition, also for extra-time matches.
  const teamStats: ProviderObservationStat[] = [];
  const byKey = new Map<string, ProviderObservationStat>();
  for (const family of ["statistics", "xg"] as const) {
    if (families[family].fetch_status !== "fetched") continue;
    for (const row of families[family].rows) {
      if (!isRecord(row)) fail("stat_row_invalid", "stat row must be an object");
      const record = row as Record<string, unknown>;
      const typeId = typeof record.type_id === "number" || typeof record.type_id === "string" ? String(record.type_id) : null;
      const definition = SPORTMONKS_LEDGER_STAT_TYPES.find((d) => d.typeId === typeId);
      // Type ids outside the allow-list are outside the contract.
      if (!definition) continue;
      if (definition.family !== family) {
        flags.add("stat_type_outside_family");
        continue;
      }
      const teamId = providerRef(record.participant_id, "stat_row_invalid", "stat participant_id");
      const side = sideByTeam.get(teamId) ?? fail("stat_team_unknown", `stat team ${teamId} is not a participant`);
      const developerName = isRecord(record.type) ? record.type.developer_name : undefined;
      if (typeof developerName !== "string" || developerName.trim() === "") {
        fail("stat_type_metadata_missing", `type ${definition.typeId} has no type.developer_name; the capture must request the type include`);
      }
      if (developerName !== definition.developerName) {
        fail("stat_type_drift", `type ${definition.typeId} is ${String(developerName).slice(0, 80)}, verified as ${definition.developerName}`);
      }
      const raw = isRecord(record.data) ? record.data.value : undefined;
      if (raw === null || raw === undefined) {
        // The provider explicitly has no value: not observed, recorded for audit.
        flags.add("stat_value_null");
        continue;
      }
      const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
      const valid =
        Number.isFinite(value) &&
        value >= 0 &&
        (definition.unit !== "count" || Number.isInteger(value)) &&
        (definition.unit !== "percent" || value <= 100);
      if (!valid) fail("stat_value_invalid", `type ${definition.typeId} value ${JSON.stringify(raw).slice(0, 40)} is not a valid ${definition.unit}`);
      const key = `${side}:${definition.typeId}`;
      const existing = byKey.get(key);
      if (existing) {
        if (existing.value !== value) fail("stat_duplicate_conflict", `conflicting values for ${key}`);
        continue;
      }
      byKey.set(key, { side, family, providerStatType: definition.typeId, definitionVersion: SPORTMONKS_STAT_DEFINITION_VERSION, value });
    }
  }
  if (extraTime) {
    if (families.statistics.fetch_status === "fetched" || families.xg.fetch_status === "fetched") flags.add("stats_not_separable_extra_time");
  } else {
    teamStats.push(...[...byKey.values()].sort((a, b) => (a.side + a.providerStatType < b.side + b.providerStatType ? -1 : 1)));
  }

  const statusFor = (side: TeamSide): { lineup: DataStatus; statistics: DataStatus } => {
    const rows = players.filter((p) => p.side === side);
    const starters = rows.filter((p) => p.lineupRole === "starter").length;
    const observed = teamStats.filter((s) => s.side === side).length;
    return {
      lineup: starters === 11 ? "complete" : rows.length > 0 ? "partial" : "not_provided",
      statistics:
        observed === SPORTMONKS_LEDGER_STAT_TYPES.length ? "complete" : observed > 0 ? "partial" : "not_provided",
    };
  };

  const familyFetches = Object.fromEntries(PROVIDER_DATA_FAMILIES.map((f) => [f, families[f].fetch_status])) as Record<
    ProviderDataFamily,
    FamilyFetchStatus
  >;
  const familyResponseSha256 = Object.fromEntries(PROVIDER_DATA_FAMILIES.map((f) => [f, families[f].raw_response_sha256])) as Record<
    ProviderDataFamily,
    string | null
  >;

  const observation: ProviderMatchObservation = {
    provider: "sportmonks",
    providerFixtureId,
    providerLeagueId,
    providerSeasonId,
    providerHomeTeamId: teamBySide.get("home") as string,
    providerAwayTeamId: teamBySide.get("away") as string,
    captureMode: capture.capture_mode,
    ingestVersion: SPORTMONKS_LEDGER_MAPPING_VERSION,
    providerEndpoint: capture.provider_endpoint,
    // Passed through as supplied; null stays null.
    rawPayloadSha256: capture.raw_payload_sha256,
    retrievedAt: new Date(capture.captured_at).toISOString(),
    kickoffAt,
    matchStatus,
    neutralVenue: typeof fixture.neutral_venue === "boolean" ? fixture.neutral_venue : null,
    homeGoals90: goals90?.home ?? null,
    awayGoals90: goals90?.away ?? null,
    homeGoalsAet: goalsAet?.home ?? null,
    awayGoalsAet: goalsAet?.away ?? null,
    homePenalties: penalties?.home ?? null,
    awayPenalties: penalties?.away ?? null,
    teams: (["home", "away"] as const).map((side) => {
      const status = statusFor(side);
      return { side, formationNominal: formations.get(side) ?? null, lineupStatus: status.lineup, statisticsStatus: status.statistics };
    }),
    players,
    teamStats,
    familyFetches,
    familyResponseSha256,
    fixtureMint: options.fixtureMint,
    runId: options.runId,
    captureQualityFlags: [...flags].sort(),
  };
  return { observation, flags: observation.captureQualityFlags };
}
