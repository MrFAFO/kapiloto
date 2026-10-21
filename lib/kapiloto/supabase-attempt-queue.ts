import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ClaimedResearchAttempt,
  FinishResearchAttemptInput,
  ResearchAttemptQueue,
} from "./research-task-executor";

function camelClaim(data: Record<string, unknown>): ClaimedResearchAttempt {
  const run = data.run as Record<string, unknown>;
  return {
    attemptId: String(data.attempt_id),
    runId: String(data.run_id),
    roundId: String(data.round_id),
    taskKey: String(data.task_key),
    roundGameId:
      data.round_game_id == null ? null : String(data.round_game_id),
    attemptNo: Number(data.attempt_no),
    leaseExpiresAt: String(data.lease_expires_at),
    fixtureCard:
      data.fixture_card == null
        ? null
        : (data.fixture_card as ClaimedResearchAttempt["fixtureCard"]),
    run: {
      modelKey: String(run.model_key),
      researchProtocolVersion: String(run.research_protocol_version),
      promptTemplateSha256: String(run.prompt_template_sha256),
      maxAttemptsPerTask: Number(run.max_attempts_per_task),
      executionTopology: String(
        run.execution_topology,
      ) as ClaimedResearchAttempt["run"]["executionTopology"],
      researchCutoffAt: String(run.research_cutoff_at),
    },
  };
}

export class SupabaseResearchAttemptQueue implements ResearchAttemptQueue {
  constructor(private readonly client: SupabaseClient) {}

  async claim(
    workerId: string,
    leaseSeconds: number,
  ): Promise<ClaimedResearchAttempt | null> {
    const { data, error } = await this.client.rpc(
      "kapiloto_claim_research_attempt",
      {
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
      },
    );

    if (error) {
      throw new Error(`Failed to claim Kapiloto attempt: ${error.message}`);
    }
    if (data == null) return null;
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Kapiloto claim RPC returned an invalid payload.");
    }

    return camelClaim(data as Record<string, unknown>);
  }

  async heartbeat(
    attemptId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc(
      "kapiloto_heartbeat_research_attempt",
      {
        p_attempt_id: attemptId,
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
      },
    );

    if (error) {
      throw new Error(`Failed to heartbeat Kapiloto attempt: ${error.message}`);
    }
    return data === true;
  }

  async finish(input: FinishResearchAttemptInput): Promise<{
    retryCreated: boolean;
    nextAttemptId: string | null;
  }> {
    const { data, error } = await this.client.rpc(
      "kapiloto_finish_research_attempt",
      {
        p_attempt_id: input.attemptId,
        p_worker_id: input.workerId,
        p_success: input.success,
        p_retryable: input.retryable,
        p_retry_delay_seconds: input.retryDelaySeconds,
        p_model_snapshot: input.modelSnapshot,
        p_provider_response_id: input.providerResponseId,
        p_input_tokens: input.inputTokens,
        p_cached_input_tokens: input.cachedInputTokens,
        p_output_tokens: input.outputTokens,
        p_reasoning_tokens: input.reasoningTokens,
        p_web_search_calls: input.webSearchCalls,
        p_sources_count: input.sourcesCount,
        p_cost_micros: input.costMicros,
        p_pricing_version: input.pricingVersion,
        p_model_ms: input.modelMs,
        p_validation_ms: input.validationMs,
        p_total_ms: input.totalMs,
        p_failure_class: input.failureClass,
        p_failure_code: input.failureCode,
        p_failure_detail: input.failureDetail,
        p_validated_output: input.validatedOutput,
        p_validation_report: input.validationReport,
        p_trace_id: input.traceId,
      },
    );

    if (error) {
      throw new Error(`Failed to finish Kapiloto attempt: ${error.message}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Kapiloto finish RPC returned an invalid payload.");
    }

    const result = data as Record<string, unknown>;
    return {
      retryCreated: result.retry_created === true,
      nextAttemptId:
        result.next_attempt_id == null
          ? null
          : String(result.next_attempt_id),
    };
  }
}
