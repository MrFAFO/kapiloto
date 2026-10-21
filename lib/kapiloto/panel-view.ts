import type {
  KapilotoFixtureEnvelope,
  KapilotoPublicFixtureAnalysis,
} from "./api-types";
import type {
  KapilotoPanelNotice,
  KapilotoPanelState,
} from "./panel-controller";

export type KapilotoPanelViewKind =
  | "closed"
  | "collapsed"
  | "loading"
  | "unresearched"
  | "first_loading"
  | "shared_researching"
  | "fresh"
  | "stale"
  | "rechecking"
  | "changed"
  | "error"
  | "budget_exhausted"
  | "rate_limited";

export type KapilotoPanelView = {
  kind: KapilotoPanelViewKind;
  analysis: KapilotoPublicFixtureAnalysis | null;
  previousAnalysis: KapilotoPublicFixtureAnalysis | null;
  freshness: KapilotoFixtureEnvelope["freshness"];
  research: KapilotoFixtureEnvelope["research"] | null;
  maxDoubles: number | null;
  notice: KapilotoPanelNotice;
  recheckOutcome: KapilotoPanelState["recheckOutcome"];
  busy: boolean;
  canConsult: boolean;
  canRecheck: boolean;
};

function analysisKind(
  state: KapilotoPanelState,
  envelope: KapilotoFixtureEnvelope,
): KapilotoPanelViewKind {
  const analysis = envelope.analysis;
  const budgetSpent =
    envelope.research.runs_remaining <= 0 || envelope.state === "limit_reached";

  if (envelope.state === "limit_reached") return "budget_exhausted";
  if (analysis && budgetSpent && envelope.freshness?.state === "stale") {
    return "budget_exhausted";
  }
  if (state.recheckOutcome === "changed") return "changed";
  if (envelope.state === "stale") return "stale";
  if (envelope.state === "ready") return "fresh";
  if (envelope.state === "unresearched") return "unresearched";
  return "error";
}

function deriveKind(state: KapilotoPanelState): KapilotoPanelViewKind {
  const envelope = state.envelope;
  const analysis = envelope?.analysis ?? null;

  if (!state.expanded) return analysis ? "collapsed" : "closed";
  if (state.notice?.kind === "rate_limited") return "rate_limited";
  if (state.notice?.kind === "error") return "error";

  if (state.activity === "loading" && !envelope) return "loading";

  const researching =
    state.activity === "consulting" ||
    state.activity === "rechecking" ||
    state.activity === "polling" ||
    envelope?.state === "researching";

  if (researching) {
    if (analysis && state.activity !== "consulting") return "rechecking";
    if (state.activity === "consulting" || state.researchOrigin === "self") {
      return "first_loading";
    }
    return "shared_researching";
  }

  if (!envelope) return "loading";
  return analysisKind(state, envelope);
}

export function deriveKapilotoPanelView(
  state: KapilotoPanelState,
): KapilotoPanelView {
  const envelope = state.envelope;
  const analysis = envelope?.analysis ?? null;
  const kind = deriveKind(state);
  const idle = state.activity === "idle";
  const research = envelope?.research ?? null;
  const freshnessState = envelope?.freshness?.state;

  const canRecheck =
    idle &&
    analysis != null &&
    research != null &&
    research.runs_remaining > 0 &&
    research.closed !== true &&
    envelope?.group.locked !== true &&
    freshnessState !== "locked" &&
    freshnessState !== "void";

  const canConsult =
    idle &&
    analysis == null &&
    (research == null ||
      (research.runs_remaining > 0 && research.closed !== true));

  return {
    kind,
    analysis,
    previousAnalysis:
      state.recheckOutcome === "changed" ? state.baselineAnalysis : null,
    freshness: envelope?.freshness ?? null,
    research,
    maxDoubles: envelope?.group.max_doubles ?? null,
    notice: state.notice,
    recheckOutcome: state.recheckOutcome,
    busy: !idle,
    canConsult,
    canRecheck,
  };
}
