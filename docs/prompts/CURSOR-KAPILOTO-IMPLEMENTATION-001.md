# Cursor Implementation Task 001 — Wire Kapiloto API + Inline Mobile UX

You are implementing the next Kapiloto slice in the existing repository.

## Mandatory context

Read first, in this order:
1. `AGENTS.md`
2. `docs/product/PRD.md`
3. `docs/product/MVP-SCOPE.md`
4. `docs/product/MOBILE-FIRST-UX-SPEC.md`
5. `docs/product/UX-STATE-MATRIX.md`
6. `docs/architecture/DATA-MODEL.md`
7. `docs/architecture/SCHEMA-V1.md`
8. `docs/ai/KAPILOTO-RESEARCH-PROTOCOL.md`
9. `docs/ai/KAPILOTO-RESEARCH-API-V1.md`
10. `docs/decisions/DECISION-LOG.md`

Current working branch:
`design/mobile-first-dark-stadium`

Current backend foundation already exists. Do not re-architect it.

Important existing code:
- `lib/providers/api-football.ts`
- `lib/providers/api-football-sync.ts`
- `lib/providers/api-football-supabase-store.ts`
- `lib/kapiloto/fixture-card.ts`
- `lib/kapiloto/fixture-input-store.ts`
- `lib/kapiloto/research-run-plan.ts`
- `lib/kapiloto/research-request-service.ts`
- `lib/kapiloto/server-research.ts`
- `lib/kapiloto/research-task-executor.ts`
- `lib/kapiloto/openai-research.ts`
- `lib/kapiloto/research-output.ts`
- `lib/kapiloto/source-grounding.ts`
- `lib/kapiloto/public-analysis.ts`
- `lib/kapiloto/freshness.ts`
- `lib/kapiloto/response-state.ts`
- `app/api/v1/rounds/[roundId]/kapiloto/requests/route.ts`

Database drafts:
- `supabase/drafts/001_schema_v1.sql`
- `supabase/drafts/002_rls_v1.sql`
- `supabase/drafts/003_kapiloto_research_rpc.sql`
- `supabase/drafts/004_kapiloto_attempt_rpc.sql`

## Locked product rules

Do not change these:

- Research is demand-driven.
- Zero Sol/web research before explicit user demand.
- One logical research run is shared by all users.
- One logical run covers the full 16-fixture round.
- Maximum 3 logical research runs per round.
- Plain Consult may create only run 1.
- Runs 2 and 3 require explicit Recheck / explicit refresh intent.
- Staleness alone never starts a run.
- Concurrent demand joins one active run.
- Technical retries stay inside the same logical run.
- Completed research publishes as one coherent immutable 16-fixture snapshot.
- Kapiloto is per-fixture UI.
- Diego is the only whole-ticket builder.
- A user pick is never changed automatically by Kapiloto.
- Double recommendation is group-contextual and derived from global round rank.
- User-facing confidence means analysis reliability, not win probability.
- Do not expose precise p_final win percentages in the UI yet.
- Sol remains the research model family; exact API model id is server config.
- Do not expose Supabase service role, OpenAI key or football-provider key to the browser.

## Scope of this task

Implement the application-facing Kapiloto slice. Do not attempt the final calibration/public-production research launch yet.

### 1. Finish the read-only API surface

Implement:

#### GET
`/api/v1/rounds/{roundId}/kapiloto/fixtures/{roundGameId}`

Requirements:
- authenticated user;
- require `group_id` query param;
- validate active group membership;
- validate the fixture belongs to the round;
- never create research;
- read the current published run only;
- return the safe public analysis projection from `lib/kapiloto/public-analysis.ts`;
- compute current freshness via `lib/kapiloto/freshness.ts`;
- compute group-specific `doubleRecommended` from group max doubles;
- return a stable ETag derived from run id + analysis id + freshness state;
- support `If-None-Match` and return 304;
- if no published analysis exists:
  - return 200 with a clear `unresearched` state;
  - if an active run exists, return `researching` with active run metadata;
- GET must never call provider sync, Sol or the create-run RPC.

#### GET
`/api/v1/rounds/{roundId}/kapiloto/state`

Requirements:
- authenticated user;
- require `group_id` query param and active group membership;
- read only `kapiloto_round_research_state`;
- include:
  - active_run_id;
  - current_run_id;
  - runs_used/max/remaining;
  - whether round research is closed;
  - state version;
- no research side effects.

Keep response naming consistent with the existing POST request route and `KAPILOTO-RESEARCH-API-V1.md`.

### 2. Add an application API client

Create a small typed client layer for browser components.

Suggested location:
`lib/kapiloto/client.ts`

It should expose:
- `consultFixture(...)`
- `recheckFixture(...)`
- `getFixtureAnalysis(...)`
- `getRoundResearchState(...)`

Requirements:
- generate a new UUID idempotency key for each explicit Consult/Recheck action;
- preserve the same key across network retry of the same action;
- no API/provider secrets;
- typed discriminated response states;
- AbortSignal support;
- surface 401/403/404/422/429/503 distinctly.

Do not put business rules in the browser client.

### 3. Replace the current mock Kapiloto bottom sheet

Current file:
`components/current-round-ticket.tsx`

The existing mock uses a bottom-sheet dialog. This no longer matches the locked UX.

Replace it with an **inline expandable Kapiloto panel directly under each fixture row**.

Do not redesign the whole ticket yet. Preserve the existing ticket/pick prototype behavior unless required for this task.

The panel must support these visual states:

- never researched;
- first research loading;
- researching shared run;
- fresh analysis;
- collapsed fresh analysis;
- stale analysis;
- rechecking while previous analysis remains visible;
- recommendation changed after recheck;
- research error;
- research budget exhausted;
- request rate-limited.

Required analysis display:
- exact recommendation;
- double recommendation yes/no;
- global double-priority rank and group context, e.g. `3 / 7`;
- reliability band;
- concise professional summary;
- main risk;
- last updated/freshness state;
- Recheck;
- source area placeholder/section compatible with future validated source projection.

Do not display p_final percentages.

There is no Apply button.

The user's normal 1/X/2 controls remain the only way to change a pick.

### 4. Polling / shared run behavior

When POST returns `researching`:
- keep existing previous analysis visible when present;
- poll the read-only state/fixture endpoints;
- respect `Retry-After` when returned;
- stop polling when a current published run changes or request aborts;
- do not POST repeatedly;
- do not create new idempotency keys during polling.

If another user triggered the run, the UI should converge to the same published result.

### 5. Development data boundary

The current prototype still contains hard-coded round/fixture UI data.

Do not fake a production Supabase migration as part of this task.

If the local environment does not contain an applied schema:
- keep the fixture list prototype data for rendering;
- isolate API-backed Kapiloto state behind the typed client;
- provide a deterministic dev/demo adapter or fixture-response mocks only for UI development;
- production code path must still point to the real API routes.

Do not call live Sol from Storybook/demo/UI tests.

### 6. Tests

Add tests for at least:

API/read layer:
- GET fixture never invokes research creation;
- no current run -> unresearched;
- active first run -> researching;
- current fresh analysis -> ready;
- stale analysis -> stale;
- group max doubles changes `doubleRecommended` without changing stored analysis;
- unauthorized -> 401;
- non-member -> 403;
- wrong round/fixture -> 404;
- ETag 304 path.

Client/UI:
- Consult sends exactly one POST with one idempotency key;
- network retry reuses the same idempotency key;
- polling uses GET only;
- Recheck keeps previous analysis visible;
- no Apply action exists;
- double recommendation does not mutate the user's pick;
- budget exhausted renders separately from 429 request throttling.

Continue running:
- `npm run typecheck`
- `npm run test:providers`
- `npm run test:kapiloto`
- `npm run build`

Add a focused UI/client test script if useful.

### 7. Security constraints

Do not:
- expose service-role credentials to the browser;
- accept a client-supplied `refreshEligible`;
- accept model/provider configuration from the browser;
- let GET routes create research;
- write directly to Kapiloto research tables from an authenticated browser client;
- trust `groupId` without checking membership;
- return raw model provenance/validated_output from attempts;
- return raw source-registry internals.

### 8. Do not do in this task

Do not:
- apply production Supabase migrations;
- execute live Sol calls;
- invent final p_final blend weights;
- invent final reliability weights;
- implement Diego;
- redesign consensus;
- redesign auth;
- replace the whole round/ticket UI;
- merge the PR yourself.

## Definition of done

This task is done when:

1. POST + both GET endpoints form a coherent typed API surface.
2. The 390px ticket UI has inline Kapiloto states instead of the mock bottom sheet.
3. Consult/Recheck is wired through the typed browser client.
4. Polling cannot create duplicate research.
5. Previous analysis remains visible during Recheck.
6. Group-specific double recommendation is rendered correctly.
7. Existing pick/double interaction still works.
8. Typecheck, provider tests, Kapiloto tests and build are green.
9. New API/client/UI tests are green.
10. No production migration or live Sol request was performed.

## Output required from Cursor

When finished, return:

### Summary
What was implemented.

### Files changed
Grouped by API / client / UI / tests / docs.

### Behavior
Describe Consult, cached read, Recheck, polling and budget-exhausted flows.

### Security review
Confirm each server/client boundary above.

### Test results
Exact commands and pass/fail counts.

### Remaining blockers
Anything requiring:
- Supabase migration;
- secrets;
- live OpenAI/API-Football;
- product decision.

### Commit
Return the final commit SHA(s). Do not merge.
