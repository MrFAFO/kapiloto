import type { PGlite } from "@electric-sql/pglite";

import type { FamilyFetchStatus, ProviderDataFamily, ProviderIngestResult, ProviderMatchObservation } from "../provider-ingest";
import { buildProviderMatchObservationPayload } from "../provider-ingest";
import { parseSportmonksLedgerCapture, type SportmonksLedgerCaptureV1 } from "../sportmonks-ledger";
import { setClock } from "./ledger-fixtures";

/**
 * SYNTHETIC Sportmonks captures and provider-ingest seeds for offline tests.
 * Every id, name and number here is invented; nothing was fetched from a
 * provider. Shapes follow the Sportmonks v3 fixture includes (participants,
 * scores, state, lineups, formations, statistics.type, xGFixture.type).
 */

export const SYNTHETIC_LEAGUE_ID = "9001";
export const SYNTHETIC_SEASON_ID = "99001";
export const SYNTHETIC_HOME_TEAM_ID = "9501";
export const SYNTHETIC_AWAY_TEAM_ID = "9502";

const STAT_ROWS: Array<[number, string, "statistics" | "xg", number, number]> = [
  [42, "SHOTS_TOTAL", "statistics", 14, 9],
  [86, "SHOTS_ON_TARGET", "statistics", 5, 3],
  [45, "BALL_POSSESSION", "statistics", 54, 46],
  [34, "CORNERS", "statistics", 6, 4],
  [5304, "EXPECTED_GOALS", "xg", 1.82, 1.11],
  [5305, "EXPECTED_GOALS_ON_TARGET", "xg", 1.64, 0.92],
  [7943, "EXPECTED_NON_PENALTY_GOALS", "xg", 1.06, 1.11],
];

const POSITIONS = [24, 25, 25, 25, 25, 26, 26, 26, 27, 27, 27];

export type SyntheticCaptureOptions = {
  providerFixtureId?: string;
  leagueId?: string;
  seasonId?: string;
  homeTeamId?: string;
  awayTeamId?: string;
  kickoffAt: string;
  capturedAt: string;
  state?: string;
  score90?: [number, number];
  scoreAet?: [number, number] | null;
  penalties?: [number, number] | null;
  families?: Partial<Record<ProviderDataFamily, FamilyFetchStatus>>;
  /** First provider player id per side (home, away); 14 consecutive ids each. */
  playerIdBase?: [number, number];
  rawPayloadSha256?: string | null;
  omitStatTypes?: number[];
};

export function syntheticCapture(options: SyntheticCaptureOptions): SportmonksLedgerCaptureV1 {
  const fixtureId = options.providerFixtureId ?? "19000001";
  const home = options.homeTeamId ?? SYNTHETIC_HOME_TEAM_ID;
  const away = options.awayTeamId ?? SYNTHETIC_AWAY_TEAM_ID;
  const [h90, a90] = options.score90 ?? [2, 1];
  const fetch = (family: ProviderDataFamily): FamilyFetchStatus => options.families?.[family] ?? "fetched";
  const [homeBase, awayBase] = options.playerIdBase ?? [3_100_000, 3_200_000];

  const scores = [
    ["1ST_HALF", Math.min(h90, 1), Math.min(a90, 1)],
    ["2ND_HALF", h90, a90],
    ["CURRENT", options.scoreAet ? options.scoreAet[0] : h90, options.scoreAet ? options.scoreAet[1] : a90],
    ...(options.penalties ? [["PENALTIES", options.penalties[0], options.penalties[1]]] : []),
  ].flatMap(([description, homeGoals, awayGoals]) => [
    { participant_id: Number(home), description, score: { goals: homeGoals, participant: "home" } },
    { participant_id: Number(away), description, score: { goals: awayGoals, participant: "away" } },
  ]) as SportmonksLedgerCaptureV1["fixture"]["scores"];

  const lineupRows = ([
    [home, homeBase, "Home"],
    [away, awayBase, "Away"],
  ] as const).flatMap(([teamId, base, label]) =>
    Array.from({ length: 14 }, (_, i) => ({
      player_id: base + i,
      team_id: Number(teamId),
      type_id: i < 11 ? 11 : 12,
      position_id: i < 11 ? POSITIONS[i] : 26,
      formation_position: i < 11 ? i + 1 : null,
      formation_field: i < 11 ? `${Math.min(i + 1, 5)}:${(i % 4) + 1}` : null,
      jersey_number: i + 1,
      player_name: `Synthetic ${label} ${i + 1}`,
    })),
  );

  const statRows = (family: "statistics" | "xg") =>
    STAT_ROWS.filter(([type, , f]) => f === family && !(options.omitStatTypes ?? []).includes(type)).flatMap(([type, developerName, , hv, av]) => [
      { type_id: type, participant_id: Number(home), location: "home", data: { value: hv }, type: { developer_name: developerName } },
      { type_id: type, participant_id: Number(away), location: "away", data: { value: av }, type: { developer_name: developerName } },
    ]);

  const family = (name: ProviderDataFamily, rows: unknown[]) => ({
    fetch_status: fetch(name),
    rows: fetch(name) === "fetched" ? rows : [],
    raw_response_sha256: null,
  });

  return {
    contract_version: "kapiloto-sportmonks-ledger-capture-v1",
    captured_at: options.capturedAt,
    capture_mode: "backfill",
    provider_endpoint: "fixtures/{id}",
    raw_payload_sha256: options.rawPayloadSha256 ?? null,
    fixture: {
      id: Number(fixtureId),
      league_id: Number(options.leagueId ?? SYNTHETIC_LEAGUE_ID),
      season_id: Number(options.seasonId ?? SYNTHETIC_SEASON_ID),
      starting_at_timestamp: Math.floor(Date.parse(options.kickoffAt) / 1000),
      state: { developer_name: options.state ?? "FT" },
      participants: [
        { id: Number(home), name: "Synthetic Home FC", meta: { location: "home" } },
        { id: Number(away), name: "Synthetic Away FC", meta: { location: "away" } },
      ],
      scores,
    },
    families: {
      lineups: family("lineups", lineupRows),
      formations: family("formations", [
        { participant_id: Number(home), formation: "4-3-3", location: "home" },
        { participant_id: Number(away), formation: "4-4-2", location: "away" },
      ]),
      statistics: family("statistics", statRows("statistics")),
      xg: family("xg", statRows("xg")),
    },
  };
}

export type IngestSeed = { competitionId: string; homeTeamId: string; awayTeamId: string };

let ingestCounter = 0;

function uuid(prefix: number, index: number): string {
  return `${String(prefix).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/**
 * Canonical competition and teams created by the TEST (the ingest RPC never
 * creates them), mapped to the synthetic Sportmonks ids.
 */
export async function seedIngestIdentities(
  db: PGlite,
  options: { leagueId?: string; homeTeamId?: string; awayTeamId?: string; mapCompetition?: boolean; mapTeams?: boolean } = {},
): Promise<IngestSeed> {
  ingestCounter += 1;
  const n = ingestCounter;
  const competitionId = uuid(80, n);
  const homeTeamId = uuid(81, n);
  const awayTeamId = uuid(82, n);
  await db.query("insert into public.competitions (id, canonical_name, country_code, competition_type) values ($1, $2, 'IL', 'league')", [
    competitionId,
    `Synthetic League ${n}`,
  ]);
  await db.query("insert into public.teams (id, canonical_name, country_code) values ($1, $2, 'IL'), ($3, $4, 'IL')", [
    homeTeamId,
    `Synthetic Home ${n}`,
    awayTeamId,
    `Synthetic Away ${n}`,
  ]);
  if (options.mapCompetition !== false) {
    await db.query(
      "insert into public.provider_competition_mappings (provider, provider_competition_id, competition_id, mapping_status) values ('sportmonks', $1, $2, 'confirmed')",
      [options.leagueId ?? SYNTHETIC_LEAGUE_ID, competitionId],
    );
  }
  if (options.mapTeams !== false) {
    await db.query(
      "insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_status) values ('sportmonks', $1, $2, 'confirmed'), ('sportmonks', $3, $4, 'confirmed')",
      [options.homeTeamId ?? SYNTHETIC_HOME_TEAM_ID, homeTeamId, options.awayTeamId ?? SYNTHETIC_AWAY_TEAM_ID, awayTeamId],
    );
  }
  return { competitionId, homeTeamId, awayTeamId };
}

export async function createIngestRun(
  db: PGlite,
  options: { provider?: string; fixtureMintKickoffBefore?: string | null } = {},
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into public.provider_ingest_runs (provider, purpose, ingest_version, scope, fixture_mint_kickoff_before)
     values ($1, 'test', 'kapiloto-sportmonks-ledger-mapping-v1', '{"synthetic": true}'::jsonb, $2) returning id`,
    [options.provider ?? "sportmonks", options.fixtureMintKickoffBefore ?? null],
  );
  return result.rows[0].id;
}

export const MINT_BEFORE = "2026-10-01T00:00:00.000Z";

export function observationFrom(
  capture: SportmonksLedgerCaptureV1,
  options: { mint?: boolean; kickoffBefore?: string; runId?: string | null } = {},
): ProviderMatchObservation {
  return parseSportmonksLedgerCapture(capture, {
    fixtureMint: { allowed: options.mint ?? true, kickoffBefore: options.kickoffBefore ?? MINT_BEFORE },
    runId: options.runId ?? null,
  }).observation;
}

/** Calls the ingest RPC as one statement at the given information-clock time. */
export async function ingest(
  db: PGlite,
  observation: ProviderMatchObservation | Record<string, unknown>,
  clock: string,
): Promise<ProviderIngestResult> {
  await setClock(db, clock);
  const payload = "contract_version" in observation ? observation : buildProviderMatchObservationPayload(observation as ProviderMatchObservation);
  const result = await db.query<{ result: ProviderIngestResult }>(
    "select public.match_ledger_ingest_provider_fixture($1::jsonb) as result",
    [JSON.stringify(payload)],
  );
  return result.rows[0].result;
}

/** PGlite adapter for the ingest and stat-read RPC wrappers. */
export function pgliteRpc(db: PGlite) {
  return async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    if (fn === "match_ledger_ingest_provider_fixture") {
      const result = await db.query<{ result: unknown }>(`select public.${fn}($1::jsonb) as result`, [JSON.stringify(args.p_observation)]);
      return result.rows[0].result;
    }
    if (fn === "provider_ingest_record_failure") {
      const result = await db.query<{ result: unknown }>(`select public.${fn}($1::uuid, $2, $3, $4, $5::jsonb) as result`, [
        args.p_run_id,
        args.p_provider,
        args.p_provider_fixture_id,
        args.p_reason_code,
        JSON.stringify(args.p_detail ?? {}),
      ]);
      return result.rows[0].result;
    }
    if (fn === "match_ledger_team_match_stats_as_of" || fn === "match_ledger_team_match_stats_for_training") {
      const training = fn === "match_ledger_team_match_stats_for_training";
      const params = [args.p_provider, args.p_competition_ids, args.p_from, training ? args.p_training_cutoff : args.p_cutoff];
      if (training) params.push(args.p_policy);
      const result = await db.query<{ result: unknown }>(
        `select coalesce(jsonb_agg(t), '[]'::jsonb) as result
         from public.${fn}($1, $2::uuid[], $3::timestamptz, $4::timestamptz${training ? ", $5" : ""}) t`,
        params,
      );
      return result.rows[0].result;
    }
    throw new Error(`unexpected rpc ${fn}`);
  };
}

export async function countRows(db: PGlite, table: string, where = "true", params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where ${where}`, params);
  return result.rows[0].n;
}

/** Row counts of every table the ingest RPC may write (atomicity checks). */
export async function writeFootprint(db: PGlite): Promise<Record<string, number>> {
  const tables = [
    "fixtures",
    "provider_fixture_mappings",
    "match_ledger_fixture_mints",
    "players",
    "provider_player_mappings",
    "player_aliases",
    "match_ledger_observations",
    "match_ledger_team_records",
    "match_ledger_players",
    "match_ledger_team_stats",
    "match_ledger_observation_provider_refs",
    "match_ledger_observation_family_fetches",
    "teams",
    "competitions",
    "provider_team_mappings",
    "provider_competition_mappings",
  ];
  const footprint: Record<string, number> = {};
  for (const table of tables) footprint[table] = await countRows(db, table);
  return footprint;
}
