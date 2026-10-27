import Link from "next/link";
import { redirect } from "next/navigation";

import { KapilotoWordmark } from "@/components/kapiloto-wordmark";
import { MobileAppNav } from "@/components/mobile-app-nav";
import {
  loadActiveGroups,
  selectActiveGroup,
} from "@/lib/groups/current-group";
import { SupabaseCurrentRoundLoader } from "@/lib/rounds/current-round";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

const kickoffClock = new Intl.DateTimeFormat("he-IL", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Jerusalem",
});

function gameStateLabel(status: string): string {
  if (status === "live") return "חי";
  if (status === "halftime") return "מחצית";
  if (status === "finished") return "הסתיים";
  if (status === "postponed") return "נדחה";
  if (status === "cancelled") return "בוטל";
  if (status === "under_review") return "בבדיקה";
  return "קרוב";
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");

  const params = await searchParams;
  const requestedGroup = Array.isArray(params.group)
    ? params.group[0]
    : params.group;

  const admin = createAdminClient();
  const [round, groups, profileResult] = await Promise.all([
    new SupabaseCurrentRoundLoader(admin).load(),
    loadActiveGroups(admin, userId),
    admin
      .from("profiles")
      .select("display_name,username")
      .eq("id", userId)
      .maybeSingle(),
  ]);

  const group = selectActiveGroup(groups, requestedGroup ?? null);
  const name =
    profileResult.data?.display_name ||
    profileResult.data?.username ||
    "אוהד";
  const liveCount =
    round?.games.filter((game) =>
      ["live", "halftime"].includes(game.status),
    ).length ?? 0;
  const finishedCount =
    round?.games.filter((game) => game.status === "finished").length ?? 0;
  const highlighted =
    round?.games
      .filter((game) => game.status !== "finished")
      .slice(0, 4) ?? [];

  return (
    <div
      dir="rtl"
      className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-[var(--canvas)] pb-[84px]"
    >
      <header className="bg-gradient-to-r from-[var(--header-from)] to-[var(--header-to)] px-[18px] pb-5 pt-[18px]">
        <div className="flex items-center justify-between">
          <KapilotoWordmark />
          <span className="rounded-full bg-[var(--elevated)] px-3 py-1.5 text-[8px] font-bold text-[var(--muted)]">
            Kapiloto V2
          </span>
        </div>
        <p className="mt-5 text-[9px] text-[var(--muted)]">שלום {name}</p>
        <h1 className="mt-1 text-[22px] font-black text-white">
          מה קורה בכדורגל שלך
        </h1>
        <p className="mt-2 max-w-[330px] text-[9px] leading-5 text-[var(--muted)]">
          טוטו, ניתוחי משחק ו־Winner נשענים על אותו Match Intelligence.
        </p>
      </header>

      <main className="flex flex-1 flex-col gap-3 px-[18px] py-4">
        <section className="grid grid-cols-2 gap-3">
          <Link
            href={group ? `/tickets/toto?group=${group.groupId}` : "/tickets/toto"}
            className="rounded-[18px] border border-[var(--kapiloto-border)] bg-[var(--kapiloto-surface)] p-4"
          >
            <p className="text-[9px] font-bold text-[var(--kapiloto)]">TOTO 16</p>
            <p className="mt-2 text-[14px] font-black text-white">
              הטופס השבועי
            </p>
            <p className="mt-1 text-[8px] leading-4 text-[var(--muted)]">
              מילוי, קפילוטו, דייגו ותוצאות חיות.
            </p>
          </Link>

          <Link
            href="/matches"
            className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4"
          >
            <p className="text-[9px] font-bold text-[var(--diego)]">MATCHES</p>
            <p className="mt-2 text-[14px] font-black text-white">
              ניתוח עמוק
            </p>
            <p className="mt-1 text-[8px] leading-4 text-[var(--muted)]">
              הסתברויות, גורמים, חיסורים ומקורות.
            </p>
          </Link>
        </section>

        <Link
          href="/tickets"
          className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[9px] font-bold text-[var(--success)]">WINNER</p>
              <p className="mt-1 text-[12px] font-bold text-white">
                שכבת השווקים הבאה
              </p>
              <p className="mt-1 text-[8px] leading-4 text-[var(--muted)]">
                נוסיף רק שווקים שמגובה להם מודל ודאטה מאומתים.
              </p>
            </div>
            <span className="rounded-full bg-[var(--elevated)] px-2.5 py-1.5 text-[8px] font-bold text-[var(--muted)]">
              בהכנה
            </span>
          </div>
        </Link>

        {round ? (
          <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[9px] font-bold text-[var(--muted)]">
                  מחזור Winner 16
                </p>
                <p className="mt-1 text-[16px] font-black text-white">
                  {round.externalRoundNumber}
                </p>
              </div>
              <div className="flex gap-1.5">
                {liveCount > 0 ? (
                  <span className="rounded-full bg-[var(--live)]/15 px-2.5 py-1.5 text-[8px] font-bold text-[var(--live)]">
                    {liveCount} חי
                  </span>
                ) : null}
                <span className="rounded-full bg-[var(--elevated)] px-2.5 py-1.5 text-[8px] font-bold text-[var(--muted)]">
                  {finishedCount}/16 הסתיימו
                </span>
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-2">
              {highlighted.map((game) => (
                <Link
                  key={game.roundGameId}
                  href={`/matches/${game.fixtureId}`}
                  className="flex items-center justify-between gap-3 rounded-xl bg-[var(--elevated)] px-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[9px] font-bold text-[var(--text)]">
                      {game.home} — {game.away}
                    </p>
                    <p className="mt-0.5 text-[8px] text-[var(--muted)]">
                      {game.league} · {kickoffClock.format(new Date(game.kickoffAt))}
                    </p>
                  </div>
                  <span className="shrink-0 text-[8px] font-bold text-[var(--kapiloto)]">
                    {gameStateLabel(game.status)}
                  </span>
                </Link>
              ))}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <Link
                href="/matches"
                className="flex h-10 items-center justify-center rounded-xl border border-[var(--border)] text-[9px] font-bold text-[var(--muted)]"
              >
                כל המשחקים
              </Link>
              <Link
                href={group ? `/tickets/toto?group=${group.groupId}` : "/tickets/toto"}
                className="flex h-10 items-center justify-center rounded-xl bg-[var(--action)] text-[9px] font-bold text-white"
              >
                לטופס
              </Link>
            </div>
          </section>
        ) : (
          <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4 text-center">
            <p className="text-[10px] font-bold">אין כרגע מחזור פעיל</p>
            <p className="mt-1 text-[8px] text-[var(--muted)]">
              המחזור הבא יופיע כאן לאחר הייבוא האוטומטי.
            </p>
          </section>
        )}

        {group ? (
          <Link
            href={`/group?group=${group.groupId}`}
            className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4"
          >
            <p className="text-[9px] font-bold text-[var(--muted)]">הקבוצה שלך</p>
            <div className="mt-1 flex items-center justify-between">
              <p className="text-[13px] font-bold text-white">{group.name}</p>
              <span className="text-[8px] font-bold text-[var(--kapiloto)]">
                פתח קבוצה ←
              </span>
            </div>
          </Link>
        ) : null}
      </main>

      <MobileAppNav active="home" groupId={group?.groupId ?? null} />
    </div>
  );
}
