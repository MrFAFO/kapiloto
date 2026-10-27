export type KapilotoApiState =
  | "ready"
  | "researching"
  | "stale"
  | "limit_reached"
  | "error";

export type KapilotoFreshness =
  | "fresh"
  | "stale"
  | "locked"
  | "void"
  | null;

export type KapilotoRequestOutcome =
  | "served_cache"
  | "served_newer"
  | "joined_run"
  | "created_run"
  | "refresh_ineligible"
  | "limit_reached"
  | "round_closed"
  | "breaker_open";

export type KapilotoReadState =
  | "unresearched"
  | "researching"
  | "ready"
  | "stale"
  | "limit_reached";

/**
 * State for read-only GET responses. Unlike the POST state, there is no
 * request outcome: the state is derived purely from the published snapshot
 * and the round research state row.
 */
export function deriveKapilotoReadState(input: {
  hasAnalysis: boolean;
  freshness: KapilotoFreshness;
  activeRunId: string | null;
  runsRemaining: number;
}): KapilotoReadState {
  if (input.activeRunId) return "researching";

  if (input.hasAnalysis) {
    return input.freshness === "stale" ? "stale" : "ready";
  }

  return input.runsRemaining <= 0 ? "limit_reached" : "unresearched";
}

export function deriveKapilotoApiState(input: {
  outcome: KapilotoRequestOutcome;
  hasAnalysis: boolean;
  freshness: KapilotoFreshness;
}): { state: KapilotoApiState; httpStatus: number } {
  const { outcome, hasAnalysis, freshness } = input;

  if (outcome === "created_run" || outcome === "joined_run") {
    return { state: "researching", httpStatus: 202 };
  }

  if (outcome === "limit_reached") {
    if (hasAnalysis && freshness === "fresh") {
      return { state: "ready", httpStatus: 200 };
    }
    return { state: "limit_reached", httpStatus: 200 };
  }

  if (outcome === "breaker_open") {
    if (!hasAnalysis) {
      return { state: "error", httpStatus: 200 };
    }
    return {
      state: freshness === "stale" ? "stale" : "ready",
      httpStatus: 200,
    };
  }

  if (!hasAnalysis) {
    return { state: "error", httpStatus: 200 };
  }

  if (freshness === "stale") {
    return { state: "stale", httpStatus: 200 };
  }

  return { state: "ready", httpStatus: 200 };
}
