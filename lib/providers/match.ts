const STOP_TOKENS = new Set([
  "fc",
  "cf",
  "afc",
  "sc",
  "club",
  "football",
  "f.c",
]);

const HEBREW_WORD_OVERRIDES: Record<string, string> = {
  "מכבי": "maccabi",
  "הפועל": "hapoel",
  "ביתר": "beitar",
  "בני": "bnei",
  "עירוני": "ironi",
  "קרית": "kiryat",
  "שמונה": "shmona",
  "פתח": "petah",
  "תקווה": "tikva",
  "חיפה": "haifa",
  "נתניה": "netanya",
  "ירושלים": "jerusalem",
  "סכנין": "sakhnin",
  "באר": "beer",
  "שבע": "sheva",
  "תל": "tel",
  "אביב": "aviv",
  "רמת": "ramat",
  "גן": "gan",
  "טבריה": "tiberias",
  "קובנטרי": "coventry",
  "פולהאם": "fulham",
  "האל": "hull",
  "ברנטפורד": "brentford",
  "קריסטל": "crystal",
  "פאלאס": "palace",
  "ניוקאסל": "newcastle",
  "סנדרלנד": "sunderland",
  "לידס": "leeds",
  "ראסינג": "racing",
  "סנטאנדר": "santander",
  "אספניול": "espanyol",
  "ולנסיה": "valencia",
  "ויאריאל": "villarreal",
  "סלטה": "celta",
  "ויגו": "vigo",
  "בטיס": "betis",
  "קליארי": "cagliari",
  "בולוניה": "bologna",
  "נאפולי": "napoli",
  "רומא": "roma",
  "קלן": "koln",
  "שאלקה": "schalke",
  "פאדרבורן": "paderborn",
  "המבורג": "hamburg",
};

const HEBREW_LETTERS: Record<string, string> = {
  "א": "a",
  "ב": "b",
  "ג": "g",
  "ד": "d",
  "ה": "h",
  "ו": "v",
  "ז": "z",
  "ח": "h",
  "ט": "t",
  "י": "i",
  "כ": "k",
  "ך": "k",
  "ל": "l",
  "מ": "m",
  "ם": "m",
  "נ": "n",
  "ן": "n",
  "ס": "s",
  "ע": "a",
  "פ": "p",
  "ף": "p",
  "צ": "z",
  "ץ": "z",
  "ק": "k",
  "ר": "r",
  "ש": "sh",
  "ת": "t",
};

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

function romanizeHebrewToken(token: string): string {
  const override = HEBREW_WORD_OVERRIDES[token];
  if (override) return override;

  return [...token]
    .map((character) => HEBREW_LETTERS[character] ?? character)
    .join("");
}

export function romanizeTeamName(value: string): string {
  return value
    .replace(/[״"]/g, "")
    .replace(/[׳']/g, "")
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map(romanizeHebrewToken)
    .join(" ");
}

function compact(value: string): string {
  return normalizeTeamName(value)
    .split(" ")
    .filter(
      (token) =>
        token.length > 1 &&
        token !== "sv" &&
        token !== "vfb" &&
        token !== "04" &&
        token !== "96" &&
        token !== "07" &&
        token !== "1",
    )
    .join("");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;

    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }

    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

export function crossScriptTeamSimilarity(
  canonicalName: string,
  providerName: string,
): number {
  const left = compact(romanizeTeamName(canonicalName));
  const right = compact(providerName);

  if (!left || !right) return 0;
  if (left === right) return 1;

  if (left.includes(right) || right.includes(left)) {
    const ratio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    return Math.max(0.82, ratio);
  }

  const distance = levenshtein(left, right);
  return Math.max(0, 1 - distance / Math.max(left.length, right.length));
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

export function bestHybridAliasSimilarity(
  providerName: string,
  primaryName: string,
  aliases: string[] = [],
): number {
  const candidates = [primaryName, ...aliases];

  return Math.max(
    bestAliasSimilarity(providerName, primaryName, aliases),
    ...candidates.map((candidate) =>
      crossScriptTeamSimilarity(candidate, providerName),
    ),
  );
}
