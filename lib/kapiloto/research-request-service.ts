import { sha256Hex } from "./snapshot";

export type KapilotoRequestIntent = "consult" | "recheck" | "diego";

export type KapilotoResearchRequestInput = {
  userId: string;
  roundId: string;
  roundGameId: string | null;
  intent: KapilotoRequestIntent;
  idempotencyKey: string;
  basedOnRunId: string | null;
  breakerOpen: boolean;
};

export type KapilotoRunConfig = {
  modelKey: string;
  researchProtocolVersion: string;
  derivationVersion: string;
  sourcePolicyVersion: string;
  recencyPolicyVersion: string;
  reliabilityFormulaVersion: string;
  blendPolicyVersion: string;
  calibrationVersion: string | null;
  promptTemplateSha256: string;
  executionTopology: "fixture_fanout" | "round_batch";
  maxAttemptsPerTask: number;
};

export type PreparedKapilotoRun = {
  researchCutoffAt: string;
  fixtureSet: unknown[];
  fixtureSetSha256: string;
  inputSnapshot: Record<string, unknown>;
  taskGameIds: string[];
};

export type KapilotoRpcOutcome =
  | "prepare_required"
  | "served_cache"
  | "served_newer"
  | "joined_run"
  | "created_run"
  | "refresh_ineligible"
  | "limit_reached"
  | "round_closed"
  | "breaker_open";

export type KapilotoRpcResponse = {
  replayed: boolean;
  outcome: KapilotoRpcOutcome;
  request_id?: string | null;
  run_id?: string | null;
  round_id: string;
  active_run_id?: string | null;
  current_run_id?: string | null;
  runs_consumed: number;
  next_budget_slot?: number;
  budget_slot?: number;
  task_count?: number;
};

export type KapilotoRpcCall = {
  request: KapilotoResearchRequestInput;
  requestSha256: string;
  config: KapilotoRunConfig;
  prepared: PreparedKapilotoRun | null;
};

export interface KapilotoResearchRpc {
  call(input: KapilotoRpcCall): Promise<KapilotoRpcResponse>;
}

export interface KapilotoResearchPreparer {
  prepare(input: {
    roundId: string;
    currentRunId: string | null;
  }): Promise<PreparedKapilotoRun>;
}

export async function ensureKapilotoResearch(
  rpc: KapilotoResearchRpc,
  preparer: KapilotoResearchPreparer,
  request: KapilotoResearchRequestInput,
  config: KapilotoRunConfig,
): Promise<KapilotoRpcResponse> {
  const requestSha256 = sha256Hex({
    round_id: request.roundId,
    round_game_id: request.roundGameId,
    intent: request.intent,
    based_on_run_id: request.basedOnRunId,
  });

  const first = await rpc.call({
    request,
    requestSha256,
    config,
    prepared: null,
  });

  if (first.outcome !== "prepare_required") {
    return first;
  }

  const prepared = await preparer.prepare({
    roundId: request.roundId,
    currentRunId: first.current_run_id ?? null,
  });

  const second = await rpc.call({
    request,
    requestSha256,
    config,
    prepared,
  });

  if (second.outcome === "prepare_required") {
    throw new Error(
      "Kapiloto RPC requested preparation after a prepared snapshot was supplied.",
    );
  }

  return second;
}
