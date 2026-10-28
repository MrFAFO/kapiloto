import type { PGlite } from "@electric-sql/pglite";

import { createMigratedDatabase } from "../../kapiloto/test-support/pglite-migrations";
import {
  buildMatchLedgerObservationPayload,
  type MatchEvent,
  type MatchLedgerObservationInput,
  type MatchdayPlayer,
  type RecordObservationResult,
  type Substitution,
  type TeamStatObservation,
} from "../match-ledger";

/**
 * Test-only information clock. Production stamps first_seen_at with
 * clock_timestamp(); tests replace the (owner-only) clock function so a test
 * can simulate observations first seen on specific historical dates.
 */
const TEST_CLOCK = `
create or replace function private.kapiloto_information_clock()
returns timestamptz
language sql
volatile
set search_path = ''
as $$
  select coalesce(nullif(current_setting('kapiloto.test_clock', true), '')::timestamptz, clock_timestamp())
$$;
`;

export async function createLedgerDatabase(
  options: { testClock?: boolean; supabaseDefaultPrivileges?: boolean } = {},
): Promise<PGlite> {
  const db = await createMigratedDatabase({
    supabaseDefaultPrivileges: options.supabaseDefaultPrivileges,
  });
  if (options.testClock !== false) await db.exec(TEST_CLOCK);
  return db;
}

export async function setClock(db: PGlite, iso: string | null): Promise<void> {
  await db.query("select set_config('kapiloto.test_clock', $1, false)", [iso ?? ""]);
}

function uuid(prefix: number, index: number): string {
  return `${String(prefix).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export type SeededTeam = {
  teamId: string;
  coachId: string;
  /** 11 starters followed by 7 bench players. */
  playerIds: string[];
};

export type LedgerSeed = {
  competitionId: string;
  home: SeededTeam;
  away: SeededTeam;
  statDefinitionIds: Record<"possession_pct" | "shots_total" | "shots_on_target" | "expected_goals" | "corners", string>;
};

let teamCounter = 0;

async function seedTeam(db: PGlite, name: string): Promise<SeededTeam> {
  teamCounter += 1;
  const n = teamCounter;
  const teamId = uuid(61, n);
  const coachId = uuid(62, n);
  await db.query("insert into public.teams (id, canonical_name, country_code) values ($1, $2, 'IL')", [teamId, name]);
  await db.query("insert into public.coaches (id, canonical_name) values ($1, $2)", [coachId, `${name} Coach`]);
  await db.query(
    `insert into public.provider_coach_mappings (provider, provider_coach_id, coach_id, mapping_status)
     values ('sportmonks', $1, $2, 'confirmed')`,
    [`c-${n}`, coachId],
  );
  const playerIds: string[] = [];
  for (let i = 1; i <= 18; i += 1) {
    const playerId = uuid(63, n * 100 + i);
    playerIds.push(playerId);
    await db.query("insert into public.players (id, canonical_name) values ($1, $2)", [playerId, `${name} Player ${i}`]);
    await db.query(
      `insert into public.provider_player_mappings (provider, provider_player_id, player_id, mapping_status)
       values ('sportmonks', $1, $2, 'confirmed')`,
      [`p-${n}-${i}`, playerId],
    );
  }
  return { teamId, coachId, playerIds };
}

export async function seedLedger(db: PGlite, names: [string, string] = ["Test Home FC", "Test Away FC"]): Promise<LedgerSeed> {
  const competitionId = uuid(60, ++teamCounter);
  await db.query(
    "insert into public.competitions (id, canonical_name, country_code, competition_type) values ($1, 'Test League', 'IL', 'league')",
    [competitionId],
  );
  const home = await seedTeam(db, names[0]);
  const away = await seedTeam(db, names[1]);
  const statDefinitionIds = {} as LedgerSeed["statDefinitionIds"];
  const definitions: Array<[keyof LedgerSeed["statDefinitionIds"], string, string]> = [
    ["possession_pct", "45", "percent"],
    ["shots_total", "42", "count"],
    ["shots_on_target", "86", "count"],
    ["expected_goals", "5304", "expected_goals"],
    ["corners", "34", "count"],
  ];
  for (const [statKey, providerType, unit] of definitions) {
    // Definitions are immutable reference rows: insert once, then read back.
    await db.query(
      `insert into public.match_ledger_stat_definitions
         (provider, provider_stat_type, definition_version, stat_key, unit)
       values ('sportmonks', $1, 'sm-2024-08', $2, $3)
       on conflict (provider, provider_stat_type, definition_version) do nothing`,
      [providerType, statKey, unit],
    );
    const result = await db.query<{ id: string }>(
      `select id from public.match_ledger_stat_definitions
       where provider = 'sportmonks' and provider_stat_type = $1 and definition_version = 'sm-2024-08'`,
      [providerType],
    );
    statDefinitionIds[statKey] = result.rows[0].id;
  }
  return { competitionId, home, away, statDefinitionIds };
}

let fixtureCounter = 0;

export async function createFixture(
  db: PGlite,
  seed: LedgerSeed,
  kickoffAt: string,
  orientation: "normal" | "reversed" = "normal",
): Promise<{ fixtureId: string; providerFixtureId: string }> {
  fixtureCounter += 1;
  const fixtureId = uuid(70, fixtureCounter);
  const [home, away] = orientation === "normal" ? [seed.home, seed.away] : [seed.away, seed.home];
  await db.query(
    `insert into public.fixtures (id, competition_id, home_team_id, away_team_id, kickoff_at, status)
     values ($1, $2, $3, $4, $5, 'finished')`,
    [fixtureId, seed.competitionId, home.teamId, away.teamId, kickoffAt],
  );
  return { fixtureId, providerFixtureId: `sm-fx-${fixtureCounter}` };
}

function squad(team: SeededTeam, positions: Array<"GK" | "DF" | "MF" | "FW">): MatchdayPlayer[] {
  return team.playerIds.map((playerId, index) => {
    const starter = index < 11;
    return {
      teamId: team.teamId,
      playerId,
      providerPlayerId: null,
      providerPlayerName: null,
      lineupRole: starter ? "starter" : "bench",
      appeared: starter ? true : null,
      positionCode: starter ? positions[index] : null,
      providerPosition: null,
      formationPosition: starter ? index + 1 : null,
      formationField: null,
      shirtNumber: index + 1,
      isCaptain: index === 3,
      minutesPlayed: starter ? 90 : 0,
      enteredMinute: starter ? 0 : null,
      exitedMinute: null,
      dataCompleteness: "complete",
    };
  });
}

const FOUR_TWO_THREE_ONE: Array<"GK" | "DF" | "MF" | "FW"> = [
  "GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "MF", "FW",
];

/**
 * A realistic finished fixture: 11 starters + 7 bench per side, three
 * substitutions each, goals, own goal, penalties, cards and team stats.
 */
export function realisticObservation(
  seed: LedgerSeed,
  fixture: { fixtureId: string; providerFixtureId: string },
  options: { kickoffAt: string; retrievedAt: string; homeGoals?: number; awayGoals?: number; withRedCard?: boolean },
): MatchLedgerObservationInput {
  const home = seed.home;
  const away = seed.away;
  const players = [...squad(home, FOUR_TWO_THREE_ONE), ...squad(away, FOUR_TWO_THREE_ONE)];
  const subs: Substitution[] = [];
  const pairs: Array<[SeededTeam, number, number, number, "tactical" | "injury"]> = [
    [home, 9, 11, 61, "tactical"],
    [home, 10, 12, 70, "tactical"],
    [home, 5, 13, 78, "injury"],
    [away, 8, 11, 55, "tactical"],
    [away, 10, 12, 66, "tactical"],
    [away, 2, 13, 84, "tactical"],
  ];
  pairs.forEach(([team, offIndex, onIndex, minute, reason]) => {
    const off = players.find((p) => p.playerId === team.playerIds[offIndex])!;
    const on = players.find((p) => p.playerId === team.playerIds[onIndex])!;
    off.exitedMinute = minute;
    off.minutesPlayed = minute;
    on.appeared = true;
    on.enteredMinute = minute;
    on.minutesPlayed = 90 - minute;
    subs.push({
      teamId: team.teamId,
      sequenceNo: subs.filter((s) => s.teamId === team.teamId).length + 1,
      playerOffId: off.playerId,
      playerOnId: on.playerId,
      minute,
      stoppageMinute: null,
      period: "second_half",
      reason,
      providerEventId: null,
    });
  });
  for (const player of players) {
    if (player.lineupRole === "bench" && player.appeared === null) player.appeared = false;
  }

  const event = (
    sequenceNo: number,
    team: SeededTeam,
    eventType: MatchEvent["eventType"],
    playerIndex: number,
    minute: number,
    period: MatchEvent["period"],
    stoppageMinute: number | null = null,
  ): MatchEvent => ({
    teamId: team.teamId,
    sequenceNo,
    eventType,
    playerId: team.playerIds[playerIndex],
    coachId: null,
    relatedPlayerId: null,
    minute,
    stoppageMinute,
    second: null,
    period,
    providerEventId: `ev-${sequenceNo}`,
    providerEventType: null,
    detail: {},
  });
  const events: MatchEvent[] = [
    event(1, home, "goal", 10, 12, "first_half"),
    event(2, away, "yellow_card", 6, 27, "first_half"),
    event(3, away, "own_goal", 2, 45, "first_half", 2),
    event(4, home, "yellow_card", 7, 51, "second_half"),
    event(5, away, "penalty_goal", 9, 58, "second_half"),
    event(6, home, "penalty_missed", 12, 74, "second_half"),
  ];
  if (options.withRedCard) {
    events.push(event(7, away, "second_yellow_card", 6, 80, "second_half"));
    const sentOff = players.find((p) => p.playerId === away.playerIds[6])!;
    sentOff.exitedMinute = 80;
    sentOff.minutesPlayed = 80;
  }
  events.push({ ...event(8, home, "yellow_card", 0, 88, "second_half"), playerId: null, coachId: home.coachId, staffRole: "head_coach" });

  const stats: TeamStatObservation[] = [
    [home, 54, 14, 5, 1.82, 6],
    [away, 46, 9, 3, 1.11, 4],
  ].flatMap(([team, possession, shots, onTarget, xg, corners]) => {
    const teamId = (team as SeededTeam).teamId;
    return ([
      ["possession_pct", possession],
      ["shots_total", shots],
      ["shots_on_target", onTarget],
      ["expected_goals", xg],
      ["corners", corners],
    ] as Array<[keyof LedgerSeed["statDefinitionIds"], number]>).map(([key, value]) => ({
      teamId,
      statDefinitionId: seed.statDefinitionIds[key],
      period: "full_time" as const,
      value,
    }));
  });

  return {
    fixtureId: fixture.fixtureId,
    provider: "sportmonks",
    providerFixtureId: fixture.providerFixtureId,
    providerEndpoint: "fixtures/{id}?include=lineups;events;statistics",
    captureMode: "backfill",
    ingestVersion: "ledger-ingest-test-v1",
    sourceVersion: "sportmonks-v3",
    rawPayloadSha256: null,
    rawObservationId: null,
    retrievedAt: options.retrievedAt,
    sourceUpdatedAt: null,
    kickoffAt: options.kickoffAt,
    matchStatus: "finished",
    neutralVenue: false,
    homeGoals90: options.homeGoals ?? 2,
    awayGoals90: options.awayGoals ?? 1,
    teams: [
      {
        teamId: home.teamId,
        side: "home",
        coachId: home.coachId,
        providerCoachId: null,
        providerCoachName: null,
        formationNominal: "4-2-3-1",
        lineupStatus: "complete",
        substitutionsStatus: "complete",
        eventsStatus: "complete",
        statisticsStatus: "complete",
      },
      {
        teamId: away.teamId,
        side: "away",
        coachId: away.coachId,
        providerCoachId: null,
        providerCoachName: null,
        formationNominal: "4-3-3",
        lineupStatus: "complete",
        substitutionsStatus: "complete",
        eventsStatus: "complete",
        statisticsStatus: "complete",
      },
    ],
    players,
    substitutions: subs,
    events,
    teamStats: stats,
  };
}

/** A results-only observation (no lineups/events/stats), e.g. a cup match. */
export function resultOnlyObservation(
  fixture: { fixtureId: string; providerFixtureId: string },
  homeTeamId: string,
  awayTeamId: string,
  options: { kickoffAt: string; retrievedAt: string; homeGoals: number; awayGoals: number; provider?: string },
): MatchLedgerObservationInput {
  const notProvided = {
    lineupStatus: "not_provided",
    substitutionsStatus: "not_provided",
    eventsStatus: "not_provided",
    statisticsStatus: "not_provided",
  } as const;
  return {
    fixtureId: fixture.fixtureId,
    provider: options.provider ?? "sportmonks",
    providerFixtureId: fixture.providerFixtureId,
    captureMode: "backfill",
    ingestVersion: "ledger-ingest-test-v1",
    retrievedAt: options.retrievedAt,
    kickoffAt: options.kickoffAt,
    matchStatus: "finished",
    homeGoals90: options.homeGoals,
    awayGoals90: options.awayGoals,
    teams: [
      { teamId: homeTeamId, side: "home", ...notProvided },
      { teamId: awayTeamId, side: "away", ...notProvided },
    ],
  };
}

export async function recordObservation(
  db: PGlite,
  input: MatchLedgerObservationInput | Record<string, unknown>,
  clock: string,
): Promise<RecordObservationResult> {
  await setClock(db, clock);
  const payload = "contract_version" in input ? input : buildMatchLedgerObservationPayload(input as MatchLedgerObservationInput);
  const result = await db.query<{ result: RecordObservationResult }>(
    "select public.match_ledger_record_observation($1::jsonb) as result",
    [JSON.stringify(payload)],
  );
  return result.rows[0].result;
}
