import assert from "node:assert/strict";
import test from "node:test";

import { buildDiscoveryPlan, CANDIDATE_DISCOVERY_BUDGET, CANDIDATE_DISCOVERY_PLAN_CONFIG, planSummary } from "./discovery-plan";
import { forbiddenModelFields } from "./model-output-guards";
import { assignTriage, CANDIDATE_TRIAGE_CONFIG, INFORMATION_NEED_KINDS, type TriageContext, type TriageFeatures } from "./triage";

type Fixture = {
  game: number;
  competitionKey: string;
  names: { home: string; away: string };
  disagreementBp: number;
  matches: { home: number; away: number };
  newToCompetition: { home: boolean; away: boolean };
  rest: { home: number; away: number };
  recent: { home: number; away: number };
};

/** The five live-dev fixtures' stored artifact-v2 facts (2026-10-25 01:35Z capture). */
const FIVE: Fixture[] = [
  { game: 1, competitionKey: "sportmonks:372", names: { home: "Maccabi Haifa", away: "Hapoel Beer Sheva" }, disagreementBp: 615, matches: { home: 78, away: 78 }, newToCompetition: { home: false, away: false }, rest: { home: 9, away: 4 }, recent: { home: 2, away: 3 } },
  { game: 7, competitionKey: "sportmonks:8", names: { home: "Hull City", away: "Brentford" }, disagreementBp: 2092, matches: { home: 7, away: 83 }, newToCompetition: { home: true, away: false }, rest: { home: 8, away: 8 }, recent: { home: 1, away: 1 } },
  { game: 8, competitionKey: "sportmonks:8", names: { home: "Crystal Palace", away: "Newcastle United" }, disagreementBp: 650, matches: { home: 83, away: 83 }, newToCompetition: { home: false, away: false }, rest: { home: 2, away: 7 }, recent: { home: 3, away: 2 } },
  { game: 9, competitionKey: "sportmonks:8", names: { home: "Sunderland", away: "Leeds United" }, disagreementBp: 316, matches: { home: 45, away: 45 }, newToCompetition: { home: false, away: false }, rest: { home: 2, away: 7 }, recent: { home: 3, away: 1 } },
  { game: 12, competitionKey: "sportmonks:564", names: { home: "Celta Vigo", away: "Real Betis" }, disagreementBp: 907, matches: { home: 85, away: 85 }, newToCompetition: { home: false, away: false }, rest: { home: 2, away: 3 }, recent: { home: 3, away: 4 } },
];

function planFor(fixture: Fixture) {
  const context: TriageContext = {
    managerChange: { home: { status: "unknown" }, away: { status: "unknown" } },
    restDays: fixture.rest,
    matchesLast14Days: fixture.recent,
    competition: { isCup: false, isSecondLeg: false },
    unresolvedAvailability: null,
  };
  const features: TriageFeatures = {
    fixtureId: `fixture-${fixture.game}`,
    marketQuality: "standard",
    statArm: "p_stat_elo_v1",
    statAvailable: true,
    disagreementBp: fixture.disagreementBp,
    statTeamMatches: fixture.matches,
    managerChangeDaysAgo: null,
    minRestDays: Math.min(fixture.rest.home, fixture.rest.away),
    maxMatchesLast14Days: Math.max(fixture.recent.home, fixture.recent.away),
    neutralVenue: false,
    isCup: false,
    isSecondLeg: false,
    newToCompetition: fixture.newToCompetition,
    unresolvedAvailability: null,
    dataGaps: ["availability_unassessed", "manager_change_unknown:away", "manager_change_unknown:home"],
  };
  const triage = assignTriage(features, CANDIDATE_TRIAGE_CONFIG);
  return {
    triage,
    plan: buildDiscoveryPlan({
      fixtureRef: `fx-${fixture.game}`,
      triage,
      triageConfig: CANDIDATE_TRIAGE_CONFIG,
      context,
      competitionKey: fixture.competitionKey,
      competitionName: "League",
      names: fixture.names,
    }),
  };
}

const scopes = (plan: ReturnType<typeof planFor>["plan"]) => Object.fromEntries(plan.needs.map((need) => [need.needId, need.scope.join(",")]));

test("current five fixtures: needs, tiers and effective scopes", () => {
  const [g1, g7, g8, g9, g12] = FIVE.map(planFor);
  assert.deepEqual(scopes(g1.plan), { "availability_rotation_check:away": "away", "availability_rotation_check:home": "home" });
  assert.deepEqual(scopes(g7.plan), {
    "availability_rotation_check:away": "away",
    "availability_rotation_check:home": "home",
    "stat_cold_start_context:home": "home",
  });
  assert.deepEqual(scopes(g8.plan), { "availability_rotation_check:away": "away", "availability_rotation_check:home": "home", "congestion_rotation:both": "home" });
  assert.deepEqual(scopes(g9.plan), { "availability_rotation_check:away": "away", "availability_rotation_check:home": "home", "congestion_rotation:both": "home" });
  assert.deepEqual(scopes(g12.plan), {
    "availability_rotation_check:away": "away",
    "availability_rotation_check:home": "home",
    "congestion_rotation:both": "home,away",
    "market_stat_gap:both": "home,away",
  });
  assert.deepEqual([g1, g7, g8, g9, g12].map((entry) => entry.plan.tier), ["minimal", "minimal", "minimal", "minimal", "standard"]);
  assert.deepEqual(g12.plan.budget, CANDIDATE_DISCOVERY_BUDGET.tiers.standard);
});

test("Hull gets cold-start context, not a market/stat gap; manager-change unknown creates no need anywhere", () => {
  const plans = FIVE.map(planFor);
  const hull = plans[1].plan;
  assert.ok(hull.needs.some((need) => need.kind === "stat_cold_start_context"));
  assert.ok(!hull.needs.some((need) => need.kind === "market_stat_gap"));
  for (const { plan } of plans) assert.ok(!plan.needs.some((need) => need.kind === "manager_change_context"));
});

test("the planner never changes the triage decision and records why a scope was narrowed", () => {
  const { triage, plan } = planFor(FIVE[2]);
  assert.deepEqual(plan.needs.map((need) => need.needId), triage.needs.map((need) => need.needId));
  const congestion = plan.needs.find((need) => need.kind === "congestion_rotation")!;
  assert.match(congestion.scopeReason, /home rest 2d, 3 matches\/14d; away rest 7d, 2 matches\/14d/);
  assert.deepEqual(plan.config.triage, triage.config);
});

test("search hints are neutral, side-scoped and carry no forecast language; languages include the source language", () => {
  const celta = planFor(FIVE[4]).plan;
  assert.deepEqual(celta.languages, ["es", "en"]);
  const congestion = celta.needs.find((need) => need.kind === "congestion_rotation")!;
  assert.deepEqual(congestion.searchHints, ["Celta Vigo rotation fitness after recent fixtures", "Real Betis rotation fitness after recent fixtures"]);
  const palace = planFor(FIVE[2]).plan.needs.find((need) => need.kind === "congestion_rotation")!;
  assert.deepEqual(palace.searchHints, ["Crystal Palace rotation fitness after recent fixtures"]);
  for (const hint of FIVE.flatMap((fixture) => planFor(fixture).plan.needs.flatMap((need) => need.searchHints))) {
    assert.doesNotMatch(hint, /odds|predict|favou?rite|win|h2h|head to head|tactic|derby|weather|motivation/i, hint);
  }
});

test("every need kind has allowed claim kinds and hints, and the plan summary feeds the parser", () => {
  for (const kind of INFORMATION_NEED_KINDS) {
    assert.ok(CANDIDATE_DISCOVERY_PLAN_CONFIG.allowedClaimKinds[kind].length > 0, kind);
    assert.ok(CANDIDATE_DISCOVERY_PLAN_CONFIG.searchHints[kind].length > 0, kind);
  }
  assert.deepEqual(CANDIDATE_DISCOVERY_PLAN_CONFIG.allowedClaimKinds.manager_change_context, ["manager_change"]);
  const plan = planFor(FIVE[1]).plan;
  const summary = planSummary(plan);
  assert.equal(summary.maxClaims, CANDIDATE_DISCOVERY_BUDGET.tiers.minimal.maxClaims);
  assert.deepEqual(forbiddenModelFields({ type: "object", properties: Object.fromEntries(Object.keys(plan).map((key) => [key, {}])) }), []);
});

test("budget tiers separate the hard tool-call cap from the audited search target", () => {
  for (const tier of Object.values(CANDIDATE_DISCOVERY_BUDGET.tiers)) {
    assert.ok(tier.maxWebToolCalls > tier.targetSearchActions);
    assert.ok(tier.maxJudgeItems >= tier.maxClaims);
  }
  assert.equal(CANDIDATE_DISCOVERY_BUDGET.status, "candidate");
});
