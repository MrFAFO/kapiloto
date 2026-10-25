# Kapiloto Research v2 — discovery and evidence verification

Status: design approved (D-047; judge side identity and cache-write pricing: D-048). Implemented so far: the researched source-registry seed (`source-registry-v2`, entries verified with recorded evidence on 2026-10-25, awaiting human approval), the discovery-v2 contract and parser, model-output guards, `impact-rules-v1`, the planner, the HTML extractor (`html-extract.ts`, parse5 8.0.1), publication/modification dates and knowledge-cutoff rules (`document-dates.ts`), the SSRF-safe fetcher (`safe-fetch.ts`) evidence windows (`evidence-window.ts`), citation-level verification v2 (`verification.ts`), source-quality-v2 and origin clustering (`source-quality.ts`), claim-level decisions with conflict supersession (`claim-decisions.ts`), research-time market revalidation (`revalidateMarketState`), v2 market timing (`research-timing.ts`), the Sol discovery client and the gpt-6-luna entailment client (`discovery-client.ts`, `entailment-client.ts`, `model-call.ts`; the only Research v2 files that may import OpenAI), `pricing-v2` and `cost-ledger-v2` (`cost-ledger.ts`) and `spend-guard-v2` (`spend-guard.ts`). Pricing (Standard tier, short context, checked 2026-10-25): gpt-6.1-sol $2/M input, $0.10/M cached, $2.50/M 30-minute and $5.00/M 12-hour cache writes, $10/M output; gpt-6-luna $0.10/M input, $0.01/M cached, $0.125/M and $0.25/M cache writes, $0.50/M output; web search $0.01 per call with search-content tokens at Sol rates. A judge model without known rates is blocked as pricing_unavailable. The discovery runner (`discovery-runner.ts`, capture side), the discovery artifact with offline replay (`discovery-artifact.ts`, network-free) and the CLI (`scripts/research-v2-discovery.ts`: plan, research, replay) are implemented. With the candidate caps, a standard-tier fixture cannot retry after a timeout (the timed-out call is charged its full $0.452 projection, and a second would exceed the $0.75 fixture cap); minimal-tier fixtures ($0.296) can. One real live-dev run has been made (game 1, 2026-10-25, D-048 findings). The Sol impact schema is retired. Live development only; formal sampling stays disabled. Builds on the accepted deterministic base (artifact v2, `base-v2` / `market-state-v2`, `triage-v2`, `membership-v1`; D-045, D-046). Every number below is a versioned candidate, not an approved or tuned parameter, and none was chosen from round 264201 outcomes.

## Principles

- Sol discovers factual claims only. It never outputs 1/X/2 probabilities, a predicted winner, a betting recommendation, a pick or double, a probability adjustment, an effect direction or an effect size.
- Research is driven only by triage information needs. There is no generic checklist (no head-to-head, tactics, derby, motivation, weather or set-piece research unless a closed need justifies it).
- A claim can affect a forecast only after deterministic verification and an independent entailment judgment. Sol cannot certify its own sources.
- Direction and size come from a deterministic, versioned rule table (`impact-rules-v1`). The former Sol impact stage (`IMPACT_OUTPUT_SCHEMA`) is retired.
- Research failure never invents evidence and never changes the deterministic base; the pre-research forecast is always kept.

## Timestamps

| Timestamp | Definition | Purpose |
| --- | --- | --- |
| `baseCutoffAt` | base artifact `executionCutoffAt` | base arms and market inputs |
| `researchStartedAt` | recorded immediately before the first research external/model call | — |
| `knowledgeCutoffAt` | `= researchStartedAt`, immutable | the information and publication cutoff of the research forecast; sent to Sol |
| `evidenceCutoffAt` | recorded after the final discovery/fetch operation | every retrieval has `retrievedAt ≤ evidenceCutoffAt`; second eligibility check. Never a publication cutoff |
| `forecastFinalizedAt` | after the adjustment stage | audit |

## Call flow

```
[0] base gate   base age = researchStartedAt − baseCutoffAt ≤ 15 min, else stop (fresh base capture required)
                market-state-v2 revalidated at knowledgeCutoffAt
[E1] eligibility #1 (status upcoming, kickoff ≥ 60 min)  → researchStartedAt = knowledgeCutoffAt
[1] planner (deterministic): needs → effective sides, allowed claim kinds, queries, budget
[$] spend guard → [2] Sol discovery: Responses API + built-in web_search, strict Structured Outputs   (external)
[3] SSRF-safe fetch of URLs observed in this call's web_search sources                                 (external)
    evidenceCutoffAt
[E2] eligibility #2 at evidenceCutoffAt; failure → whole output non-adjusting (crossed_min_lead)
[4] citation-level deterministic checks
[$] spend guard → [5] gpt-6-luna entailment on stored evidence windows (no tools, no new information)
[6] claim-level decision   [7] impact-rules-v1 → ImpactProposal
[8] admitAdjustments (adjustment-policy-v2, revalidated market) → applyAdjustments (effect-sizes-v1)
    forecastFinalizedAt
```

Stages 1, 4, 6, 7 and 8 are pure and replayable; stages 2 and 5 are recorded model calls, never re-run on replay. A combined command captures a fresh base and starts research immediately, so research never runs against an older accepted base. No database writes in live development.

## 1. Discovery input (`discovery-input-v1`)

Per fixture, Sol receives only: an opaque fixture reference; English and source-language team names; competition; `kickoff_at`; `knowledge_cutoff_at`; the planned needs (effective sides, allowed claim kinds, search hints); the budget; known structured facts (rest days and matches in 14 days for congestion needs only; structured absences, currently empty; "new to the competition this season"); the stat-maturity label for `stat_cold_start_context` only.

Never sent: probabilities, basis points, odds, Elo ratings, the market/stat gap or its direction, the triage score, results, scores, standings, head-to-head, or anything published after the cutoff. Sending probabilities or the gap direction would invite anchoring (searching to confirm the market) and is not needed by any later stage. The payload is built from a typed allow-list, checked by the result-key and forecast-field guards, and its hash is stored.

## 2. Planner and budget (`discovery-plan-v1`, `discovery-budget-v2`)

| Need | When | Allowed claim kinds | Scope |
| --- | --- | --- | --- |
| `availability_rotation_check` | every fixture | absence, suspension, doubtful, expected_return, lineup_confirmed | home, away |
| `congestion_rotation` | triage congestion | rotation_statement + availability kinds | sides that meet the congestion rule (rest ≤ 3 d or ≥ 4 matches in 14 d), recorded explicitly |
| `stat_cold_start_context` | confirmed cold start | availability kinds, manager_change, squad_change | the cold side |
| `market_stat_gap` | mature stat arm in a disagreement band | all claim kinds | both |
| `manager_change_context` | only with a checked recent change | manager_change | — |
| `coverage_gap`, `unresolved_availability`, `competition_context` | as triage emits them | availability kinds / named players / context | — |

The planner records `scope` and `scopeReason`; triage need ids and scores are unchanged. An unknown manager status alone creates no need.

| Tier | `maxWebToolCalls` (hard: `max_tool_calls`) | `targetSearchActions` (audited) | `maxFetchedPages` | `maxClaims` | `maxJudgeItems` | Sol `max_output_tokens` |
| --- | --- | --- | --- | --- | --- | --- |
| minimal | 6 | 2 | 3 | 6 | 6 | 8,000 |
| standard | 10 | 4 | 6 | 10 | 12 | 10,000 |
| deep | 18 | 8 | 12 | 16 | 20 | 12,000 |

`max_tool_calls` caps every built-in tool call (`search`, `open_page`, `find_in_page`); it is the hard kill switch. Search actions are recorded and audited separately (`search_target_exceeded` is a finding, not a failure). With needs present, tool use is required; zero recorded `search` actions is `search_not_executed` (one guarded retry, then non-adjusting).

## 3. Sol request and output (`discovery-request-v2`, `discovery-v2`)

Request: Responses API; only the built-in `web_search` tool; the tool's `sources` included; search context size low (candidate); tool use required when needs exist; `max_tool_calls`; `max_output_tokens`; strict Structured Outputs (JSON Schema, strict); prompt-cache TTL `promptCacheTtl` (`30m`, the API default, recorded per call and sent only when another TTL is selected). Recorded: model id and snapshot as returned, reasoning effort, prompt-template, schema and payload hashes, every `web_search_call` with action type and queries when returned, inline citation annotations, the complete `sources` list, and usage.

Output schema (strict subset: `additionalProperties: false` on every object, every property required, nullable through a type union, closed enums; limits the subset cannot express are enforced after parsing):

```
{ contract_version: "kapiloto-research-v2-discovery-v2", fixture_ref,
  needs_addressed: [{ need_id, status: found | nothing_found | inconclusive | budget_exhausted }],
  claims: [{ claim_id, need_id, claim_kind, side: home | away,
    subject: { type: player | team | manager, name_in_source, name_normalized_en | null,
               role: goalkeeper | defender | midfielder | forward | unknown,
               squad_status_claimed: first_choice | rotation | fringe | unknown, squad_status_quote | null,
               named_players: [string] },
    claim, stated_status: confirmed | expected | doubtful | denied, applies_to_this_fixture,
    event_time | null, observation: direct_statement | reported | inferred,
    extraction_confidence: high | medium | low, corroboration_claimed,
    citations: [{ url, quote, publisher_claimed | null, author_claimed | null, published_at_claimed | null }] }] }
```

No direction, impact, uncertainty, probability or recommendation field exists. Defence in depth: the recursive forbidden-key guard (extended with winner, favourite, tip, stake, bet, recommend, adjust, impact, magnitude) and a value-level guard that rejects any claim whose text contains odds, percentages, 1/X/2, outcome or betting language. Everything Sol "claims" about publisher, author, date or squad status is advisory and recomputed.

## 4. Claim vocabulary (`claim-kinds-v2`)

- Forecast-changing: `absence`, `suspension`, `doubtful`, `expected_return`, `rotation_statement`.
- Explanatory only: `lineup_confirmed` (it may add an A-grade corroborating cluster to an existing claim on the same subject, never adjust alone), `schedule_disruption`, `manager_change`, `squad_change`, `shape_change` (a formation or player-role change stated directly by a source; named so it is not a generic tactics topic), `other_context`.

Motivation, morale, form, "must win", rivalry and similar are not representable.

## 5. Impact rules (`impact-rules-v1`)

Preconditions: claim verified, applies to this fixture, observation not inferred, not a structured duplicate, not in conflict. Squad status counts only when the judge supports it with a span; otherwise it is unknown. Uncertainty: confirmed → low, expected → medium, doubtful → high; `denied` gives none.

| Kind | Verified status / role | Direction | Class |
| --- | --- | --- | --- |
| absence, suspension | first-choice goalkeeper / outfield | weakens side | moderate / minor |
| doubtful | first-choice goalkeeper / outfield | weakens side | moderate / minor (uncertainty high) |
| expected_return | first-choice goalkeeper / outfield | strengthens side | moderate / minor |
| any of the above | rotation / fringe / unknown | — | none (explanatory) |
| rotation_statement | direct statement (grade-A cluster) naming ≥ 2 supported first-choice players not already admitted as absences | weakens side | minor |
| rotation_statement | otherwise | — | none |

`major` is unused in v1; effect sizes and cap are unchanged (`effect-sizes-v1`); one proposal per subject. An exhaustive coverage test fails if any forecast-changing combination lacks exactly one rule.

## 6. Verification (`verification-v2`)

Citation level (each citation independently; rejected citations are removed): `url_not_observed` (not in this call's recorded `sources`), `fetch_blocked`, `page_not_retrieved`, `retrieved_after_evidence_cutoff`, `undated`, `published_after_knowledge_cutoff`, `modified_after_knowledge_cutoff`, `publication_time_ambiguous`, `modification_time_ambiguous`, `stale_for_claim_kind`, `quote_not_found`, `entity_not_in_window`, `source_denied`, `entailment_unsupported`, `entailment_missing`.

Claim level, on accepted citations only: clusters, then source policy — one independent cluster meeting `minQualityAlone` (B), or at least two independent clusters of grade C or better — then structured duplication, conflicts, timing and the impact rule. Outcome `adjusting`, `explanatory` or `rejected`. One bad extra citation never poisons a claim with a qualifying accepted cluster. Both levels are stored with reasons.

## 7. Dates and the knowledge cutoff

`publishedAt` and `modifiedAt` are stored separately, each with extraction method (JSON-LD `datePublished`/`dateModified`, `article:published_time`/`modified_time`, `<time datetime>`), precision (`datetime_tz`, `datetime_no_tz`, `date`), source location and every raw candidate. `modifiedAt` never substitutes for `publishedAt`.

Existence before `knowledgeCutoffAt` (adjusting citations; `publishedAt`, and `modifiedAt` when present):

- `datetime_tz`: value ≤ `knowledgeCutoffAt`.
- `date`: proves existence only when strictly before the calendar date containing `knowledgeCutoffAt` in UTC−12 (the latest civil timezone), so it holds under every publisher timezone; the same calendar date is `publication_time_ambiguous` / `modification_time_ambiguous` and non-adjusting.
- `datetime_no_tz`: value + 12 h ≤ `knowledgeCutoffAt`, otherwise ambiguous.
- Content published or modified after `knowledgeCutoffAt` is non-adjusting even when retrieved before `evidenceCutoffAt`.

Market timing uses the earliest possible instant (date-only at 00:00 UTC+14; no timezone at value − 14 h), so ambiguity leans to `market_likely_incorporated`. Risk to measure: pages that stamp `dateModified` on every render will be rejected.

## 8. Base freshness and market timing

`research-base-freshness-v1`: `maxBaseAgeAtResearchStart` = 15 min. Older bases are refused (no discovery; a fresh capture is required); recomputing ages never substitutes for this gate, which limits the chance that an unseen newer market snapshot already incorporated the evidence.

Market-state-v2 is recomputed from the stored provider timestamps at `knowledgeCutoffAt` (market timing only; base arms unchanged). If the oldest used price has crossed the freshness limit (360 min), the market is non-fresh for research even if it was `standard` at `baseCutoffAt`. The revalidated state is stored and passed to `admitAdjustments` (`adjustment-policy-v2`, unchanged):

| Revalidated market / evidence time | Path |
| --- | --- |
| missing, stale, thin or non-fresh | `stat_path` |
| evidence ≤ newest price | `market_likely_incorporated` |
| newest price < evidence ≤ `knowledgeCutoffAt` | `full` |
| ambiguous (date-only, no timezone, within ±30 min of the newest price; `timing-margin-v1`) | `market_likely_incorporated` |

## 9. Source quality and duplication

`source-quality-v2` (dimensions stored per citation): source type (official club/competition, club media, press-conference report, outlet, aggregator, unknown), primary or secondary reporting, accredited or specialist reporter from the registry independent of outlet size, direct quote, origin, and reporter track record (neutral now; later from verification accuracy only, never match outcomes). Grades: A official (own club or competition) or a direct statement relayed by a verified outlet; B primary reporting with club-scoped trust (a verified club specialist or a verified reporter whose scope includes the club); C secondary reporting and an established outlet's own reporting without club-scoped trust (candidate `establishedPrimaryGrade`, set conservatively to C so outlet size never grants B); D aggregator, unregistered or unknown. D never adjusts or corroborates. The registry is versioned; only `verified` or human-`approved` entries may grant specialist or accredited-reporter trust — an entry marked `needs_verification` keeps its plain outlet type and can never reach grade B through its draft scope (source quality reads the registry only through `effectiveRegistryEntries`).

`dedup-v1`: subject key = side + subject type + normalized name (availability kinds share one family; one proposal per subject). Clusters join on canonical URL, a normalized quote of 40+ characters, agency plus subject, or origin key (`presser:<team>:<date>`, `outlet:<cited outlet>`); articles quoting the same origin are one cluster. A claim matching structured availability is explanatory (structured availability is empty until a separate base decision). Conflicting statuses on one subject are non-adjusting unless a later grade-A official statement supersedes.

## 10. Entailment (`entailment-v2`, D-048)

`gpt-6-luna`, Responses API, no tools, strict Structured Outputs, reasoning effort `medium`, `max_output_tokens` 6,000. One batched call per fixture for forecast-changing claim × citation pairs that passed the deterministic pre-checks (at most `maxJudgeItems`). Each item receives the claim fields and the stored evidence window, marked as untrusted data. The payload also carries `fixture_sides` — the home and away clubs, each with its English and source-language names (the discovery input's allow-listed names) — and the instructions define `home` as the listed home team and `away` as the listed away team. That identity is for side resolution only and is not evidence: side is entailed only when the window ties the subject to that club, contradicted when it ties it to the other club, otherwise not_enough_info. No probability, rating, odds, market, triage, adjustment, recommendation or result is sent. Output per item: verdict per field (kind, side, subject, stated status, applies to fixture) as entailed / contradicted / not_enough_info; a support span that must be a verbatim substring of the window; attribution (primary/secondary, direct quote); `squad_status_supported`; `named_players_supported`. Only full entailment with a valid span passes; any failure makes the item non-adjusting. Stored: exact model id, prompt and schema hashes, window hashes, verdicts, spans, usage and cost. Candidate judge until agreement is measured.

## 11. Fetcher security (`fetcher-v1`)

http/https only, observed URLs only; DNS resolved before connecting; loopback, localhost, link-local, private, CGNAT, multicast and unspecified addresses blocked; connection to the validated address only (no rebinding); at most 3 redirects, each revalidated; 10 s timeout; 2 MB streaming limit; `text/html`, `application/xhtml+xml`, `text/plain` only; no cookies, credentials, authorization or referrer; GET only. The final canonical URL and every allow/block decision are recorded.

## 12. Persistence (`research-v2-discovery-artifact-v1`)

One local artifact per run, linked to the base artifact hash. It stores: all timestamps, the base-age check, the revalidated market state, both eligibility checks and every config hash; the planner output; per model call the structured output, annotations, every `web_search_call` and action, the full `sources`, usage; per document the requested and final URL, redirect chain, HTTP and content metadata, raw-bytes and text hashes, date candidates with locations and fetch decisions — no article bodies; per citation an evidence window (quote ± 400 characters, at most 1,200) with its hash and offsets; citation results, claim decisions, clusters, source vectors, judge records, timing, impact rules, adjustment decisions; the cost ledger.

Full documents exist only in memory during capture and verification. Replay reruns the deterministic stages on stored windows, metadata and recorded model outputs with the network blocked (fetch, http/https, net, tls and every `node:dns` lookup and resolve path, including `dns.promises` and both `Resolver` classes: `network-block.ts`); full-document facts are verified by hash. Formal storage needs legal review.

Hash boundary: `deterministic.inputs` (hashed) includes, per attempted fetch, the fetch-security policy outcome (`StoredFetchPolicy`): fetcher id and version, requested and canonical URL, overall allow/block, the deterministic reason code with policy-relevant detail only (HTTP status, media type, size, hop count), every hop with its scheme, host, allow/block, reason and the redirect it answered with, the final URL, the response acceptance checks (status, content type, encoding, size) and the final outcome. `runtime` (not hashed) keeps only non-deterministic diagnostics: resolved IP addresses per hop, fetch and model latencies, raw transport error text. Tampering with a policy outcome changes the artifact hash; DNS or CDN address variation does not. Model-call error details (Sol and Luna) pass through `redactSecrets` before truncation and storage, so no API key, bearer credential, key/token assignment or long opaque token (masked or not) reaches an artifact.

## 13. Cost ledger and spend guard (`pricing-v2`, `cost-ledger-v2`, `spend-guard-v2`, D-048)

Rates (Standard, short context, per 1M tokens): gpt-6.1-sol input $2.00, cached $0.10, cache write $2.50 (30 minutes) / $5.00 (12 hours), output $10.00; gpt-6-luna input $0.10, cached $0.01, cache write $0.125 / $0.25, output $0.50. Cache-write tokens (a subset of input) are never priced as ordinary input. Their lifetime comes, in order, from the usage breakdown `cache_write_tokens_details` (`ttl_30m_tokens`, `ttl_12h_tokens`; must reconcile with the total, otherwise the remainder is charged at 12 hours and the call is cost-uncertain), the TTL the response reports (`prompt_cache_options.ttl`), and the request's effective `prompt_cache_options.ttl` (default `30m`; `12h` only when selected). Only an unestablished lifetime is charged at 12 hours and marked uncertain; unreported writes charge all uncached input at 12 hours; the deprecated `prompt_cache_retention` is ignored. Both request configs carry `promptCacheTtl: "30m"` (recorded per call, not sent because it is the default). The spend-guard projection prices up to 12,000 discovery input tokens and all judge input at the request TTL's write rate (minimal discovery $0.296, standard $0.452; 12-hour TTL $0.326 / $0.482; caps unchanged).

Recorded per fixture and per run: Sol input, cached, cache-write and output tokens and cost; Luna input, cached, cache-write and output tokens and cost; billable web-search tool calls (recorded `web_search_call` items, billable unless reported otherwise) and fees at $0.01 per call; server fetches (count, bytes); fixture and run totals. Final accounting uses recorded calls, never targets.

Planning estimate for the current five fixtures (Sol $2/M input, $0.10/M cached, $10/M output; about 7k search-content tokens per tool call; Luna price captured before the first run):

| | Expected (12 search calls) | Hard worst case (all tool calls + one retry each) |
| --- | --- | --- |
| Sol tokens | ≈ $0.30 | ≈ $1.68 |
| Web-search fees | $0.12 | $0.68 |
| Sol + search | ≈ $0.42 | ≈ $2.36 |
| Luna | ≈ 15 items | 36 items, 5 × 6k max output |

Search-content tokens per call are not hard-capped by the API, so the spend guard is the true bound. Before every model call (discovery, retry, Luna) the remaining budget must cover that call's projected worst case (`max_tool_calls` × $0.01 plus maximum-output and assumed-maximum-input token cost); otherwise the call is skipped (`spend_guard_blocked`; a blocked retry makes the fixture `discovery_unavailable`, a blocked judge makes its claims non-adjusting). Approved caps: $0.75 per fixture, $3.00 per live-development run.

## 14. Failure and degradation

| Case | Behaviour |
| --- | --- |
| base older than 15 min | no discovery; fresh base capture required |
| market non-fresh at the knowledge cutoff | `stat_path` only |
| Sol failure or timeout | one guarded retry, then `discovery_unavailable` |
| zero search actions | `search_not_executed`, one guarded retry, then non-adjusting |
| invalid structured output | whole call rejected, raw output stored |
| forecast field or language | claim rejected |
| zero useful claims | `nothing_found`, no adjustment |
| fetch failure or blocked fetch | citation removed |
| undated, published or modified after the knowledge cutoff, same-day ambiguity | citation removed for adjustment |
| judge failure | affected claims non-adjusting |
| weak sources only | explanatory |
| conflicting sources | non-adjusting |
| budget exhausted or spend guard | recorded; no extra calls |
| crossed the 60-minute boundary at `evidenceCutoffAt` | whole output non-adjusting |

## 15. Current five fixtures (dry plan from artifact v2, no calls)

| # | Tier | Needs (effective scope) |
| --- | --- | --- |
| 1 Maccabi Haifa – Hapoel Beer Sheva | minimal | availability: home, away |
| 7 Hull – Brentford | minimal | availability: home, away; `stat_cold_start_context`: home |
| 8 Crystal Palace – Newcastle | minimal | availability: home, away; congestion: home |
| 9 Sunderland – Leeds | minimal | availability: home, away; congestion: home |
| 12 Celta Vigo – Betis | standard | availability: home, away; congestion: home, away; `market_stat_gap`: both |

Hull receives cold-start context, not `market_stat_gap`; no manager-change need is created anywhere. The 2026-10-25 01:35Z base is too old for a real run; a fresh capture comes first.

## 16. Acceptance gates

A. Before implementation: this design and the spend caps (approved); review of the source-registry seed for the three leagues; review of the impact-rule table and budget values (candidates).

B. Before the first Sol live-development run: implementation with tests for the strict-schema subset and both guards; planner scopes; `search_not_executed`; URL observation against recorded sources; the SSRF suite; separate published/modified dates with knowledge-cutoff rules (including date-only same-day and UTC−12 boundaries); base-age refusal at 15 min ± 1 ms; market revalidation (standard → non-fresh); both eligibility checks; citation-then-claim verification; judge span validation; exhaustive impact coverage; spend guard blocking a retry and a judge call; the cost ledger with web-search fees; minimal-text artifact and bit-identical replay. Also: the combined fresh-base-then-research command; an offline run on recorded synthetic responses; a network guard allowing only the OpenAI API and the safe fetcher; no database writes; captured Sol, Luna and web-search pricing; the temporary `OPENAI_API_KEY` env workflow; explicit approval of the run.

C. Before the next full dry run: structured availability decision; API-Football identifier mappings; Sportmonks access past 2026-11-02; registry and search-name coverage for the round; human spot-check of claims and judge verdicts; measured rejection rates (especially `modified_after_knowledge_cutoff` and `publication_time_ambiguous`), billable search calls and costs against the guard.

D. Before formal sampling: Supabase persistence with RLS and immutable snapshots; legal review of stored windows; measured judge agreement; a pre-registered with/without-research evaluation; reporter track record from verification outcomes only; all parameters candidate until prospective evaluation; open items from the deterministic-base audit (provider-identifier mapping, promoted-team arms).
