import type { SportmonksLedgerCaptureV1 } from "./sportmonks-ledger";
import { SPORTMONKS_LEDGER_CAPTURE_CONTRACT_VERSION } from "./versions";

export const SPORTMONKS_A2B_TARGET_LEAGUES = [
  { providerLeagueId: "8", expectedName: "Premier League", expectedCountry: "England" },
  { providerLeagueId: "82", expectedName: "Bundesliga", expectedCountry: "Germany" },
  { providerLeagueId: "564", expectedName: "La Liga", expectedCountry: "Spain" },
  { providerLeagueId: "384", expectedName: "Serie A", expectedCountry: "Italy" },
  { providerLeagueId: "372", expectedName: "Ligat ha'Al", expectedCountry: "Israel" },
] as const;

export const SPORTMONKS_A2B_FIXTURE_INCLUDE =
  "participants;scores;state;lineups;formations;statistics.type;xgfixture.type";

export type PilotGateStatus = "pass" | "fail" | "unverified";

export type PilotGate = {
  status: PilotGateStatus;
  detail: string;
};

export type SportmonksTargetLeague = (typeof SPORTMONKS_A2B_TARGET_LEAGUES)[number];

export type SportmonksLeagueIdentityAudit = {
  providerLeagueId: string;
  gates: {
    id: PilotGate;
    name: PilotGate;
    country: PilotGate;
    type: PilotGate;
    currentSeason: PilotGate;
  };
  observed: {
    name: string | null;
    country: string | null;
    type: string | null;
    subType: string | null;
    currentSeasonId: string | null;
    currentSeasonName: string | null;
  };
};

export type SportmonksA2BFixtureAudit = {
  providerFixtureId: string;
  providerLeagueId: string;
  providerSeasonId: string;
  gates: {
    participantLocations: PilotGate;
    scoreSemantics: PilotGate;
    lineupTypes: PilotGate;
    lineupParticipants: PilotGate;
    lineupStarterCounts: PilotGate;
    broadPositions: PilotGate;
    formationSemantics: PilotGate;
    possessionSum: PilotGate;
    shotsOnTarget: PilotGate;
    nonPenaltyXg: PilotGate;
    explicitZero: PilotGate;
  };
  observed: {
    familyRows: Record<"lineups" | "formations" | "statistics" | "xg", number>;
    lineupTypeIds: number[];
    positionIds: number[];
    startersBySide: { home: number; away: number };
    explicitZeroStatTypes: string[];
    omittedAllowlistedStatTypes: string[];
  };
};

export type SportmonksFamilyCoverage = {
  sampledFixtures: number;
  fixturesWithRows: number;
  fixturesEmpty: number;
  totalRows: number;
  coverageRatio: number;
};

export type SportmonksSeasonCoverageProfile = {
  providerLeagueId: string;
  providerSeasonId: string;
  seasonName: string | null;
  sampledFixtures: number;
  parsePasses: number;
  parseFailures: number;
  semanticFailures: number;
  completeLineupFixtures: number;
  pairedFormationFixtures: number;
  families: Record<"lineups" | "formations" | "statistics" | "xg", SportmonksFamilyCoverage>;
  observedPositionIds: number[];
  observedLineupTypeIds: number[];
  gateSummary: Record<keyof SportmonksA2BFixtureAudit["gates"], PilotGateStatus>;
};

type RecordLike = Record<string, unknown>;

const ALLOWLISTED_STAT_TYPES = ["34", "42", "45", "86", "5304", "5305", "7943"] as const;
const BROAD_POSITION_IDS = [24, 25, 26, 27] as const;
const FORMATION_PATTERN = /^[1-6](-[1-6]){1,5}$/;

export const SPORTMONKS_A2B_ACCEPTANCE_GATES = [
  "participantLocations",
  "scoreSemantics",
  "lineupTypes",
  "lineupParticipants",
  "lineupStarterCounts",
  "broadPositions",
  "formationSemantics",
  "possessionSum",
  "shotsOnTarget",
  "nonPenaltyXg",
] as const satisfies readonly (keyof SportmonksA2BFixtureAudit["gates"])[];

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
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function sportmonksLeagueNameMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  return normalizeName(actual) === normalizeName(expected);
}

export function auditSportmonksLeagueIdentity(
  rawLeague: unknown,
  target: SportmonksTargetLeague,
): SportmonksLeagueIdentityAudit {
  const league = isRecord(rawLeague) ? rawLeague : {};
  const country = isRecord(league.country) ? league.country : {};
  const currentSeason = isRecord(league.currentseason)
    ? league.currentseason
    : isRecord(league.currentSeason)
      ? league.currentSeason
      : {};

  const id = asProviderId(league.id);
  const actualName = typeof league.name === "string" ? league.name : null;
  const actualCountry = typeof country.name === "string" ? country.name : null;
  const type = typeof league.type === "string" ? league.type : null;
  const subType = typeof league.sub_type === "string" ? league.sub_type : null;
  const currentSeasonId = asProviderId(currentSeason.id);
  const currentSeasonLeagueId = asProviderId(currentSeason.league_id);
  const currentSeasonName =
    typeof currentSeason.name === "string" ? currentSeason.name : null;
  const currentSeasonIsCurrent = currentSeason.is_current;

  return {
    providerLeagueId: target.providerLeagueId,
    gates: {
      id:
        id === target.providerLeagueId
          ? { status: "pass", detail: `League id is ${id}.` }
          : {
              status: "fail",
              detail: `Expected league id ${target.providerLeagueId}; observed ${id ?? "none"}.`,
            },
      name:
        sportmonksLeagueNameMatches(actualName, target.expectedName)
          ? { status: "pass", detail: `League name matches ${target.expectedName}.` }
          : {
              status: "fail",
              detail: `Expected league name ${target.expectedName}; observed ${actualName ?? "none"}.`,
            },
      country:
        actualCountry && normalizeName(actualCountry) === normalizeName(target.expectedCountry)
          ? { status: "pass", detail: `League country is ${actualCountry}.` }
          : {
              status: "fail",
              detail: `Expected country ${target.expectedCountry}; observed ${actualCountry ?? "none"}.`,
            },
      type:
        type === "league" && (subType === "domestic" || subType === null)
          ? {
              status: "pass",
              detail: `Competition type is league${subType ? `/${subType}` : ""}.`,
            }
          : {
              status: "fail",
              detail: `Expected domestic league; observed type=${type ?? "none"}, sub_type=${subType ?? "none"}.`,
            },
      currentSeason:
        currentSeasonId &&
        currentSeasonLeagueId === target.providerLeagueId &&
        currentSeasonIsCurrent === true
          ? {
              status: "pass",
              detail: `Current season ${currentSeasonId} (${currentSeasonName ?? "unnamed"}) belongs to the target league.`,
            }
          : {
              status: "fail",
              detail: `Current-season identity mismatch: id=${currentSeasonId ?? "none"}, league_id=${currentSeasonLeagueId ?? "none"}, is_current=${String(currentSeasonIsCurrent)}.`,
            },
    },
    observed: {
      name: actualName,
      country: actualCountry,
      type,
      subType,
      currentSeasonId,
      currentSeasonName,
    },
  };
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
        ? {
            developer_name:
              typeof fixture.state.developer_name === "string"
                ? fixture.state.developer_name
                : null,
          }
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
      neutral_venue:
        typeof fixture.neutral_venue === "boolean" ? fixture.neutral_venue : null,
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
    if (
      !isRecord(value) ||
      String(value.description ?? "").toUpperCase() !== description ||
      !isRecord(value.score)
    ) {
      continue;
    }
    const side = value.score.participant;
    const goals = value.score.goals;
    if (
      (side === "home" || side === "away") &&
      typeof goals === "number" &&
      Number.isInteger(goals) &&
      goals >= 0
    ) {
      if (pair[side] !== undefined && pair[side] !== goals) return null;
      pair[side] = goals;
    }
  }
  return typeof pair.home === "number" && typeof pair.away === "number"
    ? { home: pair.home, away: pair.away }
    : null;
}

function gateFromChecks(
  checks: Array<boolean | null>,
  passDetail: string,
  failDetail: string,
  unverifiedDetail: string,
): PilotGate {
  if (checks.some((value) => value === false)) return { status: "fail", detail: failDetail };
  if (checks.some((value) => value === true)) return { status: "pass", detail: passDetail };
  return { status: "unverified", detail: unverifiedDetail };
}

function statRows(
  capture: SportmonksLedgerCaptureV1,
): Array<RecordLike & { family: "statistics" | "xg" }> {
  return (["statistics", "xg"] as const).flatMap((family) =>
    capture.families[family].rows
      .filter(isRecord)
      .map((row) => ({ ...row, family })),
  );
}

function sideByParticipant(
  capture: SportmonksLedgerCaptureV1,
): Map<string, "home" | "away"> {
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

export function auditSportmonksA2BCapture(
  capture: SportmonksLedgerCaptureV1,
): SportmonksA2BFixtureAudit {
  const providerFixtureId = String(capture.fixture.id);
  const providerLeagueId = String(capture.fixture.league_id);
  const providerSeasonId = String(capture.fixture.season_id);
  const sides = sideByParticipant(capture);
  const locations = capture.fixture.participants
    .map((participant) => participant.meta?.location)
    .filter((value): value is string => typeof value === "string")
    .sort();

  const participantLocations: PilotGate =
    capture.fixture.participants.length === 2 &&
    locations.join(",") === "away,home" &&
    sides.size === 2
      ? { status: "pass", detail: "Exactly one home and one away participant." }
      : {
          status: "fail",
          detail: `Expected exactly one home and one away participant; observed ${locations.join(",") || "none"}.`,
        };

  const state = capture.fixture.state?.developer_name ?? "";
  const scores = capture.fixture.scores as unknown[];
  const secondHalf = scorePair(scores, "2ND_HALF");
  const current = scorePair(scores, "CURRENT");
  let scoreSemantics: PilotGate;
  if (state === "FT") {
    if (!secondHalf && !current) {
      scoreSemantics = {
        status: "fail",
        detail: "FT fixture exposes neither 2ND_HALF nor CURRENT score pair.",
      };
    } else if (
      secondHalf &&
      current &&
      (secondHalf.home !== current.home || secondHalf.away !== current.away)
    ) {
      scoreSemantics = {
        status: "fail",
        detail: "FT 2ND_HALF and CURRENT score pairs disagree.",
      };
    } else {
      scoreSemantics = {
        status: "pass",
        detail: `FT score is usable from ${secondHalf && current ? "matching 2ND_HALF/CURRENT" : secondHalf ? "2ND_HALF" : "CURRENT"}.`,
      };
    }
  } else if (state === "AET" || state === "FT_PEN") {
    const monotonic =
      secondHalf &&
      current &&
      current.home >= secondHalf.home &&
      current.away >= secondHalf.away;
    scoreSemantics =
      secondHalf && current && monotonic
        ? {
            status: "pass",
            detail: `${state} exposes 90-minute and post-extra-time scores without decreasing goals.`,
          }
        : {
            status: "fail",
            detail: `${state} is missing a required score pair or has non-monotonic extra-time scoring.`,
          };
  } else {
    scoreSemantics = {
      status: "unverified",
      detail: `Fixture state ${state || "unknown"} is not a finished pilot state.`,
    };
  }

  const lineupRows = capture.families.lineups.rows.filter(isRecord);
  const lineupTypeIds = [
    ...new Set(
      lineupRows
        .map((row) =>
          typeof row.type_id === "number" && Number.isInteger(row.type_id)
            ? row.type_id
            : null,
        )
        .filter((value): value is number => value !== null),
    ),
  ].sort((a, b) => a - b);
  const unknownLineupTypes = lineupTypeIds.filter((id) => id !== 11 && id !== 12);
  const lineupTypes: PilotGate =
    lineupRows.length === 0
      ? { status: "unverified", detail: "No lineup rows were returned." }
      : unknownLineupTypes.length > 0
        ? {
            status: "fail",
            detail: `Unexpected lineup type ids: ${unknownLineupTypes.join(",")}.`,
          }
        : lineupTypeIds.includes(11)
          ? {
              status: "pass",
              detail: `Observed supported lineup type ids: ${lineupTypeIds.join(",")}.`,
            }
          : {
              status: "fail",
              detail: `Lineup rows were present but no starter type_id 11 was observed.`,
            };

  const seenPlayers = new Set<string>();
  let duplicatePlayer = false;
  let unknownTeam = false;
  const startersBySide = { home: 0, away: 0 };
  for (const row of lineupRows) {
    const playerId = asProviderId(row.player_id);
    const teamId = asProviderId(row.team_id);
    if (playerId) {
      if (seenPlayers.has(playerId)) duplicatePlayer = true;
      seenPlayers.add(playerId);
    }
    const side = teamId ? sides.get(teamId) : undefined;
    if (!side) {
      unknownTeam = true;
      continue;
    }
    if (row.type_id === 11) startersBySide[side] += 1;
  }

  const lineupParticipants: PilotGate =
    lineupRows.length === 0
      ? { status: "unverified", detail: "No lineup rows were returned." }
      : unknownTeam || duplicatePlayer
        ? {
            status: "fail",
            detail: `Lineup integrity failure: unknownTeam=${unknownTeam}, duplicatePlayer=${duplicatePlayer}.`,
          }
        : {
            status: "pass",
            detail: "All lineup rows belong to fixture participants and player ids are unique.",
          };

  const lineupStarterCounts: PilotGate =
    lineupRows.length === 0
      ? { status: "unverified", detail: "No lineup rows were returned." }
      : startersBySide.home > 11 || startersBySide.away > 11
        ? {
            status: "fail",
            detail: `Starter counts exceed 11: home=${startersBySide.home}, away=${startersBySide.away}.`,
          }
        : startersBySide.home === 11 && startersBySide.away === 11
          ? {
              status: "pass",
              detail: "Both teams expose exactly 11 starters.",
            }
          : {
              status: "unverified",
              detail: `Partial lineup: home starters=${startersBySide.home}, away starters=${startersBySide.away}.`,
            };

  const positionIds = [
    ...new Set(
      lineupRows
        .map((row) =>
          typeof row.position_id === "number" && Number.isInteger(row.position_id)
            ? row.position_id
            : null,
        )
        .filter((value): value is number => value !== null),
    ),
  ].sort((a, b) => a - b);
  const unknownPositions = positionIds.filter(
    (id) => !BROAD_POSITION_IDS.includes(id as (typeof BROAD_POSITION_IDS)[number]),
  );
  const broadPositions: PilotGate =
    lineupRows.length === 0
      ? { status: "unverified", detail: "No lineup rows were returned." }
      : unknownPositions.length > 0
        ? {
            status: "fail",
            detail: `Unexpected broad position ids: ${unknownPositions.join(",")}.`,
          }
        : BROAD_POSITION_IDS.every((id) => positionIds.includes(id))
          ? {
              status: "pass",
              detail: "Observed all broad position ids 24/25/26/27.",
            }
          : {
              status: "unverified",
              detail: `Observed supported positions ${positionIds.join(",") || "none"}, but not all 24/25/26/27.`,
            };

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
      ? { status: "unverified", detail: "No formation rows were returned." }
      : invalidFormation
        ? {
            status: "fail",
            detail: "Formation rows contain an unknown participant or invalid formation string.",
          }
        : formationSides.size === 2
          ? {
              status: "pass",
              detail: "Valid nominal formations were returned for both participants.",
            }
          : {
              status: "unverified",
              detail: "Valid formation data was returned for only one participant.",
            };

  const values = valuesBySideAndType(capture);
  const possessionValues = ["home", "away"].map(
    (side) => values.get(`${side}:45`) ?? null,
  );
  const possessionSum = possessionValues.every(
    (value): value is number => value !== null,
  )
    ? possessionValues[0] + possessionValues[1]
    : null;
  const possessionGate: PilotGate =
    possessionSum === null
      ? { status: "unverified", detail: "Possession was not present for both sides." }
      : possessionSum >= 98 && possessionSum <= 102
        ? { status: "pass", detail: `Possession sums to ${possessionSum}.` }
        : {
            status: "fail",
            detail: `Possession sums to ${possessionSum}, outside 98-102.`,
          };

  const shotChecks = (["home", "away"] as const).map((side) => {
    const total = values.get(`${side}:42`);
    const onTarget = values.get(`${side}:86`);
    return total === undefined || onTarget === undefined ? null : onTarget <= total;
  });
  const shotsOnTarget = gateFromChecks(
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
  const nonPenaltyXg = gateFromChecks(
    npxgChecks,
    "Observed non-penalty xG <= xG.",
    "Observed non-penalty xG > xG.",
    "Could not compare non-penalty xG with xG.",
  );

  const presentKeys = new Set<string>();
  const explicitZeroStatTypes = new Set<string>();
  for (const row of statRows(capture)) {
    const team = asProviderId(row.participant_id);
    const side = team ? sides.get(team) : undefined;
    const typeId = asProviderId(row.type_id);
    if (
      !side ||
      !typeId ||
      !ALLOWLISTED_STAT_TYPES.includes(
        typeId as (typeof ALLOWLISTED_STAT_TYPES)[number],
      )
    ) {
      continue;
    }
    presentKeys.add(`${side}:${typeId}`);
    const value = asFiniteNumber(isRecord(row.data) ? row.data.value : undefined);
    if (value === 0) explicitZeroStatTypes.add(typeId);
  }
  const omittedAllowlistedStatTypes = new Set<string>();
  for (const side of ["home", "away"] as const) {
    for (const typeId of ALLOWLISTED_STAT_TYPES) {
      if (!presentKeys.has(`${side}:${typeId}`)) omittedAllowlistedStatTypes.add(typeId);
    }
  }
  const explicitZero: PilotGate =
    explicitZeroStatTypes.size > 0
      ? {
          status: "pass",
          detail: `Observed explicit numeric zero for type ids ${[...explicitZeroStatTypes].sort().join(",")}.`,
        }
      : {
          status: "unverified",
          detail: "No allow-listed explicit zero occurred in this fixture; this is diagnostic only.",
        };

  return {
    providerFixtureId,
    providerLeagueId,
    providerSeasonId,
    gates: {
      participantLocations,
      scoreSemantics,
      lineupTypes,
      lineupParticipants,
      lineupStarterCounts,
      broadPositions,
      formationSemantics,
      possessionSum: possessionGate,
      shotsOnTarget,
      nonPenaltyXg,
      explicitZero,
    },
    observed: {
      familyRows: {
        lineups: capture.families.lineups.rows.length,
        formations: capture.families.formations.rows.length,
        statistics: capture.families.statistics.rows.length,
        xg: capture.families.xg.rows.length,
      },
      lineupTypeIds,
      positionIds,
      startersBySide,
      explicitZeroStatTypes: [...explicitZeroStatTypes].sort(),
      omittedAllowlistedStatTypes: [...omittedAllowlistedStatTypes].sort(),
    },
  };
}

export function pilotAcceptanceFailures(
  audit: SportmonksA2BFixtureAudit,
): Array<keyof SportmonksA2BFixtureAudit["gates"]> {
  return SPORTMONKS_A2B_ACCEPTANCE_GATES.filter(
    (name) => audit.gates[name].status === "fail",
  );
}

export function summarizeSportmonksA2BGates(
  audits: readonly SportmonksA2BFixtureAudit[],
): Record<keyof SportmonksA2BFixtureAudit["gates"], PilotGateStatus> {
  const names = [
    ...SPORTMONKS_A2B_ACCEPTANCE_GATES,
    "explicitZero",
  ] as const;

  return Object.fromEntries(
    names.map((name) => {
      const statuses = audits.map((audit) => audit.gates[name].status);
      const status: PilotGateStatus = statuses.includes("fail")
        ? "fail"
        : statuses.includes("pass")
          ? "pass"
          : "unverified";
      return [name, status];
    }),
  ) as Record<keyof SportmonksA2BFixtureAudit["gates"], PilotGateStatus>;
}

export function buildSportmonksSeasonCoverageProfile(input: {
  providerLeagueId: string;
  providerSeasonId: string;
  seasonName: string | null;
  audits: readonly SportmonksA2BFixtureAudit[];
  parseStatuses: readonly ("pass" | "fail")[];
}): SportmonksSeasonCoverageProfile {
  if (input.audits.length !== input.parseStatuses.length) {
    throw new Error("Coverage profile requires one parse status per fixture audit.");
  }
  const families = ["lineups", "formations", "statistics", "xg"] as const;
  const familyProfiles = Object.fromEntries(
    families.map((family) => {
      const counts = input.audits.map((audit) => audit.observed.familyRows[family]);
      const fixturesWithRows = counts.filter((count) => count > 0).length;
      const sampledFixtures = counts.length;
      return [
        family,
        {
          sampledFixtures,
          fixturesWithRows,
          fixturesEmpty: sampledFixtures - fixturesWithRows,
          totalRows: counts.reduce((sum, count) => sum + count, 0),
          coverageRatio:
            sampledFixtures === 0 ? 0 : Number((fixturesWithRows / sampledFixtures).toFixed(4)),
        },
      ];
    }),
  ) as SportmonksSeasonCoverageProfile["families"];

  const semanticFailures = input.audits.filter(
    (audit) => pilotAcceptanceFailures(audit).length > 0,
  ).length;

  return {
    providerLeagueId: input.providerLeagueId,
    providerSeasonId: input.providerSeasonId,
    seasonName: input.seasonName,
    sampledFixtures: input.audits.length,
    parsePasses: input.parseStatuses.filter((status) => status === "pass").length,
    parseFailures: input.parseStatuses.filter((status) => status === "fail").length,
    semanticFailures,
    completeLineupFixtures: input.audits.filter(
      (audit) =>
        audit.observed.startersBySide.home === 11 &&
        audit.observed.startersBySide.away === 11,
    ).length,
    pairedFormationFixtures: input.audits.filter(
      (audit) => audit.gates.formationSemantics.status === "pass",
    ).length,
    families: familyProfiles,
    observedPositionIds: [
      ...new Set(input.audits.flatMap((audit) => audit.observed.positionIds)),
    ].sort((a, b) => a - b),
    observedLineupTypeIds: [
      ...new Set(input.audits.flatMap((audit) => audit.observed.lineupTypeIds)),
    ].sort((a, b) => a - b),
    gateSummary: summarizeSportmonksA2BGates(input.audits),
  };
}
