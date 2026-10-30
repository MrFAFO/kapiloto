import { canonicalSha256 } from "./canonical-json";
import {
  CAPTURE_MODES,
  DATA_STATUSES,
  FORMATION_PATTERN,
  LINEUP_ROLES,
  MATCH_STATUSES,
  POSITION_CODES,
  type CaptureMode,
  type DataStatus,
  type LineupRole,
  type MatchStatus,
  type PositionCode,
  type TeamSide,
} from "./match-ledger";
import {
  PROVIDER_ENTITLEMENT_SNAPSHOT_VERSION,
  PROVIDER_MATCH_OBSERVATION_CONTRACT_VERSION,
} from "./versions";

/**
 * Provider-native Match Ledger ingest (A2-A, D-056).
 *
 * A provider match observation carries PROVIDER identities only. The
 * database (public.match_ledger_ingest_provider_fixture) resolves them:
 * competitions and teams through confirmed/manual mappings only (never
 * created here), the canonical fixture through an existing mapping, a
 * fail-closed canonical-key attach or an explicit mint policy, and players
 * through confirmed mappings or a provider-native bootstrap. Anything it
 * cannot decide safely is quarantined with a closed reason code and nothing
 * but the optional audit item is written.
 */

export const PROVIDER_DATA_FAMILIES = ["lineups", "formations", "statistics", "xg"] as const;
export type ProviderDataFamily = (typeof PROVIDER_DATA_FAMILIES)[number];

/**
 * fetched: the family was requested and answered (an absent key then means
 * not observed). not_requested: it was not asked for, or the plan does not
 * include it. failed: the request failed; the ingest RPC quarantines it.
 */
export const FAMILY_FETCH_STATUSES = ["fetched", "not_requested", "failed"] as const;
export type FamilyFetchStatus = (typeof FAMILY_FETCH_STATUSES)[number];

export const PROVIDER_STAT_FAMILIES = ["statistics", "xg"] as const;
export type ProviderStatFamily = (typeof PROVIDER_STAT_FAMILIES)[number];

export const PROVIDER_INGEST_QUARANTINE_CODES = [
  "family_fetch_failed",
  "not_finished",
  "finished_too_early",
  "competition_unmapped",
  "competition_untrusted",
  "team_unmapped",
  "team_untrusted",
  "team_identity_conflict",
  "player_mapping_unverified",
  "fixture_mapping_unverified",
  "fixture_mapping_untrusted",
  "fixture_mapping_conflict",
  "fixture_provider_identity_conflict",
  "fixture_candidate_ambiguous",
  "fixture_orientation_conflict",
  "fixture_competition_conflict",
  "fixture_competition_unknown",
  "fixture_possible_postponement",
  "fixture_possible_reschedule",
  "fixture_mint_not_permitted",
  "provider_fixture_id_drift",
  "provider_refs_unrecorded",
  "provider_ref_drift",
  "family_status_downgrade",
  "family_status_drift",
] as const;
export type ProviderIngestQuarantineCode = (typeof PROVIDER_INGEST_QUARANTINE_CODES)[number];

/**
 * Recoverable capture issues a parser normalized away (closed set, mirrored by
 * the ingest RPC). Stored per attempt in provider_ingest_items.detail; never
 * ledger content, never part of the 1A content hash, never a new version.
 * Contract-level problems (stat type drift, missing type metadata, invalid
 * values of verified types) are parse failures instead, never flags.
 */
export const CAPTURE_QUALITY_FLAGS = [
  "duplicate_formation_position",
  "duplicate_shirt_number",
  "formation_invalid",
  "lineup_role_unknown",
  "stat_type_outside_family",
  "stat_value_null",
  "stats_not_separable_extra_time",
] as const;
export type CaptureQualityFlag = (typeof CAPTURE_QUALITY_FLAGS)[number];
export const MAX_CAPTURE_QUALITY_FLAGS = 32;

export const FIXTURE_RESOLUTIONS = ["existing_mapping", "attached", "minted"] as const;
export type FixtureResolution = (typeof FIXTURE_RESOLUTIONS)[number];

export const PROVIDER_INGEST_FUNCTIONS = {
  ingestFixture: "match_ledger_ingest_provider_fixture",
  recordFailure: "provider_ingest_record_failure",
  providerRefConflicts: "match_ledger_provider_ref_conflicts",
} as const;

/**
 * Historical ingest trust boundary, stricter than V3's own resolution:
 * a team or an existing fixture mapping is trusted only as manual_override, or
 * confirmed with mapping_confidence = 1; a competition mapping only as
 * manual_override (the table has no confidence). Mirrors
 * private.provider_mapping_trusted / private.provider_competition_mapping_trusted.
 */
export function isTrustedProviderMapping(status: string | null, confidence: number | null): boolean {
  return status === "manual_override" || (status === "confirmed" && confidence === 1);
}

export function isTrustedProviderCompetitionMapping(status: string | null): boolean {
  return status === "manual_override";
}

export type ProviderObservationTeam = {
  side: TeamSide;
  formationNominal: string | null;
  lineupStatus: DataStatus;
  statisticsStatus: DataStatus;
};

export type ProviderObservationPlayer = {
  side: TeamSide;
  providerPlayerId: string;
  providerPlayerName: string | null;
  lineupRole: LineupRole;
  appeared: boolean | null;
  positionCode: PositionCode | null;
  formationPosition: number | null;
  formationField: string | null;
  shirtNumber: number | null;
};

export type ProviderObservationStat = {
  side: TeamSide;
  family: ProviderStatFamily;
  providerStatType: string;
  definitionVersion: string;
  value: number;
};

/** Caller mint policy: a canonical fixture may be created only for kickoffs before kickoffBefore. */
export type FixtureMintPolicy = { allowed: boolean; kickoffBefore: string | null };

export type ProviderMatchObservation = {
  provider: string;
  providerFixtureId: string;
  providerLeagueId: string;
  providerSeasonId: string;
  providerHomeTeamId: string;
  providerAwayTeamId: string;
  captureMode: CaptureMode;
  ingestVersion: string;
  providerEndpoint: string | null;
  /** SHA-256 of the exact raw response bytes, supplied by the capturer; never computed by a parser. */
  rawPayloadSha256: string | null;
  retrievedAt: string;
  kickoffAt: string;
  matchStatus: MatchStatus;
  neutralVenue: boolean | null;
  homeGoals90: number | null;
  awayGoals90: number | null;
  homeGoalsAet: number | null;
  awayGoalsAet: number | null;
  homePenalties: number | null;
  awayPenalties: number | null;
  teams: ProviderObservationTeam[];
  players: ProviderObservationPlayer[];
  teamStats: ProviderObservationStat[];
  familyFetches: Record<ProviderDataFamily, FamilyFetchStatus>;
  /** Per-family response hashes for the audit item only; not part of ledger content. */
  familyResponseSha256: Partial<Record<ProviderDataFamily, string | null>>;
  fixtureMint: FixtureMintPolicy;
  runId: string | null;
  /** Sorted, de-duplicated recoverable capture issues; audit only. */
  captureQualityFlags: CaptureQualityFlag[];
};

export type ProviderIngestResult = {
  status: "recorded" | "unchanged" | "quarantined";
  reason_code: ProviderIngestQuarantineCode | null;
  fixture_id: string | null;
  observation_id: string | null;
  attempt_no: number | null;
  fixture_resolution?: FixtureResolution;
  observation_version?: number;
  /** recorded: first annotated version; matched: refs equal the latest version's. */
  provider_refs_status?: "recorded" | "matched" | "unrecorded" | "drift";
  players_minted?: number;
};

export type ProviderIngestFailureResult = {
  status: "failed";
  reason_code: string;
  attempt_no: number;
};

export type ProviderIngestRpc = (
  fn: (typeof PROVIDER_INGEST_FUNCTIONS)[keyof typeof PROVIDER_INGEST_FUNCTIONS],
  args: Record<string, unknown>,
) => Promise<unknown>;

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER = /^[a-z0-9_]{1,40}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{1,62}$/;
const FORMATION_FIELD = /^[0-9]{1,2}:[0-9]{1,2}$/;

const isProviderRef = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 80;
const isIsoInstant = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
const isGoalCount = (value: unknown): boolean =>
  value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 99);

/** Structural validation mirroring the RPC; returns human-readable issues. */
export function validateProviderMatchObservation(observation: ProviderMatchObservation): string[] {
  const issues: string[] = [];
  if (!PROVIDER.test(observation.provider)) issues.push("invalid provider");
  for (const key of ["providerFixtureId", "providerLeagueId", "providerSeasonId", "providerHomeTeamId", "providerAwayTeamId"] as const) {
    if (!isProviderRef(observation[key])) issues.push(`${key} must be a non-empty provider ref`);
  }
  if (observation.providerHomeTeamId === observation.providerAwayTeamId) issues.push("home and away provider team ids must differ");
  if (!(CAPTURE_MODES as readonly string[]).includes(observation.captureMode)) issues.push("invalid capture mode");
  if (!(MATCH_STATUSES as readonly string[]).includes(observation.matchStatus)) issues.push("invalid match status");
  if (!observation.ingestVersion || observation.ingestVersion.length > 80) issues.push("invalid ingest version");
  if (observation.rawPayloadSha256 !== null && !SHA256.test(observation.rawPayloadSha256)) {
    issues.push("raw_payload_sha256 must be a lowercase SHA-256 of the raw response or null");
  }
  if (!isIsoInstant(observation.retrievedAt)) issues.push("retrievedAt must be an ISO instant");
  if (!isIsoInstant(observation.kickoffAt)) issues.push("kickoffAt must be an ISO instant");
  for (const key of ["homeGoals90", "awayGoals90", "homeGoalsAet", "awayGoalsAet", "homePenalties", "awayPenalties"] as const) {
    if (!isGoalCount(observation[key])) issues.push(`${key} must be a non-negative integer or null`);
  }
  if ((observation.homeGoals90 === null) !== (observation.awayGoals90 === null)) issues.push("90-minute goals must be paired");
  if ((observation.homeGoalsAet === null) !== (observation.awayGoalsAet === null)) issues.push("extra-time goals must be paired");
  if ((observation.homePenalties === null) !== (observation.awayPenalties === null)) issues.push("penalties must be paired");
  if (observation.matchStatus === "finished" && observation.homeGoals90 === null) issues.push("a finished observation needs the 90-minute score");

  const sides = observation.teams.map((team) => team.side).sort().join(",");
  if (observation.teams.length !== 2 || sides !== "away,home") issues.push("observation must contain exactly one home and one away team");
  for (const team of observation.teams) {
    if (team.formationNominal !== null && !FORMATION_PATTERN.test(team.formationNominal)) issues.push(`${team.side}: invalid formation`);
    if (!(DATA_STATUSES as readonly string[]).includes(team.lineupStatus)) issues.push(`${team.side}: invalid lineup status`);
    if (!(DATA_STATUSES as readonly string[]).includes(team.statisticsStatus)) issues.push(`${team.side}: invalid statistics status`);
  }

  for (const family of PROVIDER_DATA_FAMILIES) {
    if (!(FAMILY_FETCH_STATUSES as readonly string[]).includes(observation.familyFetches?.[family])) {
      issues.push(`family ${family} needs a fetch status`);
    }
    const hash = observation.familyResponseSha256?.[family];
    if (hash !== undefined && hash !== null && !SHA256.test(hash)) issues.push(`family ${family}: invalid response hash`);
  }
  if (Object.keys(observation.familyFetches ?? {}).some((key) => !(PROVIDER_DATA_FAMILIES as readonly string[]).includes(key))) {
    issues.push("unknown data family");
  }

  const seenPlayers = new Set<string>();
  for (const player of observation.players) {
    if (!isProviderRef(player.providerPlayerId)) issues.push("player needs a provider player id");
    if (seenPlayers.has(player.providerPlayerId)) issues.push(`provider player ${player.providerPlayerId} appears more than once`);
    seenPlayers.add(player.providerPlayerId);
    if (!(LINEUP_ROLES as readonly string[]).includes(player.lineupRole)) issues.push(`player ${player.providerPlayerId}: invalid lineup role`);
    if (player.positionCode !== null && !(POSITION_CODES as readonly string[]).includes(player.positionCode)) {
      issues.push(`player ${player.providerPlayerId}: invalid position`);
    }
    if (player.formationPosition !== null && (player.lineupRole !== "starter" || player.formationPosition < 1 || player.formationPosition > 11)) {
      issues.push(`player ${player.providerPlayerId}: formation position is for starters 1-11`);
    }
    if (player.formationField !== null && !FORMATION_FIELD.test(player.formationField)) issues.push(`player ${player.providerPlayerId}: invalid formation field`);
    if (player.lineupRole === "starter" && player.appeared === false) issues.push(`starter ${player.providerPlayerId} is marked as not appeared`);
  }

  const seenStats = new Set<string>();
  for (const stat of observation.teamStats) {
    if (!(PROVIDER_STAT_FAMILIES as readonly string[]).includes(stat.family)) issues.push(`stat ${stat.providerStatType}: invalid family`);
    else if (observation.familyFetches?.[stat.family] !== "fetched") issues.push(`stat ${stat.providerStatType}: family ${stat.family} was not fetched`);
    if (!Number.isFinite(stat.value)) issues.push(`stat ${stat.providerStatType}: value must be finite`);
    const key = `${stat.side}:${stat.providerStatType}:${stat.definitionVersion}`;
    if (seenStats.has(key)) issues.push(`stat ${key} appears more than once`);
    seenStats.add(key);
  }

  if (observation.fixtureMint.allowed && !isIsoInstant(observation.fixtureMint.kickoffBefore)) {
    issues.push("an allowed fixture mint needs kickoffBefore");
  }
  if (observation.runId !== null && !UUID.test(observation.runId)) issues.push("runId must be a uuid");
  const flags = observation.captureQualityFlags;
  if (!Array.isArray(flags) || flags.length > MAX_CAPTURE_QUALITY_FLAGS) {
    issues.push(`captureQualityFlags must be an array of at most ${MAX_CAPTURE_QUALITY_FLAGS} flags`);
  } else {
    if (flags.some((flag) => !(CAPTURE_QUALITY_FLAGS as readonly string[]).includes(flag))) issues.push("unknown capture quality flag");
    if (flags.some((flag, i) => i > 0 && flags[i - 1] >= flag)) issues.push("captureQualityFlags must be sorted and unique");
  }
  return issues;
}

/** Maps the camelCase observation to the RPC payload. */
export function buildProviderMatchObservationPayload(observation: ProviderMatchObservation): Record<string, unknown> {
  return {
    contract_version: PROVIDER_MATCH_OBSERVATION_CONTRACT_VERSION,
    provider: observation.provider,
    provider_fixture_id: observation.providerFixtureId,
    provider_league_id: observation.providerLeagueId,
    provider_season_id: observation.providerSeasonId,
    provider_home_team_id: observation.providerHomeTeamId,
    provider_away_team_id: observation.providerAwayTeamId,
    capture_mode: observation.captureMode,
    ingest_version: observation.ingestVersion,
    provider_endpoint: observation.providerEndpoint,
    raw_payload_sha256: observation.rawPayloadSha256,
    retrieved_at: observation.retrievedAt,
    kickoff_at: observation.kickoffAt,
    match_status: observation.matchStatus,
    neutral_venue: observation.neutralVenue,
    home_goals_90: observation.homeGoals90,
    away_goals_90: observation.awayGoals90,
    home_goals_aet: observation.homeGoalsAet,
    away_goals_aet: observation.awayGoalsAet,
    home_penalties: observation.homePenalties,
    away_penalties: observation.awayPenalties,
    teams: observation.teams.map((team) => ({
      side: team.side,
      formation_nominal: team.formationNominal,
      lineup_status: team.lineupStatus,
      statistics_status: team.statisticsStatus,
    })),
    players: observation.players.map((player) => ({
      side: player.side,
      provider_player_id: player.providerPlayerId,
      provider_player_name: player.providerPlayerName,
      lineup_role: player.lineupRole,
      appeared: player.appeared,
      position_code: player.positionCode,
      formation_position: player.formationPosition,
      formation_field: player.formationField,
      shirt_number: player.shirtNumber,
    })),
    team_stats: observation.teamStats.map((stat) => ({
      side: stat.side,
      family: stat.family,
      provider_stat_type: stat.providerStatType,
      definition_version: stat.definitionVersion,
      value: stat.value,
    })),
    family_fetches: { ...observation.familyFetches },
    family_response_sha256: Object.fromEntries(
      PROVIDER_DATA_FAMILIES.map((family) => [family, observation.familyResponseSha256?.[family] ?? null]),
    ),
    fixture_mint: { allowed: observation.fixtureMint.allowed, kickoff_before: observation.fixtureMint.kickoffBefore },
    run_id: observation.runId === null ? null : observation.runId.toLowerCase(),
    capture_quality_flags: [...observation.captureQualityFlags],
  };
}

/** Validates, then calls public.match_ledger_ingest_provider_fixture (service_role). */
export async function recordProviderMatchObservation(
  rpc: ProviderIngestRpc,
  observation: ProviderMatchObservation,
): Promise<ProviderIngestResult> {
  const issues = validateProviderMatchObservation(observation);
  if (issues.length > 0) throw new Error(`invalid provider match observation: ${issues.join("; ")}`);
  return (await rpc(PROVIDER_INGEST_FUNCTIONS.ingestFixture, {
    p_observation: buildProviderMatchObservationPayload(observation),
  })) as ProviderIngestResult;
}

/** Appends a 'failed' audit item (fetch or parse failure) for one provider fixture. */
export async function recordProviderIngestFailure(
  rpc: ProviderIngestRpc,
  failure: { runId: string; provider: string; providerFixtureId: string; reasonCode: string; detail?: Record<string, unknown> },
): Promise<ProviderIngestFailureResult> {
  if (!UUID.test(failure.runId)) throw new Error("ingest failure needs a run id");
  if (!PROVIDER.test(failure.provider)) throw new Error("invalid provider");
  if (!isProviderRef(failure.providerFixtureId)) throw new Error("invalid provider fixture id");
  if (!REASON_CODE.test(failure.reasonCode)) throw new Error("reason code must be snake_case");
  return (await rpc(PROVIDER_INGEST_FUNCTIONS.recordFailure, {
    p_run_id: failure.runId.toLowerCase(),
    p_provider: failure.provider,
    p_provider_fixture_id: failure.providerFixtureId,
    p_reason_code: failure.reasonCode,
    p_detail: failure.detail ?? {},
  })) as ProviderIngestFailureResult;
}

/**
 * Upper kickoff bound for fixture minting: strictly older than the V3
 * shadow-evaluation scoring lookback plus one day, so a minted canonical
 * fixture can never enter V3's finished-fixture scan. The lookback is passed
 * in (V4 does not import V3); A2-B reads it from the V3 configuration.
 */
export function fixtureMintKickoffBefore(now: string, scoringLookbackDays: number): string {
  if (!isIsoInstant(now)) throw new Error("now must be an ISO instant");
  if (!Number.isInteger(scoringLookbackDays) || scoringLookbackDays < 1) throw new Error("scoring lookback must be a positive integer");
  return new Date(Date.parse(now) - (scoringLookbackDays + 1) * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Ingest runs and entitlement snapshots
// ---------------------------------------------------------------------------

export type ProviderEntitlementSnapshot = {
  provider: string;
  capturedAt: string;
  /** Where the entitlement list came from (e.g. "sportmonks_my_leagues"). */
  source: string;
  competitions: Array<{ providerLeagueId: string; name: string | null }>;
};

/** SHA-256 of the canonical entitlement snapshot (competitions sorted by provider id). */
export function providerEntitlementSnapshotSha256(snapshot: ProviderEntitlementSnapshot): string {
  if (!PROVIDER.test(snapshot.provider)) throw new Error("invalid provider");
  if (!isIsoInstant(snapshot.capturedAt)) throw new Error("capturedAt must be an ISO instant");
  const ids = snapshot.competitions.map((c) => c.providerLeagueId);
  if (ids.some((id) => !isProviderRef(id)) || new Set(ids).size !== ids.length) throw new Error("competition ids must be unique provider refs");
  return canonicalSha256({
    contract_version: PROVIDER_ENTITLEMENT_SNAPSHOT_VERSION,
    provider: snapshot.provider,
    captured_at: new Date(snapshot.capturedAt).toISOString(),
    source: snapshot.source,
    competitions: [...snapshot.competitions]
      .sort((a, b) => (a.providerLeagueId < b.providerLeagueId ? -1 : a.providerLeagueId > b.providerLeagueId ? 1 : 0))
      .map((c) => ({ provider_league_id: c.providerLeagueId, name: c.name })),
  });
}

export type ProviderIngestRunInput = {
  provider: string;
  purpose: "backfill" | "test";
  ingestVersion: string;
  entitlementSnapshotSha256: string | null;
  scope: Record<string, unknown>;
  fixtureMintKickoffBefore: string | null;
};

/** Row for public.provider_ingest_runs (service_role insert; rows are immutable). */
export function buildProviderIngestRunRow(input: ProviderIngestRunInput): Record<string, unknown> {
  if (!PROVIDER.test(input.provider)) throw new Error("invalid provider");
  if (input.purpose !== "backfill" && input.purpose !== "test") throw new Error("invalid ingest run purpose");
  if (!input.ingestVersion || input.ingestVersion.length > 80) throw new Error("invalid ingest version");
  if (input.entitlementSnapshotSha256 !== null && !SHA256.test(input.entitlementSnapshotSha256)) throw new Error("invalid entitlement snapshot hash");
  if (input.fixtureMintKickoffBefore !== null && !isIsoInstant(input.fixtureMintKickoffBefore)) throw new Error("invalid mint bound");
  return {
    provider: input.provider,
    purpose: input.purpose,
    ingest_version: input.ingestVersion,
    entitlement_snapshot_sha256: input.entitlementSnapshotSha256,
    scope: input.scope,
    fixture_mint_kickoff_before: input.fixtureMintKickoffBefore,
  };
}

// ---------------------------------------------------------------------------
// Provider-ref reconciliation (read only)
// ---------------------------------------------------------------------------

export const PROVIDER_REF_CONFLICT_CODES = [
  "team_mapping_missing",
  "team_mapping_untrusted",
  "team_mapping_drift",
  "competition_mapping_missing",
  "competition_mapping_untrusted",
  "competition_mapping_drift",
  "fixture_competition_drift",
] as const;
export type ProviderRefConflictCode = (typeof PROVIDER_REF_CONFLICT_CODES)[number];

/** One disagreement between a sealed provider ref and today's mappings. */
export type ProviderRefConflict = {
  issue_code: ProviderRefConflictCode;
  observation_id: string;
  observation_version: number;
  is_current_version: boolean;
  fixture_id: string;
  provider_fixture_id: string;
  ref_kind: "league" | "team_home" | "team_away";
  provider_ref: string;
  recorded_canonical_id: string;
  current_canonical_id: string | null;
  current_mapping_status: string | null;
  current_mapping_confidence: number | null;
};

/**
 * Detection only: lists historical observations whose sealed team or league
 * ref no longer agrees with the current mapping under the historical-ingest
 * trust rules. Fixture-mapping drift stays in match_ledger_mapping_conflicts.
 */
export async function loadProviderRefConflicts(rpc: ProviderIngestRpc, provider: string): Promise<ProviderRefConflict[]> {
  if (!PROVIDER.test(provider)) throw new Error("invalid provider");
  const value = await rpc(PROVIDER_INGEST_FUNCTIONS.providerRefConflicts, { p_provider: provider });
  if (!Array.isArray(value)) throw new Error("provider-ref conflicts must be an array");
  return value.map((item, index) => {
    const row = item as Record<string, unknown>;
    if (!(PROVIDER_REF_CONFLICT_CODES as readonly string[]).includes(row.issue_code as string)) {
      throw new Error(`provider-ref conflict ${index} has an unknown issue code`);
    }
    return {
      ...(row as unknown as ProviderRefConflict),
      current_mapping_confidence: row.current_mapping_confidence === null || row.current_mapping_confidence === undefined ? null : Number(row.current_mapping_confidence),
    };
  });
}
