import assert from "node:assert/strict";
import test from "node:test";

import { historyBeforeCutoff, RESULT_KNOWN_AFTER_KICKOFF_MINUTES } from "./history";
import {
  computeLeagueBaseline,
  DEFAULT_LEAGUE_BASELINE_CONFIG,
  recencyWeight,
  type LeagueBaselineConfig,
} from "./league-baseline";
import { assertValidProbabilities } from "./probabilities";
import { match } from "./test-fixtures";

const close = (actual: number, expected: number, tolerance = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

const CUTOFF = "2026-01-01T12:00:00.000Z";
const DAY = 86_400_000;
const unweighted: LeagueBaselineConfig = {
  lookbackDays: 10_000,
  halfLifeDays: 1e12,
  minEffectiveMatches: 1,
  pseudoCountPerOutcome: 0,
};

function results(home: number, draw: number, away: number) {
  const scores: Array<[number, number]> = [
    ...Array<[number, number]>(home).fill([2, 0]),
    ...Array<[number, number]>(draw).fill([1, 1]),
    ...Array<[number, number]>(away).fill([0, 1]),
  ];
  return scores.map((score, index) =>
    match({
      id: String(index + 1),
      kickoffAt: new Date(Date.parse(CUTOFF) - (index + 1) * DAY).toISOString(),
      home: `h${index}`,
      away: `a${index}`,
      score,
    }),
  );
}

test("unweighted baseline equals the observed home/draw/away rates", () => {
  const baseline = computeLeagueBaseline(
    results(45, 25, 30),
    { competitionKey: "sportmonks:8", cutoffAt: CUTOFF },
    unweighted,
  );
  assert.equal(baseline.status, "available");
  if (baseline.status !== "available") return;
  close(baseline.probabilities.home, 0.45, 1e-9);
  close(baseline.probabilities.draw, 0.25, 1e-9);
  close(baseline.probabilities.away, 0.3, 1e-9);
  assert.equal(baseline.matches, 100);
  close(baseline.effectiveMatches, 100, 1e-6);
});

test("pseudo-count smoothing adds one observation per outcome", () => {
  const baseline = computeLeagueBaseline(
    results(45, 25, 30),
    { competitionKey: "sportmonks:8", cutoffAt: CUTOFF },
    { ...unweighted, pseudoCountPerOutcome: 1 },
  );
  assert.equal(baseline.status, "available");
  if (baseline.status !== "available") return;
  close(baseline.probabilities.home, 46 / 103, 1e-9);
  close(baseline.probabilities.draw, 26 / 103, 1e-9);
  close(baseline.probabilities.away, 31 / 103, 1e-9);
  assertValidProbabilities(baseline.probabilities);
});

test("time decay: a match one half-life old counts half", () => {
  close(recencyWeight(0, 730), 1);
  close(recencyWeight(730, 730), 0.5);
  close(recencyWeight(1460, 730), 0.25);

  const halfLife = 100;
  const history = [
    match({ id: "new", kickoffAt: new Date(Date.parse(CUTOFF) - 3 * 3_600_000).toISOString(), home: "a", away: "b", score: [1, 0] }),
    match({ id: "old", kickoffAt: new Date(Date.parse(CUTOFF) - 3 * 3_600_000 - halfLife * DAY).toISOString(), home: "c", away: "d", score: [0, 1] }),
  ];
  const baseline = computeLeagueBaseline(
    history,
    { competitionKey: "sportmonks:8", cutoffAt: CUTOFF },
    { lookbackDays: 1000, halfLifeDays: halfLife, minEffectiveMatches: 1, pseudoCountPerOutcome: 0 },
  );
  assert.equal(baseline.status, "available");
  if (baseline.status !== "available") return;
  // weights ~1 and ~0.5 (the 3h offset is identical for both matches' age gap)
  close(baseline.probabilities.home / baseline.probabilities.away, 2, 1e-9);
  close(baseline.probabilities.draw, 0);
});

test("cutoff isolation: unfinished, future, other-league and neutral matches are excluded", () => {
  const cutoffMs = Date.parse(CUTOFF);
  const justKnown = new Date(cutoffMs - RESULT_KNOWN_AFTER_KICKOFF_MINUTES * 60_000).toISOString();
  const notYetKnown = new Date(cutoffMs - (RESULT_KNOWN_AFTER_KICKOFF_MINUTES - 1) * 60_000).toISOString();
  const history = [
    match({ id: "known", kickoffAt: justKnown, home: "a", away: "b", score: [1, 0] }),
    match({ id: "in-play", kickoffAt: notYetKnown, home: "c", away: "d", score: [0, 3] }),
    match({ id: "future", kickoffAt: "2026-02-01T12:00:00Z", home: "e", away: "f", score: [0, 3] }),
    match({ id: "other", kickoffAt: "2025-12-01T12:00:00Z", home: "g", away: "h", score: [0, 3], competitionKey: "sportmonks:564" }),
    match({ id: "neutral", kickoffAt: "2025-12-02T12:00:00Z", home: "i", away: "j", score: [0, 3], neutralVenue: true }),
    match({ id: "known", kickoffAt: justKnown, home: "a", away: "b", score: [1, 0] }),
  ];
  const used = historyBeforeCutoff(history, {
    competitionKey: "sportmonks:8",
    cutoffAt: CUTOFF,
    lookbackDays: 1000,
  }).map((item) => item.providerFixtureId);
  assert.deepEqual(used, ["neutral", "known"]);

  const baseline = computeLeagueBaseline(
    history,
    { competitionKey: "sportmonks:8", cutoffAt: CUTOFF },
    unweighted,
  );
  assert.equal(baseline.status, "available");
  if (baseline.status !== "available") return;
  assert.equal(baseline.matches, 1);
  close(baseline.probabilities.home, 1);
});

test("future results never change the baseline", () => {
  const history = results(40, 30, 30);
  const before = computeLeagueBaseline(history, { competitionKey: "sportmonks:8", cutoffAt: CUTOFF });
  const withFuture = computeLeagueBaseline(
    [
      ...history,
      ...results(0, 0, 50).map((item, index) => ({
        ...item,
        providerFixtureId: `future-${index}`,
        kickoffAt: new Date(Date.parse(CUTOFF) + (index + 1) * DAY).toISOString(),
      })),
    ],
    { competitionKey: "sportmonks:8", cutoffAt: CUTOFF },
  );
  assert.deepEqual(withFuture, before);
});

test("insufficient league history is reported, not guessed", () => {
  const baseline = computeLeagueBaseline(
    results(10, 5, 5),
    { competitionKey: "sportmonks:8", cutoffAt: CUTOFF },
  );
  assert.equal(baseline.status, "unavailable");
  if (baseline.status !== "unavailable") return;
  assert.equal(baseline.reason, "insufficient_league_history");
  assert.equal(baseline.matches, 20);
  assert.ok(baseline.effectiveMatches < DEFAULT_LEAGUE_BASELINE_CONFIG.minEffectiveMatches);
});
