# Claude review prompt — Kapiloto research pipeline

Review branch `design/mobile-first-dark-stadium` at the current head before the first paid research run.

Do not modify secrets, billing, Vercel plan, production aliases or Supabase data. Do not trigger a Kapiloto research request.

Focus only on:
- demand-driven single-flight creation and the three-run budget;
- fixture fanout claims, leases, heartbeat, retry and exhausted-run recovery;
- mixed dispositions: research / carried_forward / research_unavailable;
- grounding and entailment failure paths;
- atomic materialization and fixture publication identity;
- Supabase pg_cron -> authenticated Vercel worker behavior;
- concurrency when two workers are triggered per scheduler tick;
- browser polling/recheck behavior and run publication refresh;
- failure modes that could consume a run slot without useful research;
- any path that could publish the wrong fixture, stale evidence, duplicate analysis, or partial round.

Treat the database RPCs as the final trust boundary. Verify idempotency and race behavior, not just happy-path types.

Return:
1. Critical findings.
2. High/medium findings.
3. Exact files/functions involved.
4. Reproduction scenario for each finding.
5. Minimal recommended fix.
6. A final GO / NO-GO recommendation for triggering round 264201.

Known fixes already implemented are documented in
`docs/reviews/KAPILOTO-RESEARCH-RED-TEAM-001.md`.
Do not re-report them unless the fix is incomplete.


---

## Live incident handoff — round 264201 / run be71f64e-22cf-42d3-9b30-68c9316c943c

This is no longer a pre-first-run review. A real budget-slot-1 run is active.
Do NOT trigger another research run, do NOT alter Supabase production data,
do NOT change secrets, and do NOT deploy.

The first infrastructure-only run failed before OpenAI because PostgreSQL
returned the same cutoff instant with +00 while the frozen card used Z.
That was fixed at commit da3506ffb8656ea750f27d2baa83160e0994e372 by
comparing parsed instants rather than timestamp strings. The failed audit run
was retained and its budget slot was refunded only after verifying zero model
tokens, zero web searches, zero provider response IDs and zero cost.

The replacement live run is:
- run id: be71f64e-22cf-42d3-9b30-68c9316c943c
- seq_no: 2
- budget_slot: 1
- round: 264201
- fixture tasks: 16
- max attempts per task: 3

Observed attempt-1 failures so far:
1. Three attempts failed with:
   - failure class: provider_transient
   - code: SolFixtureResearchError
   - detail: "Sol response did not complete: incomplete"
   - elapsed times: 183254 ms to 215581 ms
   - provider_response_id was not persisted
   - usage fields were not persisted on the failed attempts
2. One attempt failed with:
   - failure class: provider_transient
   - code: SolFixtureResearchError
   - detail: "key_assumptions exceeds 150 characters."
   - elapsed: 153471 ms

Important implementation facts:
- lib/kapiloto/openai-research.ts uses Responses API with:
  - model from KAPILOTO_OPENAI_MODEL (currently gpt-6.1-sol)
  - reasoning effort high by default
  - web_search with search_context_size high
  - strict JSON schema output
  - max_output_tokens default 12000
  - store:false
- research-prompt.ts already says each key_assumptions entry <= 140 chars.
- research-output.ts enforces <=150 chars semantically after the response.
- research-task-executor.ts currently treats provider_transient and
  model_output_invalid as retryable.
- When researchFixtureWithSol throws SolFixtureResearchError with provenance,
  executeOneResearchTask currently records providerResponseId=null and empty
  usage in the model-call failure path, losing diagnostic provenance.
- Vercel production function maxDuration for the worker route is 300 seconds.
- worker lease is 180 seconds with 30-second heartbeat.
- scheduler concurrency is capped at two live attempts.
- Do not assume the 180–216 second "incomplete" failures are Vercel timeouts:
  the OpenAI request returned a Response object with status=incomplete before
  the function duration limit.

Primary review questions:
1. Why are Responses API calls returning status=incomplete around 3–3.6 min?
   Inspect max_output_tokens, reasoning effort, web-search context size, tool
   behavior and any OpenAI SDK/API timeout defaults. Do not guess; trace code
   and current SDK/API semantics.
2. Should fixture research use background Responses API or another execution
   topology for long web-search reasoning, given Vercel's 300-second function
   ceiling? Recommend the smallest robust change.
3. Is 12000 max_output_tokens excessive for this schema? Estimate a sane bound
   based on the actual maximum output shape and evidence limits.
4. Prevent key_assumptions length drift at the schema/API layer if possible,
   not only after generation. Check docs/ai/kapiloto-research-output.schema.json
   for missing maxLength constraints and align schema, prompt and semantic
   validator.
5. Preserve failure provenance on incomplete/model-invalid responses:
   response ID, model, usage, web-search calls and source count should be
   persisted when available so retries are diagnosable and billable usage is
   not hidden.
6. Audit retry policy. A semantic length miss may deserve one repair or retry;
   repeated identical provider-incomplete outcomes should not burn all three
   attempts blindly.
7. Check whether high reasoning + high web-search context for every fixture is
   materially necessary, or whether a staged/default medium configuration can
   preserve research quality while reducing latency.
8. Verify leases/heartbeat remain safe if a request is moved to background or
   polling-based execution.

Required output:
- Critical / high / medium findings.
- Root-cause hypotheses ranked by confidence, with concrete evidence from code.
- Minimal patch plan.
- Exact tests to add.
- If you make changes, keep them local only and run the relevant unit/type/build
  checks. Do not push, deploy, mutate Supabase, call production operator-demand,
  or trigger any research run.
- End with GO / NO-GO for allowing the existing slot-1 run to continue retries
  after the patch is deployed.


### Additional live finding after handoff was prepared

Production Supabase currently has **no research-worker cron job** in `cron.job`.
The only Kapiloto cron present is `kapiloto-live-sync-every-2-min`.
However migration history shows all three research-worker migrations as applied:
- kapiloto_research_worker_scheduler_v1
- kapiloto_research_worker_parallelism_v1
- kapiloto_research_worker_concurrency_guard_v1

Current active-run attempt state at the time of this note:
- failed attempts: 4
- queued attempts: 16
- running attempts: 0

This means retries are effectively paused right now, which is desirable while
debugging, but it also exposes an operational drift problem: migration history
says the scheduler exists while the live cron catalog says it does not.

Add these questions to the review:
9. Trace every code/migration path that can unschedule
   `kapiloto-research-worker-every-2-min`. Determine why the live job is absent
   after the concurrency-guard migration was recorded as applied.
10. Recommend a safe idempotent reconciliation mechanism so scheduler drift can
    be detected/repaired without blindly re-enabling work during an incident.
11. Do not re-enable the research scheduler as part of the review. Keep the live
    run paused until the provider/schema fixes are deployed and explicitly
    approved.
