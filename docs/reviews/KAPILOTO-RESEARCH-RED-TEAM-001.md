# Kapiloto research pipeline red-team — 2026-10-20

Scope: demand-driven run creation, fixture fanout worker, retry/recovery, materialization, fixture publication, and Match Intelligence delivery.

## Closed findings

1. **Orphaned completed work could remain unpublished.**
   Worker finalization discovery now inspects active queued/running runs even when the current burst claimed no work.

2. **Mixed research dispositions could never finalize.**
   Finalization now supports research, carried-forward and research-unavailable fixtures while preserving a 16-row publication.

3. **Missing market data blocked the entire research run.**
   API-Football enrichment is optional. Missing market data uses an explicit neutral league-base prior and lowers reliability.

4. **An exhausted fixture task could leave a run permanently active.**
   The database failure sweep closes unrecoverable runs, abandons remaining attempts and releases the round single-flight.

5. **Materialization trusted application fixture identity too much.**
   The database now verifies that the frozen fixture_set contains 16 unique canonical round-game/fixture pairs and that all 16 publication payloads match that set exactly.

6. **The UI polling window was shorter than the scheduled 16-fixture fanout.**
   The scheduler now starts two single-task workers per two-minute tick, while browser polling allows up to 30 minutes. This preserves conservative worker concurrency without falsely timing out a healthy round-wide run.

7. **Environment presence did not prove OpenAI runtime access before spending a run slot.**
   A secret-authenticated internal preflight endpoint now performs a tiny non-web OpenAI generation without creating a Kapiloto request/run. Production smoke testing must pass this endpoint before the first paid round-wide research request.

8. **A Vercel timeout could leave a fixture attempt leased far longer than the function can run.**
   Hobby functions are capped at 300 seconds. Worker leases are now 180 seconds with 30-second heartbeats, so a hard-killed worker becomes recoverable shortly after execution stops instead of remaining locked for roughly 15 minutes.

9. **Two scheduler workers could accidentally multiply concurrency and duplicate finalization AI work.**
   The scheduler now fills only free capacity up to two live attempts. Exactly one worker per scheduler tick is marked as the primary finalizer; secondary workers process fixtures only. This prevents overlapping ticks from faning out beyond the cap and avoids duplicate entailment calls during finalization.

10. **Neutral league-base fallback was incorrectly treated like an informative prior.**
    All 16 fixtures in round 264201 currently lack market snapshots and therefore use the explicit near-uniform league-base fallback. Reliability no longer applies market-divergence penalties against that fallback; the existing league-base quality penalty remains, while well-grounded Sol signals can move away from 33/33/33 without being punished twice.

11. **A paid run previously had no production dry-run of the exact 16-fixture planner.**
    A secret-authenticated plan preflight now executes the real Supabase-backed planner with provider sync disabled and stops before the research RPC. It reports fixture dispositions, task count and prior types while explicitly leaving `researchRunCreated=false` and `databaseChanged=false`.

12. **The worker endpoint itself could not be smoke-tested without risking a queue claim.**
    The internal worker now supports a read-only authenticated `preflight` mode. It validates worker auth, OpenAI environment presence and Supabase connectivity, returns active-run/attempt counts, and guarantees `attemptClaimed=false`, `researchRunCreated=false`, and `databaseChanged=false`.

## Remaining gates before first paid run

- Deploy the current branch after the Vercel Hobby daily deployment quota resets.
- Smoke-test request -> run -> scheduler -> one worker invocation without creating a paid research run where possible.
- Then trigger exactly one real round-wide research request for round 264201 and observe all 16 fixture outcomes, publication pointers and UI refresh.
- Do not trigger a second research round merely to debug deployment/configuration issues.


## Preflight evidence — round 264201

- Supabase dry-run validated all 16 canonical fixtures, distinct teams, non-empty
  competition/team names, supported settlement rules, valid leg/aggregate data,
  and an open research safety window.
- Current prior mix is 16 `league_base`, 0 market snapshots.
- A transaction-scoped call to `kapiloto_request_research` produced exactly
  one `created_run`, budget slot 1, 16 queued attempts and one request row.
- The outer transaction was rolled back. A follow-up query confirmed
  `runs_consumed=0`, no active/current run, zero research runs and zero
  attempts for round 264201.
- Winner's official `GetResults` endpoint returned HTTP 403 in two isolated
  GitHub Actions probes, including one with desktop request headers and correct
  Jerusalem DST offset. It remains observational only and is not a blocker for
  the research pipeline.


13. **Read polling and join requests could bypass the scheduler concurrency cap.**
    Round-state and fixture-analysis GET routes are now strictly read-only and never launch workers. Joining an existing run no longer launches a worker. Only a newly-created run gets one immediate non-finalizing worker for low latency; the Supabase scheduler observes that live attempt, fills at most one remaining slot, and remains the sole finalization path. Demand-worker leases now match the 180-second scheduler lease.


14. **A generic HTML `<time datetime>` could be mistaken for publication time.**
    Sports pages frequently use `<time>` for kickoff/event timestamps. Source retrieval no longer treats arbitrary time elements as article publication metadata. Only explicit publication metadata (for example `article:published_time`, publish-date meta fields or JSON-LD `datePublished`) can date a source. Time-sensitive claims from otherwise undated pages therefore fail closed.
