import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAIM_KINDS_V2,
  DISCOVERY_V2_CONTRACT_VERSION,
  DISCOVERY_V2_OUTPUT_SCHEMA,
  EXPLANATORY_CLAIM_KINDS,
  FORECAST_CHANGING_CLAIM_KINDS,
  parseDiscoveryOutputV2,
  strictSchemaViolations,
  type DiscoveryClaim,
  type DiscoveryPlanSummary,
} from "./discovery-contract";
import { findForbiddenModelKeys, forbiddenModelFields, forecastLanguageFindings, isForbiddenModelKey } from "./model-output-guards";

const plan: DiscoveryPlanSummary = {
  fixtureRef: "fx-7",
  maxClaims: 3,
  needs: [
    { needId: "availability_rotation_check:home", scope: ["home"], allowedClaimKinds: ["absence", "suspension", "doubtful", "expected_return", "lineup_confirmed"] },
    { needId: "congestion_rotation:both", scope: ["home"], allowedClaimKinds: ["rotation_statement", "absence"] },
  ],
};

function claim(overrides: Partial<DiscoveryClaim> = {}): DiscoveryClaim {
  return {
    claim_id: "C1",
    need_id: "availability_rotation_check:home",
    claim_kind: "absence",
    side: "home",
    subject: { type: "player", name_in_source: "J. Smith", name_normalized_en: "John Smith", role: "goalkeeper", squad_status_claimed: "first_choice", squad_status_quote: "first-choice keeper", named_players: [] },
    claim: "John Smith is ruled out of Saturday's match with a knee injury.",
    stated_status: "confirmed",
    applies_to_this_fixture: true,
    event_time: null,
    observation: "direct_statement",
    extraction_confidence: "high",
    corroboration_claimed: false,
    citations: [{ url: "https://club.example/news/smith", quote: "Smith will miss Saturday's game", publisher_claimed: "Club", author_claimed: null, published_at_claimed: null }],
    ...overrides,
  };
}

const output = (claims: DiscoveryClaim[], extra: Record<string, unknown> = {}) => ({
  contract_version: DISCOVERY_V2_CONTRACT_VERSION,
  fixture_ref: "fx-7",
  needs_addressed: [{ need_id: "availability_rotation_check:home", status: "found" }],
  claims,
  ...extra,
});

test("the discovery-v2 schema uses only the strict subset: closed objects, every property required", () => {
  assert.deepEqual(strictSchemaViolations(DISCOVERY_V2_OUTPUT_SCHEMA), []);
  assert.deepEqual(forbiddenModelFields(DISCOVERY_V2_OUTPUT_SCHEMA), []);
  assert.ok(strictSchemaViolations({ type: "object", properties: { a: { type: "string", maxLength: 3 } }, required: ["a"] }).length > 0);
});

test("the vocabulary splits into forecast-changing and explanatory kinds with no overlap", () => {
  assert.deepEqual([...FORECAST_CHANGING_CLAIM_KINDS], ["absence", "suspension", "doubtful", "expected_return", "rotation_statement"]);
  assert.equal(new Set(CLAIM_KINDS_V2).size, FORECAST_CHANGING_CLAIM_KINDS.length + EXPLANATORY_CLAIM_KINDS.length);
  for (const kind of ["lineup_confirmed", "schedule_disruption", "manager_change"] as const) assert.ok(EXPLANATORY_CLAIM_KINDS.includes(kind));
});

test("the model guard rejects winner, tip, bet, recommendation, adjustment, impact, magnitude and direction keys", () => {
  for (const key of ["winner", "bestTip", "bet_size", "recommendation", "adjustment", "impact_class", "magnitude", "expected_direction", "home_prob", "pick"]) {
    assert.ok(isForbiddenModelKey(key), key);
  }
  for (const key of ["claim", "betweenness_not_a_word", "alphabet", "stated_status", "corroboration_claimed", "named_players"]) {
    assert.equal(isForbiddenModelKey(key), false, key);
  }
  assert.deepEqual(findForbiddenModelKeys({ a: [{ b: { tipster_verdict: 1 } }] }), []);
  assert.deepEqual(findForbiddenModelKeys({ a: [{ b: { tips: 1 } }] }), ["$.a[0].b.tips"]);
});

test("forecast or betting language in a claim is detected; plain team news is not", () => {
  assert.deepEqual(forecastLanguageFindings("John Smith is ruled out with a knee injury."), []);
  assert.deepEqual(forecastLanguageFindings("Kick-off moved to 20.45 because of travel delays."), []);
  for (const text of ["Hull have a 60% chance", "The odds have shortened", "Brentford are favourites", "Hull will win", "Pick 1X here", "Likely to beat Leeds"]) {
    assert.ok(forecastLanguageFindings(text).length > 0, text);
  }
});

test("a valid output is accepted claim by claim", () => {
  const result = parseDiscoveryOutputV2(output([claim()]), plan);
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") assert.deepEqual(result.claims.map((c) => c.status), ["admitted"]);
});

test("shape errors and forbidden keys reject the whole call", () => {
  const extraKey = parseDiscoveryOutputV2(output([claim()], { confidence_note: "x" }), plan);
  assert.equal(extraKey.status, "rejected");
  assert.equal(extraKey.status === "rejected" && extraKey.reason, "schema_invalid");
  const forbidden = parseDiscoveryOutputV2(output([{ ...claim(), impact_class: "major" } as unknown as DiscoveryClaim]), plan);
  assert.equal(forbidden.status === "rejected" && forbidden.reason, "forecast_field_in_output");
  const wrongKind = parseDiscoveryOutputV2(output([{ ...claim(), claim_kind: "motivation" } as unknown as DiscoveryClaim]), plan);
  assert.equal(wrongKind.status === "rejected" && wrongKind.reason, "schema_invalid");
  const mismatch = parseDiscoveryOutputV2({ ...output([claim()]), fixture_ref: "fx-8" }, plan);
  assert.equal(mismatch.status === "rejected" && mismatch.reason, "fixture_ref_mismatch");
});

test("plan, limit and language violations reject only the affected claim", () => {
  const result = parseDiscoveryOutputV2(
    output([
      claim({ claim_id: "ok" }),
      claim({ claim_id: "bad-need", need_id: "market_stat_gap:both" }),
      claim({ claim_id: "bad-kind", claim_kind: "manager_change" }),
      claim({ claim_id: "bad-side", need_id: "congestion_rotation:both", claim_kind: "rotation_statement", side: "away" }),
      claim({ claim_id: "no-cite", citations: [] }),
      claim({ claim_id: "too-long", claim: "x".repeat(201) }),
      claim({ claim_id: "betting", claim: "Smith out, so Brentford are favourites" }),
      claim({ claim_id: "ok" }),
    ]),
    plan,
  );
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  const byId = (id: string, index = 0) => result.claims.filter((c) => c.claim.claim_id === id)[index];
  assert.equal(byId("ok").status, "admitted");
  assert.deepEqual(byId("bad-need").rejections, ["unknown_need"]);
  assert.deepEqual(byId("bad-kind").rejections, ["claim_kind_not_allowed_for_need"]);
  assert.deepEqual(byId("bad-side").rejections, ["side_out_of_scope"]);
  assert.deepEqual(byId("no-cite").rejections, ["citation_count"]);
  assert.deepEqual(byId("too-long").rejections, ["field_too_long"]);
  assert.deepEqual(byId("betting").rejections, ["forecast_language_in_claim"]);
  assert.deepEqual(byId("ok", 1).rejections, ["duplicate_claim_id"]);
});

test("claims beyond the budget are rejected in output order", () => {
  const result = parseDiscoveryOutputV2(output(["a", "b", "c", "d"].map((id) => claim({ claim_id: id }))), plan);
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") {
    assert.deepEqual(result.claims.map((c) => c.status), ["admitted", "admitted", "admitted", "rejected"]);
    assert.deepEqual(result.claims[3].rejections, ["over_claim_budget"]);
  }
});
