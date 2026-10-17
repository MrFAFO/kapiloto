# Kapiloto and Diego AI Flows

## Product rule
Manual ticket filling is the default flow.

Kapiloto and Diego have intentionally different scopes:

- **Kapiloto = one fixture at a time.**
- **Diego = all 16 fixtures at once.**

They may share backend models and research infrastructure, but their product responsibilities remain distinct.

## Research execution policy

Kapiloto research is **demand-driven and shared per Toto round**.

Rules:
- No Sol call and no AI web research runs merely because a new round exists or time has passed.
- The first user request for a Kapiloto recommendation, Kapiloto recheck, or Diego full-ticket recommendation may trigger research when no usable shared research exists.
- A triggered research run covers **all 16 fixtures**, even when the initiating user opened only one fixture. This keeps outcome scores and round-relative double priority internally consistent.
- Every completed run is stored centrally and reused by all users.
- A round may start **at most 3 research runs**. Bounded technical retries for the same run keep the same run number.
- Freshness/staleness can make another run eligible, but eligibility alone never executes research. A later user request is still required.
- If the three-run budget has been exhausted, return the newest available analysis and clearly expose its freshness/staleness state instead of silently starting a fourth run.
- Diego counts as explicit user demand. If Diego is requested before Kapiloto has research for the round, it can trigger the first shared run.
- The approved model family for research is **Sol**. The exact OpenAI API model ID remains server configuration rather than being hard-coded into product logic.
- Research creation must use a **single-flight / idempotent round lock** so concurrent first requests cannot launch duplicate runs.

## Kapiloto — fixture analysis

Each fixture can expand inline inside the normal ticket.

Kapiloto presents:
- primary outcome derived from the research scores;
- recommended pick: 1 / X / 2 / 1X / X2 / 12;
- whether a double is justified for the current group's budget;
- round-relative double priority derived deterministically from all fixture scores;
- confidence;
- professional 7–8 line analysis;
- key factors;
- main risk;
- sources;
- generated_at;
- valid_until.

### Double recommendation requires round context
A double cannot be evaluated in isolation because the user has a limited number of doubles.

Shared research does not persist a universal `double_recommended` flag because groups may have different max-double settings. The server derives one global priority ranking from the shared scores and applies the viewing group's configured budget.

Therefore Kapiloto's per-fixture analysis has two layers:
1. **local fixture view** — how uncertain this game is and which two outcomes are strongest;
2. **round-relative view** — how valuable a double here is compared with the other 15 fixtures.

Example:
- local recommendation: X2;
- double justified: yes;
- round-relative priority: 3 of 7.

Kapiloto shows this advice but does not automatically change the user's pick.

### Recheck
Recheck is an explicit user request for newer research relative to the currently published run. If refresh eligibility passes, it creates the next shared round-wide research run for all 16 fixtures; it does not run an isolated one-fixture model call.

If another user already started that run, Recheck joins the same active run. If a newer run was already published, the request returns that newer snapshot and creates nothing.

If the recommendation changes, show the change and reason. The user's current pick remains unchanged.

## Diego — full-ticket builder

Diego is the only autonomous full-ticket AI flow.

Input:
- all 16 current fixture analyses from Kapiloto;
- group max_doubles;
- current user draft, if any;
- round rules and lock status.

Process:
1. pin exactly one completed Kapiloto research run for all 16 fixtures;
2. if no completed run exists, create/join run 1 and wait for user-visible completion;
3. never refresh implicitly merely because research is stale; explicit refresh-and-build uses the same Recheck path;
4. validate structured scores for 1/X/2;
5. select the strongest base outcome for each fixture;
6. use a deterministic optimizer to allocate up to max_doubles according to marginal coverage value;
7. generate a complete 16-match draft;
8. attach/reference the underlying Kapiloto analysis for every fixture.

Output:
- one pick for all 16 fixtures;
- exact double allocation;
- explanation for the key decisions;
- same normal ticket UI, already filled;
- inline Kapiloto explanation still available on every game.

## No separate Diego ticket
Diego does not create a different ticket type.

The flow is:
Diego generation -> normal editable draft ticket -> user review/edit -> user submit.

## Deterministic validation
The server validates:
- exactly 16 active fixture picks;
- only legal Toto pick values;
- double count <= group max;
- round still editable;
- proposal references current/accepted fixture-analysis versions.

If model output violates rules, repair or reject it before showing it as a ready draft.

## Provenance
Store:
- Diego proposal version;
- input Kapiloto analysis IDs/versions;
- optimizer version;
- generated_at;
- proposed picks;
- double-allocation rationale;
- whether the user accepted, edited or discarded the generated draft.

## Relationship to group consensus
Diego is personal assistance for one user's ticket.
The democratic group consensus remains a separate deterministic group feature.
