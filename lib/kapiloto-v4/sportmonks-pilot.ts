import type { SportmonksLedgerCaptureV1 } from "./sportmonks-ledger";
import { SPORTMONKS_LEDGER_CAPTURE_CONTRACT_VERSION } from "./versions";

export const SPORTMONKS_A2B_TARGET_LEAGUES = [
  { providerLeagueId: "8", expectedName: "Premier League" },
  { providerLeagueId: "82", expectedName: "Bundesliga" },
  { providerLeagueId: "564", expectedName: "La Liga" },
  { providerLeagueId: "384", expectedName: "Serie A" },
  { providerLeagueId: "372", expectedName: "Ligat ha'Al" },
] as const;

export const SPORTMONKS_A2B_FIXTURE_INCLUDE =
  "participants;scores;state;lineups;formations;statistics.type;xgfixture.type";

export type PilotGateStatus = "pass" | "fail" | "unverified";

export type PilotGate = {
  status: PilotGateStatus;
  detail: string;
};

export type SportmonksA2BFixtureAudit = {
  providerFixtureId: string;
  providerLeagueId: string;
  gates: {
    participantLocations: PilotGate;
    scoreSemantics: PilotGate;
    lineupTypes: PilotGate;
    broadPositions: PilotGate;
    possessionSum: PilotGate;
    shotsOnTarget: PilotGate;
    nonPenaltyXg: PilotGate;
    explicitZero: PilotGate;
  };
  observed: {
    lineupTypeIds: number[];
    positionIds: number[];
    explicitZeroStatTypes: string[];
    omittedAllowlistedStatTypes: string[];
  };
};

type RecordLike = Record<string, unknown>;

const ALLOWLISTED_STAT_TYPES = ["34", "42", "45", "86", "5304", "5305", "7943"] as const;

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

export function auditSportmonksA2BCapture(
  capture: SportmonksLedgerCaptureV1,
): SportmonksA2BFixtureAudit {
  const providerFixtureId = String(capture.fixture.id);
  const providerLeagueId = String(capture.fixture.league_id);
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
    if (secondHalf && current) {
      const equal = secondHalf.home === current.home && secondHalf.away === current.away;
      scoreSemantics = equal
        ? { status: "pass", detail: "FT has matching cumulative 2ND_HALF and CURRENT scores." }
        : { status: "fail", detail: "FT 2ND_HALF and CURRENT scores disagree." };
    } else {
      scoreSemantics = { status: "unverified", detail: "FT did not expose both 2ND_HALF and CURRENT score pairs." };
    }
  } else if (state === "AET" || state === "FT_PEN") {
    scoreSemantics = secondHalf && current
      ? { status: "pass", detail: `${state} exposes both 90-minute 2ND_HALF and post-extra-time CURRENT scores.` }
      : { status: "fail", detail: `${state} is missing 2ND_HALF or CURRENT score data.` };
  } else {
    scoreSemantics = { status: "unverified", detail: `Fixture state ${state || "unknown"} is not a finished pilot state.` };
  }

  const lineupRows = capture.families.lineups.rows.filter(isRecord);
  const lineupTypeIds = [...new Set(
    lineupRows
      .map((row) => (typeof row.type_id === "number" && Number.isInteger(row.type_id) ? row.type_id : null))
      .filter((value): value is number => value !== null),
  )].sort((a, b) => a - b);
  const unknownLineupTypes = lineupTypeIds.filter((id) => id !== 11 && id !== 12);
  const lineupTypes: PilotGate =
    unknownLineupTypes.length > 0
      ? { status: "fail", detail: `Unexpected lineup type ids: ${unknownLineupTypes.join(",")}.` }
      : lineupTypeIds.includes(11) && lineupTypeIds.includes(12)
        ? { status: "pass", detail: "Observed type_id 11 starters and type_id 12 bench players." }
        : { status: "unverified", detail: `Observed lineup type ids: ${lineupTypeIds.join(",") || "none"}.` };

  const positionIds = [...new Set(
    lineupRows
      .map((row) => (typeof row.position_id === "number" && Number.isInteger(row.position_id) ? row.position_id : null))
      .filter((value): value is number => value !== null),
  )].sort((a, b) => a - b);
  const requiredPositions = [24, 25, 26, 27];
  const broadPositions: PilotGate = requiredPositions.every((id) => positionIds.includes(id))
    ? { status: "pass", detail: "Observed all broad position ids 24/25/26/27 in real lineup payloads." }
    : { status: "unverified", detail: `Observed position ids: ${positionIds.join(",") || "none"}; not all 24/25/26/27 were present.` };

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

  const sideMap = sideByParticipant(capture);
  const presentKeys = new Set<string>();
  const explicitZeroStatTypes = new Set<string>();
  for (const row of statRows(capture)) {
    const team = asProviderId(row.participant_id);
    const side = team ? sideMap.get(team) : undefined;
    const typeId = asProviderId(row.type_id);
    if (!side || !typeId || !ALLOWLISTED_STAT_TYPES.includes(typeId as (typeof ALLOWLISTED_STAT_TYPES)[number])) continue;
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
  const explicitZero: PilotGate = explicitZeroStatTypes.size > 0
    ? { status: "pass", detail: `Observed explicit numeric zero for type ids ${[...explicitZeroStatTypes].sort().join(",")}; zero is distinguishable from omitted rows.` }
    : { status: "unverified", detail: "No allow-listed explicit zero occurred in this fixture." };

  return {
    providerFixtureId,
    providerLeagueId,
    gates: {
      participantLocations,
      scoreSemantics,
      lineupTypes,
      broadPositions,
      possessionSum: possessionGate,
      shotsOnTarget,
      nonPenaltyXg,
      explicitZero,
    },
    observed: {
      lineupTypeIds,
      positionIds,
      explicitZeroStatTypes: [...explicitZeroStatTypes].sort(),
      omittedAllowlistedStatTypes: [...omittedAllowlistedStatTypes].sort(),
    },
  };
}

export function summarizeSportmonksA2BGates(
  audits: readonly SportmonksA2BFixtureAudit[],
): Record<keyof SportmonksA2BFixtureAudit["gates"], PilotGateStatus> {
  const names = [
    "participantLocations",
    "scoreSemantics",
    "lineupTypes",
    "broadPositions",
    "possessionSum",
    "shotsOnTarget",
    "nonPenaltyXg",
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