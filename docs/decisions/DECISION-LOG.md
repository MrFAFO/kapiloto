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

## D-011 — Kapiloto whole-ticket tools [SUPERSEDED by D-018]
Previous decision: Kapiloto would support whole-ticket tools.
Status: superseded. Kapiloto is now fixture-scoped; Diego owns autonomous whole-ticket generation.

## D-012 — AI ticket optimization is validated deterministically
Decision: AI-generated whole-ticket output must pass deterministic Toto-rule validation; double allocation should use structured outcome scores and a deterministic optimizer rather than relying on unconstrained prose generation.
Reason: reproducibility, rule compliance and easier debugging.


## D-013 — Doubles are inferred from picks
Decision: there is no separate user control for “choose a double.” Selecting any two outcomes on a fixture automatically makes that fixture a double.
Reason: this matches the Toto mental model and removes redundant UI.

## D-014 — Kapiloto vs Diego responsibilities
Decision: Kapiloto is the fixture analyst; Diego is the user-facing AI that fills an entire 16-match ticket.
Reason: one clear scope per persona avoids overlapping whole-ticket actions.

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


## D-018 — Manual-first ticket flow
Decision: the normal ticket is always the default experience. Users fill it manually and consult Kapiloto only on specific fixtures as needed.
Reason: the core product remains a Toto form, not an AI wizard.

## D-019 — Diego fills the normal ticket
Decision: Diego is the only autonomous whole-ticket flow. It uses all 16 Kapiloto analyses, allocates doubles across the round, and writes the result into the same normal editable draft ticket.
Reason: preserves one ticket model and makes AI assistance reversible and understandable.

## D-020 — Double advice is round-relative
Decision: Kapiloto may recommend a double for a specific fixture only with awareness of the full round and remaining/allowed double budget. The UI can show a relative priority such as "3 of 7".
Reason: recommending a double has opportunity cost versus the other 15 matches.


## D-021 — Stable editable ticket + immutable submission versions
Decision: one `user_tickets` row represents the current editable ticket for a user/group/round, while every explicit submission is copied into immutable `ticket_versions` + `ticket_version_picks`.
Reason: this cleanly supports autosave, multi-device optimistic concurrency, historical reproducibility and consensus provenance without mutating past submissions.

## D-022 — Remove Kapiloto whole-consensus review
Decision: remove the old Kapiloto round/consensus review entity from Schema v1.
Reason: the approved product boundary is Kapiloto = fixture analysis and Diego = autonomous personal full-ticket generation. Group consensus remains its own deterministic group feature.

## D-023 — Sol is the Kapiloto research model family
Decision: Kapiloto's source-backed AI research uses the OpenAI Sol model family. The exact API model ID is configured server-side and stored as provenance rather than hard-coded into product logic.
Reason: Sol provides the desired research/reasoning quality while keeping recurring round-research cost materially below the higher-cost Astra tier.

## D-024 — Research is demand-driven, shared, and capped at three runs per round
Decision: no Kapiloto research executes until a user explicitly requests Kapiloto, recheck, or Diego assistance. The first qualifying request triggers one shared all-16-fixture research run when needed. Results are cached centrally for every user. A round may start at most three research runs, and stale/refresh eligibility never triggers a run without a new user request.
Reason: avoids spending AI/search budget on unused rounds, prevents per-user duplicate research, and preserves coherent round-relative double ranking.

