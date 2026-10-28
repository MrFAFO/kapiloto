import { MATCH_LEDGER_OBSERVATION_CONTRACT_VERSION } from "./versions";

/**
 * Match Ledger contracts (V4).
 *
 * The ledger stores immutable provider OBSERVATION VERSIONS of canonical
 * fixtures. "What the source said happened" (event time: kickoff, minutes,
 * lineups) is kept separate from "when Kapiloto first knew it" (firstSeenAt,
 * stamped by the database). A correction or backfill is a new version; old
 * versions remain, so an as-of reconstruction never sees later information.
 */

export const CAPTURE_MODES = ["scheduled_sync", "backfill", "manual_import"] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

/**
 * "withdrawal" is a header-only version that retracts a provider's data for a
 * fixture from later cutoffs (wrong fixture attachment, provider removal).
 */
export const OBSERVATION_KINDS = ["observation", "withdrawal"] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const MATCH_STATUSES = [
  "upcoming",
  "live",
  "halftime",
  "finished",
  "postponed",
  "cancelled",
  "suspended",
  "under_review",
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** Completeness of one data family for one team inside one observation. */
export const DATA_STATUSES = ["complete", "partial", "not_provided"] as const;
export type DataStatus = (typeof DATA_STATUSES)[number];

export const TEAM_SIDES = ["home", "away"] as const;
export type TeamSide = (typeof TEAM_SIDES)[number];

export const LINEUP_ROLES = ["starter", "bench", "unknown"] as const;
export type LineupRole = (typeof LINEUP_ROLES)[number];

export const POSITION_CODES = ["GK", "DF", "MF", "FW"] as const;
export type PositionCode = (typeof POSITION_CODES)[number];

export const MATCH_PERIODS = [
  "first_half",
  "second_half",
  "extra_time_first_half",
  "extra_time_second_half",
] as const;
export type MatchPeriod = (typeof MATCH_PERIODS)[number];

export const SUBSTITUTION_REASONS = ["tactical", "injury", "unknown"] as const;
export type SubstitutionReason = (typeof SUBSTITUTION_REASONS)[number];

/** Extending this list requires a migration that widens the CHECK constraint. */
export const MATCH_EVENT_TYPES = [
  "goal",
  "own_goal",
  "penalty_goal",
  "penalty_missed",
  "yellow_card",
  "second_yellow_card",
  "red_card",
] as const;
export type MatchEventType = (typeof MATCH_EVENT_TYPES)[number];

export const CARD_EVENT_TYPES: readonly MatchEventType[] = [
  "yellow_card",
  "second_yellow_card",
  "red_card",
];

/** Event types that may name a related player (assist, penalty goalkeeper). */
export const RELATED_PLAYER_EVENT_TYPES: readonly MatchEventType[] = [
  "goal",
  "penalty_goal",
  "penalty_missed",
];

/** Required with a coach card, relative to the team record's head coach. */
export const STAFF_ROLES = ["head_coach", "assistant_coach", "other_staff", "unknown"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAT_UNITS = [
  "count",
  "percent",
  "ratio",
  "expected_goals",
  "meters",
  "seconds",
  "index",
] as const;
export type StatUnit = (typeof STAT_UNITS)[number];

export const STAT_PERIODS = ["full_time", "first_half", "second_half", "extra_time"] as const;
export type StatPeriod = (typeof STAT_PERIODS)[number];

/** Suggested Kapiloto stat keys. The database accepts any snake_case key. */
export const CORE_STAT_KEYS = [
  "possession_pct",
  "shots_total",
  "shots_on_target",
  "expected_goals",
  "corners",
  "fouls",
  "offsides",
  "yellow_cards",
  "red_cards",
  "attacks",
  "dangerous_attacks",
  "passes_total",
  "passes_accurate",
] as const;

export const FORMATION_PATTERN = /^[1-6](-[1-6]){1,5}$/;

/** A match clock reading: 45+2' is { minute: 45, stoppageMinute: 2 }. */
export type MatchMinute = {
  minute: number | null;
  stoppageMinute: number | null;
  second?: number | null;
  period: MatchPeriod | null;
};

/** Provenance and information time shared by every observation version. */
export type MatchLedgerObservation = {
  id: string;
  /** Payload contract the version was written under. */
  contractVersion: typeof MATCH_LEDGER_OBSERVATION_CONTRACT_VERSION;
  fixtureId: string;
  provider: string;
  providerFixtureId: string;
  providerEndpoint: string | null;
  observationVersion: number;
  captureMode: CaptureMode;
  ingestVersion: string;
  sourceVersion: string | null;
  contentSha256: string;
  rawPayloadSha256: string | null;
  rawObservationId: string | null;
  /** When the ingester fetched the source. Never used for as-of filtering. */
  retrievedAt: string;
  sourceUpdatedAt: string | null;
  /** Information time: database clock when the header row was written. */
  firstSeenAt: string;
  /** Sealing key (writing statement's timestamp). Never use for as-of. */
  ingestStatementAt: string;
  observationKind: ObservationKind;
  withdrawalReason: string | null;
  /** Event time as reported in this version; null only for withdrawals. */
  kickoffAt: string | null;
  matchStatus: MatchStatus | null;
  neutralVenue: boolean | null;
  homeGoals90: number | null;
  awayGoals90: number | null;
  homeGoalsAet: number | null;
  awayGoalsAet: number | null;
  homePenalties: number | null;
  awayPenalties: number | null;
};

/** One team's context inside one observation version. */
export type TeamMatchLedgerRecord = {
  observationId: string;
  fixtureId: string;
  kickoffAt: string;
  firstSeenAt: string;
  teamId: string;
  opponentTeamId: string;
  side: TeamSide;
  coachId: string | null;
  providerCoachId: string | null;
  providerCoachName: string | null;
  /** Provider label as reported; formation families are a later derivation. */
  formationNominal: string | null;
  lineupStatus: DataStatus;
  substitutionsStatus: DataStatus;
  eventsStatus: DataStatus;
  statisticsStatus: DataStatus;
};

export type MatchdayPlayer = {
  teamId: string;
  playerId: string;
  providerPlayerId: string | null;
  providerPlayerName: string | null;
  lineupRole: LineupRole;
  /** Null when the source does not say whether the player appeared. */
  appeared: boolean | null;
  positionCode: PositionCode | null;
  providerPosition: string | null;
  /** 1-11 slot in the provider's formation grid, starters only. */
  formationPosition: number | null;
  /** Provider grid cell such as "2:3". */
  formationField: string | null;
  shirtNumber: number | null;
  isCaptain: boolean | null;
  minutesPlayed: number | null;
  enteredMinute: number | null;
  exitedMinute: number | null;
  dataCompleteness: "complete" | "partial";
};

export type Substitution = MatchMinute & {
  teamId: string;
  /** 1-based order of this team's substitutions in the observation. */
  sequenceNo: number;
  playerOffId: string;
  playerOnId: string;
  reason: SubstitutionReason | null;
  providerEventId: string | null;
};

export type MatchEvent = MatchMinute & {
  /**
   * Team of the acting player or coach. For an own goal this is the team that
   * conceded; use scoringTeamId() for the benefiting team.
   */
  teamId: string;
  /** 1-based order of events in the observation. */
  sequenceNo: number;
  eventType: MatchEventType;
  playerId: string | null;
  /** Cards shown to staff. */
  coachId: string | null;
  /** Required exactly when coachId is set. */
  staffRole?: StaffRole | null;
  /** Assisting player for goals; goalkeeper for a penalty. Must be in the matchday squad (either team). */
  relatedPlayerId: string | null;
  providerEventId: string | null;
  providerEventType: string | null;
  /** Small provider-specific extension bag (≤ 2000 bytes). */
  detail: Record<string, unknown>;
};

export type TeamStatDefinition = {
  id: string;
  provider: string;
  providerStatType: string;
  providerStatName: string | null;
  definitionVersion: string;
  statKey: string;
  unit: StatUnit;
  description: string | null;
};

export type TeamStatObservation = {
  teamId: string;
  statDefinitionId: string;
  period: StatPeriod;
  value: number;
};

/**
 * Derived game-state segment from one team's perspective. Segments split at
 * goals, red cards and period boundaries; contract only in Foundation 1A.
 */
export type GameStateSegment = {
  observationId: string;
  teamId: string;
  derivationVersion: string;
  segmentIndex: number;
  period: MatchPeriod;
  fromMinute: number;
  fromStoppageMinute: number;
  toMinute: number;
  toStoppageMinute: number;
  goalsFor: number;
  goalsAgainst: number;
  /** goalsFor - goalsAgainst (database-generated). */
  scoreDiff: number;
  menFor: number;
  menAgainst: number;
  /** menFor - menAgainst (database-generated). */
  menDiff: number;
  derivedAt: string;
};

/** Everything an ingester knows about one fixture at one retrieval. */
export type MatchLedgerObservationInput = {
  fixtureId: string;
  provider: string;
  providerFixtureId: string;
  providerEndpoint?: string | null;
  captureMode: CaptureMode;
  ingestVersion: string;
  sourceVersion?: string | null;
  rawPayloadSha256?: string | null;
  rawObservationId?: string | null;
  retrievedAt: string;
  sourceUpdatedAt?: string | null;
  kickoffAt: string;
  matchStatus: MatchStatus;
  neutralVenue?: boolean | null;
  homeGoals90?: number | null;
  awayGoals90?: number | null;
  homeGoalsAet?: number | null;
  awayGoalsAet?: number | null;
  homePenalties?: number | null;
  awayPenalties?: number | null;
  teams: Array<
    Pick<TeamMatchLedgerRecord, "teamId" | "side" | "lineupStatus" | "substitutionsStatus" | "eventsStatus" | "statisticsStatus"> &
      Partial<Pick<TeamMatchLedgerRecord, "coachId" | "providerCoachId" | "providerCoachName" | "formationNominal">>
  >;
  players?: MatchdayPlayer[];
  substitutions?: Substitution[];
  events?: MatchEvent[];
  teamStats?: TeamStatObservation[];
};

/** Snake-case JSON accepted by public.match_ledger_record_observation. */
export type MatchLedgerObservationPayload = Record<string, unknown> & {
  contract_version: typeof MATCH_LEDGER_OBSERVATION_CONTRACT_VERSION;
};

export type RecordObservationResult = {
  status: "recorded" | "unchanged";
  observation_id: string;
  observation_version: number;
  first_seen_at: string;
  content_sha256: string;
};

const nullable = <T>(value: T | null | undefined): T | null => (value === undefined ? null : value);
const lowerId = (value: string | null | undefined): string | null =>
  value === undefined || value === null ? null : value.toLowerCase();

/** Maps the camelCase input to the RPC payload with canonical id casing. */
export function buildMatchLedgerObservationPayload(
  input: MatchLedgerObservationInput,
): MatchLedgerObservationPayload {
  return {
    contract_version: MATCH_LEDGER_OBSERVATION_CONTRACT_VERSION,
    fixture_id: input.fixtureId.toLowerCase(),
    provider: input.provider,
    provider_fixture_id: input.providerFixtureId,
    provider_endpoint: nullable(input.providerEndpoint),
    capture_mode: input.captureMode,
    ingest_version: input.ingestVersion,
    source_version: nullable(input.sourceVersion),
    raw_payload_sha256: nullable(input.rawPayloadSha256),
    raw_observation_id: lowerId(input.rawObservationId),
    retrieved_at: input.retrievedAt,
    source_updated_at: nullable(input.sourceUpdatedAt),
    kickoff_at: input.kickoffAt,
    match_status: input.matchStatus,
    neutral_venue: nullable(input.neutralVenue),
    home_goals_90: nullable(input.homeGoals90),
    away_goals_90: nullable(input.awayGoals90),
    home_goals_aet: nullable(input.homeGoalsAet),
    away_goals_aet: nullable(input.awayGoalsAet),
    home_penalties: nullable(input.homePenalties),
    away_penalties: nullable(input.awayPenalties),
    teams: input.teams.map((team) => ({
      team_id: team.teamId.toLowerCase(),
      side: team.side,
      coach_id: lowerId(team.coachId),
      provider_coach_id: nullable(team.providerCoachId),
      provider_coach_name: nullable(team.providerCoachName),
      formation_nominal: nullable(team.formationNominal),
      lineup_status: team.lineupStatus,
      substitutions_status: team.substitutionsStatus,
      events_status: team.eventsStatus,
      statistics_status: team.statisticsStatus,
    })),
    players: (input.players ?? []).map((player) => ({
      team_id: player.teamId.toLowerCase(),
      player_id: player.playerId.toLowerCase(),
      provider_player_id: player.providerPlayerId,
      provider_player_name: player.providerPlayerName,
      lineup_role: player.lineupRole,
      appeared: player.appeared,
      position_code: player.positionCode,
      provider_position: player.providerPosition,
      formation_position: player.formationPosition,
      formation_field: player.formationField,
      shirt_number: player.shirtNumber,
      is_captain: player.isCaptain,
      minutes_played: player.minutesPlayed,
      entered_minute: player.enteredMinute,
      exited_minute: player.exitedMinute,
      data_completeness: player.dataCompleteness,
    })),
    substitutions: (input.substitutions ?? []).map((sub) => ({
      team_id: sub.teamId.toLowerCase(),
      sequence_no: sub.sequenceNo,
      player_off_id: sub.playerOffId.toLowerCase(),
      player_on_id: sub.playerOnId.toLowerCase(),
      minute: sub.minute,
      stoppage_minute: sub.stoppageMinute,
      period: sub.period,
      reason: sub.reason,
      provider_event_id: sub.providerEventId,
    })),
    events: (input.events ?? []).map((event) => ({
      team_id: event.teamId.toLowerCase(),
      sequence_no: event.sequenceNo,
      event_type: event.eventType,
      player_id: lowerId(event.playerId),
      coach_id: lowerId(event.coachId),
      staff_role: nullable(event.staffRole),
      related_player_id: lowerId(event.relatedPlayerId),
      minute: event.minute,
      stoppage_minute: event.stoppageMinute,
      second: nullable(event.second),
      period: event.period,
      provider_event_id: event.providerEventId,
      provider_event_type: event.providerEventType,
      detail: event.detail,
    })),
    team_stats: (input.teamStats ?? []).map((stat) => ({
      team_id: stat.teamId.toLowerCase(),
      stat_definition_id: stat.statDefinitionId.toLowerCase(),
      period: stat.period,
      value: stat.value,
    })),
  };
}

export type MatchLedgerWithdrawalInput = {
  fixtureId: string;
  provider: string;
  providerFixtureId: string;
  captureMode: CaptureMode;
  ingestVersion: string;
  retrievedAt: string;
  withdrawalReason: string;
};

/** Payload that withdraws a provider's data for a fixture from later cutoffs. */
export function buildMatchLedgerWithdrawalPayload(
  input: MatchLedgerWithdrawalInput,
): MatchLedgerObservationPayload {
  return {
    contract_version: MATCH_LEDGER_OBSERVATION_CONTRACT_VERSION,
    observation_kind: "withdrawal",
    fixture_id: input.fixtureId.toLowerCase(),
    provider: input.provider,
    provider_fixture_id: input.providerFixtureId,
    capture_mode: input.captureMode,
    ingest_version: input.ingestVersion,
    retrieved_at: input.retrievedAt,
    withdrawal_reason: input.withdrawalReason,
  };
}

/**
 * Bundle-level consistency checks run before calling the RPC. The database is
 * authoritative and enforces the same invariants (constraints, sealing and
 * deferred completeness triggers); this returns readable issues instead of
 * the first violation. Mapping, coach-identity and stat-provider checks need
 * database state and exist only in the database.
 */
export function validateMatchLedgerObservation(input: MatchLedgerObservationInput): string[] {
  const issues: string[] = [];
  const sides = input.teams.map((team) => team.side).sort().join(",");
  if (input.teams.length !== 2 || sides !== "away,home") {
    issues.push("observation must contain exactly one home and one away team");
  }
  const teamIds = new Set(input.teams.map((team) => team.teamId.toLowerCase()));
  for (const team of input.teams) {
    if (team.formationNominal && !FORMATION_PATTERN.test(team.formationNominal)) {
      issues.push(`team ${team.teamId}: invalid nominal formation ${team.formationNominal}`);
    }
  }
  if (input.matchStatus === "finished" && (input.homeGoals90 == null || input.awayGoals90 == null)) {
    issues.push("finished observation is missing the 90-minute score");
  }

  const players = input.players ?? [];
  const squad = new Map<string, MatchdayPlayer>();
  for (const player of players) {
    const key = player.playerId.toLowerCase();
    if (squad.has(key)) issues.push(`player ${player.playerId} appears more than once`);
    squad.set(key, player);
    if (!teamIds.has(player.teamId.toLowerCase())) {
      issues.push(`player ${player.playerId} belongs to a team outside this fixture`);
    }
    if (player.lineupRole === "starter" && player.appeared === false) {
      issues.push(`starter ${player.playerId} is marked as not appeared`);
    }
    if (player.formationPosition !== null && player.lineupRole !== "starter") {
      issues.push(`non-starter ${player.playerId} has a formation position`);
    }
    if (
      player.enteredMinute !== null &&
      player.exitedMinute !== null &&
      player.exitedMinute < player.enteredMinute
    ) {
      issues.push(`player ${player.playerId} exits before entering`);
    }
  }
  for (const team of input.teams) {
    const teamId = team.teamId.toLowerCase();
    const teamPlayers = players.filter((player) => player.teamId.toLowerCase() === teamId);
    const starters = teamPlayers.filter((player) => player.lineupRole === "starter");
    if (starters.length > 11) issues.push(`team ${team.teamId} has more than 11 starters`);
    // "complete" claims full representation; zero substitutions/events is valid.
    if (team.lineupStatus === "complete" && starters.length !== 11) {
      issues.push(`team ${team.teamId} lineup is marked complete without 11 starters`);
    }
    if (team.lineupStatus === "not_provided" && teamPlayers.length > 0) {
      issues.push(`team ${team.teamId} lineup is marked not_provided but has players`);
    }
    if (team.substitutionsStatus === "not_provided" && (input.substitutions ?? []).some((s) => s.teamId.toLowerCase() === teamId)) {
      issues.push(`team ${team.teamId} substitutions are marked not_provided but substitutions exist`);
    }
    if (team.eventsStatus === "not_provided" && (input.events ?? []).some((e) => e.teamId.toLowerCase() === teamId)) {
      issues.push(`team ${team.teamId} events are marked not_provided but events exist`);
    }
    if (team.statisticsStatus === "not_provided" && (input.teamStats ?? []).some((s) => s.teamId.toLowerCase() === teamId)) {
      issues.push(`team ${team.teamId} statistics are marked not_provided but statistics exist`);
    }
    const slots = starters.flatMap((player) => (player.formationPosition === null ? [] : [player.formationPosition]));
    if (new Set(slots).size !== slots.length) issues.push(`team ${team.teamId} repeats a formation position`);
  }

  const onIds = new Set<string>();
  const offIds = new Set<string>();
  const subSequence = new Set<string>();
  for (const sub of input.substitutions ?? []) {
    const team = sub.teamId.toLowerCase();
    const off = squad.get(sub.playerOffId.toLowerCase());
    const on = squad.get(sub.playerOnId.toLowerCase());
    if (!off || off.teamId.toLowerCase() !== team) issues.push(`substitution ${sub.sequenceNo}: player off is not in the team's squad`);
    if (!on || on.teamId.toLowerCase() !== team) issues.push(`substitution ${sub.sequenceNo}: player on is not in the team's squad`);
    if (on?.lineupRole === "starter") issues.push(`substitution ${sub.sequenceNo}: a starter cannot come on`);
    if (sub.playerOffId.toLowerCase() === sub.playerOnId.toLowerCase()) issues.push(`substitution ${sub.sequenceNo}: same player on and off`);
    if (onIds.has(sub.playerOnId.toLowerCase())) issues.push(`player ${sub.playerOnId} comes on twice`);
    if (offIds.has(sub.playerOffId.toLowerCase())) issues.push(`player ${sub.playerOffId} goes off twice`);
    const sequenceKey = `${team}:${sub.sequenceNo}`;
    if (subSequence.has(sequenceKey)) issues.push(`substitution sequence ${sequenceKey} repeats`);
    onIds.add(sub.playerOnId.toLowerCase());
    offIds.add(sub.playerOffId.toLowerCase());
    subSequence.add(sequenceKey);
  }

  const eventSequence = new Set<number>();
  for (const event of input.events ?? []) {
    if (eventSequence.has(event.sequenceNo)) issues.push(`event sequence ${event.sequenceNo} repeats`);
    eventSequence.add(event.sequenceNo);
    if (!teamIds.has(event.teamId.toLowerCase())) issues.push(`event ${event.sequenceNo} belongs to a team outside this fixture`);
    if (event.playerId && event.coachId) issues.push(`event ${event.sequenceNo} names both a player and a coach`);
    if (event.coachId && !CARD_EVENT_TYPES.includes(event.eventType)) {
      issues.push(`event ${event.sequenceNo}: only cards can be shown to a coach`);
    }
    if (Boolean(event.coachId) !== Boolean(event.staffRole)) {
      issues.push(`event ${event.sequenceNo}: staffRole is required exactly when a coach is named`);
    }
    if (event.relatedPlayerId) {
      if (!RELATED_PLAYER_EVENT_TYPES.includes(event.eventType)) {
        issues.push(`event ${event.sequenceNo}: ${event.eventType} cannot name a related player`);
      }
      if (!squad.has(event.relatedPlayerId.toLowerCase())) {
        issues.push(`event ${event.sequenceNo}: related player is not in the matchday squad`);
      }
      if (event.playerId && event.relatedPlayerId.toLowerCase() === event.playerId.toLowerCase()) {
        issues.push(`event ${event.sequenceNo}: related player equals the acting player`);
      }
    }
    if (event.playerId) {
      const player = squad.get(event.playerId.toLowerCase());
      if (!player || player.teamId.toLowerCase() !== event.teamId.toLowerCase()) {
        issues.push(`event ${event.sequenceNo}: player is not in the acting team's squad`);
      }
    }
  }

  const statKeys = new Set<string>();
  for (const stat of input.teamStats ?? []) {
    const key = `${stat.teamId.toLowerCase()}:${stat.statDefinitionId.toLowerCase()}:${stat.period}`;
    if (statKeys.has(key)) issues.push(`team stat ${key} repeats`);
    statKeys.add(key);
    if (!Number.isFinite(stat.value)) issues.push(`team stat ${key} is not finite`);
  }
  return issues;
}

/** The team credited with a goal event, or null for non-scoring events. */
export function scoringTeamId(
  event: Pick<MatchEvent, "eventType" | "teamId">,
  record: Pick<TeamMatchLedgerRecord, "teamId" | "opponentTeamId">,
): string | null {
  if (event.teamId !== record.teamId) return null;
  if (event.eventType === "goal" || event.eventType === "penalty_goal") return record.teamId;
  if (event.eventType === "own_goal") return record.opponentTeamId;
  return null;
}
