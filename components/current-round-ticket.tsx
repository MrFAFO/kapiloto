"use client";

import { useMemo, useState } from "react";
import {
  OUTCOMES,
  outcomesToPick,
  pickToOutcomes,
  type Outcome,
  type Pick,
} from "@/lib/toto";

type Fixture = {
  number: number;
  home: string;
  away: string;
  day: string;
  time: string;
};

const fixtures: Fixture[] = [
  { number: 1, home: 'בית"ר ירושלים', away: 'מכבי ת"א', day: "שני", time: "20:30" },
  { number: 2, home: "מכבי נתניה", away: "קריית שמונה", day: "שבת", time: "19:00" },
  { number: 3, home: "בני סכנין", away: 'הפועל פ"ת', day: "שבת", time: "18:00" },
  { number: 4, home: "הפועל חיפה", away: 'הפועל ר"ג', day: "שבת", time: "18:00" },
  { number: 5, home: "בני ריינה", away: 'ראשל"צ', day: "שני", time: "19:00" },
  { number: 6, home: "ברנטפורד", away: "ליברפול", day: "שבת", time: "18:30" },
  { number: 7, home: "בורנמות׳", away: "סנדרלנד", day: "ראשון", time: "16:00" },
  { number: 8, home: "לידס", away: "מנצ׳סטר יונייטד", day: "ראשון", time: "18:30" },
  { number: 9, home: "סלטה ויגו", away: "אלאבס", day: "ראשון", time: "17:15" },
  { number: 10, home: "מלאגה", away: "ריאל סוסיאדד", day: "ראשון", time: "19:30" },
  { number: 11, home: "מונזה", away: "קליארי", day: "שני", time: "21:45" },
  { number: 12, home: "אלברסברג", away: "אוגסבורג", day: "שבת", time: "16:30" },
  { number: 13, home: "שאלקה 04", away: "מיינץ", day: "שבת", time: "16:30" },
  { number: 14, home: "מנשנגלדבאך", away: "הופנהיים", day: "ראשון", time: "18:30" },
  { number: 15, home: "לה האבר", away: "אוקזר", day: "ראשון", time: "18:00" },
  { number: 16, home: "פאריס FC", away: "ראן", day: "ראשון", time: "21:45" },
];

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
  12: "12",
  13: "2",
  14: "12",
  15: "1",
  16: "12",
};

const MAX_DOUBLES = 7;

function FixtureRow({
  fixture,
  pick,
  onOutcomeClick,
  onConsult,
}: {
  fixture: Fixture;
  pick: Pick;
  onOutcomeClick: (outcome: Outcome) => void;
  onConsult: () => void;
}) {
  const selected = pickToOutcomes(pick);

  return (
    <article className="rounded-2xl border border-[var(--border)] bg-white p-3 shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
      <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-[var(--muted)]">
        <span>{fixture.day} · {fixture.time}</span>
        <span>משחק {fixture.number}</span>
      </div>

      <div className="mb-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onConsult}
          className="shrink-0 rounded-full bg-[var(--kapiloto-soft)] px-3 py-1.5 text-[11px] font-bold text-[var(--kapiloto)]"
        >
          התייעץ עם קפילוטו
        </button>
        <div className="min-w-0 text-right text-[14px] font-bold">
          {fixture.home} <span className="text-[var(--muted)]">—</span> {fixture.away}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2" dir="ltr">
        {["2", "X", "1"].map((outcome) => {
          const value = outcome as Outcome;
          const active = selected.includes(value);

          return (
            <button
              key={value}
              type="button"
              onClick={() => onOutcomeClick(value)}
              aria-pressed={active}
              className={[
                "h-10 rounded-xl border text-sm font-bold transition",
                active
                  ? "border-[var(--brand)] bg-[var(--brand)] text-white"
                  : "border-[var(--border)] bg-[#f6f8fc] text-[var(--text)]",
              ].join(" ")}
            >
              {value}
            </button>
          );
        })}
      </div>
    </article>
  );
}

export function CurrentRoundTicket() {
  const [picks, setPicks] = useState<Record<number, Pick>>(initialPicks);
  const [consulting, setConsulting] = useState<Fixture | null>(null);

  const doublesUsed = useMemo(
    () =>
      Object.values(picks).filter((pick) => pickToOutcomes(pick).length === 2)
        .length,
    [picks],
  );

  function toggleOutcome(gameNumber: number, outcome: Outcome) {
    setPicks((current) => {
      const currentOutcomes = pickToOutcomes(current[gameNumber]);
      const isSelected = currentOutcomes.includes(outcome);

      let nextOutcomes: Outcome[];

      if (isSelected) {
        if (currentOutcomes.length === 1) return current;
        nextOutcomes = currentOutcomes.filter((value) => value !== outcome);
      } else if (currentOutcomes.length === 2) {
        nextOutcomes = [outcome];
      } else {
        const doublesNow = Object.values(current).filter(
          (pick) => pickToOutcomes(pick).length === 2,
        ).length;

        if (doublesNow >= MAX_DOUBLES) return current;
        nextOutcomes = [...currentOutcomes, outcome];
      }

      return {
        ...current,
        [gameNumber]: outcomesToPick(nextOutcomes),
      };
    });
  }

  return (
    <>
      <main className="mx-auto min-h-dvh w-full max-w-[430px] bg-[var(--background)] pb-24">
        <header className="bg-white px-4 pb-4 pt-5">
          <div className="mb-4 flex items-center justify-between" dir="ltr">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-[var(--ink)] text-xs font-bold text-white">
              O
            </div>
            <div className="text-lg font-black tracking-tight">KAPILOTO</div>
          </div>

          <div className="flex items-center justify-between">
            <button className="h-10 w-10 rounded-xl border border-[var(--border)] bg-[#f8f9fc] text-xl">
              ›
            </button>
            <div className="text-center">
              <h1 className="text-xl font-black">מחזור 264101</h1>
              <p className="mt-0.5 text-xs text-[var(--muted)]">17–19 באוקטובר 2026</p>
            </div>
            <button className="h-10 w-10 rounded-xl border border-[var(--border)] bg-[#f8f9fc] text-xl">
              ‹
            </button>
          </div>

          <div className="mt-4 flex items-center justify-between text-xs">
            <span className="font-medium text-[var(--warning)]">נסגר בעוד יום ו־6 שעות</span>
            <span className="font-medium text-[var(--muted)]">הקבוצה של אופק</span>
          </div>
        </header>

        <section className="flex items-center justify-between bg-[var(--ink)] px-5 py-3 text-white">
          <div className="flex items-baseline gap-1" dir="ltr">
            <strong className="text-xl">{doublesUsed}</strong>
            <span className="text-xs text-[#bdc6d9]">/ {MAX_DOUBLES} כפולות</span>
          </div>
          <div className="text-right">
            <div className="text-sm font-bold">הטופס שלי</div>
            <div className="text-[11px] text-[#bdc6d9]">16 מתוך 16 משחקים מולאו</div>
          </div>
        </section>

        <section className="space-y-2.5 px-3.5 py-3">
          {fixtures.map((fixture) => (
            <FixtureRow
              key={fixture.number}
              fixture={fixture}
              pick={picks[fixture.number]}
              onOutcomeClick={(outcome) => toggleOutcome(fixture.number, outcome)}
              onConsult={() => setConsulting(fixture)}
            />
          ))}
        </section>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 mx-auto flex h-20 max-w-[430px] items-center justify-around border-t border-[var(--border)] bg-white px-4">
        <button className="text-xs text-[var(--muted)]">סטטיסטיקות</button>
        <button className="text-xs text-[var(--muted)]">קבוצה</button>
        <button className="rounded-2xl bg-[var(--brand-soft)] px-8 py-3 text-xs font-bold text-[var(--brand)]">
          טופס
        </button>
      </nav>

      {consulting ? (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/35"
          role="dialog"
          aria-modal="true"
          aria-label="ייעוץ קפילוטו"
          onClick={() => setConsulting(null)}
        >
          <section
            className="w-full max-w-[430px] rounded-t-[28px] bg-white p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-[#d6dbe6]" />
            <div className="mb-3 flex items-start justify-between gap-4">
              <button
                type="button"
                className="text-sm text-[var(--muted)]"
                onClick={() => setConsulting(null)}
              >
                סגור
              </button>
              <div className="text-right">
                <div className="text-xs font-bold text-[var(--kapiloto)]">KAPILOTO</div>
                <h2 className="mt-1 font-black">
                  {consulting.home} — {consulting.away}
                </h2>
              </div>
            </div>

            <div className="rounded-2xl bg-[var(--kapiloto-soft)] p-4">
              <div className="flex items-center justify-between">
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-[var(--kapiloto)]">
                  ביטחון בינוני–גבוה
                </span>
                <strong className="text-lg">המלצה: X2</strong>
              </div>
              <p className="mt-3 text-sm leading-6 text-[#31384a]">
                זהו תוכן דמה ל־MVP. בגרסה המחוברת קפילוטו יבצע מחקר עדכני על
                כושר, בית/חוץ, פציעות והרחקות, עומס משחקים, מודלים, אנליסטים
                ויחסי שוק לפני הצגת ההמלצה.
              </p>
              <div className="mt-3 text-xs text-[var(--muted)]">
                הניתוח האמיתי יציג גם זמן עדכון ומקורות.
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
