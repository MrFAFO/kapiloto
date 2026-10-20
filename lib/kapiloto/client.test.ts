import assert from "node:assert/strict";
import test from "node:test";

import type {
  KapilotoFixtureEnvelope,
  KapilotoRoundStateEnvelope,
} from "./api-types";
import { createKapilotoClient, pollFixtureResearch } from "./client";

const REF = {
  roundId: "33333333-3333-4333-8333-333333333333",
  roundGameId: "44444444-4444-4444-8444-444444444444",
  groupId: "22222222-2222-4222-8222-222222222222",
};
const RUN_1 = "55555555-5555-4555-8555-555555555551";

type Call = { url: string; method: string; headers: Headers; body: string | null };

function recorder(
  respond: (call: Call, index: number) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
      body: init?.body == null ? null : String(init.body),
    };
    calls.push(call);
    if (init?.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return respond(call, calls.length - 1);
  };
  return { calls, fetchImpl };
}

function envelope(
  overrides: Partial<KapilotoFixtureEnvelope> = {},
): KapilotoFixtureEnvelope {
  return {
    state: "researching",
    analysis: null,
    analysis_run: null,
    freshness: null,
    research: {
      active_run_id: RUN_1,
      current_run_id: null,
      runs_used: 1,
      runs_max: 3,
      runs_remaining: 2,
    },
    group: { max_doubles: 7, locked: false },
    poll: { retry_after_seconds: 3 },
    ...overrides,
  };
}

function roundState(
  research: Partial<KapilotoRoundStateEnvelope["research"]>,
): KapilotoRoundStateEnvelope {
  return {
    round_id: REF.roundId,
    research: {
      active_run_id: null,
      current_run_id: null,
      runs_used: 1,
      runs_max: 3,
      runs_remaining: 2,
      closed: false,
      version: 1,
      ...research,
    },
    poll: null,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const noSleep = async (_ms: number, signal?: AbortSignal) => {
  if (signal?.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }
};

test("consult sends exactly one POST with one UUID idempotency key", async () => {
  const { calls, fetchImpl } = recorder(() =>
    json(envelope({ request: { outcome: "created_run", replayed: false, request_id: null } }), 202, {
      "retry-after": "3",
    }),
  );
  const client = createKapilotoClient({ fetch: fetchImpl });

  const result = await client.consultFixture(REF);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `/api/v1/rounds/${REF.roundId}/kapiloto/requests`);
  const key = calls[0].headers.get("idempotency-key");
  assert.match(key ?? "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(calls[0].body ?? ""), {
    groupId: REF.groupId,
    roundGameId: REF.roundGameId,
    intent: "consult",
    basedOnRunId: null,
  });
  assert.equal(result.kind, "ok");
  assert.equal(result.idempotencyKey, key);
  if (result.kind === "ok") {
    assert.equal(result.status, 202);
    assert.equal(result.retryAfterSeconds, 3);
    assert.equal(result.data.state, "researching");
  }
});

test("each explicit action gets a new key; recheck sends basedOnRunId", async () => {
  const { calls, fetchImpl } = recorder(() => json(envelope(), 202));
  const client = createKapilotoClient({ fetch: fetchImpl });

  await client.consultFixture(REF);
  await client.recheckFixture({ ...REF, basedOnRunId: RUN_1 });

  const keys = calls.map((call) => call.headers.get("idempotency-key"));
  assert.equal(new Set(keys).size, 2);
  assert.deepEqual(JSON.parse(calls[1].body ?? "").intent, "recheck");
  assert.deepEqual(JSON.parse(calls[1].body ?? "").basedOnRunId, RUN_1);
  assert.ok(!calls[1].body?.includes("refreshEligible"));
});

test("network retry of the same action reuses the same idempotency key", async () => {
  const { calls, fetchImpl } = recorder((_call, index) => {
    if (index < 2) throw new TypeError("Failed to fetch");
    return json(envelope(), 202);
  });
  const client = createKapilotoClient({ fetch: fetchImpl, sleep: noSleep });

  const result = await client.consultFixture(REF);

  assert.equal(result.kind, "ok");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.method === "POST"));
  assert.equal(
    new Set(calls.map((call) => call.headers.get("idempotency-key"))).size,
    1,
  );
});

test("exhausted network retries surface network_error with the key for manual replay", async () => {
  const { calls, fetchImpl } = recorder(() => {
    throw new TypeError("offline");
  });
  const client = createKapilotoClient({
    fetch: fetchImpl,
    sleep: noSleep,
    maxNetworkRetries: 1,
  });

  const result = await client.consultFixture(REF);
  assert.equal(result.kind, "network_error");
  assert.equal(calls.length, 2);

  await client.consultFixture(REF, { idempotencyKey: result.idempotencyKey });
  assert.equal(calls[2].headers.get("idempotency-key"), result.idempotencyKey);
});

test("HTTP failures are surfaced distinctly", async () => {
  const cases: Array<[number, string, Record<string, string>]> = [
    [400, "invalid_request", {}],
    [401, "unauthorized", {}],
    [403, "forbidden", {}],
    [404, "not_found", {}],
    [422, "idempotency_conflict", {}],
    [429, "rate_limited", { "retry-after": "20" }],
    [503, "unavailable", { "retry-after": "5" }],
  ];

  for (const [status, kind, headers] of cases) {
    const { fetchImpl } = recorder(() =>
      json({ error: { code: "x", message: "m" } }, status, headers),
    );
    const client = createKapilotoClient({ fetch: fetchImpl });
    const result = await client.consultFixture(REF);
    assert.equal(result.kind, kind, `status ${status}`);
    if (result.kind === "rate_limited") assert.equal(result.retryAfterSeconds, 20);
    if (result.kind === "unavailable") assert.equal(result.retryAfterSeconds, 5);
  }
});

test("aborted requests return aborted and are not retried", async () => {
  const { calls, fetchImpl } = recorder(() => json(envelope(), 202));
  const client = createKapilotoClient({ fetch: fetchImpl, sleep: noSleep });
  const controller = new AbortController();
  controller.abort();

  const result = await client.consultFixture(REF, { signal: controller.signal });
  assert.equal(result.kind, "aborted");
  assert.equal(calls.length, 1);
});

test("getFixtureAnalysis is a GET with group_id and maps 304 to not_modified", async () => {
  const { calls, fetchImpl } = recorder((call) =>
    call.headers.get("if-none-match")
      ? new Response(null, { status: 304, headers: { etag: 'W/"a"' } })
      : json(envelope({ state: "unresearched" }), 200, { etag: 'W/"a"' }),
  );
  const client = createKapilotoClient({ fetch: fetchImpl });

  const first = await client.getFixtureAnalysis(REF);
  assert.equal(first.kind, "ok");
  if (first.kind === "ok") assert.equal(first.etag, 'W/"a"');

  const second = await client.getFixtureAnalysis(REF, { etag: 'W/"a"' });
  assert.equal(second.kind, "not_modified");

  assert.ok(calls.every((call) => call.method === "GET"));
  assert.equal(
    calls[0].url,
    `/api/v1/rounds/${REF.roundId}/kapiloto/fixtures/${REF.roundGameId}?group_id=${REF.groupId}`,
  );
  assert.equal(calls[1].headers.get("if-none-match"), 'W/"a"');
});

test("polling uses GET only, respects Retry-After and stops when the current run changes", async () => {
  let statePolls = 0;
  const { calls, fetchImpl } = recorder((call) => {
    if (call.url.includes("/state")) {
      statePolls += 1;
      if (statePolls < 3) {
        return json(roundState({ active_run_id: RUN_1 }), 200, {
          "retry-after": statePolls === 1 ? "7" : "2",
        });
      }
      return json(roundState({ current_run_id: RUN_1 }));
    }
    return json(
      envelope({
        state: "ready",
        research: { ...envelope().research, active_run_id: null, current_run_id: RUN_1 },
        poll: null,
      }),
    );
  });
  const client = createKapilotoClient({ fetch: fetchImpl });
  const sleeps: number[] = [];

  const outcome = await pollFixtureResearch(client, REF, {
    baselineCurrentRunId: null,
    initialRetryAfterSeconds: 3,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(outcome.kind, "published");
  assert.deepEqual(sleeps, [3000, 7000, 2000]);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.ok(calls.every((call) => !call.headers.has("idempotency-key")));
  assert.equal(calls.filter((call) => call.url.includes("/state")).length, 3);
  assert.equal(calls.filter((call) => call.url.includes("/fixtures/")).length, 1);
});

test("polling reports a run that ended without publishing", async () => {
  const { fetchImpl } = recorder((call) =>
    call.url.includes("/state")
      ? json(roundState({}))
      : json(envelope({ state: "unresearched", research: { ...envelope().research, active_run_id: null } })),
  );
  const client = createKapilotoClient({ fetch: fetchImpl });

  const outcome = await pollFixtureResearch(client, REF, {
    baselineCurrentRunId: null,
    sleep: noSleep,
  });
  assert.equal(outcome.kind, "ended_without_publish");
});

test("polling stops on abort and backs off on 429 using Retry-After", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  const { calls, fetchImpl } = recorder((_call, index) => {
    if (index === 1) controller.abort();
    return json({ error: { code: "rate_limited", message: "" } }, 429, {
      "retry-after": "12",
    });
  });
  const client = createKapilotoClient({ fetch: fetchImpl });

  const outcome = await pollFixtureResearch(client, REF, {
    baselineCurrentRunId: null,
    signal: controller.signal,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      await noSleep(ms, signal);
    },
  });

  assert.equal(outcome.kind, "aborted");
  assert.equal(sleeps[1], 12_000);
  assert.ok(calls.length <= 2);
  assert.ok(calls.every((call) => call.method === "GET"));
});


test("group-neutral Match Intelligence requests omit group query context", async () => {
  const neutralRef = { ...REF, groupId: null };
  const { calls, fetchImpl } = recorder((call) =>
    call.method === "POST"
      ? json(
          envelope({
            group: { max_doubles: 0, locked: false },
            request: {
              outcome: "created_run",
              replayed: false,
              request_id: null,
            },
          }),
          202,
        )
      : call.url.includes("/state")
        ? json(roundState({}))
        : json(
            envelope({
              state: "unresearched",
              group: { max_doubles: 0, locked: false },
            }),
          ),
  );
  const client = createKapilotoClient({ fetch: fetchImpl });

  await client.consultFixture(neutralRef);
  await client.getFixtureAnalysis(neutralRef);
  await client.getRoundResearchState({
    roundId: neutralRef.roundId,
    groupId: null,
  });

  assert.deepEqual(JSON.parse(calls[0].body ?? ""), {
    groupId: null,
    roundGameId: neutralRef.roundGameId,
    intent: "consult",
    basedOnRunId: null,
  });
  assert.equal(
    calls[1].url,
    `/api/v1/rounds/${neutralRef.roundId}/kapiloto/fixtures/${neutralRef.roundGameId}`,
  );
  assert.equal(
    calls[2].url,
    `/api/v1/rounds/${neutralRef.roundId}/kapiloto/state`,
  );
});
