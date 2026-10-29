import { canonicalSha256 } from "./canonical-json";
import { FORMATION_PATTERN, type DataStatus, type MatchStatus, type PositionCode } from "./match-ledger";
import {
  PROVIDER_MATCH_OBSERVATION_CONTRACT_VERSION,
  SPORTMONKS_LEDGER_MAPPING_VERSION,
  SPORTMONKS_STAT_DEFINITION_VERSION,
} from "./versions";

export const SPORTMONKS_STAT_ALLOW_LIST = {
  "5304": { statKey: "expected_goals", unit: "expected_goals", developerName: "EXPECTED_GOALS" },
  "5305": { statKey: "expected_goals_on_target", unit: "expected_goals", developerName: "EXPECTED_GOALS_ON_TARGET" },
  "7943": { statKey: "expected_non_penalty_goals", unit: "expected_goals", developerName: "EXPECTED_NON_PENALTY_GOALS" },
  "42": { statKey: "shots_total", unit: "count", developerName: "SHOTS_TOTAL" },
  "86": { statKey: "shots_on_target", unit: "count", developerName: "SHOTS_ON_TARGET" },
  "45": { statKey: "possession_pct", unit: "percent", developerName: "BALL_POSSESSION" },
  "34": { statKey: "corners", unit: "count", developerName: "CORNERS" },
} as const;

export type SportmonksAllowedStatType = keyof typeof SPORTMONKS_STAT_ALLOW_LIST;

export type ProviderFixtureMintPolicy = {
  allowed: boolean;
  kickoff_before: string | null;
};

export type ProviderMatchObservationPayload = {
  contract_version: typeof PROVIDER_MATCH_OBSERVATION_CONTRACT_VERSION;
  provider: "sportmonks";
  provider_fixture_id: string;
  provider_endpoint: string | null;
  provider_league_id: string;
  provider_season_id: string;
  provider_home_team_id: string;
  provider_away_team_id: string;
  capture_mode: "scheduled_sync" | "backfill" | "manual_import";
  ingest_version: typeof SPORTMONKS_LEDGER_MAPPING_VERSION;
  source_version: string | null;
  raw_payload_sha256: string;
  retrieved_at: string;
  source_updated_at: string | null;
  kickoff_at: string;
  match_status: MatchStatus;
  neutral_venue: boolean | null;
  home_goals_90: number | null;
  away_goals_90: number | null;
  home_goals_aet: number | null;
  away_goals_aet: number | null;
  home_penalties: number | null;
  away_penalties: number | null;
  fixture_mint: ProviderFixtureMintPolicy;
  run_id: string | null;
  teams: ProviderTeamInput[];
  players: ProviderPlayerInput[];
  team_stats: ProviderTeamStatInput[];
  quality_flags: string[];
};

export type ProviderTeamInput = {
  side: "home" | "away";
  provider_team_id: string;
  formation_nominal: string | null;
  lineup_status: DataStatus;
  substitutions_status: "not_provided";
  events_status: "not_provided";
  statistics_status: DataStatus;
};

export type ProviderPlayerInput = {
  provider_team_id: string;
  provider_player_id: string;
  provider_player_name: string | null;
  lineup_role: "starter" | "bench" | "unknown";
  appeared: boolean | null;
  position_code: PositionCode | null;
  provider_position: string | null;
  formation_position: number | null;
  formation_field: string | null;
  shirt_number: number | null;
  is_captain: boolean | null;
  minutes_played: null;
  entered_minute: null;
  exited_minute: null;
  data_completeness: "complete" | "partial";
};

export type ProviderTeamStatInput = {
  provider_team_id: string;
  provider_stat_type: SportmonksAllowedStatType;
  period: "full_time";
  value: number;
};

type RawParticipant = { id?: number | string; meta?: { location?: string | null } | null };
type RawScore = { description?: string | null; score?: { goals?: number | null; participant?: string | null } | null };
type RawMetric = {
  participant_id?: number | string | null;
  type_id?: number | string | null;
  data?: { value?: number | string | null } | null;
  type?: { developer_name?: string | null; name?: string | null } | null;
};
type RawLineup = {
  player_id?: number | string | null;
  team_id?: number | string | null;
  participant_id?: number | string | null;
  position_id?: number | string | null;
  formation_field?: string | null;
  type_id?: number | string | null;
  formation_position?: number | string | null;
  player_name?: string | null;
  jersey_number?: number | string | null;
  captain?: boolean | number | string | null;
};
type RawFormation = { participant_id?: number | string | null; formation?: string | null };
export type RawSportmonksLedgerFixture = {
  id?: number | string;
  league_id?: number | string;
  season_id?: number | string;
  starting_at?: string;
  neutral_venue?: boolean | null;
  updated_at?: string | null;
  state_id?: number | string;
  state?: { short_name?: string | null; state?: string | null; developer_name?: string | null } | null;
  participants?: RawParticipant[];
  scores?: RawScore[];
  lineups?: RawLineup[];
  formations?: RawFormation[];
  statistics?: RawMetric[];
  xgfixture?: RawMetric[];
};

export type ParseSportmonksLedgerOptions = {
  retrievedAt: string;
  captureMode?: "scheduled_sync" | "backfill" | "manual_import";
  runId?: string | null;
  fixtureMint?: ProviderFixtureMintPolicy;
  providerEndpoint?: string | null;
  sourceVersion?: string | null;
};

function id(value: unknown, label: string): string {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
    throw new Error(`Sportmonks ${label} is required`);
  }
  return String(value);
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Sportmonks ${label} is invalid`);
  return new Date(value).toISOString();
}

function stateName(row: RawSportmonksLedgerFixture): string {
  return (row.state?.developer_name ?? row.state?.state ?? row.state?.short_name ?? String(row.state_id ?? "UNKNOWN"))
    .trim()
    .toUpperCase();
}

function canonicalStatus(state: string): MatchStatus {
  if (state === "NS" || state === "TBA" || state === "DELAYED") return "upcoming";
  if (state === "HT") return "halftime";
  if (["INPLAY_1ST_HALF", "INPLAY_2ND_HALF", "LIVE"].includes(state)) return "live";
  if (["FT", "BREAK", "INPLAY_ET", "EXTRA_TIME_BREAK", "AET", "INPLAY_PENALTIES", "PEN_BREAK", "FT_PEN"].includes(state)) return "finished";
  if (state === "POSTPONED") return "postponed";
  if (state === "CANCELLED" || state === "DELETED") return "cancelled";
  if (["SUSPENDED", "ABANDONED", "INTERRUPTED"].includes(state)) return "suspended";
  return "under_review";
}

function scorePair(rows: RawScore[] | undefined, description: string): { home: number; away: number } | null {
  const wanted = description.toUpperCase();
  const matching = (rows ?? []).filter((row) => (row.description ?? "").trim().toUpperCase() === wanted);
  const value = (side: "home" | "away") => matching.find((row) => (row.score?.participant ?? "").trim().toLowerCase() === side)?.score?.goals;
  const home = value("home");
  const away = value("away");
  if (!Number.isInteger(home) || !Number.isInteger(away) || (home as number) < 0 || (away as number) < 0) return null;
  return { home: home as number, away: away as number };
}

function extraTimeScore(rows: RawScore[] | undefined): { home: number; away: number } | null {
  for (const name of ["EXTRA_TIME", "EXTRA TIME", "AET"]) {
    const pair = scorePair(rows, name);
    if (pair) return pair;
  }
  return null;
}

function penaltyScore(rows: RawScore[] | undefined): { home: number; away: number } | null {
  for (const name of ["PENALTIES", "PENALTY_SHOOTOUT", "PENALTY SHOOTOUT"]) {
    const pair = scorePair(rows, name);
    if (pair) return pair;
  }
  return null;
}

function participant(row: RawSportmonksLedgerFixture, side: "home" | "away"): string {
  const matches = (row.participants ?? []).filter((p) => (p.meta?.location ?? "").trim().toLowerCase() === side);
  if (matches.length !== 1) throw new Error(`Sportmonks fixture must contain exactly one ${side} participant`);
  return id(matches[0].id, `${side} participant id`);
}

function positionCode(value: unknown): PositionCode | null {
  switch (Number(value)) {
    case 24: return "GK";
    case 25: return "DF";
    case 26: return "MF";
    case 27: return "FW";
    default: return null;
  }
}

function lineupRole(value: unknown): "starter" | "bench" | "unknown" {
  if (Number(value) === 11) return "starter";
  if (Number(value) === 12) return "bench";
  return "unknown";
}

function integerOrNull(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function captain(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

function formationFor(row: RawSportmonksLedgerFixture, teamId: string): string | null {
  const raw = row.formations?.find((f) => String(f.participant_id ?? "") === teamId)?.formation ?? null;
  return raw && FORMATION_PATTERN.test(raw) ? raw : null;
}

function numericMetric(row: RawMetric): number | null {
  const value = row.data?.value;
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function parsePlayers(row: RawSportmonksLedgerFixture, homeId: string, awayId: string): { players: ProviderPlayerInput[]; statuses: Record<string, DataStatus> } {
  const raw = row.lineups ?? [];
  const teamRows = (teamId: string) => raw.filter((p) => String(p.team_id ?? p.participant_id ?? "") === teamId);
  const statuses: Record<string, DataStatus> = {};
  const out: ProviderPlayerInput[] = [];
  for (const teamId of [homeId, awayId]) {
    const rows = teamRows(teamId);
    const starters = rows.filter((p) => lineupRole(p.type_id) === "starter" && p.player_id != null);
    statuses[teamId] = starters.length === 11 ? "complete" : starters.length > 0 ? "partial" : "not_provided";
    const shirtCounts = new Map<number, number>();
    for (const p of rows) {
      const shirt = integerOrNull(p.jersey_number, 0, 99);
      if (shirt !== null) shirtCounts.set(shirt, (shirtCounts.get(shirt) ?? 0) + 1);
    }
    for (const p of rows) {
      if (p.player_id == null) continue;
      const role = lineupRole(p.type_id);
      const formationPosition = role === "starter" ? integerOrNull(p.formation_position, 1, 11) : null;
      const field = typeof p.formation_field === "string" && /^\d{1,2}:\d{1,2}$/.test(p.formation_field) ? p.formation_field : null;
      const shirt = integerOrNull(p.jersey_number, 0, 99);
      out.push({
        provider_team_id: teamId,
        provider_player_id: String(p.player_id),
        provider_player_name: typeof p.player_name === "string" && p.player_name.trim() ? p.player_name.trim() : null,
        lineup_role: role,
        appeared: role === "starter" ? true : null,
        position_code: positionCode(p.position_id),
        provider_position: p.position_id == null ? null : String(p.position_id),
        formation_position: formationPosition,
        formation_field: field,
        shirt_number: shirt !== null && shirtCounts.get(shirt) === 1 ? shirt : null,
        is_captain: captain(p.captain),
        minutes_played: null,
        entered_minute: null,
        exited_minute: null,
        data_completeness: statuses[teamId] === "complete" ? "complete" : "partial",
      });
    }
  }
  return { players: out, statuses };
}

function parseStats(row: RawSportmonksLedgerFixture, homeId: string, awayId: string, wentToExtraTime: boolean) {
  const qualityFlags: string[] = [];
  if (wentToExtraTime) return { stats: [] as ProviderTeamStatInput[], statuses: { [homeId]: "not_provided", [awayId]: "not_provided" } as Record<string, DataStatus>, qualityFlags: ["stats_not_separable_extra_time"] };
  const merged = [...(row.statistics ?? []), ...(row.xgfixture ?? [])];
  const seen = new Map<string, ProviderTeamStatInput>();
  for (const metric of merged) {
    const type = String(metric.type_id ?? "") as SportmonksAllowedStatType;
    const spec = SPORTMONKS_STAT_ALLOW_LIST[type];
    if (!spec) continue;
    const developerName = metric.type?.developer_name ?? null;
    if (developerName !== spec.developerName) {
      qualityFlags.push(`type_drift:${type}:${developerName ?? "missing"}`);
      continue;
    }
    const teamId = String(metric.participant_id ?? "");
    if (teamId !== homeId && teamId !== awayId) continue;
    const value = numericMetric(metric);
    if (value === null) continue;
    seen.set(`${teamId}:${type}`, { provider_team_id: teamId, provider_stat_type: type, period: "full_time", value });
  }
  const allTypes = Object.keys(SPORTMONKS_STAT_ALLOW_LIST) as SportmonksAllowedStatType[];
  const statuses: Record<string, DataStatus> = {};
  for (const teamId of [homeId, awayId]) {
    const count = allTypes.filter((type) => seen.has(`${teamId}:${type}`)).length;
    statuses[teamId] = count === 0 ? "not_provided" : count === allTypes.length ? "complete" : "partial";
  }
  return { stats: [...seen.values()].sort((a, b) => a.provider_team_id.localeCompare(b.provider_team_id) || a.provider_stat_type.localeCompare(b.provider_stat_type)), statuses, qualityFlags: [...new Set(qualityFlags)].sort() };
}

export function parseSportmonksLedgerFixture(
  row: RawSportmonksLedgerFixture,
  options: ParseSportmonksLedgerOptions,
): ProviderMatchObservationPayload | null {
  const providerFixtureId = id(row.id, "fixture id");
  const leagueId = id(row.league_id, "league id");
  const seasonId = id(row.season_id, "season id");
  const homeId = participant(row, "home");
  const awayId = participant(row, "away");
  if (homeId === awayId) throw new Error("Sportmonks fixture home and away ids are equal");
  const kickoffAt = iso(row.starting_at, "starting_at");
  const providerState = stateName(row);
  const matchStatus = canonicalStatus(providerState);
  if (matchStatus !== "finished") return null;

  const regularTime = scorePair(row.scores, "2ND_HALF") ?? (providerState === "FT" ? scorePair(row.scores, "CURRENT") : null);
  if (!regularTime) throw new Error("Sportmonks finished fixture has no safe 90-minute score");
  const extra = providerState === "FT" ? null : extraTimeScore(row.scores);
  const penalties = providerState.includes("PEN") ? penaltyScore(row.scores) : null;
  const wentToExtraTime = providerState !== "FT";
  const lineup = parsePlayers(row, homeId, awayId);
  const stats = parseStats(row, homeId, awayId, wentToExtraTime);

  return {
    contract_version: PROVIDER_MATCH_OBSERVATION_CONTRACT_VERSION,
    provider: "sportmonks",
    provider_fixture_id: providerFixtureId,
    provider_endpoint: options.providerEndpoint ?? `/fixtures/${providerFixtureId}`,
    provider_league_id: leagueId,
    provider_season_id: seasonId,
    provider_home_team_id: homeId,
    provider_away_team_id: awayId,
    capture_mode: options.captureMode ?? "backfill",
    ingest_version: SPORTMONKS_LEDGER_MAPPING_VERSION,
    source_version: options.sourceVersion ?? "sportmonks-v3",
    raw_payload_sha256: canonicalSha256(row),
    retrieved_at: iso(options.retrievedAt, "retrievedAt"),
    source_updated_at: row.updated_at && Number.isFinite(Date.parse(row.updated_at)) ? new Date(row.updated_at).toISOString() : null,
    kickoff_at: kickoffAt,
    match_status: matchStatus,
    neutral_venue: row.neutral_venue ?? null,
    home_goals_90: regularTime.home,
    away_goals_90: regularTime.away,
    home_goals_aet: extra?.home ?? null,
    away_goals_aet: extra?.away ?? null,
    home_penalties: penalties?.home ?? null,
    away_penalties: penalties?.away ?? null,
    fixture_mint: options.fixtureMint ?? { allowed: false, kickoff_before: null },
    run_id: options.runId ?? null,
    teams: [
      { side: "home", provider_team_id: homeId, formation_nominal: formationFor(row, homeId), lineup_status: lineup.statuses[homeId], substitutions_status: "not_provided", events_status: "not_provided", statistics_status: stats.statuses[homeId] },
      { side: "away", provider_team_id: awayId, formation_nominal: formationFor(row, awayId), lineup_status: lineup.statuses[awayId], substitutions_status: "not_provided", events_status: "not_provided", statistics_status: stats.statuses[awayId] },
    ],
    players: lineup.players,
    team_stats: stats.stats,
    quality_flags: stats.qualityFlags,
  };
}

export function sportmonksSeededDefinitionRows() {
  return Object.entries(SPORTMONKS_STAT_ALLOW_LIST).map(([providerStatType, spec]) => ({
    provider: "sportmonks" as const,
    provider_stat_type: providerStatType,
    provider_stat_name: spec.developerName,
    definition_version: SPORTMONKS_STAT_DEFINITION_VERSION,
    stat_key: spec.statKey,
    unit: spec.unit,
  }));
}
