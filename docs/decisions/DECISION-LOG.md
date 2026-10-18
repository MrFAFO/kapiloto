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

## D-025 — Atomic round snapshots for Kapiloto research
Decision: Kapiloto research uses one lockable round-state row, separate logical runs and execution attempts, immutable analysis snapshots, and a single `current_run_id` publication pointer.
Reason: database-enforced single-flight, retry safety, crash recovery and coherent 16-fixture snapshots for users and Diego.

## D-026 — Explicit refresh after the first run
Decision: a normal Consult may create the first round research run. Runs 2 and 3 require explicit Recheck or explicit Diego refresh intent and must pass freshness/rate-limit gates. Staleness by itself never creates research.
Reason: preserve the shared three-run budget for meaningful later information without adding a separate final-run confirmation step in MVP.

## D-027 — Diego pins one Kapiloto research run
Decision: every Diego proposal references exactly one completed Kapiloto research run and may not combine per-fixture analyses from different runs.
Reason: preserves internally consistent scores and round-relative double ranking.

## D-028 — Kapiloto probabilities are server-derived from Sol plus a prior
Decision: Sol returns raw pre-match home/draw/away probability estimates (`p_sol`). The server combines them with a versioned market/rating/league prior, deterministic analysis reliability, blend/deviation policy and optional fitted calibrator to produce `p_final`. All picks and double ranking use `p_final`, never raw Sol output.
Reason: double allocation requires comparable probabilities across fixtures, while an external structured prior reduces narrative/model overconfidence and keeps deterministic policy outside the LLM.

## D-029 — Market and fixture context are structured inputs, not web facts
Decision: fixture identity, Toto 1/2 orientation, 90-minute settlement rule, neutral venue, kickoff/cutoff, competition-leg context and the preferred de-vigged market prior are supplied by the server in a frozen fixture card. Sol uses web search for qualitative evidence, not for scraping odds or deciding settlement semantics.
Reason: prevents wrong-market, stale-odds, home/away-swap and qualification-vs-90-minute errors.

## D-030 — Claim-level evidence must be grounded
Decision: material Sol evidence carries a retrieved URL, short supporting quote and structured claim. Server code canonicalizes the URL, verifies the quote against retrieved content, extracts publication time, assigns source trust by claim type and enforces the research cutoff. Medium/large score-moving factors require stronger verified support; entailment verification is required before public production.
Reason: a valid URL alone does not prove that the cited page supports the model's claim.

## D-031 — User-facing confidence means analysis reliability
Decision: numeric/model self-confidence does not directly drive the UI. A versioned deterministic reliability score is derived from evidence coverage/quality, conflicts, recency, prior divergence and later empirical stability. User-facing confidence bands represent research reliability, not the probability that the recommended outcome occurs.
Reason: separates outcome uncertainty from confidence in the evidence/research process.

## D-032 — Fixture fan-out is the preferred research topology, pending shadow comparison
Decision: the worker architecture supports both a whole-round batch arm and fixture-scoped fan-out. The preferred first implementation is one task per eligible fixture with bounded concurrency and fixture-scoped retries, followed by deterministic round synthesis and atomic publication. Whole-round execution remains a shadow comparison arm until quality/cost data settles the choice.
Reason: deterministic server synthesis removes the need for one 16-game model context, while fan-out improves isolation, retry cost and grounding depth.

## D-033 — API-Football is the provisional MVP structured provider
Decision: use API-Football as the first structured fixture/market provider for MVP implementation, behind the existing provider abstraction. This is provisional and remains replaceable by Sportmonks or another provider.

Evidence: live spike on Winner 16 round 264101 resolved 16/16 fixtures, returned pre-match 1X2 odds for 16/16 fixtures with an average of 5.94 complete bookmakers, observed lineups on all six already-finished fixtures, and observed injury rows on 11/16 fixtures.

Caveat: the Israeli fixtures returned zero injury rows in this spike, so structured injury coverage must not be treated as complete for Israel. Kapiloto availability research continues to rely on verified web/official evidence and may use provider injury data only as one structured input.

Reason: API-Football demonstrated full round mapping and market-prior coverage at low MVP cost, which are the two hard dependencies for the frozen fixture card and p_prior pipeline.
