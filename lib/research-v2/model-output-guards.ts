import { FORBIDDEN_FIELD } from "./evidence";

/**
 * Guards for anything a model returns in Research v2 (Sol discovery, the
 * entailment judge). Stricter than the server-side forecast-key guard: a
 * model may also not name winners, tips, bets, recommendations, adjustments,
 * impacts, magnitudes or directions. Structured Outputs constrain the shape;
 * these guards are defence in depth.
 */

const FORBIDDEN_MODEL_TOKENS = new Set([
  "winner",
  "favourite",
  "favorite",
  "tip",
  "tips",
  "stake",
  "bet",
  "bets",
  "betting",
  "recommend",
  "recommended",
  "recommendation",
  "adjust",
  "adjusted",
  "adjustment",
  "impact",
  "magnitude",
  "direction",
]);

/** snake_case, camelCase and kebab-case keys split into lowercase tokens. */
function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isForbiddenModelKey(key: string): boolean {
  return FORBIDDEN_FIELD.test(key) || keyTokens(key).some((token) => FORBIDDEN_MODEL_TOKENS.has(token));
}

/** Property names anywhere in a JSON schema that a model contract must not contain. */
export function forbiddenModelFields(schema: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((child, index) => walk(child, `${path}[${index}]`));
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === "object") {
      for (const name of Object.keys(record.properties as Record<string, unknown>)) {
        if (isForbiddenModelKey(name)) found.push(`${path}.${name}`);
      }
    }
    for (const [key, child] of Object.entries(record)) walk(child, `${path}.${key}`);
  };
  walk(schema, "$");
  return found;
}

/** Paths of forbidden keys anywhere in a parsed model output (recursive). */
export function findForbiddenModelKeys(value: unknown, path = "$"): string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: string) => {
    if (Array.isArray(node)) return node.forEach((child, index) => walk(child, `${at}[${index}]`));
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (isForbiddenModelKey(key)) found.push(`${at}.${key}`);
      walk(child, `${at}.${key}`);
    }
  };
  walk(value, path);
  return found;
}

export type ForecastLanguageFinding = "percentage" | "betting_language" | "outcome_market_notation" | "outcome_language";

const FORECAST_LANGUAGE: ReadonlyArray<[ForecastLanguageFinding, RegExp]> = [
  ["percentage", /\d+(?:[.,]\d+)?\s?%/],
  ["betting_language", /\b(?:odds|bookmakers?|bookies|betting|bets?|wagers?|accumulators?|handicaps?|over\/under|both teams to score|tipsters?|tips)\b/i],
  ["outcome_market_notation", /\b(?:1x2|1x|x2)\b/i],
  [
    "outcome_language",
    /\b(?:probab\w*|likelihood|predict\w*|forecast\w*|favou?rites?|chances? of (?:winning|losing|victory|defeat)|(?:expected|likely|tipped|set) to (?:win|lose|beat)|will (?:win|lose|beat))\b/i,
  ],
];

/**
 * Forecast or betting language in a model's own free text (never applied to
 * verbatim source quotes, which are checked against the fetched page instead).
 */
export function forecastLanguageFindings(text: string): ForecastLanguageFinding[] {
  return FORECAST_LANGUAGE.filter(([, pattern]) => pattern.test(text)).map(([finding]) => finding);
}
