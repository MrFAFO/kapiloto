# Kapiloto Research v2 — foundations

Status: foundations implemented in shadow (`lib/research-v2`). Not wired into research, publication or the UI. No Sol call, no web research, no parameter approved. Decision: D-045.

## Locked principles

- No holistic `p_sol`. GPT-6.1 Sol never outputs 1/X/2 probabilities and never chooses a pick or double.
- No reliability-as-blend-weight and no checklist/dimension-coverage reliability.
- No uniform 3334/3333/3333 vector presented as an informative baseline.
- No same-plan fan-out: research depth follows a pure, versioned triage.
- Forecast = deterministic base + verified evidence + bounded deterministic adjustment.
- Every forecast-changing evidence item is verified, deduplicated and entailed.
- Every probability is reproducible exactly from stored inputs. Numeric probabilities stay internal.

## Pipeline

| Stage | Module | Model? |
| --- | --- | --- |
| 1 Deterministic base | `base.ts` — `p_league_base_v1`, `p_stat_elo_v1`, `p_stat_goal_model_v1` (interface slot, unavailable), `p_market_v1`, explicit market quality (`standard`/`thin`/`stale`/`missing`) | no |
| 2 Triage | `triage.ts` — `extractTriageFeatures` → `TriageConfig` → `assignTriage` | no |
| 3 Discovery | `evidence.ts` — strict discovery contract, closed claim kinds, no forecast fields | Sol (later) |
| 4 Verification | `verification.ts`, `sources.ts` — observed URL, fetched page, verbatim quote, dated ≤ cutoff, freshness per claim kind, entailment required, source quality, syndication, structured-duplicate detection | server + entailment judge |
| 5 Impact | `adjustments.ts` — closed vocabulary, no probabilities; admission rules | Sol (later) |
| 6 Combination | `combination.ts`, `forecast.ts` — candidate arms side by side, pre- and post-research | no |
| 7 Recommendation | `recommendation.ts` — `pick` / `double` / `no_signal` / `insufficient_data` | no |
| 8 Evaluation | `forecastEvaluationArms` — every base, pre-research and post-research arm | no |

Inputs carry identity and schedule only. `assertNoResultLeakage` rejects result-like fields on the forecast fixture, market or availability inputs, and any history row not knowable at the cutoff or not before the fixture.

## Evidence vs market (double counting)

Per adjustment, stored with its timestamps:

- evidence published after a fresh, standard market snapshot → `full` (shifts every candidate after pooling);
- evidence known before such a snapshot → `market_likely_incorporated` (explanatory, no shift);
- market missing, stale, thin or old → `stat_path` (shifts only the stat input of a combination; the market input is never adjusted);
- impact class `none` → `explanatory`.

## Source policy

Quality is assessed per item from organization/domain, source type, author/reporter, direct-quote status, syndication cluster and corroboration. A = official or direct statement; B = accredited reporting (strong local reporters included); C = established secondary; D = aggregator/unknown. Below the configured quality, an item needs independent corroboration; D never counts towards it; syndicated copies (same URL, same quote, same agency story) count once.

## Candidate configuration (not approved)

All values are `status: "candidate"`, versioned and hashed into every output. None was chosen from, or may be tuned on, round 264201 outcomes.

| Config | Id / version | Candidate values |
| --- | --- | --- |
| Deterministic base | `research-v2-deterministic-base` / `base-v1` | evaluation defaults for league base, Elo, market prior; stat arms Elo + goal-model slot |
| Combinations | `combination-v1` | market only; Elo only; goal model only; linear and log pools at market weights 0.50 / 0.65 / 0.80 |
| Triage | `research-v2-triage` / `triage-v1` | disagreement bands 800 / 1500 bp; tiers at scores 2 / 4; budgets 2/3, 4/6, 8/12 searches/pages |
| Source policy | `research-v2-source-policy` / `source-policy-v1` | alone ≥ B; else 2 independent clusters ≥ C |
| Verification | `research-v2-verification` / `verification-v1` | freshness per claim kind (6 h lineups … 720 h manager change) |
| Adjustment policy | `research-v2-adjustment-policy` / `adjustment-policy-v1` | fresh market ≤ 360 min |
| Effect sizes | `research-v2-effect-sizes` / `effect-sizes-v1` | log-odds home/away shift 0.05 / 0.12 / 0.25; uncertainty × 1 / 0.6 / 0.3; cap 0.40 |
| Recommendation | `research-v2-recommendation` / `recommendation-v1` | chain log-pool 0.65 → market → Elo; no-signal margin 300 bp |

## Recurring results ingestion

`planIncrementalIngest` re-reads each league from its latest stored kickoff minus 7 days up to yesterday (30 days for a league with no rows; never a silent multi-year backfill), at most once per 20 hours. It runs as an optional shadow-cycle step and as `ingest-recent [--dry-run]`. Off unless `KAPILOTO_SHADOW_EVALUATION_ENABLED=true` and `KAPILOTO_SHADOW_RESULTS_INGEST_ENABLED=true` with a Sportmonks token.

## Live development and sampling

`FORMAL_SAMPLING_ENABLED = false`. Round 264201 games 1, 7, 8, 9 and 12 are tagged `live_dev` only; `classifyLiveDevFixture` excludes anything started or within 15 minutes of kickoff. Nothing is researched retrospectively.
