"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

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
import { createTicketClient } from "@/lib/ticket-client";
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

export type CurrentRoundFixtureView = {
  number: number;
  roundGameId: string;
  fixtureId: string | null;
  home: string;
  away: string;
  league: string;
  day: string;
  time: string;
  statusLabel: string;
  scoreLabel?: string | null;
  settlementLabel?: string | null;
};

export type CurrentRoundView = {
  roundNumber: string;
  dateLabel: string;
  lockLabel: string;
  maxDoubles: number;
  fixtures: CurrentRoundFixtureView[];
  initialPicks?: Partial<Record<number, Pick>>;
  ticket?: {
    revision: number;
    state: "draft" | "submitted" | "locked" | null;
    submittedAt: string | null;
  };
  isPrototype?: boolean;
};

const prototypeGameId = (number: number) =>
  `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;

const prototypeFixtures: CurrentRoundFixtureView[] = [
  { number: 1, home: "בית״ר ירושלים", away: "מכבי ת״א", league: "ליגת העל", day: "שני", time: "20:30", statusLabel: "טרם שוחק" },
  { number: 2, home: "מכבי נתניה", away: "קריית שמונה", league: "ליגת העל", day: "שבת", time: "19:00", statusLabel: "טרם שוחק" },
  { number: 3, home: "בני סכנין", away: "הפועל פ״ת", league: "ליגת העל", day: "שבת", time: "18:00", statusLabel: "טרם שוחק" },
  { number: 4, home: "הפועל חיפה", away: "הפועל ר״ג", league: "ליגת העל", day: "שבת", time: "18:00", statusLabel: "טרם שוחק" },
  { number: 5, home: "בני ריינה", away: "ראשל״צ", league: "ליגת העל", day: "שני", time: "19:00", statusLabel: "טרם שוחק" },
  { number: 6, home: "ברנטפורד", away: "ליברפול", league: "פרמייר ליג", day: "שבת", time: "18:30", statusLabel: "טרם שוחק" },
  { number: 7, home: "בורנמות׳", away: "סנדרלנד", league: "פרמייר ליג", day: "ראשון", time: "16:00", statusLabel: "טרם שוחק" },
  { number: 8, home: "לידס", away: "מנצ׳סטר יונייטד", league: "פרמייר ליג", day: "ראשון", time: "18:30", statusLabel: "טרם שוחק" },
  { number: 9, home: "סלטה ויגו", away: "אלאבס", league: "לה ליגה", day: "ראשון", time: "17:15", statusLabel: "טרם שוחק" },
  { number: 10, home: "מלאגה", away: "ריאל סוסיאדד", league: "לה ליגה", day: "ראשון", time: "19:30", statusLabel: "טרם שוחק" },
  { number: 11, home: "מונזה", away: "קליארי", league: "סרייה A", day: "שני", time: "21:45", statusLabel: "טרם שוחק" },
  { number: 12, home: "אלברסברג", away: "אוגסבורג", league: "בונדסליגה", day: "שבת", time: "16:30", statusLabel: "טרם שוחק" },
  { number: 13, home: "שאלקה 04", away: "מיינץ", league: "בונדסליגה", day: "שבת", time: "16:30", statusLabel: "טרם שוחק" },
  { number: 14, home: "מנשנגלדבאך", away: "הופנהיים", league: "בונדסליגה", day: "ראשון", time: "18:30", statusLabel: "טרם שוחק" },
  { number: 15, home: "לה האבר", away: "אוקזר", league: "ליג 1", day: "ראשון", time: "18:00", statusLabel: "טרם שוחק" },
  { number: 16, home: "פאריס FC", away: "ראן", league: "ליג 1", day: "ראשון", time: "21:45", statusLabel: "טרם שוחק" },
].map((fixture) => ({
  ...fixture,
  roundGameId: prototypeGameId(fixture.number),
  fixtureId: null,
}));

const prototypePicks: Record<number, Pick> = {
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

export const PROTOTYPE_CURRENT_ROUND: CurrentRoundView = {
  roundNumber: "264101",
  dateLabel: "17–19 באוקטובר",
  lockLabel: "נסגר מחר · 16:24",
  maxDoubles: 7,
  fixtures: prototypeFixtures,
  initialPicks: prototypePicks,
  isPrototype: true,
};

const PICK_ORDER: Outcome[] = ["2", "X", "1"];

export type CurrentRoundKapilotoConfig = {
  roundId: string;
  groupId: string | null;
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

function DisabledKapilotoBar() {
  return (
    <div className="flex min-h-10 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--elevated)] px-3 text-center text-[9px] font-medium text-[var(--muted)]">
      יש לבחור או ליצור קבוצה כדי להתייעץ עם קפילוטו
    </div>
  );
}

function MatchAnalysisLink({ fixtureId }: { fixtureId: string | null }) {
  if (!fixtureId) return null;

  return (
    <Link
      href={`/matches/${fixtureId}`}
      className="inline-flex w-fit items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-2.5 py-1.5 text-[9px] font-bold text-[var(--kapiloto)] transition-colors hover:border-[var(--kapiloto)]"
    >
      ניתוח מלא
      <span aria-hidden="true">←</span>
    </Link>
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
  fixture: CurrentRoundFixtureView;
  pick: Pick | undefined;
  onOutcomeClick: (outcome: Outcome) => void;
  controller: KapilotoPanelController | null;
  now: number;
  demo: boolean;
}) {
  const selected = pick ? pickToOutcomes(pick) : [];
  const isDouble = selected.length === 2;

  if (!controller) {
    return (
      <article className="flex w-full flex-col gap-2 rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="flex h-[26px] items-center justify-between">
          <span className="text-[10px] font-bold text-[var(--muted)]">
            משחק {fixture.number}
          </span>
          <div className="flex items-center gap-1.5">
            <Chip>
              {fixture.day} · {fixture.time}
            </Chip>
            {isDouble ? (
              <Chip className="bg-[var(--kapiloto)] text-white">כפולה</Chip>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-0.5">
          <p className="text-[13px] font-bold text-[var(--text)]">
            {fixture.home}
            {fixture.scoreLabel ? ` ${fixture.scoreLabel} ` : " — "}
            {fixture.away}
          </p>
          <p className="text-[8px] text-[var(--muted)]">
            {fixture.league} · {fixture.statusLabel}
            {fixture.settlementLabel ? ` · ${fixture.settlementLabel}` : ""}
          </p>
        </div>

        <MatchAnalysisLink fixtureId={fixture.fixtureId} />

        <PickButtons
          selected={selected}
          isDouble={isDouble}
          onOutcomeClick={onOutcomeClick}
        />
        <DisabledKapilotoBar />
      </article>
    );
  }

  return (
    <FixtureCardWithKapiloto
      fixture={fixture}
      selected={selected}
      isDouble={isDouble}
      onOutcomeClick={onOutcomeClick}
      controller={controller}
      now={now}
      demo={demo}
    />
  );
}

function PickButtons({
  selected,
  isDouble,
  onOutcomeClick,
}: {
  selected: Outcome[];
  isDouble: boolean;
  onOutcomeClick: (outcome: Outcome) => void;
}) {
  return (
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
  );
}

function FixtureCardWithKapiloto({
  fixture,
  selected,
  isDouble,
  onOutcomeClick,
  controller,
  now,
  demo,
}: {
  fixture: CurrentRoundFixtureView;
  selected: Outcome[];
  isDouble: boolean;
  onOutcomeClick: (outcome: Outcome) => void;
  controller: KapilotoPanelController;
  now: number;
  demo: boolean;
}) {
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
            {isDouble ? (
              <Chip className="bg-[var(--kapiloto)] text-white">כפולה</Chip>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-0.5">
          <p className="text-[13px] font-bold text-[var(--text)]">
            {fixture.home}
            {fixture.scoreLabel ? ` ${fixture.scoreLabel} ` : " — "}
            {fixture.away}
          </p>
          <p className="text-[8px] text-[var(--muted)]">
            {fixture.league} · {fixture.statusLabel}
            {fixture.settlementLabel ? ` · ${fixture.settlementLabel}` : ""}
          </p>
        </div>

        <MatchAnalysisLink fixtureId={fixture.fixtureId} />

        <PickButtons
          selected={selected}
          isDouble={isDouble}
          onOutcomeClick={onOutcomeClick}
        />

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
  fixtures: CurrentRoundFixtureView[],
  maxDoubles: number,
): Map<number, KapilotoPanelController> {
  if (!config.groupId) return new Map();

  const client = config.demoScenario
    ? createKapilotoClient({
        fetch: createKapilotoDemoFetch({
          scenario: config.demoScenario,
          roundId: config.roundId,
          roundGameIds: fixtures.map((fixture) => fixture.roundGameId),
          maxDoubles,
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

function nextPicksAfterTap(
  current: Partial<Record<number, Pick>>,
  gameNumber: number,
  outcome: Outcome,
  maxDoubles: number,
): Partial<Record<number, Pick>> {
  const currentPick = current[gameNumber];

  if (!currentPick) {
    return {
      ...current,
      [gameNumber]: outcome,
    };
  }

  return toggleOutcomeInPicks(
    current as Record<number, Pick>,
    gameNumber,
    outcome,
    maxDoubles,
  );
}

export function CurrentRoundTicket({
  kapiloto,
  round = PROTOTYPE_CURRENT_ROUND,
}: {
  kapiloto: CurrentRoundKapilotoConfig;
  round?: CurrentRoundView;
}) {
  const router = useRouter();
  const [picks, setPicks] = useState<Partial<Record<number, Pick>>>(
    () => round.initialPicks ?? {},
  );
  const [controllers] = useState(() =>
    createControllers(kapiloto, round.fixtures, round.maxDoubles),
  );
  const [profileOpen, setProfileOpen] = useState(false);
  const [groupName, setGroupName] = useState("הקבוצה שלי");
  const [groupCreateStatus, setGroupCreateStatus] = useState<
    "idle" | "creating" | "error"
  >("idle");
  const [joinCode, setJoinCode] = useState("");
  const [joinStatus, setJoinStatus] = useState<
    "idle" | "sending" | "pending" | "error"
  >("idle");
  const [joinGroupName, setJoinGroupName] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "unsaved" | "saving" | "saved" | "error"
  >(round.ticket ? "saved" : "idle");
  const [ticketState, setTicketState] = useState<
    "draft" | "submitted" | "locked" | null
  >(round.ticket?.state ?? null);
  const [submitStatus, setSubmitStatus] = useState<
    "idle" | "submitting" | "submitted" | "error"
  >(round.ticket?.state === "submitted" ? "submitted" : "idle");
  const revisionRef = useRef(round.ticket?.revision ?? 0);
  const editVersionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const ticketClientRef = useRef(createTicketClient());
  const now = useNow(30_000);

  useEffect(
    () => () => {
      for (const controller of controllers.values()) controller.dispose();
    },
    [controllers],
  );

  useEffect(() => {
    if (round.isPrototype) return;

    let stopped = false;
    let running = false;

    async function refreshLiveState() {
      if (running || stopped) return;
      running = true;

      try {
        const response = await fetch(
          `/api/v1/rounds/${kapiloto.roundId}/live-sync`,
          {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
          },
        );

        if (!response.ok || stopped) return;

        const body = (await response.json().catch(() => null)) as
          | { result?: { status?: string } }
          | null;

        if (body?.result?.status === "synced") {
          router.refresh();
        }
      } finally {
        running = false;
      }
    }

    void refreshLiveState();
    const timer = window.setInterval(() => {
      void refreshLiveState();
    }, 30_000);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [kapiloto.roundId, round.isPrototype, router]);

  useEffect(() => {
    if (
      round.isPrototype ||
      !round.ticket ||
      !kapiloto.groupId ||
      saveStatus !== "unsaved"
    ) {
      return;
    }

    const generation = editVersionRef.current;
    const payload = round.fixtures.flatMap((fixture) => {
      const pick = picks[fixture.number];
      return pick
        ? [{ roundGameId: fixture.roundGameId, pick }]
        : [];
    });

    const timer = window.setTimeout(() => {
      setSaveStatus("saving");

      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const result = await ticketClientRef.current.saveDraft({
            roundId: kapiloto.roundId,
            groupId: kapiloto.groupId!,
            expectedRevision: revisionRef.current,
            picks: payload,
          });

          revisionRef.current = result.revision;
          if (generation === editVersionRef.current) {
            setSaveStatus("saved");
          } else {
            setSaveStatus("unsaved");
          }
        })
        .catch(() => {
          setSaveStatus("error");
        });
    }, 500);

    return () => window.clearTimeout(timer);
  }, [
    kapiloto.groupId,
    kapiloto.roundId,
    picks,
    round.fixtures,
    round.isPrototype,
    round.ticket,
    saveStatus,
  ]);

  const doublesUsed = useMemo(
    () =>
      Object.values(picks).filter(
        (pick): pick is Pick =>
          Boolean(pick) && pickToOutcomes(pick as Pick).length === 2,
      ).length,
    [picks],
  );

  const completedPickCount = useMemo(
    () => round.fixtures.filter((fixture) => Boolean(picks[fixture.number])).length,
    [picks, round.fixtures],
  );

  function serializeCurrentPicks() {
    return round.fixtures.flatMap((fixture) => {
      const pick = picks[fixture.number];
      return pick ? [{ roundGameId: fixture.roundGameId, pick }] : [];
    });
  }

  async function createGroup() {
    const name = groupName.trim();
    if (name.length < 2 || groupCreateStatus === "creating") return;

    setGroupCreateStatus("creating");
    try {
      const response = await fetch("/api/v1/groups", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        throw new Error(`Group create failed with HTTP ${response.status}.`);
      }

      window.location.reload();
    } catch {
      setGroupCreateStatus("error");
    }
  }

  async function requestJoin() {
    const code = joinCode.trim();
    if (code.length < 4 || joinStatus === "sending") return;

    setJoinStatus("sending");
    setJoinGroupName(null);

    try {
      const response = await fetch("/api/v1/groups/join", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ joinCode: code }),
      });

      const body = (await response.json().catch(() => null)) as
        | {
            status?: string;
            groupName?: string;
            error?: { message?: string };
          }
        | null;

      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Join request failed.");
      }

      if (body?.status === "already_member") {
        window.location.reload();
        return;
      }

      setJoinGroupName(body?.groupName ?? null);
      setJoinStatus("pending");
    } catch {
      setJoinStatus("error");
    }
  }

  function submitTicket() {
    if (
      round.isPrototype ||
      !round.ticket ||
      !kapiloto.groupId ||
      ticketState === "locked" ||
      completedPickCount !== 16 ||
      doublesUsed > round.maxDoubles ||
      submitStatus === "submitting"
    ) {
      return;
    }

    const payload = serializeCurrentPicks();
    setSubmitStatus("submitting");
    setSaveStatus("saving");

    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const saved = await ticketClientRef.current.saveDraft({
          roundId: kapiloto.roundId,
          groupId: kapiloto.groupId!,
          expectedRevision: revisionRef.current,
          picks: payload,
        });

        revisionRef.current = saved.revision;

        const submitted = await ticketClientRef.current.submit({
          roundId: kapiloto.roundId,
          groupId: kapiloto.groupId!,
          expectedRevision: saved.revision,
        });

        revisionRef.current = submitted.revision;
        setTicketState(submitted.state);
        setSaveStatus("saved");
        setSubmitStatus("submitted");
      })
      .catch(() => {
        setSaveStatus("error");
        setSubmitStatus("error");
      });
  }

  function toggleOutcome(gameNumber: number, outcome: Outcome) {
    setPicks((current) => {
      const next = nextPicksAfterTap(
        current,
        gameNumber,
        outcome,
        round.maxDoubles,
      );

      if (next !== current && round.ticket && kapiloto.groupId) {
        editVersionRef.current += 1;
        setSaveStatus("unsaved");
        if (ticketState === "submitted") {
          setSubmitStatus("idle");
        }
      }

      return next;
    });
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
            <h1 className="text-[21px] font-bold leading-tight text-white">
              מחזור {round.roundNumber}
            </h1>
            <p className="text-[9px] font-medium text-[var(--muted)]">
              {round.dateLabel}
            </p>
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
          <p className="text-[9px] font-medium text-[var(--muted)]">
            {round.lockLabel}
            {round.ticket && kapiloto.groupId ? (
              <span className="mr-1.5">
                ·{" "}
                {saveStatus === "saving"
                  ? "שומר…"
                  : saveStatus === "unsaved"
                    ? "ממתין לשמירה"
                    : saveStatus === "error"
                      ? "שגיאת שמירה"
                      : "נשמר"}
              </span>
            ) : null}
          </p>
          <span
            className="inline-flex items-center rounded-full bg-[var(--kapiloto)] px-[9px] py-[5px] text-[9px] font-bold text-white"
            data-doubles-counter
          >
            כפולות · {doublesUsed} / {round.maxDoubles}
          </span>
        </div>
      </header>

      <section className="flex h-16 items-center justify-between bg-[var(--panel)] px-[18px]">
        <div className="flex flex-col items-start gap-0.5">
          <p className="text-[10px] font-medium text-[var(--text)]">
            ממלאים לבד
          </p>
          <p className="text-[8px] text-[var(--muted)]">
            {kapiloto.groupId
              ? "קפילוטו עוזר בכל משחק"
              : "בחר קבוצה כדי להפעיל את קפילוטו"}
          </p>
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

      {!kapiloto.groupId && !kapiloto.demoScenario ? (
        <section className="border-t border-[var(--border)] bg-[var(--panel)] px-[18px] py-3">
          <div className="flex flex-col gap-2 rounded-[14px] border border-[var(--border)] bg-[var(--elevated)] p-3">
            <div>
              <p className="text-[10px] font-bold text-[var(--text)]">
                כדי לשמור טופס ולהשתמש בקפילוטו צריך קבוצה
              </p>
              <p className="mt-0.5 text-[8px] text-[var(--muted)]">
                אפשר ליצור עכשיו קבוצה פרטית. קוד הזמנה ייווצר אוטומטית.
              </p>
            </div>
            <div className="flex gap-2">
              <input
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                maxLength={80}
                aria-label="שם הקבוצה"
                className="h-10 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 text-[10px] text-[var(--text)] outline-none"
              />
              <button
                type="button"
                onClick={() => void createGroup()}
                disabled={
                  groupName.trim().length < 2 ||
                  groupCreateStatus === "creating"
                }
                className="h-10 shrink-0 rounded-xl bg-[var(--action)] px-4 text-[10px] font-bold text-white disabled:opacity-45"
              >
                {groupCreateStatus === "creating" ? "יוצר…" : "צור קבוצה"}
              </button>
            </div>
            {groupCreateStatus === "error" ? (
              <p className="text-[8px] font-medium text-red-400">
                יצירת הקבוצה נכשלה. אפשר לנסות שוב.
              </p>
            ) : null}

            <div className="my-1 h-px bg-[var(--border)]" />

            <div>
              <p className="text-[10px] font-bold text-[var(--text)]">
                כבר יש קבוצה?
              </p>
              <p className="mt-0.5 text-[8px] text-[var(--muted)]">
                הזן קוד הזמנה. מנהל הקבוצה יאשר את הבקשה.
              </p>
            </div>
            <div className="flex gap-2" dir="ltr">
              <input
                value={joinCode}
                onChange={(event) => {
                  setJoinCode(event.target.value.toUpperCase());
                  if (joinStatus !== "sending") setJoinStatus("idle");
                }}
                maxLength={32}
                aria-label="קוד הזמנה לקבוצה"
                placeholder="JOIN CODE"
                className="h-10 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 text-center text-[10px] font-bold tracking-[0.12em] text-[var(--text)] outline-none"
              />
              <button
                type="button"
                onClick={() => void requestJoin()}
                disabled={
                  joinCode.trim().length < 4 ||
                  joinStatus === "sending" ||
                  joinStatus === "pending"
                }
                className="h-10 shrink-0 rounded-xl border border-[var(--action)] px-4 text-[10px] font-bold text-[var(--action)] disabled:opacity-45"
              >
                {joinStatus === "sending"
                  ? "שולח…"
                  : joinStatus === "pending"
                    ? "נשלח"
                    : "בקש להצטרף"}
              </button>
            </div>
            {joinStatus === "pending" ? (
              <p className="text-[8px] font-medium text-[var(--muted)]">
                הבקשה{joinGroupName ? ` ל־${joinGroupName}` : ""} ממתינה לאישור מנהל.
              </p>
            ) : null}
            {joinStatus === "error" ? (
              <p className="text-[8px] font-medium text-red-400">
                לא ניתן לשלוח את הבקשה. בדוק את הקוד ונסה שוב.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {round.ticket && kapiloto.groupId ? (
        <section className="border-t border-[var(--border)] bg-[var(--panel)] px-[18px] py-2">
          <button
            type="button"
            onClick={submitTicket}
            disabled={
              completedPickCount !== 16 ||
              doublesUsed > round.maxDoubles ||
              ticketState === "locked" ||
              submitStatus === "submitting"
            }
            className="flex h-11 w-full items-center justify-center rounded-xl bg-[var(--action)] text-[11px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            {ticketState === "locked"
              ? "הטופס נעול"
              : completedPickCount !== 16
                ? `מלא עוד ${16 - completedPickCount} משחקים`
                : submitStatus === "submitting"
                  ? "שולח…"
                  : submitStatus === "submitted"
                    ? "הטופס נשלח"
                    : ticketState === "submitted"
                      ? "שלח עדכון"
                      : "שלח טופס"}
          </button>
          {submitStatus === "error" ? (
            <p className="mt-1 text-center text-[8px] font-medium text-red-400">
              השליחה נכשלה. הטופס נשאר אצלך וניתן לנסות שוב.
            </p>
          ) : null}
        </section>
      ) : null}

      <main className="flex flex-1 flex-col gap-2.5 px-[18px] pb-[96px] pt-3">
        {round.fixtures.map((fixture) => (
          <FixtureCard
            key={fixture.roundGameId}
            fixture={fixture}
            pick={picks[fixture.number]}
            onOutcomeClick={(outcome) =>
              toggleOutcome(fixture.number, outcome)
            }
            controller={controllers.get(fixture.number) ?? null}
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
        {kapiloto.groupId ? (
          <Link
            href={`/group?group=${kapiloto.groupId}`}
            className="flex h-11 w-[82px] items-center justify-center rounded-xl text-[9px] font-medium text-[var(--muted)]"
          >
            קבוצה
          </Link>
        ) : (
          <button
            type="button"
            disabled
            className="flex h-11 w-[82px] items-center justify-center rounded-xl text-[9px] font-medium text-[var(--muted-strong)]"
          >
            קבוצה
          </button>
        )}
        {["סטטיסטיקות", "עוד"].map((label) => (
          <button
            key={label}
            type="button"
            disabled
            className="flex h-11 w-[82px] items-center justify-center rounded-xl text-[9px] font-medium text-[var(--muted-strong)]"
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
