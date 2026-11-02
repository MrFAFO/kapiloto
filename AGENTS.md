# Kapiloto agent instructions

Read these before changing code:
1. `docs/product/PRD.md`
2. `docs/product/MVP-SCOPE.md`
3. `docs/architecture/DATA-MODEL.md`
4. `docs/architecture/ROUND-LIFECYCLE.md`
5. `docs/ai/CONSENSUS-ALGORITHM.md`
6. `docs/ai/KAPILOTO-RESEARCH-PROTOCOL.md`
7. `docs/ai/CLAUDE-COLLABORATION-WORKFLOW.md`

## Working rules
- Keep tasks narrow. Do not redesign unrelated areas.
- Mobile-first UI is the source priority.
- Historical submitted tickets and consensus versions are immutable snapshots.
- Never conflate field result with Toto settlement outcome.
- Never expose Supabase secret keys, OpenAI keys or football-provider keys to the browser.
- Every public-schema Supabase table must have RLS before production use.
- Do not use user-editable auth metadata for authorization.
- Consensus v1 must remain deterministic and explainable.
- Kapiloto research must be source-backed, timestamped and cached/versioned.
- Update docs when a product or architecture decision changes.
- For substantial work, explicitly consider Claude both during planning/review and during implementation; follow `docs/ai/CLAUDE-COLLABORATION-WORKFLOW.md`. The user should not need to remind the agent.
- This Claude decision is a preflight gate: make it before the first substantial code/SQL/architecture edit. Sensitive work (trust, recovery, permissions, migrations, production activation, identity/replay) normally requires Claude involvement before implementation unless the change is a narrow mechanical fix proven by direct evidence.

## Quality gate
Before proposing a merge:
- run typecheck;
- run relevant tests;
- manually inspect iPhone-width layout;
- review RLS/security when data access changes.
