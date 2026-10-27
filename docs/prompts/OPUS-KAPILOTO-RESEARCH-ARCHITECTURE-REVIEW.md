# Opus 5.5 Architecture Review — Kapiloto Demand-Driven Research

Review the current Kapiloto AI-research architecture as a senior distributed-systems/backend architect.

## Product constraints
- Kapiloto is a per-fixture analyst for a weekly Toto/Winner 16 round.
- Diego is the optional full-ticket builder using Kapiloto analyses.
- OpenAI Sol is the production research model family.
- Research is demand-driven: zero AI/web research until a user explicitly asks for Kapiloto, Recheck, or Diego.
- When research is needed, one shared research run covers all 16 fixtures.
- Results are cached centrally and reused by all users.
- Maximum 3 research runs per round.
- Staleness/TTL may make a new run eligible, but must NEVER trigger AI automatically. A new user request is always required.
- Concurrent users must not cause duplicate research runs.
- Technical retries for one logical run should not consume another run number.
- Once 3 runs are consumed, the system must return the newest available analysis with explicit stale/freshness state and must not silently create run 4.

## Current proposed data model
kapiloto_research_runs:
- id
- round_id
- run_number 1..3
- status queued/researching/completed/failed
- trigger_type fixture_consult/fixture_recheck/diego
- triggered_by_user_id
- requested_round_game_id
- requested_at
- started_at
- completed_at
- model_key
- research_protocol_version
- failure_reason
- unique(round_id, run_number)

kapiloto_analyses:
- id
- research_run_id
- round_game_id
- analysis_version
- is_current
- status researching/fresh/stale/failed
- primary_pick
- suggested_double
- double_recommended
- double_priority_rank
- double_priority_budget
- confidence
- score_1, score_x, score_2
- summary
- main_risk
- generated_at
- valid_until
- stale_at
- stale_reason
- model_key
- research_protocol_version
- unique(round_game_id, analysis_version)
- unique(research_run_id, round_game_id)

## Planned request flow
1. User requests consultation for one fixture.
2. Server reads latest round research state.
3. If current usable analysis exists, return it.
4. If a research run for the round is already queued/running, reuse that run and return a researching state.
5. If a new run is eligible and fewer than 3 logical runs have been consumed, create exactly one round-wide run using transaction/advisory lock.
6. Worker calls Sol + web research and produces structured analyses for all 16 fixtures.
7. Validate results deterministically, persist atomically, mark run completed and analyses current.
8. Subsequent users read the shared cached analyses.

## Review questions
Be critical. Identify concrete production failure modes and give specific fixes.

1. Is this data model sufficient for single-flight semantics and strict max-3 enforcement?
2. Should a failed run consume one of the 3 runs? Distinguish model/business failure vs transient infrastructure failure.
3. What exact PostgreSQL transaction/advisory-lock pattern would you use?
4. How should an abandoned/stuck queued/researching run be detected and recovered without accidentally creating run 4?
5. Should the run lifecycle distinguish logical run vs attempt? If yes, propose tables/fields.
6. How should analyses become current atomically so users never see a mixture of old/new fixtures?
7. Diego requires a coherent full-round snapshot. How should it reference one consistent completed research run rather than mixed analysis versions?
8. How should recheck behave if triggered for one fixture when the product rule says a run researches all 16?
9. What API states/status codes should the client receive for ready/researching/stale/limit_reached/error?
10. What idempotency key strategy should the API use for repeated mobile requests?
11. Is TTL/valid_until enough, or should freshness be computed from structured events/data versions?
12. What security/RLS boundaries should be used so clients can request research but never directly create/update research-run rows?
13. What observability/provenance fields are missing (cost, request IDs, model response IDs, source counts, token usage, retry/attempt data)?
14. Any concern with storing model_key on both run and analysis?
15. Should completed runs be immutable?
16. Any other race condition, data-corruption path, or unnecessary complexity you would change before implementation?

## Required output
Return:
A. Verdict: approve / approve with changes / redesign.
B. Critical issues (P0/P1/P2).
C. Recommended final schema.
D. Exact transaction/state-machine design.
E. API contract recommendation.
F. Diego integration rule.
G. Retry/failure policy.
H. Tests that must exist before production.
I. Short list of changes you would make immediately before implementation.

Do not rewrite the product concept unless a constraint is technically unsafe. Preserve the demand-driven, shared, max-3 behavior unless you can demonstrate a concrete failure mode.