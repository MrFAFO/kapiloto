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

function statusLabel(status: string): string {
  if (status === "live") return "חי";
  if (status === "halftime") return "מחצית";
  if (status === "finished") return "הסתיים";
  if (status === "postponed") return "נדחה";
  if (status === "cancelled") return "בוטל";
  if (status === "suspended") return "הופסק";
  if (status === "under_review") return "בבדיקה";
  return "טרם שוחק";
}

export default async function MatchesPage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");

  const admin = createAdminClient();
  const [round, groups] = await Promise.all([
    new SupabaseCurrentRoundLoader(admin).load(),
    loadActiveGroups(admin, userId),
  ]);
  const group = selectActiveGroup(groups, null);

  return (
    <div
      dir="rtl"
      className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-[var(--canvas)] pb-[84px]"
    >
      <header className="border-b border-[var(--border)] bg-gradient-to-r from-[var(--header-from)] to-[var(--header-to)] px-[18px] pb-4 pt-[18px]">
        <div className="flex items-center justify-between">
          <KapilotoWordmark />
          <span className="text-[9px] font-bold text-[var(--kapiloto)]">
            משחקים
          </span>
        </div>
        <h1 className="mt-4 text-[21px] font-black text-white">
          מרכז המשחקים
        </h1>
        <p className="mt-1 text-[9px] leading-5 text-[var(--muted)]">
          כל משחק הוא ישות אחת שמחברת Live, טוטו, Winner וניתוח קפילוטו.
        </p>
      </header>

      <main className="flex flex-1 flex-col gap-3 px-[18px] py-4">
        {round ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[9px] text-[var(--muted)]">Winner 16</p>
                <p className="text-[13px] font-bold text-white">
                  מחזור {round.externalRoundNumber}
                </p>
              </div>
              <span className="rounded-full bg-[var(--elevated)] px-2.5 py-1.5 text-[8px] font-bold text-[var(--muted)]">
                16 משחקים
              </span>
            </div>

            <div className="flex flex-col gap-2">
              {round.games.map((game) => {
                const score =
                  game.homeScore != null && game.awayScore != null
                    ? `${game.homeScore}–${game.awayScore}`
                    : null;

                return (
                  <Link
                    key={game.roundGameId}
                    href={`/matches/${game.fixtureId}`}
                    className="rounded-[16px] border border-[var(--border)] bg-[var(--panel)] p-3 transition-colors hover:border-[var(--kapiloto-border)]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[8px] font-bold text-[var(--muted)]">
                          משחק {game.number} · {game.league}
                        </p>
                        <p className="mt-1 truncate text-[11px] font-bold text-white">
                          {game.home} {score ? ` ${score} ` : " — "} {game.away}
                        </p>
                        <p className="mt-1 text-[8px] text-[var(--muted)]">
                          {kickoffClock.format(new Date(game.kickoffAt))}
                        </p>
                      </div>
                      <div className="shrink-0 text-left">
                        <p
                          className={[
                            "text-[8px] font-bold",
                            ["live", "halftime"].includes(game.status)
                              ? "text-[var(--live)]"
                              : "text-[var(--kapiloto)]",
                          ].join(" ")}
                        >
                          {statusLabel(game.status)}
                        </p>
                        <p className="mt-1 text-[8px] font-bold text-[var(--muted)]">
                          ניתוח ←
                        </p>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </>
        ) : (
          <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-5 text-center">
            <p className="text-[11px] font-bold">אין מחזור פעיל</p>
            <p className="mt-1 text-[8px] text-[var(--muted)]">
              משחקים יופיעו כאן לאחר הייבוא הבא.
            </p>
          </section>
        )}
      </main>

      <MobileAppNav active="matches" groupId={group?.groupId ?? null} />
    </div>
  );
}
