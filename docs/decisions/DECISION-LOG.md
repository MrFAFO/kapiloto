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

Caveats:
- the Israeli fixtures returned zero injury rows in the original full-round spike, so structured injury coverage must not be treated as complete for Israel;
- a repeat run on 2026-10-20 resolved only 3/16 because the Free plan exposed a rolling date window of 2026-10-19 through 2026-10-21. The earlier 16/16 result was obtained while the full sample was still inside the Free window. Free is therefore not a durable historical/backfill source and cannot be relied on as the production weekly horizon without timely persistence or a broader paid/fallback source.

Kapiloto availability research continues to rely on verified web/official evidence and may use provider injury data only as one structured input.

Reason: API-Football demonstrated full-round mapping and strong market-prior coverage while fixtures were inside its accessible horizon, but the provider abstraction and persistent snapshots are mandatory because plan/date access can materially change observed coverage.

## D-034 — Canonical Fixture is the shared football identity
Decision: introduce a canonical `fixtures` entity that exists independently of Toto/Winner rounds. `round_games` becomes a Toto-specific wrapper that points to `fixture_id` and owns Toto order/orientation, group-ticket linkage and settlement semantics.

Provider fixture mappings and market snapshots are fixture-scoped. Transitional `round_game_id` links remain only for compatibility while callers migrate.

Reason: Match Intelligence and future non-Toto products must be able to represent and analyze football matches that are not part of a Toto round. Using `round_games` as the football identity would permanently couple the intelligence layer to one product surface.

## D-035 — Structured metrics require explicit provenance
Decision: every structured metric shown or consumed by Kapiloto must be either an immutable raw provider fact or a versioned deterministic derived fact. Raw facts store provider/source metadata; deterministic facts store a calculation version and explicit input-fact edges. AI interpretation remains a separate third layer in Kapiloto analysis/factor/evidence tables.

Reason: prevents generated or inferred values from being presented as observed analytics, makes provider differences auditable, and allows derived metrics to be reproduced and recalculated safely.

## D-036 — Multi-provider football data uses capability-specific fallback
Decision: do not designate one provider as universally authoritative for all football data. API-Football remains the proven broad fixture/1X2 market-prior fallback, while Sportmonks is the preferred rich performance-analytics source where entitlement and competition coverage are empirically verified. Missing Sportmonks metrics fall back by capability/competition rather than being fabricated.

Evidence: across the two Sportmonks trial rotations for Winner 16 round 264101, all 16 fixtures were resolvable when their competitions were entitled. Premier League, La Liga, Serie A, Bundesliga and Ligue 1 samples returned rich statistics, xG-family data and Pressure Index. Israeli Ligat ha'Al/Liga Leumit samples returned statistics and Pressure Index but no xG rows in the tested fixtures. Sportmonks pre-match 1X2 bookmaker triples were not observed in these runs.

Reason: provider coverage is metric- and competition-specific. Capability routing preserves breadth while exploiting richer analytics where actually available.

## D-037 — Reliability/blend v1 is a shadow candidate, not a calibrated claim
Decision: implement a deterministic shadow derivation candidate under the explicit versions `kapiloto-reliability-shadow-v1` and `kapiloto-blend-shadow-v1`. Reliability uses dimension coverage, verified source quality, grounding failures, unresolved conflicts, data-quality flags and prior divergence. The shadow blend uses reliability as the prior-vs-Sol weight and always renormalizes to exactly 10,000 basis points.

The shadow formula clamps reliability away from extreme certainty and is used to generate reproducible evaluation data. It is not treated as empirically calibrated, and precise user-facing win probabilities remain gated on forward calibration evidence.

Reason: publication needs deterministic picks/double ranks now, but product claims must not outrun calibration evidence.

## D-038 — Kapiloto publication is one atomic immutable graph
Decision: a run is not published by a sequence of client-side inserts. The service first validates/grounds/derives all fixture outputs, then a service-role transaction materializes analyses, evidence, factors and input provenance for the complete 16-fixture set. Only after all rows validate does the same transaction mark the run completed, flip the Toto round `current_run_id`, and advance each canonical fixture's intelligence publication pointer.

Analyzed fixtures require accepted quote-verified evidence, and material factors with pending entailment verification are blocked before materialization.

Reason: immutable analysis tables make partial publication especially dangerous. One transaction prevents half-published rounds, mismatched fixture pointers and irrecoverable partial provenance.

## D-039 — Winner 16 discovery is staged before authoritative import
Decision: automate current-round discovery separately from database import. The first automated adapter is Telesport for round number, ordered 1..16 fixtures, listed teams, competition labels and any published kickoff times. It is treated as a non-authoritative discovery/fallback source.

A discovered round may enter the canonical import transaction only when all 16 kickoff timestamps are resolved and an explicit authoritative Toto lock time is supplied. Missing times, ambiguous rows or absent lock time block import rather than being inferred.

Reason: public Winner 16 pages are useful for fast weekly discovery but can expose incomplete kickoff fields and do not establish the official betting lock. Separating discovery from import gives Kapiloto automation without contaminating historical round snapshots with guessed values.

## D-041 — Research v2 measurement runs as an isolated shadow evaluation
Decision: before changing the Kapiloto research pipeline, add a shadow evaluation layer that scores, on the 90-minute field result, five arm families under one deterministic selection rule: uniform, league base rate, a deterministic Elo `p_stat`, a de-vigged multi-bookmaker market prior, and the published Kapiloto `p_final`/`p_sol`. Predictions and scores are append-only, server-only tables (RLS, no client grants). Issue times are stamped by the database, and LLM arms are forward-only. The arms never feed `p_final`, picks, doubles, grounding, finalization or the UI.

`p_stat` v1 is Elo, not Dixon–Coles, because production holds only team-scoped history (about 340 matches) and no league-wide results. A league results store and ingestion are added so that richer models can later be compared on the same forward data. The market arm uses per-bookmaker power de-vig and a median, requires at least two bookmakers no older than 24 hours, and returns no prediction otherwise.

Reason: the Run 5/6 audit showed the current pipeline cannot be judged without baselines and leakage-safe scoring. No arm is presumed better; production prior, research and recommendation changes wait for forward evidence. Details: `docs/ai/KAPILOTO-SHADOW-EVALUATION-V1.md`.

## D-042 — Shadow evaluation activates through one gated, budgeted cron cycle
Decision: production shadow evaluation runs as a single internal cron route (`/api/internal/cron/shadow-evaluation`), protected by `CRON_SECRET`, off unless `KAPILOTO_SHADOW_EVALUATION_ENABLED=true`, with market capture separately gated by `KAPILOTO_SHADOW_MARKET_CAPTURE_ENABLED=true`. The route is the only production module allowed to import evaluation code, and it writes only the shadow tables.

API-Football quotes are captured on an adaptive cadence: daily from 7 days out, every 3 hours inside 48 hours, hourly inside 6 hours, and one forced final capture in the 75 minutes before the evaluation deadline. An hourly scheduler selects only due fixtures. The provider is protected by per-run and per-day request budgets and a reserve on its own reported quota. Every attempt, including budget skips and failures, is recorded.

The database, not the writer, stamps every leakage-relevant time. It also enforces the selection rule on score insert (no post-deadline prediction, no fallback to an older one) and requires Kapiloto projections to carry exactly the published probabilities.

Reason: forward evidence must accumulate without any path back into recommendations, and without exhausting the provider quota the production market sync depends on. A full round costs roughly 550 provider requests per week under this cadence, so capture stays off until the plan's quota is verified.