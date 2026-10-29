import type { ProviderMatchObservationPayload } from "./sportmonks-ledger";

export type ProviderIngestResult = {
  status: "recorded" | "unchanged" | "quarantined";
  reason_code: string | null;
  fixture_id: string | null;
  fixture_resolution: "existing_mapping" | "attached" | "minted" | null;
  observation_id: string | null;
  observation_version: number | null;
  provider_refs_status: "recorded" | "matched" | "drift" | "unrecorded" | null;
  players_minted: number;
};

export type ProviderIngestRpc = (payload: ProviderMatchObservationPayload) => Promise<ProviderIngestResult>;
export type ProviderFailureRpc = (input: {
  runId: string;
  provider: string;
  providerFixtureId: string;
  reasonCode: string;
  detail?: Record<string, unknown>;
}) => Promise<number>;

export function recordProviderMatchObservation(
  rpc: ProviderIngestRpc,
  observation: ProviderMatchObservationPayload,
): Promise<ProviderIngestResult> {
  return rpc(observation);
}

export function recordIngestFailure(
  rpc: ProviderFailureRpc,
  input: Parameters<ProviderFailureRpc>[0],
): Promise<number> {
  return rpc(input);
}
