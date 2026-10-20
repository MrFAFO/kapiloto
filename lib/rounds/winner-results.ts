import { randomUUID } from "node:crypto";

const DEFAULT_RESULTS_URL =
  "https://www.winner.co.il/api/v2/publicapi/GetResults";

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type UnknownRecord = Record<string, unknown>;

export type WinnerOfficialResultEvent = {
  sportId: number;
  date: string;
  time: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  noScoreLabel: string | null;
};

export type WinnerOfficialResultsSnapshot = {
  sourceUrl: string;
  fetchedAt: string;
  startDate: string;
  endDate: string;
  events: WinnerOfficialResultEvent[];
};

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function integerOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) ? parsed : null;
}

function requiredText(
  row: UnknownRecord,
  key: string,
  index: number,
): string {
  const value = cleanText(row[key]);
  if (!value) {
    throw new Error(
      `Winner official result event ${index} is missing ${key}.`,
    );
  }
  return value;
}

export function buildWinnerResultsRequestBody(
  startDate: string,
  endDate: string,
): {
  startDate: string;
  endDate: string;
  sports: never[];
  leagues: never[];
} {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(startDate) || !datePattern.test(endDate)) {
    throw new Error("Winner results dates must use YYYY-MM-DD.");
  }
  if (startDate > endDate) {
    throw new Error("Winner results startDate must not be after endDate.");
  }

  return {
    startDate: `${startDate}T00:00:00+02:00`,
    endDate: `${endDate}T23:59:59+02:00`,
    sports: [],
    leagues: [],
  };
}

export function parseWinnerResultsResponse(
  payload: unknown,
): WinnerOfficialResultEvent[] {
  if (!isRecord(payload) || !isRecord(payload.results)) {
    throw new Error("Winner official results response is missing results.");
  }

  const events = payload.results.events;
  if (!Array.isArray(events)) {
    throw new Error("Winner official results response is missing events.");
  }

  return events.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(
        `Winner official result event ${index} is not an object.`,
      );
    }

    const sportId = integerOrNull(value.sportid);
    if (sportId == null) {
      throw new Error(
        `Winner official result event ${index} is missing sportid.`,
      );
    }

    const noScoreLabel = cleanText(value.noScoreLabel) || null;
    const homeScore = noScoreLabel ? null : integerOrNull(value.scoreA);
    const awayScore = noScoreLabel ? null : integerOrNull(value.scoreB);

    if (
      !noScoreLabel &&
      (homeScore == null || awayScore == null)
    ) {
      throw new Error(
        `Winner official result event ${index} has an invalid score.`,
      );
    }

    return {
      sportId,
      date: requiredText(value, "date", index),
      time: cleanText(value.time),
      league: requiredText(value, "league", index),
      homeTeam: requiredText(value, "teamA", index),
      awayTeam: requiredText(value, "teamB", index),
      homeScore,
      awayScore,
      noScoreLabel,
    };
  });
}

export class WinnerOfficialResultsClient {
  constructor(
    private readonly options: {
      url?: string;
      fetch?: FetchLike;
      now?: () => Date;
    } = {},
  ) {}

  async getResults(
    startDate: string,
    endDate: string,
  ): Promise<WinnerOfficialResultsSnapshot> {
    const url = this.options.url ?? DEFAULT_RESULTS_URL;
    const fetchImpl = this.options.fetch ?? fetch;
    const fetchedAt = (this.options.now?.() ?? new Date()).toISOString();

    const response = await fetchImpl(url, {
      method: "POST",
      cache: "no-store",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://www.winner.co.il",
        referer: "https://www.winner.co.il/",
        "user-agent": "Kapiloto/0.1 Winner official results verification",
        requestid: randomUUID().replace(/-/g, ""),
        deviceid: randomUUID().replace(/-/g, ""),
      },
      body: JSON.stringify(
        buildWinnerResultsRequestBody(startDate, endDate),
      ),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      throw new Error(
        `Winner official results fetch failed with HTTP ${response.status}.`,
      );
    }

    const payload = (await response.json()) as unknown;
    return {
      sourceUrl: url,
      fetchedAt,
      startDate,
      endDate,
      events: parseWinnerResultsResponse(payload),
    };
  }
}
