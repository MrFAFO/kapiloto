import assert from "node:assert/strict";
import test from "node:test";

import {
  computePStat,
  decayTowardInitial,
  DEFAULT_ELO_CONFIG,
  eloExpectedHomeScore,
  goalDifferenceMultiplier,
  homeAdvantageFromBaseline,
  orderedLogitFromBaseline,
  probabilitiesFromRatingDifference,
  runEloRatings,
} from "./elo";
import { computeLeagueBaseline } from "./league-baseline";
import { assertValidProbabilities } from "./probabilities";
import { match, syntheticLeague } from "./test-fixtures";

const close = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

const base = { home: 0.45, draw: 0.26, away: 0.29 };

test("goal-difference multiplier follows the World Football Elo table", () => {
  assert.equal(goalDifferenceMultiplier(0), 1);
  assert.equal(goalDifferenceMultiplier(-1), 1);
  assert.equal(goalDifferenceMultiplier(2), 1.5);
  assert.equal(goalDifferenceMultiplier(-3), 1.75);
  assert.equal(goalDifferenceMultiplier(4), 1.875);
});

test("home advantage reproduces the league expected home score", () => {
  const advantage = homeAdvantageFromBaseline(base);
  close(advantage, 400 * Math.log10(0.58 / 0.42));
  close(eloExpectedHomeScore(1500, 1500, advantage), 0.58);
});

test("ordered-logit mapping returns the league baseline at equal ratings", () => {
  const probabilities = probabilitiesFromRatingDifference(0, base);
  close(probabilities.home, base.home, 1e-12);
  close(probabilities.draw, base.draw, 1e-12);
  close(probabilities.away, base.away, 1e-12);
});

test("slope matches the Elo expected-score slope at equal ratings", () => {
  const expectedScore = (diff: number) => {
    const p = probabilitiesFromRatingDifference(diff, base);
    return p.home + p.draw / 2;
  };
  const h = 1e-3;
  const numeric = (expectedScore(h) - expectedScore(-h)) / (2 * h);
  const elo = (Math.log(10) * 0.58 * 0.42) / 400;
  close(numeric, elo, 1e-9);
  assert.ok(orderedLogitFromBaseline(base).slope > 0);
});

test("probabilities are valid and monotone across rating differences", () => {
  let previousHome = -1;
  let previousAway = 2;
  for (let diff = -2000; diff <= 2000; diff += 50) {
    const p = probabilitiesFromRatingDifference(diff, base);
    assertValidProbabilities(p);
    assert.ok(p.draw > 0);
    assert.ok(p.home > previousHome);
    assert.ok(p.away < previousAway);
    previousHome = p.home;
    previousAway = p.away;
  }
});

test("Elo update matches hand-computed values", () => {
  const history = [
    match({ id: "1", kickoffAt: "2025-08-01T15:00:00Z", home: "a", away: "b", score: [2, 0] }),
  ];
  const zeroAdvantage = runEloRatings(history, 0);
  close(zeroAdvantage.get("sportmonks:a")?.rating ?? 0, 1515);
  close(zeroAdvantage.get("sportmonks:b")?.rating ?? 0, 1485);

  const oneNil = [{ ...history[0], homeGoals: 1, awayGoals: 0 }];
  const withAdvantage = runEloRatings(oneNil, 100);
  const expected = 1 / (1 + 10 ** -0.25);
  close(withAdvantage.get("sportmonks:a")?.rating ?? 0, 1500 + 20 * (1 - expected));
  close(withAdvantage.get("sportmonks:b")?.rating ?? 0, 1500 - 20 * (1 - expected));
});

test("time decay halves a rating's distance from 1500 per half-life of idleness", () => {
  close(decayTowardInitial(1600, 365, DEFAULT_ELO_CONFIG), 1550);
  close(decayTowardInitial(1400, 730, DEFAULT_ELO_CONFIG), 1475);
  close(decayTowardInitial(1600, 0, DEFAULT_ELO_CONFIG), 1600);

  const history = [
    match({ id: "1", kickoffAt: "2024-08-01T15:00:00Z", home: "a", away: "b", score: [2, 0] }),
    match({ id: "2", kickoffAt: "2025-08-01T15:00:00Z", home: "a", away: "c", score: [0, 0] }),
  ];
  const ratings = runEloRatings(history, 0);
  const decayed = decayTowardInitial(1515, 365, DEFAULT_ELO_CONFIG);
  const draw = 20 * (0.5 - eloExpectedHomeScore(decayed, 1500, 0));
  close(ratings.get("sportmonks:a")?.rating ?? 0, decayed + draw);
});

const league = syntheticLeague({ teams: 10, seasons: 3 });
const lastKickoff = Date.parse(league[league.length - 1].kickoffAt);
const CUTOFF = new Date(lastKickoff + 7 * 86_400_000).toISOString();

function pStat(home: string, away: string, history = league, cutoffAt = CUTOFF) {
  return computePStat(history, {
    competitionKey: "sportmonks:8",
    homeTeamKey: `sportmonks:${home}`,
    awayTeamKey: `sportmonks:${away}`,
    cutoffAt,
    neutralVenue: false,
  });
}

test("p_stat ranks the synthetic strong team above the weak team", () => {
  const strongHome = pStat("t0", "t9");
  const weakHome = pStat("t9", "t0");
  assert.equal(strongHome.status, "available");
  assert.equal(weakHome.status, "available");
  if (strongHome.status !== "available" || weakHome.status !== "available") return;
  assertValidProbabilities(strongHome.probabilities);
  assert.ok(strongHome.probabilities.home > strongHome.baseline.home);
  assert.ok(weakHome.probabilities.away > weakHome.baseline.away);
  close(strongHome.ratingDifference, -weakHome.ratingDifference);
  assert.ok(strongHome.homeAdvantage > 0);
});

test("p_stat is a pure function of pre-cutoff history (leakage and order)", () => {
  const cutoffAt = league[200].kickoffAt;
  const before = pStat("t0", "t9", league, cutoffAt);
  const shuffled = [...league].reverse();
  assert.deepEqual(pStat("t0", "t9", shuffled, cutoffAt), before);

  const poisoned = league.map((item, index) =>
    Date.parse(item.kickoffAt) >= Date.parse(cutoffAt)
      ? { ...item, homeGoals: index % 2 === 0 ? 9 : 0, awayGoals: index % 2 === 0 ? 0 : 9 }
      : item,
  );
  assert.deepEqual(pStat("t0", "t9", poisoned, cutoffAt), before);
});

test("p_stat refuses neutral venues, thin team history and thin leagues", () => {
  const neutral = computePStat(league, {
    competitionKey: "sportmonks:8",
    homeTeamKey: "sportmonks:t0",
    awayTeamKey: "sportmonks:t1",
    cutoffAt: CUTOFF,
    neutralVenue: true,
  });
  assert.equal(neutral.status, "unavailable");
  assert.equal(neutral.status === "unavailable" && neutral.reason, "neutral_venue_unsupported");

  const promoted = pStat("t0", "new-team");
  assert.equal(promoted.status === "unavailable" && promoted.reason, "insufficient_team_history");

  const thin = pStat("t0", "t1", league.slice(0, 40));
  assert.equal(thin.status === "unavailable" && thin.reason, "insufficient_league_history");
});

test("p_stat thresholds come from the same cutoff-safe league baseline", () => {
  const result = pStat("t2", "t3");
  const baseline = computeLeagueBaseline(league, {
    competitionKey: "sportmonks:8",
    cutoffAt: CUTOFF,
  });
  assert.equal(result.status, "available");
  assert.equal(baseline.status, "available");
  if (result.status !== "available" || baseline.status !== "available") return;
  assert.deepEqual(result.baseline, baseline.probabilities);
});
