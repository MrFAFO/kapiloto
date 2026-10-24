import type { MarketQuoteRecord } from "@/lib/evaluation/market-prior";
import { syntheticLeague } from "@/lib/evaluation/test-fixtures";

import { CANDIDATE_ADJUSTMENT_POLICY, CANDIDATE_EFFECT_SIZES, type ImpactProposal } from "./adjustments";
import { CANDIDATE_DETERMINISTIC_BASE_CONFIG, type DeterministicBaseInputs } from "./base";
import { CANDIDATE_COMBINATIONS } from "./combination";
import type { DiscoveryEvidenceItem } from "./evidence";
import type { ResearchV2Configs } from "./forecast";
import { CANDIDATE_SOURCE_POLICY, type SourceRegistryV2Entry } from "./sources";
import { CANDIDATE_VERIFICATION_CONFIG, verifyEvidence, type EntailmentVerdict, type RetrievedPage } from "./verification";

export const HISTORY = syntheticLeague({ teams: 10, seasons: 2 });
const lastKickoffMs = Math.max(...HISTORY.map((match) => Date.parse(match.kickoffAt)));
export const KICKOFF_AT = new Date(lastKickoffMs + 7 * 86_400_000).toISOString();
export const CUTOFF_AT = new Date(Date.parse(KICKOFF_AT) - 24 * 3_600_000).toISOString();
export const hoursBeforeCutoff = (hours: number) => new Date(Date.parse(CUTOFF_AT) - hours * 3_600_000).toISOString();

export function quotes(
  options: { capturedAt?: string; bookmakers?: number; odds?: { home: number; draw: number; away: number } } = {},
): MarketQuoteRecord[] {
  const odds = options.odds ?? { home: 1.95, draw: 3.6, away: 4.2 };
  return Array.from({ length: options.bookmakers ?? 4 }, (_, index) => ({
    id: `q${index}`,
    fixtureId: "fixture-1",
    provider: "api-football",
    bookmakerId: `b${index}`,
    bookmakerName: `Book ${index}`,
    capturedAt: options.capturedAt ?? hoursBeforeCutoff(2),
    sourceUpdatedAt: null,
    odds: { home: odds.home + index * 0.01, draw: odds.draw, away: odds.away - index * 0.01 },
  }));
}

export function baseInputs(overrides: Partial<DeterministicBaseInputs> = {}): DeterministicBaseInputs {
  return {
    fixture: {
      fixtureId: "fixture-1",
      roundGameId: "rg-1",
      gameNumber: 3,
      homeTeamId: "team-home",
      awayTeamId: "team-away",
      kickoffAt: KICKOFF_AT,
      neutralVenue: false,
      competitionKey: "sportmonks:8",
      homeTeamKey: "sportmonks:t0",
      awayTeamKey: "sportmonks:t5",
    },
    informationCutoffAt: CUTOFF_AT,
    history: HISTORY,
    marketSnapshotId: "snapshot-1",
    marketQuotes: quotes(),
    structuredAvailability: [],
    ...overrides,
  };
}

export const CONFIGS: ResearchV2Configs = {
  base: CANDIDATE_DETERMINISTIC_BASE_CONFIG,
  combinations: CANDIDATE_COMBINATIONS,
  sourcePolicy: CANDIDATE_SOURCE_POLICY,
  adjustmentPolicy: CANDIDATE_ADJUSTMENT_POLICY,
  effects: CANDIDATE_EFFECT_SIZES,
};

export const REGISTRY: SourceRegistryV2Entry[] = [
  { domain: "homefc.example", organization: "Home FC", defaultType: "official_club" },
  { domain: "localecho.example", organization: "Local Echo", defaultType: "accredited_reporter" },
  { domain: "bignews.example", organization: "Big News", defaultType: "major_outlet", accreditedReporters: ["Jane Writer"] },
  { domain: "othernews.example", organization: "Other News", defaultType: "major_outlet" },
  { domain: "aggregator.example", organization: "Aggregator", defaultType: "aggregator" },
  { domain: "blocked.example", organization: "Blocked", defaultType: "aggregator", denied: true },
];

export function item(overrides: Partial<DiscoveryEvidenceItem> = {}): DiscoveryEvidenceItem {
  return {
    evidence_id: "E1",
    need_id: "availability_rotation_check:home",
    claim_kind: "absence",
    claim: "Home goalkeeper Smith is ruled out with a knee injury.",
    quote: "Smith will miss the match with a knee injury, the manager confirmed.",
    url: "https://homefc.example/news/smith",
    published_at: null,
    author: null,
    is_direct_quote: false,
    team: "home",
    player_name: "Smith",
    player_role: "goalkeeper",
    squad_status: "first_choice",
    expected_return: null,
    factual_confidence: "confirmed",
    expected_direction: "weakens_team",
    tentative_impact_class: "moderate",
    claimed_structured_duplicate: false,
    ...overrides,
  };
}

export function page(evidence: DiscoveryEvidenceItem, publishedAt: string | null, text?: string): RetrievedPage {
  return {
    requestedUrl: evidence.url,
    finalUrl: evidence.url,
    text: text ?? `Team news. ${evidence.quote} More text.`,
    publishedAt,
    retrievedAt: CUTOFF_AT,
    contentSha256: "0".repeat(64),
  };
}

export function verified(
  items: DiscoveryEvidenceItem[],
  options: {
    publishedAt?: string | null;
    entailment?: EntailmentVerdict;
    structuredAvailability?: DeterministicBaseInputs["structuredAvailability"];
    pages?: RetrievedPage[];
  } = {},
) {
  const publishedAt = options.publishedAt === undefined ? hoursBeforeCutoff(1) : options.publishedAt;
  return verifyEvidence({
    items,
    pages: options.pages ?? items.map((evidence) => page(evidence, publishedAt)),
    observedSearchUrls: items.map((evidence) => evidence.url),
    entailment: Object.fromEntries(items.map((evidence) => [evidence.evidence_id, options.entailment ?? "supported"])),
    informationCutoffAt: CUTOFF_AT,
    structuredAvailability: options.structuredAvailability ?? [],
    registry: REGISTRY,
    sourcePolicy: CANDIDATE_SOURCE_POLICY,
    config: CANDIDATE_VERIFICATION_CONFIG,
  });
}

export function proposal(overrides: Partial<ImpactProposal> = {}): ImpactProposal {
  return {
    proposal_id: "A1",
    kind: "availability",
    team: "home",
    effect: "weakens",
    impact_class: "moderate",
    uncertainty: "low",
    evidence_ids: ["E1"],
    rationale: "First-choice goalkeeper ruled out.",
    ...overrides,
  };
}
