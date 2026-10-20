import assert from "node:assert/strict";
import test from "node:test";

import { createTicketClient } from "./ticket-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("loads a ticket snapshot with group query", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createTicketClient({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        ticketId: null,
        state: null,
        revision: 0,
        submittedAt: null,
        maxDoubles: 7,
        picks: [],
      });
    },
  });

  const result = await client.load("round-1", "group-1");

  assert.equal(result.revision, 0);
  assert.equal(calls[0].url, "/api/v1/rounds/round-1/ticket?groupId=group-1");
  assert.equal(calls[0].init?.method, "GET");
});

test("saves the full editable draft with optimistic revision", async () => {
  let requestBody: unknown;
  const client = createTicketClient({
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({
        ticketId: "ticket-1",
        state: "draft",
        revision: 3,
        pickCount: 1,
        doublesUsed: 0,
        maxDoubles: 7,
        submittedAt: null,
      });
    },
  });

  const result = await client.saveDraft({
    roundId: "round-1",
    groupId: "group-1",
    expectedRevision: 2,
    picks: [{ roundGameId: "game-1", pick: "1" }],
  });

  assert.equal(result.revision, 3);
  assert.deepEqual(requestBody, {
    groupId: "group-1",
    expectedRevision: 2,
    picks: [{ roundGameId: "game-1", pick: "1" }],
  });
});

test("submits by revision and surfaces structured conflicts", async () => {
  const client = createTicketClient({
    fetch: async () =>
      jsonResponse(
        {
          error: {
            code: "revision_conflict",
            message: "The ticket changed on another device.",
          },
        },
        409,
      ),
  });

  await assert.rejects(
    () =>
      client.submit({
        roundId: "round-1",
        groupId: "group-1",
        expectedRevision: 4,
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { status?: number; code?: string }).status === 409 &&
      (error as Error & { code?: string }).code === "revision_conflict",
  );
});
