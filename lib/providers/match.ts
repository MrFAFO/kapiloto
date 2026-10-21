const STOP_TOKENS = new Set([
  "fc",
  "cf",
  "afc",
  "sc",
  "club",
  "football",
  "f.c",
]);

export function normalizeTeamName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !STOP_TOKENS.has(token))
    .join(" ");
}

function tokens(value: string): Set<string> {
  return new Set(normalizeTeamName(value).split(" ").filter(Boolean));
}

export function tokenSimilarity(a: string, b: string): number {
  const aTokens = tokens(a);
  const bTokens = tokens(b);

  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }

  return (2 * intersection) / (aTokens.size + bTokens.size);
}

export function bestAliasSimilarity(
  providerName: string,
  primaryName: string,
  aliases: string[] = [],
): number {
  const candidates = [primaryName, ...aliases];

  return Math.max(
    ...candidates.map((candidate) => {
      const normalizedCandidate = normalizeTeamName(candidate);
      const normalizedProvider = normalizeTeamName(providerName);
      if (
        normalizedCandidate &&
        normalizedProvider &&
        normalizedCandidate === normalizedProvider
      ) {
        return 1;
      }
      return tokenSimilarity(candidate, providerName);
    }),
  );
}
