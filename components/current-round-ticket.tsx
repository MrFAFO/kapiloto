"use client";

import { useEffect, useMemo, useState } from "react";

import {
  KapilotoDoubleContextNote,
  KapilotoPanel,
  KapilotoToggleBar,
  useKapilotoPanel,
} from "@/components/kapiloto-panel";
import { KapilotoWordmark } from "@/components/kapiloto-wordmark";
import { createKapilotoClient } from "@/lib/kapiloto/client";
import {
  createKapilotoDemoFetch,
  type KapilotoDemoScenario,
} from "@/lib/kapiloto/demo-fetch";
import { KapilotoPanelController } from "@/lib/kapiloto/panel-controller";
import {
  pickToOutcomes,
  toggleOutcomeInPicks,
  type Outcome,
  type Pick,
} from "@/lib/toto";

/*
 * Current Round — Dark Stadium screens 10.1 / 10.2 (Figma
 * 2Pp5ae9bgqhTfwcU2JcIlK, page "01 — Mobile App · Dark Stadium").
 */

type Fixture = {
  number: number;
  /** Prototype placeholder until rounds are loaded from Supabase. */
  roundGameId: string;
  home: string;
  away: string;
  league: string;
  day: string;
  time: string;
};

const prototypeGameId = (number: number) =>
  `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;

const fixtures: Fixture[] = [
  { number: 1, home: "בית״ר ירושלים", away: "מכבי ת״א", league: "ליגת העל", day: "שני", time: "20:30" },
  { number: 2, home: "מכבי נתניה", away: "קריית שמונה", league: "ליגת העל", day: "שבת", time: "19:00" },
  { number: 3, home: "בני סכנין", away: "הפועל פ״ת", league: "ליגת העל", day: "שבת", time: "18:00" },
  { number: 4, home: "הפועל חיפה", away: "הפועל ר״ג", league: "ליגת העל", day: "שבת", time: "18:00" },
  { number: 5, home: "בני ריינה", away: "ראשל״צ", league: "ליגת העל", day: "שני", time: "19:00" },
  { number: 6, home: "ברנטפורד", away: "ליברפול", league: "פרמייר ליג", day: "שבת", time: "18:30" },
  { number: 7, home: "בורנמות׳", away: "סנדרלנד", league: "פרמייר ליג", day: "ראשון", time: "16:00" },
  { number: 8, home: "לידס", away: "מנצ׳סטר יונייטד", league: "פרמייר ליג", day: "ראשון", time: "18:30" },
  { number: 9, home: "סלטה ויגו", away: "אלאבס", league: "לה ליגה", day: "ראשון", time: "17:15" },
  { number: 10, home: "מלאגה", away: "ריאל סוסיאדד", league: "לה ליגה", day: "ראשון", time: "19:30" },
  { number: 11, home: "מונזה", away: "קליארי", league: "סרייה A", day: "שני", time: "21:45" },
  { number: 12, home: "אלברסברג", away: "אוגסבורג", league: "בונדסליגה", day: "שבת", time: "16:30" },
  { number: 13, home: "שאלקה 04", away: "מיינץ", league: "בונדסליגה", day: "שבת", time: "16:30" },
  { number: 14, home: "מנשנגלדבאך", away: "הופנהיים", league: "בונדסליגה", day: "ראשון", time: "18:30" },
  { number: 15, home: "לה האבר", away: "אוקזר", league: "ליג 1", day: "ראשון", time: "18:00" },
  { number: 16, home: "פאריס FC", away: "ראן", league: "ליג 1", day: "ראשון", time: "21:45" },
].map((fixture) => ({ ...fixture, roundGameId: prototypeGameId(fixture.number) }));

const initialPicks: Record<number, Pick> = {
  1: "2",
  2: "1",
  3: "1X",
  4: "1",
  5: "2",
  6: "X2",
  7: "1",
  8: "1X",
  9: "1",
  10: "2",
  11: "12",
  12: "1",
  13: "2",
  14: "12",
  15: "1",
  16: "X",
};

const MAX_DOUBLES = 7;
const PICK_ORDER: Outcome[] = ["2", "X", "1"];

export type CurrentRoundKapilotoConfig = {
  roundId: string;
  groupId: string;
  /** Set only in local development; production always uses the real API. */
  demoScenario: KapilotoDemoScenario | null;
};

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Chip({
  children,
  className = "bg-[var(--elevated)] text-[var(--muted)]",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full px-[9px] py-[5px] text-[9px] font-bold leading-none ${className}`}
    >
      {children}
    </span>
  );
}

function FixtureCard({
  fixture,
  pick,
  onOutcomeClick,
  controller,
  now,
  demo,
}: {
  fixture: Fixture;
  pick: Pick;
  onOutcomeClick: (outcome: Outcome) => void;
  controller: KapilotoPanelController;
  now: number;
  demo: boolean;
}) {
  const selected = pickToOutcomes(pick);
  const isDouble = selected.length === 2;
  const view = useKapilotoPanel(controller);
  const panelId = `kapiloto-panel-${fixture.number}`;
  const expanded = view.kind !== "closed" && view.kind !== "collapsed";

  return (
    <>
      <article className="flex w-full flex-col gap-2 rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="flex h-[26px] items-center justify-between">
          <span className="text-[10px] font-bold text-[var(--muted)]">
            משחק {fixture.number}
          </span>
          <div className="flex items-center gap-1.5">
            <Chip>
              {fixture.day} · {fixture.time}
            </Chip>
            {isDouble ? <Chip className="bg-[var(--kapiloto)] text-white">כפולה</Chip> : null}
          </div>
        </div>

        <div className="flex flex-col gap-0.5">
          <p className="text-[13px] font-bold text-[var(--text)]">
            {fixture.home} — {fixture.away}
          </p>
          <p className="text-[8px] text-[var(--muted)]">
            {fixture.league} · טרם שוחק
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3" dir="ltr">
          {PICK_ORDER.map((value) => {
            const active = selected.includes(value);
            return (
              <button
                key={value}
                type="button"
                onClick={() => onOutcomeClick(value)}
                aria-pressed={active}
                aria-label={`${value}${active ? (isDouble ? " · חלק מכפולה" : " · נבחר") : ""}`}
                className={[
                  "h-[46px] rounded-[13px] border text-[14px] font-bold transition-colors",
                  active
                    ? isDouble
                      ? "border-[var(--kapiloto)] bg-[var(--kapiloto)] text-white"
                      : "border-[var(--action)] bg-[var(--action)] text-white"
                    : "border-[var(--border)] bg-[var(--elevated)] text-[var(--muted)]",
                ].join(" ")}
              >
                {value}
              </button>
            );
          })}
        </div>

        <KapilotoToggleBar
          view={view}
          panelId={panelId}
          onToggle={() => controller.toggle()}
        />
        <KapilotoPanel
          view={view}
          panelId={panelId}
          now={now}
          demo={demo}
          onConsult={() => void controller.consult()}
          onRecheck={() => void controller.recheck()}
          onRetry={() => controller.retry()}
        />
      </article>
      {expanded ? <KapilotoDoubleContextNote /> : null}
    </>
  );
}

function createControllers(
  config: CurrentRoundKapilotoConfig,
): Map<number, KapilotoPanelController> {
  const client = config.demoScenario
    ? createKapilotoClient({
        fetch: createKapilotoDemoFetch({
          scenario: config.demoScenario,
          roundId: config.roundId,
          roundGameIds: fixtures.map((fixture) => fixture.roundGameId),
          maxDoubles: MAX_DOUBLES,
        }),
      })
    : createKapilotoClient();

  const controllers = new Map<number, KapilotoPanelController>();
  for (const fixture of fixtures) {
    controllers.set(
      fixture.number,
      new KapilotoPanelController(
        client,
        {
          roundId: config.roundId,
          groupId: config.groupId,
          roundGameId: fixture.roundGameId,
        },
        {
          onRoundRunPublished(runId) {
            for (const [number, other] of controllers) {
              if (number !== fixture.number) other.syncRoundRun(runId);
            }
          },
        },
      ),
    );
  }
  return controllers;
}

export function CurrentRoundTicket({
  kapiloto,
}: {
  kapiloto: CurrentRoundKapilotoConfig;
}) {
  const [picks, setPicks] = useState<Record<number, Pick>>(initialPicks);
  const [controllers] = useState(() => createControllers(kapiloto));
  const [profileOpen, setProfileOpen] = useState(false);
  const now = useNow(30_000);

  useEffect(
    () => () => {
      for (const controller of controllers.values()) controller.dispose();
    },
    [controllers],
  );

  const doublesUsed = useMemo(
    () =>
      Object.values(picks).filter((pick) => pickToOutcomes(pick).length === 2)
        .length,
    [picks],
  );

  function toggleOutcome(gameNumber: number, outcome: Outcome) {
    setPicks((current) =>
      toggleOutcomeInPicks(current, gameNumber, outcome, MAX_DOUBLES),
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-[var(--canvas)]">
      <header className="flex flex-col gap-2.5 bg-gradient-to-r from-[var(--header-from)] to-[var(--header-to)] px-[18px] pb-3 pt-[18px]">
        <div className="flex h-8 items-center justify-between">
          <KapilotoWordmark />
          <div className="relative">
            <button
              type="button"
              aria-label="פרופיל"
              aria-expanded={profileOpen}
              onClick={() => setProfileOpen((open) => !open)}
              className="inline-flex items-center justify-center rounded-full bg-[var(--elevated)] px-[9px] py-[5px] text-[9px] font-bold text-white"
            >
              O
            </button>
            {profileOpen ? (
              <div className="absolute left-0 top-[34px] z-30 w-[126px] rounded-xl border border-[var(--border)] bg-[var(--panel)] p-1.5 shadow-xl">
                <form action="/api/auth/logout" method="post">
                  <button
                    type="submit"
                    className="flex h-9 w-full items-center justify-center rounded-lg text-[10px] font-bold text-[var(--text)] hover:bg-[var(--elevated)]"
                  >
                    התנתק
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex h-[46px] items-center justify-between">
          <button
            type="button"
            className="rounded-full bg-[var(--elevated)] px-[9px] py-[5px] text-[9px] font-bold text-[var(--text)]"
          >
            ‹ קודם
          </button>
          <div className="flex flex-col items-center gap-px text-center">
            <h1 className="text-[21px] font-bold leading-tight text-white">מחזור 264101</h1>
            <p className="text-[9px] font-medium text-[var(--muted)]">17–19 באוקטובר</p>
          </div>
          <button
            type="button"
            disabled
            className="rounded-full bg-[var(--elevated)] px-[9px] py-[5px] text-[9px] font-bold text-[var(--muted-strong)]"
          >
            הבא ›
          </button>
        </div>

        <div className="flex h-7 items-center justify-between">
          <p className="text-[9px] font-medium text-[var(--muted)]">נסגר מחר · 16:24</p>
          <span
            className="inline-flex items-center rounded-full bg-[var(--kapiloto)] px-[9px] py-[5px] text-[9px] font-bold text-white"
            data-doubles-counter
          >
            כפולות · {doublesUsed} / {MAX_DOUBLES}
          </span>
        </div>
      </header>

      <section className="flex h-16 items-center justify-between bg-[var(--panel)] px-[18px]">
        <div className="flex flex-col items-start gap-0.5">
          <p className="text-[10px] font-medium text-[var(--text)]">ממלאים לבד</p>
          <p className="text-[8px] text-[var(--muted)]">קפילוטו עוזר בכל משחק</p>
        </div>
        <button
          type="button"
          aria-disabled
          title="דייגו יגיע בשלב הבא"
          className="flex h-10 w-[190px] items-center justify-center rounded-xl bg-[var(--diego-surface)] text-[10px] font-bold text-[var(--diego)]"
        >
          דייגו · מלא לי את כל הטופס
        </button>
      </section>

      <main className="flex flex-1 flex-col gap-2.5 px-[18px] pb-[96px] pt-3">
        {fixtures.map((fixture) => (
          <FixtureCard
            key={fixture.number}
            fixture={fixture}
            pick={picks[fixture.number]}
            onOutcomeClick={(outcome) => toggleOutcome(fixture.number, outcome)}
            controller={controllers.get(fixture.number)!}
            now={now}
            demo={kapiloto.demoScenario != null}
          />
        ))}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 mx-auto flex h-[72px] max-w-[430px] items-center justify-between bg-[var(--nav)] px-3 pb-3 pt-[9px]">
        <button
          type="button"
          aria-current="page"
          className="flex h-11 w-[82px] items-center justify-center rounded-xl bg-[var(--elevated)] text-[9px] font-bold text-[var(--kapiloto)]"
        >
          טופס
        </button>
        {["קבוצה", "סטטיסטיקות", "עוד"].map((label) => (
          <button
            key={label}
            type="button"
            className="flex h-11 w-[82px] items-center justify-center rounded-xl text-[9px] font-medium text-[var(--muted)]"
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
