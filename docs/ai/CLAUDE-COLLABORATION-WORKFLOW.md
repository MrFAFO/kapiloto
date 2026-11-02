# Claude collaboration workflow

This document defines when and how Kapiloto work should use Claude as a second
engineering agent. It is a standing project rule: the user should not need to
remind the primary assistant in a later conversation.

## Principle

Claude is not only a reviewer. At every substantial Kapiloto task, consider
whether Claude would materially improve either:

1. **planning / architecture / red-team**, or
2. **implementation / debugging / refactoring / test repair**.

Do not use Claude mechanically for trivial work, but do not default to working
alone on high-risk or codebase-wide work.

The primary assistant remains responsible for:
- choosing when Claude adds value;
- giving Claude a precise scoped prompt;
- reviewing Claude's output independently;
- checking repository state, tests and CI;
- making the final merge recommendation.

Claude output is evidence, not authority.

## When to involve Claude

Strongly consider Claude before or during work that includes one or more of:

- architecture or trust-boundary changes;
- database migrations, RLS, permissions or identity semantics;
- historical reproducibility / replay contracts;
- provider ingest, reconciliation or production activation;
- concurrency, idempotency, settlement or immutable snapshot logic;
- broad refactors touching several modules;
- failures whose cause is not obvious after direct runtime evidence;
- changes where an independent adversarial review can catch a class of bug the
  implementer may miss;
- a large implementation where Claude may execute faster or more reliably than
  the primary assistant.

For narrow deterministic tasks, direct implementation plus tests is normally
better than adding another agent.

## Planning-stage use

Before implementation, decide explicitly whether the task benefits from a
second design opinion.

Preferred pattern for substantial changes:

1. Primary assistant inspects the repository and forms a concrete proposed
   design.
2. Claude independently red-teams the proposal or PR.
3. Primary assistant compares the findings with runtime/code evidence.
4. Only then freeze the implementation plan.

Claude should be asked to look for contradictions and failure modes, not merely
to agree with the proposed design.

## Execution-stage use

The same judgment must be applied during implementation.

If Claude is likely to implement a difficult change better or more efficiently,
it is acceptable to hand Claude the implementation itself rather than limiting
it to review.

Examples:
- a migration + registry contract change across SQL and TypeScript;
- repairing a large failing test surface after an architectural change;
- a codebase-wide refactor with many mechanically related edits;
- implementing a fix after Claude has already performed a deep review and has
  high-quality context on the failure.

When Claude executes:

1. Give it the exact repository, branch/base and current task.
2. Tell it to fetch the latest remote branch before editing.
3. Define what it may and may not change.
4. State production-safety constraints explicitly.
5. Require focused tests and the full relevant suite.
6. Require commits/pushes, but **do not allow merge unless explicitly decided
   by the primary assistant/user**.
7. Have the primary assistant independently review the resulting diff and CI.

Do not assume Claude's implementation is correct because Claude also found the
bug.

## Avoid parallel conflicting edits

Do not let the primary assistant and Claude edit the same branch/files at the
same time unless the work is deliberately split into non-overlapping scopes.

Preferred handoff:
- primary assistant stops editing;
- Claude fetches the latest branch and performs its task;
- Claude commits/pushes;
- primary assistant resumes from Claude's pushed head and reviews it.

Parallel work is acceptable only with separate branches/worktrees and clearly
non-overlapping ownership.

## Model and effort selection

Choose the model/effort deliberately instead of always using the maximum.

### Default serious review or implementation

Use the strongest current **Opus-class Claude model** at **Extra** effort.

At the time this rule was written, the available default was:
- Claude Opus 5.5
- effort: Extra

Extra is the normal starting point for substantial Kapiloto work. It gives a
strong review/implementation pass without the cost of Max.

### Escalate to Max only when justified

Use Max selectively when:
- Extra cannot resolve an architectural ambiguity;
- a Critical/High finding remains disputed;
- the task is exceptionally consequential (for example production activation
  or irreversible migration behavior);
- the first pass is internally inconsistent or clearly incomplete;
- a focused hard problem merits deeper reasoning.

Prefer escalating only the disputed/critical scope rather than rerunning an
entire large review at Max.

### Fable

Fable is available and should be considered, not forgotten.

Use the strongest current **Fable-class model** when its long-horizon/codebase
style is advantageous, especially:
- large codebase-wide implementation;
- long multi-file execution;
- an independent second implementation/review perspective;
- cases where we want a reviewer with a meaningfully different reasoning style
  from Opus.

For especially important changes, a good pattern can be:
- Opus Extra for the main review/implementation;
- Fable as an independent second reviewer;
- Max only for unresolved high-risk questions.

Model names evolve. If newer Claude versions are available, preserve the policy
above and choose the closest current Opus/Fable equivalent rather than blindly
using these exact version numbers.

## Prompt requirements

A Claude task prompt should normally include:

- repository name;
- exact base and branch/PR;
- required files/docs to read;
- concise architectural context;
- explicit task and scope;
- invariants that must not change;
- production-safety constraints;
- concrete failure modes to inspect;
- exact tests/commands or acceptance criteria;
- whether code changes are allowed;
- whether commits/pushes are allowed;
- an explicit **do not merge** instruction unless merge is intentionally
  delegated;
- required final report format.

For a review, require findings ordered Critical / High / Medium / Low with exact
file/function, reasoning, concrete fix and merge-blocking status.

For implementation, require:
- latest branch fetch before editing;
- changed files/commits;
- exact test results;
- unresolved risks;
- confirmation that forbidden production behavior was not enabled.

## When direct evidence wins

Do not use Claude as ceremony.

If direct database/runtime evidence already proves a narrow issue, use that
evidence. Claude is most useful when:
- the change is hard to reason about locally;
- independent review is valuable;
- implementation spans multiple contracts;
- hidden coupling is plausible.

Tests, CI, database behavior and reproducible runtime evidence take precedence
over either assistant's unsupported opinion.

## If Claude is not directly connected

If the primary assistant cannot invoke Claude through an available tool:

1. Prepare the model + effort recommendation.
2. Produce a complete copy-paste prompt.
3. The user may send it to Claude.
4. The user returns Claude's full output.
5. Continue from that output without requiring the user to restate context.

Do not pretend Claude was used when no Claude execution actually occurred.
