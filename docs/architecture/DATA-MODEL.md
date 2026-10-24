# Data Model

## Identity
### profiles
- id
- username
- normalized_username
- display_name
- created_at

Unique: normalized_username.

Recovery email/phone and password credentials remain in Supabase Auth and must not be copied into the public profile table unless there is a separate product need.

### private.auth_username_aliases
Private, non-exposed schema.
- normalized_username
- user_id
- preferred_auth_identifier: email/phone
- created_at
- updated_at

Unique: normalized_username.
Unique: user_id.

Purpose: support username + password login while Supabase Auth performs password authentication with the user's verified email or phone identifier.

Security:
- never expose this table to the Data API;
- server-only lookup;
- generic authentication errors;
- rate-limit login and recovery attempts;
- do not use user-editable metadata for authorization.

## Groups
### groups
- id
- name
- owner_user_id
- join_code
- join_code_rotated_at
- default_max_doubles
- created_at

A user may belong to multiple groups.

### group_members
- group_id
- user_id
- role: owner/admin/member
- status
- joined_at
- left_at

Historical submissions remain attributed even after a member leaves.

### join_requests
- id
- group_id
- user_id
- status: pending/approved/rejected
- requested_at
- decided_at
- decided_by

## Teams and provider mappings
### teams
- id
- canonical_name
- country_code
- created_at

### team_aliases
- id
- team_id
- alias
- normalized_alias
- language_code
- source
- is_preferred
- created_at

Unique: (team_id, normalized_alias).

Purpose: preserve stable multilingual/transliterated names independently of any one data provider. Provider discovery/matching may use these aliases before a provider-specific id mapping exists.

`source` names whose naming an alias reflects. A provider-named alias (for example `Hapoel Katamon` with source `api-football` for Hapoel Jerusalem) records how that provider spells the club; it is a bootstrap aid only and never replaces the Hebrew canonical name.

### provider_team_mappings
- provider
- provider_team_id
- team_id
- provider_name
- mapping_status
- mapping_confidence
- last_verified_at

Unique: (provider, provider_team_id).

This prevents supplier naming differences from leaking into product logic.

Only `confirmed` and `manual_override` rows are trusted. API-Football fixture resolution (D-043) uses a trusted API-Football team id before any name, and uses other providers' trusted `provider_name` values (for example Sportmonks) as an English identity when no API-Football id exists yet. A successful API-Football market sync writes `confirmed` only for mappings backed by provider-id evidence (a trusted fixture mapping, or the mapped team or competition id itself matching). Mappings that rest on a name bootstrap are inserted as `unverified`, never overwrite an existing row, and are ignored by resolution until an operator or a verified seed confirms them.

## Competitions
### competitions
- id
- canonical_name
- country_code
- competition_type
- created_at

### provider_competition_mappings
- provider
- provider_competition_id
- competition_id
- provider_name
- mapping_status
- last_verified_at

Unique: (provider, provider_competition_id).

## Canonical fixtures
### fixtures
One row per real football match, independent of Toto/Winner rounds.

- id
- competition_id
- home_team_id
- away_team_id
- season_key
- stage_name
- round_name
- leg_number
- neutral_venue
- kickoff_at
- actual_kickoff_at
- status
- home_score
- away_score
- last_synced_at
- created_at
- updated_at

This is the shared football identity used by Match Intelligence, Toto, future Free Slip flows and provider ingestion. A fixture may exist even when it is not present in any Toto round.

## Rounds
### rounds
- id
- external_round_number
- starts_at
- lock_at
- status
- source
- source_version
- created_at

`lock_at` is explicit. It is never derived from the first fixture kickoff.

### round_games
Toto-specific wrapper around one canonical fixture. It stores Toto order/orientation, settlement and compatibility snapshots; it is not the canonical football match.

- id
- round_id
- fixture_id
- game_number (1..16)
- home_team_id
- away_team_id
- competition_id
- competition_name_snapshot
- competition_stage_snapshot
- leg_number / aggregate score when applicable
- neutral_venue
- kickoff_at
- actual_kickoff_at
- status
- field_home_score
- field_away_score
- field_outcome
- pool_settlement_outcome
- settlement_status
- settlement_rule
- settlement_source
- settlement_confirmed_at
- last_synced_at

Unique: (round_id, game_number).

For Kapiloto research, Toto `1` maps to the stored listed-first/home team and Toto `2` to the listed-second/away team. `neutral_venue` prevents the model from interpreting that orientation as a true home-field advantage. Research also snapshots the applicable 90-minute settlement rule.

### provider_fixture_mappings
- fixture_id
- round_game_id: nullable transitional compatibility link
- provider
- provider_fixture_id
- mapping_status
- mapping_confidence
- mapped_at
- mapped_by

Unique: (provider, provider_fixture_id).
Unique: (fixture_id, provider).

The football-data provider is authoritative only for football-state data, not Toto settlement. Provider identity belongs to the canonical fixture rather than the Toto row.


### fixture_market_snapshots
Server-ingested pre-match 90-minute 1X2 market snapshots.

- id
- fixture_id
- round_game_id: nullable transitional compatibility link
- provider
- captured_at
- market_type: 1x2_90m
- raw_home_odds/raw_draw_odds/raw_away_odds
- overround
- p_1_bp/p_x_bp/p_2_bp (de-vigged, sum 10000)
- source_version
- created_at

Market data is structured input, never scraped by Sol from articles. Odds movement is computed from comparable snapshots.

## Fixture fact provenance

### fixture_fact_snapshots
Immutable structured football facts attached to a canonical fixture.

- id
- fixture_id
- fact_key
- subject_type: fixture/team/player
- subject_team_id
- subject_ref
- exactly one value field: value_numeric/value_text/value_boolean/value_json
- unit
- provenance_type: provider_raw/deterministic_derived
- provider
- provider_endpoint
- provider_record_id
- calculation_version
- source_observed_at
- captured_at
- source_version
- source_fingerprint
- metadata

Rules:
- provider_raw requires an explicit provider and cannot pretend to be a local calculation;
- deterministic_derived requires a versioned calculation;
- rows are append-only/immutable;
- a displayed metric must be traceable to either a raw provider fact or a versioned deterministic calculation.

Examples:
- Sportmonks fixture xG or Pressure Index row -> provider_raw;
- Kapiloto-computed rolling xG differential or field tilt from raw events -> deterministic_derived.

### fixture_fact_inputs
Provenance edges for deterministic calculations.

- derived_fact_id
- input_fact_id
- input_role

A derived metric can therefore be reproduced from the immutable fact snapshots it consumed.

AI interpretation is a third, separate layer: it lives in kapiloto_analyses, factors and evidence. AI output must not be stored or presented as if it were a provider fact or deterministic metric.

## Group round settings
### group_round_settings
- group_id
- round_id
- max_doubles
- consensus_double_policy
- visibility_policy
- created_from_group_defaults_at
- locked_at

This is a snapshot. Later group-setting changes never rewrite history.

Suggested visibility policies:
- after_own_submission
- after_round_lock
- immediate

Default candidate: after_own_submission.

## Tickets

The ticket model separates the **current editable ticket** from immutable submitted snapshots.

### user_tickets
Stable identity for one user's ticket in one group round.
- id
- group_id
- round_id
- user_id
- state: draft/submitted/locked
- revision
- submitted_at
- locked_at
- created_at
- updated_at

Unique: (group_id, round_id, user_id).

`revision` supports optimistic concurrency for phone/desktop editing.

### user_ticket_picks
Current editable picks.
- user_ticket_id
- round_game_id
- pick: 1/X/2/1X/X2/12
- updated_at

Unique: (user_ticket_id, round_game_id).

Selecting two outcomes in the UI is stored as the corresponding double pick. There is no separate double flag.

### ticket_versions
Immutable snapshot created on each explicit submission and at final lock when needed.
- id
- user_ticket_id
- version_no
- state_at_snapshot
- submitted_at
- created_at

Unique: (user_ticket_id, version_no).

### ticket_version_picks
Immutable picks for one ticket version.
- ticket_version_id
- round_game_id
- pick

Unique: (ticket_version_id, round_game_id).

Consensus and historical scoring reference immutable `ticket_versions`, never a mutable draft.

## Consensus
### consensus_versions
- id
- group_id
- round_id
- generated_by
- algorithm_version
- source_submission_count
- generated_at
- is_current
- stale_at
- stale_reason

### consensus_source_submissions
- consensus_version_id
- ticket_version_id

This table makes every consensus version reproducible. If a member later submits a newer ticket version before lock, the current consensus is marked stale without rewriting the old source set.

### consensus_picks
- consensus_version_id
- round_game_id
- pick
- support_1
- support_x
- support_2
- chosen_coverage
- double_gain_score

## Scoring
### ticket_pick_results
- ticket_version_id
- round_game_id
- evaluation_state
- is_hit
- evaluated_outcome
- evaluated_at

### consensus_pick_results
- consensus_version_id
- round_game_id
- evaluation_state
- is_hit
- evaluated_outcome
- evaluated_at

Live/provisional evaluation may use current sporting state. Final scoring uses the pool settlement outcome.

## Fixture-scoped Kapiloto intelligence

The Toto round still owns demand, the shared maximum-three-run budget and coherent round synthesis. The researched football identity and publication pointer are fixture-scoped so the same intelligence can be reused by Match Intelligence outside Toto.

### kapiloto_fixture_publications
Immutable publication history for one canonical fixture.

- id
- fixture_id
- analysis_id
- research_run_id
- version_no
- previous_analysis_id
- published_at

Unique: (fixture_id, version_no).
Unique: analysis_id.

Only analyses belonging to a completed research run may be published.

### kapiloto_fixture_intelligence_state
One current pointer per canonical fixture.

- fixture_id
- current_analysis_id
- current_publication_id
- version
- updated_at

Publication is atomic and idempotent through the server-only `kapiloto_publish_fixture_analysis` RPC.

During migration, `kapiloto_analyses`, research requests, attempts and freshness signals carry both canonical `fixture_id` and their Toto `round_game_id` context. The canonical fixture is the reusable intelligence identity; the round-game id remains the Toto orientation/ranking context.

## Kapiloto round research state
### kapiloto_round_research_state
One row per Toto round. This is the serialization target and atomic publication pointer.

- round_id
- runs_consumed: 0..3
- active_run_id
- current_run_id
- research_closed_at
- attempts_total
- cost_micros_total
- version
- updated_at

`current_run_id` is the only definition of the published Kapiloto snapshot. Readers never assemble “latest per fixture”.

## Kapiloto research requests
### kapiloto_research_requests
One row per explicit user intent.

- id
- user_id
- round_id
- round_game_id
- intent: consult/recheck/diego
- idempotency_key
- request_sha256
- based_on_run_id
- outcome
- run_id
- created_at

Unique: (user_id, idempotency_key).

Clients do not insert this table directly; the privileged request path records it.

## Kapiloto logical research runs
### kapiloto_research_runs
One shared logical round-wide research execution.

- id
- round_id
- seq_no
- budget_slot: 1..3 or null when refunded
- status: queued/running/completed/failed/cancelled
- trigger_type: fixture_consult/fixture_recheck/diego
- origin_request_id
- based_on_run_id
- model_key: requested server configuration
- research_protocol_version
- derivation_version
- source_policy_version
- recency_policy_version
- reliability_formula_version
- blend_policy_version
- calibration_version: nullable until a fitted calibrator exists
- prompt_template_sha256
- execution_topology: round_batch/fixture_fanout
- research_cutoff_at
- fixture_set
- fixture_set_sha256
- input_snapshot
- input_snapshot_at
- max_attempts_per_task
- attempt_count
- round_synthesis
- failure_class
- failure_detail
- token/cost/search totals
- created_at/started_at/completed_at/failed_at

Constraints:
- unique (round_id, seq_no);
- unique (round_id, budget_slot) where budget_slot is not null;
- at most one queued/running run per round.

A transient retry never creates another logical run. A refunded terminal infrastructure failure may release its budget slot.

`research_cutoff_at` freezes the pre-match evidence boundary. Research tasks do not use evidence published later than this cutoff.

## Kapiloto execution attempts
### kapiloto_research_attempts
Fixture/round task execution and retry unit inside one logical run.

- id
- run_id
- task_key
- round_game_id: nullable for a whole-round experiment task
- attempt_no
- status: queued/running/succeeded/failed/abandoned
- available_at
- worker_id
- claimed_at
- heartbeat_at
- lease_expires_at
- finished_at
- model_snapshot
- provider request/response IDs
- token/search/source/cost usage
- timing metrics
- failure_class/code/detail
- repair_calls
- raw_output_uri/raw_output_sha256
- validated_output
- validation_report
- trace_id

Unique: (run_id, task_key, attempt_no).

At most one queued/running attempt and at most one succeeded attempt exist per task key.

Workers claim attempts with `FOR UPDATE SKIP LOCKED`. Long model/web work occurs outside database transactions.

The preferred first implementation uses one task key per fixture; a round-batch task remains available for shadow comparison.

## Kapiloto source registry
### kapiloto_source_registry
Server-curated trust policy for web evidence.

- domain (canonical/punycode)
- publisher
- tier_by_claim_type
- languages
- coverage metadata
- denied
- reviewed_at
- metadata

Unknown domains default to low trust. Sol never assigns source tier.

## Kapiloto fixture research
### kapiloto_analyses
Immutable fixture rows published as one complete research-run snapshot.

- id
- research_run_id
- round_id
- round_game_id
- outcome: analyzed/insufficient_data/void/carried_forward/research_unavailable
- carried_from_analysis_id
- research_cutoff_at
- kickoff_at_snapshot
- settlement_rule_snapshot
- neutral_venue_snapshot
- orientation_verified
- prior_type: market/rating/league_base
- market_snapshot_id
- p_prior_1_bp/p_prior_x_bp/p_prior_2_bp
- p_sol_1_bp/p_sol_x_bp/p_sol_2_bp
- p_final_1_bp/p_final_x_bp/p_final_2_bp
- reliability
- reliability_band: low/medium/high
- reliability_reasons
- model_self_confidence: logged only
- primary_pick
- suggested_double
- double_priority_rank
- double_gain_score (display/audit value; ordering uses integer ratio comparison)
- blend_weight
- deviation_cap_applied
- summary
- main_risk
- availability
- dimension_coverage
- conflicts
- watch_items
- key_assumptions
- data_quality
- suspicious_content
- valid_until
- generated_at

Unique: (research_run_id, round_game_id).

Each probability triple is stored in basis points and sums to 10,000.

`p_sol` is Sol's raw pre-match 90-minute probability estimate. `p_final` is server-derived from the versioned prior/reliability/blend/calibration pipeline.

Only `p_final` drives `primary_pick`, `suggested_double`, `double_gain_score` and `double_priority_rank`.

`double_recommended` is group-specific and is computed at read/build time from the group's configured max doubles; it is not persisted as a universal analysis fact.

### kapiloto_evidence
Claim-level grounding and audit evidence.

- id
- analysis_id
- model_evidence_id
- url_canonical
- domain
- claim_type
- about_team
- quote
- claim
- source_event_time
- published_at (server-extracted)
- retrieved_at
- trust_tier (server-assigned for the claim type)
- quote_verified
- entailment: supported/unsupported/not_checked
- syndication_cluster_id
- content_sha256
- status: accepted/rejected
- rejected_reason

A real/retrieved URL is not sufficient: material evidence must also pass quote/claim validation.

### kapiloto_factors
- id
- analysis_id
- dimension
- favors: home/draw/away/none
- magnitude: small/medium/large
- rationale

### kapiloto_factor_evidence
- factor_id
- evidence_id

Many-to-many mapping from derived factor to accepted claim evidence.

### kapiloto_analysis_inputs
- analysis_id
- input_type
- input_version
- metadata

This records structured football/prior snapshots that produced the immutable analysis.

### kapiloto_freshness_signals
Non-AI ingestion signals used to compute freshness.

- round_game_id
- signal_type: lineup/injury/suspension/odds_move/kickoff_change/postponed/cancelled
- severity
- data_version
- observed_at
- payload

Freshness is computed at read time from deterministic TTL, input versions and signals. Signals never trigger AI by themselves.


## Shadow evaluation (server-only)
These tables back the Research v2 shadow evaluation (`docs/ai/KAPILOTO-SHADOW-EVALUATION-V1.md`, D-041, D-042). All five are append-only (update/delete/truncate triggers raise), have RLS enabled with no policies and no `anon`/`authenticated` grants, and are never read by research, derivation, finalization, publication or the UI. Every time column that a leakage rule depends on is set by an insert trigger.

### football_match_results
League-wide regular-time results for deterministic baselines, identified by provider IDs (not canonical teams).

- provider, provider_fixture_id (unique together)
- provider_competition_id, competition_name, provider_season_id
- kickoff_at
- provider_home_team_id/name, provider_away_team_id/name
- home_goals_90, away_goals_90
- result_basis: regular_time
- provider_state (e.g. FT, AET), score_source: 2ND_HALF/CURRENT
- neutral_venue
- observed_at (DB insert time; must be ≥ kickoff_at + 150 minutes)
- ingest_version

### fixture_market_quotes
Raw per-bookmaker 1X2 prices captured for the shadow market arm. Separate from `fixture_market_snapshots`, which remains the production prior source.

- fixture_id
- provider, provider_fixture_id, provider_home/away_team_id
- bookmaker_id, bookmaker_name
- market_type: 1x2_90m
- odds_home/draw/away (> 1), overround
- implied_home/draw/away (de-vigged, sum to 1), devig_method_version
- source_updated_at
- captured_at (DB insert time; writer value ignored)
- capture_version

### fixture_market_capture_attempts
One row per shadow quote-capture attempt, so unavailable market state is explicit.

- fixture_id, provider
- attempted_at (DB insert time)
- status: saved/no_quotes/not_found/orientation_mismatch/error/skipped_budget
- cadence_window: far/mid/near/final
- provider_fixture_id, quotes_saved (> 0 exactly when saved)
- provider_requests (0 when skipped_budget), provider_daily_remaining
- error, capture_version

### kapiloto_eval_predictions
One row per fixture/arm/arm_version/mode/information cutoff (and source analysis for Kapiloto projections).

- fixture_id, round_game_id
- arm (free-form identifier), arm_version
- evaluation_mode: forward/replay (replay requires deterministic)
- deterministic
- information_cutoff_at
- issued_at (DB-stamped: insert time, or the immutable publication time for Kapiloto projections), issued_at_source (publication source exactly for the Kapiloto arms)
- source_analysis_id (Kapiloto projections must carry that analysis's published probabilities)
- recorded_at, kickoff_at_snapshot (DB-copied from the fixture or the analysis)
- home_team_id, away_team_id
- valid, invalid_reason, p_home/p_draw/p_away
- basis, input_sha256

### kapiloto_eval_scores
One scored selection per fixture/arm/arm_version/mode/selection rule/scoring version.

- fixture_id, arm, arm_version, evaluation_mode
- selection_rule_version, scoring_version
- status: scored/prediction_unavailable/no_eligible_prediction
- prediction_id
- outcome (90-minute field result; must match the finished fixture), home_goals_90, away_goals_90, outcome_source
- brier, rps, log_loss, top_pick, top_pick_score
- details, scored_at (DB insert time)

The insert trigger rejects a score whose prediction is not the latest one eligible under selection rule v1.

## AI personas
### Kapiloto
Fixture research only, including round-relative double value for that fixture.

### Diego
Full-ticket draft generation and automatic double allocation using the latest Kapiloto analyses for all 16 fixtures.

The personas can share underlying infrastructure, but stored proposal type/persona must preserve what the user invoked.

## Diego ticket-level proposals
### diego_ticket_proposals
- id
- group_id
- round_id
- user_id
- research_run_id
- proposal_type: fill_ticket
- source_submission_id
- max_doubles
- generated_at
- model_key
- optimizer_version
- status

### diego_ticket_proposal_inputs
- proposal_id
- round_game_id
- analysis_id

### diego_ticket_proposal_picks
- proposal_id
- round_game_id
- current_pick
- proposed_pick
- change_reason
- rank
- marginal_coverage_value

A Diego proposal pins one completed Kapiloto `research_run_id`, uses analyses only from that snapshot, produces/fills the normal editable user draft, and never mutates a submitted or locked ticket.

## Audit and corrections
### admin_audit_log
- group_id
- actor_user_id
- action
- entity_type
- entity_id
- metadata
- created_at

Administrative corrections to fixture mapping, settlement or membership must be auditable.

## Derived statistics
Prefer SQL views/materialized views for derived metrics until scale proves persistent aggregates are required.

Source facts and historical snapshots are persisted; easy-to-recompute statistics should not be duplicated prematurely.
