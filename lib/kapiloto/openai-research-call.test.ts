import assert from "node:assert/strict";
import test from "node:test";

import OpenAI from "openai";

import type { KapilotoFixtureCard } from "./fixture-card";
import {
  classifyOpenAICallError,
  KAPILOTO_SOL_DEFAULT_MAX_OUTPUT_TOKENS,
  researchFixtureWithSol,
  SolFixtureResearchError,
} from "./openai-research";

const card: KapilotoFixtureCard = {
  fixture_card_version: "kapiloto-fixture-card-v2",
  fixture_key: "fixture-1",
  fixture_id: "fixture-1",
  round_game_id: "game-1",
  toto_number: 1,
  settlement: "result_after_90_minutes_including_stoppage_time",
  orientation: { "1": "home", "2": "away" },
  teams: {
    home: { id: "home", names: ["Home"] },
    away: { id: "away", names: ["Away"] },
  },
  competition: {
    id: "league",
    name: "League",
    stage: null,
    leg: null,
    aggregate: null,
  },
  kickoff_at: "2026-10-20T18:00:00.000Z",
  neutral_venue: false,
  research_cutoff_at: "2026-10-18T12:00:00.000Z",
  structured: {
    table_snapshot_id: null,
    recent_matches: [],
    squad_snapshot_id: null,
    coach: null,
    prior: {
      type: "market",
      snapshot_id: "market",
      captured_at: "2026-10-18T11:00:00.000Z",
      p_home_bp: 4000,
      p_draw_bp: 3000,
      p_away_bp: 3000,
    },
  },
};

type Captured = { body: Record<string, unknown>; options: Record<string, unknown> };

function fakeClient(response: Record<string, unknown>, captured: Captured[] = []) {
  return {
    responses: {
      async create(body: Record<string, unknown>, options: Record<string, unknown>) {
        captured.push({ body, options });
        return response;
      },
    },
  } as unknown as OpenAI;
}

const searchOutput = [
  {
    type: "web_search_call",
    action: {
      type: "search",
      sources: [
        { type: "url", url: "https://a.example/news" },
        { type: "url", url: "https://b.example/news" },
      ],
    },
  },
  { type: "web_search_call", action: { type: "open_page", url: "https://a.example/news" } },
];

const usage = {
  input_tokens: 41_000,
  output_tokens: 8_000,
  total_tokens: 49_000,
  input_tokens_details: { cached_tokens: 3_000 },
  output_tokens_details: { reasoning_tokens: 7_400 },
};

async function captureError(promise: Promise<unknown>): Promise<SolFixtureResearchError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SolFixtureResearchError);
    return error;
  }
  throw new Error("expected SolFixtureResearchError");
}

test("an incomplete Sol response keeps billable provenance and is capacity-limited", async () => {
  const error = await captureError(
    researchFixtureWithSol(
      fakeClient({
        id: "resp_incomplete",
        model: "gpt-6.1-sol-2026-10-01",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: searchOutput,
        output_text: "",
        usage,
      }),
      card,
      { model: "gpt-6.1-sol" },
    ),
  );

  assert.equal(error.failureClass, "provider_transient");
  assert.equal(error.code, "sol_incomplete:max_output_tokens");
  assert.equal(error.capacityLimited, true);
  assert.equal(error.retryable, true);
  assert.match(error.message, /incomplete \(max_output_tokens\)/);
  assert.deepEqual(error.provenance, {
    responseId: "resp_incomplete",
    model: "gpt-6.1-sol-2026-10-01",
    sourceUrls: ["https://a.example/news", "https://b.example/news"],
    webSearchCalls: 2,
    usage: {
      inputTokens: 41_000,
      cachedInputTokens: 3_000,
      outputTokens: 8_000,
      reasoningTokens: 7_400,
      totalTokens: 49_000,
    },
  });
});

test("content-filter incompletes are terminal refusals with provenance", async () => {
  const error = await captureError(
    researchFixtureWithSol(
      fakeClient({
        id: "resp_filtered",
        model: "sol",
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        output: [],
        output_text: "",
        usage,
      }),
      card,
      { model: "sol" },
    ),
  );

  assert.equal(error.failureClass, "model_refusal");
  assert.equal(error.retryable, false);
  assert.equal(error.provenance?.responseId, "resp_filtered");
});

test("semantic validation failures are model_output_invalid with provenance", async () => {
  const invalid = { protocol_version: "kapiloto-research-v1", fixture_key: "other" };
  const error = await captureError(
    researchFixtureWithSol(
      fakeClient({
        id: "resp_invalid",
        model: "sol",
        status: "completed",
        output: searchOutput,
        output_text: JSON.stringify(invalid),
        usage,
      }),
      card,
      { model: "sol" },
    ),
  );

  assert.equal(error.failureClass, "model_output_invalid");
  assert.equal(error.code, "sol_semantic_validation_failed");
  assert.match(error.message, /failed semantic validation/);
  assert.equal(error.provenance?.responseId, "resp_invalid");
  assert.equal(error.provenance?.usage.reasoningTokens, 7_400);
});

test("research request disables SDK retries, applies the deadline and output budget", async () => {
  const captured: Captured[] = [];
  await captureError(
    researchFixtureWithSol(
      fakeClient(
        {
          id: "resp",
          model: "sol",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
          output_text: "",
          usage,
        },
        captured,
      ),
      card,
      { model: "sol", reasoningEffort: "medium", timeoutMs: 175_000 },
    ),
  );

  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.max_output_tokens, KAPILOTO_SOL_DEFAULT_MAX_OUTPUT_TOKENS);
  assert.ok(KAPILOTO_SOL_DEFAULT_MAX_OUTPUT_TOKENS >= 25_000);
  assert.deepEqual(captured[0].body.reasoning, { effort: "medium" });
  assert.deepEqual(captured[0].options, { maxRetries: 0, timeout: 175_000 });
});

test("SDK timeouts become capacity-limited deadline failures", () => {
  const error = classifyOpenAICallError(
    new OpenAI.APIConnectionTimeoutError({ message: "Request timed out." }),
  );
  assert.equal(error.code, "sol_deadline_exceeded");
  assert.equal(error.failureClass, "provider_transient");
  assert.equal(error.capacityLimited, true);
  assert.equal(error.retryable, true);
});

test("client errors such as an unsupported schema keyword fail fast", () => {
  const badRequest = OpenAI.APIError.generate(
    400,
    { error: { message: "Invalid schema: 'maxLength' is not permitted." } },
    "Invalid schema",
    new Headers(),
  );
  const error = classifyOpenAICallError(badRequest);
  assert.equal(error.failureClass, "internal");
  assert.equal(error.code, "openai_bad_request");
  assert.equal(error.retryable, false);

  const unauthorized = classifyOpenAICallError(
    OpenAI.APIError.generate(401, undefined, "bad key", new Headers()),
  );
  assert.equal(unauthorized.retryable, false);
  assert.equal(unauthorized.code, "openai_configuration_error");
});

test("rate limits and server errors stay retryable transient failures", () => {
  const limited = classifyOpenAICallError(
    OpenAI.APIError.generate(429, undefined, "slow down", new Headers()),
  );
  assert.equal(limited.code, "openai_rate_limited");
  assert.equal(limited.retryable, true);
  assert.equal(limited.capacityLimited, false);

  const server = classifyOpenAICallError(
    OpenAI.APIError.generate(503, undefined, "unavailable", new Headers()),
  );
  assert.equal(server.code, "openai_server_error");
  assert.equal(server.retryable, true);
});
