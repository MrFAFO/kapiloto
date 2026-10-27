import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { FootballIlTeamStatistics } from "./football-il-parse";

export type FootballIlFactTeam = {
  canonicalTeamId: string;
  providerTeamId: string;
};

export type FootballIlFactContext = {
  fixtureId: string;
  providerGameId: string;
  capturedAt: string;
  home: FootballIlFactTeam;
  away: FootballIlFactTeam;
};

export type FootballIlFixtureFactInsert = {
  fixture_id: string;
  fact_key: string;
  subject_type: "fixture" | "team";
  subject_team_id: string | null;
  subject_ref: string | null;
  value_numeric: number | null;
  value_text: string | null;
  value_boolean: boolean | null;
  value_json: Record<string, unknown> | unknown[] | null;
  unit: string | null;
  provenance_type: "provider_raw";
  provider: "football-il-parse";
  provider_endpoint: string;
  provider_record_id: string;
  calculation_version: null;
  source_observed_at: string | null;
  captured_at: string;
  source_version: "football-il-parse-v11";
  source_fingerprint: string;
  metadata: Record<string, unknown>;
};

export interface FootballIlMatchAnalyticsSource {
  getMatchStatistics(
    gameId: number,
  ): Promise<{ stats: FootballIlTeamStatistics[] }>;
}

export interface FootballIlSeasonAnalyticsSource {
  getTeamStatistics(
    season: string,
    teamId: number,
  ): Promise<{ stats: FootballIlTeamStatistics[] }>;
}

export interface FootballIlFactStore {
  saveFacts(facts: FootballIlFixtureFactInsert[]): Promise<number>;
}

type NumericMetricDefinition = {
  field: keyof FootballIlTeamStatistics;
  factKey: string;
  unit: string | null;
};

const MATCH_METRICS: NumericMetricDefinition[] = [
  { field: "expectedGoals", factKey: "xg.expected", unit: "goals" },
  { field: "Goal", factKey: "goals.scored", unit: "goals" },
  { field: "CopedGoal", factKey: "goals.conceded", unit: "goals" },
  { field: "AttemptonGoal", factKey: "shots.total", unit: "shots" },
  { field: "OnTarget", factKey: "shots.on_target", unit: "shots" },
  { field: "ShotInsidetheArea", factKey: "shots.inside_box", unit: "shots" },
  { field: "ShotOutsidetheArea", factKey: "shots.outside_box", unit: "shots" },
  { field: "ballPossession", factKey: "possession", unit: "percent" },
  { field: "passes", factKey: "passes.total", unit: "passes" },
  { field: "accuratePasses", factKey: "passes.accurate", unit: "passes" },
  { field: "Corner", factKey: "corners", unit: "corners" },
  { field: "Cross", factKey: "crosses.total", unit: "crosses" },
  { field: "accurateCrosses", factKey: "crosses.accurate", unit: "crosses" },
  { field: "duel", factKey: "duels.total", unit: "duels" },
  { field: "duelWon", factKey: "duels.won", unit: "duels" },
  { field: "tackles", factKey: "tackles.total", unit: "tackles" },
  { field: "tacklesSuccess", factKey: "tackles.successful", unit: "tackles" },
  { field: "ballRecovery", factKey: "recoveries.total", unit: "recoveries" },
  { field: "chanceTotal", factKey: "chances.total", unit: "chances" },
  {
    field: "touchesInOppBox",
    factKey: "touches.opposition_box",
    unit: "touches",
  },
  { field: "Offside", factKey: "offsides", unit: "offsides" },
  { field: "foul", factKey: "fouls", unit: "fouls" },
  { field: "lostBall", factKey: "possession_lost", unit: "events" },
  { field: "CounterAttacks", factKey: "attacks.counter", unit: "attacks" },
];

function fingerprint(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function subjectForTeam(
  providerTeamId: number,
  context: FootballIlFactContext,
): {
  subject_type: "fixture" | "team";
  subject_team_id: string | null;
  subject_ref: string;
} {
  if (String(providerTeamId) === context.home.providerTeamId) {
    return {
      subject_type: "team",
      subject_team_id: context.home.canonicalTeamId,
      subject_ref: String(providerTeamId),
    };
  }

  if (String(providerTeamId) === context.away.providerTeamId) {
    return {
      subject_type: "team",
      subject_team_id: context.away.canonicalTeamId,
      subject_ref: String(providerTeamId),
    };
  }

  return {
    subject_type: "fixture",
    subject_team_id: null,
    subject_ref: String(providerTeamId),
  };
}

function finiteMetric(
  row: FootballIlTeamStatistics,
  field: keyof FootballIlTeamStatistics,
): number | null {
  const value = row[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildFootballIlMatchFacts(
  context: FootballIlFactContext,
  rows: FootballIlTeamStatistics[],
): FootballIlFixtureFactInsert[] {
  const facts: FootballIlFixtureFactInsert[] = [];

  for (const row of rows) {
    if (!Number.isFinite(row.teamId)) continue;

    const subject = subjectForTeam(row.teamId, context);

    for (const metric of MATCH_METRICS) {
      const value = finiteMetric(row, metric.field);
      if (value == null) continue;

      facts.push({
        fixture_id: context.fixtureId,
        fact_key: metric.factKey,
        ...subject,
        value_numeric: value,
        value_text: null,
        value_boolean: null,
        value_json: null,
        unit: metric.unit,
        provenance_type: "provider_raw",
        provider: "football-il-parse",
        provider_endpoint: `get_match_statistics?game_id=${context.providerGameId}`,
        provider_record_id: [
          "match",
          context.providerGameId,
          row.teamId,
          metric.field,
        ].join(":"),
        calculation_version: null,
        source_observed_at: null,
        captured_at: context.capturedAt,
        source_version: "football-il-parse-v11",
        source_fingerprint: fingerprint([
          "football-il-parse",
          "v11",
          "match",
          context.providerGameId,
          row.teamId,
          metric.field,
          value,
        ]),
        metadata: {
          provider_team_id: row.teamId,
          raw_field: metric.field,
          season: row.seasonName ?? null,
          tournament_id: row.tournamentId ?? null,
          stage: row.stage ?? null,
          scope: "match",
        },
      });
    }
  }

  return facts;
}

export function buildFootballIlSeasonFacts(
  context: FootballIlFactContext,
  rows: FootballIlTeamStatistics[],
): FootballIlFixtureFactInsert[] {
  const facts: FootballIlFixtureFactInsert[] = [];

  for (const row of rows) {
    if (!Number.isFinite(row.teamId) || !row.seasonName) continue;

    const subject = subjectForTeam(row.teamId, context);

    for (const metric of MATCH_METRICS) {
      const value = finiteMetric(row, metric.field);
      if (value == null) continue;

      facts.push({
        fixture_id: context.fixtureId,
        fact_key: `season.${metric.factKey}`,
        ...subject,
        value_numeric: value,
        value_text: null,
        value_boolean: null,
        value_json: null,
        unit: metric.unit,
        provenance_type: "provider_raw",
        provider: "football-il-parse",
        provider_endpoint:
          `get_team_statistics?season=${encodeURIComponent(row.seasonName)}&team_id=${row.teamId}`,
        provider_record_id: [
          "season",
          row.seasonName,
          row.teamId,
          metric.field,
        ].join(":"),
        calculation_version: null,
        source_observed_at: null,
        captured_at: context.capturedAt,
        source_version: "football-il-parse-v11",
        source_fingerprint: fingerprint([
          "football-il-parse",
          "v11",
          "season",
          row.seasonName,
          row.teamId,
          metric.field,
          value,
        ]),
        metadata: {
          provider_team_id: row.teamId,
          raw_field: metric.field,
          season: row.seasonName,
          tournament_id: row.tournamentId ?? null,
          stage: row.stage ?? null,
          scope: "season",
        },
      });
    }
  }

  return facts;
}

export async function ingestFootballIlSeasonAnalytics(
  source: FootballIlSeasonAnalyticsSource,
  store: FootballIlFactStore,
  context: FootballIlFactContext,
  season: string,
): Promise<{
  rawRows: number;
  factsWritten: number;
}> {
  const teamIds = [
    Number(context.home.providerTeamId),
    Number(context.away.providerTeamId),
  ];

  if (
    teamIds.some(
      (teamId) => !Number.isInteger(teamId) || teamId <= 0,
    )
  ) {
    throw new Error(
      "football.co.il Parse team ids must be positive integers.",
    );
  }

  const rows: FootballIlTeamStatistics[] = [];
  for (const teamId of teamIds) {
    const response = await source.getTeamStatistics(season, teamId);
    rows.push(
      ...response.stats.filter(
        (row) => row.teamId === teamId && row.seasonName === season,
      ),
    );
  }

  const facts = buildFootballIlSeasonFacts(context, rows);
  const factsWritten = await store.saveFacts(facts);

  return {
    rawRows: rows.length,
    factsWritten,
  };
}

export async function ingestFootballIlMatchAnalytics(
  source: FootballIlMatchAnalyticsSource,
  store: FootballIlFactStore,
  context: FootballIlFactContext,
): Promise<{
  rawRows: number;
  factsWritten: number;
}> {
  const gameId = Number(context.providerGameId);
  if (!Number.isInteger(gameId) || gameId <= 0) {
    throw new Error("football.co.il Parse game id must be a positive integer.");
  }

  const response = await source.getMatchStatistics(gameId);
  const facts = buildFootballIlMatchFacts(context, response.stats);
  const factsWritten = await store.saveFacts(facts);

  return {
    rawRows: response.stats.length,
    factsWritten,
  };
}

export class SupabaseFootballIlFactStore implements FootballIlFactStore {
  constructor(private readonly client: SupabaseClient) {}

  async saveFacts(facts: FootballIlFixtureFactInsert[]): Promise<number> {
    if (facts.length === 0) return 0;

    const { data, error } = await this.client
      .from("fixture_fact_snapshots")
      .upsert(facts, {
        onConflict: "fixture_id,provenance_type,source_fingerprint",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      throw new Error(
        `Failed to persist football.co.il Parse fixture facts: ${error.message}`,
      );
    }

    return data?.length ?? 0;
  }
}
