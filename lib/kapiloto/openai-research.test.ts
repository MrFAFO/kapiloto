import assert from "node:assert/strict";
import test from "node:test";

import { __testOnly } from "./openai-research";

test("extracts all web-search sources and counts tool calls", () => {
  const response = {
    output: [
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
      {
        type: "web_search_call",
        action: {
          type: "open_page",
          url: "https://c.example/page",
        },
      },
      {
        type: "message",
        content: [{ type: "output_text", text: "{}" }],
      },
    ],
  };

  assert.deepEqual(__testOnly.extractSourceUrls(response), [
    "https://a.example/news",
    "https://b.example/news",
    "https://c.example/page",
  ]);
  assert.equal(__testOnly.countWebSearchCalls(response), 2);
});

test("detects structured refusals", () => {
  assert.equal(
    __testOnly.hasRefusal({
      output: [
        {
          type: "message",
          content: [{ type: "refusal", refusal: "cannot comply" }],
        },
      ],
    }),
    true,
  );
});

test("extracts token provenance defensively", () => {
  assert.deepEqual(
    __testOnly.usageFromResponse({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 25 },
        output_tokens_details: { reasoning_tokens: 10 },
      },
    }),
    {
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 50,
      reasoningTokens: 10,
      totalTokens: 150,
    },
  );
});
