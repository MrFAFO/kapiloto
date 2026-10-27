import assert from "node:assert/strict";
import test from "node:test";

import { assembleProviderAnalyticsSnapshots } from "./provider-analytics";

function row(
  fixtureId: string,
  teamId: string,
  factKey: string,
  value: number,
  capturedAt: string,
  season = "26/27",
) {
  return {
    fixture_id: fixtureId,
    fact_key: factKey,
    subject_team_id: teamId,
    value_numeric: value,
    captured_at: capturedAt,
    source_version: "football-il-parse-v11",
    metadata: { season },
  };
}

test("assembles the latest coherent Parse analytics capture before cutoff", () => {
  const snapshots = assembleProviderAnalyticsSnapshots(
    [
      row("fixture-1", "home", "season.xg.expected", 12, "2026-10-26T08:00:00Z"),
      row("fixture-1", "away", "season.xg.expected", 10, "2026-10-26T08:00:00Z"),
      row("fixture-1", "home", "season.games_played", 8, "2026-10-26T08:00:00Z"),
      row("fixture-1", "away", "season.games_played", 8, "2026-10-26T08:00:00Z"),
      row("fixture-1", "home", "season.xg.expected", 14.4, "2026-10-27T08:00:00Z"),
      row("fixture-1", "away", "season.xg.expected", 9.6, "2026-10-27T08:00:00Z"),
      row("fixture-1", "home", "season.games_played", 8, "2026-10-27T08:00:00Z"),
      row("fixture-1", "away", "season.games_played", 8, "2026-10-27T08:00:00Z"),
      row("fixture-1", "home", "season.goals.scored", 18, "2026-10-27T08:00:00Z"),
      row("fixture-1", "away", "season.goals.scored", 11, "2026-10-27T08:00:00Z"),
    ],
    "2026-10-27T09:00:00Z",
  );

  const snapshot = snapshots.get("fixture-1");
  assert.ok(snapshot);
  assert.equal(snapshot.captured_at, "2026-10-27T08:00:00Z");
  assert.equal(snapshot.season, "26/27");

  const home = snapshot.teams.find((team) => team.team_id === "home");
  const away = snapshot.teams.find((team) => team.team_id === "away");

  assert.equal(home?.xg_expected, 14.4);
  assert.equal(home?.xg_per_match, 1.8);
  assert.equal(home?.goals_scored, 18);
  assert.equal(away?.xg_per_match, 1.2);
});

test("post-cutoff facts are ignored", () => {
  const snapshots = assembleProviderAnalyticsSnapshots(
    [
      row("fixture-1", "home", "season.xg.expected", 12, "2026-10-27T08:00:00Z"),
      row("fixture-1", "away", "season.xg.expected", 10, "2026-10-27T08:00:00Z"),
      row("fixture-1", "home", "season.xg.expected", 99, "2026-10-27T12:00:00Z"),
      row("fixture-1", "away", "season.xg.expected", 99, "2026-10-27T12:00:00Z"),
    ],
    "2026-10-27T09:00:00Z",
  );

  const snapshot = snapshots.get("fixture-1");
  assert.ok(snapshot);
  assert.equal(
    snapshot.teams.find((team) => team.team_id === "home")?.xg_expected,
    12,
  );
});

test("xG per match stays null when validated games played is absent", () => {
  const snapshots = assembleProviderAnalyticsSnapshots(
    [
      row("fixture-1", "home", "season.xg.expected", 12, "2026-10-27T08:00:00Z"),
      row("fixture-1", "away", "season.xg.expected", 10, "2026-10-27T08:00:00Z"),
    ],
    "2026-10-27T09:00:00Z",
  );

  const snapshot = snapshots.get("fixture-1");
  assert.ok(snapshot);
  assert.equal(snapshot.teams[0]?.xg_per_match, null);
  assert.equal(snapshot.teams[1]?.xg_per_match, null);
});

test("requires xG for both teams before exposing a fixture analytics snapshot", () => {
  const snapshots = assembleProviderAnalyticsSnapshots(
    [
      row("fixture-1", "home", "season.xg.expected", 12, "2026-10-27T08:00:00Z"),
      row("fixture-1", "home", "season.games_played", 8, "2026-10-27T08:00:00Z"),
    ],
    "2026-10-27T09:00:00Z",
  );

  assert.equal(snapshots.has("fixture-1"), false);
});
