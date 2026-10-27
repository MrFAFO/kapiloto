import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { KapilotoFixtureCard } from "./fixture-card";
import {
  KAPILOTO_RESEARCH_DIMENSIONS,
  validateSolFixtureResearchOutput,
  type SolFixtureResearchOutput,
} from "./research-output";
import {
  materializeKapilotoResearchRun,
  type MaterializableFixture,
  type MaterializedAnalysis,
} from "./run-materialization";
import type { GroundingResult } from "./source-grounding";
import {
  evidenceRow,
  groundAndJudge,
  V3_EVIDENCE,
  v3Card,
  v3Documents,
  v3Output,
} from "./test-support/research-v3-fixtures";
import { v2GoldenFixtures } from "./test-support/v2-golden-input";

type Spec = (typeof V3_EVIDENCE)[number];

function unavailable(game: number): MaterializableFixture {
  return {
    mode: "research_unavailable",
    gameNumber: game,
    roundGameId: `game-${game}`,
    fixtureId: `fixture-${game}`,
    reason: "missing_prior",
    context: {
      kickoffAt: "2026-10-30T18:00:00.000Z",
      settlementRule: "result_after_90_minutes_including_stoppage_time",
      neutralVenue: false,
    },
    researchCutoffAt: "2026-10-29T12:00:00.000Z",
  };
}

function round(first: MaterializableFixture): MaterializedAnalysis[] {
  const rest = Array.from({ length: 15 }, (_, index) => unavailable(index + 2));
  return materializeKapilotoResearchRun([first, ...rest]).analyses;
}

async function materializeV3(
  output: SolFixtureResearchOutput,
  options: { card?: KapilotoFixtureCard; unsupported?: RegExp[]; extra?: Spec[] } = {},
): Promise<MaterializedAnalysis> {
  const card = options.card ?? v3Card({}, { fixtureId: "fixture-1", roundGameId: "game-1" });
  output.fixture_key = card.fixture_key;
  for (const spec of options.extra ?? []) output.evidence.push(evidenceRow(spec));
  const grounding: GroundingResult = await groundAndJudge(
    output,
    card,
    options.unsupported ?? [],
    v3Documents([...V3_EVIDENCE, ...(options.extra ?? [])]),
  );
  return round({
    mode: "research",
    gameNumber: 1,
    roundGameId: "game-1",
    fixtureId: "fixture-1",
    card,
    output,
    grounding,
  })[0];
}

test("V1/V2 equality: v2 research materializes exactly as on main", () => {
  const golden = JSON.parse(
    readFileSync(
      join(process.cwd(), "lib/kapiloto/test-support/golden/v2-materialization.json"),
      "utf8",
    ),
  );
  const actual = JSON.parse(
    JSON.stringify(materializeKapilotoResearchRun(v2GoldenFixtures())),
  );
  for (const analysis of actual.analyses) {
    for (const key of ["expected_lineups", "tactical_facts", "matchup_analysis", "regime_changes"]) {
      assert.equal(analysis[key], null, key);
      delete analysis[key];
    }
  }
  assert.deepEqual(actual, golden);
});

test("only sanitized v3 data is materialized", async () => {
  const analysis = await materializeV3(v3Output(), {
    unsupported: [/^Avi Striker is expected to start/],
  });
  assert.equal(analysis.outcome, "analyzed");
  assert.equal(analysis.expected_lineups!.home.status, "partial");
  assert.equal(analysis.expected_lineups!.home.starters.length, 10);
  assert.deepEqual(analysis.availability[0].functions, ["defensive_anchor"]);
  assert.deepEqual(analysis.tactical_facts!.map((fact) => fact.fact_id), ["t1", "t2"]);
  assert.deepEqual(analysis.matchup_analysis!.map((item) => item.matchup_id), ["m1"]);
  assert.deepEqual(
    analysis.factors.find((factor) => factor.dimension === "tactical_matchup")?.matchup_ids,
    ["m1"],
  );
  assert.equal(analysis.summary, "Kapiloto published only the research items that passed evidence verification; some reported items were removed.");
  const policy = analysis.inputs.find((input) => input.input_type === "grounding_policy");
  assert.equal(policy?.input_version, "kapiloto-grounding-policy-v9");
});

test("market_only publication contains no surviving directional matchup", async () => {
  const output = v3Output();
  output.availability[0].status = "doubtful"; // medium absence factor exceeds its cap
  const analysis = await materializeV3(output);
  assert.equal(analysis.p_sol_1_bp, null);
  assert.equal(analysis.blend_weight, 0);
  assert.deepEqual(analysis.matchup_analysis, []);
  assert.equal(analysis.factors.every((factor) => factor.favors === "none"), true);
  // Descriptive, grounded lineup/fact research may still be shown.
  assert.equal(analysis.expected_lineups!.home.status, "supported");
});

test("insufficient_data publication carries no directional v3 signal", async () => {
  const output = v3Output();
  output.availability[0].status = "doubtful";
  const card = v3Card({}, { fixtureId: "fixture-1", roundGameId: "game-1" });
  card.structured.prior = { ...card.structured.prior, type: "league_base" };
  const analysis = await materializeV3(output, { card });
  assert.equal(analysis.outcome, "insufficient_data");
  assert.deepEqual(analysis.matchup_analysis, []);
  assert.equal(analysis.factors.every((factor) => factor.favors === "none"), true);
});

test("carry-forward drops time-sensitive v3 research instead of re-dating it", async () => {
  const source = await materializeV3(v3Output());
  assert.ok(source.expected_lineups);
  const carried = round({
    mode: "carried_forward",
    gameNumber: 1,
    roundGameId: "game-1",
    fixtureId: "fixture-1",
    carriedFromAnalysisId: "analysis-old",
    reason: "kickoff_too_close",
    context: {
      kickoffAt: "2026-10-30T18:00:00.000Z",
      settlementRule: "result_after_90_minutes_including_stoppage_time",
      neutralVenue: false,
    },
    researchCutoffAt: "2026-10-30T16:00:00.000Z",
    source: { analysisId: "analysis-old", analysis: source },
  })[0];
  assert.equal(carried.outcome, "carried_forward");
  assert.equal(carried.expected_lineups, null);
  assert.equal(carried.tactical_facts, null);
  assert.equal(carried.matchup_analysis, null);
  assert.equal(carried.regime_changes, null);
});

test("descriptive lineup/fact evidence alone does not move reliability or p_final", async () => {
  const base = await materializeV3(v3Output());

  const enriched = v3Output();
  const extra: Spec[] = [
    {
      id: "tac3",
      url: "https://club-home.example/tactics",
      quote: "Home FC defend with a high line.",
      claimType: "tactical_setup",
      aboutTeam: "home",
      publishedAt: "2026-10-27T08:00:00.000Z",
    },
    {
      id: "ghost",
      url: "https://club-home.example/ghost",
      quote: "This quote is not on the page.",
      claimType: "tactical_setup",
      aboutTeam: "home",
      publishedAt: "2026-10-27T08:00:00.000Z",
    },
  ];
  enriched.tactical_facts!.push(
    { fact_id: "t3", team: "home", phase: "defending", attribute: "line", value: "high", evidence_ids: ["tac3"] },
    { fact_id: "t4", team: "home", phase: "defending", attribute: "block", value: "high", evidence_ids: ["ghost"] },
  );
  const card = v3Card({}, { fixtureId: "fixture-1", roundGameId: "game-1" });
  enriched.fixture_key = card.fixture_key;
  for (const spec of extra) enriched.evidence.push(evidenceRow(spec));
  const documents = v3Documents([...V3_EVIDENCE, extra[0]]).concat(
    v3Documents([{ ...extra[1], quote: "Different page text." }]),
  );
  const grounding = await groundAndJudge(enriched, card, [], documents);
  assert.deepEqual(grounding.rejected, [{ evidenceId: "ghost", reason: "quote_not_found" }]);
  const analysis = round({
    mode: "research",
    gameNumber: 1,
    roundGameId: "game-1",
    fixtureId: "fixture-1",
    card,
    output: enriched,
    grounding,
  })[0];

  assert.equal(analysis.reliability, base.reliability);
  assert.deepEqual(
    [analysis.p_final_1_bp, analysis.p_final_x_bp, analysis.p_final_2_bp],
    [base.p_final_1_bp, base.p_final_x_bp, base.p_final_2_bp],
  );
  assert.equal(analysis.reliability_reasons.includes("grounding_rejections"), false);
});

test("a provably pre-regime structured input adds a reliability reason", async () => {
  const output = v3Output();
  output.regime_changes = [
    { team: "home", type: "coach_change", effective_date: "2026-10-27", evidence_ids: ["rg1"] },
  ];
  const analysis = await materializeV3(output, {
    extra: [
      {
        id: "rg1",
        url: "https://club-home.example/new-coach",
        quote: "Home FC appointed a new head coach on 2026-10-27.",
        claimType: "coach_regime",
        aboutTeam: "home",
        publishedAt: "2026-10-27T12:00:00.000Z",
      },
    ],
  });
  assert.ok(analysis.reliability_reasons.includes("structured_inputs_pre_regime"));
  assert.equal(analysis.regime_changes!.length, 1);
});

test("maximum legal v3 output stays under a fixed serialized-size budget", () => {
  const text = (length: number, seed: string) => (seed + "x".repeat(length)).slice(0, length);
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const name = (index: number) =>
    `Player ${letters[Math.floor(index / 26) % 26]}${letters[index % 26]} `.padEnd(60, "q");
  const card = v3Card();
  const evidence = Array.from({ length: 24 }, (_, index) => ({
    evidence_id: `e${index}`,
    url: `https://news.example/article-${index % 20}`,
    quote: text(300, `q${index}`),
    claim: text(160, `c${index}`),
    claim_type: "lineup",
    about_team: "both" as const,
    event_time: "2026-10-28T10:00:00.000Z",
  }));
  const ids = (count: number, offset = 0) =>
    Array.from({ length: count }, (_, index) => `e${(index + offset) % 24}`);
  const starters = (offset: number) =>
    Array.from({ length: 11 }, (_, index) => ({
      player_name: name(offset + index),
      position: "MF" as const,
      confidence: "medium" as const,
      evidence_ids: ids(2, index),
    }));
  const output: SolFixtureResearchOutput = {
    ...v3Output(),
    evidence,
    availability: Array.from({ length: 20 }, (_, index) => ({
      team: index % 2 === 0 ? ("home" as const) : ("away" as const),
      player_name: name(100 + index),
      status: "out" as const,
      role: "key_starter" as const,
      certainty: "confirmed" as const,
      evidence_ids: ids(5, index),
      functions: ["creator", "finisher"],
      function_evidence_ids: ids(2, index),
    })),
    expected_lineups: {
      home: { status: "supported", formation: "4-2-3-1", formation_evidence_ids: ids(2), starters: starters(0) },
      away: { status: "supported", formation: "3-4-2-1", formation_evidence_ids: ids(2), starters: starters(20) },
    },
    tactical_facts: (["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"] as const).map((fact_id, index) => ({
      fact_id,
      team: index < 4 ? ("home" as const) : ("away" as const),
      phase: "defending" as const,
      attribute: "press_height",
      value: "high",
      evidence_ids: ids(2, index),
    })),
    matchup_analysis: (["m1", "m2", "m3"] as const).map((matchup_id, index) => ({
      matchup_id,
      kind: "midfield_control" as const,
      fact_ids: ["t1", "t2", "t5", "t6"],
      favors: "none" as const,
      magnitude: "small" as const,
      description: text(120, `d${index}`),
      evidence_ids: ids(4, index),
    })),
    regime_changes: [
      { team: "home", type: "coach_change", effective_date: "2026-10-01", evidence_ids: ids(2) },
      { team: "away", type: "formation_change", effective_date: "2026-10-10", evidence_ids: ids(2, 3) },
    ],
    factors: Array.from({ length: 12 }, (_, index) => ({
      dimension: KAPILOTO_RESEARCH_DIMENSIONS[index % 10],
      favors: "none" as const,
      magnitude: "small" as const,
      evidence_ids: ids(8, index),
      structured_refs: [],
      matchup_ids: [],
      rationale: text(220, `r${index}`),
    })),
    conflicts: Array.from({ length: 10 }, (_, index) => ({
      topic: text(150, `t${index}`),
      evidence_ids_a: ids(6, index),
      evidence_ids_b: ids(6, index + 6),
      resolution: "unresolved" as const,
    })),
    key_assumptions: [text(150, "a"), text(150, "b"), text(150, "c")],
    main_risk: text(300, "m"),
    summary: text(450, "s"),
    watch_items: Array.from({ length: 8 }, (_, index) => ({
      signal_type: "lineup" as const,
      team: "both" as const,
      player_name: name(200 + index),
      condition: text(150, `w${index}`),
      impact_if_triggered: "uncertain" as const,
    })),
    data_quality: { sparse_coverage: true, language_limited: true, notes: text(220, "n") },
    suspicious_content_observed: Array.from({ length: 10 }, (_, index) => ({
      url: `https://news.example/article-${index}`,
      description: text(220, `x${index}`),
    })),
  };

  assert.doesNotThrow(() =>
    validateSolFixtureResearchOutput(output, card, [], "kapiloto-research-v3"),
  );
  const size = JSON.stringify(output).length;
  // ~48k characters is roughly 12-20k output tokens depending on language,
  // leaving room for reasoning inside the unchanged 32k max_output_tokens.
  assert.ok(size <= 48_000, `max legal v3 output is ${size} characters`);
});
