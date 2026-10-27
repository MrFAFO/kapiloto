/**
 * Deterministic research-v2 materialization input. The golden output in
 * `golden/v2-materialization.json` was produced by running this exact input
 * through main (2b38604) code, so v1/v2 replays can be checked for equality.
 * Keep this module dependency-free (types only) so it runs on old code too.
 */
import type { KapilotoFixtureCard } from "../fixture-card";
import type { MaterializableFixture } from "../run-materialization";

const CUTOFF = "2026-10-20T10:00:00.000Z";

function card(game: number): KapilotoFixtureCard {
  return {
    fixture_card_version: "kapiloto-fixture-card-v2",
    fixture_key: `fixture-${game}`,
    fixture_id: `fixture-${game}`,
    round_game_id: `game-${game}`,
    toto_number: game,
    settlement: "result_after_90_minutes_including_stoppage_time",
    orientation: { "1": `home-${game}`, "2": `away-${game}` },
    teams: {
      home: { id: `home-${game}`, names: ["Home"] },
      away: { id: `away-${game}`, names: ["Away"] },
    },
    competition: { id: "league", name: "League", stage: null, leg: null, aggregate: null },
    kickoff_at: "2026-10-21T18:00:00.000Z",
    neutral_venue: false,
    research_cutoff_at: CUTOFF,
    structured: {
      table_snapshot_id: null,
      recent_matches: [],
      squad_snapshot_id: null,
      coach: null,
      prior: {
        type: "market",
        snapshot_id: `market-${game}`,
        captured_at: "2026-10-20T09:55:00.000Z",
        p_home_bp: 4500,
        p_draw_bp: 3000,
        p_away_bp: 2500,
      },
    },
  };
}

function evidence(id: string, tier: number, claimType: string, entailment: "supported" | "not_checked") {
  return {
    modelEvidenceId: id,
    canonicalUrl: `https://example.com/${id}`,
    domain: "example.com",
    claimType,
    aboutTeam: "home" as const,
    quote: `Quote ${id}.`,
    claim: `Claim ${id}.`,
    sourceEventTime: null,
    publishedAt: "2026-10-19T10:00:00.000Z",
    retrievedAt: "2026-10-20T09:00:00.000Z",
    trustTier: tier,
    quoteVerified: true as const,
    entailment,
    syndicationClusterId: null,
    contentSha256: `sha-${id}`,
  };
}

export function v2GoldenFixtures(): MaterializableFixture[] {
  const research: MaterializableFixture = {
    mode: "research",
    gameNumber: 1,
    roundGameId: "game-1",
    fixtureId: "fixture-1",
    card: card(1),
    output: {
      protocol_version: "kapiloto-research-v2",
      fixture_key: "fixture-1",
      home_team_id: "home-1",
      away_team_id: "away-1",
      outcome: "analyzed",
      evidence: ["e1", "e2", "e3"].map((id) => ({
        evidence_id: id,
        url: `https://example.com/${id}`,
        quote: `Quote ${id}.`,
        claim: `Claim ${id}.`,
        claim_type: "availability",
        about_team: "home" as const,
        event_time: null,
      })),
      availability: [
        {
          team: "away",
          player_name: "Player B",
          status: "out",
          role: "regular",
          certainty: "confirmed",
          evidence_ids: ["e2"],
        },
      ],
      factors: [
        {
          dimension: "availability",
          favors: "home",
          magnitude: "small",
          evidence_ids: ["e1"],
          structured_refs: [],
          rationale: "Away are missing a regular.",
        },
      ],
      dimension_coverage: [
        "baseline_form",
        "home_away_draw",
        "availability",
        "load_schedule",
        "tactical_matchup",
        "competition_context",
        "club_coach_news",
        "independent_model",
        "conditions",
        "head_to_head",
      ].map((dimension) => ({
        dimension: dimension as never,
        status: dimension === "availability" ? "material_signal" : "no_material_signal",
      })) as never,
      conflicts: [],
      p_sol: { home_bp: 4800, draw_bp: 2800, away_bp: 2400 },
      market_deviation: null,
      key_assumptions: ["Player B stays out."],
      main_risk: "Late team news.",
      summary: "A small home edge.",
      watch_items: [],
      data_quality: { sparse_coverage: false, language_limited: false, notes: "ok" },
      suspicious_content_observed: [],
      model_self_confidence: "medium",
    },
    grounding: {
      accepted: [
        evidence("e1", 3, "availability", "supported"),
        evidence("e2", 1, "availability", "not_checked"),
      ],
      rejected: [{ evidenceId: "e3", reason: "quote_not_found" }],
      requiresEntailmentVerification: [],
    },
  };

  const unavailable: MaterializableFixture[] = Array.from({ length: 15 }, (_, index) => {
    const game = index + 2;
    return {
      mode: "research_unavailable",
      gameNumber: game,
      roundGameId: `game-${game}`,
      fixtureId: `fixture-${game}`,
      reason: "missing_prior",
      context: {
        kickoffAt: "2026-10-21T18:00:00.000Z",
        settlementRule: "result_after_90_minutes_including_stoppage_time",
        neutralVenue: false,
      },
      researchCutoffAt: CUTOFF,
    };
  });

  return [research, ...unavailable];
}
