import type { SupabaseClient } from "@supabase/supabase-js";

export type KapilotoPublicFixtureAnalysis = {
  analysisId: string;
  runId: string;
  outcome: string;
  primaryPick: "1" | "X" | "2" | null;
  suggestedDouble: "1X" | "X2" | "12" | null;
  doublePriorityRank: number | null;
  doubleRecommended: boolean;
  reliabilityBand: "low" | "medium" | "high" | null;
  summary: string | null;
  mainRisk: string | null;
  generatedAt: string;
  validUntil: string | null;
};

export async function loadPublicFixtureAnalysis(
  admin: SupabaseClient,
  runId: string,
  roundGameId: string,
  maxDoubles: number,
): Promise<KapilotoPublicFixtureAnalysis | null> {
  const { data, error } = await admin
    .from("kapiloto_analyses")
    .select(
      "id,research_run_id,outcome,primary_pick,suggested_double,double_priority_rank,reliability_band,summary,main_risk,generated_at,valid_until",
    )
    .eq("research_run_id", runId)
    .eq("round_game_id", roundGameId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to load Kapiloto fixture analysis: ${error.message}`,
    );
  }
  if (!data) return null;

  const rank =
    data.double_priority_rank == null
      ? null
      : Number(data.double_priority_rank);

  return {
    analysisId: String(data.id),
    runId: String(data.research_run_id),
    outcome: String(data.outcome),
    primaryPick:
      data.primary_pick == null
        ? null
        : (data.primary_pick as "1" | "X" | "2"),
    suggestedDouble:
      data.suggested_double == null
        ? null
        : (data.suggested_double as "1X" | "X2" | "12"),
    doublePriorityRank: rank,
    doubleRecommended:
      rank != null && maxDoubles > 0 && rank <= maxDoubles,
    reliabilityBand:
      data.reliability_band == null
        ? null
        : (data.reliability_band as "low" | "medium" | "high"),
    summary: data.summary == null ? null : String(data.summary),
    mainRisk: data.main_risk == null ? null : String(data.main_risk),
    generatedAt: String(data.generated_at),
    validUntil:
      data.valid_until == null ? null : String(data.valid_until),
  };
}
