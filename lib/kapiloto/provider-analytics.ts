import type { SupabaseClient } from "@supabase/supabase-js";

export type ProviderAnalyticsTeamMetrics = {
  team_id: string;
  xg_expected: number | null;
  games_played: number | null;
  xg_per_match: number | null;
  goals_scored: number | null;
  shots_total: number | null;
  shots_on_target: number | null;
  possession: number | null;
};

export type FixtureProviderAnalyticsSnapshot = {
  fixture_id: string;
  provider: "football-il-parse";
  source_version: string;
  captured_at: string;
  season: string | null;
  teams: ProviderAnalyticsTeamMetrics[];
};

type FactRow = {
  fixture_id: string;
  fact_key: string;
  subject_team_id: string | null;
  value_numeric: number | string | null;
  captured_at: string;
  source_version: string;
  metadata: Record<string, unknown> | null;
};

const FACT_KEYS = [
  "season.xg.expected",
  "season.games_played",
  "season.goals.scored",
  "season.shots.total",
  "season.shots.on_target",
  "season.possession",
] as const;

function numeric(value: number | string | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

type MutableMetrics = {
  team_id: string;
  xg_expected: number | null;
  games_played: number | null;
  goals_scored: number | null;
  shots_total: number | null;
  shots_on_target: number | null;
  possession: number | null;
};

function emptyMetrics(teamId: string): MutableMetrics {
  return {
    team_id: teamId,
    xg_expected: null,
    games_played: null,
    goals_scored: null,
    shots_total: null,
    shots_on_target: null,
    possession: null,
  };
}

function applyFact(metrics: MutableMetrics, row: FactRow): void {
  const value = numeric(row.value_numeric);
  if (value == null) return;

  switch (row.fact_key) {
    case "season.xg.expected":
      metrics.xg_expected = value;
      break;
    case "season.games_played":
      metrics.games_played = value;
      break;
    case "season.goals.scored":
      metrics.goals_scored = value;
      break;
    case "season.shots.total":
      metrics.shots_total = value;
      break;
    case "season.shots.on_target":
      metrics.shots_on_target = value;
      break;
    case "season.possession":
      metrics.possession = value;
      break;
  }
}

function finalize(metrics: MutableMetrics): ProviderAnalyticsTeamMetrics {
  const xgPerMatch =
    metrics.xg_expected != null &&
    metrics.games_played != null &&
    metrics.games_played > 0
      ? metrics.xg_expected / metrics.games_played
      : null;

  return {
    ...metrics,
    xg_per_match: xgPerMatch,
  };
}

export function assembleProviderAnalyticsSnapshots(
  rows: FactRow[],
  cutoffAt: string,
): Map<string, FixtureProviderAnalyticsSnapshot> {
  const cutoffMs = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoffMs)) {
    throw new Error("Invalid provider analytics cutoff: " + cutoffAt);
  }

  const captures = new Map<
    string,
    Map<
      string,
      {
        sourceVersion: string;
        capturedAt: string;
        season: string | null;
        teams: Map<string, MutableMetrics>;
        seenValues: Map<string, number>;
        invalid: boolean;
      }
    >
  >();

  for (const row of rows) {
    const capturedMs = Date.parse(row.captured_at);
    if (
      row.subject_team_id == null ||
      !Number.isFinite(capturedMs) ||
      capturedMs > cutoffMs
    ) {
      continue;
    }

    let fixtureCaptures = captures.get(row.fixture_id);
    if (!fixtureCaptures) {
      fixtureCaptures = new Map();
      captures.set(row.fixture_id, fixtureCaptures);
    }

    let group = fixtureCaptures.get(row.captured_at);
    if (!group) {
      const season =
        typeof row.metadata?.season === "string"
          ? row.metadata.season
          : null;
      group = {
        sourceVersion: row.source_version,
        capturedAt: row.captured_at,
        season,
        teams: new Map(),
        seenValues: new Map(),
        invalid: false,
      };
      fixtureCaptures.set(row.captured_at, group);
    }

    const value = numeric(row.value_numeric);
    if (value != null) {
      const valueKey = row.subject_team_id + ":" + row.fact_key;
      const previous = group.seenValues.get(valueKey);
      if (previous != null && previous !== value) {
        group.invalid = true;
      } else if (previous == null) {
        group.seenValues.set(valueKey, value);
      }
    }

    let metrics = group.teams.get(row.subject_team_id);
    if (!metrics) {
      metrics = emptyMetrics(row.subject_team_id);
      group.teams.set(row.subject_team_id, metrics);
    }
    applyFact(metrics, row);
  }

  const output = new Map<string, FixtureProviderAnalyticsSnapshot>();

  for (const [fixtureId, fixtureCaptures] of captures) {
    const ordered = [...fixtureCaptures.values()].sort(
      (a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt),
    );

    for (const group of ordered) {
      if (group.invalid) continue;
      const teams = [...group.teams.values()].map(finalize);
      const complete = teams.filter(
        (team) =>
          team.xg_expected != null &&
          team.games_played != null &&
          team.games_played > 0 &&
          team.xg_per_match != null,
      );

      if (complete.length !== 2) continue;

      output.set(fixtureId, {
        fixture_id: fixtureId,
        provider: "football-il-parse",
        source_version: group.sourceVersion,
        captured_at: group.capturedAt,
        season: group.season,
        teams: complete,
      });
      break;
    }
  }

  return output;
}

export class SupabaseProviderAnalyticsStore {
  constructor(private readonly client: SupabaseClient) {}

  async loadLatestAtOrBefore(
    fixtureIds: string[],
    cutoffAt: string,
  ): Promise<Map<string, FixtureProviderAnalyticsSnapshot>> {
    if (fixtureIds.length === 0) return new Map();

    const { data, error } = await this.client
      .from("fixture_fact_snapshots")
      .select(
        "fixture_id,fact_key,subject_team_id,value_numeric,captured_at,source_version,metadata",
      )
      .in("fixture_id", fixtureIds)
      .eq("provider", "football-il-parse")
      .in("fact_key", [...FACT_KEYS])
      .lte("captured_at", cutoffAt)
      .order("captured_at", { ascending: false });

    if (error) {
      throw new Error(
        "Failed to load football.co.il provider analytics: " + error.message,
      );
    }

    return assembleProviderAnalyticsSnapshots((data ?? []) as FactRow[], cutoffAt);
  }
}
