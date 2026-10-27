export type KapilotoResearchIntent = "consult" | "recheck" | "diego";

export type KapilotoCurrentFreshness = "fresh" | "stale" | "locked" | "void";

export type KapilotoResearchPolicyState = {
  runsConsumed: number;
  activeRunId: string | null;
  currentRunId: string | null;
  currentFreshness: KapilotoCurrentFreshness | null;
  refreshEligible: boolean;
  roundClosed: boolean;
  breakerOpen: boolean;
};

export type KapilotoResearchPolicyRequest = {
  intent: KapilotoResearchIntent;
  basedOnRunId: string | null;
};

export type KapilotoResearchPolicyDecision =
  | {
      action: "serve_current";
      outcome:
        | "served_cache"
        | "served_newer"
        | "refresh_ineligible"
        | "limit_reached"
        | "round_closed"
        | "breaker_open";
      runId: string | null;
    }
  | {
      action: "join_active";
      outcome: "joined_run";
      runId: string;
    }
  | {
      action: "create_run";
      outcome: "created_run";
      budgetSlot: 1 | 2 | 3;
      basedOnRunId: string | null;
    };

function assertState(state: KapilotoResearchPolicyState): void {
  if (
    !Number.isInteger(state.runsConsumed) ||
    state.runsConsumed < 0 ||
    state.runsConsumed > 3
  ) {
    throw new Error(`Invalid runsConsumed: ${state.runsConsumed}`);
  }
}

function nextBudgetSlot(runsConsumed: number): 1 | 2 | 3 {
  const slot = runsConsumed + 1;
  if (slot < 1 || slot > 3) {
    throw new Error("Kapiloto research budget is exhausted.");
  }
  return slot as 1 | 2 | 3;
}

export function decideKapilotoResearchRequest(
  state: KapilotoResearchPolicyState,
  request: KapilotoResearchPolicyRequest,
): KapilotoResearchPolicyDecision {
  assertState(state);

  if (
    request.basedOnRunId != null &&
    state.currentRunId != null &&
    request.basedOnRunId !== state.currentRunId
  ) {
    return {
      action: "serve_current",
      outcome: "served_newer",
      runId: state.currentRunId,
    };
  }

  if (state.roundClosed) {
    return {
      action: "serve_current",
      outcome: "round_closed",
      runId: state.currentRunId,
    };
  }

  if (state.activeRunId != null) {
    return {
      action: "join_active",
      outcome: "joined_run",
      runId: state.activeRunId,
    };
  }

  if (state.breakerOpen) {
    return {
      action: "serve_current",
      outcome: "breaker_open",
      runId: state.currentRunId,
    };
  }

  if (state.currentRunId != null) {
    if (request.intent === "consult" || request.intent === "diego") {
      return {
        action: "serve_current",
        outcome: "served_cache",
        runId: state.currentRunId,
      };
    }

    if (!state.refreshEligible) {
      return {
        action: "serve_current",
        outcome: "refresh_ineligible",
        runId: state.currentRunId,
      };
    }
  }

  if (state.runsConsumed >= 3) {
    return {
      action: "serve_current",
      outcome: "limit_reached",
      runId: state.currentRunId,
    };
  }

  if (request.intent === "recheck" && state.currentRunId == null) {
    // A recheck with no prior snapshot is equivalent to the first explicit demand.
    return {
      action: "create_run",
      outcome: "created_run",
      budgetSlot: nextBudgetSlot(state.runsConsumed),
      basedOnRunId: null,
    };
  }

  return {
    action: "create_run",
    outcome: "created_run",
    budgetSlot: nextBudgetSlot(state.runsConsumed),
    basedOnRunId: state.currentRunId,
  };
}
