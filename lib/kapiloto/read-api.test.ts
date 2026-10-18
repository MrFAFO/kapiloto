import assert from "node:assert/strict";
import test from "node:test";

import type {
  KapilotoFixtureEnvelope,
  KapilotoRoundStateEnvelope,
} from "./api-types";
import {
  handleFixtureAnalysisGet,
  handleRoundResearchStateGet,
  type KapilotoReadDeps,
} from "./read-api";
import { createFakeSupabase } from "./test-support/fake-supabase";

const USER = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const OTHER_GROUP = "22222222-2222-4222-8222-999999999999";
const ROUND = "33333333-3333-4333-8333-333333333333";
const OTHER_ROUND = "33333333-3333-4333-8333-999999999999";
const GAME = "44444444-4444-4444-8444-444444444444";
const OTHER_GAME = "44444444-4444-4444-8444-999999999999";
const RUN_1 = "55555555-5555-4555-8555-555555555551";
const RUN_2 = "55555555-5555-4555-8555-555555555552";
const ANALYSIS_1 = "66666666-6666-4666-8666-666666666661";

const FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const GENERATED = "2026-10-17T10:00:00.000Z";

type Tables = Record<string, Record<string, unknown>[]>;

function baseTables(overrides: Partial<Tables> = {}): Tables {
  return {
    group_members: [
      { group_id: GROUP, user_id: USER, role: "member", status: "active" },
    ],
    group_round_settings: [
      { group_id: GROUP, round_id: ROUND, max_doubles: 7, locked_at: null },
    ],
    round_games: [{ id: GAME, round_id: ROUND }],
    kapiloto_round_research_state: [],
    kapiloto_analyses: [],
    kapiloto_freshness_signals: [],
    ...overrides,
  };
}

function analysisRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ANALYSIS_1,
    research_run_id: RUN_1,
    round_game_id: GAME,
    outcome: "analyzed",
    primary_pick: "X",
    suggested_double: "X2",
    double_priority_rank: 3,
    reliability_band: "high",
    summary: "Balanced fixture.",
    main_risk: "Late lineup news.",
    generated_at: GENERATED,
    valid_until: FUTURE,
    p_final_1_bp: 3000,
    p_final_x_bp: 3500,
    p_final_2_bp: 3500,
    ...overrides,
  };
}

function setup(tables: Tables, userId: string | null = USER) {
  const fake = createFakeSupabase(tables);
  let adminRequested = 0;
  const deps: KapilotoReadDeps = {
    getUserId: async () => userId,
    getAdmin: () => {
      adminRequested += 1;
      return fake.client;
    },
  };
  return { fake, deps, adminRequested: () => adminRequested };
}

function fixtureRequest(
  options: { groupId?: string | null; ifNoneMatch?: string } = {},
) {
  const groupId = options.groupId === undefined ? GROUP : options.groupId;
  const url = new URL(
    `http://localhost/api/v1/rounds/${ROUND}/kapiloto/fixtures/${GAME}`,
  );
  if (groupId) url.searchParams.set("group_id", groupId);
  return new Request(url, {
    headers: options.ifNoneMatch ? { "if-none-match": options.ifNoneMatch } : {},
  });
}

async function getFixture(
  tables: Tables,
  options: {
    groupId?: string | null;
    ifNoneMatch?: string;
    roundId?: string;
    roundGameId?: string;
    userId?: string | null;
  } = {},
) {
  const ctx = setup(tables, options.userId === undefined ? USER : options.userId);
  const response = await handleFixtureAnalysisGet(
    fixtureRequest(options),
    {
      roundId: options.roundId ?? ROUND,
      roundGameId: options.roundGameId ?? GAME,
    },
    ctx.deps,
  );
  return { response, ...ctx };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

test("GET fixture never invokes research creation or writes", async () => {
  const scenarios: Tables[] = [
    baseTables(),
    baseTables({
      kapiloto_round_research_state: [
        { round_id: ROUND, runs_consumed: 1, active_run_id: RUN_1, current_run_id: null, research_closed_at: null, version: 1 },
      ],
    }),
    baseTables({
      kapiloto_round_research_state: [
        { round_id: ROUND, runs_consumed: 1, active_run_id: null, current_run_id: RUN_1, research_closed_at: null, version: 2 },
      ],
      kapiloto_analyses: [analysisRow({ valid_until: PAST })],
    }),
  ];

  for (const tables of scenarios) {
    const { response, fake } = await getFixture(tables);
    assert.equal(response.status, 200);
    assert.deepEqual(fake.forbiddenCalls, []);
    assert.ok(fake.queries.every((query) => query.operation === "select"));
    assert.ok(
      !fake.queries.some((query) => query.table === "kapiloto_research_requests"),
    );
  }
});

test("no current run returns unresearched without analysis", async () => {
  const { response } = await getFixture(baseTables());
  const body = await json<KapilotoFixtureEnvelope>(response);

  assert.equal(response.status, 200);
  assert.equal(body.state, "unresearched");
  assert.equal(body.analysis, null);
  assert.equal(body.analysis_run, null);
  assert.equal(body.poll, null);
  assert.deepEqual(body.research, {
    active_run_id: null,
    current_run_id: null,
    runs_used: 0,
    runs_max: 3,
    runs_remaining: 3,
    closed: false,
    version: 0,
  });
});

test("active first run returns researching with run metadata and Retry-After", async () => {
  const { response } = await getFixture(
    baseTables({
      kapiloto_round_research_state: [
        { round_id: ROUND, runs_consumed: 1, active_run_id: RUN_1, current_run_id: null, research_closed_at: null, version: 1 },
      ],
    }),
  );
  const body = await json<KapilotoFixtureEnvelope>(response);

  assert.equal(response.status, 200);
  assert.equal(body.state, "researching");
  assert.equal(body.analysis, null);
  assert.equal(body.research.active_run_id, RUN_1);
  assert.equal(body.research.runs_remaining, 2);
  assert.deepEqual(body.poll, { retry_after_seconds: 3 });
  assert.equal(response.headers.get("retry-after"), "3");
});

test("current fresh analysis returns ready with the safe projection", async () => {
  const { response } = await getFixture(
    baseTables({
      kapiloto_round_research_state: [
        { round_id: ROUND, runs_consumed: 1, active_run_id: null, current_run_id: RUN_1, research_closed_at: null, version: 2 },
      ],
      kapiloto_analyses: [analysisRow()],
    }),
  );
  const body = await json<KapilotoFixtureEnvelope>(response);

  assert.equal(body.state, "ready");
  assert.deepEqual(body.freshness, { state: "fresh", stale_reasons: [] });
  assert.deepEqual(body.analysis_run, { id: RUN_1 });
  assert.equal(body.analysis?.primaryPick, "X");
  assert.equal(body.analysis?.suggestedDouble, "X2");
  assert.equal(body.analysis?.doublePriorityRank, 3);
  assert.equal(body.analysis?.doubleRecommended, true);
  assert.equal(body.group.max_doubles, 7);

  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("p_final"), "p_final must not be exposed");
  assert.ok(!raw.includes("3500"), "probability basis points must not leak");
});

test("stale analysis returns stale with reasons; an active recheck run keeps analysis visible", async () => {
  const stale = await getFixture(
    baseTables({
      kapiloto_round_research_state: [
        { round_id: ROUND, runs_consumed: 1, active_run_id: null, current_run_id: RUN_1, research_closed_at: null, version: 2 },
      ],
      kapiloto_analyses: [analysisRow()],
      kapiloto_freshness_signals: [
        { round_game_id: GAME, signal_type: "lineup_change", severity: 3, observed_at: "2026-10-17T12:00:00.000Z" },
        { round_game_id: GAME, signal_type: "minor_news", severity: 1, observed_at: "2026-10-17T12:00:00.000Z" },
      ],
    }),
  );
  const staleBody = await json<KapilotoFixtureEnvelope>(stale.response);
  assert.equal(staleBody.state, "stale");
  assert.deepEqual(staleBody.freshness, {
    state: "stale",
    stale_reasons: ["signal:lineup_change"],
  });

  const rechecking = await getFixture(
    baseTables({
      kapiloto_round_research_state: [
        { round_id: ROUND, runs_consumed: 2, active_run_id: RUN_2, current_run_id: RUN_1, research_closed_at: null, version: 3 },
      ],
      kapiloto_analyses: [analysisRow({ valid_until: PAST })],
    }),
  );
  const recheckBody = await json<KapilotoFixtureEnvelope>(rechecking.response);
  assert.equal(recheckBody.state, "researching");
  assert.equal(recheckBody.analysis?.analysisId, ANALYSIS_1);
  assert.deepEqual(recheckBody.freshness?.stale_reasons, ["ttl_expired"]);
});

test("exhausted budget without analysis returns limit_reached", async () => {
  const { response } = await getFixture(
    baseTables({
      kapiloto_round_research_state: [
        { round_id: ROUND, runs_consumed: 3, active_run_id: null, current_run_id: null, research_closed_at: null, version: 9 },
      ],
    }),
  );
  const body = await json<KapilotoFixtureEnvelope>(response);
  assert.equal(body.state, "limit_reached");
  assert.equal(body.research.runs_remaining, 0);
});

test("group max doubles changes doubleRecommended without changing stored analysis", async () => {
  const tablesFor = (maxDoubles: number) =>
    baseTables({
      group_round_settings: [
        { group_id: GROUP, round_id: ROUND, max_doubles: maxDoubles, locked_at: null },
      ],
      kapiloto_round_research_state: [
        { round_id: ROUND, runs_consumed: 1, active_run_id: null, current_run_id: RUN_1, research_closed_at: null, version: 2 },
      ],
      kapiloto_analyses: [analysisRow({ double_priority_rank: 5 })],
    });

  const wide = await json<KapilotoFixtureEnvelope>(
    (await getFixture(tablesFor(7))).response,
  );
  const narrow = await json<KapilotoFixtureEnvelope>(
    (await getFixture(tablesFor(4))).response,
  );
  const none = await json<KapilotoFixtureEnvelope>(
    (await getFixture(tablesFor(0))).response,
  );

  assert.equal(wide.analysis?.doubleRecommended, true);
  assert.equal(narrow.analysis?.doubleRecommended, false);
  assert.equal(none.analysis?.doubleRecommended, false);

  for (const body of [narrow, none]) {
    assert.equal(body.analysis?.analysisId, wide.analysis?.analysisId);
    assert.equal(body.analysis?.doublePriorityRank, 5);
    assert.equal(body.analysis?.suggestedDouble, wide.analysis?.suggestedDouble);
    assert.equal(body.analysis?.primaryPick, wide.analysis?.primaryPick);
  }
});

test("unauthenticated request returns 401 before touching the database", async () => {
  const { response, adminRequested } = await getFixture(baseTables(), {
    userId: null,
  });
  assert.equal(response.status, 401);
  assert.equal(adminRequested(), 0);
});

test("non-member or unconfigured group returns 403", async () => {
  const nonMember = await getFixture(baseTables(), { groupId: OTHER_GROUP });
  assert.equal(nonMember.response.status, 403);

  const inactive = await getFixture(
    baseTables({
      group_members: [
        { group_id: GROUP, user_id: USER, role: "member", status: "left" },
      ],
    }),
  );
  assert.equal(inactive.response.status, 403);

  const unconfigured = await getFixture(baseTables(), { roundId: OTHER_ROUND });
  assert.equal(unconfigured.response.status, 403);
});

test("fixture that does not belong to the round returns 404", async () => {
  const { response } = await getFixture(
    baseTables({ round_games: [{ id: OTHER_GAME, round_id: OTHER_ROUND }] }),
  );
  assert.equal(response.status, 404);

  const unknown = await getFixture(baseTables(), { roundGameId: OTHER_GAME });
  assert.equal(unknown.response.status, 404);
});

test("missing or malformed group_id is rejected with 400", async () => {
  const missing = await getFixture(baseTables(), { groupId: null });
  assert.equal(missing.response.status, 400);

  const malformed = await getFixture(baseTables(), { groupId: "not-a-uuid" });
  assert.equal(malformed.response.status, 400);
});

test("ETag is stable, supports If-None-Match 304 and changes with group context", async () => {
  const tables = baseTables({
    kapiloto_round_research_state: [
      { round_id: ROUND, runs_consumed: 1, active_run_id: null, current_run_id: RUN_1, research_closed_at: null, version: 2 },
    ],
    kapiloto_analyses: [analysisRow()],
  });

  const first = await getFixture(tables);
  const etag = first.response.headers.get("etag");
  assert.ok(etag);

  const second = await getFixture(tables);
  assert.equal(second.response.headers.get("etag"), etag);

  const notModified = await getFixture(tables, { ifNoneMatch: etag });
  assert.equal(notModified.response.status, 304);
  assert.equal(notModified.response.headers.get("etag"), etag);
  assert.equal(await notModified.response.text(), "");

  const listed = await getFixture(tables, {
    ifNoneMatch: `W/"other", ${etag}`,
  });
  assert.equal(listed.response.status, 304);

  const changedGroup = await getFixture({
    ...tables,
    group_round_settings: [
      { group_id: GROUP, round_id: ROUND, max_doubles: 2, locked_at: null },
    ],
  }, { ifNoneMatch: etag });
  assert.equal(changedGroup.response.status, 200);
  assert.notEqual(changedGroup.response.headers.get("etag"), etag);
});

test("GET state returns round research counters without side effects", async () => {
  const tables = baseTables({
    kapiloto_round_research_state: [
      { round_id: ROUND, runs_consumed: 2, active_run_id: RUN_2, current_run_id: RUN_1, research_closed_at: null, version: 7 },
    ],
  });
  const ctx = setup(tables);
  const response = await handleRoundResearchStateGet(
    new Request(
      `http://localhost/api/v1/rounds/${ROUND}/kapiloto/state?group_id=${GROUP}`,
    ),
    { roundId: ROUND },
    ctx.deps,
  );
  const body = await json<KapilotoRoundStateEnvelope>(response);

  assert.equal(response.status, 200);
  assert.deepEqual(body.research, {
    active_run_id: RUN_2,
    current_run_id: RUN_1,
    runs_used: 2,
    runs_max: 3,
    runs_remaining: 1,
    closed: false,
    version: 7,
  });
  assert.deepEqual(body.poll, { retry_after_seconds: 3 });
  assert.equal(response.headers.get("retry-after"), "3");
  assert.deepEqual(ctx.fake.forbiddenCalls, []);
  assert.deepEqual(
    [...new Set(ctx.fake.queries.map((query) => query.table))].sort(),
    ["group_members", "group_round_settings", "kapiloto_round_research_state"],
  );
});

test("GET state reports closed rounds and enforces auth and membership", async () => {
  const tables = baseTables({
    kapiloto_round_research_state: [
      { round_id: ROUND, runs_consumed: 1, active_run_id: null, current_run_id: RUN_1, research_closed_at: GENERATED, version: 4 },
    ],
  });
  const url = (groupId: string | null) =>
    `http://localhost/api/v1/rounds/${ROUND}/kapiloto/state${groupId ? `?group_id=${groupId}` : ""}`;

  const ok = await handleRoundResearchStateGet(
    new Request(url(GROUP)),
    { roundId: ROUND },
    setup(tables).deps,
  );
  const body = await json<KapilotoRoundStateEnvelope>(ok);
  assert.equal(body.research.closed, true);
  assert.equal(body.poll, null);

  const unauthorized = await handleRoundResearchStateGet(
    new Request(url(GROUP)),
    { roundId: ROUND },
    setup(tables, null).deps,
  );
  assert.equal(unauthorized.status, 401);

  const forbidden = await handleRoundResearchStateGet(
    new Request(url(OTHER_GROUP)),
    { roundId: ROUND },
    setup(tables).deps,
  );
  assert.equal(forbidden.status, 403);

  const missingGroup = await handleRoundResearchStateGet(
    new Request(url(null)),
    { roundId: ROUND },
    setup(tables).deps,
  );
  assert.equal(missingGroup.status, 400);
});
