import type { Pick } from "@/lib/toto";

import type { CurrentRoundView } from "@/components/current-round-ticket";

import type { CurrentRoundData } from "./current-round";

const TIME_ZONE = "Asia/Jerusalem";

const hebrewMonth = new Intl.DateTimeFormat("he-IL", {
  month: "long",
  timeZone: TIME_ZONE,
});

const dayNumber = new Intl.DateTimeFormat("he-IL", {
  day: "numeric",
  timeZone: TIME_ZONE,
});

const weekday = new Intl.DateTimeFormat("he-IL", {
  weekday: "long",
  timeZone: TIME_ZONE,
});

const clock = new Intl.DateTimeFormat("he-IL", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: TIME_ZONE,
});

const fullDateTime = new Intl.DateTimeFormat("he-IL", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: TIME_ZONE,
});

function cleanWeekday(value: string): string {
  return value
    .replace(/^יום\s+/, "")
    .replace("ראשון", "א׳")
    .replace("שני", "ב׳")
    .replace("שלישי", "ג׳")
    .replace("רביעי", "ד׳")
    .replace("חמישי", "ה׳")
    .replace("שישי", "ו׳");
}

function statusLabel(status: string): string {
  switch (status) {
    case "live":
      return "חי";
    case "halftime":
      return "מחצית";
    case "finished":
      return "הסתיים";
    case "postponed":
      return "נדחה";
    case "cancelled":
      return "בוטל";
    case "suspended":
      return "הופסק";
    case "under_review":
      return "בבדיקה";
    default:
      return "טרם שוחק";
  }
}

function dateLabel(round: CurrentRoundData): string {
  const dates = round.games
    .map((game) => new Date(game.kickoffAt))
    .sort((a, b) => a.getTime() - b.getTime());

  const first = dates[0];
  const last = dates[dates.length - 1];
  const firstDay = dayNumber.format(first);
  const lastDay = dayNumber.format(last);
  const firstMonth = hebrewMonth.format(first);
  const lastMonth = hebrewMonth.format(last);

  if (firstMonth === lastMonth) {
    return firstDay === lastDay
      ? `${firstDay} ב${firstMonth}`
      : `${firstDay}–${lastDay} ב${firstMonth}`;
  }

  return `${firstDay} ב${firstMonth} – ${lastDay} ב${lastMonth}`;
}

export function buildCurrentRoundView(
  round: CurrentRoundData,
  options: {
    maxDoubles: number;
    picks?: Array<{ gameNumber: number; pick: Pick }>;
    ticketRevision?: number;
    ticketState?: "draft" | "submitted" | "locked" | null;
    submittedAt?: string | null;
  },
): CurrentRoundView {
  const initialPicks: Partial<Record<number, Pick>> = {};
  for (const item of options.picks ?? []) {
    initialPicks[item.gameNumber] = item.pick;
  }

  return {
    roundNumber: round.externalRoundNumber,
    dateLabel: dateLabel(round),
    lockLabel: `נסגר · ${fullDateTime.format(new Date(round.lockAt))}`,
    maxDoubles: options.maxDoubles,
    initialPicks,
    ticket:
      options.ticketRevision == null
        ? undefined
        : {
            revision: options.ticketRevision,
            state: options.ticketState ?? null,
            submittedAt: options.submittedAt ?? null,
          },
    isPrototype: false,
    fixtures: round.games.map((game) => ({
      number: game.number,
      roundGameId: game.roundGameId,
      home: game.home,
      away: game.away,
      league: game.league,
      day: cleanWeekday(weekday.format(new Date(game.kickoffAt))),
      time: clock.format(new Date(game.kickoffAt)),
      statusLabel: statusLabel(game.status),
    })),
  };
}
