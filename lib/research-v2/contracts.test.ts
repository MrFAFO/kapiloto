import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { KAPILOTO_PSTAT_VERSION } from "@/lib/evaluation/elo";
import { KAPILOTO_LEAGUE_BASELINE_VERSION } from "@/lib/evaluation/league-baseline";
import { KAPILOTO_MARKET_PRIOR_VERSION } from "@/lib/evaluation/market-prior";

import { assertNoResultLeakage, buildDeterministicBase } from "./base";
import { CLAIM_KINDS_V2, DISCOVERY_V2_OUTPUT_SCHEMA } from "./discovery-contract";
import { assertNoForecastKeys, DISCOVERY_OUTPUT_SCHEMA, EVIDENCE_CLAIM_KINDS, forbiddenForecastFields } from "./evidence";
import { forbiddenModelFields } from "./model-output-guards";
import { computeResearchV2Forecast } from "./forecast";
import { RESEARCH_V2_ENGINE_VERSION, sha256Canonical } from "./provenance";
import { INFORMATION_NEED_KINDS } from "./triage";
import { baseInputs, CONFIGS, HISTORY, item, KICKOFF_AT, proposal, verified } from "./test-support";

test("no Research v2 Sol contract contains a probability, odds, pick or double field", () => {
  assert.deepEqual(forbiddenForecastFields(DISCOVERY_OUTPUT_SCHEMA), []);
  assert.deepEqual(forbiddenModelFields(DISCOVERY_V2_OUTPUT_SCHEMA), [], "discovery-v2 passes the stricter model guard");
});

test("the forecast-field detector catches the fields a model could use to forecast", () => {
  for (const name of ["p_home", "home_bp", "probability", "odds", "pick", "suggested_double", "win_chance", "draw_likelihood"]) {
    const schema = { type: "object", properties: { nested: { type: "object", properties: { [name]: { type: "number" } } } } };
    assert.ok(forbiddenForecastFields(schema).length > 0, name);
  }
  assert.throws(() => assertNoForecastKeys([{ proposal_id: "A1", home_bp: 5000 }], "proposals"), /forecast_field/);
  assert.throws(
    () =>
      computeResearchV2Forecast(
        {
          base: baseInputs(),
          research: {
            verification: verified([item()]),
            proposals: [{ ...proposal(), p_home: 0.6 } as never],
          },
        },
        CONFIGS,
      ),
    /forecast_field/,
  );
});

test("generic topics are neither claim kinds nor information needs", () => {
  const generic = /h2h|head|tactic|derby|weather|set_?piece|motivation|form|table|rest/i;
  assert.deepEqual(EVIDENCE_CLAIM_KINDS.filter((kind) => generic.test(kind)), []);
  assert.deepEqual(CLAIM_KINDS_V2.filter((kind) => generic.test(kind)), []);
  assert.deepEqual(INFORMATION_NEED_KINDS.filter((kind) => generic.test(kind)), []);
});

test("result-like fields on the forecast fixture are rejected", () => {
  const poisoned = baseInputs();
  (poisoned.fixture as Record<string, unknown>).home_score = 2;
  assert.throws(() => assertNoResultLeakage(poisoned), /result_leakage/);
  const quoteWithResult = baseInputs();
  (quoteWithResult.marketQuotes[0] as unknown as Record<string, unknown>).final_result = "1";
  assert.throws(() => buildDeterministicBase(quoteWithResult, CONFIGS.base), /result_leakage/);
});

test("history not knowable at the cutoff, or not before the fixture, is rejected", () => {
  const late = baseInputs({
    history: [...HISTORY, { ...HISTORY[0], providerFixtureId: "late", kickoffAt: new Date(Date.parse(KICKOFF_AT) - 2 * 3_600_000).toISOString() }],
  });
  assert.throws(() => assertNoResultLeakage(late), /not known at the cutoff/);
});

test("version identifiers reflect the code and the exact config used", () => {
  const forecast = computeResearchV2Forecast({ base: baseInputs(), research: null }, CONFIGS);
  assert.equal(forecast.engineVersion, RESEARCH_V2_ENGINE_VERSION);
  assert.equal(forecast.base.arms.p_stat_elo_v1.version, KAPILOTO_PSTAT_VERSION);
  assert.equal(forecast.base.arms.p_league_base_v1.version, KAPILOTO_LEAGUE_BASELINE_VERSION);
  assert.equal(forecast.base.arms.p_market_v1.version, KAPILOTO_MARKET_PRIOR_VERSION);
  assert.equal(forecast.provenance.base.sha256, sha256Canonical(CONFIGS.base));
  assert.equal(forecast.provenance.effects.sha256, sha256Canonical(CONFIGS.effects));
  assert.deepEqual(forecast.provenance.combinations.map((c) => c.sha256), CONFIGS.combinations.map(sha256Canonical));
  assert.ok([forecast.provenance.base, forecast.provenance.effects, ...forecast.provenance.combinations].every((c) => c.status === "candidate"));

  const changed = { ...CONFIGS, effects: { ...CONFIGS.effects, totalCap: CONFIGS.effects.totalCap / 2 } };
  const other = computeResearchV2Forecast({ base: baseInputs(), research: null }, changed);
  assert.notEqual(other.provenance.effects.sha256, forecast.provenance.effects.sha256);
});

test("Research v2 modules never read result tables or outcome columns", () => {
  const dir = join(process.cwd(), "lib", "research-v2");
  // The live-dev provider adapter is the single module allowed to read the
  // database, and only through its read-only client wrapper.
  const READ_ONLY_ADAPTER = "live-dev-providers.ts";
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
    const source = readFileSync(join(dir, file), "utf8");
    assert.doesNotMatch(source, /home_score|away_score|field_outcome|pool_settlement|football_match_results/, file);
    if (file === READ_ONLY_ADAPTER) {
      assert.match(source, /const client = readOnlySupabaseClient\(options\.client\);/);
      assert.doesNotMatch(source, /options\.client\.from\(|\.rpc\(/, `${file} must only use the read-only client`);
      continue;
    }
    assert.doesNotMatch(source, /\.from\(\s*["'`]/, `${file} must not query the database`);
    assert.doesNotMatch(source, /@supabase\/supabase-js|\.rpc\(/, `${file} must not use a database client`);
  }
});
