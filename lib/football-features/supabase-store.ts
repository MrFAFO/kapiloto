import type { SupabaseClient } from "@supabase/supabase-js";

import type { FixtureStructuredFeaturesV1 } from "./v1";
import type { FixtureStructuredSnapshotDraft } from "./snapshot";

export type StoredFixtureStructuredSnapshot = {
  id: string;
  fixtureId: string;
  featureVersion: string;
  researchCutoffAt: string;
  computedAt: string;
  features: FixtureStructuredFeaturesV1;
  inputPayload: Record<string, unknown>;
  sha256: string;
};

type SnapshotRow = {
  id: string;
  fixture_id: string;
  feature_version: string;
  research_cutoff_at: string;
  computed_at: string;
  features: FixtureStructuredFeaturesV1;
  input_payload: Record<string, unknown>;
  sha256: string;
};

function fromRow(row: SnapshotRow): StoredFixtureStructuredSnapshot {
  return {
    id: row.id,
    fixtureId: row.fixture_id,
    featureVersion: row.feature_version,
    researchCutoffAt: row.research_cutoff_at,
    computedAt: row.computed_at,
    features: row.features,
    inputPayload: row.input_payload,
    sha256: row.sha256,
  };
}

export class SupabaseFixtureStructuredSnapshotStore {
  constructor(private readonly client: SupabaseClient) {}

  async save(
    draft: FixtureStructuredSnapshotDraft,
  ): Promise<StoredFixtureStructuredSnapshot> {
    const { data, error } = await this.client
      .from("fixture_structured_snapshots")
      .insert({
        fixture_id: draft.fixture_id,
        feature_version: draft.feature_version,
        research_cutoff_at: draft.research_cutoff_at,
        computed_at: draft.computed_at,
        features: draft.features,
        input_payload: draft.input_payload,
        sha256: draft.sha256,
      })
      .select(
        "id,fixture_id,feature_version,research_cutoff_at,computed_at,features,input_payload,sha256",
      )
      .single();

    if (error) {
      throw new Error(
        `Failed to persist structured fixture snapshot: ${error.message}`,
      );
    }

    return fromRow(data as SnapshotRow);
  }

  async loadLatestAtOrBefore(
    fixtureIds: string[],
    cutoffAt: string,
  ): Promise<Map<string, StoredFixtureStructuredSnapshot>> {
    if (fixtureIds.length === 0) return new Map();

    const { data, error } = await this.client
      .from("fixture_structured_snapshots")
      .select(
        "id,fixture_id,feature_version,research_cutoff_at,computed_at,features,input_payload,sha256",
      )
      .in("fixture_id", fixtureIds)
      .lte("research_cutoff_at", cutoffAt)
      .order("research_cutoff_at", { ascending: false });

    if (error) {
      throw new Error(
        `Failed to load structured fixture snapshots: ${error.message}`,
      );
    }

    const latest = new Map<string, StoredFixtureStructuredSnapshot>();
    for (const raw of (data ?? []) as SnapshotRow[]) {
      if (!latest.has(raw.fixture_id)) {
        latest.set(raw.fixture_id, fromRow(raw));
      }
    }
    return latest;
  }
}
