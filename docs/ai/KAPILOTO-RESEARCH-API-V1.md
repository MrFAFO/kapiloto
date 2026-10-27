# Kapiloto Research API Contract v1

Status: architecture contract; POST and both read-only GET routes implemented against the draft schema (not yet applied to production).

## Principles
- GET never starts research.
- Only an explicit POST intent may create a logical research run.
- Normal Consult can create only the first run when no published research exists.
- Later shared runs require explicit Recheck or Diego refresh intent.
- Every POST requires an Idempotency-Key.
- All readers consume one published round snapshot.

## Endpoints

### POST /api/v1/rounds/{roundId}/kapiloto/requests
Header: Idempotency-Key: <uuid>

Request fields:
- round_game_id: uuid
- intent: consult | recheck
- based_on_run_id: uuid | null

Rules:
- consult with no published run may create run 1.
- consult with a published run never creates run 2 or 3, even if stale.
- recheck can create a later run only when refresh eligibility passes.
- based_on_run_id makes refresh conditional. If a newer run is already published, return it and create nothing.
- concurrent requests join the one active run.
- maximum three non-refunded budget slots per round.

Implemented body (camelCase, validated by `lib/kapiloto/http-contract.ts`): `groupId`, `roundGameId`, `intent`, `basedOnRunId`. The browser never sends refresh eligibility, model or provider configuration.

### GET /api/v1/rounds/{roundId}/kapiloto/fixtures/{roundGameId}?group_id={groupId}
Read only. Never starts research, never calls provider sync, Sol or the create-run RPC. Order of checks: 400 malformed ids / missing `group_id` → 401 no session → 403 no active membership or group not configured for the round → 404 fixture not in round.

Reads only the current published run (`kapiloto_round_research_state.current_run_id`). Returns the same envelope as POST without `request`. Read states:
- `unresearched`: no published analysis, no active run, budget remaining;
- `researching`: an active run exists; a previously published analysis, if any, is still returned;
- `ready` / `stale`: published analysis with freshness computed at read time;
- `limit_reached`: no published analysis and no budget remaining.

`ETag` is a weak tag over current run id, analysis id, freshness state/reasons, read state, active run id, runs used, closed flag and the group's max doubles/lock (so a group budget change cannot be served a stale `doubleRecommended`). `If-None-Match` returns 304. `Cache-Control: private, no-cache`.

### GET /api/v1/rounds/{roundId}/kapiloto/state?group_id={groupId}
Read-only poll/realtime fallback. Same auth/membership checks. Reads only `kapiloto_round_research_state` and returns `research: { active_run_id, current_run_id, runs_used, runs_max, runs_remaining, closed, version }` plus `poll`. `Retry-After` is set while a run is active.

### Browser client and polling
`lib/kapiloto/client.ts` generates one UUID Idempotency-Key per explicit Consult/Recheck and reuses it for transport retries of that action. Polling uses only the two GET routes, honours `Retry-After`, and stops when `current_run_id` changes, the active run ends, or the request is aborted.

## Response state
The envelope contains:
- state: ready | researching | stale | limit_reached | error (POST); GET adds unresearched
- analysis and analysis_run
- freshness: fresh | stale | locked | void plus stale reasons
- research: active run, runs used/max/remaining, refresh eligibility, last failure
- request outcome
- poll retry_after_seconds

Analysis includes outcome, deterministically derived primary_pick and suggested_double, global double_priority_rank/double_gain_score, group-specific double_recommended, reliability/reliability_band, server-derived p_final basis points, summary, main_risk, generated_at and validated evidence/sources.

Research v3 adds optional, sanitized fields to the fixture analysis:
`expectedLineups`, `tacticalFacts`, `matchupAnalysis` and `regimeChanges`.
They are null for v1/v2 analyses and for carried-forward analyses. They are
descriptive research only; probabilities, picks and double ranks remain
derived from factors and the frozen prior.

`double_recommended` in the API is contextual to the requesting group's configured double budget; it is not stored as a universal model output. The shared stored probabilities/rank remain identical for every group.

`reliability` means trust in the research quality, not the chance that the top outcome occurs. Precise p_final percentages are primarily optimizer/internal data and should not be presented to users as calibrated win probabilities until calibration is validated.

## HTTP behavior
| Scenario | HTTP | State | Request outcome |
|---|---:|---|---|
| First consult; no run exists | 202 | researching | created_run |
| Cached fresh consult | 200 | ready | served_cache |
| Concurrent request while run active | 202 | researching | joined_run |
| Poll while active | 200 | researching | n/a |
| Plain consult against stale published data | 200 | stale | served_cache |
| Eligible explicit recheck | 202 | researching | created_run |
| Recheck not eligible | 200 | ready/stale | refresh_ineligible |
| Recheck based on older run | 200 | ready/stale | served_newer |
| Explicit request after three budget slots are consumed | 200 | limit_reached when no fresh usable analysis is available | limit_reached |
| Round closed | 200 | ready/stale/limit_reached | served_cache |
| No usable analysis after terminal failure | 200 | error | n/a |
| Backend/worker unavailable and no useful cached response | 503 | n/a | n/a |
| Per-user request-rate limit | 429 | n/a | n/a |
| Same idempotency key with different body | 422 | n/a | n/a |
| Unauthorized/forbidden/not found | 401/403/404 | n/a | n/a |

Do not use 429 for the three-run business limit.

For read-only GETs, a stale published analysis may remain `stale` while
`research.runs_remaining = 0`; the client renders that combination as
research-budget-exhausted while preserving the newest analysis. The
`limit_reached` request outcome is reserved for an explicit POST that asks
for another run after the logical-run budget is exhausted.

## Idempotency
Store (user_id, idempotency_key, request_sha256). Same key + same body returns the current state of the original request/run and never creates another run. Same key + different body returns 422.

## Model-output boundary
Sol's fixture-scoped strict structured output contains claim-level evidence, availability, dimension coverage, conflicts, raw pre-match home/draw/away probability estimates, material factors, data quality, structured watch items, suspicious-content flags and a logged self-confidence enum.

Sol does **not** author the persisted Toto pick, suggested double, global double rank, group-specific double recommendation, source tier, final reliability or p_final. Server code validates identity/evidence, blends p_sol with the versioned prior/reliability/calibration policy, maps home/draw/away to 1/X/2, then derives decisions deterministically.

Every evidence URL must correspond to a page actually retrieved, not merely listed. Material evidence carries a short supporting quote that the server verifies against fetched content; source tier and published_at are assigned/extracted server-side.

## Pre-match cutoff
Each logical run freezes `research_cutoff_at`. Fixture tasks inside the configured kickoff safety window do not perform new web research. Evidence published after the cutoff is rejected. Research workers have no access to actual-results/settlement tables used for later evaluation.

## Research lifecycle
1. Request path performs an optimistic read.
2. Possible create path locks kapiloto_round_research_state FOR UPDATE.
3. It re-checks active run, published run, refresh eligibility, budget and circuit breaker.
4. It creates one logical run and the task set for the configured execution topology in one short transaction.
5. Workers claim fixture/round tasks with FOR UPDATE SKIP LOCKED.
6. Sol/web research happens without an open DB transaction; task retries stay inside the same logical run.
7. Server validates fixture identity, evidence, p_sol, cutoff rules and deterministic p_final derivation.
8. Completion validates the full frozen fixture set.
9. One short completion transaction inserts the immutable 16-analysis snapshot and changes current_run_id.
10. Realtime/poll clients observe the new round-state version.

## Freshness
Freshness is computed when read. A fixture is stale when deterministic TTL or a material signal/data-version change occurred after the published run input snapshot. Freshness signals never create runs.

## Diego
Diego pins exactly one completed research_run_id. If no completed run exists, a Diego request may create/join run 1 and return researching. If a completed run exists while a newer run is active, Diego may build from the completed run and expose that newer research is pending. Explicit refresh-and-build uses the same recheck request path.