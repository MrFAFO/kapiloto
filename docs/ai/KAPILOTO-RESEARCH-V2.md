# Kapiloto Research v2 — foundations

Status: foundations implemented in shadow (`lib/research-v2`). Not wired into research, publication or the UI. No Sol call, no web research, no parameter approved. Decisions: D-045, D-046.

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
| 2 Triage | `triage.ts` — `extractTriageFeatures` → `TriageConfig` → `assignTriage`; explicit data gaps, competition membership (`league-membership.ts`), stat cold start | no |
| 3 Discovery | `evidence.ts` — strict discovery contract, closed claim kinds, no forecast fields | Sol (later) |
| 4 Verification | `verification.ts`, `sources.ts` — observed URL, fetched page, verbatim quote, dated ≤ cutoff, freshness per claim kind, entailment required, source quality, syndication, structured-duplicate detection | server + entailment judge |
| 5 Impact | `adjustments.ts` — closed vocabulary, no probabilities; admission rules | Sol (later) |
| 6 Combination | `combination.ts`, `forecast.ts` — candidate arms side by side, pre- and post-research | no |
| 7 Recommendation | `recommendation.ts` — `pick` / `double` / `no_signal` / `insufficient_data` | no |
| 8 Evaluation | `forecastEvaluationArms` — every base, pre-research and post-research arm | no |

Inputs carry identity and schedule only. `assertNoResultLeakage` rejects result-like fields on the forecast fixture, market or availability inputs, and any history row not knowable at the cutoff or not before the fixture.

## Market time (`market-state-v2`)

Versioned in `base-v2` as `research-v2-market-state` / `market-state-v2`; the engine refuses any other version.

- A price's information time is the provider's own last update (`sourceUpdatedAt`), or Kapiloto's retrieval time when that is earlier. Retrieval time is kept as `retrievedAt` for audit only.
- Freshness and staleness are measured from the oldest price used (`informationAgeMinutesAtCutoff`): over 6 h loses `standard` (`market_information_not_fresh`), over 24 h is `stale` and the market arm is unavailable.
- A quote without a provider update time falls back to its retrieval time (`capture_fallback`) and can never support `standard` (`provider_update_time_missing`).
- A quote retrieved after the cutoff is excluded even if the provider updated it earlier.
- API-Football supplies one update time per fixture, shared by every bookmaker.

## Evidence vs market (double counting)

`adjustment-policy-v2` (requires `market-state-v2`). Per adjustment, stored with the market-state version and the newest price time:

- evidence published after the newest price used by a fresh, standard market → `full` (shifts every candidate after pooling);
- evidence published at or before that price → `market_likely_incorporated` (explanatory, no shift);
- market missing, stale, thin or old → `stat_path` (shifts only the stat input of a combination; the market input is never adjusted);
- impact class `none` → `explanatory`.

## Triage inputs, membership and cold start

- Unknown is never "checked, nothing found": manager change is `checked` or `unknown` per side, unresolved availability is `null` when not assessed, and missing rest or recent-load values are listed. Each unknown is a `dataGaps` entry (0 points in `triage-v2`) and creates no research need by itself: a need requires an actual signal. Every fixture still gets the availability/rotation check.
- `newToCompetitionThisSeason` (`membership-v1`) is what stored history proves: the side did not play in the competition's previous season. It is not a claim of promotion. Seasons come from provider season ids when every row has one and seasons do not overlap; otherwise a gap of at least 60 days between matches starts a season (the reason is recorded). The target opens a new season when it kicks off at least 60 days after the latest stored match. A previous season whose first stored match is less than 14 days after the history window start may be truncated, so membership is unknown.
- An Elo side is cold-start with fewer than 20 rated matches, or when it is new to the competition this season. With no match count and no new-to-competition signal, cold start is unknown (`stat_team_matches_unknown:<side>` gap, `cold_start_unknown` flag), never assumed, and the disagreement is scored normally. Market/stat disagreement is then recorded but not scored, the `market_stat_gap` need is replaced by `stat_cold_start_context` for that side (0 points), and the output carries `p_stat_elo_v1:cold_start:<side>`. Elo values are unchanged.

## Source policy

Quality is assessed per item from organization/domain, source type, author/reporter, direct-quote status, syndication cluster and corroboration. A = official or direct statement; B = accredited reporting (strong local reporters included); C = established secondary; D = aggregator/unknown. Below the configured quality, an item needs independent corroboration; D never counts towards it; syndicated copies (same URL, same quote, same agency story) count once.

## Candidate configuration (not approved)

All values are `status: "candidate"`, versioned and hashed into every output. None was chosen from, or may be tuned on, round 264201 outcomes.

| Config | Id / version | Candidate values |
| --- | --- | --- |
| Deterministic base | `research-v2-deterministic-base` / `base-v2` | evaluation defaults for league base, Elo, market prior; `market-state-v2`; stat arms Elo + goal-model slot |
| Combinations | `combination-v1` | market only; Elo only; goal model only; linear and log pools at market weights 0.50 / 0.65 / 0.80 |
| Triage | `research-v2-triage` / `triage-v2` | disagreement bands 800 / 1500 bp; tiers at scores 2 / 4; budgets 2/3, 4/6, 8/12 searches/pages; new to competition 1 point; cold start under 20 matches, 0 points; data gaps 0 points |
| League membership | `research-v2-league-membership` / `membership-v1` | provider season ids, else 60-day inactivity gap; previous-season coverage 14 days |
| Source policy | `research-v2-source-policy` / `source-policy-v1` | alone ≥ B; else 2 independent clusters ≥ C |
| Verification | `research-v2-verification` / `verification-v1` | freshness per claim kind (6 h lineups … 720 h manager change) |
| Adjustment policy | `research-v2-adjustment-policy` / `adjustment-policy-v2` | fresh market ≤ 360 min from the oldest price; requires `market-state-v2` |
| Effect sizes | `research-v2-effect-sizes` / `effect-sizes-v1` | log-odds home/away shift 0.05 / 0.12 / 0.25; uncertainty × 1 / 0.6 / 0.3; cap 0.40 |
| Recommendation | `research-v2-recommendation` / `recommendation-v1` | chain log-pool 0.65 → market → Elo; no-signal margin 300 bp |

## Recurring results ingestion

`planIncrementalIngest` re-reads each league from its latest stored kickoff minus 7 days up to yesterday (30 days for a league with no rows; never a silent multi-year backfill), at most once per 20 hours. It runs as an optional shadow-cycle step and as `ingest-recent [--dry-run]`. Off unless `KAPILOTO_SHADOW_EVALUATION_ENABLED=true` and `KAPILOTO_SHADOW_RESULTS_INGEST_ENABLED=true` with a Sportmonks token.

## Live development and sampling

`FORMAL_SAMPLING_ENABLED = false`. Round 264201 games 1, 7, 8, 9 and 12 are tagged `live_dev` only; `classifyLiveDevFixture` excludes anything started or within 15 minutes of kickoff. Nothing is researched retrospectively.

## Live-dev deterministic-base runner

`scripts/research-v2-live-dev.ts` (core: `live-dev-runner.ts`, provider access: `live-dev-providers.ts`). Read-only, never published, never a formal sample.

- `capture --round <id> [--min-lead-minutes 60] [--out <path>]`: rereads fixture status and kickoff (explicit safe columns only), excludes any fixture not `upcoming` or less than 60 minutes from kickoff (exactly 60 is eligible) before any provider call, loads Sportmonks league history once per league and API-Football odds per fixture through provider-id-first resolution, takes the execution cutoff after retrieval so every captured quote precedes it, rechecks eligibility at the cutoff, and writes one local artifact (default `artifacts/research-v2/`, never overwritten).
- History requests start at the later of the arms' lookback start and the versioned provider-account floor (`SPORTMONKS_HISTORY_FLOOR`, `history-floor-v1`, 2024-08-01, measured by the 2026-10-24 coverage probe), so no request is spent on windows the account cannot serve. The floor and the effective window are recorded in `deterministic.inputs.historyPlan`; `--history-floor YYYY-MM-DD` records an operator override as its own version and `--no-history-floor` requests the full lookback. The floor bounds requests only; it changes no model parameter or statistic.
- `replay --artifact <path>`: recomputes from the stored deterministic inputs with all network blocked; succeeds only if input, output and artifact hashes match. Only artifact schema v2 is replayed; a v1 artifact (retrieval-time market semantics) is refused with `artifact_schema_unsupported: …; runner v2 requires artifact schema v2`. There is no legacy replay path.
- History rows carry the provider's season id (`providerSeasonId`) from the same Sportmonks responses; no extra request.
- Database access goes through a client that refuses every mutation, RPC, storage and function call; network access through a guard allowing only GET to Supabase and the two football-data hosts. No language model is reachable.
- Provider failures are isolated and explicit: a date-window refusal or missing market leaves only that fixture's market arm unavailable (`provider_plan_date_window`, `fixture_not_found`, …); a failed league history marks league base and `p_stat` unavailable (`sportmonks_history_unavailable:*`); thin or stale captures are kept and classified. Nothing is replaced by uniform probabilities.
- Zero research adjustments, zero Sol calls, no recommendation.

Artifact (schema v2): `deterministic.inputs` (cutoff, minimum lead, full configs including `membership`, league histories with season ids, per-fixture identity, market capture, triage context), `deterministic.outputs` (eligibility, arms in probabilities and basis points, market provenance with `marketStateVersion`, retrieval and information times and quality, competition membership, every candidate arm with config hash, triage features/data gaps/score/tier/needs, `flags` such as cold start, degraded reasons), `inputSha256`, `outputSha256`, `artifactSha256`, and a separate `retrieval` block (guard decisions, call timings and errors) that is never hashed.
