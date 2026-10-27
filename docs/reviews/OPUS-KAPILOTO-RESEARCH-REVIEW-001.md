# Architecture Review Reconciliation — Kapiloto Research 001

Source review: Claude Opus 5.5 external architecture review, October 2026.

## Verdict
Accepted direction: **approve with changes**.

The product rules remain unchanged: demand-driven research; no AI/web research before user demand; one shared round-wide run researches all 16 fixtures; results are reused for all users; Sol is the research model family; at most three budget-consuming research runs per round; staleness alone never starts research.

## Accepted changes

### Round-level research state
Add one kapiloto_round_research_state row per round. It is the serialization target and stores active_run_id, current_run_id, consumed research budget, research close time, circuit-breaker counters, and a monotonic version for polling/ETag. Run creation re-checks invariants while holding SELECT ... FOR UPDATE on this row.

### Logical runs and execution attempts are separate
A logical research run consumes at most one research-budget slot. kapiloto_research_attempts records retries, worker leases, provider/model IDs, token/cost usage and failure classification. Transient retries stay inside the same logical run.

### Database-enforced single-flight
Use one active-run partial unique index per round; budget slots constrained to 1..3; unique (round_id, budget_slot) for non-refunded runs; and one privileged request path that creates runs. Workers, reapers and clients never create logical runs directly.

### Atomic publication by pointer
Analyses are immutable snapshots keyed by research_run_id. A run is published by atomically changing round_state.current_run_id. Remove per-analysis is_current, analysis_version and mutable freshness/stale fields. Readers resolve one published run and read all fixtures from it.

### Explicit request/idempotency records
Every consult/recheck/Diego research request is recorded with user, intent, idempotency key, request hash, based_on_run_id, outcome and joined/created run.

### Deterministic freshness
valid_until is a deterministic fallback. Freshness also considers non-AI signals/data versions such as lineup publication, injuries/suspensions, material odds movement, kickoff changes, postponement/cancellation and newer sports-data versions. Signals may make refresh eligible but never execute research.

### Failure classes and slot refunds
Transient infrastructure/provider failures retry within the same logical run. If transient failure becomes terminal, its budget slot is refunded. Deterministic model/business failures may consume the slot. Per-round attempt/cost circuit breakers prevent unlimited spend.

### Worker lease/fencing
Workers claim queued attempts with short transactions and FOR UPDATE SKIP LOCKED. Long Sol/web research happens outside DB transactions. Heartbeat leases fence zombie workers; completion is accepted only from the currently owning attempt.

### Diego pins one completed run
Diego never asks for latest analysis per fixture. It pins exactly one completed research_run_id and all 16 inputs come from that run.

### Server-only mutation
Authenticated clients get no direct write access to Kapiloto research tables. The browser calls a server/API/RPC boundary; OpenAI credentials exist only server-side.

## Adapted rather than accepted verbatim

### Refresh gating
We accept: Consult may create run 1; runs 2 and 3 require explicit Recheck or explicit Diego refresh; material-staleness gating; a configurable minimum refresh interval with critical-signal bypass; and rate limiting.

We do **not** add a separate final-run confirmation UX in MVP. We also do **not** impose one refresh-creating request per user per round, because a small/private group may legitimately have one user initiating both later refreshes.

### Fan-out
Per-fixture task fan-out is deferred. MVP may execute one round-level attempt that validates all 16 results atomically. The attempt schema can later gain task_key if empirical retry cost warrants fan-out.

### Raw output archive
Object-storage archival is recommended before production but is not required to finish the first schema draft.

## Immediate implementation order
1. Replace current run schema with round state + run + attempt + request tables.
2. Make analyses immutable and publish with current_run_id.
3. Add deterministic freshness signals.
4. Update Diego to pin one run.
5. Lock Kapiloto mutations behind one privileged server path.
6. Implement API idempotency and response contract.
7. Add concurrency, lease-expiry, refund and atomic-publication tests before the real migration.