import { createHash } from "node:crypto";

import type {
  DiscoveredCompetition,
  DiscoveredRoundGame,
  TotoRoundDiscovery,
  TotoRoundProvider,
} from "./toto-source";

const DEFAULT_URL = "https://www.telesport.co.il/toto.aspx";
const ISRAEL_TIME_ZONE = "Asia/Jerusalem";

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

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
