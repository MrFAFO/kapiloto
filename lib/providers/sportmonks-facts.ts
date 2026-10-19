import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  SportmonksMetricRow,
  SportmonksPressureRow,
} from "./sportmonks";

export type SportmonksFactTeam = {
  canonicalTeamId: string;
  providerTeamId: string;
};

export type SportmonksFactContext = {
  fixtureId: string;
  providerFixtureId: string;
  capturedAt: string;
  home: SportmonksFactTeam;
  away: SportmonksFactTeam;
};

export type FixtureFactInsert = {
  fixture_id: string;
  fact_key: string;
  subject_type: "fixture" | "team";
  subject_team_id: string | null;
  subject_ref: string | null;
  value_numeric: number | null;
  value_text: string | null;
  value_boolean: boolean | null;
  value_json: Record<string, unknown> | unknown[] | null;
  unit: string | null;
  provenance_type: "provider_raw";
  provider: "sportmonks";
  provider_endpoint: string;
  provider_record_id: string;
  calculation_version: null;
  source_observed_at: string | null;
  captured_at: string;
  source_version: string;
  source_fingerprint: string;
  metadata: Record<string, unknown>;
};

export interface SportmonksAnalyticsSource {
  getStatisticsRows(fixtureId: string): Promise<SportmonksMetricRow[]>;
  getXgRows(fixtureId: string): Promise<SportmonksMetricRow[]>;
  getPressureRows(fixtureId: string): Promise<SportmonksPressureRow[]>;
}

export interface SportmonksFactStore {
  saveFacts(facts: FixtureFactInsert[]): Promise<number>;
}

function normalizeMetricKey(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || fallback;
}

function subjectForParticipant(
  participantId: number | undefined,
  context: SportmonksFactContext,
): {
  subject_type: "fixture" | "team";
  subject_team_id: string | null;
  subject_ref: string | null;
} {
  if (participantId != null && String(participantId) === context.home.providerTeamId) {
    return {
      subject_type: "team",
      subject_team_id: context.home.canonicalTeamId,
      subject_ref: context.home.providerTeamId,
    };
  }

  if (participantId != null && String(participantId) === context.away.providerTeamId) {
    return {
      subject_type: "team",
      subject_team_id: context.away.canonicalTeamId,
      subject_ref: context.away.providerTeamId,
    };
  }

  return {
    subject_type: "fixture",
    subject_team_id: null,
    subject_ref: participantId == null ? null : String(participantId),
  };
}

function rawValue(
  value: number | string | null | undefined,
  fallback: Record<string, unknown>,
): Pick<
  FixtureFactInsert,
  "value_numeric" | "value_text" | "value_boolean" | "value_json"
> {
  if (typeof value === "number" && Number.isFinite(value)) {
    return {
      value_numeric: value,
      value_text: null,
      value_boolean: null,
      value_json: null,
    };
  }

  if (typeof value === "string") {
    return {
      value_numeric: null,
      value_text: value,
      value_boolean: null,
      value_json: null,
    };
  }

  return {
    value_numeric: null,
    value_text: null,
    value_boolean: null,
    value_json: fallback,
  };
}

function fingerprint(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function metricFact(
  kind: "stat" | "xg",
  row: SportmonksMetricRow,
  context: SportmonksFactContext,
): FixtureFactInsert {
  const developerName = normalizeMetricKey(
    row.type?.developer_name,
    `type_${row.type_id ?? "unknown"}`,
  );
  const subject = subjectForParticipant(row.participant_id, context);
  const endpoint =
    kind === "xg"
      ? `/fixtures/${context.providerFixtureId}?include=xGFixture.type`
      : `/fixtures/${context.providerFixtureId}?include=statistics.type`;

  const raw = {
    fixture_id: row.fixture_id ?? null,
    participant_id: row.participant_id ?? null,
    type_id: row.type_id ?? null,
    location: row.location ?? null,
    data: row.data ?? null,
    type: row.type ?? null,
  };

  return {
    fixture_id: context.fixtureId,
    fact_key: `${kind}.${developerName}`,
    ...subject,
    ...rawValue(row.data?.value, raw),
    unit: null,
    provenance_type: "provider_raw",
    provider: "sportmonks",
    provider_endpoint: endpoint,
    provider_record_id: [
      kind,
      context.providerFixtureId,
      row.participant_id ?? "fixture",
      row.type_id ?? developerName,
      row.location ?? "all",
    ].join(":"),
    calculation_version: null,
    source_observed_at: null,
    captured_at: context.capturedAt,
    source_version: "sportmonks-v3",
    source_fingerprint: fingerprint([
      "sportmonks",
      kind,
      context.providerFixtureId,
      row.participant_id ?? null,
      row.type_id ?? null,
      row.location ?? null,
      row.data?.value ?? null,
      row.type?.developer_name ?? null,
    ]),
    metadata: {
      provider_participant_id: row.participant_id ?? null,
      provider_type_id: row.type_id ?? null,
      location: row.location ?? null,
      type_name: row.type?.name ?? null,
      type_code: row.type?.code ?? null,
    },
  };
}

function pressureFact(
  row: SportmonksPressureRow,
  context: SportmonksFactContext,
): FixtureFactInsert {
  const subject = subjectForParticipant(row.participant_id, context);
  const pressure =
    typeof row.pressure === "number" && Number.isFinite(row.pressure)
      ? row.pressure
      : null;

  const value =
    pressure == null
      ? {
          value_numeric: null,
          value_text: null,
          value_boolean: null,
          value_json: {
            fixture_id: row.fixture_id ?? null,
            participant_id: row.participant_id ?? null,
            minute: row.minute ?? null,
            pressure: row.pressure ?? null,
          },
        }
      : {
          value_numeric: pressure,
          value_text: null,
          value_boolean: null,
          value_json: null,
        };

  return {
    fixture_id: context.fixtureId,
    fact_key: "pressure.index",
    ...subject,
    ...value,
    unit: "index",
    provenance_type: "provider_raw",
    provider: "sportmonks",
    provider_endpoint: `/fixtures/${context.providerFixtureId}?include=pressure`,
    provider_record_id: [
      "pressure",
      context.providerFixtureId,
      row.participant_id ?? "fixture",
      row.minute ?? "unknown",
    ].join(":"),
    calculation_version: null,
    source_observed_at: null,
    captured_at: context.capturedAt,
    source_version: "sportmonks-v3",
    source_fingerprint: fingerprint([
      "sportmonks",
      "pressure",
      context.providerFixtureId,
      row.participant_id ?? null,
      row.minute ?? null,
      row.pressure ?? null,
    ]),
    metadata: {
      provider_participant_id: row.participant_id ?? null,
      minute: row.minute ?? null,
    },
  };
}

export function buildSportmonksFixtureFacts(
  context: SportmonksFactContext,
  input: {
    statistics: SportmonksMetricRow[];
    xg: SportmonksMetricRow[];
    pressure: SportmonksPressureRow[];
  },
): FixtureFactInsert[] {
  return [
    ...input.statistics.map((row) => metricFact("stat", row, context)),
    ...input.xg.map((row) => metricFact("xg", row, context)),
    ...input.pressure.map((row) => pressureFact(row, context)),
  ];
}

export async function ingestSportmonksFixtureAnalytics(
  source: SportmonksAnalyticsSource,
  store: SportmonksFactStore,
  context: SportmonksFactContext,
): Promise<{
  statistics: number;
  xg: number;
  pressure: number;
  factsWritten: number;
}> {
  const [statistics, xg, pressure] = await Promise.all([
    source.getStatisticsRows(context.providerFixtureId),
    source.getXgRows(context.providerFixtureId),
    source.getPressureRows(context.providerFixtureId),
  ]);

  const facts = buildSportmonksFixtureFacts(context, {
    statistics,
    xg,
    pressure,
  });

  const factsWritten = await store.saveFacts(facts);

  return {
    statistics: statistics.length,
    xg: xg.length,
    pressure: pressure.length,
    factsWritten,
  };
}

export class SupabaseSportmonksFactStore implements SportmonksFactStore {
  constructor(private readonly client: SupabaseClient) {}

  async saveFacts(facts: FixtureFactInsert[]): Promise<number> {
    if (facts.length === 0) return 0;

    const { data, error } = await this.client
      .from("fixture_fact_snapshots")
      .upsert(facts, {
        onConflict: "fixture_id,provenance_type,source_fingerprint",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      throw new Error(`Failed to persist Sportmonks fixture facts: ${error.message}`);
    }

    return data?.length ?? 0;
  }
}
