import type {
  KapilotoFixtureEnvelope,
  KapilotoPublicFixtureAnalysis,
} from "./api-types";
import {
  pollFixtureResearch,
  type KapilotoActionResult,
  type KapilotoClient,
  type KapilotoFailure,
  type KapilotoFixtureRef,
  type KapilotoPollOptions,
} from "./client";

export type KapilotoPanelErrorReason =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "unavailable"
  | "network"
  | "research_failed"
  | "timeout";

export type KapilotoPanelNotice =
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  | { kind: "error"; reason: KapilotoPanelErrorReason }
  | { kind: "refresh_ineligible" }
  | null;

export type KapilotoPanelActivity =
  | "idle"
  | "loading"
  | "consulting"
  | "rechecking"
  | "polling";

export type KapilotoPanelState = {
  expanded: boolean;
  activity: KapilotoPanelActivity;
  envelope: KapilotoFixtureEnvelope | null;
  /** "self" when this action created the run, "shared" when joined/observed. */
  researchOrigin: "self" | "shared" | null;
  /** Analysis visible when the user asked for a recheck. */
  baselineAnalysis: KapilotoPublicFixtureAnalysis | null;
  recheckOutcome: "changed" | "unchanged" | null;
  notice: KapilotoPanelNotice;
};

export type KapilotoPanelControllerOptions = {
  onRoundRunPublished?: (currentRunId: string) => void;
  pollOptions?: Pick<KapilotoPollOptions, "sleep" | "now" | "maxWaitMs">;
};

type LastAction =
  | { kind: "load" }
  | { kind: "consult" }
  | { kind: "recheck" }
  | null;

const INITIAL_STATE: KapilotoPanelState = {
  expanded: false,
  activity: "idle",
  envelope: null,
  researchOrigin: null,
  baselineAnalysis: null,
  recheckOutcome: null,
  notice: null,
};

/** The pick Kapiloto shows for this group: the double when recommended. */
export function kapilotoRecommendation(
  analysis: KapilotoPublicFixtureAnalysis,
): string | null {
  if (analysis.doubleRecommended && analysis.suggestedDouble) {
    return analysis.suggestedDouble;
  }
  return analysis.primaryPick;
}

function failureReason(failure: KapilotoFailure): KapilotoPanelErrorReason {
  switch (failure.kind) {
    case "unauthorized":
    case "forbidden":
    case "not_found":
    case "invalid_request":
      return failure.kind;
    case "network_error":
      return "network";
    default:
      return "unavailable";
  }
}

/**
 * Per-fixture inline panel state machine. Framework-agnostic so the React
 * hook stays thin and the flows are testable without a DOM.
 */
export class KapilotoPanelController {
  private state: KapilotoPanelState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private inflight: AbortController | null = null;
  private outdated = false;
  private etag: string | null = null;
  private lastAction: LastAction = null;
  /** Key of a POST that failed in transport; a manual retry replays it. */
  private pendingKey: { action: "consult" | "recheck"; key: string } | null =
    null;

  constructor(
    private readonly client: KapilotoClient,
    private readonly ref: KapilotoFixtureRef,
    private readonly options: KapilotoPanelControllerOptions = {},
  ) {}

  getState = (): KapilotoPanelState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<KapilotoPanelState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private begin(): AbortSignal {
    this.inflight?.abort();
    this.inflight = new AbortController();
    return this.inflight.signal;
  }

  open() {
    this.set({ expanded: true });
    if (this.state.activity !== "idle") return;
    if (this.state.envelope == null || this.outdated) void this.load();
  }

  collapse() {
    this.set({ expanded: false });
  }

  toggle() {
    if (this.state.expanded) this.collapse();
    else this.open();
  }

  /** Read-only refresh of this fixture. Never starts research. */
  async load() {
    this.lastAction = { kind: "load" };
    this.outdated = false;
    const signal = this.begin();
    this.set({ activity: "loading", notice: null });

    const result = await this.client.getFixtureAnalysis(this.ref, {
      signal,
      etag: this.state.envelope ? this.etag : null,
    });
    if (signal.aborted || result.kind === "aborted") return;

    if (result.kind === "not_modified") {
      this.set({ activity: "idle" });
      return;
    }
    if (result.kind !== "ok") {
      this.set({
        activity: "idle",
        notice:
          result.kind === "rate_limited"
            ? { kind: "rate_limited", retryAfterSeconds: result.retryAfterSeconds }
            : { kind: "error", reason: failureReason(result) },
      });
      return;
    }

    this.etag = result.etag;
    this.applyEnvelope(result.data, {
      origin: "shared",
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }

  async consult() {
    if (this.state.activity !== "idle") return;
    this.lastAction = { kind: "consult" };
    const signal = this.begin();
    this.set({
      expanded: true,
      activity: "consulting",
      notice: null,
      recheckOutcome: null,
      baselineAnalysis: null,
    });

    const result = await this.client.consultFixture(this.ref, {
      signal,
      idempotencyKey: this.takePendingKey("consult"),
    });
    this.handleAction("consult", result, signal);
  }

  async recheck() {
    const analysis = this.state.envelope?.analysis;
    if (this.state.activity !== "idle" || !analysis) return;
    this.lastAction = { kind: "recheck" };
    const signal = this.begin();
    this.set({
      expanded: true,
      activity: "rechecking",
      notice: null,
      recheckOutcome: null,
      baselineAnalysis: analysis,
    });

    const result = await this.client.recheckFixture(
      {
        ...this.ref,
        basedOnRunId: this.state.envelope?.analysis_run?.id ?? analysis.runId,
      },
      { signal, idempotencyKey: this.takePendingKey("recheck") },
    );
    this.handleAction("recheck", result, signal);
  }

  retry() {
    if (this.state.activity !== "idle") return;
    const action = this.lastAction?.kind ?? "load";
    if (action === "consult") void this.consult();
    else if (action === "recheck" && this.state.envelope?.analysis) {
      void this.recheck();
    } else void this.load();
  }

  /** Another panel observed a newly published round run. */
  syncRoundRun(currentRunId: string) {
    const envelope = this.state.envelope;
    if (!envelope || envelope.research.current_run_id === currentRunId) return;
    if (this.state.activity !== "idle") return;
    if (this.state.expanded) void this.load();
    else this.outdated = true;
  }

  dispose() {
    this.inflight?.abort();
    this.inflight = null;
    if (this.state.activity !== "idle") this.set({ activity: "idle" });
  }

  private takePendingKey(action: "consult" | "recheck"): string | undefined {
    const pending = this.pendingKey;
    this.pendingKey = null;
    return pending?.action === action ? pending.key : undefined;
  }

  private handleAction(
    action: "consult" | "recheck",
    result: KapilotoActionResult,
    signal: AbortSignal,
  ) {
    if (signal.aborted || result.kind === "aborted") return;

    if (result.kind === "ok") {
      const outcome = result.data.request?.outcome;
      if (outcome === "refresh_ineligible") {
        this.applyEnvelope(result.data, { origin: "shared" });
        this.set({ notice: { kind: "refresh_ineligible" }, baselineAnalysis: null });
        return;
      }
      this.applyEnvelope(result.data, {
        origin: outcome === "created_run" ? "self" : "shared",
        retryAfterSeconds: result.retryAfterSeconds,
      });
      return;
    }

    if (result.kind === "network_error") {
      this.pendingKey = { action, key: result.idempotencyKey };
    }

    this.set({
      activity: "idle",
      baselineAnalysis: null,
      notice:
        result.kind === "rate_limited"
          ? { kind: "rate_limited", retryAfterSeconds: result.retryAfterSeconds }
          : { kind: "error", reason: failureReason(result) },
    });
  }

  /** Keeps the previously visible analysis while a new run is researching. */
  private mergeEnvelope(
    incoming: KapilotoFixtureEnvelope,
  ): KapilotoFixtureEnvelope {
    const previous = this.state.envelope;
    if (incoming.analysis || !previous?.analysis) return incoming;
    if (incoming.state !== "researching" && incoming.state !== "error") {
      return incoming;
    }
    return {
      ...incoming,
      analysis: previous.analysis,
      analysis_run: previous.analysis_run,
      freshness: previous.freshness,
    };
  }

  private applyEnvelope(
    incoming: KapilotoFixtureEnvelope,
    meta: { origin: "self" | "shared"; retryAfterSeconds?: number | null },
  ) {
    const envelope = this.mergeEnvelope(incoming);
    const baseline = this.state.baselineAnalysis;
    let recheckOutcome = this.state.recheckOutcome;

    if (envelope.state === "researching") {
      this.set({
        envelope,
        researchOrigin:
          this.state.activity === "polling" ? this.state.researchOrigin : meta.origin,
      });
      void this.poll(
        envelope.research.current_run_id,
        meta.retryAfterSeconds ?? envelope.poll?.retry_after_seconds ?? null,
      );
      return;
    }

    if (baseline && envelope.analysis && envelope.analysis.runId !== baseline.runId) {
      recheckOutcome =
        kapilotoRecommendation(envelope.analysis) !==
          kapilotoRecommendation(baseline) ||
        envelope.analysis.primaryPick !== baseline.primaryPick
          ? "changed"
          : "unchanged";
    }

    this.set({
      envelope,
      activity: "idle",
      researchOrigin: null,
      recheckOutcome,
      baselineAnalysis: recheckOutcome ? baseline : null,
    });
  }

  private async poll(
    baselineCurrentRunId: string | null,
    initialRetryAfterSeconds: number | null,
  ) {
    const signal = this.begin();
    this.set({ activity: "polling" });

    const outcome = await pollFixtureResearch(this.client, this.ref, {
      ...this.options.pollOptions,
      signal,
      baselineCurrentRunId,
      initialRetryAfterSeconds,
    });
    if (signal.aborted || outcome.kind === "aborted") return;

    if (outcome.kind === "published") {
      this.etag = null;
      this.set({ activity: "idle" });
      this.applyEnvelope(outcome.envelope, { origin: "shared" });
      const runId = outcome.envelope.research.current_run_id;
      if (runId) this.options.onRoundRunPublished?.(runId);
      return;
    }

    if (outcome.kind === "ended_without_publish") {
      this.set({
        envelope: this.mergeEnvelope({ ...outcome.envelope, state: "error" }),
        activity: "idle",
        researchOrigin: null,
        baselineAnalysis: null,
        notice: { kind: "error", reason: "research_failed" },
      });
      return;
    }

    this.set({
      activity: "idle",
      researchOrigin: null,
      notice:
        outcome.kind === "timeout"
          ? { kind: "error", reason: "timeout" }
          : outcome.failure.kind === "rate_limited"
            ? {
                kind: "rate_limited",
                retryAfterSeconds: outcome.failure.retryAfterSeconds,
              }
            : { kind: "error", reason: failureReason(outcome.failure) },
    });
  }
}
