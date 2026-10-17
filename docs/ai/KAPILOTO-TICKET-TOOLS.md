# Kapiloto and Diego AI Flows

## Product rule
Manual ticket filling is the default flow.

Kapiloto and Diego have intentionally different scopes:

- **Kapiloto = one fixture at a time.**
- **Diego = all 16 fixtures at once.**

They may share backend models and research infrastructure, but their product responsibilities remain distinct.

## Kapiloto — fixture analysis

Each fixture can expand inline inside the normal ticket.

Kapiloto returns:
- primary outcome;
- recommended pick: 1 / X / 2 / 1X / X2 / 12;
- whether a double is justified;
- round-relative double priority;
- confidence;
- professional 7–8 line analysis;
- key factors;
- main risk;
- sources;
- generated_at;
- valid_until.

### Double recommendation requires round context
A double cannot be evaluated in isolation because the user has a limited number of doubles.

Therefore Kapiloto's per-fixture analysis has two layers:
1. **local fixture view** — how uncertain this game is and which two outcomes are strongest;
2. **round-relative view** — how valuable a double here is compared with the other 15 fixtures.

Example:
- local recommendation: X2;
- double justified: yes;
- round-relative priority: 3 of 7.

Kapiloto shows this advice but does not automatically change the user's pick.

### Recheck
Recheck refreshes that fixture's research and version.
If the recommendation changes, show the change and reason.
The user's current pick remains unchanged.

## Diego — full-ticket builder

Diego is the only autonomous full-ticket AI flow.

Input:
- all 16 current fixture analyses from Kapiloto;
- group max_doubles;
- current user draft, if any;
- round rules and lock status.

Process:
1. refresh stale fixture analyses when required;
2. validate structured scores for 1/X/2;
3. select the strongest base outcome for each fixture;
4. use a deterministic optimizer to allocate up to max_doubles according to marginal coverage value;
5. generate a complete 16-match draft;
6. attach/reference the underlying Kapiloto analysis for every fixture.

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
