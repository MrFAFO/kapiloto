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

## D-043 — API-Football fixtures resolve by provider ids first, names only as bootstrap
Decision: API-Football fixture resolution uses, in order: a mapped API-Football fixture id; same-date candidates within 3 hours of the Toto kickoff, filtered to the mapped API-Football competition when one exists; confirmed API-Football team ids (both known: they decide alone; one known: the other side must still pass the name threshold); and only when no team id is known, a name bootstrap over the Hebrew canonical name, Hebrew aliases, provider-named aliases and other providers' confirmed English names (Sportmonks). A fixture listed with home and away swapped is rejected as `orientation_mismatch`, and two plausible candidates are rejected as `ambiguous`; neither is ever guessed. Candidates come from every UTC date the kickoff ±3h window touches; if an adjacent date cannot be read, only a provider-id match is accepted. Hebrew canonical names are unchanged.

Persistence: a market sync writes `confirmed` only for mappings backed by provider-id evidence (a trusted fixture mapping, or the mapped team or competition id matching). Anything resting on a name bootstrap is inserted as `unverified` with `ON CONFLICT DO NOTHING`, so it never overwrites or downgrades an existing mapping, and resolution ignores it. Unverified fixture mappings are likewise never used as a provided fixture id. One name match therefore cannot steer later runs; promotion to `confirmed` needs provider-id evidence, an operator, or a verified seed.

Verified mappings from the 2026-10-24 probe of round 264201 (30 teams, 5 competitions, and the provider alias `Hapoel Katamon` for Hapoel Jerusalem) are prepared as an additive, idempotent data migration that never overwrites an existing mapping.

Reason: Kapiloto's team names and aliases are Hebrew, while API-Football names are English, so the previous weighted fuzzy score resolved 0/16 fixtures of a real round and production had never stored a market prior. English names from the existing Sportmonks mappings resolved 15/16 (the 16th was outside the Free plan's date window); one club needed a provider-specific alias. Provider ids make the match deterministic and remove repeated fuzzy matching.

## D-044 — Shadow route uses the worker convention and a Free-plan cadence by default
Decision: `/api/internal/cron/shadow-evaluation` is `POST`-only, authorized with the research worker's secret (`KAPILOTO_WORKER_SECRET_SHA256`, timing-safe hash check), and acknowledges with `202` before running the cycle through Next.js `after`, so a `pg_net` caller's timeout never cuts the work. The `GET`/`CRON_SECRET` path is removed. It is scheduled by Supabase `pg_cron` (not created yet), not Vercel Cron. `{"preflight": true}` reports switches, cadence and budget without doing work.

The market cadence defaults to the API-Football Free profile: T-24h, T-6h and the forced final capture before the deadline; the 7-day adaptive cadence (D-042) runs only with `KAPILOTO_SHADOW_MARKET_CADENCE=adaptive`, and any other value keeps the cheap profile. A known API-Football fixture id is now found in the day list already fetched for the run, so known fixtures share one request per date instead of one by-id request each.

Reason: the Free plan (100 requests/day, today ±1) cannot serve captures beyond 24 hours, and the forward evaluation scores the latest pre-deadline prediction, so earlier snapshots add cost without changing the scored forecast. Reusing the worker authentication and deferred-work pattern keeps one internal-auth convention for every scheduled route.

## D-045 — Research v2: deterministic base, verified evidence, bounded deterministic adjustment
Decision: the Kapiloto predictor is rebuilt as a deterministic base (league base rate, Elo `p_stat`, a reserved goal-model stat arm, de-vigged market), research triage, Sol evidence discovery without probabilities, server verification (observed URL, fetched page, verbatim quote, dated before the cutoff, freshness, entailment, source quality, syndication, structured duplication), Sol impact interpretation in a closed vocabulary, and deterministic combination and recommendation. Holistic `p_sol`, reliability-as-blend-weight, checklist reliability, the uniform prior presented as a baseline and same-plan fan-out are removed from the target design.

Evidence known before a fresh, standard market snapshot is `market_likely_incorporated` and does not shift probabilities; later evidence may shift them; with a missing, stale or thin market, verified earlier evidence may adjust only the stat input. The decision is stored per adjustment.

Every weight, threshold and effect size is a versioned candidate, hashed into each output, and none is selected; candidate arms run side by side for forward evaluation. Round 264201 is live development only and is excluded from formal sampling, which stays disabled until Research v2 is explicitly approved. Foundations live in `lib/research-v2` (shadow-side; no production import). Details: `docs/ai/KAPILOTO-RESEARCH-V2.md`.

Reason: the Run 5/6 audit showed a uniform prior, near-uniform `p_sol` anchored on it, 91% "small" factors, half of them restating structured data, a third of cited evidence unverifiable and `p_sol` never recomputed after grounding. Separating deterministic probabilities from verified evidence makes every forecast reproducible and every change traceable to verified claims.

## D-046 — Research v2: provider market time, explicit unknowns, competition membership and Elo cold start
Decision: market time is versioned as `market-state-v2` inside `base-v2`. A price's information time is the provider's last update (Kapiloto's retrieval only when earlier), freshness and staleness are measured from the oldest price used, and a quote without a provider update time can never support `standard`. `adjustment-policy-v2` refuses any other market state, takes freshness from the oldest price and allows `full` only for evidence published after the newest price used.

Triage inputs distinguish unknown from "checked, nothing found": manager changes, unresolved availability, rest, recent-load and stat match-count gaps are listed as data gaps (0 points in `triage-v2`) and create no research need by themselves. "Promoted" is removed: `membership-v1` derives only `newToCompetitionThisSeason` (absent from the competition's previous season) from stored history, using provider season ids and, when they are missing or overlap, a 60-day inactivity gap; a previous season starting less than 14 days after the history window is treated as possibly truncated (unknown).

An Elo side with fewer than 20 rated matches, or new to the competition this season, is cold-start (with no count and no such signal it is unknown, never assumed): market/stat disagreement is then not scored, the `market_stat_gap` need is replaced by `stat_cold_start_context` (0 points) and the output carries a `p_stat_elo_v1:cold_start:<side>` flag. Elo values are unchanged. The live-dev artifact schema is v2 and runner v2 refuses v1 artifacts on replay; there is no legacy replay path. All values are candidates.

Reason: the read-only audit of the first live-dev artifact (2026-10-25) found prices 177–207 minutes older than the recorded 0–1 minute retrieval age, so evidence published between the provider update and retrieval would have been treated as already priced; unknown manager/availability/promotion inputs were read as "no signal"; and a side in its first 7 Premier League matches still carried most of its 1500 starting rating, which triage presented as a genuine market/stat gap. No value was chosen from round 264201 outcomes.

## D-047 — Research v2 discovery and evidence verification design
Decision: Sol discovery uses the OpenAI Responses API built-in `web_search` with strict Structured Outputs and returns factual claims only, driven by triage needs with explicit effective sides; it never outputs probabilities, a winner, a recommendation, a pick or double, a direction or a magnitude. The Sol impact stage is retired: verified claims map to adjustments through the deterministic `impact-rules-v1` (forecast-changing kinds: absence, suspension, doubtful, expected_return, rotation_statement; everything else explanatory), with effect sizes unchanged.

Citations are verified independently (observed in the call's recorded web-search sources, SSRF-safe fetch, separate `publishedAt`/`modifiedAt` proven at or before an immutable `knowledgeCutoffAt` = `researchStartedAt` with a UTC−12 date-only rule, quote and entity in a bounded evidence window, source grade); claims are decided on accepted citations and independent origin clusters, and every forecast-changing claim needs a `gpt-6-luna` entailment judgment (no tools, medium reasoning). Research runs only on a base captured at most 15 minutes earlier, with market state revalidated at the knowledge cutoff; eligibility is checked before the first call and again at `evidenceCutoffAt`.

Budgets separate the hard `max_tool_calls` cap from audited search targets; a cost ledger records tokens, billable web-search calls and fees; a spend guard ($0.75 per fixture, $3.00 per live-development run) is checked before every model call, including retries and the judge. Live-development artifacts keep evidence windows and hashes, never full article bodies. All values are candidates. Details: `docs/ai/KAPILOTO-RESEARCH-V2-DISCOVERY.md`.

Reason: Research v1 let one model research, cite, grade and weigh its own evidence, checked entailment for a third of claims and spent searches on generic topics. Separating discovery from deterministic verification and sizing makes every adjustment traceable, bounds cost, and keeps numeric forecasting out of model prose.

## D-048 — Research v2: judge side identity and cache-write pricing
Decision: `entailment-v2` sends the judge the fixture's two clubs (`fixture_sides`: home and away, each with its English name and source-language names, the same allow-listed names Sol receives) and defines `home` as the listed home team and `away` as the listed away team. The identity is for side resolution only and is not evidence; side is entailed only when the window itself ties the subject to that club, every other field still needs the window alone, and no probability, rating, odds, market, triage, adjustment, recommendation or result reaches the judge.

`pricing-v2` adds the Standard short-context cache-write rates (gpt-6.1-sol: $2.50/M for the 30-minute TTL, $5.00/M for the 12-hour TTL; gpt-6-luna: $0.125/M and $0.25/M). Cache writes are never priced as ordinary input. Their lifetime is taken, in order, from the usage breakdown `cache_write_tokens_details` (`ttl_30m_tokens`, `ttl_12h_tokens`, which must reconcile with the total, else the remainder is charged at 12 hours and the cost marked uncertain), the TTL the response reports it applied (`prompt_cache_options.ttl`), and the request's effective `prompt_cache_options.ttl` (default `30m`; `12h` only when the request selects it). Only a lifetime that cannot be established is charged at 12 hours and marked uncertain; the deprecated `prompt_cache_retention` never decides the price. The discovery and judge request configs (`discovery-request-v2`, `entailment-v2`) carry an explicit `promptCacheTtl` (`30m`, the default, so it is recorded but not sent), and `cost-ledger-v2` records each call's effective TTL and write split. `spend-guard-v2` projects up to 12,000 discovery input tokens and all judge input at the request TTL's write rate; the $0.75 per-fixture and $3.00 per-run caps are unchanged. Artifacts captured earlier keep their recorded versions and replay unchanged.

Reason: in the first real live-dev run (game 1, 2026-10-25) both Sport5-sourced away absences failed entailment only on `side`, because the judge was told "away" without being told which club that is; and both models reported cache-write tokens that pricing-v1 billed as ordinary input. That run sent no `prompt_cache_options`, so its writes take the documented 30-minute default: $0.094964 instead of the recorded $0.092289 (+$0.002675); its responses' TTL breakdown and applied TTL were not recorded, so the split cannot be verified. No value was chosen from match outcomes.

## D-049 — V4 Foundation 1A: canonical players/coaches and a bitemporal Match Ledger
Decision: V4 gets its own data spine, additive to V3 and not read by it yet. Players and coaches are canonical UUID entities; provider ids are mappings (`unique (provider, entity)`, so two provider ids never collapse silently) and spellings are aliases that are unique per entity only, so an alias matching several entities is ambiguous and never auto-resolved. Duplicates are repaired by explicit one-hop merges; no fuzzy resolution exists. `fixtures` and `teams` stay the canonical match and team identities. The Match Ledger stores immutable provider observation versions per fixture (team context, matchday squads, paired substitutions, typed events, typed/versioned team stats, a derived game-state segment contract). `first_seen_at` is stamped by a database clock (`clock_timestamp()` when the header is written, after per-fixture locks), children are sealed to the header's writing statement, corrections are new versions, wrongly attached data is retracted by a header-only withdrawal version, and every as-of read filters on `first_seen_at <= cutoff` before choosing the latest version and only then on event time. History reads are provider-scoped (one row per fixture); a fused multi-provider history is a later, separate API. Completeness, mapping consistency, stat-provider identity and staff-card rules are enforced in the database; identity, versioning and provider-fixture claims are serialized by advisory locks under READ COMMITTED. Ingestion goes through `match_ledger_record_observation` (service_role only, security invoker). Details: `docs/architecture/KAPILOTO-V4-FOUNDATION.md`.

Reason: V3 can only reach lineups through reported web XIs, and the Fixture Card has no per-match lineups, minutes, substitutions or coaches. Every later V4 model needs that history, and providers backfill and correct data after matches. Without information-time discipline, training and replay would silently use data Kapiloto did not have at the cutoff.

## D-050 — V4 canonical identity: merges are retroactive in model-facing reads, writes take survivors only
Decision: A canonical merge (A → B) is a data-quality correction, not football information. Match Ledger rows stay immutable and keep the ids they were written with; model-facing reads (`match_ledger_provider_player_matches_as_of`, team-history coach columns, `team_coach_tenures_as_of`, alias and provider-mapping resolution) use the current survivor at every cutoff, while `first_seen_at` still governs which football facts are visible. A merged id passed to a read redirects to the survivor, and rows report observed and canonical ids. Ingestion rejects merged ids in every position before the hash comparison; there is no silent canonicalization, so stored ids and `content_sha256` never diverge. A merge is refused when both identities appear as two people in one stored observation version (players in one squad; coaches on opposite sides), superseded versions included, because earlier cutoffs still read them. Player/coach mapping writes and merges serialize against ledger writes through per-table identity locks. `provider_fixture_mappings` (V3) is not serialized against the ledger; drift is detected by `match_ledger_mapping_conflicts`, and a unified mapping/ledger writer is a hard requirement of the ingestion task. Mis-attribution (a provider id mapped to the wrong real person) is repaired by a corrected version and is not retroactive in 1A. Details: `docs/architecture/KAPILOTO-V4-FOUNDATION.md`.

Reason: Without merge-aware reads, an explicit merge would leave a player's or coach's history fragmented across ids, defeating the merge. Exact historical model inputs are preserved by the Foundation 1B prediction registry rather than by versioning the identity graph.

## D-051 — V4 Foundation 1B: document archive, claim truth history and an immutable prediction registry
Decision: V4 separates documents (observed source material) from document versions (immutable observations with content hash, bounded text, external raw-media pointers and rights provenance), claims (structured propositions deduplicated by a fingerprint of every structured dimension, never by prose), claim observations (what one version says, rights-gated quotes, syndication-aware independence), claim relations (typed provenance; derived_from/supersedes/refines acyclic) and claim resolutions (append-only adjudications on the lattice unresolved/verified/verified_degraded/quarantined/contradicted/fabricated with typed evidence foreign keys). Derived kinds (inference, matchup hypothesis, scenario, probability adjustment) must cite premises and are never observed in documents. Missing metadata is verified_degraded or quarantined, never fabricated, which accepts only fabrication reason codes. Every `first_seen_at` is stamped by the 1A information clock and every as-of read filters on it first, so later truth (including post-match resolutions) is invisible to earlier cutoffs. Prediction snapshots are immutable scientific records, distinct from V3 analyses and Research v2 shadow arms: they freeze code/protocol/model/prompt/feature versions, outputs (basis points summing to 10,000, uncertainty, bounded payload without hidden reasoning), the exact input rows (ledger versions, document versions, claims with the exact resolution version, claim observations, market/structured/fact snapshots) and identity bindings. The recording RPC refuses any input first seen after the prediction cutoff, any cutoff after the canonical fixture kickoff and any fixture-scoped reference of another fixture, verifies the input-bundle hash against the link rows at commit, and replays only the same idempotency key. Identity bindings name active canonical ids at recording time and are never changed by later merges. Legacy V3 research rows are referenced only by soft provenance ids (no foreign keys, no validation, never leakage evidence). Details: `docs/architecture/KAPILOTO-V4-KNOWLEDGE-REGISTRY.md`.

Reason: Source reliability, contradiction resolution, post-match truth, lineup and tactical learning, champion/challenger and calibration all need durable, time-correct records of what Kapiloto read, believed and predicted. V3 evidence is per-analysis and binary, and drops true information when metadata is missing. Without frozen inputs and identities, a later backtest would silently use corrections, truth and identity merges the live prediction never had.

## D-052 — V4 canonical claims follow identity merges; prediction identities and provenance are time-ordered
Decision:
- Raw claim rows stay immutable with the fingerprint they were recorded with, and prediction snapshots keep the exact raw claim, resolution and identity ids they used.
- The current canonical proposition is the group of raw claims whose fingerprints coincide once player/coach subjects resolve to their D-050 survivors; every other dimension must match exactly.
- `knowledge_record_claim` joins that group instead of creating a duplicate. Model-facing claim reads (`knowledge_claim_resolutions_as_of`, `knowledge_claim_support_as_of`) aggregate the group.
- The representative is the earliest member. A merge that makes several raw claims one proposition is a visible collision (`knowledge_canonical_claims`), never hidden and never a reason to block the merge.
- Prediction identity bindings must name an active canonical id, and any observed id must resolve to it.
- Every claim relation is first seen no earlier than both endpoints, and a derived claim no earlier than the premises it was created with, so a cutoff can never see a derived claim before its premises.
- `observation_count` is raw extraction volume; corroboration uses `independent_source_count`.

Details: `docs/architecture/KAPILOTO-V4-KNOWLEDGE-REGISTRY.md`.

Reason: D-050 treats a merge as a data-quality correction. Without merge-aware claim identity, the knowledge layer would split one proposition into two claims with separate evidence and truth histories. Without observed-id and provenance ordering, the registry could record an impossible identity pair or a conclusion visible before its premises.

## D-053 — V4 roster membership and deterministic pre-match squad state
Decision:
- **Roster assertions.** Roster membership is stored as immutable, versioned assertions (`team_player_memberships`): a source says a player belongs to a team within inclusive, uncertain date bounds. Corrections and retractions are new versions under a per-key lock, `first_seen_at` is database-stamped, and writes name D-050 survivors while reads expose observed and canonical ids. Overlapping assertions are allowed and never turned into transfer truth.
- **Raw inputs, pure derivation.** `squad_state_inputs_as_of` returns cutoff-filtered raw inputs and fails closed only for an unresolvable fixture or team or a cutoff after the canonical kickoff. The pure `buildFixtureSquadState` derives the squad state in memory (`kapiloto-squad-state-v1`); it is not persisted.
- **History selection.** One ledger observation per historical fixture: complete over partial, then explicit provider priority (`kapiloto-history-selection-v1`), never blended, with reasons recorded. The latest 10 selected fixtures are used.
- **Candidates.** The universe is the union of active or possible roster, selected history, and attributable target-fixture availability and lineup claims (`historical_only` and `claim_only` kept, never pruned).
- **Features (`kapiloto-squad-features-v1`).** Raw counts with per-feature knownness: start, appearance and minutes each have their own known denominator, and unknown is never zero. A `complete` lineup structurally proves only its 11 starters, so absence from it means "did not start" and nothing else; squad negatives are never inferred in V1. Full regulation starts need explicit minutes of at least 90.
- **Target date.** Membership and tenure coverage use the kickoff's UTC calendar date (`kapiloto-target-date-utc-v1`), which is deterministic but not necessarily the local football date.
- **Evidence.** Accepted availability evidence is verified/verified_degraded only; unresolved is evidence, never a conclusion; quarantined/contradicted/fabricated are audit only. Conflicting accepted categories set `availability_conflict` and pick nothing (`kapiloto-availability-normalization-v1`). Reported lineups remain evidence.
- **Coach state.** Reported as `ledger_and_tenure`/`ledger_only`/`tenure_only`/`conflict`/`unknown`; no coach is invented on conflict.
- **Scope gate.** 1C produces no lineup probability. Before any 1D lineup model powers a persisted prediction, the Prediction Registry must gain a versioned way to freeze roster-membership and coach-tenure inputs without changing existing `kapiloto-prediction-snapshot-v1` meaning or hashes.

Details: `docs/architecture/KAPILOTO-V4-SQUAD-STATE.md`.

Reason: Availability, expected lineups, minutes and replacements all need a reproducible, leakage-free picture of the squad before kickoff. Without explicit provider fusion, partial-data denominators and evidence standing, a lineup model would double-count matches, mistake missing data for absence, or let a single unverified report decide the team.

## D-054 — V4 lineup forecast baseline and Prediction Registry V2
Decision:
- **Registry V2, V1 untouched.** A new contract `kapiloto-prediction-snapshot-v2` and RPC `prediction_record_snapshot_v2` persist team-scoped lineup forecasts. The V1 RPC, the V1 canonical input bundle and the output hash are not modified; every existing row is `match_outcome` with no subject team; golden tests pin the V1 input/output hashes captured before the migration.
- **Kinds.** `match_outcome` keeps the 1/X/2 rule (V1 and V2). `lineup_forecast` (V2 only) has no 1/X/2, a frozen `subject_team_id` that plays the fixture, and requires `payload.lineup_estimate` when predicted. `abstained` is never used to carry a forecast that was made. One forecast per team.
- **Frozen 1C inputs.** Memberships and tenures get their own link tables. Lineup forecasts must use squad roles: selected/alternative ledger history of the subject team (never the target fixture), target-fixture claims about the subject team with their exact resolution, memberships, tenures and identity bindings. Everything is first seen at or before the cutoff and is the version the 1C as-of reads return (latest visible version, finished observations only, no withdrawals or retractions).
- **Squad-state context and hash.** One context row freezes the 1C versions, the explicit provider priority, the history window, the exact canonical JSON bytes of the state (`squad_state_canonical_json`) and `squad_state_sha256 = SHA-256(those bytes)`. The database verifies that any stored `lineup_estimate` matches the snapshot's fixture, subject team and context hash, that a predicted one is `projected`, and that every output player has an identity binding. Historical replay uses the frozen artifact, not a current re-read: today's 1C reads resolve today's survivors, so a rebuilt state differs after a later merge on purpose.
- **Version-specific canonicalization.** V2 bundle = V1 canonical families + sorted memberships + sorted tenures + normalized context; the commit-time check rebuilds it from the link rows and dispatches by contract version.
- **Baseline model (`kapiloto-lineup-model-v1`, parameters `kapiloto-lineup-parameters-v1`, output `kapiloto-lineup-output-v1`).** Pure and deterministic. B0 is a Beta(1,1) posterior over last-10 known starts and appearances. M1 treats accepted reported-lineup claims as pseudo-counts (verified: starts +4/+4, on_bench +4 start failures/+2 appearances, not_in_squad +8/+8; degraded is half). Accepted availability caps the start probability (available 0.98, doubtful 0.60, unavailable 0.02, suspended 0, returning 0.75; unknown or conflicting means no cap). Cross-family conflicts suppress claim adjustments and the cap. One team intercept makes the start marginals sum to exactly 11, allocated as integer basis points summing to 110000 with caps respected. The modal XI is the top 11 (a set, not a joint distribution). Appearance is max(start, min(cap, raw)). Expected regulation minutes are 0-90 with explicit starter/substitute samples or 75/18 fallbacks. The values are uncalibrated; there is no bench or squad-selection probability.
- **Benchmarks.** Start Brier, log loss (epsilon 1e-6), modal-XI hits and minutes MAE, over known truth only.
- **Replay and correctness hardening (before activation).**
  - *Complete capture.* At commit, the registry re-runs `squad_state_inputs_as_of(fixture, subject team, cutoff, history_max_fixtures)` and requires the frozen history, membership, tenure and claim/resolution sets to equal it exactly.
  - *Frozen state artifact.* It stores the exact canonical JSON bytes of the squad state as text, with a SHA-256 check, so a historical forecast's state is retrievable and its output replayable after later identity merges.
  - *Output contract.* The database and TypeScript validate the stored `kapiloto-lineup-output-v1` contract.
  - *Cross-family conflicts.* They are decided on the raw accepted evidence sets.
  - *Minutes.* Conditional minutes use only role-known rows.
  - *Negated reports.* Negated lineup reports are ignored.
  - *Parameters.* The complete parameter object is validated fail closed, with `team_starters` = 11.

Details: `docs/architecture/KAPILOTO-V4-LINEUP-MODEL.md`.

Reason: A lineup forecast is only scientifically useful if it can be replayed and audited: exactly which roster, tenure, history, claim and identity inputs it saw before the cutoff, and which derivation produced it. Extending the V1 bundle in place would have silently changed the meaning and hashes of existing snapshots, so V2 is a separate, versioned contract. A transparent Beta-Binomial baseline with explicit evidence rules is the benchmark every later lineup model must beat.

## D-055 — V4 membership-aware squad features (features V2, builder V2)
Decision:
- **Defect.** `kapiloto-squad-features-v1` counts absence from a complete historical lineup as a known non-start even for matches before the player joined the team, so new signings get manufactured non-starts in `start_known_matches`, `starts_last`, `consecutive_starts` and the 1D start probability.
- **V2 rule.** `kapiloto-squad-state-builder-v2` produces `kapiloto-squad-features-v2`: an absence is a known non-start only if the lineup is complete **and** the frozen memberships make the player certainly a member on the fixture's UTC kickoff date (inclusive bounds, `membershipCoverage` semantics, strongest applicable assertion wins). `possible`, `outside` or no membership is unknown. Rows are always authoritative. Absence still proves only "did not start".
- **No silent change.** Builder V1 and features V1 stay callable and byte-identical (golden-pinned) for replaying frozen 1D snapshots. The state contract (`kapiloto-squad-state-v1`), raw-input contract (`kapiloto-squad-state-inputs-v1`), lineup model (`kapiloto-lineup-model-v1`) and snapshot contract (`kapiloto-prediction-snapshot-v2`) are unchanged, because their shapes and meanings did not change.
- **Registry.** An additive migration lets `prediction_squad_state_context` freeze the pair builder-v2/features-v2 next to builder-v1/features-v1, as a closed pair. Canonicalization, hashing, complete capture and the artifact-to-context version check are unchanged and already cover it.
- **Before 1E.** Lineup deviation and lineup strength depend most on squad changes, which is exactly where V1 knownness is wrong. New forecasts use builder V2.

Details: `docs/architecture/KAPILOTO-V4-SQUAD-STATE.md`.

Reason: Versioned science. Frozen artifacts must keep their meaning, and a corrected rule must be a new, named derivation from the same frozen inputs rather than an edit behind an existing version string.

## D-056 — V4 provider-native Match Ledger ingest contracts (1E-A2-A)
Decision:
- **Contracts only.** A2-A adds:
  - a captured Sportmonks bundle (`kapiloto-sportmonks-ledger-capture-v1`);
  - a pure offline parser (`kapiloto-sportmonks-ledger-mapping-v1`, which is also the ledger `ingest_version`);
  - the ingest RPC `match_ledger_ingest_provider_fixture` (`kapiloto-provider-match-observation-v1`);
  - an append-only ingest audit;
  - the per-team stats read `kapiloto-team-match-stats-v1`.

  Nothing calls a provider, runs a backfill or lists competitions; that is A2-B. The 1A RPC, the as-of reads, the content hash and `first_seen_at` are unchanged.
- **Raw hash.** `raw_payload_sha256` is the SHA-256 of one raw response body. Only the capturer supplies it; the parser never computes it, and it is null otherwise. Per-family response hashes are audit-only.
- **Explicit missingness.** Every family carries `fetched` / `not_requested` / `failed`. An empty array never means "provided".
  - Extra time is `not_separable`.
  - A fetched family whose key is absent or unusable is `not_observed`.
  - A family that was not requested, or that has no recorded status, is `family_not_provided`.
  - A failed family is quarantined, never frozen.

  Statuses are sealed per observation version in `match_ledger_observation_family_fetches`. A downgrade is quarantined. An upgrade with unchanged content cannot be versioned and is quarantined (`family_status_drift`).
- **Identity.**
  - Canonical teams and competitions are never created by ingest.
  - Historical corpus ingest has a stricter trust boundary than V3, which writes `confirmed` at confidence 0.9 for name-resolved identities:
    - a competition resolves only through `manual_override` (the table has no confidence);
    - a team or an existing fixture mapping resolves through `manual_override` or `confirmed` at `mapping_confidence = 1`;
    - anything else quarantines (`competition_untrusted`, `team_untrusted`, `fixture_mapping_untrusted`).

    Ingest never promotes mappings; the A2-B preflight does, after review.
  - An existing provider fixture mapping wins if it is authoritative and consistent.
  - Otherwise every canonical fixture of the same two teams (either orientation, ±180 days) is a candidate, including fixtures already mapped (any status) or ledger-attached to another provider fixture id. Such a fixture in any guard window gives `fixture_provider_identity_conflict`. A unique unmapped ±48 h candidate is attached only when no reversed-orientation or other-competition fixture lies within 48 h, and no ±14-day, ±180-day postponed or unknown-competition fixture exists. Anything else is quarantined.
  - The search runs under one lock per unordered team pair, held through the write.
  - A latest ledger version for another provider fixture id (a re-pointed mapping) gives `provider_fixture_id_drift`.
  - Every V3 mapping row used to resolve identity is locked `FOR SHARE` until commit: the competition, both teams (one statement, `provider_team_id` order), the incoming fixture mapping and candidate fixture mappings. `FOR SHARE` is the weakest mode that blocks a concurrent update or upsert of non-key columns. A post-write re-check aborts the call if any of them no longer matches.
  - A fixture is minted only under an explicit caller policy whose `kickoff_before` A2-B derives as now − (V3 scoring lookback + 1 day). No window is hardcoded in the database.
  - Players: confirmed and manual mappings resolve to survivors. A missing mapping bootstraps a canonical player with a confirmed mapping (`mapping_basis = 'provider_native_bootstrap'`). An unverified mapping quarantines `player_mapping_unverified`, with no writes, no promotion and no second mapping.
- **Provider-ref drift.** League, season and team refs are sealed per version in `match_ledger_observation_provider_refs`. A payload that disagrees with the latest version's refs is quarantined (`provider_ref_drift`), and so is a latest version without refs (`provider_refs_unrecorded`). A withdrawal resets the attachment. The ledger stays on contract V1.
- **Stat definitions.** Seven Sportmonks definitions are seeded at `sm-2024-08`. They were verified against the Sportmonks v3 fixture-statistics and expected-value type references: 5304, 5305 and 7943 (three distinct xG keys), and 42, 86, 45 and 34.
  - An allow-listed row whose `type.developer_name` differs fails the whole capture (`stat_type_drift`).
  - A missing name or `type` include fails it too (`stat_type_metadata_missing`), and so does an invalid value (`stat_value_invalid`). Provider contract drift therefore never becomes ordinary `not_observed`.
  - A documentation/payload mismatch found later gets a new `definition_version`.
- **Capture quality flags.** Recoverable parser normalizations come from a closed set and are stored per run-bound attempt in `provider_ingest_items.detail`. They are not ledger content and never create a version. Ledger quality flags remain derived from persisted state at read time.
- **Two availability classes.**
  - The strict read uses actual `first_seen_at`.
  - The training-only read (`kapiloto-retrospective-training-availability-v1`) makes version 1 of a finished backfill observation available at `min(first_seen_at, kickoff_at + 24h)`. Later versions and withdrawals keep their actual time. Rows are labelled `retrospective`.

  The training loader is not exported from the V4 index and must not be imported by live or registry code. The registry already refuses ledger inputs first seen after the cutoff.
  - Known-superseded content is excluded, not rewritten: if the version selected at a training cutoff has a later correction or withdrawal in the ledger today, the chain is omitted from that training query. The later version is never backdated. `match_ledger_retrospective_training_exclusions` reports the omissions as `later_correction` / `later_withdrawal`.
- **Reconciliation.** Provider refs seal the canonical ids they resolved to. `match_ledger_provider_ref_conflicts` reports team and competition mapping that is missing, untrusted or drifted, and fixture competition drift, without mutating history.
- **Pilot gates, not invariants.** Cross-stat checks, provider-side zero semantics, lineup and position ids, `2ND_HALF` semantics and `meta.location` are verified in the A2-B pilot before becoming rules.

Details: `docs/architecture/KAPILOTO-V4-PROVIDER-INGEST.md`.

Reason: Historical team strength needs many finished matches, and the ledger must not acquire wrong identities, silent zeros or leaked knowledge on the way in. Teams and competitions cannot be merged later (D-050), so they are never guessed. Missing data must stay distinguishable from absent events. Backfilled history must be usable for training without being presented as what was known live.

## D-057 — Contain V3 Sportmonks mapping writes and pause historical ingest (Stage 0)
Decision:
- **Observed.** On 2026-10-30 the five A2-B pilot competitions (Sportmonks 8, 82, 372, 384, 564) were promoted to `manual_override` at about 20:34:57 UTC. By 20:45:05 UTC V3's structured sync had upserted 8, 372 and 384 back to `confirmed`; 82 and 564 were not in the current round.
- **Cause.** The V3 Sportmonks store upserts team, competition and fixture mappings with `ON CONFLICT DO UPDATE` on every structured sync (the daily cron and the 15-minute precompute job). Each sync can re-point an identity and reset its status. A name-matched mapping (confidence 0.9) is rewritten at confidence 1 once V3 fetches the fixture by its own mapped id. So A2-A's trust rule (`manual_override`, or `confirmed` at confidence 1) rests on columns an automated writer controls.
- **Guard.** Migration `20261030211645_kapiloto_v4_identity_mapping_guard.sql` adds a row-level `BEFORE UPDATE` trigger (`private.guard_v3_identity_mapping_update`) to `provider_team_mappings`, `provider_competition_mappings` and `provider_fixture_mappings`. For every Sportmonks row and every `manual_override` row it returns `NULL`, so the update is skipped:
  - no error, and V3's sync continues;
  - INSERT of a missing mapping and DELETE (including cascades) are unchanged;
  - other providers' non-`manual_override` rows are unaffected.
- **Operator override.** An operator changes a guarded row only in a transaction that runs `set local kapiloto.identity_operator = 'on'`.
- **Pause.** `service_role` loses EXECUTE on `match_ledger_ingest_provider_fixture`. Existing `confirmed`/1 Sportmonks rows are suspect until re-attested.
- **Scope.** This is the one deliberate exception to "V4 adds no trigger to V3 tables". No V3 code changes. No data changes: re-promotion is a separate operator step after the migration is applied.
- **Next (Stage 1).** Historical trust moves to V4-owned attestations, requiring mapping and attestation agreement, with one provider id per canonical team or competition. Fixture trust is derived from attested teams, competition and kickoff. The ingest grant returns with it.

Details: `docs/architecture/KAPILOTO-V4-PROVIDER-INGEST.md` ("Stage 0 containment"), `docs/operations/2026-10-30-sportmonks-mapping-overwrite.md`.

Reason: An identity mapping that an automated sync can rewrite every 15 minutes cannot carry historical-ingest trust, and an operator's `manual_override` must not be silently undone. Suppressing the mutation in the database stops it immediately without a deploy and without interrupting V3's structured snapshots. Pausing ingest keeps laundered rows from reaching the ledger before the trust model changes.


## D-058 — V4 provider identity attestations and bounded activation (Stage 1)
Decision:
- **Trust root.** Historical-ingest trust moves to V4-owned team/competition attestations. For Stage 1 Sportmonks, a current mapping is trusted only when it is `manual_override` **and** agrees with the active V4 attestation. Neither mapping status nor attestation alone is sufficient. Existing confidence-1 rows are not grandfathered.
- **State model.** Team and competition attestations use separate current projections plus immutable event histories. Active injectivity is enforced per provider in both directions. Evidence refresh stays in one generation; revoke closes the generation; re-attest creates a new generation even for the same canonical id.
- **Per-observation provenance.** V2 provider ingest seals the exact league/home/away attestation event/generation used by each observation version in a typed, integrity-checked sidecar. Plain 1A writes have no such provenance and are excluded from V2 model-facing reads.
- **Read-side enforcement.** V2 historical/team-match-stat readers require sealed refs, sealed attestation provenance, a non-revoked current generation, and a current agreeing `manual_override` mapping. Providers without a Stage 1 attestation system return zero V2 rows. A V2 retrospective-exclusions report records trust exclusions.
- **Revocation/recovery.** Revocation removes affected generations from V2 reads immediately. A read-only impact report identifies affected observations, fixture mappings and mints. Recovery is explicit: withdraw affected chains, repair mappings, re-attest, then re-ingest. If football content is unchanged but the sealed generation is stale, V2 quarantines `attestation_generation_stale` rather than silently returning `unchanged`. Availability policy V1 does not backdate recovered later versions.
- **Fixture identity.** Fixture mapping confidence/status is not historical trust, except that `unverified` fails closed. Existing mappings are accepted only after full team-pair candidate classification: the incoming-id mapping must be the unique valid `N` candidate, with matching attested orientation/competition, acceptable kickoff/status and no other guard/identity conflict. The pair lock is taken on both mapping paths; the selected fixture row is locked `FOR SHARE`.
- **Concurrency.** V2 ingest holds a shared provider-identity advisory lock. Attest/revoke hold it exclusive, must be the first write-capable operation in their transaction, use function-level `SET lock_timeout = '5s'`, and therefore run one identity per transaction. Projection/event writes require the internal RPC flag plus the correct held advisory lock.
- **Security.** Stage 1 functions are SECURITY INVOKER with empty search path. PUBLIC/anon/authenticated access is revoked explicitly. Because Supabase default privileges grant new public functions to `service_role`, M2A explicitly revokes V2 ingest from `public, anon, authenticated, service_role`; the security suite runs with default-privilege emulation enabled. RLS is not treated as a control against service-role BYPASSRLS. The production `private` schema must be confirmed absent from exposed Data API schemas before M2A application.
- **Versioning.** Existing V1 ingest/read/report functions remain present. Stage 1 adds versioned V2 ingest/read/report contracts rather than redefining frozen semantics. The old V1 provider-ref report and old model-facing V1 team-match-stat readers are de-authorized where their trust semantics would be misleading.
- **M2A.** M2A builds the attestation foundation, V2 ingest, V2 reads, reports, sidecars, security and tests. **M2A does not enable provider ingest.** Both V1 and V2 ingest RPCs remain non-executable by `service_role` after M2A.
- **M2B.** M2B is a separate grant-only activation for V2 ingest. It requires a reviewed immutable run whose `scope.provider_fixture_ids` explicitly bounds the pilot. The allowlist limits accidents, not a malicious service role.
- **Uncovered readers block M2B.** `squad_state_inputs_as_of`, the 1A observation/team/player as-of reads, and dependent squad-state/lineup snapshot paths are not attestation-aware. M2B is forbidden until attestation-aware V2 successors exist for any production consumer that may use them, or D-058's no-activation rule is enforced by repository boundary/grep gates so those consumers cannot use Sportmonks Match Ledger history.
- **M2C.** Emergency pause is a reviewed SQL body that revokes V2 ingest EXECUTE. Do not pre-create an old-timestamp migration file; in an emergency execute the reviewed revoke, then immediately create/commit the matching migration with a fresh timestamp so Supabase CLI cannot reject it as out of order.
- **Residual race.** Toto import may insert a new duplicate fixture while an existing-mapping ingest is already in flight because the new row does not yet exist to lock. This is accepted as ingest-first/import-second ordering: the current ingest may commit, and the next attempt sees the duplicate and quarantines.

Implementation status:
- Independent Opus and Fable final reviews both concluded that **M2A architecture is ready for implementation** after the above spec/test details are folded in.
- M2B remains NO-GO until uncovered reads are gated, the entity/reconciliation reports are clean for pilot scope, the recovery runbook is rehearsed, A2-B is amended/re-run, the reviewed run allowlist is fixed, and the production `private` schema exposure check is clean.
- M2A is implemented on `feat/v4-identity-attestations-m2a` (migration `20261031100000_kapiloto_v4_identity_attestations.sql`; not merged, not applied). Implementation clarification, not a redesign: a chain V2 wrongly minted cannot be re-minted under the same provider fixture id because the applied A2-A `match_ledger_fixture_mints` is unique per `(provider, provider_fixture_id)`; recovery by attaching to an existing correct fixture works. Minted-chain recovery needs a reviewed decision before the M2B recovery rehearsal.

Details: `docs/architecture/KAPILOTO-V4-IDENTITY-ATTESTATIONS-RFC.md`.

Reason: A historical training corpus cannot rely on mutable V3 confidence/status or write-time checks alone. Trust must be independently owned, auditable per observation, revocable at read time, recoverable after mistakes, and activated only through a deliberately bounded pilot.
