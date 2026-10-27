import type { KapilotoFixtureCard } from "./fixture-card";
import type { SolFixtureResearchOutput } from "./research-output";

export const KAPILOTO_STRUCTURED_REF_VERSION =
  "kapiloto-structured-refs-v1" as const;

export const KAPILOTO_STRUCTURED_REFS = [
  "home.form",
  "away.form",
  "home.rest",
  "away.rest",
  "home.table",
  "away.table",
  "home.attack_xg",
  "away.attack_xg",
] as const;

export type KapilotoStructuredRef =
  (typeof KAPILOTO_STRUCTURED_REFS)[number];

type ResearchFactor = SolFixtureResearchOutput["factors"][number];
type Side = "home" | "away";

export type StructuredFactorVerification = {
  valid: boolean;
  reason:
    | "no_structured_refs"
    | "missing_snapshot"
    | "unknown_ref"
    | "unavailable_ref"
    | "wrong_dimension"
    | "insufficient_pair"
    | "direction_mismatch"
    | "structured_only_magnitude_too_large"
    | "supported";
  refs: KapilotoStructuredRef[];
};

function refsOf(factor: ResearchFactor): string[] {
  return factor.structured_refs ?? [];
}

function isKnownRef(value: string): value is KapilotoStructuredRef {
  return (KAPILOTO_STRUCTURED_REFS as readonly string[]).includes(value);
}

function referencedSides(
  refs: KapilotoStructuredRef[],
  kind: "form" | "rest" | "table" | "attack_xg",
): Set<Side> {
  return new Set(
    refs
      .filter((ref) => ref.endsWith(`.${kind}`))
      .map((ref) => ref.split(".")[0] as Side),
  );
}

function requiredPair(
  refs: KapilotoStructuredRef[],
  kind: "form" | "rest" | "table" | "attack_xg",
): boolean {
  const sides = referencedSides(refs, kind);
  return sides.has("home") && sides.has("away");
}

function favorsByDifference(
  factor: ResearchFactor,
  homeValue: number,
  awayValue: number,
  margin: number,
): boolean {
  if (factor.favors === "home") return homeValue - awayValue >= margin;
  if (factor.favors === "away") return awayValue - homeValue >= margin;
  return factor.favors === "none";
}

function verifyFormDirection(
  factor: ResearchFactor,
  card: KapilotoFixtureCard,
  refs: KapilotoStructuredRef[],
): boolean {
  if (!requiredPair(refs, "form")) return false;
  const snapshot = card.structured.structured_snapshot;
  const home = snapshot?.features.home.form;
  const away = snapshot?.features.away.form;
  if (!home || !away || home.played < 3 || away.played < 3) return false;

  if (factor.dimension === "baseline_form") {
    const homePpg = home.points / home.played;
    const awayPpg = away.points / away.played;
    const homeGd = (home.gf - home.ga) / home.played;
    const awayGd = (away.gf - away.ga) / away.played;

    if (factor.favors === "home") {
      return homePpg - awayPpg >= 0.5 || homeGd - awayGd >= 0.5;
    }
    if (factor.favors === "away") {
      return awayPpg - homePpg >= 0.5 || awayGd - homeGd >= 0.5;
    }
    return factor.favors === "none";
  }

  if (factor.dimension === "home_away_draw") {
    if (home.venue_played < 3 || away.venue_played < 3) return false;
    return favorsByDifference(
      factor,
      home.venue_points / home.venue_played,
      away.venue_points / away.venue_played,
      0.5,
    );
  }

  return false;
}

function verifyScheduleDirection(
  factor: ResearchFactor,
  card: KapilotoFixtureCard,
  refs: KapilotoStructuredRef[],
): boolean {
  if (
    factor.dimension !== "load_schedule" ||
    !requiredPair(refs, "rest")
  ) {
    return false;
  }

  const snapshot = card.structured.structured_snapshot;
  const home = snapshot?.features.home.rest;
  const away = snapshot?.features.away.rest;
  if (!home || !away) return false;

  if (factor.favors === "home") {
    return (
      home.rest_days - away.rest_days >= 2 ||
      away.matches_last_14d - home.matches_last_14d >= 2
    );
  }
  if (factor.favors === "away") {
    return (
      away.rest_days - home.rest_days >= 2 ||
      home.matches_last_14d - away.matches_last_14d >= 2
    );
  }
  return factor.favors === "none";
}

function verifyTableDirection(
  factor: ResearchFactor,
  card: KapilotoFixtureCard,
  refs: KapilotoStructuredRef[],
): boolean {
  if (
    factor.dimension !== "competition_context" ||
    !requiredPair(refs, "table")
  ) {
    return false;
  }

  const snapshot = card.structured.structured_snapshot;
  const home = snapshot?.features.home.table;
  const away = snapshot?.features.away.table;
  if (
    !home ||
    !away ||
    home.played == null ||
    away.played == null ||
    home.played < 5 ||
    away.played < 5
  ) {
    return false;
  }

  return favorsByDifference(
    factor,
    home.points / home.played,
    away.points / away.played,
    0.5,
  );
}

function verifyAttackXgDirection(
  factor: ResearchFactor,
  card: KapilotoFixtureCard,
  refs: KapilotoStructuredRef[],
): boolean {
  if (
    factor.dimension !== "baseline_form" ||
    !requiredPair(refs, "attack_xg")
  ) {
    return false;
  }

  const analytics = card.structured.provider_analytics;
  const home = analytics?.home;
  const away = analytics?.away;

  if (
    home?.xg_per_match == null ||
    away?.xg_per_match == null ||
    home.games_played == null ||
    away.games_played == null ||
    home.games_played < 5 ||
    away.games_played < 5
  ) {
    return false;
  }

  return favorsByDifference(
    factor,
    home.xg_per_match,
    away.xg_per_match,
    0.15,
  );
}

function refAvailable(
  ref: KapilotoStructuredRef,
  card: KapilotoFixtureCard,
): boolean {
  const [side, kind] = ref.split(".") as [
    Side,
    "form" | "rest" | "table" | "attack_xg",
  ];

  if (kind === "attack_xg") {
    const analytics = card.structured.provider_analytics;
    const team = analytics?.[side];
    return (
      team?.xg_per_match != null &&
      team.games_played != null &&
      team.games_played >= 5
    );
  }

  const snapshot = card.structured.structured_snapshot;
  if (!snapshot) return false;
  const team = snapshot.features[side];
  const coverage = team.coverage[kind];

  return (
    team[kind] != null &&
    (coverage === "available" || coverage === "partial")
  );
}

export function structuredRefTrustTier(
  ref: KapilotoStructuredRef,
  card: KapilotoFixtureCard,
): 1 | 3 | null {
  const [side, kind] = ref.split(".") as [
    Side,
    "form" | "rest" | "table" | "attack_xg",
  ];

  if (kind === "attack_xg") {
    return refAvailable(ref, card) ? 1 : null;
  }

  const snapshot = card.structured.structured_snapshot;
  if (!snapshot) return null;
  const team = snapshot.features[side];
  if (team[kind] == null) return null;
  const coverage = team.coverage[kind];
  if (coverage === "available") return 1;
  if (coverage === "partial") return 3;
  return null;
}

export function validateStructuredRefs(
  refs: string[],
  card: KapilotoFixtureCard,
): KapilotoStructuredRef[] {
  if (refs.length === 0) return [];
  if (
    !card.structured.structured_snapshot &&
    !card.structured.provider_analytics
  ) {
    throw new Error(
      "Structured references require a frozen Fixture Card v3 snapshot.",
    );
  }

  const unique = new Set<KapilotoStructuredRef>();
  for (const ref of refs) {
    if (!isKnownRef(ref)) {
      throw new Error(`Unknown structured reference: ${ref}`);
    }
    if (!refAvailable(ref, card)) {
      throw new Error(`Structured reference is unavailable: ${ref}`);
    }
    unique.add(ref);
  }
  return [...unique].sort();
}

export function verifyStructuredFactor(
  factor: ResearchFactor,
  card: KapilotoFixtureCard,
): StructuredFactorVerification {
  const rawRefs = refsOf(factor);
  if (rawRefs.length === 0) {
    return { valid: false, reason: "no_structured_refs", refs: [] };
  }
  if (
    !card.structured.structured_snapshot &&
    !card.structured.provider_analytics
  ) {
    return { valid: false, reason: "missing_snapshot", refs: [] };
  }

  let refs: KapilotoStructuredRef[];
  try {
    refs = validateStructuredRefs(rawRefs, card);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      reason: message.includes("unavailable")
        ? "unavailable_ref"
        : "unknown_ref",
      refs: rawRefs.filter(isKnownRef),
    };
  }

  if (factor.evidence_ids.length === 0 && factor.magnitude !== "small") {
    return {
      valid: false,
      reason: "structured_only_magnitude_too_large",
      refs,
    };
  }

  let directionSupported = false;
  if (
    factor.dimension === "baseline_form" ||
    factor.dimension === "home_away_draw"
  ) {
    const hasFormRefs = refs.some((ref) => ref.endsWith(".form"));
    const hasXgRefs = refs.some((ref) => ref.endsWith(".attack_xg"));

    if (
      (hasFormRefs && !requiredPair(refs, "form")) ||
      (hasXgRefs && !requiredPair(refs, "attack_xg")) ||
      (!hasFormRefs && !hasXgRefs)
    ) {
      return { valid: false, reason: "insufficient_pair", refs };
    }

    directionSupported =
      (hasFormRefs && verifyFormDirection(factor, card, refs)) ||
      (factor.dimension === "baseline_form" &&
        hasXgRefs &&
        verifyAttackXgDirection(factor, card, refs));
  } else if (factor.dimension === "load_schedule") {
    if (!requiredPair(refs, "rest")) {
      return { valid: false, reason: "insufficient_pair", refs };
    }
    directionSupported = verifyScheduleDirection(factor, card, refs);
  } else if (factor.dimension === "competition_context") {
    if (!requiredPair(refs, "table")) {
      return { valid: false, reason: "insufficient_pair", refs };
    }
    directionSupported = verifyTableDirection(factor, card, refs);
  } else {
    return { valid: false, reason: "wrong_dimension", refs };
  }

  return {
    valid: directionSupported,
    reason: directionSupported ? "supported" : "direction_mismatch",
    refs,
  };
}
