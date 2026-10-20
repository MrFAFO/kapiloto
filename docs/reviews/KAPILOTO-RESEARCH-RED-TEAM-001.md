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

## Remaining gates before first paid run

- Deploy the current branch after the Vercel Hobby daily deployment quota resets.
- Smoke-test request -> run -> scheduler -> one worker invocation without creating a paid research run where possible.
- Then trigger exactly one real round-wide research request for round 264201 and observe all 16 fixture outcomes, publication pointers and UI refresh.
- Do not trigger a second research round merely to debug deployment/configuration issues.
