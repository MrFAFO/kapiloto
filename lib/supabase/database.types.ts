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
      fixture_market_snapshots: {
        Row: {
          captured_at: string
          created_at: string
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
          round_game_id: string
          source_version: string | null
        }
        Insert: {
          captured_at: string
          created_at?: string
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
          round_game_id: string
          source_version?: string | null
        }
        Update: {
          captured_at?: string
          created_at?: string
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
          round_game_id?: string
          source_version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fixture_market_snapshots_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
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
          blend_weight: number | null
          carried_from_analysis_id: string | null
          conflicts: Json
          data_quality: Json
          deviation_cap_applied: boolean
          dimension_coverage: Json
          double_gain_score: number | null
          double_priority_rank: number | null
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
          blend_weight?: number | null
          carried_from_analysis_id?: string | null
          conflicts?: Json
          data_quality?: Json
          deviation_cap_applied?: boolean
          dimension_coverage?: Json
          double_gain_score?: number | null
          double_priority_rank?: number | null
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
          blend_weight?: number | null
          carried_from_analysis_id?: string | null
          conflicts?: Json
          data_quality?: Json
          deviation_cap_applied?: boolean
          dimension_coverage?: Json
          double_gain_score?: number | null
          double_priority_rank?: number | null
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
        }
        Insert: {
          analysis_id: string
          dimension: string
          favors: string
          id?: string
          magnitude: string
          rationale: string
        }
        Update: {
          analysis_id?: string
          dimension?: string
          favors?: string
          id?: string
          magnitude?: string
          rationale?: string
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
      kapiloto_freshness_signals: {
        Row: {
          data_version: string | null
          id: number
          observed_at: string
          payload: Json
          round_game_id: string
          severity: number
          signal_type: string
          subject_player: string | null
          subject_team_id: string | null
        }
        Insert: {
          data_version?: string | null
          id?: never
          observed_at: string
          payload?: Json
          round_game_id: string
          severity: number
          signal_type: string
          subject_player?: string | null
          subject_team_id?: string | null
        }
        Update: {
          data_version?: string | null
          id?: never
          observed_at?: string
          payload?: Json
          round_game_id?: string
          severity?: number
          signal_type?: string
          subject_player?: string | null
          subject_team_id?: string | null
        }
        Relationships: [
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
          mapped_at: string
          mapped_by: string | null
          mapping_confidence: number | null
          mapping_status: string
          provider: string
          provider_fixture_id: string
          round_game_id: string
        }
        Insert: {
          mapped_at?: string
          mapped_by?: string | null
          mapping_confidence?: number | null
          mapping_status?: string
          provider: string
          provider_fixture_id: string
          round_game_id: string
        }
        Update: {
          mapped_at?: string
          mapped_by?: string | null
          mapping_confidence?: number | null
          mapping_status?: string
          provider?: string
          provider_fixture_id?: string
          round_game_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_fixture_mappings_round_game_id_fkey"
            columns: ["round_game_id"]
            isOneToOne: false
            referencedRelation: "round_games"
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
      kapiloto_consume_auth_rate_limit: {
        Args: {
          p_bucket: string
          p_key_hash: string
          p_limit: number
          p_window_seconds: number
        }
        Returns: boolean
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
