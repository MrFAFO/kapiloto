import assert from "node:assert/strict";
import test from "node:test";

import {
  selectScoredPrediction,
  type FixtureForEvaluation,
  type StoredEvalPrediction,
} from "./selection";

const HOME = "00000000-0000-4000-8000-0000000000a1";
const AWAY = "00000000-0000-4000-8000-0000000000a2";
const KICKOFF = "2026-10-24T14:00:00.000Z";
const at = (minutesBeforeKickoff: number) =>
  new Date(Date.parse(KICKOFF) - minutesBeforeKickoff * 60_000).toISOString();

const fixture: FixtureForEvaluation = {
  fixtureId: "fixture-1",
  homeTeamId: HOME,
  awayTeamId: AWAY,
  kickoffAt: KICKOFF,
  actualKickoffAt: null,
  status: "finished",
  homeScore: 1,
  awayScore: 0,
};

function prediction(
  id: string,
  issuedMinutesBefore: number,
  overrides: Partial<StoredEvalPrediction> = {},
): StoredEvalPrediction {
  return {
    id,
    fixture_id: "fixture-1",
    arm: "kapiloto_published",
    arm_version: "v1",
    evaluation_mode: "forward",
    deterministic: false,
    information_cutoff_at: at(issuedMinutesBefore + 30),
    issued_at: at(issuedMinutesBefore),
    recorded_at: at(issuedMinutesBefore),
    kickoff_at_snapshot: KICKOFF,
    home_team_id: HOME,
    away_team_id: AWAY,
    valid: true,
    invalid_reason: null,
    p_home: 0.5,
    p_draw: 0.3,
    p_away: 0.2,
    ...overrides,
  };
}

const selectedId = (result: ReturnType<typeof selectScoredPrediction>) =>
  result.status === "selected" ? result.prediction.id : null;

test("forward selection picks the latest prediction issued before kickoff minus margin", () => {
  const result = selectScoredPrediction(
    [prediction("early", 600), prediction("latest", 20), prediction("middle", 120)],
    fixture,
    "forward",
  );
  assert.equal(selectedId(result), "latest");
  assert.equal(result.deadline, at(15));
});

test("a run published after the deadline is never selected", () => {
  const result = selectScoredPrediction(
    [
      prediction("pre", 60),
      prediction("inside-margin", 10, { information_cutoff_at: at(120) }),
      prediction("after-kickoff", -90, { information_cutoff_at: at(120) }),
    ],
    fixture,
    "forward",
  );
  assert.equal(selectedId(result), "pre");
  assert.deepEqual(
    result.rejected.map((item) => [item.id, item.reason]),
    [
      ["inside-margin", "issued_after_deadline"],
      ["after-kickoff", "issued_after_deadline"],
    ],
  );
});

test("selection is independent of input order and breaks ties deterministically", () => {
  const tied = [
    prediction("b", 60),
    prediction("a", 60),
    prediction("c", 60, { information_cutoff_at: at(70) }),
  ];
  const forward = selectedId(selectScoredPrediction(tied, fixture, "forward"));
  const reversed = selectedId(selectScoredPrediction([...tied].reverse(), fixture, "forward"));
  assert.equal(forward, "c");
  assert.equal(reversed, "c");
  const exact = [prediction("b", 60), prediction("a", 60)];
  assert.equal(selectedId(selectScoredPrediction(exact, fixture, "forward")), "a");
});

test("an invalid latest prediction is scored as unavailable, never replaced by an older one", () => {
  const result = selectScoredPrediction(
    [
      prediction("older-valid", 300),
      prediction("latest-invalid", 30, {
        valid: false,
        invalid_reason: "kapiloto_outcome_insufficient_data",
        p_home: null,
        p_draw: null,
        p_away: null,
      }),
    ],
    fixture,
    "forward",
  );
  assert.equal(selectedId(result), "latest-invalid");
});

test("wrong home/away orientation is rejected", () => {
  const result = selectScoredPrediction(
    [prediction("swapped", 60, { home_team_id: AWAY, away_team_id: HOME })],
    fixture,
    "forward",
  );
  assert.equal(result.status, "no_eligible_prediction");
  assert.deepEqual(result.rejected, [{ id: "swapped", reason: "orientation_mismatch" }]);
});

test("information later than issue time or deadline is rejected", () => {
  const result = selectScoredPrediction(
    [
      prediction("future-info", 60, { information_cutoff_at: at(30) }),
      prediction("late-info", 60, { information_cutoff_at: at(5) }),
    ],
    fixture,
    "forward",
  );
  assert.equal(result.status, "no_eligible_prediction");
  assert.deepEqual(
    result.rejected.map((item) => item.reason),
    ["information_after_issue", "information_after_deadline"],
  );
});

test("a postponed-and-rescheduled fixture does not score predictions made for the old date", () => {
  const rescheduled = { ...fixture, kickoffAt: "2026-11-04T19:00:00.000Z" };
  const result = selectScoredPrediction([prediction("old-date", 60)], rescheduled, "forward");
  assert.equal(result.status, "no_eligible_prediction");
  assert.deepEqual(result.rejected, [{ id: "old-date", reason: "kickoff_rescheduled" }]);

  const delayed = { ...fixture, actualKickoffAt: at(-30) };
  assert.equal(
    selectedId(selectScoredPrediction([prediction("same-day", 60)], delayed, "forward")),
    "same-day",
  );
});

test("replay mode only scores deterministic arms and keys on information cutoff", () => {
  const replay = [
    prediction("llm", 60, { evaluation_mode: "replay" }),
    prediction("det-early", -600, {
      evaluation_mode: "replay",
      deterministic: true,
      information_cutoff_at: at(600),
    }),
    prediction("det-late", -700, {
      evaluation_mode: "replay",
      deterministic: true,
      information_cutoff_at: at(20),
    }),
    prediction("forward-row", 60),
  ];
  const result = selectScoredPrediction(replay, fixture, "replay");
  assert.equal(selectedId(result), "det-late");
  assert.deepEqual(
    result.rejected.map((item) => [item.id, item.reason]).sort(),
    [
      ["forward-row", "mode_mismatch"],
      ["llm", "non_deterministic_replay"],
    ],
  );
});
