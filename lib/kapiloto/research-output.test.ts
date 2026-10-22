import assert from "node:assert/strict";
import test from "node:test";

import type { KapilotoFixtureCard } from "./fixture-card";
import {
  KAPILOTO_RESEARCH_DIMENSIONS,
  validateSolFixtureResearchOutput,
} from "./research-output";

const card: KapilotoFixtureCard = {
  fixture_card_version: "kapiloto-fixture-card-v2",
  fixture_key: "fixture-1",
  fixture_id: "fixture-1",
  round_game_id: "game-1",
  toto_number: 1,
  settlement: "result_after_90_minutes_including_stoppage_time",
  orientation: { "1": "home-1", "2": "away-1" },
  teams: {
    home: { id: "home-1", names: ["Home"] },
    away: { id: "away-1", names: ["Away"] },
  },
  competition: {
    id: "league-1",
    name: "League",
    stage: "Regular Season",
    leg: null,
    aggregate: null,
  },
  kickoff_at: "2026-10-20T18:00:00.000Z",
  neutral_venue: false,
  research_cutoff_at: "2026-10-18T12:00:00.000Z",
  structured: {
    table_snapshot_id: null,
    recent_matches: [],
    squad_snapshot_id: null,
    coach: null,
    prior: {
      type: "market",
      snapshot_id: "market-1",
      captured_at: "2026-10-18T11:59:00.000Z",
      p_home_bp: 4000,
      p_draw_bp: 3000,
      p_away_bp: 3000,
    },
  },
};


const structuredCard: KapilotoFixtureCard = {
  ...card,
  fixture_card_version: "kapiloto-fixture-card-v3",
  structured: {
    ...card.structured,
    structured_snapshot: {
      id: "snapshot-1",
      feature_version: "kapiloto-features-v1",
      sha256: "a".repeat(64),
      computed_at: "2026-10-18T11:50:00.000Z",
      cutoff_at: "2026-10-18T12:00:00.000Z",
      features: {
        feature_version: "kapiloto-features-v1",
        home: {
          form: {
            played: 6,
            points: 15,
            gf: 12,
            ga: 5,
            venue_played: 4,
            venue_points: 10,
            venue_gf: 8,
            venue_ga: 3,
            last_match_at: "2026-10-15T18:00:00.000Z",
          },
          rest: { rest_days: 5, matches_last_14d: 2 },
          table: {
            position: 2,
            points: 20,
            played: 8,
            goal_difference: 9,
            points_deducted: null,
          },
          coverage: {
            form: "partial",
            rest: "available",
            table: "available",
          },
        },
        away: {
          form: {
            played: 6,
            points: 7,
            gf: 6,
            ga: 10,
            venue_played: 4,
            venue_points: 4,
            venue_gf: 3,
            venue_ga: 8,
            last_match_at: "2026-10-16T18:00:00.000Z",
          },
          rest: { rest_days: 2, matches_last_14d: 4 },
          table: {
            position: 9,
            points: 9,
            played: 8,
            goal_difference: -5,
            points_deducted: null,
          },
          coverage: {
            form: "partial",
            rest: "available",
            table: "available",
          },
        },
        sources: [],
      },
    },
  },
};

function output() {
  return {
    protocol_version: "kapiloto-research-v1",
    fixture_key: "fixture-1",
    home_team_id: "home-1",
    away_team_id: "away-1",
    outcome: "analyzed",
    evidence: [
      {
        evidence_id: "e1",
        url: "https://example.com/team-news?utm_source=test",
        quote: "Player A is unavailable for the match.",
        claim: "Player A is unavailable.",
        claim_type: "availability",
        about_team: "home",
        event_time: "2026-10-18T10:00:00Z",
      },
    ],
    availability: [
      {
        team: "home",
        player_name: "Player A",
        status: "out",
        role: "regular",
        certainty: "confirmed",
        evidence_ids: ["e1"],
      },
    ],
    factors: [
      {
        dimension: "availability",
        favors: "away",
        magnitude: "medium",
        evidence_ids: ["e1"],
        rationale: "The home side is missing a regular player.",
      },
    ],
    dimension_coverage: KAPILOTO_RESEARCH_DIMENSIONS.map((dimension) => ({
      dimension,
      status:
        dimension === "availability"
          ? "material_signal"
          : "no_material_signal",
    })),
    conflicts: [],
    p_sol: { home_bp: 3700, draw_bp: 3000, away_bp: 3300 },
    market_deviation: null,
    key_assumptions: [],
    main_risk: "Late lineup news could change the balance.",
    summary: "The matchup is close, with a modest away-side adjustment.",
    watch_items: [],
    data_quality: {
      sparse_coverage: false,
      language_limited: false,
      notes: "Coverage is adequate.",
    },
    suspicious_content_observed: [],
    model_self_confidence: "medium",
  };
}

test("validates identity, p_sol, dimensions and observed source URLs", () => {
  const result = validateSolFixtureResearchOutput(
    output(),
    card,
    ["https://example.com/team-news"],
  );

  assert.equal(result.output.p_sol.home_bp, 3700);
  assert.deepEqual(result.normalizedSourceUrls, [
    "https://example.com/team-news",
  ]);
});

test("preserves evidence URLs not observed by web search for grounding rejection", () => {
  const result = validateSolFixtureResearchOutput(output(), card, [
    "https://different.example.com/news",
  ]);

  assert.equal(result.output.evidence.length, 1);
  assert.equal(result.output.evidence[0].evidence_id, "e1");
  assert.deepEqual(result.output.factors[0].evidence_ids, ["e1"]);
  assert.deepEqual(result.output.availability[0].evidence_ids, ["e1"]);
});

test("rejects wrong fixture orientation", () => {
  const raw = output();
  raw.home_team_id = "wrong-home";

  assert.throws(
    () =>
      validateSolFixtureResearchOutput(raw, card, [
        "https://example.com/team-news",
      ]),
    /home_team_id/,
  );
});

test("rejects p_sol that does not sum to 10000", () => {
  const raw = output();
  raw.p_sol.away_bp = 3299;

  assert.throws(
    () =>
      validateSolFixtureResearchOutput(raw, card, [
        "https://example.com/team-news",
      ]),
    /sum to exactly 10000/,
  );
});

test("rejects references to unknown evidence ids", () => {
  const raw = output();
  raw.factors[0].evidence_ids = ["missing"];

  assert.throws(
    () =>
      validateSolFixtureResearchOutput(
        raw,
        card,
        ["https://example.com/team-news"],
      ),
    /references unknown evidence id missing/,
  );
});

test("rejects key_assumptions longer than the shared limit", () => {
  const raw = output();
  raw.key_assumptions = ["x".repeat(151)] as never[];

  assert.throws(
    () =>
      validateSolFixtureResearchOutput(raw, card, [
        "https://example.com/team-news",
      ]),
    /key_assumptions exceeds 150 characters/,
  );
});

test("bounds conflict topics and watch-item conditions like the schema", () => {
  const conflictRaw = output();
  conflictRaw.conflicts = [
    {
      topic: "t".repeat(151),
      evidence_ids_a: ["e1"],
      evidence_ids_b: ["e1"],
      resolution: "unresolved",
    },
  ] as never[];
  assert.throws(
    () =>
      validateSolFixtureResearchOutput(conflictRaw, card, [
        "https://example.com/team-news",
      ]),
    /conflicts\.topic exceeds 150/,
  );

  const watchRaw = output();
  watchRaw.watch_items = [
    {
      signal_type: "lineup",
      team: "home",
      player_name: null,
      condition: "c".repeat(151),
      impact_if_triggered: "uncertain",
    },
  ] as never[];
  assert.throws(
    () =>
      validateSolFixtureResearchOutput(watchRaw, card, [
        "https://example.com/team-news",
      ]),
    /watch_items\.condition exceeds 150/,
  );
});


test("v2 accepts a structured-only small factor from a frozen v3 card", () => {
  const raw = output();
  raw.protocol_version = "kapiloto-research-v2";
  raw.evidence = [];
  raw.availability = [];
  raw.factors = [
    {
      dimension: "baseline_form",
      favors: "home",
      magnitude: "small",
      evidence_ids: [],
      structured_refs: ["home.form", "away.form"],
      rationale: "The frozen form snapshot favors the home side.",
    },
  ] as never[];

  const result = validateSolFixtureResearchOutput(raw, structuredCard, []);
  assert.deepEqual(result.output.factors[0].structured_refs, [
    "away.form",
    "home.form",
  ]);
});

test("structured refs fail closed when the frozen card does not contain them", () => {
  const raw = output();
  raw.protocol_version = "kapiloto-research-v2";
  raw.factors[0] = {
    ...raw.factors[0],
    structured_refs: ["home.form", "away.form"],
  } as never;

  assert.throws(
    () =>
      validateSolFixtureResearchOutput(raw, card, [
        "https://example.com/team-news",
      ]),
    /Structured references require a frozen Fixture Card v3 snapshot/,
  );
});
