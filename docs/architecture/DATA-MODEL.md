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
- id
- round_id
- game_number (1..16)
- home_team_id
- away_team_id
- kickoff_at
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

### provider_fixture_mappings
- round_game_id
- provider
- provider_fixture_id
- mapping_status
- mapping_confidence
- mapped_at
- mapped_by

Unique: (provider, provider_fixture_id).

The football-data provider is authoritative only for football-state data, not Toto settlement.

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
### ticket_submissions
- id
- group_id
- round_id
- user_id
- version
- revision
- state: draft/submitted/locked
- submitted_at
- updated_at
- created_at

`revision` supports optimistic concurrency for multi-device editing.

A submitted edit creates or advances an auditable version; historical versions are never silently overwritten.

### ticket_picks
- submission_id
- round_game_id
- pick: 1/X/2/1X/X2/12
- updated_at

Unique: (submission_id, round_game_id).

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
- submission_id
- submission_version

This table makes every consensus version reproducible and lets the UI mark it stale when a source submission changes.

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
- submission_id
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

## Kapiloto fixture research
### kapiloto_analyses
- id
- round_game_id
- analysis_version
- status
- primary_pick
- suggested_double
- confidence
- score_1
- score_x
- score_2
- summary
- main_risk
- generated_at
- valid_until
- stale_at
- stale_reason
- model_key
- research_protocol_version

`score_1/score_x/score_2` are structured model/research scores used by deterministic ticket optimization. They must not be presented as calibrated probabilities unless we later validate calibration.

### kapiloto_factors
- analysis_id
- factor_type
- text
- direction
- importance

### kapiloto_sources
- analysis_id
- title
- url
- publisher
- source_type
- published_at
- accessed_at
- trust_tier

### kapiloto_analysis_inputs
- analysis_id
- input_type
- input_version
- metadata

This records the sports-data/research versions that produced an analysis.

## AI personas
### Kapiloto
Fixture research and ticket review.

### Diego
Full-ticket draft generation and automatic double allocation.

The personas can share underlying infrastructure, but stored proposal type/persona must preserve what the user invoked.

## Kapiloto / Diego ticket-level proposals
### kapiloto_ticket_proposals
- id
- group_id
- round_id
- user_id
- persona: kapiloto/diego
- proposal_type: review_ticket/fill_ticket
- source_submission_id
- max_doubles
- generated_at
- model_key
- optimizer_version
- status

### kapiloto_ticket_proposal_inputs
- proposal_id
- round_game_id
- analysis_id
- analysis_version

### kapiloto_ticket_proposal_picks
- proposal_id
- round_game_id
- current_pick
- proposed_pick
- change_reason
- rank
- marginal_coverage_value

A proposal never directly mutates a submitted ticket. The user previews and explicitly applies it to a draft.

### kapiloto_round_reviews
- id
- group_id
- round_id
- consensus_version_id
- review
- generated_at

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
