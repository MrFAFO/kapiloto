# Product Review 001 — Adversarial Pass

Status: initial internal review before external-model reconciliation.

## Critical / High findings

### P1 — Ticket visibility can bias the group
If members can see everyone else's picks before submitting their own, the product may create herding instead of independent group intelligence.

Recommendation:
- default to hiding other member picks until the viewer submits;
- optionally allow the admin to choose a stricter policy: reveal only after round lock;
- snapshot the visibility policy per group round.

### P2 — Consensus can become stale before lock
If the admin generates consensus and a member later edits a submitted ticket, the displayed consensus is no longer based on the current submission set.

Recommendation:
- store the exact source submission versions used by every consensus version;
- show Stale when any source submission changes;
- require regenerate before final lock, or clearly freeze the chosen consensus version.

### P3 — Round lock must come from Toto rules, not first kickoff
The pool submission deadline may differ from the kickoff of the first fixture.

Recommendation:
- model lock_at as an explicit round field from the Toto source/admin;
- never derive lock automatically from fixture kickoff.

### P4 — Raw hit rate is not enough when members use different numbers of doubles
A member using seven doubles has more coverage than a member using three.

Recommendation:
- keep raw 0–16 hits because it is intuitive;
- add an efficiency metric separately;
- never replace raw hits with an opaque composite score.

### P5 — Full-ticket AI needs preview/diff, not one-tap replacement
Replacing 16 picks at once is a high-impact action.

Recommendation:
- Kapiloto produces a proposed draft;
- UI highlights changed games and double-count delta;
- user explicitly applies all or selected changes.

## Medium findings

### P6 — Late joins and historical visibility
Decide whether a member joining today can see old group tickets and member-level history from before joining.

Suggested default: group-level history is visible; historical private member submissions before join are visible only if group policy permits.

### P7 — Missing submissions
Consensus must define eligibility when some members do not submit.

Suggested rule: only submitted tickets at the consensus source timestamp count. Drafts never count.

### P8 — Leaving or removing a member
Historical rounds must retain attribution even if the account later leaves the group.

### P9 — AI advice can dominate group behavior
Kapiloto should not visually overpower the user's own choice or democratic consensus.

Recommendation: keep AI, personal pick and group consensus visually distinct concepts.

### P10 — Reminders are likely a retention feature, not a nice-to-have
Weekly products fail when users simply forget to submit.

Recommendation: shortly after MVP add configurable reminders before lock and alerts when consensus becomes stale.

## Product questions to resolve
- Can a user belong to multiple groups? Recommended: yes.
- Can a group have multiple admins? Recommended: yes.
- Can ownership transfer? Recommended: yes before public beta.
- Does consensus use exactly max doubles or up to max doubles? Recommended default: up to max, with an option to force exactly max later.
- Are member picks visible immediately after the viewer submits, or only after lock? Recommended default: after viewer submits.
- Is Hebrew the only MVP language? Recommended: yes, while keeping schema/UI architecture translation-ready.

## Compliance / trust
Before public launch, obtain a legal review for Israeli gambling-adjacent product requirements, age-related requirements, use of Toto/Winner marks, sports-data redistribution rights, and the wording of AI prediction disclaimers.