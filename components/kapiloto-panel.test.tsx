import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type {
  KapilotoFixtureEnvelope,
  KapilotoPublicFixtureAnalysis,
} from "@/lib/kapiloto/api-types";
import type { KapilotoPanelState } from "@/lib/kapiloto/panel-controller";
import {
  deriveKapilotoPanelView,
  type KapilotoPanelViewKind,
} from "@/lib/kapiloto/panel-view";
import { toggleOutcomeInPicks, type Pick } from "@/lib/toto";

import { KapilotoPanel, KapilotoToggleBar } from "./kapiloto-panel";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const RUN_1 = "55555555-5555-4555-8555-555555555551";
const RUN_2 = "55555555-5555-4555-8555-555555555552";

function analysis(
  overrides: Partial<KapilotoPublicFixtureAnalysis> = {},
): KapilotoPublicFixtureAnalysis {
  return {
    analysisId: "a-1",
    runId: RUN_1,
    outcome: "analyzed",
    primaryPick: "X",
    suggestedDouble: "X2",
    doublePriorityRank: 3,
    doubleRecommended: true,
    reliabilityBand: "high",
    summary: "Balanced fixture with a home edge.",
    mainRisk: "Late lineup news.",
    generatedAt: "2026-10-18T11:48:00.000Z",
    validUntil: "2026-10-18T18:00:00.000Z",
    ...overrides,
  };
}

function envelope(
  overrides: Partial<KapilotoFixtureEnvelope> = {},
): KapilotoFixtureEnvelope {
  const a = overrides.analysis === undefined ? analysis() : overrides.analysis;
  return {
    state: "ready",
    analysis: a,
    analysis_run: a ? { id: a.runId } : null,
    freshness: a ? { state: "fresh", stale_reasons: [] } : null,
    research: {
      active_run_id: null,
      current_run_id: a?.runId ?? null,
      runs_used: 1,
      runs_max: 3,
      runs_remaining: 2,
      closed: false,
      version: 1,
    },
    group: { max_doubles: 7, locked: false },
    poll: null,
    ...overrides,
  };
}

function state(overrides: Partial<KapilotoPanelState> = {}): KapilotoPanelState {
  return {
    expanded: true,
    activity: "idle",
    envelope: envelope(),
    researchOrigin: null,
    baselineAnalysis: null,
    recheckOutcome: null,
    notice: null,
    ...overrides,
  };
}

function render(panelState: KapilotoPanelState) {
  const view = deriveKapilotoPanelView(panelState);
  const noop = () => {};
  const markup = renderToStaticMarkup(
    <>
      <KapilotoToggleBar view={view} panelId="p" onToggle={noop} />
      <KapilotoPanel
        view={view}
        panelId="p"
        now={NOW}
        onConsult={noop}
        onRecheck={noop}
        onRetry={noop}
      />
    </>,
  );
  const panelOnly = renderToStaticMarkup(
    <KapilotoPanel
      view={view}
      panelId="p"
      now={NOW}
      onConsult={noop}
      onRecheck={noop}
      onRetry={noop}
    />,
  );
  return { view, markup, panelOnly };
}

const staleEnvelope = envelope({
  state: "stale",
  freshness: { state: "stale", stale_reasons: ["signal:lineup_change"] },
});

const visualStates: Record<
  Exclude<KapilotoPanelViewKind, "closed" | "loading">,
  KapilotoPanelState
> = {
  unresearched: state({
    envelope: envelope({ state: "unresearched", analysis: null }),
  }),
  first_loading: state({
    activity: "polling",
    researchOrigin: "self",
    envelope: envelope({ state: "researching", analysis: null }),
  }),
  shared_researching: state({
    activity: "polling",
    researchOrigin: "shared",
    envelope: envelope({ state: "researching", analysis: null }),
  }),
  fresh: state(),
  collapsed: state({ expanded: false }),
  stale: state({ envelope: staleEnvelope }),
  rechecking: state({
    activity: "polling",
    baselineAnalysis: analysis(),
    envelope: envelope({ state: "researching" }),
  }),
  changed: state({
    recheckOutcome: "changed",
    baselineAnalysis: analysis(),
    envelope: envelope({
      analysis: analysis({
        analysisId: "a-2",
        runId: RUN_2,
        primaryPick: "1",
        suggestedDouble: "1X",
        doubleRecommended: false,
      }),
    }),
  }),
  error: state({
    envelope: envelope({ state: "unresearched", analysis: null }),
    notice: { kind: "error", reason: "research_failed" },
  }),
  budget_exhausted: state({
    envelope: {
      ...staleEnvelope,
      research: { ...staleEnvelope.research, runs_used: 3, runs_remaining: 0 },
    },
  }),
  rate_limited: state({
    notice: { kind: "rate_limited", retryAfterSeconds: 20 },
  }),
};

test("every required inline visual state renders", () => {
  for (const [kind, panelState] of Object.entries(visualStates)) {
    const { view, markup } = render(panelState);
    assert.equal(view.kind, kind);
    assert.ok(
      markup.includes(`data-kapiloto-view="${kind}"`),
      `${kind} should render its view marker`,
    );
  }
});


test("analysis shows recommendation, double, group rank, reliability, risk, freshness and sources", () => {
  const { markup } = render(state());

  assert.match(markup, /data-recommendation="true">X2</);
  assert.match(markup, /data-double-recommended="true">כפולה מומלצת: כן</);
  assert.match(markup, /data-double-rank="true">עדיפות 3 מתוך 7</);
  assert.match(markup, /data-reliability="true">גבוהה</);
  assert.ok(markup.includes("Balanced fixture with a home edge."));
  assert.ok(markup.includes("Late lineup news."));
  assert.ok(markup.includes("עודכן לפני 12 דק׳"));
  assert.ok(markup.includes('data-freshness="fresh"'));
  assert.ok(markup.includes("data-kapiloto-sources"));
  assert.ok(markup.includes('data-action="recheck"'));
});

test("no Apply action exists and no win-probability percentage is shown", () => {
  const allowedActions = new Set(["collapse", "expand", "consult", "recheck", "retry"]);

  for (const panelState of Object.values(visualStates)) {
    const { markup } = render(panelState);
    assert.ok(!/apply|החל|אמץ|יישם/i.test(markup), "no Apply affordance");
    assert.ok(!markup.includes("%"), "no percentages");
    for (const match of markup.matchAll(/data-action="([^"]+)"/g)) {
      assert.ok(allowedActions.has(match[1]), `unexpected action ${match[1]}`);
    }
    const badge = markup.match(/<div[^>]*data-recommendation-badge[^>]*>/);
    if (badge) assert.ok(!badge[0].includes("data-action"), "recommendation is display-only");
  }
});

test("group context decides the displayed double", () => {
  const outOfBudget = render(
    state({
      envelope: envelope({
        group: { max_doubles: 2, locked: false },
        analysis: analysis({ doubleRecommended: false }),
      }),
    }),
  );
  assert.match(outOfBudget.markup, /data-recommendation="true">X</);
  assert.match(outOfBudget.markup, /data-double-recommended="true">כפולה מומלצת: לא</);
  assert.match(outOfBudget.markup, /data-double-rank="true">עדיפות 3 מתוך 2</);
});

test("double recommendation never mutates picks; only user taps change them", () => {
  const picks: Record<number, Pick> = { 1: "1", 2: "X2" };
  const frozen = structuredClone(picks);

  render(state());
  assert.deepEqual(picks, frozen);

  const doubled = toggleOutcomeInPicks(picks, 1, "X", 7);
  assert.equal(doubled[1], "1X");
  assert.deepEqual(picks, frozen, "toggle is pure");

  const blocked = toggleOutcomeInPicks(picks, 1, "X", 1);
  assert.equal(blocked, picks, "max doubles blocks a new double");

  const single = toggleOutcomeInPicks(picks, 2, "2", 7);
  assert.equal(single[2], "X");
});

test("Recheck keeps the previous analysis visible", () => {
  const { markup } = render(visualStates.rechecking);
  assert.ok(markup.includes('data-kapiloto-analysis="a-1"'));
  assert.ok(markup.includes("הניתוח הקודם מוצג"));
  assert.ok(!markup.includes('data-action="recheck"'));
});

test("stale keeps the previous analysis and offers Recheck", () => {
  const { markup } = render(visualStates.stale);
  assert.ok(markup.includes('data-kapiloto-analysis="a-1"'));
  assert.ok(markup.includes("התקבל עדכון מהותי"));
  assert.ok(markup.includes("עדיפות קודמת 3/7"));
  assert.ok(markup.includes('data-action="recheck"'));
});

test("recommendation change is announced and the user's pick is kept", () => {
  const { markup } = render(visualStates.changed);
  assert.ok(markup.includes("X2 → 1"));
  assert.ok(markup.includes("הבחירה שלך בטופס לא שונתה"));
});

test("budget exhaustion and rate limiting render distinctly", () => {
  const budget = render(visualStates.budget_exhausted).markup;
  const throttled = render(visualStates.rate_limited).markup;

  assert.ok(budget.includes("data-kapiloto-budget-exhausted"));
  assert.ok(!budget.includes("data-kapiloto-rate-limited"));
  assert.ok(!budget.includes('data-action="recheck"'));

  assert.ok(throttled.includes("data-kapiloto-rate-limited"));
  assert.ok(!throttled.includes("data-kapiloto-budget-exhausted"));
  assert.ok(throttled.includes("20 שניות"));
  assert.ok(throttled.includes('data-action="retry"'));
  assert.ok(!throttled.includes('data-action="recheck"'));
});

test("closed shows only the consult bar; collapsed keeps a compact cached summary", () => {
  const closed = render(state({ expanded: false, envelope: null }));
  assert.equal(closed.panelOnly, "");
  assert.ok(closed.markup.includes("מחקר משותף למחזור"));
  assert.ok(closed.markup.includes('aria-expanded="false"'));

  const collapsed = render(visualStates.collapsed);
  assert.equal(collapsed.panelOnly, "");
  assert.ok(collapsed.markup.includes('data-kapiloto-view="collapsed"'));
  assert.ok(collapsed.markup.includes(">X2<"));
  assert.ok(!collapsed.markup.includes("data-kapiloto-analysis"));
});