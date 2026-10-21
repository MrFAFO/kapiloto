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
      if (!process.env.OPENAI_API_KEY?.trim()) {
        throw new Error(
          "OPENAI_API_KEY is required before a new Kapiloto research run can be created.",
        );
      }

      const apiKey = process.env.API_FOOTBALL_API_KEY?.trim();
      const apiFootball = apiKey
        ? new ApiFootballClient(apiKey, {
            minRequestIntervalMs: getApiFootballMinRequestIntervalMs(),
          })
        : null;

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
