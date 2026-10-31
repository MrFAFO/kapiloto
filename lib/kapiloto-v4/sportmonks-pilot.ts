import {
  SPORTMONKS_LEDGER_STAT_TYPES,
  type SportmonksLedgerCaptureV1,
} from "./sportmonks-ledger";
import {
  PROVIDER_DATA_FAMILIES,
  type ProviderDataFamily,
} from "./provider-ingest";
import { SPORTMONKS_LEDGER_CAPTURE_CONTRACT_VERSION } from "./versions";

/**
 * Read-only Sportmonks A2-B provider-semantics pilot.
 *
 * Important: this module does not decide whether historical backfill is
 * approved. It separates:
 *  - provider/competition identity evidence;
 *  - provider-wide field-semantics evidence;
 *  - per-competition family/stat coverage.
 *
 * Optional or absent data remains missing. An observed contradiction fails;
 * lack of optional evidence is reported as unverified/coverage, never turned
 * into zero and never pooled with evidence from another competition.
 */

export const SPORTMONKS_A2B_TARGET_LEAGUES = [
  { providerLeagueId: "8", expectedName: "Premier League", expectedCountryIso2: "GB", expectedType: "league", expectedSubType: "domestic" },
  { providerLeagueId: "82", expectedName: "Bundesliga", expectedCountryIso2: "DE", expectedType: "league", expectedSubType: "domestic" },
  { providerLeagueId: "564", expectedName: "La Liga", expectedCountryIso2: "ES", expectedType: "league", expectedSubType: "domestic" },
  { providerLeagueId: "384", expectedName: "Serie A", expectedCountryIso2: "IT", expectedType: "league", expectedSubType: "domestic" },
  { providerLeagueId: "372", expectedName: "Ligat ha'Al", expectedCountryIso2: "IL", expectedType: "league", expectedSubType: "domestic" },
] as const;

export const SPORTMONKS_A2B_FIXTURE_INCLUDE =
  "participants;scores;state;lineups;formations;statistics.type;xgfixture.type";

export type PilotGateStatus = "pass" | "fail" | "unverified";

export type PilotGate = {
  status: PilotGateStatus;
  detail: string;
};

export const SPORTMONKS_A2B_GATE_NAMES = [
  "participantLocations",
  "scoreSemantics",
  "lineupTypes",
  "broadPositions",
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
    lineupTypeIds: number[];
    positionIds: number[];
    lineupStarterCounts: { home: number; away: number };
    lineupBenchCounts: { home: number; away: number };
    explicitZeroStatTypes: string[];
    omittedAllowlistedStatTypes: string[];
    presentAllowlistedStatTypes: string[];
    familyRows: Record<ProviderDataFamily, number>;
  };
};

export type GateEvidence = {
  status: PilotGateStatus;
  passFixtures: number;
  failFixtures: number;
  unverifiedFixtures: number;
};

export type SportmonksA2BCompetitionProfile = {
  providerLeagueId: string;
  fixtures: number;
  seasonsObserved: string[];
  gateEvidence: Record<SportmonksA2BGateName, GateEvidence>;
  familyCoverage: Record<ProviderDataFamily, {
    fetchedFixtures: number;
    nonEmptyFixtures: number;
    totalRows: number;
  }>;
  statTypeCoverage: Record<string, {
    fixturesPresent: number;
    fixturesExplicitZero: number;
  }>;
  lineupTypeIds: number[];
  positionIds: number[];
  contradictions: Array<{ fixtureId: string; gate: SportmonksA2BGateName; detail: string }>;
};

export type SportmonksA2BProviderSemantics = {
  status: PilotGateStatus;
  blockers: string[];
  gateEvidence: Record<SportmonksA2BGateName, GateEvidence>;
  lineupTypeIds: number[];
  positionIds: number[];
};

type RecordLike = Record<string, unknown>;

const ALLOWLISTED_STAT_TYPES = SPORTMONKS_LEDGER_STAT_TYPES.map((row) => row.typeId);
const ALLOWLISTED_STAT_TYPE_SET = new Set<string>(ALLOWLISTED_STAT_TYPES);
const EXPECTED_LINEUP_TYPES = [11, 12] as const;
const EXPECTED_POSITIONS = [24, 25, 26, 27] as const;

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

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function sportmonksLeagueNameMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  return normalizeName(actual) === normalizeName(expected);
}

export type SportmonksA2BLeagueIdentity = {
  entitled: boolean;
  providerName: string | null;
  providerCountryId: string | null;
  providerCountryIso2: string | null;
  providerType: string | null;
  providerSubType: string | null;
  providerActive: boolean | null;
  nameMatches: boolean;
  countryMatches: boolean;
  typeMatches: boolean;
  subTypeMatches: boolean;
  identityStatus: "pass" | "fail";
};

export function auditSportmonksA2BLeagueIdentity(input: {
  expectedName: string;
  expectedCountryIso2: string;
  expectedType: string;
  expectedSubType: string;
  actual: {
    name: string | null;
    countryId: string | null;
    countryIso2: string | null;
    type: string | null;
    subType: string | null;
    active: boolean | null;
  } | null;
}): SportmonksA2BLeagueIdentity {
  const actual = input.actual;
  const nameMatches = sportmonksLeagueNameMatches(actual?.name ?? null, input.expectedName);
  const countryMatches = actual?.countryIso2 === input.expectedCountryIso2;
  const typeMatches = actual?.type === input.expectedType;
  const subTypeMatches = actual?.subType === input.expectedSubType;
  const entitled = actual !== null;
  return {
    entitled,
    providerName: actual?.name ?? null,
    providerCountryId: actual?.countryId ?? null,
    providerCountryIso2: actual?.countryIso2 ?? null,
    providerType: actual?.type ?? null,
    providerSubType: actual?.subType ?? null,
    providerActive: actual?.active ?? null,
    nameMatches,
    countryMatches,
    typeMatches,
    subTypeMatches,
    identityStatus:
      entitled && nameMatches && countryMatches && typeMatches && subTypeMatches
        ? "pass"
        : "fail",
  };
}

export function assertSportmonksA2BPaginationComplete(input: {
  label: string;
  page: number;
  cap: number;
  hasMore: boolean;
}): void {
  if (!Number.isInteger(input.page) || !Number.isInteger(input.cap) || input.page < 1 || input.cap < 1) {
    throw new Error("pagination page/cap must be positive integers");
  }
  if (input.page >= input.cap && input.hasMore) {
    throw new Error(
      `${input.label} pagination reached hard cap ${input.cap} while has_more=true; refusing a partial snapshot`,
    );
  }
}

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

  const fixture = input.fixture as RecordLike;
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
      starting_at_timestamp:
        typeof fixture.starting_at_timestamp === "number" ? fixture.starting_at_timestamp : null,
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
      lineups: {
        fetch_status: "fetched",
        rows: familyRows.lineups,
        raw_response_sha256: input.rawPayloadSha256,
      },
      formations: {
        fetch_status: "fetched",
        rows: familyRows.formations,
        raw_response_sha256: input.rawPayloadSha256,
      },
      statistics: {
        fetch_status: "fetched",
        rows: familyRows.statistics,
        raw_response_sha256: input.rawPayloadSha256,
      },
      xg: {
        fetch_status: "fetched",
        rows: familyRows.xg,
        raw_response_sha256: input.rawPayloadSha256,
      },
    },
  };
}

function scorePair(
  scores: unknown[],
  description: string,
): { home: number; away: number } | null {
  const pair: Partial<Record<"home" | "away", number>> = {};
  for (const value of scores) {
    if (!isRecord(value) || String(value.description ?? "").toUpperCase() !== description) continue;
    if (!isRecord(value.score)) continue;
    const side = value.score.participant;
    const goals = value.score.goals;
    if ((side === "home" || side === "away") && typeof goals === "number" && Number.isInteger(goals)) {
      pair[side] = goals;
    }
  }
  return typeof pair.home === "number" && typeof pair.away === "number"
    ? { home: pair.home, away: pair.away }
    : null;
}

function statRows(capture: SportmonksLedgerCaptureV1): Array<RecordLike & { family: "statistics" | "xg" }> {
  return (["statistics", "xg"] as const).flatMap((family) =>
    capture.families[family].rows
      .filter(isRecord)
      .map((row) => ({ ...row, family })),
  );
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

function valuesBySideAndType(capture: SportmonksLedgerCaptureV1): Map<string, number> {
  const sides = sideByParticipant(capture);
  const result = new Map<string, number>();
  for (const row of statRows(capture)) {
    const participant = asProviderId(row.participant_id);
    const side = participant ? sides.get(participant) : undefined;
    const typeId = asProviderId(row.type_id);
    const data = isRecord(row.data) ? row.data : {};
    const value = asFiniteNumber(data.value);
    if (side && typeId && value !== null) result.set(`${side}:${typeId}`, value);
  }
  return result;
}

function relationGate(
  checks: Array<boolean | null>,
  passDetail: string,
  failDetail: string,
  unverifiedDetail: string,
): PilotGate {
  if (checks.some((value) => value === false)) return { status: "fail", detail: failDetail };
  if (checks.some((value) => value === true)) return { status: "pass", detail: passDetail };
  return { status: "unverified", detail: unverifiedDetail };
}

export function auditSportmonksA2BCapture(
  capture: SportmonksLedgerCaptureV1,
): SportmonksA2BFixtureAudit {
  const providerFixtureId = String(capture.fixture.id);
  const providerLeagueId = String(capture.fixture.league_id);
  const providerSeasonId = String(capture.fixture.season_id);
  const locations = capture.fixture.participants
    .map((participant) => participant.meta?.location)
    .filter((value): value is string => typeof value === "string")
    .sort();

  const participantLocations: PilotGate =
    capture.fixture.participants.length === 2 && locations.join(",") === "away,home"
      ? { status: "pass", detail: "Exactly one home and one away participant." }
      : { status: "fail", detail: `Expected home+away participant locations; observed ${locations.join(",") || "none"}.` };

  const state = capture.fixture.state?.developer_name ?? "";
  const scores = capture.fixture.scores as unknown[];
  const secondHalf = scorePair(scores, "2ND_HALF");
  const current = scorePair(scores, "CURRENT");
  let scoreSemantics: PilotGate;
  if (state === "FT") {
    if (!secondHalf || !current) {
      scoreSemantics = { status: "unverified", detail: "FT did not expose both cumulative 2ND_HALF and CURRENT score pairs." };
    } else if (secondHalf.home === current.home && secondHalf.away === current.away) {
      scoreSemantics = { status: "pass", detail: "FT has equal cumulative 2ND_HALF and CURRENT scores." };
    } else {
      scoreSemantics = { status: "fail", detail: "FT 2ND_HALF and CURRENT scores disagree." };
    }
  } else if (state === "AET" || state === "FT_PEN") {
    if (!secondHalf || !current) {
      scoreSemantics = { status: "unverified", detail: `${state} did not expose both 2ND_HALF and CURRENT score pairs.` };
    } else if (current.home < secondHalf.home || current.away < secondHalf.away) {
      scoreSemantics = { status: "fail", detail: `${state} CURRENT score is lower than the cumulative 90-minute 2ND_HALF score.` };
    } else {
      scoreSemantics = { status: "pass", detail: `${state} exposes 2ND_HALF at 90 minutes and a non-decreasing CURRENT score after extra time.` };
    }
  } else {
    scoreSemantics = { status: "unverified", detail: `Fixture state ${state || "unknown"} is not a finished pilot state.` };
  }

  const sideMap = sideByParticipant(capture);
  const lineupRows = capture.families.lineups.rows.filter(isRecord);
  const lineupTypeIds = [...new Set(
    lineupRows
      .map((row) => (typeof row.type_id === "number" && Number.isInteger(row.type_id) ? row.type_id : null))
      .filter((value): value is number => value !== null),
  )].sort((a, b) => a - b);
  const unknownLineupTypes = lineupTypeIds.filter((id) => !EXPECTED_LINEUP_TYPES.includes(id as (typeof EXPECTED_LINEUP_TYPES)[number]));
  const starterCounts = { home: 0, away: 0 };
  const benchCounts = { home: 0, away: 0 };
  let lineupUnknownTeam = false;
  for (const row of lineupRows) {
    const teamId = asProviderId(row.team_id);
    const side = teamId ? sideMap.get(teamId) : undefined;
    if (!side) {
      lineupUnknownTeam = true;
      continue;
    }
    if (row.type_id === 11) starterCounts[side] += 1;
    if (row.type_id === 12) benchCounts[side] += 1;
  }
  const lineupTypes: PilotGate =
    lineupUnknownTeam || unknownLineupTypes.length > 0
      ? { status: "fail", detail: `Unexpected lineup team/type ids: ${unknownLineupTypes.join(",") || "unknown participant"}.` }
      : lineupRows.length === 0
        ? { status: "unverified", detail: "No lineup rows were returned." }
        : starterCounts.home === 11 && starterCounts.away === 11 && benchCounts.home > 0 && benchCounts.away > 0
          ? { status: "pass", detail: "Both teams expose exactly 11 type_id=11 starters and one or more type_id=12 bench players." }
          : {
              status: "fail",
              detail: `Expected 11 starters and bench rows per side; observed starters ${starterCounts.home}/${starterCounts.away}, bench ${benchCounts.home}/${benchCounts.away}.`,
            };

  const positionIds = [...new Set(
    lineupRows
      .map((row) => (typeof row.position_id === "number" && Number.isInteger(row.position_id) ? row.position_id : null))
      .filter((value): value is number => value !== null),
  )].sort((a, b) => a - b);
  const unknownPositions = positionIds.filter((id) => !EXPECTED_POSITIONS.includes(id as (typeof EXPECTED_POSITIONS)[number]));
  const broadPositions: PilotGate =
    unknownPositions.length > 0
      ? { status: "fail", detail: `Unexpected broad position ids: ${unknownPositions.join(",")}.` }
      : positionIds.length > 0
        ? { status: "pass", detail: `Observed only verified broad position ids: ${positionIds.join(",")}.` }
        : { status: "unverified", detail: "No broad position ids were observed." };

  const values = valuesBySideAndType(capture);
  const possessionValues = ["home", "away"].map((side) => values.get(`${side}:45`) ?? null);
  const possessionSum = possessionValues.every((value): value is number => value !== null)
    ? possessionValues[0] + possessionValues[1]
    : null;
  const possessionGate: PilotGate =
    possessionSum === null
      ? { status: "unverified", detail: "Possession was not present for both sides." }
      : possessionSum >= 98 && possessionSum <= 102
        ? { status: "pass", detail: `Possession sums to ${possessionSum}.` }
        : { status: "fail", detail: `Possession sums to ${possessionSum}, outside 98-102.` };

  const shotChecks = (["home", "away"] as const).map((side) => {
    const total = values.get(`${side}:42`);
    const onTarget = values.get(`${side}:86`);
    return total === undefined || onTarget === undefined ? null : onTarget <= total;
  });
  const shotsOnTarget = relationGate(
    shotChecks,
    "Observed shots_on_target <= shots_total.",
    "Observed shots_on_target > shots_total.",
    "Could not compare shots_on_target with shots_total.",
  );

  const npxgChecks = (["home", "away"] as const).map((side) => {
    const xg = values.get(`${side}:5304`);
    const npxg = values.get(`${side}:7943`);
    return xg === undefined || npxg === undefined ? null : npxg <= xg + 1e-9;
  });
  const nonPenaltyXg = relationGate(
    npxgChecks,
    "Observed non-penalty xG <= xG.",
    "Observed non-penalty xG > xG.",
    "Could not compare non-penalty xG with xG.",
  );

  const presentKeys = new Set<string>();
  const presentAllowlistedStatTypes = new Set<string>();
  const explicitZeroStatTypes = new Set<string>();
  for (const row of statRows(capture)) {
    const team = asProviderId(row.participant_id);
    const side = team ? sideMap.get(team) : undefined;
    const typeId = asProviderId(row.type_id);
    if (!side || !typeId || !ALLOWLISTED_STAT_TYPE_SET.has(typeId)) continue;
    presentKeys.add(`${side}:${typeId}`);
    presentAllowlistedStatTypes.add(typeId);
    const value = asFiniteNumber(isRecord(row.data) ? row.data.value : undefined);
    if (value === 0) explicitZeroStatTypes.add(typeId);
  }
  const omittedAllowlistedStatTypes = new Set<string>();
  for (const side of ["home", "away"] as const) {
    for (const typeId of ALLOWLISTED_STAT_TYPES) {
      if (!presentKeys.has(`${side}:${typeId}`)) omittedAllowlistedStatTypes.add(typeId);
    }
  }

  return {
    providerFixtureId,
    providerLeagueId,
    providerSeasonId,
    gates: {
      participantLocations,
      scoreSemantics,
      lineupTypes,
      broadPositions,
      possessionSum: possessionGate,
      shotsOnTarget,
      nonPenaltyXg,
    },
    observed: {
      lineupTypeIds,
      positionIds,
      lineupStarterCounts: starterCounts,
      lineupBenchCounts: benchCounts,
      explicitZeroStatTypes: [...explicitZeroStatTypes].sort(),
      omittedAllowlistedStatTypes: [...omittedAllowlistedStatTypes].sort(),
      presentAllowlistedStatTypes: [...presentAllowlistedStatTypes].sort(),
      familyRows: Object.fromEntries(
        PROVIDER_DATA_FAMILIES.map((family) => [family, capture.families[family].rows.length]),
      ) as Record<ProviderDataFamily, number>,
    },
  };
}

function summarizeOneGate(
  audits: readonly SportmonksA2BFixtureAudit[],
  name: SportmonksA2BGateName,
): GateEvidence {
  const statuses = audits.map((audit) => audit.gates[name].status);
  const passFixtures = statuses.filter((status) => status === "pass").length;
  const failFixtures = statuses.filter((status) => status === "fail").length;
  const unverifiedFixtures = statuses.filter((status) => status === "unverified").length;
  const status: PilotGateStatus =
    failFixtures > 0 ? "fail" : passFixtures > 0 && unverifiedFixtures === 0 ? "pass" : "unverified";
  return { status, passFixtures, failFixtures, unverifiedFixtures };
}

export function summarizeSportmonksA2BGateEvidence(
  audits: readonly SportmonksA2BFixtureAudit[],
): Record<SportmonksA2BGateName, GateEvidence> {
  return Object.fromEntries(
    SPORTMONKS_A2B_GATE_NAMES.map((name) => [name, summarizeOneGate(audits, name)]),
  ) as Record<SportmonksA2BGateName, GateEvidence>;
}

/**
 * Provider-wide semantics are evidence about field meanings only. They are not
 * a per-competition coverage or backfill-approval signal.
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

  const unknownLineupTypes = lineupTypeIds.filter((id) => !EXPECTED_LINEUP_TYPES.includes(id as (typeof EXPECTED_LINEUP_TYPES)[number]));
  if (unknownLineupTypes.length > 0) blockers.push(`unknown lineup type ids: ${unknownLineupTypes.join(",")}`);
  if (!EXPECTED_LINEUP_TYPES.every((id) => lineupTypeIds.includes(id))) blockers.push("provider-wide sample did not discriminate both lineup type ids 11/12");

  const unknownPositions = positionIds.filter((id) => !EXPECTED_POSITIONS.includes(id as (typeof EXPECTED_POSITIONS)[number]));
  if (unknownPositions.length > 0) blockers.push(`unknown broad position ids: ${unknownPositions.join(",")}`);
  if (!EXPECTED_POSITIONS.every((id) => positionIds.includes(id))) blockers.push("provider-wide sample did not cover broad position ids 24/25/26/27");

  const status: PilotGateStatus =
    blockers.length > 0
      ? "fail"
      : audits.length > 0
        ? "pass"
        : "unverified";

  return { status, blockers, gateEvidence, lineupTypeIds, positionIds };
}

export function buildSportmonksA2BCompetitionProfile(
  providerLeagueId: string,
  audits: readonly SportmonksA2BFixtureAudit[],
): SportmonksA2BCompetitionProfile {
  const filtered = audits.filter((audit) => audit.providerLeagueId === providerLeagueId);
  const familyCoverage = Object.fromEntries(
    PROVIDER_DATA_FAMILIES.map((family) => {
      const rowCounts = filtered.map((audit) => audit.observed.familyRows[family]);
      return [family, {
        fetchedFixtures: filtered.length,
        nonEmptyFixtures: rowCounts.filter((rows) => rows > 0).length,
        totalRows: rowCounts.reduce((sum, rows) => sum + rows, 0),
      }];
    }),
  ) as SportmonksA2BCompetitionProfile["familyCoverage"];

  const statTypeCoverage = Object.fromEntries(
    ALLOWLISTED_STAT_TYPES.map((typeId) => [
      typeId,
      {
        fixturesPresent: filtered.filter((audit) => audit.observed.presentAllowlistedStatTypes.includes(typeId)).length,
        fixturesExplicitZero: filtered.filter((audit) => audit.observed.explicitZeroStatTypes.includes(typeId)).length,
      },
    ]),
  );

  return {
    providerLeagueId,
    fixtures: filtered.length,
    seasonsObserved: [...new Set(filtered.map((audit) => audit.providerSeasonId))].sort(),
    gateEvidence: summarizeSportmonksA2BGateEvidence(filtered),
    familyCoverage,
    statTypeCoverage,
    lineupTypeIds: [...new Set(filtered.flatMap((audit) => audit.observed.lineupTypeIds))].sort((a, b) => a - b),
    positionIds: [...new Set(filtered.flatMap((audit) => audit.observed.positionIds))].sort((a, b) => a - b),
    contradictions: filtered.flatMap((audit) =>
      SPORTMONKS_A2B_GATE_NAMES.flatMap((gate) =>
        audit.gates[gate].status === "fail"
          ? [{ fixtureId: audit.providerFixtureId, gate, detail: audit.gates[gate].detail }]
          : [],
      ),
    ),
  };
}
