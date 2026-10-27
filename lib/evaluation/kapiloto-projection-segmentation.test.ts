import assert from "node:assert/strict";
import test from "node:test";

import {
  kapilotoProjectionArmVersion,
  KAPILOTO_PUBLISHED_PROJECTION_VERSION,
  projectKapilotoPublication,
  type PublishedKapilotoAnalysis,
} from "./kapiloto-projection";

function publication(overrides: Partial<PublishedKapilotoAnalysis> = {}): PublishedKapilotoAnalysis {
  return {
    publicationId: "pub-1",
    publishedAt: "2026-10-29T13:00:00.000Z",
    analysisId: "analysis-1",
    researchRunId: "run-1",
    fixtureId: "fixture-1",
    roundGameId: "game-1",
    outcome: "analyzed",
    orientationVerified: true,
    researchCutoffAt: "2026-10-29T12:00:00.000Z",
    kickoffAtSnapshot: "2026-10-30T18:00:00.000Z",
    roundGameHomeTeamId: "home",
    roundGameAwayTeamId: "away",
    priorType: "market",
    pFinal: { home: 4500, draw: 2800, away: 2700 },
    pSol: { home: 4800, draw: 2700, away: 2500 },
    derivationVersion: "kapiloto-derivation-v4",
    blendPolicyVersion: "kapiloto-blend-shadow-v2",
    reliabilityFormulaVersion: "kapiloto-reliability-shadow-v5",
    calibrationVersion: null,
    ...overrides,
  };
}

test("evaluation never pools v2 and v3 research systems", () => {
  const legacy = projectKapilotoPublication(
    publication({ researchProtocolVersion: "kapiloto-research-v2", reliabilityFormulaVersion: "kapiloto-reliability-shadow-v4" }),
  );
  const v3 = projectKapilotoPublication(
    publication({
      researchProtocolVersion: "kapiloto-research-v3",
      groundingPolicyVersion: "kapiloto-grounding-policy-v9",
    }),
  );
  assert.equal(legacy[0].arm_version, KAPILOTO_PUBLISHED_PROJECTION_VERSION);
  assert.equal(
    v3[0].arm_version,
    `${KAPILOTO_PUBLISHED_PROJECTION_VERSION}|kapiloto-research-v3|kapiloto-grounding-policy-v9|kapiloto-reliability-shadow-v5`,
  );
  assert.notEqual(legacy[0].arm_version, v3[0].arm_version);
  assert.equal(v3[0].basis.research_protocol_version, "kapiloto-research-v3");
  assert.equal(v3[0].basis.grounding_policy_version, "kapiloto-grounding-policy-v9");
  assert.ok(v3[0].arm_version.length <= 160);
  assert.equal(kapilotoProjectionArmVersion({ reliabilityFormulaVersion: null }), KAPILOTO_PUBLISHED_PROJECTION_VERSION);
});
