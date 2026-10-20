import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

import type { KapilotoFixtureCard } from "./fixture-card";
import type { SolFixtureResearchOutput } from "./research-output";
import type { FixtureEvidenceGrounder } from "./research-task-executor";
import {
  verifyGroundedResearchEvidence,
  type GroundingResult,
  type SourceRegistryEntry,
} from "./source-grounding";
import {
  retrieveResearchSourceDocuments,
  type SourceRetrievalResult,
} from "./source-retriever";

type RegistryRow = {
  domain: string;
  denied: boolean;
  tier_by_claim_type: Json;
  metadata: Json;
};

function tierMap(value: Json): Record<string, number | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const mapped: Record<string, number | undefined> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isInteger(raw)) {
      mapped[key] = raw;
    }
  }
  return mapped;
}

function syndicationCluster(value: Json): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value.syndication_cluster_id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

async function loadSourceRegistry(
  client: SupabaseClient<Database>,
): Promise<SourceRegistryEntry[]> {
  const { data, error } = await client
    .from("kapiloto_source_registry")
    .select("domain,denied,tier_by_claim_type,metadata");

  if (error) {
    throw new Error(`Failed to load Kapiloto source registry: ${error.message}`);
  }

  return ((data ?? []) as RegistryRow[]).map((row) => ({
    domain: row.domain,
    denied: row.denied,
    tierByClaimType: tierMap(row.tier_by_claim_type),
    syndicationClusterId: syndicationCluster(row.metadata),
  }));
}

export type RuntimeGroundingResult = {
  grounding: GroundingResult;
  retrieval: SourceRetrievalResult;
};

export async function groundResearchOutput(
  client: SupabaseClient<Database>,
  card: KapilotoFixtureCard,
  output: SolFixtureResearchOutput,
): Promise<RuntimeGroundingResult> {
  const [retrieval, registry] = await Promise.all([
    retrieveResearchSourceDocuments(output),
    loadSourceRegistry(client),
  ]);

  const grounding = verifyGroundedResearchEvidence(
    output,
    card,
    retrieval.documents,
    registry,
  );

  return { grounding, retrieval };
}


export function createSupabaseFixtureEvidenceGrounder(
  client: SupabaseClient<Database>,
): FixtureEvidenceGrounder {
  return {
    async ground(card, output) {
      const result = await groundResearchOutput(client, card, output);
      return {
        grounding: result.grounding,
        retrievalFailures: result.retrieval.failures,
      };
    },
  };
}
