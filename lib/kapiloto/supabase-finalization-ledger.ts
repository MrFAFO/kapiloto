import type { SupabaseClient } from "@supabase/supabase-js";

import type { MaterializedRound } from "./run-materialization";
import {
  FinalizationClaimLostError,
  KAPILOTO_FINALIZATION_MAX_ATTEMPTS,
  type FencedPublicationResult,
  type FinalizationClaimResult,
  type FinalizationFailure,
  type FinalizationObservability,
  type KapilotoFinalizationLedger,
} from "./run-finalizer";

function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function record(value: unknown, rpc: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${rpc} returned an invalid payload.`);
  }
  return value as Record<string, unknown>;
}

const SKIP_OUTCOMES = new Set([
  "already_claimed",
  "already_completed",
  "not_finalizable",
  "not_ready",
  "backoff",
  "exhausted",
]);

export function parseFinalizationClaim(value: unknown): FinalizationClaimResult {
  const row = record(value, "kapiloto_claim_run_finalization");
  const outcome = row.outcome;

  if (outcome === "claimed") {
    if (
      typeof row.attempt_id !== "string" ||
      typeof row.attempt_no !== "number" ||
      typeof row.lease_expires_at !== "string"
    ) {
      throw new Error("Finalization claim response is incomplete.");
    }
    return {
      outcome: "claimed",
      attemptId: row.attempt_id,
      attemptNo: row.attempt_no,
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  if (typeof outcome === "string" && SKIP_OUTCOMES.has(outcome)) {
    return {
      outcome: outcome as Exclude<FinalizationClaimResult["outcome"], "claimed">,
      detail: row,
    };
  }

  throw new Error(`Unknown finalization claim outcome: ${String(outcome)}`);
}

export class SupabaseKapilotoFinalizationLedger
  implements KapilotoFinalizationLedger
{
  constructor(
    private readonly client: SupabaseClient,
    private readonly maxAttempts = KAPILOTO_FINALIZATION_MAX_ATTEMPTS,
  ) {}

  async claim(
    runId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<FinalizationClaimResult> {
    const { data, error } = await this.client.rpc(
      "kapiloto_claim_run_finalization",
      {
        p_run_id: runId,
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
        p_max_attempts: this.maxAttempts,
      },
    );
    if (error) {
      throw new Error(`Failed to claim Kapiloto finalization: ${error.message}`);
    }
    return parseFinalizationClaim(data);
  }

  async heartbeat(
    attemptId: string,
    workerId: string,
    leaseSeconds: number,
    observability?: FinalizationObservability,
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc(
      "kapiloto_heartbeat_run_finalization",
      {
        p_attempt_id: attemptId,
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
        p_observability: observability ? asJson(observability) : null,
      },
    );
    if (error) {
      throw new Error(
        `Failed to heartbeat Kapiloto finalization: ${error.message}`,
      );
    }
    return data === true;
  }

  async publish(
    attemptId: string,
    workerId: string,
    materialized: MaterializedRound,
    observability: FinalizationObservability,
  ): Promise<FencedPublicationResult> {
    const { data, error } = await this.client.rpc(
      "kapiloto_publish_run_finalization",
      {
        p_attempt_id: attemptId,
        p_worker_id: workerId,
        p_analyses: asJson(materialized.analyses),
        p_round_synthesis: asJson(materialized.synthesis),
        p_observability: asJson(observability),
      },
    );

    if (error) {
      if (/finalization claim lost/i.test(error.message)) {
        throw new FinalizationClaimLostError(error.message);
      }
      throw new Error(
        `Failed to publish Kapiloto finalization: ${error.message}`,
      );
    }

    const row = record(data, "kapiloto_publish_run_finalization");
    if (
      typeof row.run_id !== "string" ||
      typeof row.round_id !== "string" ||
      row.status !== "completed" ||
      typeof row.analysis_count !== "number" ||
      typeof row.published_fixture_count !== "number" ||
      typeof row.replayed !== "boolean"
    ) {
      throw new Error("Kapiloto fenced publication response is incomplete.");
    }

    return {
      runId: row.run_id,
      roundId: row.round_id,
      analysisCount: row.analysis_count,
      publishedFixtureCount: row.published_fixture_count,
      replayed: row.replayed,
      claimOutcome:
        row.claim_outcome === "already_completed" ? "already_completed" : "published",
    };
  }

  async fail(
    attemptId: string,
    workerId: string,
    failure: FinalizationFailure,
    observability: FinalizationObservability,
  ): Promise<{ outcome: "claim_lost" | "retry_scheduled" | "run_failed" }> {
    const { data, error } = await this.client.rpc(
      "kapiloto_fail_run_finalization",
      {
        p_attempt_id: attemptId,
        p_worker_id: workerId,
        p_retryable: failure.retryable,
        p_failure_code: failure.code,
        p_failure_detail: failure.detail,
        p_retry_delay_seconds: failure.retryDelaySeconds,
        p_observability: asJson(observability),
        p_max_attempts: this.maxAttempts,
      },
    );
    if (error) {
      throw new Error(
        `Failed to record Kapiloto finalization failure: ${error.message}`,
      );
    }

    const outcome = record(data, "kapiloto_fail_run_finalization").outcome;
    if (
      outcome !== "claim_lost" &&
      outcome !== "retry_scheduled" &&
      outcome !== "run_failed"
    ) {
      throw new Error(`Unknown finalization failure outcome: ${String(outcome)}`);
    }
    return { outcome };
  }
}
