import type { EntailmentJudge } from "../entailment-verifier";
import { verifyRequiredEntailment } from "../entailment-verifier";
import type { KapilotoFixtureCard } from "../fixture-card";
import {
  KAPILOTO_RESEARCH_DIMENSIONS,
  type SolFixtureResearchOutput,
} from "../research-output";
import {
  verifyGroundedResearchEvidence,
  type GroundingResult,
  type RetrievedSourceDocument,
  type SourceRegistryEntry,
} from "../source-grounding";

export const V3_CUTOFF = "2026-10-29T12:00:00.000Z";
export const V3_KICKOFF = "2026-10-30T18:00:00.000Z";

export const HOME_XI = [
  ["Gal Keeper", "GK"],
  ["Dan Back", "DF"],
  ["Eli Back", "DF"],
  ["Omer Back", "DF"],
  ["Noa Back", "DF"],
  ["Ron Mid", "MF"],
  ["Tal Mid", "MF"],
  ["Yoav Mid", "MF"],
  ["Ido Wing", "FW"],
  ["Ben Wing", "FW"],
  ["Avi Striker", "FW"],
] as const;

export function v3Card(
  overrides: Partial<KapilotoFixtureCard> = {},
  ids: { fixtureId?: string; roundGameId?: string; gameNumber?: number } = {},
): KapilotoFixtureCard {
  const fixtureId = ids.fixtureId ?? "fixture-v3";
  const team = (lastMatchAt: string) => ({
    form: {
      played: 6,
      points: 12,
      gf: 10,
      ga: 6,
      venue_played: 6,
      venue_points: 9,
      venue_gf: 6,
      venue_ga: 3,
      last_match_at: lastMatchAt,
    },
    rest: { rest_days: 4, matches_last_14d: 2 },
    table: {
      position: 3,
      points: 20,
      played: 10,
      goal_difference: 5,
      points_deducted: null,
    },
    coverage: {
      form: "available" as const,
      rest: "available" as const,
      table: "available" as const,
    },
  });
  return {
    fixture_card_version: "kapiloto-fixture-card-v3",
    fixture_key: fixtureId,
    fixture_id: fixtureId,
    round_game_id: ids.roundGameId ?? "game-v3",
    toto_number: ids.gameNumber ?? 1,
    settlement: "result_after_90_minutes_including_stoppage_time",
    orientation: { "1": "home", "2": "away" },
    teams: {
      home: { id: "home", names: ["Home FC"] },
      away: { id: "away", names: ["Away FC"] },
    },
    competition: {
      id: "league",
      name: "League",
      stage: null,
      leg: null,
      aggregate: null,
    },
    kickoff_at: V3_KICKOFF,
    neutral_venue: false,
    research_cutoff_at: V3_CUTOFF,
    lineup_research: "enabled",
    structured: {
      table_snapshot_id: null,
      recent_matches: [],
      squad_snapshot_id: null,
      coach: null,
      structured_snapshot: {
        id: "snapshot-v3",
        feature_version: "kapiloto-features-v1",
        sha256: "a".repeat(64),
        computed_at: "2026-10-29T11:00:00.000Z",
        cutoff_at: V3_CUTOFF,
        features: {
          feature_version: "kapiloto-features-v1",
          home: team("2026-10-25T18:00:00.000Z"),
          away: team("2026-10-26T18:00:00.000Z"),
          sources: [],
        },
      },
      prior: {
        type: "market",
        snapshot_id: "market-v3",
        captured_at: "2026-10-29T11:00:00.000Z",
        p_home_bp: 4200,
        p_draw_bp: 2900,
        p_away_bp: 2900,
      },
    },
    ...overrides,
  };
}

type EvidenceSpec = {
  id: string;
  url: string;
  quote: string;
  claimType: string;
  aboutTeam: "home" | "away" | "both" | "none";
  publishedAt: string | null;
};

export const V3_EVIDENCE: EvidenceSpec[] = [
  {
    id: "lh1",
    url: "https://club-home.example/expected-xi",
    quote: `Expected XI (4-3-3): ${HOME_XI.map(([name]) => name).join(", ")}.`,
    claimType: "lineup",
    aboutTeam: "home",
    publishedAt: "2026-10-28T09:00:00.000Z",
  },
  {
    id: "av1",
    url: "https://news.example/away-injury",
    quote: "Away FC captain Zed Anchor is ruled out of the match with a hamstring injury.",
    claimType: "availability",
    aboutTeam: "away",
    publishedAt: "2026-10-28T08:00:00.000Z",
  },
  {
    id: "role1",
    url: "https://analysis.example/away-profile",
    quote: "Zed Anchor is Away FC's defensive anchor, shielding the back four.",
    claimType: "tactical_setup",
    aboutTeam: "away",
    publishedAt: "2026-10-20T08:00:00.000Z",
  },
  {
    id: "tac1",
    url: "https://analysis.example/home-press",
    quote: "Home FC press high from the front under their coach.",
    claimType: "tactical_setup",
    aboutTeam: "home",
    publishedAt: "2026-10-22T08:00:00.000Z",
  },
  {
    id: "tac2",
    url: "https://analysis.example/away-buildup",
    quote: "Away FC insist on a short build-up from the back.",
    claimType: "tactical_setup",
    aboutTeam: "away",
    publishedAt: "2026-10-22T08:00:00.000Z",
  },
  {
    id: "mx1",
    url: "https://news.example/preview",
    quote: "Home FC's high press should trouble Away FC's short build-up on Thursday.",
    claimType: "tactical_setup",
    aboutTeam: "both",
    publishedAt: "2026-10-28T10:00:00.000Z",
  },
];

export function evidenceRow(spec: EvidenceSpec) {
  return {
    evidence_id: spec.id,
    url: spec.url,
    quote: spec.quote,
    claim: spec.quote.slice(0, 150),
    claim_type: spec.claimType,
    about_team: spec.aboutTeam,
    event_time: null,
  };
}

/** A complete, valid v3 output that passes grounding with a supportive judge. */
export function v3Output(): SolFixtureResearchOutput {
  return {
    protocol_version: "kapiloto-research-v3",
    fixture_key: "fixture-v3",
    home_team_id: "home",
    away_team_id: "away",
    outcome: "analyzed",
    evidence: V3_EVIDENCE.map(evidenceRow),
    availability: [
      {
        team: "away",
        player_name: "Zed Anchor",
        status: "out",
        role: "key_starter",
        certainty: "confirmed",
        evidence_ids: ["av1"],
        functions: ["defensive_anchor"],
        function_evidence_ids: ["role1"],
      },
    ],
    expected_lineups: {
      home: {
        status: "supported",
        formation: "4-3-3",
        formation_evidence_ids: ["lh1"],
        starters: HOME_XI.map(([name, position]) => ({
          player_name: name,
          position,
          confidence: "medium" as const,
          evidence_ids: ["lh1"],
        })),
      },
      away: {
        status: "insufficient_data",
        formation: null,
        formation_evidence_ids: [],
        starters: [],
      },
    },
    tactical_facts: [
      {
        fact_id: "t1",
        team: "home",
        phase: "defending",
        attribute: "press_height",
        value: "high",
        evidence_ids: ["tac1"],
      },
      {
        fact_id: "t2",
        team: "away",
        phase: "possession",
        attribute: "build_up",
        value: "short",
        evidence_ids: ["tac2"],
      },
    ],
    matchup_analysis: [
      {
        matchup_id: "m1",
        kind: "press_vs_buildup",
        fact_ids: ["t1", "t2"],
        favors: "home",
        magnitude: "small",
        description: "Home FC's high press can disrupt Away FC's short build-up.",
        evidence_ids: ["mx1"],
      },
    ],
    regime_changes: [],
    factors: [
      {
        dimension: "tactical_matchup",
        favors: "home",
        magnitude: "small",
        evidence_ids: ["mx1"],
        structured_refs: [],
        matchup_ids: ["m1"],
        rationale: "The press-versus-build-up interaction slightly favors Home FC.",
      },
      {
        dimension: "availability",
        favors: "home",
        magnitude: "medium",
        evidence_ids: ["av1"],
        structured_refs: [],
        matchup_ids: [],
        rationale: "Away FC lose their defensive anchor.",
      },
    ],
    dimension_coverage: KAPILOTO_RESEARCH_DIMENSIONS.map((dimension) => ({
      dimension,
      status:
        dimension === "tactical_matchup" || dimension === "availability"
          ? ("material_signal" as const)
          : ("no_material_signal" as const),
    })),
    conflicts: [],
    p_sol: { home_bp: 4600, draw_bp: 2800, away_bp: 2600 },
    market_deviation: null,
    key_assumptions: ["Zed Anchor stays out."],
    main_risk: "Model prose that must not survive pruning.",
    summary: "Model summary that mentions the predicted XI.",
    watch_items: [],
    data_quality: { sparse_coverage: false, language_limited: false, notes: "ok" },
    suspicious_content_observed: [],
    model_self_confidence: "medium",
  };
}

export function v3Documents(
  specs: EvidenceSpec[] = V3_EVIDENCE,
  overrides: Record<string, Partial<RetrievedSourceDocument>> = {},
): RetrievedSourceDocument[] {
  const byUrl = new Map<string, EvidenceSpec[]>();
  for (const spec of specs) {
    byUrl.set(spec.url, [...(byUrl.get(spec.url) ?? []), spec]);
  }
  return [...byUrl.entries()].map(([url, rows]) => ({
    requestedUrl: url,
    finalUrl: url,
    retrievedAt: "2026-10-29T11:30:00.000Z",
    publishedAt: rows[0].publishedAt,
    text: `Article. ${rows.map((row) => row.quote).join(" ")} End.`,
    contentSha256: `sha-${url}`,
    ...(overrides[url] ?? {}),
  }));
}

export function v3Registry(): SourceRegistryEntry[] {
  return [
    {
      domain: "club-home.example",
      denied: false,
      tierByClaimType: { availability: 1, default: 2 },
    },
    {
      domain: "news.example",
      denied: false,
      tierByClaimType: { availability: 2, tactical: 2, default: 3 },
    },
    {
      domain: "analysis.example",
      denied: false,
      tierByClaimType: { tactical: 2, default: 3 },
    },
  ];
}

export function groundV3(
  output: SolFixtureResearchOutput = v3Output(),
  card: KapilotoFixtureCard = v3Card(),
  documents: RetrievedSourceDocument[] = v3Documents(),
  registry: SourceRegistryEntry[] = v3Registry(),
): GroundingResult {
  return verifyGroundedResearchEvidence(output, card, documents, registry, null);
}

/** Deterministic judge: `unsupported` when the claim matches any pattern. */
export function patternJudge(
  unsupported: RegExp[] = [],
  seen: Array<{ claim: string; quote: string; quotes?: string[] }> = [],
): EntailmentJudge {
  return {
    async verify(items) {
      seen.push(...items.map((item) => ({ claim: item.claim, quote: item.quote, quotes: item.quotes })));
      return {
        verdicts: items.map((item) => ({
          verificationId: item.verificationId,
          verdict: unsupported.some((pattern) => pattern.test(item.claim))
            ? ("unsupported" as const)
            : ("supported" as const),
        })),
        provenance: { responseId: "judge-1", model: "judge", usage: null },
      };
    },
  };
}

export async function groundAndJudge(
  output: SolFixtureResearchOutput = v3Output(),
  card: KapilotoFixtureCard = v3Card(),
  unsupported: RegExp[] = [],
  documents?: RetrievedSourceDocument[],
): Promise<GroundingResult> {
  const grounding = groundV3(output, card, documents);
  const judged = await verifyRequiredEntailment(
    [{ fixtureId: card.fixture_id, grounding }],
    patternJudge(unsupported),
  );
  return judged.fixtures[0].grounding;
}
