# Data Model

## Identity
### profiles
- id
- display_name
- created_at

Credentials remain in Supabase Auth.

## Groups
### groups
- id
- name
- owner_user_id
- join_code
- default_max_doubles
- created_at

### group_members
- group_id
- user_id
- role: owner/admin/member
- status
- joined_at

### join_requests
- id
- group_id
- user_id
- status: pending/approved/rejected
- requested_at
- decided_at
- decided_by

## Rounds
### rounds
- id
- external_round_number
- starts_at
- lock_at
- status
- source
- created_at

### round_games
- id
- round_id
- game_number (1..16)
- home_team_id
- away_team_id
- kickoff_at
- football_fixture_external_id
- status
- field_home_score
- field_away_score
- field_outcome
- pool_settlement_outcome
- settlement_status
- last_synced_at

Unique: (round_id, game_number).

## Group round settings
### group_round_settings
- group_id
- round_id
- max_doubles
- consensus_double_policy
- visibility_policy
- locked_at

This is a snapshot. Later group setting changes never rewrite history.

## Tickets
### ticket_submissions
- id
- group_id
- round_id
- user_id
- version
- state: draft/submitted/locked
- submitted_at
- updated_at

### ticket_picks
- submission_id
- round_game_id
- pick: 1/X/2/1X/X2/12

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

## Kapiloto
### kapiloto_analyses
- id
- round_game_id
- analysis_version
- status
- primary_pick
- suggested_double
- confidence
- summary
- main_risk
- generated_at
- valid_until
- model_key
- research_protocol_version

### kapiloto_sources
- analysis_id
- title
- url
- publisher
- published_at
- accessed_at

### kapiloto_round_reviews
- id
- group_id
- round_id
- consensus_version_id
- review
- generated_at

## Audit
### admin_audit_log
- group_id
- actor_user_id
- action
- entity_type
- entity_id
- metadata
- created_at
