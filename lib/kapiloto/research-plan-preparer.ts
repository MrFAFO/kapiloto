import type { SupabaseClient } from "@supabase/supabase-js";

import { loadRoundFixtureCardInputs } from "./fixture-input-store";
import { buildKapilotoResearchRunPlan } from "./research-run-plan";
import type {
  KapilotoResearchPreparer,
  PreparedKapilotoRun,
} from "./research-request-service";

type PreviousAnalysisRow = {
  id: string;
  fixture_id: string;
  carried_from_analysis_id: string | null;
};

export class SupabaseKapilotoResearchPreparer
  implements KapilotoResearchPreparer
{
  constructor(
    private readonly client: SupabaseClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async loadPreviousAnalyses(
    currentRunId: string | null,
  ): Promise<Array<{ fixtureId: string; analysisId: string }>> {
    if (currentRunId == null) return [];

    const { data, error } = await this.client
      .from("kapiloto_analyses")
      .select("id,fixture_id,carried_from_analysis_id")
      .eq("research_run_id", currentRunId);

    if (error) {
      throw new Error(
        `Failed to load current Kapiloto analyses: ${error.message}`,
      );
    }

    return ((data ?? []) as PreviousAnalysisRow[]).map((row) => ({
      fixtureId: row.fixture_id,
      analysisId: row.carried_from_analysis_id ?? row.id,
    }));
  }

  async prepare(input: {
    roundId: string;
    currentRunId: string | null;
  }): Promise<PreparedKapilotoRun> {
    // Provider collection is scheduled independently from user demand. The
    // research request freezes whatever provider snapshots already exist at
    // this instant; it never performs slow or billable football-data calls.
    const researchCutoffAt = this.clock().toISOString();

    const [fixtureInputs, previousAnalyses] = await Promise.all([
      loadRoundFixtureCardInputs(
        this.client,
        input.roundId,
        researchCutoffAt,
        "api-football",
      ),
      this.loadPreviousAnalyses(input.currentRunId),
    ]);

    const plan = buildKapilotoResearchRunPlan(
      fixtureInputs,
      researchCutoffAt,
      previousAnalyses,
    );

    return {
      researchCutoffAt: plan.researchCutoffAt,
      fixtureSet: plan.fixtures,
      fixtureSetSha256: plan.fixtureSetSha256,
      taskGameIds: plan.taskGameIds,
      inputSnapshot: {
        task_fixture_ids: plan.taskFixtureIds,
        prior_strategy: "cached-market-with-league-base-fallback",
        structured_provider: "scheduled_snapshot",
        provider_sync_started_at: null,
        provider_sync_completed_at: null,
        provider_sync_summary: { status: "scheduled_provider_sync" },
        prepared_at: researchCutoffAt,
      },
    };
  }
}
