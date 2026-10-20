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
