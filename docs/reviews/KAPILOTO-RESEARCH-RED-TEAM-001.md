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

## Remaining gates before first paid run

- Deploy the current branch after the Vercel Hobby daily deployment quota resets.
- Smoke-test request -> run -> scheduler -> one worker invocation without creating a paid research run where possible.
- Then trigger exactly one real round-wide research request for round 264201 and observe all 16 fixture outcomes, publication pointers and UI refresh.
- Do not trigger a second research round merely to debug deployment/configuration issues.
