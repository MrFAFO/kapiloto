# Kapiloto Research API Contract v1

Status: architecture contract; implementation pending.

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

### GET /api/v1/rounds/{roundId}/kapiloto/fixtures/{roundGameId}
Read only. Never starts research. Supports ETag / If-None-Match.

### GET /api/v1/rounds/{roundId}/kapiloto/state
Read-only poll/realtime fallback for round research state.

## Response state
The envelope contains:
- state: ready | researching | stale | limit_reached | error
- analysis and analysis_run
- freshness: fresh | stale | locked | void plus stale reasons
- research: active run, runs used/max/remaining, refresh eligibility, last failure
- request outcome
- poll retry_after_seconds

Analysis includes outcome, primary_pick, suggested_double, double_recommended, double_priority_rank, confidence, normalized scores, summary, main_risk, generated_at and sources.

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
| Three budget slots consumed | 200 | limit_reached when stale | limit_reached |
| Round closed | 200 | ready/stale/limit_reached | served_cache |
| No usable analysis after terminal failure | 200 | error | n/a |
| Backend/worker unavailable and no useful cached response | 503 | n/a | n/a |
| Per-user request-rate limit | 429 | n/a | n/a |
| Same idempotency key with different body | 422 | n/a | n/a |
| Unauthorized/forbidden/not found | 401/403/404 | n/a | n/a |

Do not use 429 for the three-run business limit.

## Idempotency
Store (user_id, idempotency_key, request_sha256). Same key + same body returns the current state of the original request/run and never creates another run. Same key + different body returns 422.

## Research lifecycle
1. Request path performs an optimistic read.
2. Possible create path locks kapiloto_round_research_state FOR UPDATE.
3. It re-checks active run, published run, refresh eligibility, budget and circuit breaker.
4. It creates one logical run and one queued attempt in one short transaction.
5. Worker claims an attempt with FOR UPDATE SKIP LOCKED.
6. Sol/web research happens without an open DB transaction.
7. Completion validates the frozen fixture set.
8. One short completion transaction inserts the immutable 16-analysis snapshot and changes current_run_id.
9. Realtime/poll clients observe the new round-state version.

## Freshness
Freshness is computed when read. A fixture is stale when deterministic TTL or a material signal/data-version change occurred after the published run input snapshot. Freshness signals never create runs.

## Diego
Diego pins exactly one completed research_run_id. If no completed run exists, a Diego request may create/join run 1 and return researching. If a completed run exists while a newer run is active, Diego may build from the completed run and expose that newer research is pending. Explicit refresh-and-build uses the same recheck request path.