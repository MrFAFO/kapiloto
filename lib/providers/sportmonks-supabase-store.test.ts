import assert from "node:assert/strict";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { SupabaseSportmonksSyncStore } from "./sportmonks-supabase-store";
import type { SportmonksResolvedFixture } from "./sportmonks-sync";

type Row = Record<string, unknown>;

function fakeClient(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const filters: Array<(row: Row) => boolean> = [];
      let patch: Row | null = null;

      const builder = {
        update(values: Row) {
          patch = values;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        upsert(row: Row, options: { onConflict: string; ignoreDuplicates?: boolean }) {
          const keys = options.onConflict.split(",");
          const existing = rows.find((candidate) =>
            keys.every((key) => candidate[key] === row[key]),
          );
          if (!existing) rows.push({ ...row });
          else if (!options.ignoreDuplicates) Object.assign(existing, row);
          return Promise.resolve({ error: null });
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          const matched = rows.filter((row) =>
            filters.every((filter) => filter(row)),
          );
          if (patch) {
            for (const row of matched) Object.assign(row, patch);
          }
          return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
        },
      };

      return builder;
    },
  } as unknown as SupabaseClient;
}

function snapshot(resolution: SportmonksResolvedFixture["resolution"]): SportmonksResolvedFixture {
  return {
    capturedAt: "2026-10-30T22:00:00.000Z",
    resolution,
    game: {
      roundGameId: "rg-1",
      fixtureId: "fx-1",
      gameNumber: 1,
      kickoffAt: "2026-11-01T18:00:00.000Z",
      competitionId: "comp-1",
      competitionName: "Premier League",
      home: {
        teamId: "team-home",
        canonicalName: "Home",
        aliases: [],
        providerTeamId: null,
      },
      away: {
        teamId: "team-away",
        canonicalName: "Away",
        aliases: [],
        providerTeamId: null,
      },
      providerFixtureId: 19700001,
    },
    fixture: {
      provider: "sportmonks",
      providerFixtureId: "19700001",
      kickoffAt: "2026-11-01T18:00:00.000Z",
      status: "NS",
      season: 2026,
      competition: {
        id: "8",
        name: "Premier League",
        country: "England",
        round: null,
      },
      home: { id: "14", name: "Manchester United" },
      away: { id: "52", name: "AFC Bournemouth" },
    },
  };
}

function emptyTables(): Record<string, Row[]> {
  return {
    provider_fixture_mappings: [],
    provider_team_mappings: [],
    provider_competition_mappings: [],
    fixtures: [{ id: "fx-1", last_synced_at: null }],
  };
}

test("Sportmonks bootstrap writes are insert-only weak evidence even for provided_id", async () => {
  const data = emptyTables();
  const store = new SupabaseSportmonksSyncStore(fakeClient(data));

  await store.saveResolvedFixture(snapshot("provided_id"));

  assert.deepEqual(
    data.provider_fixture_mappings.map((row) => [
      row.provider_fixture_id,
      row.mapping_status,
      row.mapping_confidence,
    ]),
    [["19700001", "confirmed", 0.9]],
  );
  assert.deepEqual(
    data.provider_team_mappings
      .map((row) => [
        row.provider_team_id,
        row.team_id,
        row.mapping_status,
        row.mapping_confidence,
      ])
      .sort(),
    [
      ["14", "team-home", "confirmed", 0.9],
      ["52", "team-away", "confirmed", 0.9],
    ],
  );
  assert.deepEqual(
    data.provider_competition_mappings.map((row) => [
      row.provider_competition_id,
      row.competition_id,
      row.mapping_status,
    ]),
    [["8", "comp-1", "confirmed"]],
  );
  assert.equal(data.fixtures[0].last_synced_at, "2026-10-30T22:00:00.000Z");
});

test("Sportmonks sync never rewrites existing identity rows", async () => {
  const data = emptyTables();
  data.provider_fixture_mappings.push({
    fixture_id: "fx-1",
    provider: "sportmonks",
    provider_fixture_id: "old-fixture",
    mapping_status: "manual_override",
    mapping_confidence: 1,
  });
  data.provider_team_mappings.push(
    {
      provider: "sportmonks",
      provider_team_id: "14",
      team_id: "existing-home",
      provider_name: "Existing Home",
      mapping_status: "manual_override",
      mapping_confidence: 1,
      last_verified_at: "2026-10-01T00:00:00.000Z",
    },
    {
      provider: "sportmonks",
      provider_team_id: "52",
      team_id: "existing-away",
      provider_name: "Existing Away",
      mapping_status: "confirmed",
      mapping_confidence: 0.9,
      last_verified_at: "2026-10-01T00:00:00.000Z",
    },
  );
  data.provider_competition_mappings.push({
    provider: "sportmonks",
    provider_competition_id: "8",
    competition_id: "existing-comp",
    provider_name: "Premier League",
    mapping_status: "manual_override",
    last_verified_at: "2026-10-01T00:00:00.000Z",
  });

  const before = JSON.parse(JSON.stringify({
    fixture: data.provider_fixture_mappings,
    teams: data.provider_team_mappings,
    competitions: data.provider_competition_mappings,
  }));

  await new SupabaseSportmonksSyncStore(fakeClient(data)).saveResolvedFixture(
    snapshot("provided_id"),
  );

  assert.deepEqual(data.provider_fixture_mappings, before.fixture);
  assert.deepEqual(data.provider_team_mappings, before.teams);
  assert.deepEqual(data.provider_competition_mappings, before.competitions);
  assert.equal(data.fixtures[0].last_synced_at, "2026-10-30T22:00:00.000Z");
});
