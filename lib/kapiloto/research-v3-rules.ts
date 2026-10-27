import type { KapilotoFixtureCard } from "./fixture-card";
import type {
  KapilotoMatchupKind,
  KapilotoResearchDimension,
  SolRegimeChange,
} from "./research-output";

/**
 * Research v3 evidence rules derived from the ITEM that cites the evidence.
 *
 * The model-declared `claim_type` only has to be compatible with the citing
 * item; it never selects freshness or trust on its own. Freshness windows and
 * the canonical trust class always come from the item kind, and the effective
 * trust tier is the WORSE of the declared and canonical class so relabelling a
 * claim can never raise its trust (no claim-type laundering).
 */

export const DAY_MS = 86_400_000;

export type V3FreshnessRule = {
  /** Evidence must carry a source publication timestamp. */
  requireDated: boolean;
  /** Maximum source age at the research cutoff, in days. */
  maxAgeDays: number | null;
  /** Source must be published after this side's latest known match. */
  afterLastMatch?: "home" | "away";
};

export type V3EvidenceRule = {
  allowedClaimTypes: readonly string[];
  canonicalClaimType: string;
  freshness: V3FreshnessRule;
};

export const V3_LINEUP_MAX_AGE_DAYS = 7;
export const V3_TACTICAL_MAX_AGE_DAYS = 45;
export const V3_DIRECTIONAL_MATCHUP_RECENT_DAYS = 14;
export const V3_REGIME_MAX_AGE_DAYS = 180;
export const V3_AVAILABILITY_MAX_AGE_DAYS = 14;
export const V3_MAX_DISTINCT_EVIDENCE_URLS = 20;
export const V3_MAX_EVIDENCE_ROWS = 24;

export function starterRule(side: "home" | "away"): V3EvidenceRule {
  return {
    allowedClaimTypes: ["lineup", "availability"],
    canonicalClaimType: "lineup",
    freshness: {
      requireDated: true,
      maxAgeDays: V3_LINEUP_MAX_AGE_DAYS,
      afterLastMatch: side,
    },
  };
}

export function formationRule(side: "home" | "away"): V3EvidenceRule {
  return {
    allowedClaimTypes: ["lineup", "formation"],
    canonicalClaimType: "formation",
    freshness: {
      requireDated: true,
      maxAgeDays: V3_LINEUP_MAX_AGE_DAYS,
      afterLastMatch: side,
    },
  };
}

export const ROLE_RULE: V3EvidenceRule = {
  allowedClaimTypes: ["tactical_setup", "availability", "lineup"],
  canonicalClaimType: "tactical_setup",
  freshness: { requireDated: true, maxAgeDays: V3_TACTICAL_MAX_AGE_DAYS },
};

export const TACTICAL_FACT_RULE: V3EvidenceRule = {
  allowedClaimTypes: ["tactical_setup", "formation"],
  canonicalClaimType: "tactical_setup",
  freshness: { requireDated: true, maxAgeDays: V3_TACTICAL_MAX_AGE_DAYS },
};

export const AVAILABILITY_ITEM_RULE: V3EvidenceRule = {
  allowedClaimTypes: ["availability", "lineup"],
  canonicalClaimType: "availability",
  freshness: { requireDated: true, maxAgeDays: V3_AVAILABILITY_MAX_AGE_DAYS },
};

export function matchupRule(kind: KapilotoMatchupKind): V3EvidenceRule {
  const freshness = {
    requireDated: true,
    maxAgeDays: V3_TACTICAL_MAX_AGE_DAYS,
  };
  if (kind === "absence_impact") {
    return {
      allowedClaimTypes: ["availability", "lineup", "tactical_setup", "formation"],
      canonicalClaimType: "availability",
      freshness,
    };
  }
  if (kind === "formation_change") {
    return {
      allowedClaimTypes: [
        "formation",
        "tactical_setup",
        "coach_regime",
        "club_coach_news",
        "lineup",
      ],
      canonicalClaimType: "tactical_setup",
      freshness,
    };
  }
  return {
    allowedClaimTypes: ["tactical_setup", "formation", "lineup"],
    canonicalClaimType: "tactical_setup",
    freshness,
  };
}

export function regimeRule(type: SolRegimeChange["type"]): V3EvidenceRule {
  return {
    allowedClaimTypes:
      type === "coach_change"
        ? ["coach_regime", "club_coach_news"]
        : ["coach_regime", "formation", "tactical_setup"],
    canonicalClaimType: "coach_regime",
    freshness: { requireDated: true, maxAgeDays: V3_REGIME_MAX_AGE_DAYS },
  };
}

const FACTOR_RULES: Record<KapilotoResearchDimension, V3EvidenceRule> = {
  baseline_form: {
    allowedClaimTypes: ["form", "independent_model"],
    canonicalClaimType: "form",
    freshness: { requireDated: false, maxAgeDays: null },
  },
  home_away_draw: {
    allowedClaimTypes: ["home_away", "draw_propensity"],
    canonicalClaimType: "home_away",
    freshness: { requireDated: false, maxAgeDays: null },
  },
  availability: {
    allowedClaimTypes: ["availability", "lineup"],
    canonicalClaimType: "availability",
    freshness: { requireDated: true, maxAgeDays: V3_AVAILABILITY_MAX_AGE_DAYS },
  },
  load_schedule: {
    allowedClaimTypes: ["schedule_fatigue"],
    canonicalClaimType: "schedule_fatigue",
    freshness: { requireDated: true, maxAgeDays: 14 },
  },
  tactical_matchup: {
    allowedClaimTypes: ["tactical_setup", "formation", "lineup", "coach_regime"],
    canonicalClaimType: "tactical_setup",
    freshness: { requireDated: true, maxAgeDays: V3_TACTICAL_MAX_AGE_DAYS },
  },
  competition_context: {
    allowedClaimTypes: ["competition_context"],
    canonicalClaimType: "competition_context",
    freshness: { requireDated: false, maxAgeDays: null },
  },
  club_coach_news: {
    allowedClaimTypes: ["club_coach_news", "coach_regime", "formation"],
    canonicalClaimType: "club_coach_news",
    freshness: { requireDated: true, maxAgeDays: V3_REGIME_MAX_AGE_DAYS },
  },
  independent_model: {
    allowedClaimTypes: ["independent_model"],
    canonicalClaimType: "independent_model",
    freshness: { requireDated: false, maxAgeDays: null },
  },
  conditions: {
    allowedClaimTypes: ["conditions"],
    canonicalClaimType: "conditions",
    freshness: { requireDated: true, maxAgeDays: 7 },
  },
  head_to_head: {
    allowedClaimTypes: ["head_to_head"],
    canonicalClaimType: "head_to_head",
    freshness: { requireDated: false, maxAgeDays: null },
  },
};

function hasStructuredFormCoverage(card: KapilotoFixtureCard): boolean {
  const features = card.structured.structured_snapshot?.features;
  if (!features) return false;
  return (["home", "away"] as const).every((side) => {
    const status = features[side]?.coverage?.form;
    return status === "available" || status === "partial";
  });
}

/**
 * Evidence rule for a probability-moving factor. Web reports that merely
 * restate structured form/xG cannot add a second directional signal when the
 * frozen card already covers those values for both teams.
 */
export function factorRule(
  dimension: KapilotoResearchDimension,
  card: KapilotoFixtureCard,
): V3EvidenceRule {
  const rule = FACTOR_RULES[dimension];
  if (dimension === "baseline_form" && hasStructuredFormCoverage(card)) {
    return { ...rule, allowedClaimTypes: [] };
  }
  if (dimension === "home_away_draw" && hasStructuredFormCoverage(card)) {
    return { ...rule, allowedClaimTypes: ["draw_propensity"] };
  }
  return rule;
}

export function canonicalClaimTypeForDimension(
  dimension: KapilotoResearchDimension,
): string {
  return FACTOR_RULES[dimension].canonicalClaimType;
}

type FreshnessInput = {
  publishedAt: string | null;
};

export type FreshnessFailure =
  | "undated"
  | "stale"
  | "before_last_match"
  | "after_cutoff";

export function freshnessFailure(
  evidence: FreshnessInput,
  rule: V3FreshnessRule,
  card: KapilotoFixtureCard,
): FreshnessFailure | null {
  if (evidence.publishedAt == null) {
    return rule.requireDated ? "undated" : null;
  }
  const publishedMs = Date.parse(evidence.publishedAt);
  const cutoffMs = Date.parse(card.research_cutoff_at);
  if (!Number.isFinite(publishedMs)) return "undated";
  if (publishedMs > cutoffMs) return "after_cutoff";
  if (rule.maxAgeDays != null && cutoffMs - publishedMs > rule.maxAgeDays * DAY_MS) {
    return "stale";
  }
  if (rule.afterLastMatch) {
    const lastMatchAt =
      card.structured.structured_snapshot?.features[rule.afterLastMatch]?.form
        ?.last_match_at ?? null;
    const lastMatchMs = lastMatchAt == null ? NaN : Date.parse(lastMatchAt);
    if (Number.isFinite(lastMatchMs) && publishedMs <= lastMatchMs) {
      return "before_last_match";
    }
  }
  return null;
}

/** Resolves a registry tier map with v3 fallbacks for unconfigured types. */
export function resolveV3TierMap(
  raw: Record<string, number | undefined>,
): Record<string, number> {
  const mapped: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4) {
      mapped[key] = value;
    }
  }
  mapped.lineup ??= mapped.availability ?? mapped.default ?? 4;
  mapped.formation ??= mapped.tactical ?? mapped.default ?? 4;
  mapped.tactical_setup ??= mapped.tactical ?? mapped.default ?? 4;
  mapped.coach_regime ??= mapped.club_coach_news ?? mapped.default ?? 4;
  return mapped;
}

export function tierFromMap(
  map: Record<string, number> | undefined,
  claimType: string,
): number {
  if (!map) return 4;
  const value = map[claimType] ?? map.default ?? 4;
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 4;
}

type TieredEvidence = {
  trustTier: number;
  claimTierMap?: Record<string, number>;
};

/**
 * Trust tier of one evidence row when used by an item of `canonicalClaimType`.
 * The worse of the declared-type tier and the item's canonical tier wins.
 */
export function itemTrustTier(
  evidence: TieredEvidence,
  canonicalClaimType: string,
): number {
  if (!evidence.claimTierMap) return evidence.trustTier;
  return Math.max(
    evidence.trustTier,
    tierFromMap(evidence.claimTierMap, canonicalClaimType),
  );
}

export function normalizeQuoteForIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Same canonical URL + normalized quote counts as the same evidence. */
export function evidenceIdentityKey(evidence: {
  canonicalUrl: string;
  quote: string;
}): string {
  return `${evidence.canonicalUrl}\u0000${normalizeQuoteForIdentity(evidence.quote)}`;
}

export function normalizeFormationText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‐-―−]/g, "-")
    .replace(/(\d)\s*-\s*(?=\d)/g, "$1-");
}

export function isRealCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * Deterministic staleness of structured form/xG after a dated regime change.
 *
 * The frozen card cannot count matches since an arbitrary date, so only two
 * provable cases are treated as "fewer than five matches under the new
 * regime":
 *  1. the change is dated after the team's latest league match in the frozen
 *     form window (zero matches since), or
 *  2. the change falls inside the 14-day rest window and the team played
 *     fewer than five matches in that window.
 * Anything else is left undetermined (V4 will count matches since the date).
 */
export function regimeMakesStructuredStale(
  regime: Pick<SolRegimeChange, "team" | "effective_date">,
  card: KapilotoFixtureCard,
): boolean {
  if (!isRealCalendarDate(regime.effective_date)) return false;
  const effectiveMs = Date.parse(`${regime.effective_date}T00:00:00.000Z`);
  const features = card.structured.structured_snapshot?.features[regime.team];
  if (!features) return false;

  const lastMatchMs =
    features.form?.last_match_at == null
      ? NaN
      : Date.parse(features.form.last_match_at);
  if (Number.isFinite(lastMatchMs) && effectiveMs > lastMatchMs) {
    return true;
  }

  const kickoffMs = Date.parse(card.kickoff_at);
  const matchesLast14d = features.rest?.matches_last_14d;
  if (
    Number.isFinite(kickoffMs) &&
    typeof matchesLast14d === "number" &&
    effectiveMs >= kickoffMs - 14 * DAY_MS &&
    matchesLast14d < 5
  ) {
    return true;
  }

  return false;
}
