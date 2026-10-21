import type { KapilotoPublicFixtureAnalysis } from "./public-analysis";
import type {
  KapilotoApiState,
  KapilotoFreshness,
  KapilotoReadState,
  KapilotoRequestOutcome,
} from "./response-state";

export type { KapilotoPublicFixtureAnalysis };

export const KAPILOTO_RUNS_MAX = 3;

export type KapilotoFixtureState = KapilotoApiState | KapilotoReadState;

export type KapilotoResearchSummary = {
  active_run_id: string | null;
  current_run_id: string | null;
  runs_used: number;
  runs_max: number;
  runs_remaining: number;
  closed?: boolean;
  version?: number;
};

export type KapilotoFixtureEnvelope = {
  state: KapilotoFixtureState;
  analysis: KapilotoPublicFixtureAnalysis | null;
  analysis_run: { id: string } | null;
  freshness: {
    state: Exclude<KapilotoFreshness, null>;
    stale_reasons: string[];
  } | null;
  research: KapilotoResearchSummary;
  group: {
    max_doubles: number;
    locked: boolean;
  };
  poll: { retry_after_seconds: number } | null;
  request?: {
    outcome: KapilotoRequestOutcome;
    replayed: boolean;
    request_id: string | null;
  };
};

export type KapilotoRoundStateEnvelope = {
  round_id: string;
  research: Required<KapilotoResearchSummary>;
  poll: { retry_after_seconds: number } | null;
};

export type KapilotoErrorEnvelope = {
  error: {
    code: string;
    message: string;
  };
};
