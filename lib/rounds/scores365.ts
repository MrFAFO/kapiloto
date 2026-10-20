import { createHash } from "node:crypto";

import { normalizeTeamName } from "@/lib/providers/match";

const DEFAULT_BASE_URL = "https://webws.365scores.com/web/games/";

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type UnknownRecord = Record<string, unknown>;

export type Scores365FinalResult = {
  eventId: string;
  date: string;
  startTime: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  outcome: "1" | "X" | "2";
};

export type Scores365FinalSnapshot = {
  sourceVersion: string;
  fetchedAt: string;
  date: string;
  results: Scores365FinalResult[];
};

export type Scores365FixtureIdentity = {
  kickoffAt: string;
  homeNames: string[];
  awayNames: string[];
};

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : "";
}

function integerScore(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function israelDateKey(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid fixture kickoff: ${isoTimestamp}`);
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${map.year}-${map.month}-${map.day}`;
}

function scores365Date(dateKey: string): string {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`365Scores date must use YYYY-MM-DD: ${dateKey}`);
  }
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export function parseScores365FinalResults(
  payload: unknown,
  date: string,
): Scores365FinalResult[] {
  if (!isRecord(payload) || !Array.isArray(payload.games)) {
    throw new Error("365Scores response is missing games.");
  }

  const results: Scores365FinalResult[] = [];

  for (const raw of payload.games) {
    if (!isRecord(raw)) continue;

    const statusText = cleanText(raw.statusText);
    const isFinal =
      Number(raw.statusGroup) === 4 ||
      /final|ended|הסתיים/i.test(statusText);
    if (!isFinal) continue;

    const home = isRecord(raw.homeCompetitor)
      ? raw.homeCompetitor
      : null;
    const away = isRecord(raw.awayCompetitor)
      ? raw.awayCompetitor
      : null;
    if (!home || !away) continue;

    const homeTeam = cleanText(home.name);
    const awayTeam = cleanText(away.name);
    const homeScore = integerScore(home.score);
    const awayScore = integerScore(away.score);
    const eventId =
      typeof raw.id === "number" || typeof raw.id === "string"
        ? String(raw.id)
        : "";

    if (
      !eventId ||
      !homeTeam ||
      !awayTeam ||
      homeScore == null ||
      awayScore == null
    ) {
      continue;
    }

    results.push({
      eventId,
      date,
      startTime: cleanText(raw.startTime) || null,
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      outcome:
        homeScore === awayScore ? "X" : homeScore > awayScore ? "1" : "2",
    });
  }

  return results;
}

function normalizedNames(values: string[]): Set<string> {
  return new Set(
    values
      .map((value) => normalizeTeamName(value))
      .filter(Boolean),
  );
}

export function matchScores365FinalResult(
  fixture: Scores365FixtureIdentity,
  results: Scores365FinalResult[],
): Scores365FinalResult | null {
  const date = israelDateKey(fixture.kickoffAt);
  const home = normalizedNames(fixture.homeNames);
  const away = normalizedNames(fixture.awayNames);
  const kickoffMs = Date.parse(fixture.kickoffAt);

  const matches = results.filter((result) => {
    if (result.date !== date) return false;

    const resultHome = normalizeTeamName(result.homeTeam);
    const resultAway = normalizeTeamName(result.awayTeam);
    if (!home.has(resultHome) || !away.has(resultAway)) return false;

    if (result.startTime) {
      const providerKickoffMs = Date.parse(result.startTime);
      if (
        Number.isFinite(kickoffMs) &&
        Number.isFinite(providerKickoffMs) &&
        Math.abs(providerKickoffMs - kickoffMs) > 6 * 60 * 60_000
      ) {
        return false;
      }
    }

    return true;
  });

  return matches.length === 1 ? matches[0] : null;
}

export class Scores365ResultsProvider {
  constructor(
    private readonly options: {
      url?: string;
      fetch?: FetchLike;
      now?: () => Date;
    } = {},
  ) {}

  async getFinalResultsForDate(
    date: string,
  ): Promise<Scores365FinalSnapshot> {
    const fetchImpl = this.options.fetch ?? fetch;
    const fetchedAt = (this.options.now?.() ?? new Date()).toISOString();
    const params = new URLSearchParams({
      langId: "2",
      timezoneName: "Asia/Jerusalem",
      userCountryId: "6",
      appTypeId: "5",
      sports: "1",
      startDate: scores365Date(date),
      endDate: scores365Date(date),
    });
    const url = `${this.options.url ?? DEFAULT_BASE_URL}?${params}`;

    const response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        accept: "application/json",
        origin: "https://www.365scores.com",
        referer:
          "https://www.365scores.com/he/football/match-results",
        "user-agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(
        `365Scores results fetch failed with HTTP ${response.status}.`,
      );
    }

    const raw = await response.text();
    const payload = JSON.parse(raw) as unknown;

    return {
      sourceVersion: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      fetchedAt,
      date,
      results: parseScores365FinalResults(payload, date),
    };
  }
}
