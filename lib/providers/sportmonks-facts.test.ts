import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSportmonksFixtureFacts,
  ingestSportmonksFixtureAnalytics,
  type FixtureFactInsert,
  type SportmonksFactContext,
  type SportmonksFactStore,
} from "./sportmonks-facts";
import type {
  SportmonksMetricRow,
  SportmonksPressureRow,
} from "./sportmonks";

const context: SportmonksFactContext = {
  fixtureId: "fixture-1",
  providerFixtureId: "19735144",
  capturedAt: "2026-10-20T00:00:00.000Z",
  home: {
    canonicalTeamId: "team-home",
    providerTeamId: "10",
  },
  away: {
    canonicalTeamId: "team-away",
    providerTeamId: "20",
  },
};

test("normalizes Sportmonks xG/statistics/pressure into immutable raw facts", () => {
  const statistics: SportmonksMetricRow[] = [
    {
      fixture_id: 19735144,
      participant_id: 10,
      type_id: 42,
      data: { value: 61 },
      type: { developer_name: "BALL_POSSESSION", name: "Ball Possession" },
    },
  ];
  const xg: SportmonksMetricRow[] = [
    {
      fixture_id: 19735144,
      participant_id: 20,
      type_id: 5304,
      data: { value: 1.37 },
      type: { developer_name: "EXPECTED_GOALS", name: "Expected Goals" },
    },
  ];
  const pressure: SportmonksPressureRow[] = [
    {
      fixture_id: 19735144,
      participant_id: 10,
      minute: 17,
      pressure: 68.5,
    },
  ];

  const facts = buildSportmonksFixtureFacts(context, {
    statistics,
    xg,
    pressure,
  });

  assert.equal(facts.length, 3);

  assert.deepEqual(
    {
      key: facts[0].fact_key,
      subject: facts[0].subject_team_id,
      value: facts[0].value_numeric,
      provider: facts[0].provider,
      provenance: facts[0].provenance_type,
    },
    {
      key: "stat.ball_possession",
      subject: "team-home",
      value: 61,
      provider: "sportmonks",
      provenance: "provider_raw",
    },
  );

  assert.equal(facts[1].fact_key, "xg.expected_goals");
  assert.equal(facts[1].subject_team_id, "team-away");
  assert.equal(facts[1].value_numeric, 1.37);

  assert.equal(facts[2].fact_key, "pressure.index");
  assert.equal(facts[2].subject_team_id, "team-home");
  assert.equal(facts[2].value_numeric, 68.5);
  assert.deepEqual(facts[2].metadata, {
    provider_participant_id: 10,
    minute: 17,
  });

  assert.match(facts[0].source_fingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(facts[0].source_fingerprint, facts[1].source_fingerprint);
});

test("unknown participants stay fixture-scoped instead of being misattributed", () => {
  const facts = buildSportmonksFixtureFacts(context, {
    statistics: [
      {
        participant_id: 999,
        type_id: 7,
        data: { value: "12" },
        type: { developer_name: "SHOTS_TOTAL" },
      },
    ],
    xg: [],
    pressure: [],
  });

  assert.equal(facts[0].subject_type, "fixture");
  assert.equal(facts[0].subject_team_id, null);
  assert.equal(facts[0].subject_ref, "999");
  assert.equal(facts[0].value_text, "12");
  assert.equal(facts[0].value_numeric, null);
});

test("ingestion fetches all analytics groups and writes one fact batch", async () => {
  const source = {
    async getStatisticsRows(): Promise<SportmonksMetricRow[]> {
      return [
        {
          participant_id: 10,
          type_id: 1,
          data: { value: 5 },
          type: { developer_name: "SHOTS_TOTAL" },
        },
      ];
    },
    async getXgRows(): Promise<SportmonksMetricRow[]> {
      return [
        {
          participant_id: 10,
          type_id: 2,
          data: { value: 0.8 },
          type: { developer_name: "EXPECTED_GOALS" },
        },
      ];
    },
    async getPressureRows(): Promise<SportmonksPressureRow[]> {
      return [{ participant_id: 20, minute: 1, pressure: 41 }];
    },
  };

  class MemoryStore implements SportmonksFactStore {
    facts: FixtureFactInsert[] = [];

    async saveFacts(facts: FixtureFactInsert[]): Promise<number> {
      this.facts = facts;
      return facts.length;
    }
  }

  const store = new MemoryStore();
  const result = await ingestSportmonksFixtureAnalytics(source, store, context);

  assert.deepEqual(result, {
    statistics: 1,
    xg: 1,
    pressure: 1,
    factsWritten: 3,
  });
  assert.equal(store.facts.length, 3);
});
