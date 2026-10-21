import type { ProviderFixture } from "@/lib/providers/types";
import { normalizeTeamName } from "@/lib/providers/match";

import type {
  DiscoveredRoundGame,
  TotoRoundDiscovery,
} from "./toto-source";

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
        token !== "96",
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
  discoveredName: string,
  providerName: string,
): number {
  const left = compact(romanizeTeamName(discoveredName));
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

function fixturePairScore(
  game: DiscoveredRoundGame,
  fixture: ProviderFixture,
): number {
  if (
    normalizeTeamName(game.competition.canonicalName) !==
    normalizeTeamName(fixture.competition.name)
  ) {
    return 0;
  }

  const home = crossScriptTeamSimilarity(game.homeTeam, fixture.home.name);
  const away = crossScriptTeamSimilarity(game.awayTeam, fixture.away.name);

  if (home < 0.55 || away < 0.55) return 0;
  return home * 0.5 + away * 0.5;
}

export type DiscoveryCompletion = {
  discovery: TotoRoundDiscovery;
  resolvedBySportmonks: Array<{
    gameNumber: number;
    providerFixtureId: string;
    kickoffAt: string;
    score: number;
  }>;
  unresolvedGameNumbers: number[];
};

export function completeMissingKickoffsFromFixtures(
  discovery: TotoRoundDiscovery,
  providerFixtures: ProviderFixture[],
): DiscoveryCompletion {
  const usedFixtureIds = new Set<string>();
  const resolvedBySportmonks: DiscoveryCompletion["resolvedBySportmonks"] = [];

  const games = discovery.games.map((game) => {
    if (game.kickoffAt) return { ...game };

    const candidates = providerFixtures
      .filter((fixture) => !usedFixtureIds.has(fixture.providerFixtureId))
      .map((fixture) => ({
        fixture,
        score: fixturePairScore(game, fixture),
      }))
      .filter((candidate) => candidate.score >= 0.68)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) return { ...game };

    const best = candidates[0];
    const second = candidates[1];
    if (second && best.score - second.score < 0.08) {
      return { ...game };
    }

    usedFixtureIds.add(best.fixture.providerFixtureId);
    resolvedBySportmonks.push({
      gameNumber: game.gameNumber,
      providerFixtureId: best.fixture.providerFixtureId,
      kickoffAt: best.fixture.kickoffAt,
      score: Math.round(best.score * 10_000) / 10_000,
    });

    return {
      ...game,
      kickoffAt: new Date(best.fixture.kickoffAt).toISOString(),
      rawKickoff: `${game.rawKickoff} · resolved:sportmonks`,
    };
  });

  const unresolvedGameNumbers = games
    .filter((game) => !game.kickoffAt)
    .map((game) => game.gameNumber);

  const suffix =
    resolvedBySportmonks.length === 0
      ? ""
      : `+sportmonks:${resolvedBySportmonks
          .map((item) => `${item.gameNumber}=${item.providerFixtureId}`)
          .join(",")}`;

  return {
    discovery: {
      ...discovery,
      sourceVersion: `${discovery.sourceVersion}${suffix}`,
      games,
      completeKickoffs: unresolvedGameNumbers.length === 0,
    },
    resolvedBySportmonks,
    unresolvedGameNumbers,
  };
}

export function sportmonksCompletionWindow(
  discovery: TotoRoundDiscovery,
): { startDate: string; endDate: string } | null {
  const known = discovery.games
    .map((game) => game.kickoffAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);

  if (known.length === 0) return null;

  const start = new Date(Math.min(...known));
  const end = new Date(Math.max(...known));
  start.setUTCDate(start.getUTCDate() - 1);
  end.setUTCDate(end.getUTCDate() + 2);

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

export type OperationalLock = {
  lockAt: string;
  sourceType: "derived_safety";
  sourceRef: string;
  derived: true;
  safetyMinutes: number;
};

export function deriveConservativeOperationalLock(
  discovery: TotoRoundDiscovery,
  safetyMinutes = 30,
): OperationalLock {
  if (!Number.isInteger(safetyMinutes) || safetyMinutes < 5 || safetyMinutes > 180) {
    throw new Error("Toto safety lock must be an integer between 5 and 180 minutes.");
  }

  const kickoffTimes = discovery.games.map((game) => {
    if (!game.kickoffAt) {
      throw new Error(
        `Cannot derive operational lock with unresolved game ${game.gameNumber}.`,
      );
    }
    return Date.parse(game.kickoffAt);
  });

  const earliest = Math.min(...kickoffTimes);
  return {
    lockAt: new Date(earliest - safetyMinutes * 60_000).toISOString(),
    sourceType: "derived_safety",
    sourceRef: `earliest_fixture_minus_${safetyMinutes}m`,
    derived: true,
    safetyMinutes,
  };
}
