import { createHash } from "node:crypto";

import type {
  DiscoveredCompetition,
  DiscoveredRoundGame,
  TotoRoundDiscovery,
  TotoRoundProvider,
} from "./toto-source";

const DEFAULT_URL = "https://www.telesport.co.il/winner-16";
const ISRAEL_TIME_ZONE = "Asia/Jerusalem";

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type TelesportGameState = {
  gameNumber: number;
  status:
    | "upcoming"
    | "live"
    | "halftime"
    | "finished"
    | "postponed"
    | "cancelled"
    | "suspended"
    | "under_review";
  homeScore: number | null;
  awayScore: number | null;
  outcome: "1" | "X" | "2" | null;
  rawStatus: string;
  rawScore: string;
};

export type TelesportWinner16State = {
  externalRoundNumber: string;
  sourceVersion: string;
  fetchedAt: string;
  games: TelesportGameState[];
};

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/&lt;|&#60;/gi, "<")
    .replace(/&gt;|&#62;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#([0-9]+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    );
}

function textFromHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function inferYear(month: number, now: Date): number {
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const difference = month - currentMonth;

  if (difference > 6) return currentYear - 1;
  if (difference < -6) return currentYear + 1;
  return currentYear;
}

const israelFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ISRAEL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function zonedParts(epochMs: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const values = Object.fromEntries(
    israelFormatter
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

export function israelLocalDateTimeToIso(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): string {
  const desiredAsUtc = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    0,
  );

  let guess = desiredAsUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(guess);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const delta = desiredAsUtc - actualAsUtc;

    if (delta === 0) {
      return new Date(guess).toISOString();
    }

    guess += delta;
  }

  return new Date(guess).toISOString();
}

export function normalizeTelesportCompetition(
  sourceLabel: string,
): DiscoveredCompetition {
  const label = sourceLabel.replace(/\s+/g, " ").trim();

  const known: Array<{
    match: RegExp;
    canonicalName: string;
    countryCode: string;
  }> = [
    {
      match: /^ישראל\s*-\s*ליגת\s+Winner$/i,
      canonicalName: "Ligat Ha'al",
      countryCode: "IL",
    },
    {
      match: /^אנגליה\s*-\s*פרמייר\s+ליג$/i,
      canonicalName: "Premier League",
      countryCode: "GB",
    },
    {
      match: /^ספרד\s*-\s*לה\s+ליגה$/i,
      canonicalName: "La Liga",
      countryCode: "ES",
    },
    {
      match: /^איטליה\s*-\s*סרייה\s+א['׳]?$/i,
      canonicalName: "Serie A",
      countryCode: "IT",
    },
    {
      match: /^גרמניה\s*-\s*בונדסליגה$/i,
      canonicalName: "Bundesliga",
      countryCode: "DE",
    },
    {
      match: /^צרפת\s*-\s*ליג\s*1$/i,
      canonicalName: "Ligue 1",
      countryCode: "FR",
    },
  ];

  const mapped = known.find((item) => item.match.test(label));

  return {
    canonicalName: mapped?.canonicalName ?? label,
    countryCode: mapped?.countryCode ?? null,
    competitionType: "league",
    sourceLabel: label,
  };
}

function parseKickoff(
  rawKickoff: string,
  now: Date,
): string | null {
  const match = rawKickoff.match(
    /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/,
  );

  if (!match) return null;

  const [, dayText, monthText, hourText, minuteText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const year = inferYear(month, now);

  return israelLocalDateTimeToIso({
    year,
    month,
    day,
    hour,
    minute,
  });
}

function parseTelesportScore(
  rawScore: string,
): { home: number; away: number } | null {
  const match = rawScore.match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if (!match) return null;

  const home = Number(match[1]);
  const away = Number(match[2]);
  if (!Number.isInteger(home) || !Number.isInteger(away)) return null;

  return { home, away };
}

function canonicalTelesportGameStatus(
  rawStatus: string,
  hasScore: boolean,
): TelesportGameState["status"] {
  const value = rawStatus.replace(/\s+/g, " ").trim();

  if (/הסתיים/.test(value)) return "finished";
  if (/מחצית/.test(value) || /^45['’]?\+?$/.test(value)) return "halftime";
  if (/^\d{1,3}['’]\+?$/.test(value)) return "live";
  if (/נדחה/.test(value)) return "postponed";
  if (/בוטל/.test(value)) return "cancelled";
  if (/הופסק|נפסק/.test(value)) return "suspended";
  if (/^\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}$/.test(value)) return "upcoming";
  if (/ת\.\s*סיום/.test(value)) return "upcoming";

  return hasScore ? "under_review" : "upcoming";
}

type ModernWinner16Row = {
  gameNumber: number;
  rawStatus: string;
  homeTeam: string;
  rawScore: string;
  awayTeam: string;
  outcome: "1" | "X" | "2" | null;
  competition: DiscoveredCompetition;
};

function modernVisibleLines(html: string): string[] {
  const withoutNonContent = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");

  const withBoundaries = withoutNonContent
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(
      /<\/(?:div|p|li|tr|td|th|h1|h2|h3|h4|section|article|header|footer|main|span|button)>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");

  return decodeHtml(withBoundaries)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function modernRoundAnchor(lines: string[]): {
  index: number;
  externalRoundNumber: string;
} | null {
  const currentRoundIndex = lines.findIndex((line) => /^מחזור\s+נוכחי$/i.test(line));
  const start = currentRoundIndex >= 0 ? currentRoundIndex + 1 : 0;
  const end =
    currentRoundIndex >= 0
      ? Math.min(lines.length, currentRoundIndex + 8)
      : lines.length;

  for (let index = start; index < end; index += 1) {
    const match = lines[index].match(/^מחזור\s*:\s*(\d+)$/);
    if (match) {
      return { index, externalRoundNumber: match[1] };
    }
  }

  return null;
}

function parseModernWinner16Rows(html: string): {
  externalRoundNumber: string;
  rows: ModernWinner16Row[];
} | null {
  const lines = modernVisibleLines(html);
  const anchor = modernRoundAnchor(lines);
  if (!anchor) return null;

  const rows: ModernWinner16Row[] = [];
  let cursor = anchor.index + 1;
  let competition: DiscoveredCompetition | null = null;

  for (let expected = 1; expected <= 16; expected += 1) {
    const expectedText = String(expected);
    let gameIndex = -1;

    while (cursor < lines.length) {
      if (lines[cursor] === expectedText) {
        gameIndex = cursor;
        break;
      }

      const candidate = lines[cursor];
      if (
        candidate !== "?" &&
        candidate !== "1" &&
        candidate !== "X" &&
        candidate !== "2" &&
        !/^מחזור\s*:/i.test(candidate)
      ) {
        competition = normalizeTelesportCompetition(candidate);
      }
      cursor += 1;
    }

    if (gameIndex < 0 || !competition) return null;
    if (gameIndex + 4 >= lines.length) return null;

    const rawStatus = lines[gameIndex + 1];
    const homeTeam = lines[gameIndex + 2];
    const rawScore = lines[gameIndex + 3];
    const awayTeam = lines[gameIndex + 4];

    if (
      !rawStatus ||
      !homeTeam ||
      !awayTeam ||
      /^\d{1,2}$/.test(homeTeam) ||
      /^\d{1,2}$/.test(awayTeam)
    ) {
      return null;
    }

    cursor = gameIndex + 5;

    let outcome: "1" | "X" | "2" | null = null;
    const outcomeCandidate = lines[cursor];
    if (
      outcomeCandidate === "?" ||
      outcomeCandidate === "1" ||
      outcomeCandidate === "X" ||
      outcomeCandidate === "2"
    ) {
      const nextGameText = expected < 16 ? String(expected + 1) : null;
      const looksLikeNextGameNumber =
        nextGameText != null &&
        outcomeCandidate === nextGameText &&
        lines[cursor + 1] !== nextGameText;

      if (!looksLikeNextGameNumber) {
        if (
          outcomeCandidate === "1" ||
          outcomeCandidate === "X" ||
          outcomeCandidate === "2"
        ) {
          outcome = outcomeCandidate;
        }
        cursor += 1;
      }
    }

    rows.push({
      gameNumber: expected,
      rawStatus,
      homeTeam,
      rawScore,
      awayTeam,
      outcome,
      competition,
    });
  }

  if (rows.length !== 16) return null;
  return { externalRoundNumber: anchor.externalRoundNumber, rows };
}

function parseModernTelesportWinner16StateHtml(
  html: string,
): Omit<TelesportWinner16State, "sourceVersion" | "fetchedAt"> | null {
  const parsed = parseModernWinner16Rows(html);
  if (!parsed) return null;

  return {
    externalRoundNumber: parsed.externalRoundNumber,
    games: parsed.rows.map((row) => {
      const score = parseTelesportScore(row.rawScore);
      return {
        gameNumber: row.gameNumber,
        status: canonicalTelesportGameStatus(row.rawStatus, score != null),
        homeScore: score?.home ?? null,
        awayScore: score?.away ?? null,
        outcome: row.outcome,
        rawStatus: row.rawStatus,
        rawScore: row.rawScore,
      };
    }),
  };
}

function parseModernTelesportWinner16Html(
  html: string,
  now: Date,
): Omit<
  TotoRoundDiscovery,
  "source" | "sourceUrl" | "sourceVersion" | "fetchedAt"
> | null {
  const parsed = parseModernWinner16Rows(html);
  if (!parsed) return null;

  const games: DiscoveredRoundGame[] = parsed.rows.map((row) => ({
    gameNumber: row.gameNumber,
    rawKickoff: row.rawStatus,
    kickoffAt: parseKickoff(row.rawStatus, now),
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    competition: row.competition,
  }));

  return {
    externalRoundNumber: parsed.externalRoundNumber,
    games,
    completeKickoffs: games.every((game) => game.kickoffAt !== null),
  };
}

export function parseTelesportWinner16StateHtml(
  html: string,
): Omit<TelesportWinner16State, "sourceVersion" | "fetchedAt"> {
  const sectionMatch = html.match(
    /<h2\b[^>]*>\s*ווינר\s*16\s*-\s*מספר\s*מחזור\s*:\s*(\d+)\s*<\/h2>([\s\S]*?)(?=<h2\b|$)/i,
  );

  if (!sectionMatch) {
    const modern = parseModernTelesportWinner16StateHtml(html);
    if (modern) return modern;
    throw new Error("Telesport Winner 16 state section was not found.");
  }

  const externalRoundNumber = sectionMatch[1];
  const section = sectionMatch[2];
  const games: TelesportGameState[] = [];
  const tablePattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;

  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tablePattern.exec(section)) !== null) {
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowPattern.exec(tableMatch[1])) !== null) {
      const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
        .map((match) => textFromHtml(match[1]));

      if (cells.length < 5) continue;

      const numberMatch = cells[0].match(/^(\d{1,2})\.?$/);
      if (!numberMatch) continue;

      const gameNumber = Number(numberMatch[1]);
      if (gameNumber < 1 || gameNumber > 16) continue;

      const rawStatus = cells[1] ?? "";
      const rawScore = cells[3] ?? "";
      const score = parseTelesportScore(rawScore);
      const outcomeText = [...cells.slice(5)]
        .reverse()
        .find((value) => /^(1|X|2)$/.test(value.trim()));
      const outcome =
        outcomeText === "1" || outcomeText === "X" || outcomeText === "2"
          ? outcomeText
          : null;

      games.push({
        gameNumber,
        status: canonicalTelesportGameStatus(rawStatus, score != null),
        homeScore: score?.home ?? null,
        awayScore: score?.away ?? null,
        outcome,
        rawStatus,
        rawScore,
      });
    }
  }

  games.sort((a, b) => a.gameNumber - b.gameNumber);
  if (games.length !== 16) {
    throw new Error(
      `Telesport Winner 16 state parser expected 16 games; got ${games.length}.`,
    );
  }

  for (let index = 0; index < 16; index += 1) {
    if (games[index].gameNumber !== index + 1) {
      throw new Error("Telesport Winner 16 state game numbers must be exactly 1..16.");
    }
  }

  return { externalRoundNumber, games };
}

export function parseTelesportWinner16Html(
  html: string,
  now = new Date(),
): Omit<
  TotoRoundDiscovery,
  "source" | "sourceUrl" | "sourceVersion" | "fetchedAt"
> {
  const sectionMatch = html.match(
    /<h2\b[^>]*>\s*ווינר\s*16\s*-\s*מספר\s*מחזור\s*:\s*(\d+)\s*<\/h2>([\s\S]*?)(?=<h2\b|$)/i,
  );

  if (!sectionMatch) {
    const modern = parseModernTelesportWinner16Html(html, now);
    if (modern) return modern;
    throw new Error("Telesport Winner 16 section was not found.");
  }

  const externalRoundNumber = sectionMatch[1];
  const section = sectionMatch[2];
  const games: DiscoveredRoundGame[] = [];

  const competitionPattern =
    /<h3\b[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<table\b[^>]*>([\s\S]*?)<\/table>/gi;

  let competitionMatch: RegExpExecArray | null;
  while ((competitionMatch = competitionPattern.exec(section)) !== null) {
    const competition = normalizeTelesportCompetition(
      textFromHtml(competitionMatch[1]),
    );
    const table = competitionMatch[2];
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowPattern.exec(table)) !== null) {
      const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
        .map((match) => textFromHtml(match[1]));

      if (cells.length < 5) continue;

      const numberMatch = cells[0].match(/^(\d{1,2})\.?$/);
      if (!numberMatch) continue;

      const gameNumber = Number(numberMatch[1]);
      if (gameNumber < 1 || gameNumber > 16) continue;

      const rawKickoff = cells[1];
      const homeTeam = cells[2];
      const awayTeam = cells[4];

      if (!homeTeam || !awayTeam) {
        throw new Error(
          `Telesport game ${gameNumber} is missing a team name.`,
        );
      }

      games.push({
        gameNumber,
        rawKickoff,
        kickoffAt: parseKickoff(rawKickoff, now),
        homeTeam,
        awayTeam,
        competition,
      });
    }
  }

  games.sort((a, b) => a.gameNumber - b.gameNumber);

  if (games.length !== 16) {
    throw new Error(
      `Telesport Winner 16 parser expected 16 games; got ${games.length}.`,
    );
  }

  for (let index = 0; index < 16; index += 1) {
    if (games[index].gameNumber !== index + 1) {
      throw new Error("Telesport Winner 16 game numbers must be exactly 1..16.");
    }
  }

  return {
    externalRoundNumber,
    games,
    completeKickoffs: games.every((game) => game.kickoffAt !== null),
  };
}

export class TelesportWinner16Provider implements TotoRoundProvider {
  constructor(
    private readonly options: {
      url?: string;
      fetch?: FetchLike;
      now?: () => Date;
    } = {},
  ) {}

  async getCurrentState(): Promise<TelesportWinner16State> {
    const url = this.options.url ?? DEFAULT_URL;
    const fetchImpl = this.options.fetch ?? fetch;
    const fetchedAt = (this.options.now?.() ?? new Date()).toISOString();

    const response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Kapiloto/0.1 Winner16 state sync",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(
        `Telesport Winner 16 state fetch failed with HTTP ${response.status}.`,
      );
    }

    const html = await response.text();
    const parsed = parseTelesportWinner16StateHtml(html);
    const fingerprint = createHash("sha256").update(html).digest("hex");

    return {
      ...parsed,
      sourceVersion: `sha256:${fingerprint}`,
      fetchedAt,
    };
  }

  async discoverCurrent(): Promise<TotoRoundDiscovery> {
    const url = this.options.url ?? DEFAULT_URL;
    const fetchImpl = this.options.fetch ?? fetch;
    const fetchedAt = (this.options.now?.() ?? new Date()).toISOString();

    const response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Kapiloto/0.1 Winner16 discovery",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(
        `Telesport Winner 16 fetch failed with HTTP ${response.status}.`,
      );
    }

    const html = await response.text();
    const parsed = parseTelesportWinner16Html(
      html,
      this.options.now?.() ?? new Date(),
    );
    const fingerprint = createHash("sha256").update(html).digest("hex");

    return {
      source: "telesport-winner16",
      sourceUrl: url,
      sourceVersion: `sha256:${fingerprint}`,
      fetchedAt,
      ...parsed,
    };
  }
}
