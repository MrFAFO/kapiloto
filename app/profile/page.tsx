import Link from "next/link";
import { redirect } from "next/navigation";

import { KapilotoWordmark } from "@/components/kapiloto-wordmark";
import { MobileAppNav } from "@/components/mobile-app-nav";
import {
  loadActiveGroups,
  selectActiveGroup,
} from "@/lib/groups/current-group";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");

  const admin = createAdminClient();
  const [profileResult, groups] = await Promise.all([
    admin
      .from("profiles")
      .select("username,display_name,created_at")
      .eq("id", userId)
      .maybeSingle(),
    loadActiveGroups(admin, userId),
  ]);

  if (profileResult.error) {
    throw new Error(`Failed to load profile: ${profileResult.error.message}`);
  }

  const group = selectActiveGroup(groups, null);
  const username = profileResult.data?.username ?? "משתמש";
  const displayName = profileResult.data?.display_name || username;

  return (
    <div
      dir="rtl"
      className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-[var(--canvas)] pb-[84px]"
    >
      <header className="border-b border-[var(--border)] bg-gradient-to-r from-[var(--header-from)] to-[var(--header-to)] px-[18px] pb-5 pt-[18px]">
        <div className="flex items-center justify-between">
          <KapilotoWordmark />
          <span className="text-[9px] font-bold text-[var(--kapiloto)]">
            אישי
          </span>
        </div>
        <h1 className="mt-5 text-[22px] font-black text-white">{displayName}</h1>
        <p className="mt-1 text-[9px] text-[var(--muted)]">@{username}</p>
      </header>

      <main className="flex flex-1 flex-col gap-3 px-[18px] py-4">
        <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
          <p className="text-[9px] font-bold text-[var(--muted)]">הקבוצות שלי</p>
          <p className="mt-1 text-[24px] font-black text-white">{groups.length}</p>
          <p className="mt-1 text-[8px] text-[var(--muted)]">
            קבוצות פעילות בחשבון
          </p>
        </section>

        <div className="grid grid-cols-2 gap-3">
          <Link
            href="/tickets"
            className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4"
          >
            <p className="text-[10px] font-bold text-white">הטפסים שלי</p>
            <p className="mt-1 text-[8px] leading-4 text-[var(--muted)]">
              מעבר לטוטו ולמרכז הטפסים.
            </p>
          </Link>
          {group ? (
            <Link
              href={`/group?group=${group.groupId}`}
              className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4"
            >
              <p className="text-[10px] font-bold text-white">הקבוצה</p>
              <p className="mt-1 truncate text-[8px] leading-4 text-[var(--muted)]">
                {group.name}
              </p>
            </Link>
          ) : (
            <Link
              href="/tickets/toto"
              className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4"
            >
              <p className="text-[10px] font-bold text-white">צור קבוצה</p>
              <p className="mt-1 text-[8px] leading-4 text-[var(--muted)]">
                מתחילים מתוך טופס הטוטו.
              </p>
            </Link>
          )}
        </div>
      </main>

      <MobileAppNav active="profile" groupId={group?.groupId ?? null} />
    </div>
  );
}
