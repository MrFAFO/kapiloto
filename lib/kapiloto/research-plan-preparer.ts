import type { SupabaseClient } from "@supabase/supabase-js";

import { SupabaseApiFootballSyncStore } from "@/lib/providers/api-football-supabase-store";
import {
  syncApiFootballRoundMarket,
  type ApiFootballSyncClient,
} from "@/lib/providers/api-football-sync";

import { loadRoundFixtureCardInputs } from "./fixture-input-store";
import { buildKapilotoResearchRunPlan } from "./research-run-plan";
import type {
  KapilotoResearchPreparer,
  PreparedKapilotoRun,
} from "./research-request-service";

type PreviousAnalysisRow = {
  id: string;
  fixture_id: string;
};

export class SupabaseKapilotoResearchPreparer
  implements KapilotoResearchPreparer
{
  constructor(
    private readonly client: SupabaseClient,
    private readonly apiFootball: ApiFootballSyncClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async loadPreviousAnalyses(
    currentRunId: string | null,
  ): Promise<Array<{ fixtureId: string; analysisId: string }>> {
    if (currentRunId == null) return [];

    const { data, error } = await this.client
      .from("kapiloto_analyses")
      .select("id,fixture_id")
      .eq("research_run_id", currentRunId);

    if (error) {
      throw new Error(
        `Failed to load current Kapiloto analyses: ${error.message}`,
      );
    }

    return ((data ?? []) as PreviousAnalysisRow[]).map((row) => ({
      fixtureId: row.fixture_id,
      analysisId: row.id,
    }));
  }

  async prepare(input: {
    roundId: string;
    currentRunId: string | null;
  }): Promise<PreparedKapilotoRun> {
    const syncStore = new SupabaseApiFootballSyncStore(this.client);

    const providerSync = await syncApiFootballRoundMarket(
      syncStore,
      this.apiFootball,
      input.roundId,
      this.clock,
    );

    // Freeze the research evidence boundary only after structured provider
    // refresh has completed. Every selected market snapshot is therefore
    // guaranteed to have been captured at or before this cutoff.
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
        structured_provider: "api-football",
        provider_sync_started_at: providerSync.startedAt,
        provider_sync_completed_at: providerSync.completedAt,
        provider_sync_summary: providerSync.summary,
        prepared_at: researchCutoffAt,
      },
    };
  }
}
