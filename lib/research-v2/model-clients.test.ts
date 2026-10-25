import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { callCost, CANDIDATE_PRICING, CostLedger, tokenCost, tokenCostMicros, type PricingConfig } from "./cost-ledger";
import { strictSchemaViolations, type DiscoveryClaim } from "./discovery-contract";
import { buildDiscoveryInput, buildDiscoveryRequest, CANDIDATE_DISCOVERY_REQUEST, discoveryInputProblems, observedUrls, runDiscoveryCall, type DiscoveryInputV1 } from "./discovery-client";
import { buildDiscoveryPlan } from "./discovery-plan";
import { buildEntailmentPayload, CANDIDATE_ENTAILMENT_REQUEST, ENTAILMENT_CONTRACT_VERSION, ENTAILMENT_INSTRUCTIONS, ENTAILMENT_OUTPUT_SCHEMA, runEntailmentCall, type EntailmentFixtureSides, type EntailmentItem } from "./entailment-client";
import { buildEvidenceWindow, locateQuote } from "./evidence-window";
import { classifyCallError, redactSecrets, type ResponsesClient } from "./model-call";
import { findForbiddenModelKeys, forbiddenModelFields } from "./model-output-guards";
import { CANDIDATE_SPEND_GUARD, checkSpend, projectCallMicros } from "./spend-guard";
import { assignTriage, CANDIDATE_TRIAGE_CONFIG, type TriageContext, type TriageFeatures } from "./triage";

// ---- fixtures: Hull v Brentford plan (minimal tier), synthetic Responses payloads ----

const context: TriageContext = {
  managerChange: { home: { status: "unknown" }, away: { status: "unknown" } },
  restDays: { home: 8, away: 8 },
  matchesLast14Days: { home: 1, away: 1 },
  competition: { isCup: false, isSecondLeg: false },
  unresolvedAvailability: null,
};
const features: TriageFeatures = {
  fixtureId: "fixture-7", marketQuality: "standard", statArm: "p_stat_elo_v1", statAvailable: true, disagreementBp: 2092,
  statTeamMatches: { home: 7, away: 83 }, managerChangeDaysAgo: null, minRestDays: 8, maxMatchesLast14Days: 1, neutralVenue: false,
  isCup: false, isSecondLeg: false, newToCompetition: { home: true, away: false }, unresolvedAvailability: null,
  dataGaps: ["availability_unassessed", "manager_change_unknown:away", "manager_change_unknown:home"],
};
const PLAN = buildDiscoveryPlan({
  fixtureRef: "fx-7", triage: assignTriage(features, CANDIDATE_TRIAGE_CONFIG), triageConfig: CANDIDATE_TRIAGE_CONFIG, context,
  competitionKey: "sportmonks:8", competitionName: "Premier League", names: { home: "Hull City", away: "Brentford" },
});
const INPUT: DiscoveryInputV1 = buildDiscoveryInput({
  plan: PLAN, names: { home: { en: "Hull City", source: ["האל"] }, away: { en: "Brentford", source: ["ברנטפורד"] } },
  competition: "Premier League", kickoffAt: "2026-10-25T14:00:00Z", knowledgeCutoffAt: "2026-10-25T08:00:00Z",
  restDays: context.restDays, matchesLast14Days: context.matchesLast14Days, structuredAbsences: [],
  newToCompetition: { home: true, away: false }, statColdStartSides: ["home"],
});

const usage = (input: number, cached: number, output: number) => ({
  input_tokens: input, input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
  output_tokens: output, output_tokens_details: { reasoning_tokens: 200 }, total_tokens: input + output,
});
const search = (id: string, queries: string[], sources: string[]) => ({ type: "web_search_call", id, status: "completed", action: { type: "search", queries, sources: sources.map((url) => ({ type: "url", url })) } });
const openPage = (id: string, url: string) => ({ type: "web_search_call", id, status: "completed", action: { type: "open_page", url } });
const findInPage = (id: string, url: string, pattern: string) => ({ type: "web_search_call", id, status: "completed", action: { type: "find_in_page", url, pattern } });
const message = (text: string, annotations: unknown[] = []) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations }] });
const payload = (output: unknown[], extra: Record<string, unknown> = {}) => ({ id: "resp_1", model: "gpt-6.1-sol-2026-10-01", status: "completed", output, usage: usage(20_000, 2_000, 1_500), ...extra });

function claim(overrides: Partial<DiscoveryClaim> = {}): DiscoveryClaim {
  return {
    claim_id: "C1", need_id: "availability_rotation_check:home", claim_kind: "absence", side: "home",
    subject: { type: "player", name_in_source: "John Keeper", name_normalized_en: "John Keeper", role: "goalkeeper", squad_status_claimed: "first_choice", squad_status_quote: null, named_players: [] },
    claim: "John Keeper is ruled out of Sunday's match.", stated_status: "confirmed", applies_to_this_fixture: true, event_time: null,
    observation: "reported", extraction_confidence: "high", corroboration_claimed: false,
    citations: [{ url: "https://www.hulldailymail.co.uk/sport/a", quote: "Keeper will miss Sunday", publisher_claimed: "Hull Live", author_claimed: null, published_at_claimed: null }],
    ...overrides,
  };
}
const discoveryText = (claims: DiscoveryClaim[] = [claim()], fixtureRef = "fx-7", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ contract_version: "kapiloto-research-v2-discovery-v2", fixture_ref: fixtureRef, needs_addressed: [{ need_id: "availability_rotation_check:home", status: "found" }], claims, ...extra });

/** A fake Responses client returning recorded payloads (or throwing) in order, recording every request. */
function fakeClient(...replies: Array<unknown | Error>): ResponsesClient & { requests: Array<{ body: Record<string, unknown>; options: unknown }> } {
  const requests: Array<{ body: Record<string, unknown>; options: unknown }> = [];
  return {
    requests,
    responses: {
      async create(body, options) {
        requests.push({ body, options });
        const reply = replies[requests.length - 1];
        if (reply instanceof Error) throw reply;
        if (reply === undefined) throw new Error("unexpected extra call");
        return reply;
      },
    },
  };
}
const clock = () => {
  let t = 1_000;
  return () => (t += 250);
};

// ---- discovery ------------------------------------------------------------------

test("the discovery request is web_search only, required, strictly structured and budgeted", () => {
  const { body, record } = buildDiscoveryRequest(INPUT, PLAN);
  assert.deepEqual(body.tools, [{ type: "web_search", search_context_size: "low" }]);
  assert.equal(body.tool_choice, "required");
  assert.deepEqual(body.include, ["web_search_call.action.sources"]);
  assert.equal(body.max_tool_calls, PLAN.budget.maxWebToolCalls);
  assert.equal(body.max_output_tokens, PLAN.budget.maxOutputTokens);
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.equal(body.store, false);
  const format = (body.text as { format: { type: string; strict: boolean; schema: unknown } }).format;
  assert.deepEqual([format.type, format.strict], ["json_schema", true]);
  assert.deepEqual(strictSchemaViolations(format.schema), []);
  assert.equal(record.model, "gpt-6.1-sol");
  for (const hash of [record.payloadSha256, record.schemaSha256, record.instructionsSha256]) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(discoveryInputProblems(INPUT), []);
  const sent = JSON.parse(body.input as string);
  assert.deepEqual(Object.keys(sent).sort(), ["away", "budget", "competition", "fixture_ref", "home", "input_version", "kickoff_at", "knowledge_cutoff_at", "known_facts", "languages", "needs"]);
  assert.equal(sent.known_facts.rest_days, null, "rest days only go out with a congestion need");
  assert.deepEqual(sent.known_facts.stat_cold_start_sides, ["home"]);
  assert.doesNotMatch(body.input as string, /prob|odds|_bp|elo|rating|score|disagreement/i);
});

test("a valid discovery response records actions, queries, sources, citations, usage, latency and cost", async () => {
  const client = fakeClient(
    payload([
      search("ws_1", ["Hull City team news"], ["https://www.hulldailymail.co.uk/sport/a", "https://www.skysports.com/b"]),
      search("ws_2", ["Brentford injury news"], ["https://www.skysports.com/b", "https://www.brentfordfc.com/c"]),
      openPage("ws_3", "https://www.hulldailymail.co.uk/sport/a"),
      findInPage("ws_4", "https://www.hulldailymail.co.uk/sport/a", "Keeper"),
      message(discoveryText(), [{ type: "url_citation", url: "https://www.hulldailymail.co.uk/sport/a", title: "Team news", start_index: 0, end_index: 10 }]),
    ]),
  );
  const ledger = new CostLedger();
  const result = await runDiscoveryCall({ client, discoveryInput: INPUT, plan: PLAN, ledger, now: clock() });
  assert.equal(result.status, "ok");
  assert.deepEqual(client.requests[0].options, { maxRetries: 0, timeout: 180_000 });
  assert.deepEqual([result.webSearch.searchActions, result.webSearch.openPageActions, result.webSearch.findInPageActions, result.webSearch.billableCalls], [2, 1, 1, 4]);
  assert.deepEqual(result.webSearch.queries, ["Hull City team news", "Brentford injury news"]);
  assert.deepEqual(observedUrls(result), ["https://www.hulldailymail.co.uk/sport/a", "https://www.skysports.com/b", "https://www.brentfordfc.com/c"]);
  assert.equal(result.citations[0].url, "https://www.hulldailymail.co.uk/sport/a");
  assert.deepEqual([result.response?.id, result.response?.model, result.response?.latencyMs, result.response?.usageStatus], ["resp_1", "gpt-6.1-sol-2026-10-01", 250, "complete"]);
  assert.equal(result.parse?.status, "accepted");
  // Billing uses the 4 recorded tool calls, not the target of 2 searches.
  const tokens = tokenCostMicros({ inputTokens: 20_000, cachedInputTokens: 2_000, outputTokens: 1_500, reasoningTokens: 200, cacheWriteTokens: 0 }, CANDIDATE_PRICING.sol)!;
  assert.equal(tokens, 51_200); // 18k × $2/M + 2k × $0.10/M + 1.5k × $10/M
  assert.equal(result.cost?.webSearchFeeMicros, 4 * 10_000);
  assert.equal(ledger.chargedMicros("fx-7"), tokens + 40_000);
});

test("no search action is search_not_executed (recorded and charged, no retry inside the client)", async () => {
  const client = fakeClient(payload([message(discoveryText())]));
  const ledger = new CostLedger();
  const result = await runDiscoveryCall({ client, discoveryInput: INPUT, plan: PLAN, ledger });
  assert.deepEqual([result.status, result.failure], ["failed", "search_not_executed"]);
  assert.equal(client.requests.length, 1);
  assert.equal(result.webSearch.billableCalls, 0);
  assert.equal(result.cost?.webSearchFeeMicros, 0);
  assert.ok(ledger.chargedMicros() > 0, "tokens are still charged");
});

test("using every allowed tool call is recorded and billed in full", async () => {
  const calls = Array.from({ length: PLAN.budget.maxWebToolCalls }, (_, i) => search(`ws_${i}`, [`q${i}`], [`https://www.skysports.com/${i}`]));
  const result = await runDiscoveryCall({ client: fakeClient(payload([...calls, message(discoveryText())])), discoveryInput: INPUT, plan: PLAN, ledger: new CostLedger() });
  assert.equal(result.request?.maxToolCalls, 6);
  assert.equal(result.webSearch.billableCalls, 6);
  assert.equal(result.cost?.webSearchFeeMicros, 60_000);
});

test("malformed, schema-invalid, forecast-keyed, wrong-fixture, refused and incomplete outputs fail explicitly", async () => {
  const run = async (reply: unknown) => runDiscoveryCall({ client: fakeClient(reply), discoveryInput: INPUT, plan: PLAN, ledger: new CostLedger() });
  const searched = (text: string, extra: Record<string, unknown> = {}) => payload([search("ws_1", ["q"], ["https://a.example"]), message(text)], extra);
  assert.equal((await run(searched("{not json"))).failure, "malformed_output");
  assert.equal((await run(searched(discoveryText([claim()], "fx-7", { notes: "x" })))).failure, "schema_invalid");
  assert.equal((await run(searched(discoveryText([{ ...claim(), impact_class: "major" } as unknown as DiscoveryClaim])))).failure, "forecast_field_in_output");
  assert.equal((await run(searched(discoveryText([claim()], "fx-8")))).failure, "fixture_ref_mismatch");
  const refused = await run(payload([{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that." }] }]));
  assert.equal(refused.failure, "refusal");
  assert.ok(refused.cost, "a refused call is still recorded for cost");
  assert.equal((await run(searched(discoveryText(), { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))).failure, "incomplete");
});

test("forecast language in a claim rejects that claim only", async () => {
  const text = discoveryText([claim(), claim({ claim_id: "C2", claim: "Keeper out, so Brentford are favourites." })]);
  const result = await runDiscoveryCall({ client: fakeClient(payload([search("ws_1", ["q"], ["https://a.example"]), message(text)])), discoveryInput: INPUT, plan: PLAN, ledger: new CostLedger() });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.parse?.status === "accepted" && result.parse.claims.map((c) => [c.claim.claim_id, c.status, c.rejections]), [["C1", "admitted", []], ["C2", "rejected", ["forecast_language_in_claim"]]]);
});

test("unsafe input, API errors and timeouts never reach a parse; timeouts are charged at the projection", async () => {
  const unsafe: DiscoveryInputV1 = { ...INPUT, needs: [{ ...INPUT.needs[0], search_hints: ["best odds for Hull"] }] };
  const unsafeClient = fakeClient();
  const blocked = await runDiscoveryCall({ client: unsafeClient, discoveryInput: unsafe, plan: PLAN, ledger: new CostLedger() });
  assert.deepEqual([blocked.failure, unsafeClient.requests.length], ["unsafe_input", 0]);
  const withKey = { ...INPUT, known_facts: { ...INPUT.known_facts, home_win_prob: 0.4 } } as unknown as DiscoveryInputV1;
  assert.ok(discoveryInputProblems(withKey).some((problem) => problem.includes("home_win_prob")));

  const timeout = Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
  const ledger = new CostLedger();
  const timedOut = await runDiscoveryCall({ client: fakeClient(timeout), discoveryInput: INPUT, plan: PLAN, ledger });
  assert.equal(timedOut.failure, "timeout");
  assert.equal(timedOut.cost?.usageStatus, "missing");
  assert.equal(ledger.chargedMicros(), projectCallMicros({ kind: "discovery", fixtureRef: "fx-7", maxToolCalls: 6, maxOutputTokens: 8_000 }, CANDIDATE_PRICING), "an unknown-outcome call is charged its projection, never zero");
  const rejected = Object.assign(new Error("Bad request"), { name: "BadRequestError", status: 400 });
  const rejectedLedger = new CostLedger();
  const apiError = await runDiscoveryCall({ client: fakeClient(rejected), discoveryInput: INPUT, plan: PLAN, ledger: rejectedLedger });
  assert.equal(apiError.failure, "api_error");
  assert.equal(rejectedLedger.chargedMicros(), 0, "a request rejected with a 4xx is not charged");
  assert.match(apiError.detail ?? "", /BadRequestError 400/);
});

test("key-like fragments in provider error text are redacted before they reach the call record", async () => {
  const FULL_KEY = `sk-proj-${"Ab3dEf7hIj".repeat(5)}Wxyz`;
  const SPORTMONKS_TOKEN = "Q7m2Lk9pX4vB8nR1tY6uZ3wE5aS0dF2gH4jK7lP9oI1uY3tR5eW7qA9sD2fG4h";
  const APISPORTS_KEY = "3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e";
  const cases: Array<[string, string[]]> = [
    // OpenAI's 401 message, masked and unmasked.
    ["Incorrect API key provided: sk-proj-Ab3d********************************Wxyz. You can find your API key at https://platform.openai.com/account/api-keys.", ["sk-proj", "Ab3d", "Wxyz"]],
    [`Incorrect API key provided: ${FULL_KEY}.`, [FULL_KEY, "Wxyz"]],
    [`Authorization failed for header Bearer ${FULL_KEY}`, [FULL_KEY]],
    [`GET https://api.sportmonks.com/v3/football/fixtures?api_token=${SPORTMONKS_TOKEN}&page=2 failed`, [SPORTMONKS_TOKEN]],
    [`header x-apisports-key: ${APISPORTS_KEY} rejected`, [APISPORTS_KEY]],
    [`{"error":{"message":"bad","apiKey":"${APISPORTS_KEY}"}}`, [APISPORTS_KEY]],
    [`opaque credential ${SPORTMONKS_TOKEN} in text`, [SPORTMONKS_TOKEN]],
    // A key straddling the 300-character limit leaves no fragment behind.
    [`${"x ".repeat(130)}${FULL_KEY}`, ["sk-proj", "Ab3dEf7h"]], // starts at character 285 of the detail
  ];
  for (const [message, secrets] of cases) {
    const error = Object.assign(new Error(message), { name: "AuthenticationError", status: 401 });
    const classified = classifyCallError(error);
    for (const secret of secrets) assert.ok(!classified.detail.includes(secret), `${secret.slice(0, 12)}… leaked from: ${message.slice(0, 60)}`);
    assert.match(classified.detail, /^AuthenticationError 401: /);
    assert.match(classified.detail, /\[redacted/);
    assert.deepEqual([classified.failure, classified.possiblyBilled, classified.status], ["api_error", false, 401]);
  }
  // Useful, non-secret detail survives: status, model names, URLs without credentials, fixture UUIDs.
  const kept = redactSecrets("Model gpt-6.1-sol not found for fixture 35097a2f-7cf8-4282-af3e-651229800099 at https://api.openai.com/v1/responses (task-force risk-free)");
  assert.equal(kept, "Model gpt-6.1-sol not found for fixture 35097a2f-7cf8-4282-af3e-651229800099 at https://api.openai.com/v1/responses (task-force risk-free)");

  // End to end: the stored discovery and Luna failure details carry no key fragment.
  const authError = () => Object.assign(new Error(`Incorrect API key provided: ${FULL_KEY}.`), { name: "AuthenticationError", status: 401 });
  const discovery = await runDiscoveryCall({ client: fakeClient(authError()), discoveryInput: INPUT, plan: PLAN, ledger: new CostLedger() });
  assert.equal(discovery.failure, "api_error");
  assert.ok(!JSON.stringify(discovery).includes(FULL_KEY) && !JSON.stringify(discovery).includes("Wxyz"));
});

test("missing or partial usage is recorded as uncertain and charged at the projection", async () => {
  const ledger = new CostLedger();
  const missing = await runDiscoveryCall({ client: fakeClient(payload([search("ws_1", ["q"], ["https://a.example"]), message(discoveryText())], { usage: null })), discoveryInput: INPUT, plan: PLAN, ledger });
  assert.equal(missing.response?.usageStatus, "missing");
  assert.equal(missing.cost?.tokenCostMicros, null);
  assert.equal(missing.cost?.chargedMicros, 296_000);
  const partialLedger = new CostLedger();
  const partial = await runDiscoveryCall({
    client: fakeClient(payload([search("ws_1", ["q"], ["https://a.example"]), message(discoveryText())], { usage: { input_tokens: 10_000, output_tokens: 500 } })),
    discoveryInput: INPUT, plan: PLAN, ledger: partialLedger,
  });
  assert.equal(partial.response?.usageStatus, "partial");
  assert.equal(partialLedger.snapshot().run.costUncertain, true);
});

// ---- spend guard ----------------------------------------------------------------------

/** A pricing config whose judge model has no known rates (any future, unpriced model). */
const UNPRICED_JUDGE: PricingConfig = { ...CANDIDATE_PRICING, version: "pricing-test-unpriced", luna: null };
const charge = (ledger: CostLedger, fixtureRef: string, micros: number) =>
  ledger.recordCall({ kind: "discovery", fixtureRef, callId: `prior-${fixtureRef}-${micros}`, model: "m", usage: null, usageStatus: "missing", billableWebSearchCalls: 0, webSearchFeeMicros: 0, tokenCostMicros: null, cacheTtl: null, cacheWrites: null, costUncertain: true, knownMicros: 0, chargedMicros: micros });

test("projections are conservative and the caps are inclusive boundaries", () => {
  const minimal = projectCallMicros({ kind: "discovery", fixtureRef: "fx", maxToolCalls: 6, maxOutputTokens: 8_000 }, CANDIDATE_PRICING);
  // (3k + 6 × 12k − 12k cache writes) × $2/M + 12k × $2.50/M (30-minute write, the default TTL) + 8k × $10/M + 6 × $0.01
  assert.equal(minimal, 296_000);
  assert.equal(projectCallMicros({ kind: "discovery", fixtureRef: "fx", maxToolCalls: 10, maxOutputTokens: 10_000 }, CANDIDATE_PRICING), 452_000);
  // A request that selects the 12-hour TTL projects at the 12-hour write rate ($5/M).
  assert.equal(projectCallMicros({ kind: "discovery", fixtureRef: "fx", maxToolCalls: 6, maxOutputTokens: 8_000, cacheTtl: "12h" }, CANDIDATE_PRICING), 326_000);
  // Luna: (1,500 + items × 1,000) × $0.125/M (all input at the 30-minute write rate) + 6,000 × $0.50/M
  assert.equal(projectCallMicros({ kind: "entailment", fixtureRef: "fx", items: 6, maxOutputTokens: 6_000 }, CANDIDATE_PRICING), 3_938);
  assert.equal(projectCallMicros({ kind: "entailment", fixtureRef: "fx", items: 12, maxOutputTokens: 6_000 }, CANDIDATE_PRICING), 4_688);
  assert.equal(projectCallMicros({ kind: "entailment", fixtureRef: "fx", items: 20, maxOutputTokens: 6_000 }, CANDIDATE_PRICING), 5_688);
  assert.equal(projectCallMicros({ kind: "entailment", fixtureRef: "fx", items: 6, maxOutputTokens: 6_000, cacheTtl: "12h" }, CANDIDATE_PRICING), 4_875);
  assert.equal(projectCallMicros({ kind: "entailment", fixtureRef: "fx", items: 6, maxOutputTokens: 6_000 }, UNPRICED_JUDGE), null, "an unpriced model has no projection");
  const exact = new CostLedger();
  charge(exact, "fx", 750_000 - 296_000);
  assert.equal(checkSpend({ kind: "discovery", fixtureRef: "fx", maxToolCalls: 6, maxOutputTokens: 8_000 }, exact).allowed, true, "projection exactly fills the cap");
  charge(exact, "fx", 1);
  assert.equal(checkSpend({ kind: "discovery", fixtureRef: "fx", maxToolCalls: 6, maxOutputTokens: 8_000 }, exact).reason, "fixture_cap_would_be_exceeded");
  const reached = new CostLedger();
  charge(reached, "fx", 750_000);
  assert.equal(checkSpend({ kind: "discovery", fixtureRef: "fx", maxToolCalls: 0, maxOutputTokens: 0 }, reached).reason, "fixture_cap_reached");
  const runReached = new CostLedger();
  for (let i = 0; i < 4; i += 1) charge(runReached, `fx-${i}`, 750_000);
  assert.equal(checkSpend({ kind: "discovery", fixtureRef: "fx-new", maxToolCalls: 6, maxOutputTokens: 8_000 }, runReached).reason, "run_cap_reached");
  assert.equal(CANDIDATE_SPEND_GUARD.perFixtureCapUsd, 0.75);
  assert.equal(CANDIDATE_SPEND_GUARD.runCapUsd, 3);
});

test("a discovery retry blocked by the remaining fixture budget never reaches the network", async () => {
  const ledger = new CostLedger();
  charge(ledger, "fx-7", 500_000); // first attempt already cost $0.50
  const client = fakeClient();
  const retry = await runDiscoveryCall({ client, discoveryInput: INPUT, plan: PLAN, ledger });
  assert.deepEqual([retry.failure, retry.detail, client.requests.length], ["spend_guard_blocked", "fixture_cap_would_be_exceeded", 0]);
});

// ---- entailment ---------------------------------------------------------------------

const WINDOW_TEXT = "Team news. The manager confirmed John Keeper will miss Sunday with a knee injury. More text.";
const windowFor = (quote: string) => buildEvidenceWindow(WINDOW_TEXT, locateQuote(WINDOW_TEXT, quote)!);
/** The fixture sides Luna receives for side resolution (the discovery input's team names). */
const SIDES: EntailmentFixtureSides = { home: INPUT.home, away: INPUT.away };
const ITEMS: EntailmentItem[] = ["C1#0", "C2#0", "C3#0"].map((itemId) => ({ itemId, claim: claim({ claim_id: itemId.split("#")[0] }), window: windowFor("John Keeper will miss Sunday") }));
const judged = (itemId: string, verdict: "entailed" | "contradicted" | "not_enough_info", span: string | null, extra: Record<string, unknown> = {}) => ({
  item_id: itemId,
  verdicts: { claim_kind: verdict, side: "entailed", subject: "entailed", stated_status: "entailed", applies_to_fixture: "entailed" },
  support_span: span,
  attribution: { reporting: "primary", direct_quote: false, cited_origin: { type: "press_conference", name: null, date: "2026-10-24" } },
  squad_status_supported: true,
  named_players_supported: [],
  ...extra,
});
const lunaText = (items: unknown[], fixtureRef = "fx-7") => JSON.stringify({ contract_version: ENTAILMENT_CONTRACT_VERSION, fixture_ref: fixtureRef, items });
const lunaPayload = (text: string, extra: Record<string, unknown> = {}) => ({ id: "resp_l1", model: "gpt-6-luna-2026-09-15", status: "completed", output: [message(text)], usage: usage(4_000, 0, 900), ...extra });

test("the Luna request has no tools, medium reasoning, 6,000 output tokens and windows as untrusted data", async () => {
  const client = fakeClient(lunaPayload(lunaText([judged("C1#0", "entailed", "John Keeper will miss Sunday"), judged("C2#0", "entailed", "knee injury"), judged("C3#0", "entailed", "will miss")])));
  const result = await runEntailmentCall({ client, fixtureRef: "fx-7", fixture: SIDES, items: ITEMS, maxJudgeItems: 6, ledger: new CostLedger() });
  assert.equal(result.status, "ok");
  const body = client.requests[0].body;
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
  assert.deepEqual([body.model, body.max_output_tokens, body.store], ["gpt-6-luna", 6_000, false]);
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.match(String(body.instructions), /untrusted text/);
  const sent = JSON.parse(String(body.input));
  assert.deepEqual(Object.keys(sent.items[0]).sort(), ["claim", "evidence", "item_id"]);
  assert.deepEqual(Object.keys(sent.items[0].evidence).sort(), ["untrusted_window_text", "window_sha256"]);
  assert.doesNotMatch(String(body.input), /https?:\/\//, "no URL, grade or market data goes to the judge");
  assert.deepEqual(strictSchemaViolations(ENTAILMENT_OUTPUT_SCHEMA), []);
  assert.deepEqual(forbiddenModelFields(ENTAILMENT_OUTPUT_SCHEMA), []);
  assert.deepEqual(result.items.map((item) => item.input.verdict), ["entailed", "entailed", "entailed"]);
  assert.deepEqual(result.items[0].input.attribution.citedOrigin, { type: "press_conference", name: null, date: "2026-10-24" });
});

test("contradicted, not-enough-info, invalid spans, missing and unknown items are never entailed", async () => {
  const client = fakeClient(lunaPayload(lunaText([
    judged("C1#0", "contradicted", "John Keeper will miss Sunday"),
    judged("C2#0", "not_enough_info", null),
    judged("C3#0", "entailed", "John Keeper is fit"),
    judged("C9#9", "entailed", "will miss"),
  ])));
  const result = await runEntailmentCall({ client, fixtureRef: "fx-7", fixture: SIDES, items: [...ITEMS, { ...ITEMS[0], itemId: "C4#0" }], maxJudgeItems: 6, ledger: new CostLedger() });
  const byId = Object.fromEntries(result.items.map((item) => [item.itemId, item]));
  assert.equal(byId["C1#0"].input.verdict, "contradicted");
  assert.equal(byId["C2#0"].input.verdict, "not_enough_info");
  assert.deepEqual([byId["C3#0"].input.verdict, byId["C3#0"].failure, byId["C3#0"].spanValid], ["error", "support_span_invalid", false]);
  assert.deepEqual([byId["C4#0"].input.verdict, byId["C4#0"].failure], ["error", "item_missing"]);
  assert.deepEqual(result.unknownItemIds, ["C9#9"]);
});

test("a rejected Luna key leaves no key fragment in the stored judge record", async () => {
  const key = `sk-proj-${"Zq8wLm2xVb".repeat(5)}Kt4n`;
  const authError = Object.assign(new Error(`Incorrect API key provided: ${key}.`), { name: "AuthenticationError", status: 401 });
  const result = await runEntailmentCall({ client: fakeClient(authError), fixtureRef: "fx-7", fixture: SIDES, items: ITEMS, maxJudgeItems: 6, ledger: new CostLedger() });
  assert.ok(result.items.every((item) => item.input.verdict === "error"), "every item stays non-passing");
  assert.ok(!JSON.stringify(result).includes(key) && !JSON.stringify(result).includes("Kt4n"));
  assert.match(JSON.stringify(result), /\[redacted-key\]/);
});

// ---- entailment-v2: side identity ------------------------------------------------------

/** Synthetic Ligat Ha'al fixture: the names Luna receives, English and Hebrew (source language). */
const HAIFA_SIDES: EntailmentFixtureSides = {
  home: { name_en: "Maccabi Haifa", source_names: ["מכבי חיפה"] },
  away: { name_en: "Hapoel Beer Sheva", source_names: ["הפועל באר שבע"] },
};
/** Invented windows (not copied from any article); each contains the quoted sentence once. */
const sideWindow = (text: string, quote: string) => buildEvidenceWindow(text, locateQuote(text, quote)!);
const sideItem = (itemId: string, side: "home" | "away", text: string, quote: string): EntailmentItem => ({
  itemId,
  claim: claim({
    claim_id: itemId.split("#")[0],
    need_id: `availability_rotation_check:${side}`,
    side,
    subject: { type: "player", name_in_source: "דני כהן", name_normalized_en: "Dani Cohen", role: "midfielder", squad_status_claimed: "unknown", squad_status_quote: null, named_players: [] },
    claim: "Dani Cohen is out of the match.",
  }),
  window: sideWindow(text, quote),
});

/**
 * A reference judge that applies the entailment-v2 side rule using only what
 * the payload carries: side is entailed when the window names that side's club
 * (any listed name), contradicted when it names only the other club, otherwise
 * not_enough_info. Every other field is entailed so side alone decides.
 */
function referenceSideJudge(): ResponsesClient & { payloads: Array<ReturnType<typeof buildEntailmentPayload>> } {
  const payloads: Array<ReturnType<typeof buildEntailmentPayload>> = [];
  return {
    payloads,
    responses: {
      async create(body) {
        const payload = JSON.parse(String(body.input)) as ReturnType<typeof buildEntailmentPayload>;
        payloads.push(payload);
        const names = (side: "home" | "away") => [payload.fixture_sides[side].name_en, ...payload.fixture_sides[side].source_names];
        const items = payload.items.map((item) => {
          const own = item.claim.side as "home" | "away";
          const other = own === "home" ? "away" : "home";
          const text = item.evidence.untrusted_window_text;
          const side = names(own).some((name) => text.includes(name)) ? "entailed" : names(other).some((name) => text.includes(name)) ? "contradicted" : "not_enough_info";
          return { ...judged(item.item_id, "entailed", text), verdicts: { claim_kind: "entailed", side, subject: "entailed", stated_status: "entailed", applies_to_fixture: "entailed" }, squad_status_supported: false };
        });
        return lunaPayload(lunaText(items, payload.fixture_ref));
      },
    },
  };
}

test("entailment-v2 sends each side's club by English and source names, defines home/away, and nothing forecast-related", async () => {
  assert.equal(CANDIDATE_ENTAILMENT_REQUEST.version, "entailment-v2");
  assert.equal(ENTAILMENT_CONTRACT_VERSION, "kapiloto-research-v2-entailment-v2");
  assert.match(ENTAILMENT_INSTRUCTIONS, /Side home means the listed home team and side away means the listed away team/);
  assert.match(ENTAILMENT_INSTRUCTIONS, /it is not evidence that any claim is true/);
  const item = sideItem("A1#0", "away", "Squad update. The Hapoel Beer Sheva coach said Dani Cohen is out. Training continues.", "Dani Cohen is out");
  const judge = referenceSideJudge();
  await runEntailmentCall({ client: judge, fixtureRef: "fx-1", fixture: HAIFA_SIDES, items: [item], maxJudgeItems: 6, ledger: new CostLedger() });
  const sent = judge.payloads[0];
  assert.deepEqual(sent, buildEntailmentPayload("fx-1", HAIFA_SIDES, [item]), "the request carries exactly the documented payload");
  assert.deepEqual(Object.keys(sent).sort(), ["contract_version", "fixture_ref", "fixture_sides", "items"]);
  assert.deepEqual(sent.fixture_sides, HAIFA_SIDES);
  assert.deepEqual(Object.keys(sent.items[0]).sort(), ["claim", "evidence", "item_id"]);
  assert.deepEqual(findForbiddenModelKeys(sent, "payload"), []);
  // No probabilities, Elo, odds, market, triage, adjustments, recommendation or results.
  assert.doesNotMatch(JSON.stringify(sent), /prob|elo|odds|market|_bp|triage|score|adjust|shift|recommend|pick|double|result|winner|url|grade/i);
});

test("entailment-v2 side resolution: local or English club names entail, the other club contradicts, neither is not_enough_info", async () => {
  const items = [
    // away claim, window names the away club in its Hebrew form
    sideItem("A1#0", "away", "עדכון סגל. מאמן הפועל באר שבע מסר כי דני כהן בחוץ. שאר השחקנים כשירים.", "דני כהן בחוץ"),
    // home claim, window names the home club in its Hebrew form
    sideItem("H1#0", "home", "עדכון סגל. במכבי חיפה נמסר כי דני כהן בחוץ. שאר השחקנים כשירים.", "דני כהן בחוץ"),
    // away claim, window names only the home club: the subject is tied to the other side
    sideItem("A2#0", "away", "עדכון סגל. במכבי חיפה נמסר כי דני כהן בחוץ.", "דני כהן בחוץ"),
    // away claim, window names neither club
    sideItem("A3#0", "away", "עדכון סגל. המאמן מסר כי דני כהן בחוץ.", "דני כהן בחוץ"),
    // canonical English names resolve too, for either side
    sideItem("A4#0", "away", "Team news. Hapoel Beer Sheva confirmed Dani Cohen is out.", "Dani Cohen is out"),
    sideItem("H2#0", "home", "Team news. Maccabi Haifa confirmed Dani Cohen is out.", "Dani Cohen is out"),
  ];
  const result = await runEntailmentCall({ client: referenceSideJudge(), fixtureRef: "fx-1", fixture: HAIFA_SIDES, items, maxJudgeItems: 12, ledger: new CostLedger() });
  const byId = Object.fromEntries(result.items.map((entry) => [entry.itemId, entry]));
  assert.deepEqual(
    ["A1#0", "H1#0", "A2#0", "A3#0", "A4#0", "H2#0"].map((id) => [id, byId[id].fieldVerdicts?.side, byId[id].input.verdict]),
    [
      ["A1#0", "entailed", "entailed"],
      ["H1#0", "entailed", "entailed"],
      ["A2#0", "contradicted", "contradicted"],
      ["A3#0", "not_enough_info", "not_enough_info"],
      ["A4#0", "entailed", "entailed"],
      ["H2#0", "entailed", "entailed"],
    ],
  );
  // Side passing changes nothing else: squad status stays unsupported, so first-choice rules still apply downstream.
  assert.ok(result.items.every((entry) => entry.input.squadStatusSupported === false));
});

test("with side entailed, every other entailment requirement still applies", async () => {
  const item = sideItem("A1#0", "away", "עדכון סגל. מאמן הפועל באר שבע מסר כי דני כהן בחוץ.", "דני כהן בחוץ");
  const reply = (verdicts: Record<string, string>, span: string | null) =>
    lunaPayload(lunaText([{ ...judged("A1#0", "entailed", span), verdicts: { claim_kind: "entailed", side: "entailed", subject: "entailed", stated_status: "entailed", applies_to_fixture: "entailed", ...verdicts } }], "fx-1"));
  const run = async (verdicts: Record<string, string>, span: string | null = "דני כהן בחוץ") =>
    (await runEntailmentCall({ client: fakeClient(reply(verdicts, span)), fixtureRef: "fx-1", fixture: HAIFA_SIDES, items: [item], maxJudgeItems: 6, ledger: new CostLedger() })).items[0];
  assert.equal((await run({})).input.verdict, "entailed");
  assert.equal((await run({ stated_status: "not_enough_info" })).input.verdict, "not_enough_info");
  assert.equal((await run({ applies_to_fixture: "contradicted" })).input.verdict, "contradicted");
  const badSpan = await run({}, "not in the window");
  assert.deepEqual([badSpan.input.verdict, badSpan.failure], ["error", "support_span_invalid"]);
});

test("items beyond maxJudgeItems are not sent and stay non-passing", async () => {
  const client = fakeClient(lunaPayload(lunaText([judged("C1#0", "entailed", "will miss"), judged("C2#0", "entailed", "will miss")])));
  const result = await runEntailmentCall({ client, fixtureRef: "fx-7", fixture: SIDES, items: ITEMS, maxJudgeItems: 2, ledger: new CostLedger() });
  assert.equal(JSON.parse(String(client.requests[0].body.input)).items.length, 2);
  assert.equal(result.request?.excludedItems, 1);
  assert.deepEqual(result.items.find((item) => item.itemId === "C3#0")?.failure, "judge_budget_exceeded");
});

test("Luna refusal, errors, malformed output and wrong fixture leave every item non-passing", async () => {
  const run = (reply: unknown) => runEntailmentCall({ client: fakeClient(reply), fixtureRef: "fx-7", fixture: SIDES, items: ITEMS, maxJudgeItems: 6, ledger: new CostLedger() });
  const cases: Array<[unknown, string]> = [
    [{ id: "r", model: "m", status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }], usage: usage(100, 0, 10) }, "refusal"],
    [Object.assign(new Error("boom"), { name: "InternalServerError", status: 500 }), "api_error"],
    [Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }), "timeout"],
    [lunaPayload("{oops"), "malformed_output"],
    [lunaPayload(lunaText([{ item_id: "C1#0" }])), "schema_invalid"],
    [lunaPayload(lunaText([judged("C1#0", "entailed", "will miss")], "fx-8")), "fixture_ref_mismatch"],
  ];
  for (const [reply, failure] of cases) {
    const result = await run(reply);
    assert.equal(result.failure, failure, failure);
    assert.ok(result.items.every((item) => item.input.verdict === "error" && item.failure === "call_failed"), failure);
  }
});

test("Luna runs under the candidate pricing; an unpriced judge model is blocked before any network call", async () => {
  const priced = fakeClient(lunaPayload(lunaText([judged("C1#0", "entailed", "will miss"), judged("C2#0", "entailed", "will miss"), judged("C3#0", "entailed", "will miss")])));
  const allowed = await runEntailmentCall({ client: priced, fixtureRef: "fx-7", fixture: SIDES, items: ITEMS, maxJudgeItems: 6, ledger: new CostLedger() });
  assert.deepEqual([allowed.status, allowed.guard?.allowed, allowed.guard?.projectedMicros, priced.requests.length], ["ok", true, 3_563, 1]);
  const unpriced = fakeClient();
  const blocked = await runEntailmentCall({ client: unpriced, fixtureRef: "fx-7", fixture: SIDES, items: ITEMS, maxJudgeItems: 6, ledger: new CostLedger(UNPRICED_JUDGE) });
  assert.deepEqual([blocked.failure, blocked.detail, unpriced.requests.length], ["spend_guard_blocked", "pricing_unavailable", 0]);
});

test("Luna is blocked by the remaining run or fixture budget before any network call", async () => {
  const projection = 3_563; // 3 items: (1,500 + 3 × 1,000) × $0.125/M (30-minute write rate) + 6,000 × $0.50/M
  const runLedger = new CostLedger();
  for (const [fixture, micros] of [["fx-1", 740_000], ["fx-8", 740_000], ["fx-9", 740_000], ["fx-12", 780_000 - projection + 1]] as const) charge(runLedger, fixture, micros);
  const runBudget = fakeClient();
  const runBlocked = await runEntailmentCall({ client: runBudget, fixtureRef: "fx-7", fixture: SIDES, items: ITEMS, maxJudgeItems: 6, ledger: runLedger });
  assert.deepEqual([runBlocked.failure, runBlocked.detail, runBudget.requests.length], ["spend_guard_blocked", "run_cap_would_be_exceeded", 0]);
  const fixtureLedger = new CostLedger();
  charge(fixtureLedger, "fx-7", 750_000 - projection + 1);
  const fixtureBudget = fakeClient();
  const fixtureBlocked = await runEntailmentCall({ client: fixtureBudget, fixtureRef: "fx-7", fixture: SIDES, items: ITEMS, maxJudgeItems: 6, ledger: fixtureLedger });
  assert.deepEqual([fixtureBlocked.failure, fixtureBlocked.detail, fixtureBudget.requests.length], ["spend_guard_blocked", "fixture_cap_would_be_exceeded", 0]);
  const exactLedger = new CostLedger();
  charge(exactLedger, "fx-7", 750_000 - projection);
  assert.equal(checkSpend({ kind: "entailment", fixtureRef: "fx-7", items: 3, maxOutputTokens: 6_000 }, exactLedger).allowed, true, "exactly filling the fixture cap is allowed");
});

// ---- ledger ---------------------------------------------------------------------------

test("the ledger keeps Sol, Luna, web search and fetches apart, per fixture and per run, with pricing provenance", () => {
  const ledger = new CostLedger();
  ledger.recordCall(callCost({ kind: "discovery", fixtureRef: "fx-7", callId: "d1", model: "sol", usage: { inputTokens: 20_000, cachedInputTokens: 2_000, outputTokens: 1_500, reasoningTokens: 0, cacheWriteTokens: 0 }, billableWebSearchCalls: 4, projectedMicros: 290_000, pricing: CANDIDATE_PRICING }));
  ledger.recordCall(callCost({ kind: "entailment", fixtureRef: "fx-7", callId: "l1", model: "luna", usage: { inputTokens: 4_000, cachedInputTokens: 0, outputTokens: 900, reasoningTokens: 0, cacheWriteTokens: 0 }, billableWebSearchCalls: 0, projectedMicros: 0, pricing: CANDIDATE_PRICING }));
  ledger.recordFetch("fx-7", 120_000);
  ledger.recordFetch("fx-7", 80_000);
  ledger.recordFetch("fx-8", 50_000);
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.version, "cost-ledger-v2");
  assert.deepEqual([snapshot.pricing.version, snapshot.pricing.currency, snapshot.pricing.checkedOn], ["pricing-v2", "USD", "2026-10-25"]);
  const fx7 = snapshot.fixtures["fx-7"];
  assert.deepEqual([fx7.solInputTokens, fx7.solCachedInputTokens, fx7.solOutputTokens], [20_000, 2_000, 1_500]);
  assert.deepEqual([fx7.lunaInputTokens, fx7.lunaOutputTokens], [4_000, 900]);
  assert.deepEqual([fx7.billableWebSearchCalls, fx7.webSearchFeeMicros, fx7.serverFetches, fx7.serverFetchBytes], [4, 40_000, 2, 200_000]);
  assert.equal(fx7.knownMicros, 51_200 + 40_000 + 850); // Luna: 4k × $0.10/M + 900 × $0.50/M
  assert.equal(snapshot.run.serverFetches, 3);
  assert.equal(snapshot.run.chargedMicros, fx7.chargedMicros);
  assert.equal(snapshot.run.costUncertain, false, "no cache writes: nothing to be uncertain about");
  assert.deepEqual([fx7.solCacheWriteTokens, fx7.lunaCacheWriteTokens], [0, 0]);
});

test("pricing-v2 records Standard short-context Sol and Luna rates, including both cache-write durations, with provenance", () => {
  assert.equal(CANDIDATE_PRICING.version, "pricing-v2");
  const sol = CANDIDATE_PRICING.sol;
  assert.deepEqual(
    [sol.model, sol.processingTier, sol.inputUsdPerMillion, sol.cachedInputUsdPerMillion, sol.cacheWrite30mUsdPerMillion, sol.cacheWrite12hUsdPerMillion, sol.outputUsdPerMillion, sol.checkedOn],
    ["gpt-6.1-sol", "standard", 2, 0.1, 2.5, 5, 10, "2026-10-25"],
  );
  const luna = CANDIDATE_PRICING.luna!;
  assert.deepEqual(
    [luna.model, luna.processingTier, luna.inputUsdPerMillion, luna.cachedInputUsdPerMillion, luna.cacheWrite30mUsdPerMillion, luna.cacheWrite12hUsdPerMillion, luna.outputUsdPerMillion, luna.checkedOn],
    ["gpt-6-luna", "standard", 0.1, 0.01, 0.125, 0.25, 0.5, "2026-10-25"],
  );
  for (const source of [sol.source, luna.source, CANDIDATE_PRICING.source]) assert.match(source, /Official OpenAI .*pricing/i);
  assert.deepEqual([CANDIDATE_PRICING.currency, CANDIDATE_PRICING.webSearchUsdPerCall, CANDIDATE_PRICING.status], ["USD", 0.01, "candidate"]);
  // 3k uncached × $0.10/M + 1k cached × $0.01/M + 900 × $0.50/M = $0.00076
  assert.equal(tokenCostMicros({ inputTokens: 4_000, cachedInputTokens: 1_000, outputTokens: 900, reasoningTokens: 300, cacheWriteTokens: 0 }, luna), 760);
  // A fully used standard-tier batch written entirely to the cache (default 30m TTL) costs exactly its projection.
  const recorded = callCost({ kind: "entailment", fixtureRef: "fx-7", callId: "l2", model: "gpt-6-luna", usage: { inputTokens: 13_500, cachedInputTokens: 0, outputTokens: 6_000, reasoningTokens: 0, cacheWriteTokens: 13_500 }, billableWebSearchCalls: 0, projectedMicros: 4_688, pricing: CANDIDATE_PRICING, cacheTtl: "30m" });
  assert.deepEqual([recorded.tokenCostMicros, recorded.chargedMicros, recorded.usageStatus, recorded.costUncertain], [4_688, 4_688, "complete", false]);
});

test("cache-write lifetime: usage TTL breakdown first, then the reported TTL, then the request TTL (default 30m); 12h only when selected", () => {
  const sol = CANDIDATE_PRICING.sol;
  const base = { inputTokens: 24_135, cachedInputTokens: 0, outputTokens: 1_337, reasoningTokens: 251, cacheWriteTokens: 5_275 };
  // 1. The usage breakdown decides, priced per lifetime: 18,860 × $2 + 5,000 × $2.50 + 275 × $5 + 1,337 × $10 (per 1M)
  const detailed = tokenCost({ ...base, cacheWriteDetailsReported: true, cacheWriteTtl30mTokens: 5_000, cacheWriteTtl12hTokens: 275 }, sol, "30m");
  assert.deepEqual([detailed.micros, detailed.split?.basis, detailed.split?.ttl30mTokens, detailed.split?.ttl12hTokens, detailed.uncertain], [64_965, "usage_detail", 5_000, 275, false]);
  // A breakdown that does not reconcile with the total: the remainder is charged at 12h and the cost is uncertain.
  const unreconciled = tokenCost({ ...base, cacheWriteDetailsReported: true, cacheWriteTtl30mTokens: 5_000, cacheWriteTtl12hTokens: 0 }, sol, "30m");
  assert.deepEqual([unreconciled.micros, unreconciled.split?.basis, unreconciled.split?.ttl12hTokens, unreconciled.uncertain], [64_965, "usage_detail_unreconciled", 275, true]);
  // 2. Only the total: the TTL the response reports it applied, else the request's effective TTL.
  assert.deepEqual([tokenCost({ ...base, responseCacheTtl: "12h" }, sol, "30m").micros, tokenCost({ ...base, responseCacheTtl: "12h" }, sol, "30m").split?.basis], [77_465, "response_ttl"]);
  const requested30m = tokenCost(base, sol, "30m");
  assert.deepEqual([requested30m.micros, requested30m.split?.basis, requested30m.uncertain], [64_278, "request_ttl", false]);
  const requested12h = tokenCost(base, sol, "12h");
  assert.deepEqual([requested12h.micros, requested12h.split?.basis, requested12h.uncertain], [77_465, "request_ttl", false], "12h only because the request selected it");
  // 3. Only a genuinely unknown lifetime is charged conservatively (12h) and marked uncertain.
  const unknown = tokenCost(base, sol, null);
  assert.deepEqual([unknown.micros, unknown.split?.basis, unknown.uncertain], [77_465, "unknown_ttl", true]);
  // No writes: ordinary input, certain. Writes not reported at all: all uncached input at 12h, uncertain.
  assert.deepEqual([tokenCost({ ...base, cacheWriteTokens: 0 }, sol, "30m").micros, tokenCost({ ...base, cacheWriteTokens: 0 }, sol, "30m").uncertain], [61_640, false]);
  assert.deepEqual([tokenCost({ ...base, cacheWriteTokens: null }, sol, "30m").micros, tokenCost({ ...base, cacheWriteTokens: null }, sol, "30m").split?.basis], [134_045, "unreported"]);
  // Writes are a subset of uncached input: an over-report is trimmed and marked uncertain.
  const over = tokenCost({ inputTokens: 10_000, cachedInputTokens: 4_000, outputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 9_000 }, sol, "30m");
  assert.deepEqual([over.micros, over.split?.ttl30mTokens, over.uncertain], [15_400, 6_000, true]);

  // The call record carries the effective TTL and the split; only uncertainty marks the ledger uncertain.
  const ledger = new CostLedger();
  const cost = callCost({ kind: "discovery", fixtureRef: "fx-1", callId: "d", model: "gpt-6.1-sol", usage: base, billableWebSearchCalls: 3, projectedMicros: 296_000, pricing: CANDIDATE_PRICING, cacheTtl: "30m" });
  ledger.recordCall(cost);
  assert.deepEqual([cost.cacheTtl, cost.cacheWrites?.basis, cost.costUncertain, cost.chargedMicros], ["30m", "request_ttl", false, 64_278 + 30_000]);
  assert.deepEqual([ledger.snapshot().run.costUncertain, ledger.snapshot().run.solCacheWriteTokens], [false, 5_275]);
  const unknownLedger = new CostLedger();
  unknownLedger.recordCall(callCost({ kind: "discovery", fixtureRef: "fx-1", callId: "d", model: "gpt-6.1-sol", usage: base, billableWebSearchCalls: 3, projectedMicros: 296_000, pricing: CANDIDATE_PRICING }));
  assert.equal(unknownLedger.snapshot().run.costUncertain, true, "a call record without a TTL cannot establish the write lifetime");
});

test("responses: the TTL breakdown and applied TTL are parsed, the deprecated prompt_cache_retention is ignored, and the request records its TTL", async () => {
  const usage = (details?: Record<string, number>) => ({ input_tokens: 24_135, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 5_275, ...(details ? { cache_write_tokens_details: details } : {}) }, output_tokens: 1_337, output_tokens_details: { reasoning_tokens: 251 } });
  const reply = (extra: Record<string, unknown>) => payload([search("ws_1", ["q"], ["https://a.example"]), message(discoveryText())], extra);
  const run = async (extra: Record<string, unknown>, config = CANDIDATE_DISCOVERY_REQUEST) => {
    const client = fakeClient(reply(extra));
    const result = await runDiscoveryCall({ client, discoveryInput: INPUT, plan: PLAN, ledger: new CostLedger(), config });
    return { result, body: client.requests[0].body };
  };
  const detailed = await run({ usage: usage({ ttl_30m_tokens: 5_000, ttl_12h_tokens: 275 }), prompt_cache_options: { mode: "implicit", ttl: "30m" }, prompt_cache_retention: "24h" });
  assert.deepEqual(
    [detailed.result.response?.usage?.cacheWriteTtl30mTokens, detailed.result.response?.usage?.cacheWriteTtl12hTokens, detailed.result.response?.usage?.responseCacheTtl, detailed.result.cost?.cacheWrites?.basis, detailed.result.cost?.tokenCostMicros],
    [5_000, 275, "30m", "usage_detail", 64_965],
  );
  // Only the total, no TTL in the response, deprecated retention "24h": priced at the request's default 30m, certain.
  const defaulted = await run({ usage: usage(), prompt_cache_retention: "24h" });
  assert.deepEqual([defaulted.result.cost?.cacheTtl, defaulted.result.cost?.cacheWrites?.basis, defaulted.result.cost?.tokenCostMicros, defaulted.result.cost?.costUncertain], ["30m", "request_ttl", 64_278, false]);
  assert.deepEqual(defaulted.result.request?.promptCache, { effectiveTtl: "30m", sentInRequest: false });
  assert.equal("prompt_cache_options" in defaulted.body, false, "the API default is not sent");
  // A request that selects 12h sends it, records it, and is priced (and projected) at the 12-hour rate.
  const extended = await run({ usage: usage() }, { ...CANDIDATE_DISCOVERY_REQUEST, promptCacheTtl: "12h" });
  assert.deepEqual(extended.body.prompt_cache_options, { ttl: "12h" });
  assert.deepEqual([extended.result.request?.promptCache.effectiveTtl, extended.result.cost?.tokenCostMicros, extended.result.guard?.projectedMicros], ["12h", 77_465, 326_000]);
  assert.deepEqual([CANDIDATE_DISCOVERY_REQUEST.promptCacheTtl, CANDIDATE_DISCOVERY_REQUEST.version, CANDIDATE_ENTAILMENT_REQUEST.promptCacheTtl], ["30m", "discovery-request-v2", "30m"]);
});

// ---- isolation ------------------------------------------------------------------------

test("only the model-client files import OpenAI, and the client graph reaches no Kapiloto research module", () => {
  const root = process.cwd();
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      const base = specifier.startsWith("@/") ? join(root, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(file), specifier) : null;
      if (!base) continue;
      for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
        if (existsSync(candidate) && candidate.endsWith(".ts")) {
          walk(candidate);
          break;
        }
      }
    }
  };
  walk(join(root, "lib", "research-v2", "discovery-client.ts"));
  walk(join(root, "lib", "research-v2", "entailment-client.ts"));
  const rel = (file: string) => file.slice(root.length + 1).replace(/\\/g, "/");
  const importsOpenAI = [...seen].filter((file) => /from\s+["']openai["']/.test(readFileSync(file, "utf8"))).map(rel);
  assert.deepEqual(importsOpenAI, ["lib/research-v2/model-call.ts"]);
  // Same single exception as the base runner: the pure SHA-256 helper (node:crypto only).
  assert.deepEqual([...seen].map(rel).filter((file) => file.startsWith("lib/kapiloto/")), ["lib/kapiloto/snapshot.ts"]);
});
