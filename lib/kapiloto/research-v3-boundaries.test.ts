import assert from "node:assert/strict";
import test from "node:test";

import { KAPILOTO_RELIABILITY_FORMULA_VERSION as DERIVATION_RELIABILITY } from "./derivation";
import { runKapilotoResearchSchemaPreflight } from "./openai-preflight";
import { loadPublicFixtureAnalysis } from "./public-analysis";
import { buildFixtureEtag } from "./read-api";
import {
  KAPILOTO_BLEND_POLICY_VERSION,
  KAPILOTO_RELIABILITY_FORMULA_VERSION,
  KAPILOTO_RESEARCH_PROTOCOL_VERSION,
} from "./research-config";
import {
  assertCurrentResearchProtocol,
  KapilotoFinalizationDataError,
  SupabaseKapilotoRunFinalizationStore,
} from "./run-finalizer";
import { createFakeSupabase } from "./test-support/fake-supabase";

test("live protocol is v3 and policy versions have a single source of truth", () => {
  assert.equal(KAPILOTO_RESEARCH_PROTOCOL_VERSION, "kapiloto-research-v3");
  assert.equal(KAPILOTO_RELIABILITY_FORMULA_VERSION, "kapiloto-reliability-shadow-v5");
  assert.equal(KAPILOTO_RELIABILITY_FORMULA_VERSION, DERIVATION_RELIABILITY);
  assert.equal(KAPILOTO_BLEND_POLICY_VERSION, "kapiloto-blend-shadow-v2");
});

test("finalization refuses a run or attempt frozen under another protocol", async () => {
  assert.throws(
    () => assertCurrentResearchProtocol("kapiloto-research-v2"),
    KapilotoFinalizationDataError,
  );
  assert.throws(
    () => assertCurrentResearchProtocol("kapiloto-research-v3", ["kapiloto-research-v2"]),
    /does not match run protocol/,
  );
  assert.doesNotThrow(() =>
    assertCurrentResearchProtocol("kapiloto-research-v3", ["kapiloto-research-v3"]),
  );

  const { client } = createFakeSupabase({
    kapiloto_research_runs: [
      {
        id: "run-v2",
        round_id: "round",
        status: "running",
        fixture_set: [],
        research_cutoff_at: "2026-10-29T12:00:00.000Z",
        research_protocol_version: "kapiloto-research-v2",
      },
    ],
    kapiloto_research_attempts: [],
  });
  const store = new SupabaseKapilotoRunFinalizationStore(client as never);
  await assert.rejects(store.load("run-v2"), /cannot be finalized by kapiloto-research-v3/);
});

const baseRow = {
  id: "analysis-1",
  research_run_id: "run-1",
  round_game_id: "game-1",
  outcome: "analyzed",
  primary_pick: "1",
  suggested_double: "1X",
  double_priority_rank: 2,
  reliability_band: "medium",
  summary: "Summary.",
  main_risk: "Risk.",
  generated_at: "2026-10-29T12:30:00.000Z",
  valid_until: null,
};

test("public read model is null-tolerant for v1/v2 rows and serializes v3 fields", async () => {
  const legacy = createFakeSupabase({ kapiloto_analyses: [baseRow] });
  const v2 = await loadPublicFixtureAnalysis(legacy.client, "run-1", "game-1", 3);
  assert.equal(v2?.availability, null);
  assert.equal(v2?.expectedLineups, null);
  assert.equal(v2?.tacticalFacts, null);
  assert.equal(v2?.matchupAnalysis, null);
  assert.equal(v2?.regimeChanges, null);
  assert.equal(v2?.primaryPick, "1");
  assert.equal(v2?.doubleRecommended, true);

  const lineups = {
    home: { status: "partial", formation: "4-3-3", formation_evidence_ids: ["e1"], starters: [] },
    away: { status: "insufficient_data", formation: null, formation_evidence_ids: [], starters: [] },
  };
  const current = createFakeSupabase({
    kapiloto_analyses: [
      {
        ...baseRow,
        availability: [{
          team: "away",
          player_name: "Anchor",
          status: "out",
          role: "key_starter",
          certainty: "confirmed",
          evidence_ids: ["e1"],
          functions: ["defensive_anchor"],
          function_evidence_ids: ["e2"],
        }],
        expected_lineups: lineups,
        tactical_facts: [],
        matchup_analysis: [],
        regime_changes: [],
      },
    ],
  });
  const v3 = await loadPublicFixtureAnalysis(current.client, "run-1", "game-1", 3);
  assert.deepEqual(v3?.availability?.[0]?.functions, ["defensive_anchor"]);
  assert.deepEqual(v3?.expectedLineups, lineups);
  assert.deepEqual(v3?.tacticalFacts, []);
  assert.deepEqual(JSON.parse(JSON.stringify(v3)).expectedLineups, lineups);
  assert.deepEqual(current.forbiddenCalls, []);
});

test("schema preflight exercises the live research v3 schema", async () => {
  let request: Record<string, unknown> | null = null;
  const client = {
    responses: {
      create: async (input: Record<string, unknown>) => {
        request = input;
        return {
          id: "resp-preflight",
          model: "gpt-test",
          status: "incomplete",
          usage: { input_tokens: 1, output_tokens: 0 },
        };
      },
    },
  };

  const result = await runKapilotoResearchSchemaPreflight(client as never, "gpt-test");
  assert.equal(result.schemaAccepted, true);

  const format = (
    (request?.text as { format?: Record<string, unknown> } | undefined)?.format
  ) ?? {};
  assert.equal(format.name, "kapiloto_fixture_research_v3");
  const schema = format.schema as {
    properties?: { protocol_version?: { enum?: string[] } };
  };
  assert.deepEqual(
    schema.properties?.protocol_version?.enum,
    ["kapiloto-research-v3"],
  );
});

test("ETag depends on publication identity/state, not on analysis payload size", () => {
  const input = {
    state: "ready",
    currentRunId: "run-1",
    analysisId: "analysis-1",
    freshness: "fresh",
    staleReasons: [],
    activeRunId: null,
    runsUsed: 1,
    closed: false,
    maxDoubles: 3,
    groupLocked: false,
  };
  assert.equal(buildFixtureEtag(input), buildFixtureEtag({ ...input }));
  assert.notEqual(buildFixtureEtag(input), buildFixtureEtag({ ...input, analysisId: "analysis-2" }));
});
