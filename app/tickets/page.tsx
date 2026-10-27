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

export default async function TicketsPage({
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
  const [round, groups] = await Promise.all([
    new SupabaseCurrentRoundLoader(admin).load(),
    loadActiveGroups(admin, userId),
  ]);
  const group = selectActiveGroup(groups, requestedGroup ?? null);
  const totoHref = group
    ? `/tickets/toto?group=${group.groupId}`
    : "/tickets/toto";

  return (
    <div
      dir="rtl"
      className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-[var(--canvas)] pb-[84px]"
    >
      <header className="border-b border-[var(--border)] bg-gradient-to-r from-[var(--header-from)] to-[var(--header-to)] px-[18px] pb-4 pt-[18px]">
        <div className="flex items-center justify-between">
          <KapilotoWordmark />
          <span className="text-[9px] font-bold text-[var(--kapiloto)]">
            טפסים
          </span>
        </div>
        <h1 className="mt-4 text-[21px] font-black text-white">
          מרכז הטפסים
        </h1>
        <p className="mt-1 text-[9px] leading-5 text-[var(--muted)]">
          טוטו נשאר ה־flow המלא. Winner יתווסף בהדרגה על אותה שכבת מודיעין.
        </p>
      </header>

      <main className="flex flex-1 flex-col gap-3 px-[18px] py-4">
        <Link
          href={totoHref}
          className="rounded-[20px] border border-[var(--kapiloto-border)] bg-[var(--kapiloto-surface)] p-5"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[9px] font-bold text-[var(--kapiloto)]">
                TOTO 16
              </p>
              <h2 className="mt-1 text-[17px] font-black text-white">
                {round
                  ? `מחזור ${round.externalRoundNumber}`
                  : "הטופס השבועי"}
              </h2>
              <p className="mt-2 text-[9px] leading-5 text-[var(--muted)]">
                מילוי 16 משחקים, כפולות, קפילוטו, קבוצה, Live ו־settlement.
              </p>
            </div>
            <span className="rounded-full bg-[var(--action)] px-3 py-1.5 text-[8px] font-bold text-white">
              פעיל
            </span>
          </div>
          <div className="mt-4 flex h-10 items-center justify-center rounded-xl bg-[var(--kapiloto)] text-[9px] font-bold text-white">
            פתח את טופס הטוטו
          </div>
        </Link>

        <section className="rounded-[20px] border border-[var(--border)] bg-[var(--panel)] p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[9px] font-bold text-[var(--success)]">
                WINNER
              </p>
              <h2 className="mt-1 text-[17px] font-black text-white">
                טופס חופשי
              </h2>
              <p className="mt-2 text-[9px] leading-5 text-[var(--muted)]">
                הממשק יישען על אותם משחקים וניתוחים, אבל לא נציג שוק או
                המלצה לפני שיש לו מודל דטרמיניסטי ודאטה מאומתים.
              </p>
            </div>
            <span className="rounded-full bg-[var(--elevated)] px-3 py-1.5 text-[8px] font-bold text-[var(--muted)]">
              בהכנה
            </span>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            {["1X2", "שערים", "שווקים נוספים"].map((label, index) => (
              <div
                key={label}
                className="rounded-xl border border-[var(--border)] bg-[var(--elevated)] px-2 py-3 text-center"
              >
                <p className="text-[9px] font-bold text-[var(--text)]">{label}</p>
                <p className="mt-1 text-[7px] text-[var(--muted)]">
                  {index < 2 ? "בשלב המודל" : "מאוחר יותר"}
                </p>
              </div>
            ))}
          </div>

          <Link
            href="/matches"
            className="mt-4 flex h-10 items-center justify-center rounded-xl border border-[var(--border)] text-[9px] font-bold text-[var(--kapiloto)]"
          >
            עבור לניתוחי המשחקים
          </Link>
        </section>
      </main>

      <MobileAppNav active="tickets" groupId={group?.groupId ?? null} />
    </div>
  );
}
