import type { SupabaseClient } from "@supabase/supabase-js";

import type { EvalPredictionDraft, EvaluationMode, ShadowFixtureContext } from "./arms";
import type { HistoricalMatchResult } from "./history";
import type { PublishedKapilotoAnalysis } from "./kapiloto-projection";
import type { LastActivity } from "./market-cadence";
import type {
  MarketCaptureAttemptDraft,
  MarketCaptureAttemptSink,
  MarketQuoteDraft,
  MarketQuoteSink,
} from "./market-capture";
import type { MarketQuoteRecord } from "./market-prior";
import type { MatchResultRow, MatchResultSink } from "./results-ingest";
import type { EvalScoreDraft } from "./scoring";
import type { FixtureForEvaluation, StoredEvalPrediction } from "./selection";

/** Provider whose league-wide results feed B2/B3. */
export const SHADOW_HISTORY_PROVIDER = "sportmonks";

/** Tables this module may write. Everything else is read-only here. */
export const SHADOW_EVALUATION_WRITE_TABLES = [
  "football_match_results",
  "fixture_market_quotes",
  "fixture_market_capture_attempts",
  "kapiloto_eval_predictions",
  "kapiloto_eval_scores",
] as const;

const PAGE_SIZE = 1000;
const UNIQUE_VIOLATION = "23505";

type Row = Record<string, unknown>;

function fail(context: string, error: { message: string }): never {
  throw new Error(`${context}: ${error.message}`);
}

function bp(row: Row, prefix: string) {
  const home = row[`${prefix}_1_bp`];
  const draw = row[`${prefix}_x_bp`];
  const away = row[`${prefix}_2_bp`];
  if (typeof home !== "number" || typeof draw !== "number" || typeof away !== "number") {
    return null;
  }
  return { home, draw, away };
}

function single<T>(values: T[]): T | null {
  return values.length === 1 ? values[0] : null;
}

export interface ShadowEvaluationStore {
  loadRoundFixtureIds(roundId: string): Promise<string[]>;
  loadFixtureContexts(fixtureIds: string[]): Promise<ShadowFixtureContext[]>;
  loadHistory(
    competitionKey: string,
    cutoffAt: string,
    lookbackDays: number,
  ): Promise<HistoricalMatchResult[]>;
  loadMarketQuotes(fixtureId: string, cutoffAt: string): Promise<MarketQuoteRecord[]>;
  insertPredictions(drafts: EvalPredictionDraft[]): Promise<{ inserted: number; duplicates: number }>;
  loadPublishedKapiloto(fixtureIds: string[]): Promise<PublishedKapilotoAnalysis[]>;
  loadPredictions(fixtureIds: string[], mode: EvaluationMode): Promise<StoredEvalPrediction[]>;
  loadFixturesForEvaluation(fixtureIds: string[]): Promise<FixtureForEvaluation[]>;
  insertScores(drafts: EvalScoreDraft[]): Promise<number>;
}

export type StoredScoreSummary = {
  fixture_id: string;
  arm: string;
  arm_version: string;
  status: string;
};

export type QuoteSnapshotSummary = {
  fixtureId: string;
  capturedAt: string;
  bookmakers: number;
};

/** Reads and writes used by the scheduled shadow cycle and the operator report. */
export interface ShadowCycleStore
  extends ShadowEvaluationStore, MarketQuoteSink, MarketCaptureAttemptSink {
  loadLatestCaptureAttempts(fixtureIds: string[]): Promise<Map<string, LastActivity>>;
  loadProviderRequestsSince(provider: string, sinceAt: string): Promise<number>;
  loadLatestQuoteCapturedAt(fixtureIds: string[]): Promise<Map<string, string>>;
  loadLatestPredictionIssuedAt(
    fixtureIds: string[],
    arm: string,
    mode: EvaluationMode,
  ): Promise<Map<string, string>>;
  loadFinishedFixtureIdsBetween(fromAt: string, toAt: string): Promise<string[]>;
  loadScores(fixtureIds: string[], mode: EvaluationMode): Promise<StoredScoreSummary[]>;
  loadLatestQuoteSnapshots(fixtureIds: string[], sinceAt: string): Promise<QuoteSnapshotSummary[]>;
  loadSupportedCompetitionKeys(): Promise<string[]>;
}

export class SupabaseShadowEvaluationStore implements ShadowCycleStore {
  constructor(private readonly client: SupabaseClient) {}

  async saveQuotes(rows: MarketQuoteDraft[]): Promise<number> {
    return new SupabaseMarketQuoteStore(this.client).saveQuotes(rows);
  }

  async saveAttempt(row: MarketCaptureAttemptDraft): Promise<void> {
    const { error } = await this.client.from("fixture_market_capture_attempts").insert(row);
    if (error) fail("Failed to record market capture attempt", error);
  }

  async loadLatestCaptureAttempts(fixtureIds: string[]): Promise<Map<string, LastActivity>> {
    const latest = new Map<string, LastActivity>();
    if (fixtureIds.length === 0) return latest;
    const { data, error } = await this.client
      .from("fixture_market_capture_attempts")
      .select("fixture_id,attempted_at,status")
      .in("fixture_id", fixtureIds)
      .neq("status", "skipped_budget")
      .order("attempted_at", { ascending: false })
      .limit(PAGE_SIZE);
    if (error) fail("Failed to load market capture attempts", error);
    for (const row of (data ?? []) as Row[]) {
      const fixtureId = String(row.fixture_id);
      if (!latest.has(fixtureId)) {
        latest.set(fixtureId, {
          at: new Date(String(row.attempted_at)).toISOString(),
          status: String(row.status),
        });
      }
    }
    return latest;
  }

  async loadProviderRequestsSince(provider: string, sinceAt: string): Promise<number> {
    let total = 0;
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await this.client
        .from("fixture_market_capture_attempts")
        .select("provider_requests")
        .eq("provider", provider)
        .gte("attempted_at", sinceAt)
        .order("attempted_at", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) fail("Failed to load provider request usage", error);
      const page = (data ?? []) as Row[];
      total += page.reduce((sum, row) => sum + Number(row.provider_requests ?? 0), 0);
      if (page.length < PAGE_SIZE) break;
    }
    return total;
  }

  async loadLatestQuoteCapturedAt(fixtureIds: string[]): Promise<Map<string, string>> {
    const latest = new Map<string, string>();
    await Promise.all(
      fixtureIds.map(async (fixtureId) => {
        const { data, error } = await this.client
          .from("fixture_market_quotes")
          .select("captured_at")
          .eq("fixture_id", fixtureId)
          .order("captured_at", { ascending: false })
          .limit(1);
        if (error) fail("Failed to load latest market quote", error);
        const row = ((data ?? []) as Row[])[0];
        if (row) latest.set(fixtureId, new Date(String(row.captured_at)).toISOString());
      }),
    );
    return latest;
  }

  async loadLatestPredictionIssuedAt(
    fixtureIds: string[],
    arm: string,
    mode: EvaluationMode,
  ): Promise<Map<string, string>> {
    const latest = new Map<string, string>();
    await Promise.all(
      fixtureIds.map(async (fixtureId) => {
        const { data, error } = await this.client
          .from("kapiloto_eval_predictions")
          .select("issued_at")
          .eq("fixture_id", fixtureId)
          .eq("arm", arm)
          .eq("evaluation_mode", mode)
          .order("issued_at", { ascending: false })
          .limit(1);
        if (error) fail("Failed to load latest evaluation prediction", error);
        const row = ((data ?? []) as Row[])[0];
        if (row) latest.set(fixtureId, new Date(String(row.issued_at)).toISOString());
      }),
    );
    return latest;
  }

  async loadFinishedFixtureIdsBetween(fromAt: string, toAt: string): Promise<string[]> {
    const { data, error } = await this.client
      .from("fixtures")
      .select("id")
      .in("status", ["finished", "cancelled"])
      .gte("kickoff_at", fromAt)
      .lt("kickoff_at", toAt)
      .order("kickoff_at", { ascending: true });
    if (error) fail("Failed to load finished fixtures", error);
    return ((data ?? []) as Row[]).map((row) => String(row.id));
  }

  async loadScores(fixtureIds: string[], mode: EvaluationMode): Promise<StoredScoreSummary[]> {
    if (fixtureIds.length === 0) return [];
    const { data, error } = await this.client
      .from("kapiloto_eval_scores")
      .select("fixture_id,arm,arm_version,status")
      .in("fixture_id", fixtureIds)
      .eq("evaluation_mode", mode);
    if (error) fail("Failed to load evaluation scores", error);
    return (data ?? []) as StoredScoreSummary[];
  }

  async loadLatestQuoteSnapshots(
    fixtureIds: string[],
    sinceAt: string,
  ): Promise<QuoteSnapshotSummary[]> {
    if (fixtureIds.length === 0) return [];
    const rows: Row[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await this.client
        .from("fixture_market_quotes")
        .select("fixture_id,captured_at,bookmaker_id")
        .in("fixture_id", fixtureIds)
        .gte("captured_at", sinceAt)
        .order("captured_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) fail("Failed to load market quote snapshots", error);
      const page = (data ?? []) as Row[];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    const snapshots = new Map<string, { capturedAt: string; bookmakers: Set<string> }>();
    for (const row of rows) {
      const fixtureId = String(row.fixture_id);
      const capturedAt = new Date(String(row.captured_at)).toISOString();
      const existing = snapshots.get(fixtureId);
      if (!existing) {
        snapshots.set(fixtureId, { capturedAt, bookmakers: new Set([String(row.bookmaker_id)]) });
      } else if (existing.capturedAt === capturedAt) {
        existing.bookmakers.add(String(row.bookmaker_id));
      }
    }
    return [...snapshots.entries()].map(([fixtureId, snapshot]) => ({
      fixtureId,
      capturedAt: snapshot.capturedAt,
      bookmakers: snapshot.bookmakers.size,
    }));
  }

  async loadSupportedCompetitionKeys(): Promise<string[]> {
    const { data, error } = await this.client
      .from("provider_competition_mappings")
      .select("provider_competition_id,mapping_status")
      .eq("provider", SHADOW_HISTORY_PROVIDER);
    if (error) fail("Failed to load competition mappings", error);
    return [
      ...new Set(
        ((data ?? []) as Row[])
          .filter((row) => row.mapping_status !== "unverified")
          .map((row) => `${SHADOW_HISTORY_PROVIDER}:${row.provider_competition_id}`),
      ),
    ].sort();
  }

  async loadRoundFixtureIds(roundId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from("round_games")
      .select("fixture_id,game_number")
      .eq("round_id", roundId)
      .order("game_number", { ascending: true });
    if (error) fail("Failed to load round fixtures", error);
    return ((data ?? []) as Row[]).map((row) => String(row.fixture_id));
  }

  async loadFixtureContexts(fixtureIds: string[]): Promise<ShadowFixtureContext[]> {
    if (fixtureIds.length === 0) return [];
    const { data: fixtures, error } = await this.client
      .from("fixtures")
      .select("id,competition_id,home_team_id,away_team_id,kickoff_at,neutral_venue")
      .in("id", fixtureIds);
    if (error) fail("Failed to load fixtures", error);
    const fixtureRows = (fixtures ?? []) as Row[];

    const competitionIds = [
      ...new Set(fixtureRows.map((row) => row.competition_id).filter(Boolean)),
    ] as string[];
    const teamIds = [
      ...new Set(fixtureRows.flatMap((row) => [row.home_team_id, row.away_team_id])),
    ] as string[];

    const [games, competitions, teams] = await Promise.all([
      this.client.from("round_games").select("id,fixture_id").in("fixture_id", fixtureIds),
      competitionIds.length > 0
        ? this.client
            .from("provider_competition_mappings")
            .select("competition_id,provider_competition_id,mapping_status")
            .eq("provider", SHADOW_HISTORY_PROVIDER)
            .in("competition_id", competitionIds)
        : Promise.resolve({ data: [], error: null }),
      this.client
        .from("provider_team_mappings")
        .select("team_id,provider_team_id,mapping_status")
        .eq("provider", SHADOW_HISTORY_PROVIDER)
        .in("team_id", teamIds),
    ]);
    if (games.error) fail("Failed to load round games", games.error);
    if (competitions.error) fail("Failed to load competition mappings", competitions.error);
    if (teams.error) fail("Failed to load team mappings", teams.error);

    const confirmed = (row: Row) => row.mapping_status !== "unverified";
    const competitionKey = (competitionId: unknown) => {
      const mapped = ((competitions.data ?? []) as Row[]).filter(
        (row) => row.competition_id === competitionId && confirmed(row),
      );
      const only = single(mapped);
      return only ? `${SHADOW_HISTORY_PROVIDER}:${only.provider_competition_id}` : null;
    };
    const teamKey = (teamId: unknown) => {
      const mapped = ((teams.data ?? []) as Row[]).filter(
        (row) => row.team_id === teamId && confirmed(row),
      );
      const only = single(mapped);
      return only ? `${SHADOW_HISTORY_PROVIDER}:${only.provider_team_id}` : null;
    };

    return fixtureRows
      .map((row) => {
        const roundGames = ((games.data ?? []) as Row[]).filter(
          (game) => game.fixture_id === row.id,
        );
        return {
          fixtureId: String(row.id),
          roundGameId: single(roundGames)?.id ? String(single(roundGames)?.id) : null,
          homeTeamId: String(row.home_team_id),
          awayTeamId: String(row.away_team_id),
          kickoffAt: new Date(String(row.kickoff_at)).toISOString(),
          neutralVenue: row.neutral_venue === true,
          competitionKey: competitionKey(row.competition_id),
          homeTeamKey: teamKey(row.home_team_id),
          awayTeamKey: teamKey(row.away_team_id),
        };
      })
      .sort((a, b) => a.fixtureId.localeCompare(b.fixtureId));
  }

  async loadHistory(
    competitionKey: string,
    cutoffAt: string,
    lookbackDays: number,
  ): Promise<HistoricalMatchResult[]> {
    const separator = competitionKey.indexOf(":");
    const provider = competitionKey.slice(0, separator);
    const competitionId = competitionKey.slice(separator + 1);
    const startAt = new Date(
      Date.parse(cutoffAt) - lookbackDays * 86_400_000,
    ).toISOString();

    const rows: Row[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await this.client
        .from("football_match_results")
        .select(
          "provider,provider_fixture_id,provider_competition_id,kickoff_at,provider_home_team_id,provider_away_team_id,home_goals_90,away_goals_90,neutral_venue",
        )
        .eq("provider", provider)
        .eq("provider_competition_id", competitionId)
        .gte("kickoff_at", startAt)
        .lt("kickoff_at", cutoffAt)
        .order("kickoff_at", { ascending: true })
        .order("provider_fixture_id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) fail("Failed to load match history", error);
      const page = (data ?? []) as Row[];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    return rows.map((row) => ({
      provider: String(row.provider),
      providerFixtureId: String(row.provider_fixture_id),
      competitionKey: `${row.provider}:${row.provider_competition_id}`,
      kickoffAt: new Date(String(row.kickoff_at)).toISOString(),
      homeTeamKey: `${row.provider}:${row.provider_home_team_id}`,
      awayTeamKey: `${row.provider}:${row.provider_away_team_id}`,
      homeGoals: Number(row.home_goals_90),
      awayGoals: Number(row.away_goals_90),
      neutralVenue: row.neutral_venue === true,
    }));
  }

  async loadMarketQuotes(fixtureId: string, cutoffAt: string): Promise<MarketQuoteRecord[]> {
    const { data, error } = await this.client
      .from("fixture_market_quotes")
      .select(
        "id,fixture_id,provider,bookmaker_id,bookmaker_name,captured_at,source_updated_at,odds_home,odds_draw,odds_away",
      )
      .eq("fixture_id", fixtureId)
      .lte("captured_at", cutoffAt)
      .order("captured_at", { ascending: false });
    if (error) fail("Failed to load market quotes", error);
    return ((data ?? []) as Row[]).map((row) => ({
      id: String(row.id),
      fixtureId: String(row.fixture_id),
      provider: String(row.provider),
      bookmakerId: String(row.bookmaker_id),
      bookmakerName: String(row.bookmaker_name ?? row.bookmaker_id),
      capturedAt: new Date(String(row.captured_at)).toISOString(),
      sourceUpdatedAt:
        row.source_updated_at == null
          ? null
          : new Date(String(row.source_updated_at)).toISOString(),
      odds: {
        home: Number(row.odds_home),
        draw: Number(row.odds_draw),
        away: Number(row.odds_away),
      },
    }));
  }

  async insertPredictions(
    drafts: EvalPredictionDraft[],
  ): Promise<{ inserted: number; duplicates: number }> {
    let inserted = 0;
    let duplicates = 0;
    for (const draft of drafts) {
      const { error } = await this.client.from("kapiloto_eval_predictions").insert(draft);
      if (!error) inserted += 1;
      else if (error.code === UNIQUE_VIOLATION) duplicates += 1;
      else fail("Failed to insert evaluation prediction", error);
    }
    return { inserted, duplicates };
  }

  async loadPublishedKapiloto(fixtureIds: string[]): Promise<PublishedKapilotoAnalysis[]> {
    if (fixtureIds.length === 0) return [];
    const { data: publications, error } = await this.client
      .from("kapiloto_fixture_publications")
      .select("id,fixture_id,analysis_id,research_run_id,published_at")
      .in("fixture_id", fixtureIds);
    if (error) fail("Failed to load Kapiloto publications", error);
    const publicationRows = (publications ?? []) as Row[];
    if (publicationRows.length === 0) return [];

    const analysisIds = publicationRows.map((row) => String(row.analysis_id));
    const runIds = [...new Set(publicationRows.map((row) => String(row.research_run_id)))];
    const [analyses, runs] = await Promise.all([
      this.client
        .from("kapiloto_analyses")
        .select(
          "id,round_game_id,outcome,orientation_verified,research_cutoff_at,kickoff_at_snapshot,prior_type,p_final_1_bp,p_final_x_bp,p_final_2_bp,p_sol_1_bp,p_sol_x_bp,p_sol_2_bp",
        )
        .in("id", analysisIds),
      this.client
        .from("kapiloto_research_runs")
        .select(
          "id,derivation_version,blend_policy_version,reliability_formula_version,calibration_version",
        )
        .in("id", runIds),
    ]);
    if (analyses.error) fail("Failed to load Kapiloto analyses", analyses.error);
    if (runs.error) fail("Failed to load Kapiloto runs", runs.error);

    const analysisRows = new Map(
      ((analyses.data ?? []) as Row[]).map((row) => [String(row.id), row]),
    );
    const runRows = new Map(((runs.data ?? []) as Row[]).map((row) => [String(row.id), row]));
    const roundGameIds = [
      ...new Set([...analysisRows.values()].map((row) => String(row.round_game_id))),
    ];
    const { data: games, error: gamesError } = await this.client
      .from("round_games")
      .select("id,home_team_id,away_team_id")
      .in("id", roundGameIds);
    if (gamesError) fail("Failed to load round games", gamesError);
    const gameRows = new Map(((games ?? []) as Row[]).map((row) => [String(row.id), row]));

    return publicationRows.flatMap((publication) => {
      const analysis = analysisRows.get(String(publication.analysis_id));
      const game = analysis ? gameRows.get(String(analysis.round_game_id)) : undefined;
      if (!analysis || !game) return [];
      const run = runRows.get(String(publication.research_run_id));
      return [
        {
          publicationId: String(publication.id),
          publishedAt: new Date(String(publication.published_at)).toISOString(),
          analysisId: String(analysis.id),
          researchRunId: String(publication.research_run_id),
          fixtureId: String(publication.fixture_id),
          roundGameId: String(analysis.round_game_id),
          outcome: String(analysis.outcome),
          orientationVerified: analysis.orientation_verified === true,
          researchCutoffAt: new Date(String(analysis.research_cutoff_at)).toISOString(),
          kickoffAtSnapshot: new Date(String(analysis.kickoff_at_snapshot)).toISOString(),
          roundGameHomeTeamId: String(game.home_team_id),
          roundGameAwayTeamId: String(game.away_team_id),
          priorType: (analysis.prior_type as string | null) ?? null,
          pFinal: bp(analysis, "p_final"),
          pSol: bp(analysis, "p_sol"),
          derivationVersion: (run?.derivation_version as string | null) ?? null,
          blendPolicyVersion: (run?.blend_policy_version as string | null) ?? null,
          reliabilityFormulaVersion:
            (run?.reliability_formula_version as string | null) ?? null,
          calibrationVersion: (run?.calibration_version as string | null) ?? null,
        },
      ];
    });
  }

  async loadPredictions(
    fixtureIds: string[],
    mode: EvaluationMode,
  ): Promise<StoredEvalPrediction[]> {
    if (fixtureIds.length === 0) return [];
    const { data, error } = await this.client
      .from("kapiloto_eval_predictions")
      .select(
        "id,fixture_id,arm,arm_version,evaluation_mode,deterministic,information_cutoff_at,issued_at,recorded_at,kickoff_at_snapshot,home_team_id,away_team_id,valid,invalid_reason,p_home,p_draw,p_away",
      )
      .in("fixture_id", fixtureIds)
      .eq("evaluation_mode", mode);
    if (error) fail("Failed to load evaluation predictions", error);
    return (data ?? []) as StoredEvalPrediction[];
  }

  async loadFixturesForEvaluation(fixtureIds: string[]): Promise<FixtureForEvaluation[]> {
    if (fixtureIds.length === 0) return [];
    const { data, error } = await this.client
      .from("fixtures")
      .select(
        "id,home_team_id,away_team_id,kickoff_at,actual_kickoff_at,status,home_score,away_score",
      )
      .in("id", fixtureIds);
    if (error) fail("Failed to load fixtures for evaluation", error);
    return ((data ?? []) as Row[]).map((row) => ({
      fixtureId: String(row.id),
      homeTeamId: String(row.home_team_id),
      awayTeamId: String(row.away_team_id),
      kickoffAt: new Date(String(row.kickoff_at)).toISOString(),
      actualKickoffAt:
        row.actual_kickoff_at == null
          ? null
          : new Date(String(row.actual_kickoff_at)).toISOString(),
      status: String(row.status),
      homeScore: row.home_score == null ? null : Number(row.home_score),
      awayScore: row.away_score == null ? null : Number(row.away_score),
    }));
  }

  async insertScores(drafts: EvalScoreDraft[]): Promise<number> {
    if (drafts.length === 0) return 0;
    const { data, error } = await this.client
      .from("kapiloto_eval_scores")
      .upsert(drafts, {
        onConflict:
          "fixture_id,arm,arm_version,evaluation_mode,selection_rule_version,scoring_version",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) fail("Failed to insert evaluation scores", error);
    return (data ?? []).length;
  }
}

export class SupabaseMatchResultStore implements MatchResultSink {
  constructor(private readonly client: SupabaseClient) {}

  async saveResults(rows: MatchResultRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const { data, error } = await this.client
      .from("football_match_results")
      .upsert(rows, { onConflict: "provider,provider_fixture_id", ignoreDuplicates: true })
      .select("id");
    if (error) fail("Failed to save match results", error);
    return (data ?? []).length;
  }
}

export class SupabaseMarketQuoteStore implements MarketQuoteSink {
  constructor(private readonly client: SupabaseClient) {}

  async saveQuotes(rows: MarketQuoteDraft[]): Promise<number> {
    if (rows.length === 0) return 0;
    const { data, error } = await this.client
      .from("fixture_market_quotes")
      .insert(rows)
      .select("id");
    if (error) fail("Failed to save market quotes", error);
    return (data ?? []).length;
  }
}
