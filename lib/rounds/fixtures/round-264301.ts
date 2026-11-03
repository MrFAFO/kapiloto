import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseScores365FinalResults, type Scores365FinalResult } from "../scores365";

// Test-only reference data for Winner 16 round 264301 (all games finished),
// captured 2026-11-03 from Telesport and 365Scores. See D-062.

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "lib", "rounds", "fixtures", name), "utf8");
}

export const TELESPORT_264301_MODERN_HTML = fixture("telesport-winner16-264301-modern.html");
export const TELESPORT_264301_CLASSIC_HTML = fixture("telesport-winner16-264301-classic.html");

// The 16 round events plus same-day look-alike decoys.
export const SCORES365_264301_FINALS: Scores365FinalResult[] = Object.entries(
  JSON.parse(fixture("scores365-264301-finals.json")) as Record<string, unknown>,
)
  .filter(([date]) => date !== "_provenance")
  .flatMap(([date, snapshot]) => parseScores365FinalResults(snapshot, date));

// Per game: Kapiloto team names as live sync loads them (the Telesport
// canonical name, plus the stored 365Scores alias from round 264201 where one
// exists), the 365Scores event and its regular-time score, and the 1/X/2
// marker Telesport shows.
export const ROUND_264301: Array<{
  game: number;
  kickoffAt: string;
  homeNames: string[];
  awayNames: string[];
  eventId: string;
  score: [home: number, away: number];
  outcome: "1" | "X" | "2";
}> = [
  { game: 1, kickoffAt: "2026-11-02T18:30:00.000Z", homeNames: ["הפועל תל אביב"], awayNames: ["מכבי חיפה"], eventId: "4739299", score: [2, 1], outcome: "1" },
  { game: 2, kickoffAt: "2026-10-31T17:30:00.000Z", homeNames: ["מכבי נתניה"], awayNames: ["הפועל ירושלים"], eventId: "4739301", score: [1, 1], outcome: "X" },
  { game: 3, kickoffAt: "2026-10-31T16:00:00.000Z", homeNames: ["בני סכנין"], awayNames: ["עירוני טבריה"], eventId: "4739298", score: [1, 1], outcome: "X" },
  { game: 4, kickoffAt: "2026-10-31T15:30:00.000Z", homeNames: ["הפועל חיפה"], awayNames: ["הפועל פתח תקווה"], eventId: "4739296", score: [2, 1], outcome: "1" },
  { game: 5, kickoffAt: "2026-11-02T17:00:00.000Z", homeNames: ["מ.ס אשדוד"], awayNames: ["בני יהודה"], eventId: "4739086", score: [3, 1], outcome: "1" },
  { game: 6, kickoffAt: "2026-11-02T17:00:00.000Z", homeNames: ["מכבי יפו"], awayNames: ["הפועל כפר סבא"], eventId: "4739083", score: [0, 3], outcome: "2" },
  { game: 7, kickoffAt: "2026-11-01T16:30:00.000Z", homeNames: ["ליברפול"], awayNames: ["ארסנל"], eventId: "4742014", score: [0, 1], outcome: "2" },
  { game: 8, kickoffAt: "2026-10-31T15:00:00.000Z", homeNames: ["קובנטרי"], awayNames: ["סנדרלנד"], eventId: "4742016", score: [3, 1], outcome: "1" },
  { game: 9, kickoffAt: "2026-10-31T15:00:00.000Z", homeNames: ["האל", "האל סיטי"], awayNames: ["איפסוויץ'"], eventId: "4742015", score: [2, 2], outcome: "X" },
  { game: 10, kickoffAt: "2026-10-31T15:00:00.000Z", homeNames: ["בורנמות'"], awayNames: ["לידס", "לידס יונייטד"], eventId: "4742020", score: [2, 0], outcome: "1" },
  { game: 11, kickoffAt: "2026-10-31T15:15:00.000Z", homeNames: ["ראיו ואייקאנו"], awayNames: ["סלטה ויגו"], eventId: "4750803", score: [3, 0], outcome: "1" },
  { game: 12, kickoffAt: "2026-11-01T13:00:00.000Z", homeNames: ["חטאפה"], awayNames: ["סביליה"], eventId: "4750806", score: [3, 1], outcome: "1" },
  { game: 13, kickoffAt: "2026-11-01T17:30:00.000Z", homeNames: ["אלצ'ה"], awayNames: ["ולנסיה"], eventId: "4750808", score: [0, 1], outcome: "2" },
  { game: 14, kickoffAt: "2026-11-01T20:00:00.000Z", homeNames: ["אתלטיק בילבאו"], awayNames: ["ריאל סוסיאדד"], eventId: "4750811", score: [2, 1], outcome: "1" },
  { game: 15, kickoffAt: "2026-10-31T19:45:00.000Z", homeNames: ["מילאן"], awayNames: ["אינטר"], eventId: "4732643", score: [3, 1], outcome: "1" },
  { game: 16, kickoffAt: "2026-11-01T19:45:00.000Z", homeNames: ["יובנטוס"], awayNames: ["נאפולי"], eventId: "4732646", score: [2, 0], outcome: "1" },
];
