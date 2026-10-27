import assert from "node:assert/strict";
import test from "node:test";

import { applyAdjustments, CANDIDATE_EFFECT_SIZES, type AdjustmentDecision } from "./adjustments";
import {
  CLAIM_KINDS_V2,
  EXPLANATORY_CLAIM_KINDS,
  FORECAST_CHANGING_CLAIM_KINDS,
  OBSERVATIONS,
  PLAYER_ROLES_V2,
  SQUAD_STATUSES_V2,
  STATED_STATUSES,
} from "./discovery-contract";
import { applyImpactRules, CANDIDATE_IMPACT_RULES, IMPACT_RULE_IDS, type VerifiedClaimFacts } from "./impact-rules";

const base: VerifiedClaimFacts = {
  claimId: "C1",
  subjectKey: "home:player:john smith",
  claimKind: "absence",
  side: "home",
  statedStatus: "confirmed",
  appliesToThisFixture: true,
  observation: "direct_statement",
  verified: true,
  structuredDuplicate: false,
  conflict: false,
  role: "goalkeeper",
  verifiedSquadStatus: "first_choice",
  rotation: null,
  evidenceIds: ["E2", "E1"],
};

const ADJUSTING = new Set([
  "availability_first_choice_goalkeeper",
  "availability_first_choice_outfield",
  "return_first_choice_goalkeeper",
  "return_first_choice_outfield",
  "rotation_direct_statement",
]);

test("exhaustive coverage: every claim maps to exactly one closed rule, and every rule is reachable", () => {
  const hit = new Set<string>();
  const adjustingKinds = new Set<string>();
  let cases = 0;
  const bools = [true, false];
  for (const claimKind of CLAIM_KINDS_V2)
    for (const statedStatus of STATED_STATUSES)
      for (const observation of OBSERVATIONS)
        for (const role of PLAYER_ROLES_V2)
          for (const verifiedSquadStatus of SQUAD_STATUSES_V2)
            for (const verified of bools)
              for (const appliesToThisFixture of bools)
                for (const structuredDuplicate of bools)
                  for (const conflict of bools)
                    for (const rotation of [null, ...bools.flatMap((gradeADirectStatement) => [0, 1, 2, 3].map((supportedFirstChoicePlayers) => ({ gradeADirectStatement, supportedFirstChoicePlayers })))]) {
                      cases += 1;
                      const facts = { ...base, claimKind, statedStatus, observation, role, verifiedSquadStatus, verified, appliesToThisFixture, structuredDuplicate, conflict, rotation };
                      const result = applyImpactRules(facts);
                      assert.ok((IMPACT_RULE_IDS as readonly string[]).includes(result.ruleId));
                      hit.add(result.ruleId);
                      assert.equal(result.proposal != null, ADJUSTING.has(result.ruleId), result.ruleId);
                      if (!result.proposal) continue;
                      adjustingKinds.add(claimKind);
                      assert.ok((FORECAST_CHANGING_CLAIM_KINDS as readonly string[]).includes(claimKind), `explanatory ${claimKind} adjusted`);
                      assert.equal(verifiedSquadStatus === "first_choice" || claimKind === "rotation_statement", true, "unknown importance never adjusts");
                      assert.ok(verified && appliesToThisFixture && !structuredDuplicate && !conflict && observation !== "inferred" && statedStatus !== "denied");
                      assert.equal(result.proposal.effect, claimKind === "expected_return" ? "strengthens" : "weakens");
                      assert.ok(["minor", "moderate"].includes(result.proposal.impact_class), "major is unused in v1");
                    }
  assert.ok(cases > 100_000, String(cases));
  assert.deepEqual([...hit].sort(), [...IMPACT_RULE_IDS].sort(), "every rule is reachable");
  assert.deepEqual([...adjustingKinds].sort(), [...FORECAST_CHANGING_CLAIM_KINDS].sort(), "every forecast-changing kind has an adjusting rule");
});

test("explanatory kinds never adjust", () => {
  for (const claimKind of EXPLANATORY_CLAIM_KINDS) {
    assert.equal(applyImpactRules({ ...base, claimKind }).ruleId, "explanatory_kind", claimKind);
  }
});

test("availability classes, direction and uncertainty follow the table", () => {
  const gk = applyImpactRules(base).proposal!;
  assert.deepEqual([gk.kind, gk.team, gk.effect, gk.impact_class, gk.uncertainty], ["availability", "home", "weakens", "moderate", "low"]);
  assert.deepEqual(gk.evidence_ids, ["E1", "E2"]);
  assert.equal(gk.proposal_id, "availability_first_choice_goalkeeper:home:player:john smith");
  assert.equal(gk.rationale, "impact-rules-v1:availability_first_choice_goalkeeper");
  const outfieldExpected = applyImpactRules({ ...base, role: "forward", statedStatus: "expected" }).proposal!;
  assert.deepEqual([outfieldExpected.impact_class, outfieldExpected.uncertainty], ["minor", "medium"]);
  const doubtful = applyImpactRules({ ...base, claimKind: "doubtful", statedStatus: "confirmed" }).proposal!;
  assert.equal(doubtful.uncertainty, "high", "doubtful is always high uncertainty");
  assert.equal(applyImpactRules({ ...base, role: "unknown" }).proposal!.impact_class, "minor", "unknown role with first-choice status is outfield");
});

test("a generic return with unknown squad importance never adjusts", () => {
  assert.equal(applyImpactRules({ ...base, claimKind: "expected_return", verifiedSquadStatus: "unknown" }).ruleId, "return_not_first_choice");
  const keeperBack = applyImpactRules({ ...base, claimKind: "expected_return" }).proposal!;
  assert.deepEqual([keeperBack.effect, keeperBack.impact_class], ["strengthens", "moderate"]);
});

test("rotation needs a grade-A direct statement naming enough supported first-choice players", () => {
  const rotation = (gradeADirectStatement: boolean, supportedFirstChoicePlayers: number, observation: VerifiedClaimFacts["observation"] = "direct_statement") =>
    applyImpactRules({ ...base, claimKind: "rotation_statement", role: "unknown", verifiedSquadStatus: "unknown", observation, rotation: { gradeADirectStatement, supportedFirstChoicePlayers } });
  assert.equal(rotation(true, CANDIDATE_IMPACT_RULES.rotationMinSupportedFirstChoicePlayers).ruleId, "rotation_direct_statement");
  assert.equal(rotation(true, CANDIDATE_IMPACT_RULES.rotationMinSupportedFirstChoicePlayers - 1).ruleId, "rotation_insufficient");
  assert.equal(rotation(false, 3).ruleId, "rotation_insufficient");
  assert.equal(rotation(true, 3, "reported").ruleId, "rotation_insufficient");
});

test("preconditions are checked before any kind rule", () => {
  assert.equal(applyImpactRules({ ...base, verified: false }).ruleId, "precondition_not_verified");
  assert.equal(applyImpactRules({ ...base, evidenceIds: [] }).ruleId, "precondition_not_verified");
  assert.equal(applyImpactRules({ ...base, appliesToThisFixture: false }).ruleId, "precondition_not_this_fixture");
  assert.equal(applyImpactRules({ ...base, observation: "inferred" }).ruleId, "precondition_inferred");
  assert.equal(applyImpactRules({ ...base, structuredDuplicate: true }).ruleId, "precondition_structured_duplicate");
  assert.equal(applyImpactRules({ ...base, conflict: true }).ruleId, "precondition_conflict");
  assert.equal(applyImpactRules({ ...base, statedStatus: "denied" }).ruleId, "denied_status");
});

test("rule proposals feed the unchanged effect sizes", () => {
  const proposal = applyImpactRules(base).proposal!;
  const decision = { proposal, status: "admitted", path: "full" } as AdjustmentDecision;
  const applied = applyAdjustments({ home: 0.45, draw: 0.27, away: 0.28 }, [decision], ["full"], CANDIDATE_EFFECT_SIZES);
  assert.equal(applied.appliedShift, -CANDIDATE_EFFECT_SIZES.impact.moderate * CANDIDATE_EFFECT_SIZES.uncertaintyMultiplier.low);
});
