export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      admin_audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          group_id: string | null
          id: number
          metadata: Json
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          group_id?: string | null
          id?: never
          metadata?: Json
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          group_id?: string | null
          id?: never
          metadata?: Json
        }
        Relationships: [
          {
            foreignKeyName: "admin_audit_log_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      coach_aliases: {
        Row: {
          alias: string
          alias_kind: string
          coach_id: string
          created_at: string
          id: string
          language_code: string | null
          normalized_alias: string | null
          provider: string | null
          source: string
        }
        Insert: {
          alias: string
          alias_kind: string
          coach_id: string
          created_at?: string
          id?: string
          language_code?: string | null
          normalized_alias?: never
          provider?: string | null
          source?: string
        }
        Update: {
          alias?: string
          alias_kind?: string
          coach_id?: string
          created_at?: string
          id?: string
          language_code?: string | null
          normalized_alias?: never
          provider?: string | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "coach_aliases_coach_id_fkey"
            columns: ["coach_id"]
            isOneToOne: false
            referencedRelation: "coaches"
            referencedColumns: ["id"]
          },
        ]
      }
      coaches: {
        Row: {
          canonical_name: string
          created_at: string
          date_of_birth: string | null
          id: string
          identity_status: string
          merged_into_coach_id: string | null
          nationality_code: string | null
          updated_at: string
        }
        Insert: {
          canonical_name: string
          created_at?: string
          date_of_birth?: string | null
          id?: string
          identity_status?: string
          merged_into_coach_id?: string | null
          nationality_code?: string | null
          updated_at?: string
        }
        Update: {
          canonical_name?: string
          created_at?: string
          date_of_birth?: string | null
          id?: string
          identity_status?: string
          merged_into_coach_id?: string | null
          nationality_code?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "coaches_merged_into_coach_id_fkey"
            columns: ["merged_into_coach_id"]
            isOneToOne: false
            referencedRelation: "coaches"
            referencedColumns: ["id"]
          },
        ]
      }
      competitions: {
        Row: {
          canonical_name: string
          competition_type: string | null
          country_code: string | null
          created_at: string
          id: string
        }
        Insert: {
          canonical_name: string
          competition_type?: string | null
          country_code?: string | null
          created_at?: string
          id?: string
        }
        Update: {
          canonical_name?: string
          competition_type?: string | null
          country_code?: string | null
          created_at?: string
          id?: string
        }
        Relationships: []
      }
      consensus_pick_results: {
        Row: {
          consensus_version_id: string
          evaluated_at: string
          evaluated_outcome: string | null
          evaluation_state: string
          is_hit: boolean | null
          round_game_id: string
        }
        Insert: {
          consensus_version_id: string
          evaluated_at?: string
          evaluated_outcome?: string | null
          evaluation_state: string
          is_hit?: boolean | null
          round_game_id: string
        }
        Update: {
          consensus_version_id?: string
          evaluated_at?: string
          evaluated_outcome?: string | null
          evaluation_state?: string
          is_hit?: boolean | null
          round_game_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "consensus_pick_results_consensus_version_id_fkey"
            columns: ["consensus_version_id"]
            isOneToOne: false
            referencedRelation: "consensus_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consensus_pick_results_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id"]
          },
        ]
      }
      consensus_picks: {
        Row: {
          chosen_coverage: number | null
          consensus_version_id: string
          double_gain_score: number | null
          pick: string
          round_game_id: string
          support_1: number
          support_2: number
          support_x: number
        }
        Insert: {
          chosen_coverage?: number | null
          consensus_version_id: string
          double_gain_score?: number | null
          pick: string
          round_game_id: string
          support_1: number
          support_2: number
          support_x: number
        }
        Update: {
          chosen_coverage?: number | null
          consensus_version_id?: string
          double_gain_score?: number | null
          pick?: string
          round_game_id?: string
          support_1?: number
          support_2?: number
          support_x?: number
        }
        Relationships: [
          {
            foreignKeyName: "consensus_picks_consensus_version_id_fkey"
            columns: ["consensus_version_id"]
            isOneToOne: false
            referencedRelation: "consensus_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consensus_picks_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id"]
          },
        ]
      }
      consensus_source_submissions: {
        Row: {
          consensus_version_id: string
          ticket_version_id: string
        }
        Insert: {
          consensus_version_id: string
          ticket_version_id: string
        }
        Update: {
          consensus_version_id?: string
          ticket_version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "consensus_source_submissions_consensus_version_id_fkey"
            columns: ["consensus_version_id"]
            isOneToOne: false
            referencedRelation: "consensus_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consensus_source_submissions_ticket_version_id_fkey"
            columns: ["ticket_version_id"]
            isOneToOne: false
            referencedRelation: "ticket_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      consensus_versions: {
        Row: {
          algorithm_version: string
          generated_at: string
          generated_by: string
          group_id: string
          id: string
          is_current: boolean
          round_id: string
          source_submission_count: number
          stale_at: string | null
          stale_reason: string | null
        }
        Insert: {
          algorithm_version: string
          generated_at?: string
          generated_by: string
          group_id: string
          id?: string
          is_current?: boolean
          round_id: string
          source_submission_count: number
          stale_at?: string | null
          stale_reason?: string | null
        }
        Update: {
          algorithm_version?: string
          generated_at?: string
          generated_by?: string
          group_id?: string
          id?: string
          is_current?: boolean
          round_id?: string
          source_submission_count?: number
          stale_at?: string | null
          stale_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "consensus_versions_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consensus_versions_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      diego_ticket_proposal_inputs: {
        Row: {
          analysis_id: string
          proposal_id: string
          round_game_id: string
        }
        Insert: {
          analysis_id: string
          proposal_id: string
          round_game_id: string
        }
        Update: {
          analysis_id?: string
          proposal_id?: string
          round_game_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "diego_ticket_proposal_inputs_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_analyses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "diego_ticket_proposal_inputs_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "diego_ticket_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "diego_ticket_proposal_inputs_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id"]
          },
        ]
      }
      diego_ticket_proposal_picks: {
        Row: {
          change_reason: string | null
          current_pick: string | null
          marginal_coverage_value: number | null
          proposal_id: string
          proposed_pick: string
          rank: number | null
          round_game_id: string
        }
        Insert: {
          change_reason?: string | null
          current_pick?: string | null
          marginal_coverage_value?: number | null
          proposal_id: string
          proposed_pick: string
          rank?: number | null
          round_game_id: string
        }
        Update: {
          change_reason?: string | null
          current_pick?: string | null
          marginal_coverage_value?: number | null
          proposal_id?: string
          proposed_pick?: string
          rank?: number | null
          round_game_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "diego_ticket_proposal_picks_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "diego_ticket_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "diego_ticket_proposal_picks_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id"]
          },
        ]
      }
      diego_ticket_proposals: {
        Row: {
          generated_at: string
          group_id: string
          id: string
          max_doubles: number
          model_key: string | null
          optimizer_version: string
          research_run_id: string
          round_id: string
          source_ticket_id: string | null
          status: string
          user_id: string
        }
        Insert: {
          generated_at?: string
          group_id: string
          id?: string
          max_doubles: number
          model_key?: string | null
          optimizer_version: string
          research_run_id: string
          round_id: string
          source_ticket_id?: string | null
          status?: string
          user_id: string
        }
        Update: {
          generated_at?: string
          group_id?: string
          id?: string
          max_doubles?: number
          model_key?: string | null
          optimizer_version?: string
          research_run_id?: string
          round_id?: string
          source_ticket_id?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "diego_ticket_proposals_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "diego_ticket_proposals_research_run_id_round_id_fkey"
            columns: ["research_run_id", "round_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_research_runs"
            referencedColumns: ["id", "round_id"]
          },
          {
            foreignKeyName: "diego_ticket_proposals_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "diego_ticket_proposals_source_ticket_id_fkey"
            columns: ["source_ticket_id"]
            isOneToOne: false
            referencedRelation: "user_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      fixture_fact_inputs: {
        Row: {
          derived_fact_id: string
          input_fact_id: string
          input_role: string | null
        }
        Insert: {
          derived_fact_id: string
          input_fact_id: string
          input_role?: string | null
        }
        Update: {
          derived_fact_id?: string
          input_fact_id?: string
          input_role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fixture_fact_inputs_derived_fact_id_fkey"
            columns: ["derived_fact_id"]
            isOneToOne: false
            referencedRelation: "fixture_fact_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixture_fact_inputs_input_fact_id_fkey"
            columns: ["input_fact_id"]
            isOneToOne: false
            referencedRelation: "fixture_fact_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      fixture_fact_snapshots: {
        Row: {
          calculation_version: string | null
          captured_at: string
          fact_key: string
          fixture_id: string
          id: string
          metadata: Json
          provenance_type: string
          provider: string | null
          provider_endpoint: string | null
          provider_record_id: string | null
          source_fingerprint: string | null
          source_observed_at: string | null
          source_version: string | null
          subject_ref: string | null
          subject_team_id: string | null
          subject_type: string
          unit: string | null
          value_boolean: boolean | null
          value_json: Json | null
          value_numeric: number | null
          value_text: string | null
        }
        Insert: {
          calculation_version?: string | null
          captured_at?: string
          fact_key: string
          fixture_id: string
          id?: string
          metadata?: Json
          provenance_type: string
          provider?: string | null
          provider_endpoint?: string | null
          provider_record_id?: string | null
          source_fingerprint?: string | null
          source_observed_at?: string | null
          source_version?: string | null
          subject_ref?: string | null
          subject_team_id?: string | null
          subject_type: string
          unit?: string | null
          value_boolean?: boolean | null
          value_json?: Json | null
          value_numeric?: number | null
          value_text?: string | null
        }
        Update: {
          calculation_version?: string | null
          captured_at?: string
          fact_key?: string
          fixture_id?: string
          id?: string
          metadata?: Json
          provenance_type?: string
          provider?: string | null
          provider_endpoint?: string | null
          provider_record_id?: string | null
          source_fingerprint?: string | null
          source_observed_at?: string | null
          source_version?: string | null
          subject_ref?: string | null
          subject_team_id?: string | null
          subject_type?: string
          unit?: string | null
          value_boolean?: boolean | null
          value_json?: Json | null
          value_numeric?: number | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fixture_fact_snapshots_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixture_fact_snapshots_subject_team_id_fkey"
            columns: ["subject_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      fixture_market_snapshots: {
        Row: {
          captured_at: string
          created_at: string
          fixture_id: string
          id: string
          market_type: string
          overround: number | null
          p_1_bp: number
          p_2_bp: number
          p_x_bp: number
          provider: string
          raw_away_odds: number | null
          raw_draw_odds: number | null
          raw_home_odds: number | null
          round_game_id: string | null
          source_version: string | null
        }
        Insert: {
          captured_at: string
          created_at?: string
          fixture_id: string
          id?: string
          market_type?: string
          overround?: number | null
          p_1_bp: number
          p_2_bp: number
          p_x_bp: number
          provider: string
          raw_away_odds?: number | null
          raw_draw_odds?: number | null
          raw_home_odds?: number | null
          round_game_id?: string | null
          source_version?: string | null
        }
        Update: {
          captured_at?: string
          created_at?: string
          fixture_id?: string
          id?: string
          market_type?: string
          overround?: number | null
          p_1_bp?: number
          p_2_bp?: number
          p_x_bp?: number
          provider?: string
          raw_away_odds?: number | null
          raw_draw_odds?: number | null
          raw_home_odds?: number | null
          round_game_id?: string | null
          source_version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fixture_market_snapshots_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixture_market_snapshots_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id"]
          },
        ]
      }
      fixtures: {
        Row: {
          actual_kickoff_at: string | null
          away_score: number | null
          away_team_id: string
          competition_id: string | null
          created_at: string
          home_score: number | null
          home_team_id: string
          id: string
          kickoff_at: string
          last_synced_at: string | null
          leg_number: number | null
          neutral_venue: boolean
          round_name: string | null
          season_key: string | null
          stage_name: string | null
          status: string
          updated_at: string
        }
        Insert: {
          actual_kickoff_at?: string | null
          away_score?: number | null
          away_team_id: string
          competition_id?: string | null
          created_at?: string
          home_score?: number | null
          home_team_id: string
          id?: string
          kickoff_at: string
          last_synced_at?: string | null
          leg_number?: number | null
          neutral_venue?: boolean
          round_name?: string | null
          season_key?: string | null
          stage_name?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          actual_kickoff_at?: string | null
          away_score?: number | null
          away_team_id?: string
          competition_id?: string | null
          created_at?: string
          home_score?: number | null
          home_team_id?: string
          id?: string
          kickoff_at?: string
          last_synced_at?: string | null
          leg_number?: number | null
          neutral_venue?: boolean
          round_name?: string | null
          season_key?: string | null
          stage_name?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fixtures_away_team_id_fkey"
            columns: ["away_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixtures_competition_id_fkey"
            columns: ["competition_id"]
            isOneToOne: false
            referencedRelation: "competitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixtures_home_team_id_fkey"
            columns: ["home_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      group_members: {
        Row: {
          group_id: string
          joined_at: string
          left_at: string | null
          role: string
          status: string
          user_id: string
        }
        Insert: {
          group_id: string
          joined_at?: string
          left_at?: string | null
          role: string
          status?: string
          user_id: string
        }
        Update: {
          group_id?: string
          joined_at?: string
          left_at?: string | null
          role?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      group_round_settings: {
        Row: {
          consensus_double_policy: string
          created_from_group_defaults_at: string
          group_id: string
          locked_at: string | null
          max_doubles: number
          round_id: string
          visibility_policy: string
        }
        Insert: {
          consensus_double_policy?: string
          created_from_group_defaults_at?: string
          group_id: string
          locked_at?: string | null
          max_doubles: number
          round_id: string
          visibility_policy?: string
        }
        Update: {
          consensus_double_policy?: string
          created_from_group_defaults_at?: string
          group_id?: string
          locked_at?: string | null
          max_doubles?: number
          round_id?: string
          visibility_policy?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_round_settings_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_round_settings_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          created_at: string
          default_max_doubles: number
          id: string
          join_code: string
          join_code_rotated_at: string | null
          name: string
          owner_user_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          default_max_doubles?: number
          id?: string
          join_code: string
          join_code_rotated_at?: string | null
          name: string
          owner_user_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          default_max_doubles?: number
          id?: string
          join_code?: string
          join_code_rotated_at?: string | null
          name?: string
          owner_user_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      join_requests: {
        Row: {
          decided_at: string | null
          decided_by: string | null
          group_id: string
          id: string
          requested_at: string
          status: string
          user_id: string
        }
        Insert: {
          decided_at?: string | null
          decided_by?: string | null
          group_id: string
          id?: string
          requested_at?: string
          status?: string
          user_id: string
        }
        Update: {
          decided_at?: string | null
          decided_by?: string | null
          group_id?: string
          id?: string
          requested_at?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "join_requests_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      kapiloto_analyses: {
        Row: {
          availability: Json
          expected_lineups: Json | null
          tactical_facts: Json | null
          matchup_analysis: Json | null
          regime_changes: Json | null
          blend_weight: number | null
          carried_from_analysis_id: string | null
          conflicts: Json
          data_quality: Json
          deviation_cap_applied: boolean
          dimension_coverage: Json
          double_gain_score: number | null
          double_priority_rank: number | null
          fixture_id: string
          generated_at: string
          id: string
          key_assumptions: Json
          kickoff_at_snapshot: string
          main_risk: string | null
          market_snapshot_id: string | null
          model_self_confidence: string | null
          neutral_venue_snapshot: boolean
          orientation_verified: boolean
          outcome: string
          p_final_1_bp: number | null
          p_final_2_bp: number | null
          p_final_x_bp: number | null
          p_prior_1_bp: number | null
          p_prior_2_bp: number | null
          p_prior_x_bp: number | null
          p_sol_1_bp: number | null
          p_sol_2_bp: number | null
          p_sol_x_bp: number | null
          primary_pick: string | null
          prior_type: string | null
          reliability: number | null
          reliability_band: string | null
          reliability_reasons: Json
          research_cutoff_at: string
          research_run_id: string
          round_game_id: string
          round_id: string
          settlement_rule_snapshot: string
          suggested_double: string | null
          summary: string | null
          suspicious_content: Json
          valid_until: string | null
          watch_items: Json
        }
        Insert: {
          availability?: Json
          expected_lineups?: Json | null
          tactical_facts?: Json | null
          matchup_analysis?: Json | null
          regime_changes?: Json | null
          blend_weight?: number | null
          carried_from_analysis_id?: string | null
          conflicts?: Json
          data_quality?: Json
          deviation_cap_applied?: boolean
          dimension_coverage?: Json
          double_gain_score?: number | null
          double_priority_rank?: number | null
          fixture_id: string
          generated_at?: string
          id?: string
          key_assumptions?: Json
          kickoff_at_snapshot: string
          main_risk?: string | null
          market_snapshot_id?: string | null
          model_self_confidence?: string | null
          neutral_venue_snapshot?: boolean
          orientation_verified?: boolean
          outcome?: string
          p_final_1_bp?: number | null
          p_final_2_bp?: number | null
          p_final_x_bp?: number | null
          p_prior_1_bp?: number | null
          p_prior_2_bp?: number | null
          p_prior_x_bp?: number | null
          p_sol_1_bp?: number | null
          p_sol_2_bp?: number | null
          p_sol_x_bp?: number | null
          primary_pick?: string | null
          prior_type?: string | null
          reliability?: number | null
          reliability_band?: string | null
          reliability_reasons?: Json
          research_cutoff_at: string
          research_run_id: string
          round_game_id: string
          round_id: string
          settlement_rule_snapshot: string
          suggested_double?: string | null
          summary?: string | null
          suspicious_content?: Json
          valid_until?: string | null
          watch_items?: Json
        }
        Update: {
          availability?: Json
          expected_lineups?: Json | null
          tactical_facts?: Json | null
          matchup_analysis?: Json | null
          regime_changes?: Json | null
          blend_weight?: number | null
          carried_from_analysis_id?: string | null
          conflicts?: Json
          data_quality?: Json
          deviation_cap_applied?: boolean
          dimension_coverage?: Json
          double_gain_score?: number | null
          double_priority_rank?: number | null
          fixture_id?: string
          generated_at?: string
          id?: string
          key_assumptions?: Json
          kickoff_at_snapshot?: string
          main_risk?: string | null
          market_snapshot_id?: string | null
          model_self_confidence?: string | null
          neutral_venue_snapshot?: boolean
          orientation_verified?: boolean
          outcome?: string
          p_final_1_bp?: number | null
          p_final_2_bp?: number | null
          p_final_x_bp?: number | null
          p_prior_1_bp?: number | null
          p_prior_2_bp?: number | null
          p_prior_x_bp?: number | null
          p_sol_1_bp?: number | null
          p_sol_2_bp?: number | null
          p_sol_x_bp?: number | null
          primary_pick?: string | null
          prior_type?: string | null
          reliability?: number | null
          reliability_band?: string | null
          reliability_reasons?: Json
          research_cutoff_at?: string
          research_run_id?: string
          round_game_id?: string
          round_id?: string
          settlement_rule_snapshot?: string
          suggested_double?: string | null
          summary?: string | null
          suspicious_content?: Json
          valid_until?: string | null
          watch_items?: Json
        }
        Relationships: [
          {
            foreignKeyName: "kapiloto_analyses_carried_from_analysis_id_fkey"
            columns: ["carried_from_analysis_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_analyses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_analyses_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_analyses_market_snapshot_fixture_fk"
            columns: ["market_snapshot_id", "fixture_id"]
            isOneToOne: false
            referencedRelation: "fixture_market_snapshots"
            referencedColumns: ["id", "fixture_id"]
          },
          {
            foreignKeyName: "kapiloto_analyses_market_snapshot_id_round_game_id_fkey"
            columns: ["market_snapshot_id", "round_game_id"]
            isOneToOne: false
            referencedRelation: "fixture_market_snapshots"
            referencedColumns: ["id", "round_game_id"]
          },
          {
            foreignKeyName: "kapiloto_analyses_research_run_id_round_id_fkey"
            columns: ["research_run_id", "round_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_research_runs"
            referencedColumns: ["id", "round_id"]
          },
          {
            foreignKeyName: "kapiloto_analyses_round_game_id_round_id_fkey"
            columns: ["round_game_id", "round_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id", "round_id"]
          },
        ]
      }
      kapiloto_analysis_inputs: {
        Row: {
          analysis_id: string
          id: string
          input_type: string
          input_version: string | null
          metadata: Json
        }
        Insert: {
          analysis_id: string
          id?: string
          input_type: string
          input_version?: string | null
          metadata?: Json
        }
        Update: {
          analysis_id?: string
          id?: string
          input_type?: string
          input_version?: string | null
          metadata?: Json
        }
        Relationships: [
          {
            foreignKeyName: "kapiloto_analysis_inputs_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_analyses"
            referencedColumns: ["id"]
          },
        ]
      }
      kapiloto_evidence: {
        Row: {
          about_team: string
          analysis_id: string
          claim: string
          claim_type: string
          content_sha256: string | null
          domain: string
          entailment: string
          id: string
          model_evidence_id: string
          published_at: string | null
          quote: string
          quote_verified: boolean
          rejected_reason: string | null
          retrieved_at: string
          source_event_time: string | null
          status: string
          syndication_cluster_id: string | null
          trust_tier: number | null
          url_canonical: string
        }
        Insert: {
          about_team: string
          analysis_id: string
          claim: string
          claim_type: string
          content_sha256?: string | null
          domain: string
          entailment?: string
          id?: string
          model_evidence_id: string
          published_at?: string | null
          quote: string
          quote_verified?: boolean
          rejected_reason?: string | null
          retrieved_at: string
          source_event_time?: string | null
          status?: string
          syndication_cluster_id?: string | null
          trust_tier?: number | null
          url_canonical: string
        }
        Update: {
          about_team?: string
          analysis_id?: string
          claim?: string
          claim_type?: string
          content_sha256?: string | null
          domain?: string
          entailment?: string
          id?: string
          model_evidence_id?: string
          published_at?: string | null
          quote?: string
          quote_verified?: boolean
          rejected_reason?: string | null
          retrieved_at?: string
          source_event_time?: string | null
          status?: string
          syndication_cluster_id?: string | null
          trust_tier?: number | null
          url_canonical?: string
        }
        Relationships: [
          {
            foreignKeyName: "kapiloto_evidence_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_analyses"
            referencedColumns: ["id"]
          },
        ]
      }
      kapiloto_factor_evidence: {
        Row: {
          analysis_id: string
          evidence_id: string
          factor_id: string
        }
        Insert: {
          analysis_id: string
          evidence_id: string
          factor_id: string
        }
        Update: {
          analysis_id?: string
          evidence_id?: string
          factor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "kapiloto_factor_evidence_evidence_id_analysis_id_fkey"
            columns: ["evidence_id", "analysis_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_evidence"
            referencedColumns: ["id", "analysis_id"]
          },
          {
            foreignKeyName: "kapiloto_factor_evidence_factor_id_analysis_id_fkey"
            columns: ["factor_id", "analysis_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_factors"
            referencedColumns: ["id", "analysis_id"]
          },
        ]
      }
      kapiloto_factors: {
        Row: {
          analysis_id: string
          dimension: string
          favors: string
          id: string
          magnitude: string
          rationale: string
          matchup_ids: Json
        }
        Insert: {
          analysis_id: string
          dimension: string
          favors: string
          id?: string
          magnitude: string
          rationale: string
          matchup_ids?: Json
        }
        Update: {
          analysis_id?: string
          dimension?: string
          favors?: string
          id?: string
          magnitude?: string
          rationale?: string
          matchup_ids?: Json
        }
        Relationships: [
          {
            foreignKeyName: "kapiloto_factors_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_analyses"
            referencedColumns: ["id"]
          },
        ]
      }
      kapiloto_fixture_intelligence_state: {
        Row: {
          current_analysis_id: string | null
          current_publication_id: string | null
          fixture_id: string
          updated_at: string
          version: number
        }
        Insert: {
          current_analysis_id?: string | null
          current_publication_id?: string | null
          fixture_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          current_analysis_id?: string | null
          current_publication_id?: string | null
          fixture_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "kapiloto_fixture_intelligence_current_analysis_id_fixture__fkey"
            columns: ["current_analysis_id", "fixture_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_analyses"
            referencedColumns: ["id", "fixture_id"]
          },
          {
            foreignKeyName: "kapiloto_fixture_intelligence_state_current_publication_id_fkey"
            columns: ["current_publication_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_fixture_publications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_fixture_intelligence_state_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: true
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
        ]
      }
      kapiloto_fixture_publications: {
        Row: {
          analysis_id: string
          fixture_id: string
          id: string
          previous_analysis_id: string | null
          published_at: string
          research_run_id: string
          version_no: number
        }
        Insert: {
          analysis_id: string
          fixture_id: string
          id?: string
          previous_analysis_id?: string | null
          published_at?: string
          research_run_id: string
          version_no: number
        }
        Update: {
          analysis_id?: string
          fixture_id?: string
          id?: string
          previous_analysis_id?: string | null
          published_at?: string
          research_run_id?: string
          version_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "kapiloto_fixture_publications_analysis_id_fixture_id_fkey"
            columns: ["analysis_id", "fixture_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_analyses"
            referencedColumns: ["id", "fixture_id"]
          },
          {
            foreignKeyName: "kapiloto_fixture_publications_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_fixture_publications_previous_analysis_id_fkey"
            columns: ["previous_analysis_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_analyses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_fixture_publications_research_run_id_fkey"
            columns: ["research_run_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_research_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      kapiloto_freshness_signals: {
        Row: {
          data_version: string | null
          fixture_id: string
          id: number
          observed_at: string
          payload: Json
          round_game_id: string | null
          severity: number
          signal_type: string
          subject_player: string | null
          subject_team_id: string | null
        }
        Insert: {
          data_version?: string | null
          fixture_id: string
          id?: never
          observed_at: string
          payload?: Json
          round_game_id?: string | null
          severity: number
          signal_type: string
          subject_player?: string | null
          subject_team_id?: string | null
        }
        Update: {
          data_version?: string | null
          fixture_id?: string
          id?: never
          observed_at?: string
          payload?: Json
          round_game_id?: string | null
          severity?: number
          signal_type?: string
          subject_player?: string | null
          subject_team_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "kapiloto_freshness_signals_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_freshness_signals_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_freshness_signals_subject_team_id_fkey"
            columns: ["subject_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      kapiloto_research_attempts: {
        Row: {
          attempt_no: number
          available_at: string
          cached_input_tokens: number | null
          claimed_at: string | null
          cost_micros: number | null
          failure_class: string | null
          failure_code: string | null
          failure_detail: string | null
          finished_at: string | null
          fixture_id: string | null
          heartbeat_at: string | null
          id: string
          input_tokens: number | null
          lease_expires_at: string | null
          model_ms: number | null
          model_snapshot: string | null
          output_tokens: number | null
          pricing_version: string | null
          provider_request_ids: string[] | null
          provider_response_id: string | null
          queue_wait_ms: number | null
          raw_output_sha256: string | null
          raw_output_uri: string | null
          reasoning_tokens: number | null
          repair_calls: number
          round_game_id: string | null
          round_id: string
          run_id: string
          sources_count: number | null
          status: string
          task_key: string
          total_ms: number | null
          trace_id: string | null
          validated_output: Json | null
          validation_ms: number | null
          validation_report: Json | null
          web_search_calls: number | null
          worker_id: string | null
        }
        Insert: {
          attempt_no: number
          available_at?: string
          cached_input_tokens?: number | null
          claimed_at?: string | null
          cost_micros?: number | null
          failure_class?: string | null
          failure_code?: string | null
          failure_detail?: string | null
          finished_at?: string | null
          fixture_id?: string | null
          heartbeat_at?: string | null
          id?: string
          input_tokens?: number | null
          lease_expires_at?: string | null
          model_ms?: number | null
          model_snapshot?: string | null
          output_tokens?: number | null
          pricing_version?: string | null
          provider_request_ids?: string[] | null
          provider_response_id?: string | null
          queue_wait_ms?: number | null
          raw_output_sha256?: string | null
          raw_output_uri?: string | null
          reasoning_tokens?: number | null
          repair_calls?: number
          round_game_id?: string | null
          round_id: string
          run_id: string
          sources_count?: number | null
          status?: string
          task_key: string
          total_ms?: number | null
          trace_id?: string | null
          validated_output?: Json | null
          validation_ms?: number | null
          validation_report?: Json | null
          web_search_calls?: number | null
          worker_id?: string | null
        }
        Update: {
          attempt_no?: number
          available_at?: string
          cached_input_tokens?: number | null
          claimed_at?: string | null
          cost_micros?: number | null
          failure_class?: string | null
          failure_code?: string | null
          failure_detail?: string | null
          finished_at?: string | null
          fixture_id?: string | null
          heartbeat_at?: string | null
          id?: string
          input_tokens?: number | null
          lease_expires_at?: string | null
          model_ms?: number | null
          model_snapshot?: string | null
          output_tokens?: number | null
          pricing_version?: string | null
          provider_request_ids?: string[] | null
          provider_response_id?: string | null
          queue_wait_ms?: number | null
          raw_output_sha256?: string | null
          raw_output_uri?: string | null
          reasoning_tokens?: number | null
          repair_calls?: number
          round_game_id?: string | null
          round_id?: string
          run_id?: string
          sources_count?: number | null
          status?: string
          task_key?: string
          total_ms?: number | null
          trace_id?: string | null
          validated_output?: Json | null
          validation_ms?: number | null
          validation_report?: Json | null
          web_search_calls?: number | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "kapiloto_research_attempts_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_research_attempts_round_game_id_round_id_fkey"
            columns: ["round_game_id", "round_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id", "round_id"]
          },
          {
            foreignKeyName: "kapiloto_research_attempts_run_id_round_id_fkey"
            columns: ["run_id", "round_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_research_runs"
            referencedColumns: ["id", "round_id"]
          },
        ]
      }
      kapiloto_research_requests: {
        Row: {
          based_on_run_id: string | null
          created_at: string
          fixture_id: string | null
          id: string
          idempotency_key: string
          intent: string
          outcome: string | null
          request_sha256: string
          round_game_id: string | null
          round_id: string
          run_id: string | null
          user_id: string
        }
        Insert: {
          based_on_run_id?: string | null
          created_at?: string
          fixture_id?: string | null
          id?: string
          idempotency_key: string
          intent: string
          outcome?: string | null
          request_sha256: string
          round_game_id?: string | null
          round_id: string
          run_id?: string | null
          user_id: string
        }
        Update: {
          based_on_run_id?: string | null
          created_at?: string
          fixture_id?: string | null
          id?: string
          idempotency_key?: string
          intent?: string
          outcome?: string | null
          request_sha256?: string
          round_game_id?: string | null
          round_id?: string
          run_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "kapiloto_requests_based_on_run_fk"
            columns: ["based_on_run_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_research_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_requests_run_fk"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_research_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_research_requests_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_research_requests_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_research_requests_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      kapiloto_research_runs: {
        Row: {
          attempt_count: number
          based_on_run_id: string | null
          blend_policy_version: string
          budget_slot: number | null
          cached_input_tokens_total: number
          calibration_version: string | null
          completed_at: string | null
          cost_micros_total: number
          created_at: string
          derivation_version: string
          execution_topology: string
          failed_at: string | null
          failure_class: string | null
          failure_detail: string | null
          fixture_set: Json
          fixture_set_sha256: string
          id: string
          input_snapshot: Json | null
          input_snapshot_at: string | null
          input_tokens_total: number
          max_attempts_per_task: number
          model_key: string
          origin_request_id: string
          output_tokens_total: number
          prompt_template_sha256: string
          reasoning_tokens_total: number
          recency_policy_version: string
          reliability_formula_version: string
          research_cutoff_at: string
          research_protocol_version: string
          round_id: string
          round_synthesis: Json
          seq_no: number
          source_policy_version: string
          started_at: string | null
          status: string
          trigger_type: string
          web_search_calls_total: number
        }
        Insert: {
          attempt_count?: number
          based_on_run_id?: string | null
          blend_policy_version: string
          budget_slot?: number | null
          cached_input_tokens_total?: number
          calibration_version?: string | null
          completed_at?: string | null
          cost_micros_total?: number
          created_at?: string
          derivation_version: string
          execution_topology?: string
          failed_at?: string | null
          failure_class?: string | null
          failure_detail?: string | null
          fixture_set: Json
          fixture_set_sha256: string
          id?: string
          input_snapshot?: Json | null
          input_snapshot_at?: string | null
          input_tokens_total?: number
          max_attempts_per_task?: number
          model_key: string
          origin_request_id: string
          output_tokens_total?: number
          prompt_template_sha256: string
          reasoning_tokens_total?: number
          recency_policy_version: string
          reliability_formula_version: string
          research_cutoff_at: string
          research_protocol_version: string
          round_id: string
          round_synthesis?: Json
          seq_no: number
          source_policy_version: string
          started_at?: string | null
          status?: string
          trigger_type: string
          web_search_calls_total?: number
        }
        Update: {
          attempt_count?: number
          based_on_run_id?: string | null
          blend_policy_version?: string
          budget_slot?: number | null
          cached_input_tokens_total?: number
          calibration_version?: string | null
          completed_at?: string | null
          cost_micros_total?: number
          created_at?: string
          derivation_version?: string
          execution_topology?: string
          failed_at?: string | null
          failure_class?: string | null
          failure_detail?: string | null
          fixture_set?: Json
          fixture_set_sha256?: string
          id?: string
          input_snapshot?: Json | null
          input_snapshot_at?: string | null
          input_tokens_total?: number
          max_attempts_per_task?: number
          model_key?: string
          origin_request_id?: string
          output_tokens_total?: number
          prompt_template_sha256?: string
          reasoning_tokens_total?: number
          recency_policy_version?: string
          reliability_formula_version?: string
          research_cutoff_at?: string
          research_protocol_version?: string
          round_id?: string
          round_synthesis?: Json
          seq_no?: number
          source_policy_version?: string
          started_at?: string | null
          status?: string
          trigger_type?: string
          web_search_calls_total?: number
        }
        Relationships: [
          {
            foreignKeyName: "kapiloto_research_runs_based_on_run_id_fkey"
            columns: ["based_on_run_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_research_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_research_runs_origin_request_id_fkey"
            columns: ["origin_request_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_research_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_research_runs_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      kapiloto_round_research_state: {
        Row: {
          active_run_id: string | null
          attempts_total: number
          cost_micros_total: number
          current_run_id: string | null
          research_closed_at: string | null
          round_id: string
          runs_consumed: number
          updated_at: string
          version: number
        }
        Insert: {
          active_run_id?: string | null
          attempts_total?: number
          cost_micros_total?: number
          current_run_id?: string | null
          research_closed_at?: string | null
          round_id: string
          runs_consumed?: number
          updated_at?: string
          version?: number
        }
        Update: {
          active_run_id?: string | null
          attempts_total?: number
          cost_micros_total?: number
          current_run_id?: string | null
          research_closed_at?: string | null
          round_id?: string
          runs_consumed?: number
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "kapiloto_round_research_state_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: true
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kapiloto_state_active_run_fk"
            columns: ["active_run_id", "round_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_research_runs"
            referencedColumns: ["id", "round_id"]
          },
          {
            foreignKeyName: "kapiloto_state_current_run_fk"
            columns: ["current_run_id", "round_id"]
            isOneToOne: false
            referencedRelation: "kapiloto_research_runs"
            referencedColumns: ["id", "round_id"]
          },
        ]
      }
      kapiloto_source_registry: {
        Row: {
          coverage_metadata: Json
          denied: boolean
          domain: string
          languages: string[]
          metadata: Json
          publisher: string | null
          reviewed_at: string | null
          tier_by_claim_type: Json
        }
        Insert: {
          coverage_metadata?: Json
          denied?: boolean
          domain: string
          languages?: string[]
          metadata?: Json
          publisher?: string | null
          reviewed_at?: string | null
          tier_by_claim_type?: Json
        }
        Update: {
          coverage_metadata?: Json
          denied?: boolean
          domain?: string
          languages?: string[]
          metadata?: Json
          publisher?: string | null
          reviewed_at?: string | null
          tier_by_claim_type?: Json
        }
        Relationships: []
      }
      knowledge_claim_observations: {
        Row: {
          claim_id: string
          contract_version: string
          document_id: string
          document_version_id: string
          extracted_at: string
          extraction_confidence: number | null
          extractor_kind: string
          extractor_model: string | null
          extractor_version: string
          first_seen_at: string
          id: string
          independence_key: string
          observed_wording: string | null
          prompt_sha256: string | null
          quote: string | null
          quote_found: boolean | null
          relationship: string
          source_event_at: string | null
          source_event_text: string | null
          span_end: number | null
          span_start: number | null
          v3_evidence_id: string | null
        }
        Insert: {
          claim_id: string
          contract_version: string
          document_id: string
          document_version_id: string
          extracted_at: string
          extraction_confidence?: number | null
          extractor_kind: string
          extractor_model?: string | null
          extractor_version: string
          first_seen_at?: string
          id?: string
          independence_key: string
          observed_wording?: string | null
          prompt_sha256?: string | null
          quote?: string | null
          quote_found?: boolean | null
          relationship: string
          source_event_at?: string | null
          source_event_text?: string | null
          span_end?: number | null
          span_start?: number | null
          v3_evidence_id?: string | null
        }
        Update: {
          claim_id?: string
          contract_version?: string
          document_id?: string
          document_version_id?: string
          extracted_at?: string
          extraction_confidence?: number | null
          extractor_kind?: string
          extractor_model?: string | null
          extractor_version?: string
          first_seen_at?: string
          id?: string
          independence_key?: string
          observed_wording?: string | null
          prompt_sha256?: string | null
          quote?: string | null
          quote_found?: boolean | null
          relationship?: string
          source_event_at?: string | null
          source_event_text?: string | null
          span_end?: number | null
          span_start?: number | null
          v3_evidence_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_claim_observations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "knowledge_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_claim_observations_document_version_id_document__fkey"
            columns: ["document_version_id", "document_id"]
            isOneToOne: false
            referencedRelation: "knowledge_document_versions"
            referencedColumns: ["id", "document_id"]
          },
        ]
      }
      knowledge_claim_relations: {
        Row: {
          asserted_by_kind: string
          asserted_by_version: string
          first_seen_at: string
          from_claim_id: string
          id: string
          note: string | null
          relation_type: string
          to_claim_id: string
        }
        Insert: {
          asserted_by_kind: string
          asserted_by_version: string
          first_seen_at?: string
          from_claim_id: string
          id?: string
          note?: string | null
          relation_type: string
          to_claim_id: string
        }
        Update: {
          asserted_by_kind?: string
          asserted_by_version?: string
          first_seen_at?: string
          from_claim_id?: string
          id?: string
          note?: string | null
          relation_type?: string
          to_claim_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_claim_relations_from_claim_id_fkey"
            columns: ["from_claim_id"]
            isOneToOne: false
            referencedRelation: "knowledge_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_claim_relations_to_claim_id_fkey"
            columns: ["to_claim_id"]
            isOneToOne: false
            referencedRelation: "knowledge_claims"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_claim_resolutions: {
        Row: {
          claim_id: string
          confidence: number | null
          contract_version: string
          first_seen_at: string
          id: string
          idempotency_key: string | null
          ingest_statement_at: string
          note: string | null
          quality_flags: string[]
          reason_code: string
          resolution_version: number
          resolver_id: string | null
          resolver_kind: string
          resolver_version: string
          status: string
        }
        Insert: {
          claim_id: string
          confidence?: number | null
          contract_version: string
          first_seen_at?: string
          id?: string
          idempotency_key?: string | null
          ingest_statement_at?: string
          note?: string | null
          quality_flags?: string[]
          reason_code: string
          resolution_version: number
          resolver_id?: string | null
          resolver_kind: string
          resolver_version: string
          status: string
        }
        Update: {
          claim_id?: string
          confidence?: number | null
          contract_version?: string
          first_seen_at?: string
          id?: string
          idempotency_key?: string | null
          ingest_statement_at?: string
          note?: string | null
          quality_flags?: string[]
          reason_code?: string
          resolution_version?: number
          resolver_id?: string | null
          resolver_kind?: string
          resolver_version?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_claim_resolutions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "knowledge_claims"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_claims: {
        Row: {
          claim_fingerprint: string
          claim_kind: string
          claim_type: string
          coach_id: string | null
          contract_version: string
          first_seen_at: string
          fixture_id: string | null
          id: string
          object_value: Json
          player_id: string | null
          polarity: string
          predicate: string
          scope_ends_on: string | null
          scope_starts_on: string | null
          statement_text: string | null
          team_id: string | null
          temporal_scope: string
        }
        Insert: {
          claim_fingerprint: string
          claim_kind: string
          claim_type: string
          coach_id?: string | null
          contract_version: string
          first_seen_at?: string
          fixture_id?: string | null
          id?: string
          object_value?: Json
          player_id?: string | null
          polarity?: string
          predicate: string
          scope_ends_on?: string | null
          scope_starts_on?: string | null
          statement_text?: string | null
          team_id?: string | null
          temporal_scope: string
        }
        Update: {
          claim_fingerprint?: string
          claim_kind?: string
          claim_type?: string
          coach_id?: string | null
          contract_version?: string
          first_seen_at?: string
          fixture_id?: string | null
          id?: string
          object_value?: Json
          player_id?: string | null
          polarity?: string
          predicate?: string
          scope_ends_on?: string | null
          scope_starts_on?: string | null
          statement_text?: string | null
          team_id?: string | null
          temporal_scope?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_claims_coach_id_fkey"
            columns: ["coach_id"]
            isOneToOne: false
            referencedRelation: "coaches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_claims_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_claims_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_claims_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_document_versions: {
        Row: {
          access_basis: string
          author: string | null
          canonical_url: string | null
          content_sha256: string
          contract_version: string
          discovered_at: string | null
          discovery_channel: string | null
          discovery_query_sha256: string | null
          discovery_rank: number | null
          document_id: string
          extracted_text: string | null
          extraction_version: string
          first_seen_at: string
          id: string
          ingest_version: string
          language_code: string | null
          may_expose_excerpts: boolean
          may_retain_raw: boolean
          may_retain_text: boolean
          metadata: Json
          published_at: string | null
          raw_content_sha256: string | null
          raw_content_uri: string | null
          retrieved_at: string
          rights_note: string | null
          source_updated_at: string | null
          syndication_cluster: string | null
          title: string | null
          version_fingerprint: string
          version_no: number
        }
        Insert: {
          access_basis: string
          author?: string | null
          canonical_url?: string | null
          content_sha256: string
          contract_version: string
          discovered_at?: string | null
          discovery_channel?: string | null
          discovery_query_sha256?: string | null
          discovery_rank?: number | null
          document_id: string
          extracted_text?: string | null
          extraction_version: string
          first_seen_at?: string
          id?: string
          ingest_version: string
          language_code?: string | null
          may_expose_excerpts?: boolean
          may_retain_raw?: boolean
          may_retain_text?: boolean
          metadata?: Json
          published_at?: string | null
          raw_content_sha256?: string | null
          raw_content_uri?: string | null
          retrieved_at: string
          rights_note?: string | null
          source_updated_at?: string | null
          syndication_cluster?: string | null
          title?: string | null
          version_fingerprint: string
          version_no: number
        }
        Update: {
          access_basis?: string
          author?: string | null
          canonical_url?: string | null
          content_sha256?: string
          contract_version?: string
          discovered_at?: string | null
          discovery_channel?: string | null
          discovery_query_sha256?: string | null
          discovery_rank?: number | null
          document_id?: string
          extracted_text?: string | null
          extraction_version?: string
          first_seen_at?: string
          id?: string
          ingest_version?: string
          language_code?: string | null
          may_expose_excerpts?: boolean
          may_retain_raw?: boolean
          may_retain_text?: boolean
          metadata?: Json
          published_at?: string | null
          raw_content_sha256?: string | null
          raw_content_uri?: string | null
          retrieved_at?: string
          rights_note?: string | null
          source_updated_at?: string | null
          syndication_cluster?: string | null
          title?: string | null
          version_fingerprint?: string
          version_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_document_versions_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "knowledge_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_documents: {
        Row: {
          canonical_url: string | null
          domain: string | null
          external_id: string | null
          first_seen_at: string
          id: string
          identity_key: string | null
          platform: string | null
          provider: string | null
          publisher: string | null
          source_account: string | null
          source_kind: string
        }
        Insert: {
          canonical_url?: string | null
          domain?: string | null
          external_id?: string | null
          first_seen_at?: string
          id?: string
          identity_key?: never
          platform?: string | null
          provider?: string | null
          publisher?: string | null
          source_account?: string | null
          source_kind: string
        }
        Update: {
          canonical_url?: string | null
          domain?: string | null
          external_id?: string | null
          first_seen_at?: string
          id?: string
          identity_key?: never
          platform?: string | null
          provider?: string | null
          publisher?: string | null
          source_account?: string | null
          source_kind?: string
        }
        Relationships: [

        ]
      }
      knowledge_resolution_evidence: {
        Row: {
          claim_observation_id: string | null
          document_version_id: string | null
          evidence_first_seen_at: string
          evidence_role: string
          id: string
          ledger_event_id: string | null
          ledger_observation_id: string | null
          ledger_player_id: string | null
          note: string | null
          resolution_id: string
        }
        Insert: {
          claim_observation_id?: string | null
          document_version_id?: string | null
          evidence_first_seen_at: string
          evidence_role: string
          id?: string
          ledger_event_id?: string | null
          ledger_observation_id?: string | null
          ledger_player_id?: string | null
          note?: string | null
          resolution_id: string
        }
        Update: {
          claim_observation_id?: string | null
          document_version_id?: string | null
          evidence_first_seen_at?: string
          evidence_role?: string
          id?: string
          ledger_event_id?: string | null
          ledger_observation_id?: string | null
          ledger_player_id?: string | null
          note?: string | null
          resolution_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_resolution_evidence_claim_observation_id_fkey"
            columns: ["claim_observation_id"]
            isOneToOne: false
            referencedRelation: "knowledge_claim_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_resolution_evidence_document_version_id_fkey"
            columns: ["document_version_id"]
            isOneToOne: false
            referencedRelation: "knowledge_document_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_resolution_evidence_ledger_event_id_fkey"
            columns: ["ledger_event_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_resolution_evidence_ledger_observation_id_fkey"
            columns: ["ledger_observation_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_resolution_evidence_ledger_player_id_fkey"
            columns: ["ledger_player_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_resolution_evidence_resolution_id_fkey"
            columns: ["resolution_id"]
            isOneToOne: false
            referencedRelation: "knowledge_claim_resolutions"
            referencedColumns: ["id"]
          },
        ]
      }
      match_ledger_events: {
        Row: {
          coach_id: string | null
          detail: Json
          event_type: string
          id: string
          minute: number | null
          observation_id: string
          period: string | null
          player_id: string | null
          provider_event_id: string | null
          provider_event_type: string | null
          related_player_id: string | null
          second: number | null
          sequence_no: number
          staff_role: string | null
          stoppage_minute: number | null
          team_id: string
        }
        Insert: {
          coach_id?: string | null
          detail?: Json
          event_type: string
          id?: string
          minute?: number | null
          observation_id: string
          period?: string | null
          player_id?: string | null
          provider_event_id?: string | null
          provider_event_type?: string | null
          related_player_id?: string | null
          second?: number | null
          sequence_no: number
          staff_role?: string | null
          stoppage_minute?: number | null
          team_id: string
        }
        Update: {
          coach_id?: string | null
          detail?: Json
          event_type?: string
          id?: string
          minute?: number | null
          observation_id?: string
          period?: string | null
          player_id?: string | null
          provider_event_id?: string | null
          provider_event_type?: string | null
          related_player_id?: string | null
          second?: number | null
          sequence_no?: number
          staff_role?: string | null
          stoppage_minute?: number | null
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_ledger_events_coach_id_fkey"
            columns: ["coach_id"]
            isOneToOne: false
            referencedRelation: "coaches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_ledger_events_observation_id_related_player_id_fkey"
            columns: ["observation_id", "related_player_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_players"
            referencedColumns: ["observation_id", "player_id"]
          },
          {
            foreignKeyName: "match_ledger_events_observation_id_team_id_fkey"
            columns: ["observation_id", "team_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_team_records"
            referencedColumns: ["observation_id", "team_id"]
          },
          {
            foreignKeyName: "match_ledger_events_observation_id_team_id_player_id_fkey"
            columns: ["observation_id", "team_id", "player_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_players"
            referencedColumns: ["observation_id", "team_id", "player_id"]
          },
        ]
      }
      match_ledger_game_state_segments: {
        Row: {
          derivation_version: string
          derived_at: string
          from_minute: number
          from_stoppage_minute: number
          goals_against: number
          goals_for: number
          id: string
          men_against: number
          men_diff: number | null
          men_for: number
          observation_id: string
          period: string
          score_diff: number | null
          segment_index: number
          team_id: string
          to_minute: number
          to_stoppage_minute: number
        }
        Insert: {
          derivation_version: string
          derived_at?: string
          from_minute: number
          from_stoppage_minute?: number
          goals_against: number
          goals_for: number
          id?: string
          men_against: number
          men_diff?: never
          men_for: number
          observation_id: string
          period: string
          score_diff?: never
          segment_index: number
          team_id: string
          to_minute: number
          to_stoppage_minute?: number
        }
        Update: {
          derivation_version?: string
          derived_at?: string
          from_minute?: number
          from_stoppage_minute?: number
          goals_against?: number
          goals_for?: number
          id?: string
          men_against?: number
          men_diff?: never
          men_for?: number
          observation_id?: string
          period?: string
          score_diff?: never
          segment_index?: number
          team_id?: string
          to_minute?: number
          to_stoppage_minute?: number
        }
        Relationships: [
          {
            foreignKeyName: "match_ledger_game_state_segments_observation_id_team_id_fkey"
            columns: ["observation_id", "team_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_team_records"
            referencedColumns: ["observation_id", "team_id"]
          },
        ]
      }
      match_ledger_observations: {
        Row: {
          away_goals_90: number | null
          away_goals_aet: number | null
          away_penalties: number | null
          capture_mode: string
          content_sha256: string
          contract_version: string
          first_seen_at: string
          fixture_id: string
          home_goals_90: number | null
          home_goals_aet: number | null
          home_penalties: number | null
          id: string
          ingest_statement_at: string
          ingest_version: string
          kickoff_at: string | null
          match_status: string | null
          neutral_venue: boolean | null
          observation_kind: string
          observation_version: number
          provider: string
          provider_endpoint: string | null
          provider_fixture_id: string
          raw_observation_id: string | null
          raw_payload_sha256: string | null
          retrieved_at: string
          source_updated_at: string | null
          source_version: string | null
          withdrawal_reason: string | null
        }
        Insert: {
          away_goals_90?: number | null
          away_goals_aet?: number | null
          away_penalties?: number | null
          capture_mode: string
          content_sha256: string
          contract_version: string
          first_seen_at?: string
          fixture_id: string
          home_goals_90?: number | null
          home_goals_aet?: number | null
          home_penalties?: number | null
          id?: string
          ingest_statement_at?: string
          ingest_version: string
          kickoff_at?: string | null
          match_status?: string | null
          neutral_venue?: boolean | null
          observation_kind?: string
          observation_version: number
          provider: string
          provider_endpoint?: string | null
          provider_fixture_id: string
          raw_observation_id?: string | null
          raw_payload_sha256?: string | null
          retrieved_at: string
          source_updated_at?: string | null
          source_version?: string | null
          withdrawal_reason?: string | null
        }
        Update: {
          away_goals_90?: number | null
          away_goals_aet?: number | null
          away_penalties?: number | null
          capture_mode?: string
          content_sha256?: string
          contract_version?: string
          first_seen_at?: string
          fixture_id?: string
          home_goals_90?: number | null
          home_goals_aet?: number | null
          home_penalties?: number | null
          id?: string
          ingest_statement_at?: string
          ingest_version?: string
          kickoff_at?: string | null
          match_status?: string | null
          neutral_venue?: boolean | null
          observation_kind?: string
          observation_version?: number
          provider?: string
          provider_endpoint?: string | null
          provider_fixture_id?: string
          raw_observation_id?: string | null
          raw_payload_sha256?: string | null
          retrieved_at?: string
          source_updated_at?: string | null
          source_version?: string | null
          withdrawal_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "match_ledger_observations_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
        ]
      }
      match_ledger_players: {
        Row: {
          appeared: boolean | null
          data_completeness: string
          entered_minute: number | null
          exited_minute: number | null
          first_seen_at: string
          formation_field: string | null
          formation_position: number | null
          id: string
          is_captain: boolean | null
          kickoff_at: string
          lineup_role: string
          minutes_played: number | null
          observation_id: string
          player_id: string
          position_code: string | null
          provider_player_id: string | null
          provider_player_name: string | null
          provider_position: string | null
          shirt_number: number | null
          team_id: string
        }
        Insert: {
          appeared?: boolean | null
          data_completeness: string
          entered_minute?: number | null
          exited_minute?: number | null
          first_seen_at: string
          formation_field?: string | null
          formation_position?: number | null
          id?: string
          is_captain?: boolean | null
          kickoff_at: string
          lineup_role: string
          minutes_played?: number | null
          observation_id: string
          player_id: string
          position_code?: string | null
          provider_player_id?: string | null
          provider_player_name?: string | null
          provider_position?: string | null
          shirt_number?: number | null
          team_id: string
        }
        Update: {
          appeared?: boolean | null
          data_completeness?: string
          entered_minute?: number | null
          exited_minute?: number | null
          first_seen_at?: string
          formation_field?: string | null
          formation_position?: number | null
          id?: string
          is_captain?: boolean | null
          kickoff_at?: string
          lineup_role?: string
          minutes_played?: number | null
          observation_id?: string
          player_id?: string
          position_code?: string | null
          provider_player_id?: string | null
          provider_player_name?: string | null
          provider_position?: string | null
          shirt_number?: number | null
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_ledger_players_observation_id_team_id_fkey"
            columns: ["observation_id", "team_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_team_records"
            referencedColumns: ["observation_id", "team_id"]
          },
          {
            foreignKeyName: "match_ledger_players_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      match_ledger_stat_definitions: {
        Row: {
          created_at: string
          definition_version: string
          description: string | null
          id: string
          provider: string
          provider_stat_name: string | null
          provider_stat_type: string
          stat_key: string
          unit: string
        }
        Insert: {
          created_at?: string
          definition_version: string
          description?: string | null
          id?: string
          provider: string
          provider_stat_name?: string | null
          provider_stat_type: string
          stat_key: string
          unit: string
        }
        Update: {
          created_at?: string
          definition_version?: string
          description?: string | null
          id?: string
          provider?: string
          provider_stat_name?: string | null
          provider_stat_type?: string
          stat_key?: string
          unit?: string
        }
        Relationships: [

        ]
      }
      match_ledger_substitutions: {
        Row: {
          id: string
          minute: number | null
          observation_id: string
          period: string | null
          player_off_id: string
          player_on_id: string
          provider_event_id: string | null
          reason: string | null
          sequence_no: number
          stoppage_minute: number | null
          team_id: string
        }
        Insert: {
          id?: string
          minute?: number | null
          observation_id: string
          period?: string | null
          player_off_id: string
          player_on_id: string
          provider_event_id?: string | null
          reason?: string | null
          sequence_no: number
          stoppage_minute?: number | null
          team_id: string
        }
        Update: {
          id?: string
          minute?: number | null
          observation_id?: string
          period?: string | null
          player_off_id?: string
          player_on_id?: string
          provider_event_id?: string | null
          reason?: string | null
          sequence_no?: number
          stoppage_minute?: number | null
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_ledger_substitutions_observation_id_team_id_fkey"
            columns: ["observation_id", "team_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_team_records"
            referencedColumns: ["observation_id", "team_id"]
          },
          {
            foreignKeyName: "match_ledger_substitutions_observation_id_team_id_player__fkey1"
            columns: ["observation_id", "team_id", "player_on_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_players"
            referencedColumns: ["observation_id", "team_id", "player_id"]
          },
          {
            foreignKeyName: "match_ledger_substitutions_observation_id_team_id_player_o_fkey"
            columns: ["observation_id", "team_id", "player_off_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_players"
            referencedColumns: ["observation_id", "team_id", "player_id"]
          },
        ]
      }
      match_ledger_team_records: {
        Row: {
          coach_id: string | null
          events_status: string
          first_seen_at: string
          fixture_id: string
          formation_nominal: string | null
          id: string
          kickoff_at: string
          lineup_status: string
          observation_id: string
          opponent_team_id: string
          provider_coach_id: string | null
          provider_coach_name: string | null
          side: string
          statistics_status: string
          substitutions_status: string
          team_id: string
        }
        Insert: {
          coach_id?: string | null
          events_status: string
          first_seen_at: string
          fixture_id: string
          formation_nominal?: string | null
          id?: string
          kickoff_at: string
          lineup_status: string
          observation_id: string
          opponent_team_id: string
          provider_coach_id?: string | null
          provider_coach_name?: string | null
          side: string
          statistics_status: string
          substitutions_status: string
          team_id: string
        }
        Update: {
          coach_id?: string | null
          events_status?: string
          first_seen_at?: string
          fixture_id?: string
          formation_nominal?: string | null
          id?: string
          kickoff_at?: string
          lineup_status?: string
          observation_id?: string
          opponent_team_id?: string
          provider_coach_id?: string | null
          provider_coach_name?: string | null
          side?: string
          statistics_status?: string
          substitutions_status?: string
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_ledger_team_records_coach_id_fkey"
            columns: ["coach_id"]
            isOneToOne: false
            referencedRelation: "coaches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_ledger_team_records_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_ledger_team_records_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_ledger_team_records_opponent_team_id_fkey"
            columns: ["opponent_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_ledger_team_records_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      match_ledger_team_stats: {
        Row: {
          id: string
          observation_id: string
          period: string
          stat_definition_id: string
          team_id: string
          value_numeric: number
        }
        Insert: {
          id?: string
          observation_id: string
          period?: string
          stat_definition_id: string
          team_id: string
          value_numeric: number
        }
        Update: {
          id?: string
          observation_id?: string
          period?: string
          stat_definition_id?: string
          team_id?: string
          value_numeric?: number
        }
        Relationships: [
          {
            foreignKeyName: "match_ledger_team_stats_observation_id_team_id_fkey"
            columns: ["observation_id", "team_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_team_records"
            referencedColumns: ["observation_id", "team_id"]
          },
          {
            foreignKeyName: "match_ledger_team_stats_stat_definition_id_fkey"
            columns: ["stat_definition_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_stat_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      player_aliases: {
        Row: {
          alias: string
          alias_kind: string
          created_at: string
          id: string
          language_code: string | null
          normalized_alias: string | null
          player_id: string
          provider: string | null
          source: string
        }
        Insert: {
          alias: string
          alias_kind: string
          created_at?: string
          id?: string
          language_code?: string | null
          normalized_alias?: never
          player_id: string
          provider?: string | null
          source?: string
        }
        Update: {
          alias?: string
          alias_kind?: string
          created_at?: string
          id?: string
          language_code?: string | null
          normalized_alias?: never
          player_id?: string
          provider?: string | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_aliases_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      players: {
        Row: {
          canonical_name: string
          created_at: string
          date_of_birth: string | null
          height_cm: number | null
          id: string
          identity_status: string
          merged_into_player_id: string | null
          nationality_code: string | null
          updated_at: string
        }
        Insert: {
          canonical_name: string
          created_at?: string
          date_of_birth?: string | null
          height_cm?: number | null
          id?: string
          identity_status?: string
          merged_into_player_id?: string | null
          nationality_code?: string | null
          updated_at?: string
        }
        Update: {
          canonical_name?: string
          created_at?: string
          date_of_birth?: string | null
          height_cm?: number | null
          id?: string
          identity_status?: string
          merged_into_player_id?: string | null
          nationality_code?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "players_merged_into_player_id_fkey"
            columns: ["merged_into_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_claim_inputs: {
        Row: {
          claim_id: string
          input_first_seen_at: string
          input_role: string
          resolution_id: string | null
          resolution_status: string
          snapshot_id: string
        }
        Insert: {
          claim_id: string
          input_first_seen_at: string
          input_role: string
          resolution_id?: string | null
          resolution_status: string
          snapshot_id: string
        }
        Update: {
          claim_id?: string
          input_first_seen_at?: string
          input_role?: string
          resolution_id?: string | null
          resolution_status?: string
          snapshot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prediction_claim_inputs_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "knowledge_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_claim_inputs_resolution_id_claim_id_fkey"
            columns: ["resolution_id", "claim_id"]
            isOneToOne: false
            referencedRelation: "knowledge_claim_resolutions"
            referencedColumns: ["id", "claim_id"]
          },
          {
            foreignKeyName: "prediction_claim_inputs_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "prediction_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_claim_observation_inputs: {
        Row: {
          claim_observation_id: string
          input_first_seen_at: string
          input_role: string
          snapshot_id: string
        }
        Insert: {
          claim_observation_id: string
          input_first_seen_at: string
          input_role: string
          snapshot_id: string
        }
        Update: {
          claim_observation_id?: string
          input_first_seen_at?: string
          input_role?: string
          snapshot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prediction_claim_observation_inputs_claim_observation_id_fkey"
            columns: ["claim_observation_id"]
            isOneToOne: false
            referencedRelation: "knowledge_claim_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_claim_observation_inputs_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "prediction_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_document_inputs: {
        Row: {
          document_version_id: string
          input_first_seen_at: string
          input_role: string
          snapshot_id: string
        }
        Insert: {
          document_version_id: string
          input_first_seen_at: string
          input_role: string
          snapshot_id: string
        }
        Update: {
          document_version_id?: string
          input_first_seen_at?: string
          input_role?: string
          snapshot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prediction_document_inputs_document_version_id_fkey"
            columns: ["document_version_id"]
            isOneToOne: false
            referencedRelation: "knowledge_document_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_document_inputs_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "prediction_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_identity_bindings: {
        Row: {
          binding_role: string
          coach_id: string | null
          context_team_id: string | null
          entity_type: string
          id: string
          observed_coach_id: string | null
          observed_player_id: string | null
          player_id: string | null
          provider: string | null
          provider_entity_id: string | null
          snapshot_id: string
          team_id: string | null
        }
        Insert: {
          binding_role: string
          coach_id?: string | null
          context_team_id?: string | null
          entity_type: string
          id?: string
          observed_coach_id?: string | null
          observed_player_id?: string | null
          player_id?: string | null
          provider?: string | null
          provider_entity_id?: string | null
          snapshot_id: string
          team_id?: string | null
        }
        Update: {
          binding_role?: string
          coach_id?: string | null
          context_team_id?: string | null
          entity_type?: string
          id?: string
          observed_coach_id?: string | null
          observed_player_id?: string | null
          player_id?: string | null
          provider?: string | null
          provider_entity_id?: string | null
          snapshot_id?: string
          team_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "prediction_identity_bindings_coach_id_fkey"
            columns: ["coach_id"]
            isOneToOne: false
            referencedRelation: "coaches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_identity_bindings_context_team_id_fkey"
            columns: ["context_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_identity_bindings_observed_coach_id_fkey"
            columns: ["observed_coach_id"]
            isOneToOne: false
            referencedRelation: "coaches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_identity_bindings_observed_player_id_fkey"
            columns: ["observed_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_identity_bindings_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_identity_bindings_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "prediction_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_identity_bindings_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_ledger_inputs: {
        Row: {
          input_first_seen_at: string
          input_role: string
          ledger_observation_id: string
          snapshot_id: string
        }
        Insert: {
          input_first_seen_at: string
          input_role: string
          ledger_observation_id: string
          snapshot_id: string
        }
        Update: {
          input_first_seen_at?: string
          input_role?: string
          ledger_observation_id?: string
          snapshot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prediction_ledger_inputs_ledger_observation_id_fkey"
            columns: ["ledger_observation_id"]
            isOneToOne: false
            referencedRelation: "match_ledger_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_ledger_inputs_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "prediction_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_reference_inputs: {
        Row: {
          fact_snapshot_id: string | null
          id: string
          input_role: string
          input_time_at: string | null
          legacy_v3_id: string | null
          market_quote_id: string | null
          market_snapshot_id: string | null
          reference_kind: string
          referenced_row_sha256: string | null
          snapshot_id: string
          structured_snapshot_id: string | null
        }
        Insert: {
          fact_snapshot_id?: string | null
          id?: string
          input_role: string
          input_time_at?: string | null
          legacy_v3_id?: string | null
          market_quote_id?: string | null
          market_snapshot_id?: string | null
          reference_kind: string
          referenced_row_sha256?: string | null
          snapshot_id: string
          structured_snapshot_id?: string | null
        }
        Update: {
          fact_snapshot_id?: string | null
          id?: string
          input_role?: string
          input_time_at?: string | null
          legacy_v3_id?: string | null
          market_quote_id?: string | null
          market_snapshot_id?: string | null
          reference_kind?: string
          referenced_row_sha256?: string | null
          snapshot_id?: string
          structured_snapshot_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "prediction_reference_inputs_fact_snapshot_id_fkey"
            columns: ["fact_snapshot_id"]
            isOneToOne: false
            referencedRelation: "fixture_fact_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_reference_inputs_market_snapshot_id_fkey"
            columns: ["market_snapshot_id"]
            isOneToOne: false
            referencedRelation: "fixture_market_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_reference_inputs_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "prediction_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_reference_inputs_structured_snapshot_id_fkey"
            columns: ["structured_snapshot_id"]
            isOneToOne: false
            referencedRelation: "fixture_structured_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_snapshots: {
        Row: {
          abstain_reason: string | null
          calibration_version: string | null
          code_revision: string
          contract_version: string
          derivation_version: string | null
          feature_versions: Json
          first_seen_at: string
          fixture_id: string
          generated_at: string
          id: string
          idempotency_key: string
          ingest_statement_at: string
          input_bundle_sha256: string
          kickoff_at_snapshot: string
          model_identifiers: Json
          outcome: string
          output_bundle_sha256: string
          p_1_bp: number | null
          p_2_bp: number | null
          p_x_bp: number | null
          payload: Json
          payload_schema_version: string
          pipeline_version: string
          prediction_protocol_version: string
          prompt_hashes: Json
          purpose: string
          reliability: number | null
          research_cutoff_at: string
          round_game_id: string | null
          settlement_rule: string | null
          uncertainty: Json
        }
        Insert: {
          abstain_reason?: string | null
          calibration_version?: string | null
          code_revision: string
          contract_version: string
          derivation_version?: string | null
          feature_versions?: Json
          first_seen_at?: string
          fixture_id: string
          generated_at: string
          id?: string
          idempotency_key: string
          ingest_statement_at?: string
          input_bundle_sha256: string
          kickoff_at_snapshot: string
          model_identifiers?: Json
          outcome: string
          output_bundle_sha256: string
          p_1_bp?: number | null
          p_2_bp?: number | null
          p_x_bp?: number | null
          payload?: Json
          payload_schema_version: string
          pipeline_version: string
          prediction_protocol_version: string
          prompt_hashes?: Json
          purpose: string
          reliability?: number | null
          research_cutoff_at: string
          round_game_id?: string | null
          settlement_rule?: string | null
          uncertainty?: Json
        }
        Update: {
          abstain_reason?: string | null
          calibration_version?: string | null
          code_revision?: string
          contract_version?: string
          derivation_version?: string | null
          feature_versions?: Json
          first_seen_at?: string
          fixture_id?: string
          generated_at?: string
          id?: string
          idempotency_key?: string
          ingest_statement_at?: string
          input_bundle_sha256?: string
          kickoff_at_snapshot?: string
          model_identifiers?: Json
          outcome?: string
          output_bundle_sha256?: string
          p_1_bp?: number | null
          p_2_bp?: number | null
          p_x_bp?: number | null
          payload?: Json
          payload_schema_version?: string
          pipeline_version?: string
          prediction_protocol_version?: string
          prompt_hashes?: Json
          purpose?: string
          reliability?: number | null
          research_cutoff_at?: string
          round_game_id?: string | null
          settlement_rule?: string | null
          uncertainty?: Json
        }
        Relationships: [
          {
            foreignKeyName: "prediction_snapshots_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_snapshots_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          normalized_username: string | null
          updated_at: string
          username: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          normalized_username?: string | null
          updated_at?: string
          username: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          normalized_username?: string | null
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
      provider_coach_mappings: {
        Row: {
          coach_id: string
          created_at: string
          last_verified_at: string | null
          mapping_confidence: number | null
          mapping_status: string
          provider: string
          provider_coach_id: string
          provider_name: string | null
          updated_at: string
        }
        Insert: {
          coach_id: string
          created_at?: string
          last_verified_at?: string | null
          mapping_confidence?: number | null
          mapping_status?: string
          provider: string
          provider_coach_id: string
          provider_name?: string | null
          updated_at?: string
        }
        Update: {
          coach_id?: string
          created_at?: string
          last_verified_at?: string | null
          mapping_confidence?: number | null
          mapping_status?: string
          provider?: string
          provider_coach_id?: string
          provider_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_coach_mappings_coach_id_fkey"
            columns: ["coach_id"]
            isOneToOne: false
            referencedRelation: "coaches"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_competition_mappings: {
        Row: {
          competition_id: string
          last_verified_at: string | null
          mapping_status: string
          provider: string
          provider_competition_id: string
          provider_name: string | null
        }
        Insert: {
          competition_id: string
          last_verified_at?: string | null
          mapping_status?: string
          provider: string
          provider_competition_id: string
          provider_name?: string | null
        }
        Update: {
          competition_id?: string
          last_verified_at?: string | null
          mapping_status?: string
          provider?: string
          provider_competition_id?: string
          provider_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provider_competition_mappings_competition_id_fkey"
            columns: ["competition_id"]
            isOneToOne: false
            referencedRelation: "competitions"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_fixture_mappings: {
        Row: {
          fixture_id: string
          mapped_at: string
          mapped_by: string | null
          mapping_confidence: number | null
          mapping_status: string
          provider: string
          provider_fixture_id: string
          round_game_id: string | null
        }
        Insert: {
          fixture_id: string
          mapped_at?: string
          mapped_by?: string | null
          mapping_confidence?: number | null
          mapping_status?: string
          provider: string
          provider_fixture_id: string
          round_game_id?: string | null
        }
        Update: {
          fixture_id?: string
          mapped_at?: string
          mapped_by?: string | null
          mapping_confidence?: number | null
          mapping_status?: string
          provider?: string
          provider_fixture_id?: string
          round_game_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provider_fixture_mappings_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_fixture_mappings_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_player_mappings: {
        Row: {
          created_at: string
          last_verified_at: string | null
          mapping_confidence: number | null
          mapping_status: string
          player_id: string
          provider: string
          provider_name: string | null
          provider_player_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          last_verified_at?: string | null
          mapping_confidence?: number | null
          mapping_status?: string
          player_id: string
          provider: string
          provider_name?: string | null
          provider_player_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          last_verified_at?: string | null
          mapping_confidence?: number | null
          mapping_status?: string
          player_id?: string
          provider?: string
          provider_name?: string | null
          provider_player_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_player_mappings_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_team_mappings: {
        Row: {
          last_verified_at: string | null
          mapping_confidence: number | null
          mapping_status: string
          provider: string
          provider_name: string | null
          provider_team_id: string
          team_id: string
        }
        Insert: {
          last_verified_at?: string | null
          mapping_confidence?: number | null
          mapping_status?: string
          provider: string
          provider_name?: string | null
          provider_team_id: string
          team_id: string
        }
        Update: {
          last_verified_at?: string | null
          mapping_confidence?: number | null
          mapping_status?: string
          provider?: string
          provider_name?: string | null
          provider_team_id?: string
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_team_mappings_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      round_games: {
        Row: {
          actual_kickoff_at: string | null
          aggregate_away_score: number | null
          aggregate_home_score: number | null
          away_team_id: string
          competition_id: string | null
          competition_name_snapshot: string
          competition_stage_snapshot: string | null
          created_at: string
          field_away_score: number | null
          field_home_score: number | null
          field_outcome: string | null
          fixture_id: string
          game_number: number
          home_team_id: string
          id: string
          kickoff_at: string
          last_synced_at: string | null
          leg_number: number | null
          neutral_venue: boolean
          pool_settlement_outcome: string | null
          round_id: string
          settlement_confirmed_at: string | null
          settlement_rule: string | null
          settlement_source: string | null
          settlement_status: string
          status: string
        }
        Insert: {
          actual_kickoff_at?: string | null
          aggregate_away_score?: number | null
          aggregate_home_score?: number | null
          away_team_id: string
          competition_id?: string | null
          competition_name_snapshot: string
          competition_stage_snapshot?: string | null
          created_at?: string
          field_away_score?: number | null
          field_home_score?: number | null
          field_outcome?: string | null
          fixture_id: string
          game_number: number
          home_team_id: string
          id?: string
          kickoff_at: string
          last_synced_at?: string | null
          leg_number?: number | null
          neutral_venue?: boolean
          pool_settlement_outcome?: string | null
          round_id: string
          settlement_confirmed_at?: string | null
          settlement_rule?: string | null
          settlement_source?: string | null
          settlement_status?: string
          status?: string
        }
        Update: {
          actual_kickoff_at?: string | null
          aggregate_away_score?: number | null
          aggregate_home_score?: number | null
          away_team_id?: string
          competition_id?: string | null
          competition_name_snapshot?: string
          competition_stage_snapshot?: string | null
          created_at?: string
          field_away_score?: number | null
          field_home_score?: number | null
          field_outcome?: string | null
          fixture_id?: string
          game_number?: number
          home_team_id?: string
          id?: string
          kickoff_at?: string
          last_synced_at?: string | null
          leg_number?: number | null
          neutral_venue?: boolean
          pool_settlement_outcome?: string | null
          round_id?: string
          settlement_confirmed_at?: string | null
          settlement_rule?: string | null
          settlement_source?: string | null
          settlement_status?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "round_games_away_team_id_fkey"
            columns: ["away_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "round_games_competition_id_fkey"
            columns: ["competition_id"]
            isOneToOne: false
            referencedRelation: "competitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "round_games_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "round_games_home_team_id_fkey"
            columns: ["home_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "round_games_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      round_sync_control: {
        Row: {
          id: number
          last_detail: Json
          last_finished_at: string | null
          last_started_at: string | null
          last_status: string | null
          updated_at: string
        }
        Insert: {
          id?: number
          last_detail?: Json
          last_finished_at?: string | null
          last_started_at?: string | null
          last_status?: string | null
          updated_at?: string
        }
        Update: {
          id?: number
          last_detail?: Json
          last_finished_at?: string | null
          last_started_at?: string | null
          last_status?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      rounds: {
        Row: {
          created_at: string
          external_round_number: string
          id: string
          lock_at: string
          source: string
          source_version: string | null
          starts_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          external_round_number: string
          id?: string
          lock_at: string
          source: string
          source_version?: string | null
          starts_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          external_round_number?: string
          id?: string
          lock_at?: string
          source?: string
          source_version?: string | null
          starts_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      team_aliases: {
        Row: {
          alias: string
          created_at: string
          id: string
          is_preferred: boolean
          language_code: string | null
          normalized_alias: string | null
          source: string
          team_id: string
        }
        Insert: {
          alias: string
          created_at?: string
          id?: string
          is_preferred?: boolean
          language_code?: string | null
          normalized_alias?: string | null
          source?: string
          team_id: string
        }
        Update: {
          alias?: string
          created_at?: string
          id?: string
          is_preferred?: boolean
          language_code?: string | null
          normalized_alias?: string | null
          source?: string
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_aliases_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      team_coach_tenures: {
        Row: {
          assertion_status: string
          coach_id: string
          ends_on_earliest: string | null
          ends_on_latest: string | null
          first_seen_at: string
          id: string
          ingest_version: string
          provider: string | null
          provider_record_id: string | null
          raw_observation_id: string | null
          retrieved_at: string | null
          role: string
          source_fingerprint: string | null
          source_kind: string
          source_reference: string | null
          starts_on_earliest: string
          starts_on_latest: string
          team_id: string
          tenure_key: string
          tenure_version: number
        }
        Insert: {
          assertion_status?: string
          coach_id: string
          ends_on_earliest?: string | null
          ends_on_latest?: string | null
          first_seen_at?: string
          id?: string
          ingest_version: string
          provider?: string | null
          provider_record_id?: string | null
          raw_observation_id?: string | null
          retrieved_at?: string | null
          role?: string
          source_fingerprint?: string | null
          source_kind: string
          source_reference?: string | null
          starts_on_earliest: string
          starts_on_latest: string
          team_id: string
          tenure_key: string
          tenure_version: number
        }
        Update: {
          assertion_status?: string
          coach_id?: string
          ends_on_earliest?: string | null
          ends_on_latest?: string | null
          first_seen_at?: string
          id?: string
          ingest_version?: string
          provider?: string | null
          provider_record_id?: string | null
          raw_observation_id?: string | null
          retrieved_at?: string | null
          role?: string
          source_fingerprint?: string | null
          source_kind?: string
          source_reference?: string | null
          starts_on_earliest?: string
          starts_on_latest?: string
          team_id?: string
          tenure_key?: string
          tenure_version?: number
        }
        Relationships: [
          {
            foreignKeyName: "team_coach_tenures_coach_id_fkey"
            columns: ["coach_id"]
            isOneToOne: false
            referencedRelation: "coaches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_coach_tenures_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      team_player_memberships: {
        Row: {
          assertion_status: string
          contract_version: string
          document_version_id: string | null
          ends_on_earliest: string | null
          ends_on_latest: string | null
          first_seen_at: string
          id: string
          ingest_version: string
          membership_key: string
          membership_version: number
          player_id: string
          provider: string | null
          provider_record_id: string | null
          retrieved_at: string | null
          shirt_number: number | null
          source_fingerprint: string | null
          source_kind: string
          source_reference: string | null
          squad_group: string
          starts_on_earliest: string
          starts_on_latest: string
          team_id: string
        }
        Insert: {
          assertion_status?: string
          contract_version: string
          document_version_id?: string | null
          ends_on_earliest?: string | null
          ends_on_latest?: string | null
          first_seen_at?: string
          id?: string
          ingest_version: string
          membership_key: string
          membership_version: number
          player_id: string
          provider?: string | null
          provider_record_id?: string | null
          retrieved_at?: string | null
          shirt_number?: number | null
          source_fingerprint?: string | null
          source_kind: string
          source_reference?: string | null
          squad_group?: string
          starts_on_earliest: string
          starts_on_latest: string
          team_id: string
        }
        Update: {
          assertion_status?: string
          contract_version?: string
          document_version_id?: string | null
          ends_on_earliest?: string | null
          ends_on_latest?: string | null
          first_seen_at?: string
          id?: string
          ingest_version?: string
          membership_key?: string
          membership_version?: number
          player_id?: string
          provider?: string | null
          provider_record_id?: string | null
          retrieved_at?: string | null
          shirt_number?: number | null
          source_fingerprint?: string | null
          source_kind?: string
          source_reference?: string | null
          squad_group?: string
          starts_on_earliest?: string
          starts_on_latest?: string
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_player_memberships_document_version_id_fkey"
            columns: ["document_version_id"]
            isOneToOne: false
            referencedRelation: "knowledge_document_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_player_memberships_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_player_memberships_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          canonical_name: string
          country_code: string | null
          created_at: string
          id: string
        }
        Insert: {
          canonical_name: string
          country_code?: string | null
          created_at?: string
          id?: string
        }
        Update: {
          canonical_name?: string
          country_code?: string | null
          created_at?: string
          id?: string
        }
        Relationships: []
      }
      ticket_pick_results: {
        Row: {
          evaluated_at: string
          evaluated_outcome: string | null
          evaluation_state: string
          is_hit: boolean | null
          round_game_id: string
          ticket_version_id: string
        }
        Insert: {
          evaluated_at?: string
          evaluated_outcome?: string | null
          evaluation_state: string
          is_hit?: boolean | null
          round_game_id: string
          ticket_version_id: string
        }
        Update: {
          evaluated_at?: string
          evaluated_outcome?: string | null
          evaluation_state?: string
          is_hit?: boolean | null
          round_game_id?: string
          ticket_version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_pick_results_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_pick_results_ticket_version_id_fkey"
            columns: ["ticket_version_id"]
            isOneToOne: false
            referencedRelation: "ticket_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_version_picks: {
        Row: {
          pick: string
          round_game_id: string
          ticket_version_id: string
        }
        Insert: {
          pick: string
          round_game_id: string
          ticket_version_id: string
        }
        Update: {
          pick?: string
          round_game_id?: string
          ticket_version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_version_picks_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_version_picks_ticket_version_id_fkey"
            columns: ["ticket_version_id"]
            isOneToOne: false
            referencedRelation: "ticket_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_versions: {
        Row: {
          created_at: string
          id: string
          state_at_snapshot: string
          submitted_at: string
          user_ticket_id: string
          version_no: number
        }
        Insert: {
          created_at?: string
          id?: string
          state_at_snapshot: string
          submitted_at: string
          user_ticket_id: string
          version_no: number
        }
        Update: {
          created_at?: string
          id?: string
          state_at_snapshot?: string
          submitted_at?: string
          user_ticket_id?: string
          version_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "ticket_versions_user_ticket_id_fkey"
            columns: ["user_ticket_id"]
            isOneToOne: false
            referencedRelation: "user_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      user_ticket_picks: {
        Row: {
          pick: string
          round_game_id: string
          updated_at: string
          user_ticket_id: string
        }
        Insert: {
          pick: string
          round_game_id: string
          updated_at?: string
          user_ticket_id: string
        }
        Update: {
          pick?: string
          round_game_id?: string
          updated_at?: string
          user_ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_ticket_picks_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_ticket_picks_user_ticket_id_fkey"
            columns: ["user_ticket_id"]
            isOneToOne: false
            referencedRelation: "user_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      user_tickets: {
        Row: {
          created_at: string
          group_id: string
          id: string
          locked_at: string | null
          revision: number
          round_id: string
          state: string
          submitted_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          group_id: string
          id?: string
          locked_at?: string | null
          revision?: number
          round_id: string
          state?: string
          submitted_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          group_id?: string
          id?: string
          locked_at?: string | null
          revision?: number
          round_id?: string
          state?: string
          submitted_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_tickets_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_tickets_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      kapiloto_claim_research_attempt: {
        Args: { p_lease_seconds?: number; p_worker_id: string }
        Returns: Json
      }
      kapiloto_complete_research_run: {
        Args: { p_round_synthesis?: Json; p_run_id: string }
        Returns: Json
      }
      kapiloto_consume_auth_rate_limit: {
        Args: {
          p_bucket: string
          p_key_hash: string
          p_limit: number
          p_window_seconds: number
        }
        Returns: boolean
      }
      kapiloto_create_group: {
        Args: { p_name: string; p_user_id: string }
        Returns: Json
      }
      kapiloto_decide_group_join: {
        Args: {
          p_actor_user_id: string
          p_decision: string
          p_request_id: string
        }
        Returns: Json
      }
      kapiloto_ensure_group_round_settings: {
        Args: { p_group_id: string; p_round_id: string; p_user_id: string }
        Returns: Json
      }
      kapiloto_fail_exhausted_runs: {
        Args: { p_limit?: number }
        Returns: Json
      }
      kapiloto_finish_research_attempt: {
        Args: {
          p_attempt_id: string
          p_cached_input_tokens: number
          p_cost_micros: number
          p_failure_class: string
          p_failure_code: string
          p_failure_detail: string
          p_input_tokens: number
          p_model_ms: number
          p_model_snapshot: string
          p_output_tokens: number
          p_pricing_version: string
          p_provider_response_id: string
          p_reasoning_tokens: number
          p_retry_delay_seconds: number
          p_retryable: boolean
          p_sources_count: number
          p_success: boolean
          p_total_ms: number
          p_trace_id: string
          p_validated_output: Json
          p_validation_ms: number
          p_validation_report: Json
          p_web_search_calls: number
          p_worker_id: string
        }
        Returns: Json
      }
      kapiloto_heartbeat_research_attempt: {
        Args: {
          p_attempt_id: string
          p_lease_seconds?: number
          p_worker_id: string
        }
        Returns: boolean
      }
      kapiloto_materialize_and_complete_run: {
        Args: { p_analyses: Json; p_round_synthesis?: Json; p_run_id: string }
        Returns: Json
      }
      kapiloto_publish_fixture_analysis: {
        Args: { p_analysis_id: string }
        Returns: Json
      }
      kapiloto_recover_expired_attempts: {
        Args: { p_limit?: number; p_retry_delay_seconds?: number }
        Returns: Json
      }
      kapiloto_register_identity: {
        Args: {
          p_identifier_type: string
          p_preferred_auth_identifier: string
          p_user_id: string
          p_username: string
        }
        Returns: undefined
      }
      kapiloto_request_group_join: {
        Args: { p_join_code: string; p_user_id: string }
        Returns: Json
      }
      kapiloto_verify_scheduler_secret: {
        Args: { p_name: string; p_secret: string }
        Returns: boolean
      }
      kapiloto_request_research: {
        Args: {
          p_based_on_run_id: string
          p_blend_policy_version: string
          p_breaker_open: boolean
          p_calibration_version: string
          p_derivation_version: string
          p_execution_topology: string
          p_fixture_set: Json
          p_fixture_set_sha256: string
          p_idempotency_key: string
          p_input_snapshot: Json
          p_intent: string
          p_max_attempts_per_task?: number
          p_model_key: string
          p_prompt_template_sha256: string
          p_recency_policy_version: string
          p_reliability_formula_version: string
          p_request_sha256: string
          p_research_cutoff_at: string
          p_research_protocol_version: string
          p_round_game_id: string
          p_round_id: string
          p_source_policy_version: string
          p_task_game_ids: string[]
          p_user_id: string
        }
        Returns: Json
      }
      kapiloto_resolve_username: {
        Args: { p_normalized_username: string }
        Returns: {
          identifier_type: string
          preferred_auth_identifier: string
        }[]
      }
      toto_apply_game_state_v1: {
        Args: { p_update: Json }
        Returns: Json
      }
      toto_apply_round_state_v1: {
        Args: { p_updates: Json }
        Returns: Json
      }
      toto_import_round_snapshot: { Args: { p_snapshot: Json }; Returns: Json }
      toto_import_round_snapshot_v2: {
        Args: { p_snapshot: Json }
        Returns: Json
      }
      coach_alias_candidates: {
        Args: { p_alias: string }
        Returns: {
          canonical_coach_id: string
          coach_id: string
        }[]
      }
      knowledge_canonical_claims: {
        Args: { p_claim_ids: string[] }
        Returns: {
          canonical_claim_id: string
          claim_id: string
          collision: boolean
          member_claim_ids: string[]
        }[]
      }
      knowledge_claim_resolutions_as_of: {
        Args: { p_claim_ids: string[]; p_cutoff: string }
        Returns: {
          canonical_claim_id: string
          claim_id: string
          confidence: number | null
          first_seen_at: string | null
          member_claim_ids: string[]
          quality_flags: string[]
          reason_code: string | null
          resolution_claim_id: string | null
          resolution_id: string | null
          resolution_version: number | null
          resolver_kind: string | null
          status: string
        }[]
      }
      knowledge_claim_support_as_of: {
        Args: { p_claim_id: string; p_cutoff: string }
        Returns: {
          document_count: number
          independent_source_count: number
          observation_count: number
          relationship: string
        }[]
      }
      knowledge_document_version_as_of: {
        Args: { p_cutoff: string; p_document_id: string }
        Returns: string
      }
      knowledge_record_claim: { Args: { p_claim: Json }; Returns: Json }
      knowledge_record_claim_resolution: {
        Args: { p_resolution: Json }
        Returns: Json
      }
      knowledge_record_document_version: {
        Args: { p_document: Json }
        Returns: Json
      }
      match_ledger_mapping_conflicts: {
        Args: { p_provider: string }
        Returns: {
          conflict_kind: string
          fixture_id: string
          mapped_canonical_id: string | null
          observation_id: string
          provider_entity_id: string
          stored_canonical_id: string
        }[]
      }
      match_ledger_observation_as_of: {
        Args: { p_cutoff: string; p_fixture_id: string; p_provider: string }
        Returns: string
      }
      match_ledger_provider_player_matches_as_of: {
        Args: {
          p_cutoff: string
          p_limit?: number
          p_player_id: string
          p_provider: string
        }
        Returns: {
          appeared: boolean | null
          canonical_player_id: string
          data_completeness: string
          entered_minute: number | null
          exited_minute: number | null
          first_seen_at: string
          fixture_id: string
          formation_position: number | null
          is_captain: boolean | null
          kickoff_at: string
          lineup_role: string
          minutes_played: number | null
          observation_id: string
          observation_version: number
          observed_player_id: string
          position_code: string | null
          provider: string
          team_id: string
        }[]
      }
      match_ledger_provider_team_matches_as_of: {
        Args: {
          p_cutoff: string
          p_limit?: number
          p_provider: string
          p_team_id: string
        }
        Returns: {
          canonical_coach_id: string | null
          events_status: string
          first_seen_at: string
          fixture_id: string
          formation_nominal: string | null
          goals_against_90: number | null
          goals_for_90: number | null
          kickoff_at: string
          lineup_status: string
          neutral_venue: boolean | null
          observation_id: string
          observation_version: number
          observed_coach_id: string | null
          opponent_team_id: string
          provider: string
          side: string
          statistics_status: string
          substitutions_status: string
        }[]
      }
      match_ledger_record_observation: {
        Args: { p_observation: Json }
        Returns: Json
      }
      player_alias_candidates: {
        Args: { p_alias: string }
        Returns: {
          canonical_player_id: string
          player_id: string
        }[]
      }
      prediction_record_snapshot: {
        Args: { p_snapshot: Json }
        Returns: Json
      }
      resolve_provider_coach_ids: {
        Args: { p_provider: string; p_provider_coach_ids: string[] }
        Returns: {
          canonical_coach_id: string
          mapped_coach_id: string
          provider_coach_id: string
        }[]
      }
      resolve_provider_player_ids: {
        Args: { p_provider: string; p_provider_player_ids: string[] }
        Returns: {
          canonical_player_id: string
          mapped_player_id: string
          provider_player_id: string
        }[]
      }
      squad_state_inputs_as_of: {
        Args: {
          p_cutoff: string
          p_fixture_id: string
          p_history_fixture_limit?: number
          p_team_id: string
        }
        Returns: Json
      }
      team_coach_tenures_as_of: {
        Args: { p_cutoff: string; p_team_id: string }
        Returns: {
          assertion_status: string
          canonical_coach_id: string
          coach_id: string
          ends_on_earliest: string | null
          ends_on_latest: string | null
          first_seen_at: string
          id: string
          ingest_version: string
          provider: string | null
          provider_record_id: string | null
          raw_observation_id: string | null
          retrieved_at: string | null
          role: string
          source_fingerprint: string | null
          source_kind: string
          source_reference: string | null
          starts_on_earliest: string
          starts_on_latest: string
          team_id: string
          tenure_key: string
          tenure_version: number
        }[]
      }
      team_player_memberships_as_of: {
        Args: { p_cutoff: string; p_on_date: string; p_team_id: string }
        Returns: {
          canonical_player_id: string
          coverage: string
          document_version_id: string | null
          ends_on_earliest: string | null
          ends_on_latest: string | null
          first_seen_at: string
          membership_id: string
          membership_key: string
          membership_version: number
          observed_player_id: string
          provider: string | null
          provider_record_id: string | null
          shirt_number: number | null
          source_kind: string
          source_reference: string | null
          squad_group: string
          starts_on_earliest: string
          starts_on_latest: string
          team_id: string
        }[]
      }
      toto_save_ticket_draft: {
        Args: {
          p_expected_revision: number
          p_group_id: string
          p_picks: Json
          p_round_id: string
          p_user_id: string
        }
        Returns: Json
      }
      toto_submit_ticket: {
        Args: {
          p_expected_revision: number
          p_group_id: string
          p_round_id: string
          p_user_id: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
