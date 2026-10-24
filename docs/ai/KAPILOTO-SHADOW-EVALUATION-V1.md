# Kapiloto Shadow Evaluation v1 (Research v2, Phase 1)

Status: implemented in shadow mode on `feature/research-v2-foundations`. Migration `20261024090000_kapiloto_shadow_evaluation_v1.sql` is written and tested against PGlite. It is **not applied** to any hosted database, and no job is scheduled.

This document implements the measurement part of `KAPILOTO-EVALUATION-PLAN.md`. It adds no claim that any arm is better than another; that can only come from forward data scored under the rules below.

## Shadow guarantee

Nothing in Phase 1 changes published Kapiloto behaviour:
- `p_sol`, `p_final`, pick, double, double rank, grounding (v5/v6/v7), entailment, reliability, blend, finalization and the production prior path (`fixture_market_snapshots`, `aggregateMarketPrior`) are untouched;
- no app route, component or `lib/` module outside `lib/evaluation/` imports evaluation code or references the four new tables (enforced by `lib/evaluation/shadow-isolation.test.ts`);
- evaluation code writes only to `football_match_results`, `fixture_market_quotes`, `kapiloto_eval_predictions` and `kapiloto_eval_scores`, performs no updates/deletes, and calls no RPCs (same test);
- evaluation code makes no OpenAI or web-search calls;
- the new tables have RLS enabled, no policies and no `anon`/`authenticated` privileges, so numeric probabilities cannot reach the browser.

The only shared-file change is an additive `SportmonksClient.getLeagueCompletedMatchesBetween` method used by results ingestion.

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
- **Recorded issue time:** for B1–B4 the database sets `issued_at = recorded_at = now()` on insert; writer-supplied values are overwritten. Forward jobs set the information cutoff 60 seconds behind the app clock so app/DB clock skew cannot trip the trigger.
- **Publication issue time:** for B5, `issued_at` is the `published_at` of the referenced immutable `kapiloto_fixture_publications` row, and that publication must belong to the same fixture.
- **No information after issue:** in forward mode the database rejects `information_cutoff_at > issued_at`.
- **No backdated quotes:** `fixture_market_quotes.captured_at` must be within 600 seconds of the row's `created_at`.
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
3. Quote age ≤ 1,440 minutes (`stale` otherwise). The current market cron runs once a day, so a 24-hour bound is the tightest that the existing schedule can satisfy.
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

Changing any formula or threshold requires a new version string. Scores are unique per `(fixture, arm, arm_version, mode, selection_rule_version, scoring_version)`, so old and new versions coexist.

## Limitations

- **No data yet.** B2/B3 return `insufficient_league_history` until the migration is applied and `ingest-results` backfills each mapped league (Sportmonks 8, 82, 372, 384, 564). B4 returns no prediction until `capture-market` runs; there are currently 0 market snapshots in production.
- **No scheduling.** No cron or worker invokes any shadow job. Scheduling capture more often than daily, so that `standard` quality is reachable, is a separate decision.
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
