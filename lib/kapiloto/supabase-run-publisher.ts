import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

import type { MaterializedRound } from "./run-materialization";

export type KapilotoRunPublicationResult = {
  runId: string;
  roundId: string;
  status: "completed";
  analysisCount: number;
  publishedFixtureCount: number;
  replayed: boolean;
};

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function parsePublicationResult(value: Json): KapilotoRunPublicationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kapiloto materialization RPC returned an invalid response.");
  }

  const row = value as Record<string, Json | undefined>;
  const runId = row.run_id;
  const roundId = row.round_id;
  const status = row.status;
  const analysisCount = row.analysis_count;
  const publishedFixtureCount = row.published_fixture_count;
  const replayed = row.replayed;

  if (
    typeof runId !== "string" ||
    typeof roundId !== "string" ||
    status !== "completed" ||
    typeof analysisCount !== "number" ||
    typeof publishedFixtureCount !== "number" ||
    typeof replayed !== "boolean"
  ) {
    throw new Error("Kapiloto materialization RPC response is incomplete.");
  }

  return {
    runId,
    roundId,
    status,
    analysisCount,
    publishedFixtureCount,
    replayed,
  };
}

export class SupabaseKapilotoRunPublisher {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async publish(
    runId: string,
    materialized: MaterializedRound,
  ): Promise<KapilotoRunPublicationResult> {
    const { data, error } = await this.client.rpc(
      "kapiloto_materialize_and_complete_run",
      {
        p_run_id: runId,
        p_analyses: asJson(materialized.analyses),
        p_round_synthesis: asJson(materialized.synthesis),
      },
    );

    if (error) {
      throw new Error(
        `Failed to materialize Kapiloto research run: ${error.message}`,
      );
    }

    return parsePublicationResult(data);
  }
}
