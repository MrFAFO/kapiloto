# Kapiloto Shadow Evaluation v1 (Research v2, Phase 1)

Status: implemented in shadow mode and deployed to the production database on 2026-10-27 under migration `20261027183933_kapiloto_shadow_evaluation_v1.sql`. The migration is tested against PGlite. The shadow evaluation job is still not scheduled in `vercel.json`, so deployment of the schema alone does not activate recurring shadow evaluation.

This document implements the measurement part of `KAPILOTO-EVALUATION-PLAN.md`. It adds no claim that any arm is better than another; that can only come from forward data scored under the rules below.

## Shadow guarantee

Nothing in Phase 1 changes published Kapiloto behaviour:
- `p_sol`, `p_final`, pick, double, double rank, grounding (v5/v6/v7), entailment, reliability, blend, finalization and the production prior path (`fixture_market_snapshots`, `aggregateMarketPrior`) are untouched;
- no app route, component or `lib/` module outside `lib/evaluation/` imports evaluation code or references the five new tables. The single exception is the internal cron route `app/api/internal/cron/shadow-evaluation`, which requires `CRON_SECRET`, does nothing unless `KAPILOTO_SHADOW_EVALUATION_ENABLED=true`, and is not in `vercel.json` (all enforced by `lib/evaluation/shadow-isolation.test.ts`);
- evaluation code writes only to `football_match_results`, `fixture_market_quotes`, `fixture_market_capture_attempts`, `kapiloto_eval_predictions` and `kapiloto_eval_scores`, performs no updates/deletes, and calls no RPCs (same test). It does not write `round_sync_control`, provider mappings or `fixture_market_snapshots`;
- evaluation code makes no OpenAI or web-search calls;
- the new tables have RLS enabled, no policies and no `anon`/`authenticated` privileges, so numeric probabilities cannot reach the browser.

Shared-file changes are additive only: `SportmonksClient.getLeagueCompletedMatchesBetween` (paginated league results with score provenance), plus an optional `onResponse` quota hook and `getAccountStatus()` on `ApiFootballClient`. Existing production parsers and call sites are unchanged.

## Architecture

```text
Sportmonks league results ──ingest──► football_match_results ─┐
API-Football bookmaker 1X2 ─capture─► fixture_market_quotes  ─┤
                                                              ├─► B1–B4 drafts (pure functions of data ≤ cutoff)
fixtures + round_games + provider mappings ───────────────────┘          │
kapiloto_fixture_publications ⨝ kapiloto_analyses ──► B5 projections ────┤
                                                                         ▼
                                                     kapiloto_eval_predictions (append-only)
                                                                         │ deterministic selection rule
fixtures.home_score/away_score (90-minute field result) ──────────────► kapiloto_eval_scores (append-only)
```

Modules live in `lib/evaluation/`; the operator entry point is `npm run eval:shadow -- <command>` (`scripts/evaluation-shadow.ts`, server-side, needs the service key and never runs in the browser).

| Command | Effect |
| --- | --- |
| `dry-run [--round <id>] [--probe-market]` | read-only readiness report; Supabase writes and non-GET requests are blocked |
| `report [--round <id>]` | read-only operator report (below) |
| `cycle [--round <id>]` | one scheduled pass, same code as the cron route |
| `backfill-results [--years 3] [--league <id>] [--dry-run]` | league results for every supported league, oldest first |
| `record --round <id>` | forward B1–B4 at now − 60 s |
| `replay --round <id> [--lead-minutes N]` | deterministic B1–B4 at kickoff − 15 min − N |
| `project-kapiloto --round <id>` | B5 rows from immutable publications |
| `score --round <id> --mode forward\|replay [--persist]` | select + score finished fixtures |
| `capture-market --round <id>` | append raw API-Football quotes |
| `ingest-results --league <sportmonks id> --from --to` | league results backfill |
| `backtest --league <id> --from --to` | in-memory B1–B3 historical replay (not persisted) |

## Arms

Arms are free-form identifiers matching `^[a-z][a-z0-9_]{1,62}$` plus a free-form `arm_version`, so new arms need no schema change.

| Arm | Version | Source |
| --- | --- | --- |
| B1 `uniform` | `kapiloto-uniform-v1` | 1/3 each |
| B2 `league_base` | `kapiloto-league-base-v1` | weighted league H/D/A rates |
| B3 `p_stat` | `kapiloto-pstat-elo-v1` | Elo + ordered-logit mapping |
| B4 `market` | `kapiloto-market-prior-v1;devig-power-v1` | median power-de-vigged bookmakers |
| B5 `kapiloto_published` | `kapiloto-published-projection-v1` | published `p_final` |
| B5 `kapiloto_sol` | `kapiloto-published-projection-v1` | published raw `p_sol` (diagnostic) |

Each prediction row stores fixture, round game, arm, arm version, evaluation mode, determinism, information cutoff, DB-stamped issue time, kickoff snapshot, home/away team IDs, validity (or an explicit `invalid_reason`), 1/X/2 probabilities, a `basis` JSON (inputs used, ratings, thresholds, excluded quotes, run versions) and `input_sha256` over the canonical inputs.

An arm that cannot be computed is stored as `valid = false` with a reason (`insufficient_league_history`, `insufficient_team_history`, `competition_unmapped`, `team_unmapped`, `neutral_venue_unsupported`, `no_quotes_before_cutoff`, `stale_market`, `insufficient_bookmakers`, `kapiloto_outcome_<x>`, `orientation_unverified`, `probabilities_missing`). Nothing is filled in.

## Cutoff and leakage rules

- **Safety margin:** `D = (actual kickoff, else scheduled kickoff) − 15 minutes`, the same window used by research and sync.
- **Result availability:** a historical result is usable only if `kickoff + 150 minutes ≤ cutoff`, and only for the same competition. Future and in-play matches never enter B2/B3.
- **Market availability:** a quote is usable only if `captured_at ≤ cutoff` and its provider `source_updated_at` (if present) is `≤ cutoff`.
- **Recorded issue time:** for B1–B4 the database sets `issued_at = recorded_at = now()` on insert and copies `kickoff_at_snapshot` from the fixture; writer-supplied values are overwritten. Rows whose home/away teams differ from the fixture are rejected (`kapiloto_eval_orientation_mismatch`).
- **Forward cutoff:** `max(now − 60 s, latest DB-stamped quote captured_at for the fixture)`, capped at `D`. The 60 seconds absorb app/DB clock skew; the quote floor lets a prediction see quotes captured moments earlier in the same run, using a timestamp the database itself wrote.
- **Publication issue time:** for B5, `issued_at` is the `published_at` of the referenced immutable `kapiloto_fixture_publications` row, and that publication must belong to the same fixture. A valid projection must carry exactly the analysis's published basis points (`kapiloto_eval_publication_probability_mismatch`), and `kickoff_at_snapshot` is taken from the analysis. Only `kapiloto_published`/`kapiloto_sol` may use a publication source, and they may use nothing else. Publications made after `D` are not projected.
- **No information after issue:** in forward mode the database rejects `information_cutoff_at > issued_at`.
- **No backdated rows:** `fixture_market_quotes.captured_at`, `football_match_results.observed_at`, `fixture_market_capture_attempts.attempted_at`, `kapiloto_eval_scores.scored_at` and every `created_at` are set by insert triggers; writer values are ignored. A result row additionally requires `observed_at ≥ kickoff_at + 150 minutes`.
- **Score integrity:** the score trigger requires a finished fixture whose stored 90-minute goals and outcome match the row. It also mirrors the selection rule: the referenced prediction must be eligible at `D`, no strictly later eligible prediction of the same arm/version/mode may exist (`kapiloto_eval_score_not_latest_prediction`), and `no_eligible_prediction` is refused while an eligible one exists.
- **Append-only:** update, delete and truncate are rejected by triggers on all five tables.
- **Replay restriction:** replay rows must be `deterministic` (DB check), so LLM arms can only ever be forward-evaluated. Finished matches are never re-researched.
- **Orientation:** predictions whose home/away team IDs differ from the canonical fixture are rejected at selection (`orientation_mismatch`). B5 additionally requires `orientation_verified`.
- **Postponement:** if the scheduled kickoff moved more than 360 minutes from the prediction's `kickoff_at_snapshot`, the prediction is rejected (`kickoff_rescheduled`).
- **Outcome states:** a cancelled fixture is void and not scored. Fixtures that are not finished (postponed, suspended, live, under review) are deferred. A missing regular-time score is deferred as `score_missing`.

## Deterministic selection rule (`kapiloto-eval-selection-v1`)

For each fixture and `(arm, arm_version, mode)`:

1. Drop records failing any rule above. In forward mode, also drop records with `issued_at > D` or `information_cutoff_at > issued_at`. In all modes, drop records with `information_cutoff_at > D`.
2. **Forward mode:** pick the maximum `issued_at`. **Replay mode:** pick the maximum `information_cutoff_at`.
3. Break ties by `information_cutoff_at` descending, then `recorded_at` descending, then `id` ascending.
4. Validity is **not** a selection criterion. If the latest eligible record is invalid, the fixture scores `prediction_unavailable` for that arm, with no fallback to an older valid record. No eligible record gives `no_eligible_prediction`.

The outcome is the 90-minute field result `fixtures.home_score/away_score` (`fixtures.regular_time_score`). Toto/pool settlement outcome is never used.

## Scoring formulas (`kapiloto-eval-scoring-v1`)

Let `p = (pH, pD, pA)` and let `y` be the one-hot actual outcome.

- **Multiclass Brier:** `Σ_k (p_k − y_k)²`, in the range [0, 2].
- **RPS** (ordered 1 < X < 2): `½ [(pH − yH)² + (pH + pD − yH − yD)²]`, in the range [0, 1].
- **Log loss:** `−ln max(p_outcome, 1e−15)`.
- **Top-pick accuracy:** `1/|argmax p|` if the outcome is in the argmax set, otherwise 0. Ties share credit and break no ties artificially.
- **Summaries:** means per `(arm, arm_version)`, plus coverage counts (scored vs unavailable). Arms are compared only on **paired** fixtures that both arms scored (`compareArms`). Calibration bins and bootstrap CIs plug into the same per-fixture score rows and are not implemented yet.

## B2 — league baseline (`kapiloto-league-base-v1`)

Inputs are same-competition, non-neutral results satisfying the availability rule, with kickoff within 1,095 days before the cutoff.

```text
w_i  = 2^(−age_days_i / 730)
p_k  = (Σ_{i: outcome_i = k} w_i + 1) / (Σ_i w_i + 3)
n_eff = (Σ w_i)² / Σ w_i²
```

Unavailable when `n_eff < 100`.

## B3 — p_stat (`kapiloto-pstat-elo-v1`)

### Why Elo and not Dixon–Coles

A read-only production inspection found only about 340 unique historical matches, embedded in structured snapshots and scoped to the 32 Toto teams over about six months. There is no league-wide results store. Dixon–Coles needs attack/defence parameters for every team in a league, fitted on complete league seasons. With team-scoped history, opponents' strengths are unidentified and the fit would be unstable. Elo needs only results, has one well-understood update rule, is cheap to make cutoff-safe, and degrades transparently.

Phase 1 therefore adds the missing league-wide store (`football_match_results` plus Sportmonks ingestion) and uses Elo. Dixon–Coles (or a bivariate Poisson with xG) is a candidate to be compared against Elo on forward data once full league history exists. It is not assumed to be better.

### Model

All matches are same-competition and non-neutral, within 1,460 days before the cutoff, processed oldest first. Ties are broken by provider fixture ID.

```text
initial rating R0 = 1500, K = 20
home advantage HA = 400 · log10(E / (1 − E)),  E = pH_base + pD_base / 2   (from B2 at the same cutoff)
expected home score  We = 1 / (1 + 10^(−(R_home + HA − R_away) / 400))
goal multiplier G = 1 (margin ≤ 1), 1.5 (margin 2), (11 + margin) / 8 (margin ≥ 3)
update  ΔR = K · G · (S − We),  S ∈ {1, ½, 0};  home += ΔR, away −= ΔR
idle decay before each match and at the cutoff:  R ← R0 + (R − R0) · 2^(−idle_days / 365)
```

Ratings map to 1/X/2 with an ordered logit anchored to the league baseline:

```text
c1 = logit(pA_base),  c2 = logit(pA_base + pD_base)
s  = 2 · ln10 · E(1 − E) / (σ'(c1) + σ'(c2)),   σ'(c) = σ(c)(1 − σ(c))
d  = (R_home − R_away) / 400
P(2) = σ(c1 − s·d),  P(X) = σ(c2 − s·d) − σ(c1 − s·d),  P(1) = 1 − σ(c2 − s·d)
```

At equal ratings this returns exactly the league baseline, so home advantage and the draw rate come from B2. The slope `s` makes `dE/dd` at `d = 0` equal to Elo's expected-score slope. The output is always a valid distribution with a positive draw probability, and is monotone in the rating difference.

The prediction is unavailable when the league baseline is unavailable, when either team has fewer than 5 rated matches, or for neutral venues.

### Features

Features are only: same-league 90-minute results, goal margin, home/away role, match recency (decay) and league home/draw/away rates. The model does not use xG, squads, injuries, transfers, cup or European matches, cross-league strength, or market data.

## B4 — market prior (`kapiloto-market-prior-v1`)

Raw quotes are appended by `capture-market` to `fixture_market_quotes`. This is separate from the production `fixture_market_snapshots`, which keeps its existing proportional-median prior.

Eligibility at a cutoff:
1. Same fixture, `captured_at ≤ cutoff`, `source_updated_at ≤ cutoff` when present.
2. Latest quote per `provider:bookmaker`; older ones are `superseded_by_newer_quote`.
3. Quote age ≤ 1,440 minutes (`stale` otherwise), matching the slowest (`far`) capture interval of the shadow cadence below.
4. All three odds > 1 and overround within [0, 0.25].
5. At least **2** distinct bookmakers, otherwise no prediction (`insufficient_bookmakers`, or `stale_market` if staleness removed them). One bookmaker is never a market.

**Aggregation:** each bookmaker is de-vigged separately; the per-outcome median is taken and renormalized. Quality is `standard` with ≥ 3 bookmakers all ≤ 360 minutes old, otherwise `thin`. The quality label is stored in `basis` so the two can be evaluated separately.

### De-vig (`devig-power-v1`, default)

With implied probabilities `π_i = 1/o_i` and booksum `B = Σ π_i`, solve for `k` by bisection on [1e−6, 64]:

```text
Σ π_i^k = 1,   p_i = π_i^k
```

Shin (`devig-shin-v1`) is implemented and tested as an alternative:

```text
p_i(z) = (√(z² + 4(1 − z) π_i² / B) − z) / (2(1 − z)),   with z ∈ [0, 0.99) solved so that Σ p_i = 1
```

Both remove more margin from longshots than proportional de-vig (`devig-proportional-v1`). Power was chosen as the default because it is monotone, always defined for a positive overround, and has a single parameter. Which method calibrates better on Kapiloto's leagues is an open, measurable question.

## B5 — published Kapiloto projection

Projection reads immutable `kapiloto_fixture_publications ⨝ kapiloto_analyses` and converts basis points to probabilities without modification. `kapiloto_published` takes `p_final`; `kapiloto_sol` takes raw `p_sol`. A projection is valid only for outcome `analyzed`/`carried_forward` with verified orientation. `basis` records the derivation, blend, reliability and calibration versions and the prior type.

## Production shadow activation (D-042)

Nothing here is enabled. Activation is an operator decision, taken in this order.

### Scheduled cycle

`GET /api/internal/cron/shadow-evaluation` (Bearer `CRON_SECRET`) runs `runShadowEvaluationCycle` for the current round. It does the following, each step isolated (a failure is reported with HTTP 207, and later dependent steps are skipped):

1. **Market capture** for fixtures that are due under the cadence (only when market capture is enabled and `API_FOOTBALL_API_KEY` is set).
2. **Forward B1–B4** for fixtures that are cadence-due or that captured quotes in this run.
3. **Kapiloto projection** of pre-deadline publications for the round and for fixtures finished in the last 21 days. Only `p_final`/`p_sol` already published are recorded; nothing is reconstructed after the match.
4. **Scoring** (persisted) of fixtures that finished 3 hours to 21 days ago. This step is skipped if projection failed, so a Kapiloto arm is never scored before its projection had the chance to be recorded.

Re-running is safe: cadence gates captures and predictions, and projections and scores are de-duplicated by unique keys.

Invocation: `POST /api/internal/cron/shadow-evaluation` with `Authorization: Bearer <research worker secret>`, checked against `KAPILOTO_WORKER_SECRET_SHA256` exactly like `/api/internal/kapiloto/worker`. The route answers `202` and runs the cycle after the response (Next.js `after`), so the caller's HTTP timeout never cuts the work; a disabled route answers `200 enabled:false` and runs nothing. `{"preflight": true}` returns the active switches, cadence and budget without doing any work. There is no `GET` and no `CRON_SECRET` path.

Proposed schedule (not created): Supabase `pg_cron` hourly at `7 * * * *`, calling the route through `pg_net` with the Vault-stored worker secret, as the research worker schedule does. Not Vercel Cron, which Hobby limits to once a day. The route picks only due fixtures internally.

### Switches and budgets (environment)

| Variable | Default | Effect |
| --- | --- | --- |
| `KAPILOTO_SHADOW_EVALUATION_ENABLED` | off | `true` enables the route at all |
| `KAPILOTO_SHADOW_MARKET_CAPTURE_ENABLED` | off | `true` (with the above) allows API-Football requests |
| `KAPILOTO_SHADOW_MARKET_MAX_REQUESTS_PER_RUN` | 30 | provider requests per cycle |
| `KAPILOTO_SHADOW_MARKET_MAX_REQUESTS_PER_DAY` | 200 | rolling 24 h, summed from recorded attempts |
| `KAPILOTO_SHADOW_MARKET_PROVIDER_RESERVE` | 100 | stop when the provider's own daily remaining falls below this, leaving room for the production market sync |
| `KAPILOTO_SHADOW_RESULTS_INGEST_ENABLED` | off | `true` (with evaluation enabled and `SPORTMONKS_API_TOKEN`) runs recurring league-results ingestion at most once per 20 h |
| `KAPILOTO_SHADOW_MARKET_CADENCE` | `free_plan` | `adaptive` opts into the 7-day cadence (paid plan); any other value, unset or misspelled, keeps the Free-plan cadence |

### Market cadence (`kapiloto-shadow-cadence-v1`)

Default profile `free_plan` (API-Football Free: 100 requests/day, dates limited to today ±1): one capture once a fixture is inside 24 h, one once it is inside 6 h, and the forced final capture in the last 75 minutes before `D`. Nothing further out is attempted. The `adaptive` profile in the table below applies only when explicitly selected.

| Window (time to kickoff) | Capture interval |
| --- | --- |
| more than 168 h | none |
| 48–168 h (`far`) | 24 h |
| 6–48 h (`mid`) | 3 h |
| under 6 h (`near`) | 1 h |
| last 75 min before `D` (`final`) | one forced capture, then hourly |

Intervals have 10 minutes of slack so an hourly scheduler does not drift by a whole run. After an `error`, a retry is allowed after 60 minutes. When the budget does not cover every due fixture, `final` comes first, then `near`, `mid` and `far`, then earlier kickoff. Fixtures left out are recorded as `skipped_budget` attempts and stay due.

Every attempt is stored in `fixture_market_capture_attempts`, including `no_quotes`, `not_found`, `orientation_mismatch`, `error` and `skipped_budget`, together with provider requests used and the provider's remaining daily quota. Unavailable market state is therefore recorded, not inferred from missing rows.

Estimated volume (the `dry-run` simulation, at 2 requests per capture plus 1 fixture-resolution request per kickoff date per run): one fixture costs 25 captures over its last week. A full 16-fixture round costs about 400 captures and about 550 requests, peaking at about 165 requests on the busiest day. Free API-Football plans (100 requests/day, about 10/minute) cannot sustain this. With the default reserve of 100, capture stops before touching such a plan's quota.

### Historical backfill

`backfill-results` fetches finished league fixtures from Sportmonks in 90-day windows, from 3 years before today up to yesterday, for every supported (confirmed, Sportmonks-mapped) competition. Rows are de-duplicated by provider fixture ID, sorted oldest first, and inserted with `ignoreDuplicates`, so reruns add nothing. Only 90-minute scores are stored: `2ND_HALF`, or `CURRENT` for plain `FT`. Matches decided after extra time without a `2ND_HALF` row are dropped. Each row keeps `provider_state` and `score_source`. Run with `--dry-run` first: it fetches and reports per-league counts, seasons and date ranges without writing. The coverage actually returned by the subscription is what gets reported; nothing is padded.

The backfill feeds B2/B3 only. Historical predictions are not persisted (they need a canonical fixture); the `backtest` command evaluates B1–B3 in memory. No historical LLM or Kapiloto predictions are ever created.

### Operator report

`report` (read-only) lists, for the round:
- fixtures, and fixtures with league history and with a valid `p_stat`;
- market coverage (standard/thin), bookmakers per latest snapshot and snapshot age;
- frozen Kapiloto `p_final`/`p_sol` projections;
- stored forward predictions and evaluated fixtures;
- unavailable arms with reasons.

It is a CLI output only; there is no public UI or API.

### Activation order

1. Apply the migration.
2. Run `backfill-results --dry-run`, review per-league coverage, then run it for real.
3. Verify API-Football plan and coverage with `dry-run --probe-market`.
4. Set `KAPILOTO_SHADOW_EVALUATION_ENABLED=true`, then add the schedule.
5. Enable market capture only once the plan's daily quota covers the estimate above plus the production sync.

## Version identifiers

| Component | Version |
| --- | --- |
| uniform arm | `kapiloto-uniform-v1` |
| league baseline | `kapiloto-league-base-v1` |
| p_stat | `kapiloto-pstat-elo-v1` |
| market prior | `kapiloto-market-prior-v1` |
| de-vig | `devig-power-v1`, `devig-shin-v1`, `devig-proportional-v1` |
| Kapiloto projection | `kapiloto-published-projection-v1` |
| selection rule | `kapiloto-eval-selection-v1` |
| scoring | `kapiloto-eval-scoring-v1` |
| results ingest | `football-results-ingest-v1` |
| quote capture | `kapiloto-market-quotes-capture-v1` |
| capture cadence | `kapiloto-shadow-cadence-v1` |

Changing any formula or threshold requires a new version string. Scores are unique per `(fixture, arm, arm_version, mode, selection_rule_version, scoring_version)`, so old and new versions coexist.

## Limitations

- **No data yet.** B2/B3 return `insufficient_league_history` until the migration is applied and `backfill-results` runs for each mapped league (Sportmonks 8, 82, 372, 384, 564). B4 returns no prediction until market capture runs. Production has never stored a market snapshot (`fixture_market_snapshots` is empty) and has no API-Football team or fixture mappings, so capture relies on name matching, and real bookmaker coverage is unverified.
- **No scheduling.** The cron route exists but is disabled by default and not scheduled.
- **Elo limits:**
  - promoted and newly mapped teams start at 1,500 and stay unavailable for their first 5 matches;
  - there is no cross-league or cup information;
  - draw probability varies only through the baseline thresholds and the rating gap;
  - K, decay and the goal multiplier are literature defaults, not fitted.
- **Unsupported fixtures:** neutral venues and cross-competition fixtures (e.g. European cups) are unsupported.
- **Orientation:** a Toto `round_game` whose orientation disagrees with the canonical fixture yields `orientation_mismatch` for B5 rather than a flipped probability.
- **Provider data:** the 90-minute result relies on live sync storing the regular-time score. Results ingestion trusts the Sportmonks score array the existing parser already uses.
- **Backtest:** the in-memory backtest covers B1–B3 only. Historical market and LLM performance cannot be reconstructed honestly and are measured forward only.
- **Not yet implemented:** calibration diagrams, ECE and bootstrap confidence intervals. Sample sizes from a single Toto round per week will be small for months.
