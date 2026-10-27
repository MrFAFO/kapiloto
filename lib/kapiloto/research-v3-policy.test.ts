import assert from "node:assert/strict";
import test from "node:test";

import type { KapilotoFixtureCard } from "./fixture-card";
import {
  applyGroundingPolicy,
  V3_SANITIZED_MAIN_RISK,
  V3_SANITIZED_SUMMARY,
} from "./grounding-policy";
import type { SolFixtureResearchOutput } from "./research-output";
import {
  evidenceRow,
  groundAndJudge,
  V3_EVIDENCE,
  v3Card,
  v3Documents,
  v3Output,
} from "./test-support/research-v3-fixtures";

type Spec = (typeof V3_EVIDENCE)[number];

async function run(
  output: SolFixtureResearchOutput,
  options: {
    card?: KapilotoFixtureCard;
    unsupported?: RegExp[];
    extra?: Spec[];
  } = {},
) {
  const card = options.card ?? v3Card();
  const specs = [...V3_EVIDENCE, ...(options.extra ?? [])];
  for (const spec of options.extra ?? []) output.evidence.push(evidenceRow(spec));
  const grounding = await groundAndJudge(
    output,
    card,
    options.unsupported ?? [],
    v3Documents(specs),
  );
  return applyGroundingPolicy(output, grounding, card);
}

/** Card whose structured form clearly favors the home side. */
function formCard(overrides: Partial<KapilotoFixtureCard> = {}): KapilotoFixtureCard {
  const card = v3Card(overrides);
  const away = card.structured.structured_snapshot!.features.away;
  away.form = {
    ...away.form!,
    points: 3,
    gf: 3,
    ga: 13,
    venue_points: 1,
    venue_gf: 1,
    venue_ga: 9,
  };
  return card;
}

test("clean v3 output publishes in Sol mode with server-derived supported lineup", async () => {
  const decision = await run(v3Output());
  assert.equal(decision.mode, "sol");
  assert.equal(decision.policyVersion, "kapiloto-grounding-policy-v9");
  assert.equal(decision.output.expected_lineups!.home.status, "supported");
  assert.equal(decision.output.expected_lineups!.away.status, "insufficient_data");
  assert.deepEqual(decision.removedItems, []);
  assert.equal(decision.output.summary, "Model summary that mentions the predicted XI.");
});

test("model-claimed supported status is recomputed by the server", async () => {
  const output = v3Output();
  output.expected_lineups!.home.starters[0].position = "unknown";
  const decision = await run(output);
  assert.equal(decision.output.expected_lineups!.home.status, "partial");
  assert.equal(decision.output.expected_lineups!.home.starters.length, 11);
});

test("all starters and the formation pruned -> insufficient_data", async () => {
  const decision = await run(v3Output(), {
    unsupported: [/expected to start/, /expected to use the/],
  });
  const home = decision.output.expected_lineups!.home;
  assert.equal(home.status, "insufficient_data");
  assert.deepEqual(home.starters, []);
  assert.equal(home.formation, null);
  assert.deepEqual(home.formation_evidence_ids, []);
});

test("formation pruned -> null formation and partial lineup", async () => {
  const decision = await run(v3Output(), { unsupported: [/expected to use the/] });
  const home = decision.output.expected_lineups!.home;
  assert.equal(home.formation, null);
  assert.equal(home.starters.length, 11);
  assert.equal(home.status, "partial");
});

test("lineup data is dropped when the frozen card disables lineup research", async () => {
  const decision = await run(v3Output(), { card: v3Card({ lineup_research: "disabled" }) });
  assert.equal(decision.output.expected_lineups!.home.status, "insufficient_data");
  assert.deepEqual(decision.output.expected_lineups!.home.starters, []);
});

test("unsupported matchup inference removes the matchup and its small factor (advisory)", async () => {
  const decision = await run(v3Output(), { unsupported: [/interaction between/] });
  assert.deepEqual(decision.output.matchup_analysis, []);
  assert.ok(decision.removedItems.includes("factor:tactical_matchup:linked_matchup_removed"));
  assert.equal(decision.mode, "sol");
  assert.equal(decision.pSolValid, true);
  assert.deepEqual(
    decision.output.factors.map((factor) => factor.dimension),
    ["availability"],
  );
});

test("linked medium tactical factor failure invalidates p_sol (market_only / insufficient)", async () => {
  const output = () => {
    const value = v3Output();
    value.matchup_analysis![0].magnitude = "medium";
    value.factors[0].magnitude = "medium";
    return value;
  };
  const market = await run(output(), { unsupported: [/interaction between/] });
  assert.equal(market.mode, "market_only");
  assert.equal(market.pSolValid, false);
  assert.ok(market.reasons.includes("p_sol_invalidated:tactical_matchup"));

  const leagueBase = v3Card();
  leagueBase.structured.prior = { ...leagueBase.structured.prior, type: "league_base" };
  const fallback = await run(output(), { card: leagueBase, unsupported: [/interaction between/] });
  assert.equal(fallback.mode, "insufficient_data");
});

test("factor failure removes its linked matchup", async () => {
  // Evidence-level rejection of the factor evidence removes the factor; the
  // descriptive matchup must not survive as an orphaned directional signal.
  const decision = await run(v3Output(), { unsupported: [/^Home FC's high press should trouble/] });
  assert.equal(decision.output.factors.some((factor) => factor.dimension === "tactical_matchup"), false);
  assert.deepEqual(decision.output.matchup_analysis, []);
});

test("an unlinked material directional matchup invalidates p_sol", async () => {
  const output = v3Output();
  output.matchup_analysis![0].magnitude = "medium";
  output.factors[0].matchup_ids = [];
  const decision = await run(output);
  assert.deepEqual(decision.output.matchup_analysis, []);
  assert.ok(decision.reasons.includes("p_sol_invalidated:unlinked_directional_matchup"));
  assert.equal(decision.mode, "market_only");
});

test("tactical caps: large tactical factor and more than one directional tactical factor", async () => {
  const large = v3Output();
  large.matchup_analysis![0].magnitude = "large";
  large.factors[0].magnitude = "large";
  const largeDecision = await run(large);
  assert.ok(largeDecision.removedItems.includes("factor:tactical_matchup:tactical_magnitude_cap"));
  assert.equal(largeDecision.mode, "market_only");

  const twice = v3Output();
  twice.matchup_analysis = [{ ...twice.matchup_analysis![0], favors: "none" }];
  twice.factors[0].matchup_ids = [];
  twice.factors.push({ ...twice.factors[0], evidence_ids: ["tac1"] });
  const twiceDecision = await run(twice);
  assert.ok(twiceDecision.reasons.includes("p_sol_invalidated:multiple_tactical_factors"));
});

test("absence double-count guard: a tactical factor may not reuse absence evidence", async () => {
  const output = v3Output();
  const relabelled: Spec = {
    ...V3_EVIDENCE.find((spec) => spec.id === "av1")!,
    id: "av1-tactical",
    claimType: "tactical_setup",
    aboutTeam: "both",
  };
  output.factors[0].evidence_ids = ["mx1", "av1-tactical"];
  const decision = await run(output, { extra: [relabelled] });
  assert.ok(decision.removedItems.includes("factor:tactical_matchup:absence_double_count"));
});

test("one evidence identity (same URL + quote) backs at most one directional factor", async () => {
  const output = v3Output();
  const copy: Spec = {
    ...V3_EVIDENCE.find((spec) => spec.id === "av1")!,
    id: "av1-copy",
  };
  output.factors.push({
    dimension: "club_coach_news",
    favors: "home",
    magnitude: "small",
    evidence_ids: ["av1-copy"],
    structured_refs: [],
    matchup_ids: [],
    rationale: "Same news counted again.",
  });
  copy.claimType = "club_coach_news";
  const decision = await run(output, { extra: [copy] });
  assert.ok(decision.reasons.includes("p_sol_invalidated:duplicate_directional_evidence"));
  assert.equal(decision.mode, "market_only");
});

test("structured strength double-count guard across directional factors", async () => {
  const output = v3Output();
  output.factors.push(
    {
      dimension: "baseline_form",
      favors: "home",
      magnitude: "small",
      evidence_ids: [],
      structured_refs: ["home.form", "away.form"],
      matchup_ids: [],
      rationale: "Structured form.",
    },
    {
      dimension: "home_away_draw",
      favors: "home",
      magnitude: "small",
      evidence_ids: [],
      structured_refs: ["home.form", "away.form"],
      matchup_ids: [],
      rationale: "Venue form.",
    },
  );
  const decision = await run(output, { card: formCard() });
  assert.ok(decision.reasons.includes("p_sol_invalidated:duplicate_structured_strength"));
  assert.equal(decision.output.factors.some((factor) => factor.structured_refs?.length), false);
});

test("absence magnitude caps: doubtful player or no supported role -> small", async () => {
  const output = v3Output();
  output.availability[0].status = "doubtful";
  const decision = await run(output);
  assert.ok(decision.removedItems.includes("factor:availability:absence_magnitude_cap"));
  assert.equal(decision.mode, "market_only");

  const small = v3Output();
  small.availability[0].status = "doubtful";
  small.factors[1].magnitude = "small";
  const ok = await run(small);
  assert.equal(ok.output.factors.some((factor) => factor.dimension === "availability"), true);
});

test("regime change after the last match makes structured form stale (fail closed)", async () => {
  const output = v3Output();
  const regimeSpec: Spec = {
    id: "rg1",
    url: "https://club-home.example/new-coach",
    quote: "Home FC appointed a new head coach on 2026-10-27.",
    claimType: "coach_regime",
    aboutTeam: "home",
    publishedAt: "2026-10-27T12:00:00.000Z",
  };
  output.regime_changes = [
    { team: "home", type: "coach_change", effective_date: "2026-10-27", evidence_ids: ["rg1"] },
  ];
  output.factors.push({
    dimension: "baseline_form",
    favors: "home",
    magnitude: "small",
    evidence_ids: [],
    structured_refs: ["home.form", "away.form"],
    matchup_ids: [],
    rationale: "Structured form.",
  });
  const decision = await run(output, { card: formCard(), extra: [regimeSpec] });
  assert.equal(decision.output.regime_changes!.length, 1);
  assert.deepEqual(decision.preRegimeStructuredTeams, ["home"]);
  assert.ok(decision.removedItems.includes("factor:baseline_form:pre_regime_structured_ref"));
  // Small structured factor removal is advisory; other grounded factors remain.
  assert.equal(decision.mode, "sol");
});

test("regime staleness is not invented when the frozen data cannot establish it", async () => {
  const card = formCard();
  card.structured.structured_snapshot!.features.home.rest = { rest_days: 4, matches_last_14d: 6 };
  const output = v3Output();
  output.regime_changes = [
    { team: "home", type: "coach_change", effective_date: "2026-10-20", evidence_ids: ["rg1"] },
  ];
  const regimeSpec: Spec = {
    id: "rg1",
    url: "https://club-home.example/new-coach",
    quote: "Home FC changed head coach on 2026-10-20.",
    claimType: "coach_regime",
    aboutTeam: "home",
    publishedAt: "2026-10-20T12:00:00.000Z",
  };
  const decision = await run(output, { card, extra: [regimeSpec] });
  assert.equal(decision.output.regime_changes!.length, 1);
  assert.deepEqual(decision.preRegimeStructuredTeams, []);
});

test("narrative is sanitized server-side after pruning", async () => {
  const decision = await run(v3Output(), { unsupported: [/^Avi Striker is expected to start/] });
  assert.equal(decision.output.summary, V3_SANITIZED_SUMMARY);
  assert.equal(decision.output.main_risk, V3_SANITIZED_MAIN_RISK);
  assert.deepEqual(decision.output.key_assumptions, []);
  assert.deepEqual(decision.output.watch_items, []);
  assert.equal(decision.output.data_quality.notes, "unsupported_items_removed");
});
