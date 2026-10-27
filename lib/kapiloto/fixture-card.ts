import type { FixtureStructuredFeaturesV1 } from "@/lib/football-features/v1";
import type { ProviderAnalyticsTeamMetrics } from "./provider-analytics";

export const KAPILOTO_FIXTURE_CARD_V2_VERSION =
  "kapiloto-fixture-card-v2" as const;
export const KAPILOTO_FIXTURE_CARD_VERSION =
  "kapiloto-fixture-card-v3" as const;
export const KAPILOTO_SETTLEMENT_90M =
  "result_after_90_minutes_including_stoppage_time" as const;
export const DEFAULT_RESEARCH_SAFETY_WINDOW_MINUTES = 15;

export type BasisPointTriple = {
  home: number;
  draw: number;
  away: number;
};

export type FixturePriorInput = {
  type: "market" | "rating" | "league_base";
  snapshotId: string | null;
  capturedAt: string | null;
  probabilitiesBp: BasisPointTriple;
};

export type FixtureCardTeamInput = {
  id: string;
  canonicalName: string;
  aliases?: string[];
};

export type FixtureCardInput = {
  fixtureId: string;
  roundId: string;
  roundGameId: string;
  gameNumber: number;
  home: FixtureCardTeamInput;
  away: FixtureCardTeamInput;
  competition: {
    id: string | null;
    name: string;
    stage: string | null;
    leg: number | null;
    aggregateHome: number | null;
    aggregateAway: number | null;
  };
  kickoffAt: string;
  neutralVenue: boolean;
  settlementRule?: string | null;
  tableSnapshotId?: string | null;
  recentMatches?: Record<string, unknown>[];
  squadSnapshotId?: string | null;
  coach?: string | null;
  structuredSnapshot?: {
    id: string;
    featureVersion: string;
    sha256: string;
    computedAt: string;
    cutoffAt: string;
    features: FixtureStructuredFeaturesV1;
  } | null;
  providerAnalytics?: {
    provider: "football-il-parse";
    sourceVersion: string;
    capturedAt: string;
    season: string | null;
    home: ProviderAnalyticsTeamMetrics;
    away: ProviderAnalyticsTeamMetrics;
  } | null;
  prior: FixturePriorInput | null;
};

export type KapilotoFixtureCard = {
  fixture_card_version:
    | typeof KAPILOTO_FIXTURE_CARD_V2_VERSION
    | typeof KAPILOTO_FIXTURE_CARD_VERSION;
  fixture_key: string;
  fixture_id: string;
  round_game_id: string;
  toto_number: number;
  settlement: typeof KAPILOTO_SETTLEMENT_90M;
  orientation: {
    "1": string;
    "2": string;
  };
  teams: {
    home: { id: string; names: string[] };
    away: { id: string; names: string[] };
  };
  competition: {
    id: string | null;
    name: string;
    stage: string | null;
    leg: number | null;
    aggregate: { home: number; away: number } | null;
  };
  kickoff_at: string;
  neutral_venue: boolean;
  research_cutoff_at: string;
  structured: {
    table_snapshot_id: string | null;
    recent_matches: Record<string, unknown>[];
    squad_snapshot_id: string | null;
    coach: string | null;
    structured_snapshot?: {
      id: string;
      feature_version: string;
      sha256: string;
      computed_at: string;
      cutoff_at: string;
      features: FixtureStructuredFeaturesV1;
    };
    provider_analytics?: {
      provider: "football-il-parse";
      source_version: string;
      captured_at: string;
      season: string | null;
      home: ProviderAnalyticsTeamMetrics;
      away: ProviderAnalyticsTeamMetrics;
    };
    prior: {
      type: FixturePriorInput["type"];
      snapshot_id: string | null;
      captured_at: string | null;
      p_home_bp: number;
      p_draw_bp: number;
      p_away_bp: number;
    };
  };
};

export type FixtureResearchEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | "kickoff_too_close"
        | "already_started"
        | "missing_prior"
        | "post_cutoff_prior"
        | "invalid_fixture";
    };

function parseTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return parsed;
}

function assertBasisPoints(probabilities: BasisPointTriple): void {
  const values = [
    ["home", probabilities.home],
    ["draw", probabilities.draw],
    ["away", probabilities.away],
  ] as const;

  for (const [name, value] of values) {
    if (!Number.isInteger(value) || value < 0 || value > 10_000) {
      throw new Error(`Invalid ${name} prior basis points: ${value}`);
    }
  }

  if (probabilities.home + probabilities.draw + probabilities.away !== 10_000) {
    throw new Error("Prior basis points must sum to exactly 10000.");
  }
}

function assertFixtureIdentity(input: FixtureCardInput): void {
  if (!input.fixtureId) {
    throw new Error("Canonical fixture id is required.");
  }
  if (!input.roundId || !input.roundGameId) {
    throw new Error("Round and round-game ids are required for Toto context.");
  }
  if (!Number.isInteger(input.gameNumber) || input.gameNumber < 1 || input.gameNumber > 16) {
    throw new Error(`Invalid Toto game number: ${input.gameNumber}`);
  }
  if (!input.home.id || !input.away.id || input.home.id === input.away.id) {
    throw new Error("Fixture requires two distinct team ids.");
  }
  if (!input.home.canonicalName.trim() || !input.away.canonicalName.trim()) {
    throw new Error("Fixture team names are required.");
  }
  if (!input.competition.name.trim()) {
    throw new Error("Competition name is required.");
  }

  const { leg, aggregateHome, aggregateAway } = input.competition;
  if (leg != null && (!Number.isInteger(leg) || leg < 1 || leg > 2)) {
    throw new Error(`Unsupported competition leg: ${leg}`);
  }
  const hasAggregateHome = aggregateHome != null;
  const hasAggregateAway = aggregateAway != null;
  if (hasAggregateHome !== hasAggregateAway) {
    throw new Error("Aggregate score must contain both home and away values.");
  }
  for (const [name, value] of [
    ["aggregateHome", aggregateHome],
    ["aggregateAway", aggregateAway],
  ] as const) {
    if (value != null && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`Invalid ${name}: ${value}`);
    }
  }

  if (
    input.settlementRule != null &&
    input.settlementRule !== KAPILOTO_SETTLEMENT_90M
  ) {
    throw new Error(
      `Unsupported Kapiloto settlement rule: ${input.settlementRule}`,
    );
  }
}

function dedupeNames(primary: string, aliases: string[] = []): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of [primary, ...aliases]) {
    const trimmed = value.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed);
    if (output.length === 8) break;
  }

  return output;
}

export function assessFixtureResearchEligibility(
  input: FixtureCardInput,
  researchCutoffAt: string,
  safetyWindowMinutes = DEFAULT_RESEARCH_SAFETY_WINDOW_MINUTES,
): FixtureResearchEligibility {
  try {
    assertFixtureIdentity(input);

    const kickoffMs = parseTimestamp(input.kickoffAt, "kickoffAt");
    const cutoffMs = parseTimestamp(researchCutoffAt, "researchCutoffAt");
    const safetyMs = safetyWindowMinutes * 60_000;

    if (cutoffMs >= kickoffMs) {
      return { eligible: false, reason: "already_started" };
    }
    if (kickoffMs - cutoffMs <= safetyMs) {
      return { eligible: false, reason: "kickoff_too_close" };
    }

    if (input.prior == null) {
      return { eligible: false, reason: "missing_prior" };
    }

    assertBasisPoints(input.prior.probabilitiesBp);

    if (input.prior.capturedAt != null) {
      const priorMs = parseTimestamp(input.prior.capturedAt, "prior.capturedAt");
      if (priorMs > cutoffMs) {
        return { eligible: false, reason: "post_cutoff_prior" };
      }
    }

    return { eligible: true };
  } catch {
    return { eligible: false, reason: "invalid_fixture" };
  }
}

export function buildKapilotoFixtureCard(
  input: FixtureCardInput,
  researchCutoffAt: string,
  safetyWindowMinutes = DEFAULT_RESEARCH_SAFETY_WINDOW_MINUTES,
): KapilotoFixtureCard {
  assertFixtureIdentity(input);

  if (input.prior == null) {
    throw new Error(
      `Fixture ${input.gameNumber} is not eligible for fresh research: missing_prior`,
    );
  }

  // The builder is a developer-facing invariant boundary, so malformed
  // probabilities fail with a precise diagnostic instead of the policy-level
  // generic invalid_fixture reason.
  assertBasisPoints(input.prior.probabilitiesBp);

  const eligibility = assessFixtureResearchEligibility(
    input,
    researchCutoffAt,
    safetyWindowMinutes,
  );
  if (!eligibility.eligible) {
    throw new Error(
      `Fixture ${input.gameNumber} is not eligible for fresh research: ${eligibility.reason}`,
    );
  }

  const aggregate =
    input.competition.aggregateHome != null &&
    input.competition.aggregateAway != null
      ? {
          home: input.competition.aggregateHome,
          away: input.competition.aggregateAway,
        }
      : null;

  return {
    fixture_card_version:
      input.structuredSnapshot == null
        ? KAPILOTO_FIXTURE_CARD_V2_VERSION
        : KAPILOTO_FIXTURE_CARD_VERSION,
    fixture_key: input.fixtureId,
    fixture_id: input.fixtureId,
    round_game_id: input.roundGameId,
    toto_number: input.gameNumber,
    settlement: KAPILOTO_SETTLEMENT_90M,
    orientation: {
      "1": input.home.id,
      "2": input.away.id,
    },
    teams: {
      home: {
        id: input.home.id,
        names: dedupeNames(input.home.canonicalName, input.home.aliases),
      },
      away: {
        id: input.away.id,
        names: dedupeNames(input.away.canonicalName, input.away.aliases),
      },
    },
    competition: {
      id: input.competition.id,
      name: input.competition.name.trim(),
      stage: input.competition.stage,
      leg: input.competition.leg,
      aggregate,
    },
    kickoff_at: new Date(input.kickoffAt).toISOString(),
    neutral_venue: input.neutralVenue,
    research_cutoff_at: new Date(researchCutoffAt).toISOString(),
    structured: {
      table_snapshot_id: input.tableSnapshotId ?? null,
      recent_matches: input.recentMatches ?? [],
      squad_snapshot_id: input.squadSnapshotId ?? null,
      coach: input.coach?.trim() || null,
      ...(input.structuredSnapshot == null
        ? {}
        : {
            structured_snapshot: {
              id: input.structuredSnapshot.id,
              feature_version: input.structuredSnapshot.featureVersion,
              sha256: input.structuredSnapshot.sha256,
              computed_at: new Date(
                input.structuredSnapshot.computedAt,
              ).toISOString(),
              cutoff_at: new Date(
                input.structuredSnapshot.cutoffAt,
              ).toISOString(),
              features: input.structuredSnapshot.features,
            },
          }),
      ...(input.providerAnalytics == null
        ? {}
        : {
            provider_analytics: {
              provider: input.providerAnalytics.provider,
              source_version: input.providerAnalytics.sourceVersion,
              captured_at: new Date(
                input.providerAnalytics.capturedAt,
              ).toISOString(),
              season: input.providerAnalytics.season,
              home: input.providerAnalytics.home,
              away: input.providerAnalytics.away,
            },
          }),
      prior: {
        type: input.prior.type,
        snapshot_id: input.prior.snapshotId,
        captured_at:
          input.prior.capturedAt == null
            ? null
            : new Date(input.prior.capturedAt).toISOString(),
        p_home_bp: input.prior.probabilitiesBp.home,
        p_draw_bp: input.prior.probabilitiesBp.draw,
        p_away_bp: input.prior.probabilitiesBp.away,
      },
    },
  };
}

export function buildRoundFixtureCards(
  inputs: FixtureCardInput[],
  researchCutoffAt: string,
  safetyWindowMinutes = DEFAULT_RESEARCH_SAFETY_WINDOW_MINUTES,
): KapilotoFixtureCard[] {
  if (inputs.length !== 16) {
    throw new Error(`Kapiloto round research requires exactly 16 fixtures; got ${inputs.length}.`);
  }

  const gameNumbers = inputs.map((input) => input.gameNumber);
  const unique = new Set(gameNumbers);
  if (unique.size !== 16 || [...unique].some((game) => game < 1 || game > 16)) {
    throw new Error("Kapiloto round fixture set must contain Toto numbers 1..16 exactly once.");
  }

  return [...inputs]
    .sort((a, b) => a.gameNumber - b.gameNumber)
    .map((input) =>
      buildKapilotoFixtureCard(input, researchCutoffAt, safetyWindowMinutes),
    );
}
