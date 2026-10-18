import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  KapilotoResearchRpc,
  KapilotoRpcCall,
  KapilotoRpcResponse,
} from "./research-request-service";

export class SupabaseKapilotoResearchRpc implements KapilotoResearchRpc {
  constructor(private readonly client: SupabaseClient) {}

  async call(input: KapilotoRpcCall): Promise<KapilotoRpcResponse> {
    const prepared = input.prepared;

    const { data, error } = await this.client.rpc("kapiloto_request_research", {
      p_user_id: input.request.userId,
      p_round_id: input.request.roundId,
      p_round_game_id: input.request.roundGameId,
      p_intent: input.request.intent,
      p_idempotency_key: input.request.idempotencyKey,
      p_request_sha256: input.requestSha256,
      p_based_on_run_id: input.request.basedOnRunId,
      p_breaker_open: input.request.breakerOpen,
      p_model_key: input.config.modelKey,
      p_research_protocol_version: input.config.researchProtocolVersion,
      p_derivation_version: input.config.derivationVersion,
      p_source_policy_version: input.config.sourcePolicyVersion,
      p_recency_policy_version: input.config.recencyPolicyVersion,
      p_reliability_formula_version: input.config.reliabilityFormulaVersion,
      p_blend_policy_version: input.config.blendPolicyVersion,
      p_calibration_version: input.config.calibrationVersion,
      p_prompt_template_sha256: input.config.promptTemplateSha256,
      p_execution_topology: input.config.executionTopology,
      p_research_cutoff_at: prepared?.researchCutoffAt ?? null,
      p_fixture_set: prepared?.fixtureSet ?? null,
      p_fixture_set_sha256: prepared?.fixtureSetSha256 ?? null,
      p_input_snapshot: prepared?.inputSnapshot ?? null,
      p_task_game_ids: prepared?.taskGameIds ?? null,
      p_max_attempts_per_task: input.config.maxAttemptsPerTask,
    });

    if (error) {
      throw new Error(`Kapiloto research RPC failed: ${error.message}`);
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Kapiloto research RPC returned an invalid response.");
    }

    return data as unknown as KapilotoRpcResponse;
  }
}
