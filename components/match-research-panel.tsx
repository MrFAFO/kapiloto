"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  KapilotoPanel,
  useKapilotoPanel,
} from "@/components/kapiloto-panel";
import { createKapilotoClient } from "@/lib/kapiloto/client";
import { KapilotoPanelController } from "@/lib/kapiloto/panel-controller";

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}

function ConnectedMatchResearchPanel({
  roundId,
  roundGameId,
  groupId,
}: {
  roundId: string;
  roundGameId: string;
  groupId: string;
}) {
  const router = useRouter();
  const now = useNow();
  const [controller] = useState(
    () =>
      new KapilotoPanelController(
        createKapilotoClient(),
        {
          roundId,
          roundGameId,
          groupId,
        },
        {
          onRoundRunPublished() {
            router.refresh();
          },
        },
      ),
  );
  const view = useKapilotoPanel(controller);

  useEffect(() => {
    controller.open();
    return () => controller.dispose();
  }, [controller]);

  return (
    <KapilotoPanel
      view={view}
      panelId={`match-kapiloto-${roundGameId}`}
      now={now}
      onConsult={() => void controller.consult()}
      onRecheck={() => void controller.recheck()}
      onRetry={() => controller.retry()}
    />
  );
}

export function MatchResearchPanel({
  roundId,
  roundGameId,
  groupId,
}: {
  roundId: string | null;
  roundGameId: string | null;
  groupId: string | null;
}) {
  if (!roundId || !roundGameId) {
    return (
      <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
        <p className="text-[11px] font-bold">מחקר קפילוטו</p>
        <p className="mt-2 text-[9px] leading-5 text-[var(--muted)]">
          המשחק אינו משויך כרגע למחזור Winner 16 פעיל, ולכן אין אפשרות לפתוח
          ממנו סבב מחקר משותף.
        </p>
      </section>
    );
  }

  if (!groupId) {
    return (
      <section className="rounded-[18px] border border-[var(--kapiloto-border)] bg-[var(--kapiloto-surface)] p-4">
        <p className="text-[11px] font-bold text-white">מחקר קפילוטו</p>
        <p className="mt-2 text-[9px] leading-5 text-[var(--muted)]">
          כדי לבקש מחקר או בדיקה חוזרת יש לבחור או ליצור קבוצה. הניתוח עצמו
          נשאר מרכזי ומשותף למחזור ואינו רץ מחדש לכל משתמש.
        </p>
      </section>
    );
  }

  return (
    <ConnectedMatchResearchPanel
      roundId={roundId}
      roundGameId={roundGameId}
      groupId={groupId}
    />
  );
}
