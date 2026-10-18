import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiFootballClient } from "@/lib/providers/api-football";

import {
  getApiFootballMinRequestIntervalMs,
  getKapilotoRunConfig,
} from "./research-config";
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
      const apiKey = process.env.API_FOOTBALL_API_KEY?.trim();
      if (!apiKey) {
        throw new Error(
          "API_FOOTBALL_API_KEY is required when a new Kapiloto run needs preparation.",
        );
      }

      const apiFootball = new ApiFootballClient(apiKey, {
        minRequestIntervalMs: getApiFootballMinRequestIntervalMs(),
      });

      return new SupabaseKapilotoResearchPreparer(
        admin,
        apiFootball,
      ).prepare(input);
    },
  };

  return ensureKapilotoResearch(
    rpc,
    lazyPreparer,
    request,
    getKapilotoRunConfig(),
  );
}
