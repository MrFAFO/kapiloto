import type { SupabaseClient } from "@supabase/supabase-js";

import { getKapilotoRunConfig } from "./research-config";
import { loadKapilotoWeeklyBudgetStatus } from "./research-cost";
import { SupabaseKapilotoResearchPreparer } from "./research-plan-preparer";
import {
  ensureKapilotoResearch,
  type KapilotoResearchRequestInput,
  type KapilotoResearchPreparer,
  type KapilotoRpcResponse,
} from "./research-request-service";
import { SupabaseKapilotoResearchRpc } from "./supabase-research-rpc";

export async function ensureServerKapilotoResearch(
  admin: SupabaseClient,
  request: KapilotoResearchRequestInput,
): Promise<KapilotoRpcResponse> {
  const rpc = new SupabaseKapilotoResearchRpc(admin);

  const lazyPreparer: KapilotoResearchPreparer = {
    async prepare(input) {
      if (!process.env.OPENAI_API_KEY?.trim()) {
        throw new Error(
          "OPENAI_API_KEY is required before a new Kapiloto research run can be created.",
        );
      }

      return new SupabaseKapilotoResearchPreparer(admin).prepare(input);
    },
  };

  const budget = await loadKapilotoWeeklyBudgetStatus(
    admin as Parameters<typeof loadKapilotoWeeklyBudgetStatus>[0],
  );

  return ensureKapilotoResearch(
    rpc,
    lazyPreparer,
    {
      ...request,
      breakerOpen: request.breakerOpen || !budget.canCreateRun,
    },
    getKapilotoRunConfig(),
  );
}