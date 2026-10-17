# Decision Log

## D-001 — Web first
Responsive Next.js web app, mobile-first.

## D-002 — Supabase
Supabase Auth/Postgres/RLS/Realtime.

## D-003 — Historical snapshots
Round settings, submitted tickets and consensus versions are reproducible snapshots.

## D-004 — Separate field and pool outcomes
Never overload one result field. Sporting outcome and Toto settlement outcome are separate.

## D-005 — Democratic consensus v1
Equal user voting power. Doubles split 0.5/0.5. Group doubles are allocated by estimated coverage gain.

## D-006 — Provider abstraction
Toto-round ingestion and football live-data access are behind interfaces.

## D-007 — Kapiloto caching
Research is versioned and shared per fixture rather than repeated for every user click.

## Open decisions
- Final product branding
- Football-data vendor after empirical coverage test
- Weekly Toto fixture source
- Ticket visibility before lock
- Whether consensus uses exactly max doubles or up to max doubles
- Ownership-transfer behavior in MVP


## D-008 — Mobile-first product surface
Decision: phone is the primary product surface; desktop is adapted afterward.
Reason: expected usage is predominantly mobile and the 16-match weekly workflow must optimize for one-handed use and compact scanning.

## D-009 — Inline Kapiloto fixture analysis
Decision: per-match Kapiloto consultation expands inline below the fixture instead of navigating to a separate page.
Reason: preserves ticket context and enables compare/apply/recheck without losing place in the 16-match list.

## D-010 — Fixture state is first-class UI
Decision: every game independently shows upcoming date/time, live score/minute, or final score plus hit/miss/review state.
Reason: a global live count is insufficient for a live weekly ticket.

## D-011 — Kapiloto whole-ticket tools
Decision: Kapiloto supports three ticket-level flows: recommend doubles, review current ticket, and generate a full draft.
Reason: users need both per-match research and ticket-level optimization.

## D-012 — AI ticket optimization is validated deterministically
Decision: AI-generated whole-ticket output must pass deterministic Toto-rule validation; double allocation should use structured outcome scores and a deterministic optimizer rather than relying on unconstrained prose generation.
Reason: reproducibility, rule compliance and easier debugging.


## D-013 — Doubles are inferred from picks
Decision: there is no separate user control for “choose a double.” Selecting any two outcomes on a fixture automatically makes that fixture a double.
Reason: this matches the Toto mental model and removes redundant UI.

## D-014 — Kapiloto vs Diego responsibilities
Decision: Kapiloto remains the research analyst/reviewer; Diego is the user-facing AI that fills an entire 16-match ticket.
Reason: distinct personas make the two AI jobs understandable without changing backend flexibility.

## D-015 — Username-first authentication
Decision: primary login UX is username + password. Registration requires at least one recovery contact (email or phone).
Reason: simple recurring group usage with a memorable public identifier.

Implementation note: Supabase Auth requires email or phone for password sign-in, so username resolution occurs server-side through a private alias mapping before calling Supabase Auth.

## D-016 — Remember-me behavior
Decision: “Remember me” is available and checked by default. Remembered sessions survive normal browser restarts; explicit sign-out clears the session.
Reason: weekly repeated mobile use should not create unnecessary login friction.

## D-017 — 3D brand personas
Decision: create original 3D characters for Kapiloto and Diego as a marketing/brand layer, starting with authentication/onboarding.
Reason: establish recognizable product identity and make the AI personas memorable.
