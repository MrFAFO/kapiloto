"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { KapilotoWordmark } from "@/components/kapiloto-wordmark";
import { MobileAppNav } from "@/components/mobile-app-nav";
import type { ActiveGroupContext } from "@/lib/groups/current-group";
import type { GroupDashboard } from "@/lib/groups/dashboard";

function roleLabel(role: "owner" | "admin" | "member"): string {
  if (role === "owner") return "בעלים";
  if (role === "admin") return "מנהל";
  return "חבר";
}

function joinedLabel(value: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jerusalem",
  }).format(new Date(value));
}

export function GroupDashboardScreen({
  dashboard,
  groups,
}: {
  dashboard: GroupDashboard;
  groups: ActiveGroupContext[];
}) {
  const router = useRouter();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [decisionState, setDecisionState] = useState<
    Record<string, "approving" | "rejecting" | "error">
  >({});

  async function copyJoinCode() {
    try {
      await navigator.clipboard.writeText(dashboard.joinCode);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
    }
  }

  async function decide(
    requestId: string,
    decision: "approved" | "rejected",
  ) {
    setDecisionState((current) => ({
      ...current,
      [requestId]: decision === "approved" ? "approving" : "rejecting",
    }));

    try {
      const response = await fetch(
        `/api/v1/groups/${dashboard.groupId}/join-requests/${requestId}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );

      if (!response.ok) {
        throw new Error(`Join decision failed with HTTP ${response.status}.`);
      }

      setDecisionState((current) => {
        const next = { ...current };
        delete next[requestId];
        return next;
      });
      router.refresh();
    } catch {
      setDecisionState((current) => ({
        ...current,
        [requestId]: "error",
      }));
    }
  }

  const isAdmin = dashboard.role === "owner" || dashboard.role === "admin";

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-[var(--canvas)] pb-[84px]">
      <header className="bg-gradient-to-r from-[var(--header-from)] to-[var(--header-to)] px-[18px] pb-4 pt-[18px]">
        <div className="flex h-8 items-center justify-between">
          <KapilotoWordmark />
          <Link
            href={`/tickets/toto?group=${dashboard.groupId}`}
            className="inline-flex h-8 items-center rounded-full bg-[var(--elevated)] px-3 text-[9px] font-bold text-[var(--text)]"
          >
            חזרה לטופס
          </Link>
        </div>

        <div className="mt-4 flex items-end justify-between gap-3">
          <div>
            <p className="text-[9px] font-medium text-[var(--muted)]">הקבוצה שלי</p>
            <h1 className="mt-0.5 text-[22px] font-bold leading-tight text-white">
              {dashboard.name}
            </h1>
          </div>
          <span className="rounded-full bg-[var(--kapiloto-deep)] px-3 py-1.5 text-[9px] font-bold text-white">
            {roleLabel(dashboard.role)}
          </span>
        </div>

        <div className="mt-3 flex items-center gap-2 text-[9px] text-[var(--muted)]">
          <span>{dashboard.memberCount} חברים</span>
          <span>·</span>
          <span>עד {dashboard.defaultMaxDoubles} כפולות כברירת מחדל</span>
        </div>
      </header>

      {groups.length > 1 ? (
        <section className="overflow-x-auto border-b border-[var(--border)] bg-[var(--panel)] px-[18px] py-3">
          <div className="flex min-w-max gap-2">
            {groups.map((group) => {
              const active = group.groupId === dashboard.groupId;
              return (
                <Link
                  key={group.groupId}
                  href={`/group?group=${group.groupId}`}
                  aria-current={active ? "page" : undefined}
                  className={[
                    "rounded-full border px-3 py-2 text-[9px] font-bold",
                    active
                      ? "border-[var(--kapiloto)] bg-[var(--kapiloto-deep)] text-white"
                      : "border-[var(--border)] bg-[var(--elevated)] text-[var(--muted)]",
                  ].join(" ")}
                >
                  {group.name}
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      <main className="flex flex-1 flex-col gap-3 px-[18px] py-4">
        <section className="rounded-[18px] border border-[var(--kapiloto-border)] bg-[var(--kapiloto-surface)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[12px] font-bold text-white">קוד הזמנה</h2>
              <p className="mt-1 text-[8px] leading-4 text-[var(--muted)]">
                מי שמזין את הקוד שולח בקשת הצטרפות. מנהל צריך לאשר אותה.
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-[var(--kapiloto-deep)] px-2.5 py-1 text-[8px] font-bold text-white">
              פרטי
            </span>
          </div>

          <div className="mt-3 flex items-center gap-2" dir="ltr">
            <div className="flex h-12 min-w-0 flex-1 items-center justify-center rounded-xl border border-[var(--kapiloto-border)] bg-[var(--panel)] font-mono text-[16px] font-bold tracking-[0.16em] text-white">
              {dashboard.joinCode}
            </div>
            <button
              type="button"
              onClick={() => void copyJoinCode()}
              className="h-12 shrink-0 rounded-xl bg-[var(--kapiloto)] px-4 text-[9px] font-bold text-white"
            >
              {copyState === "copied"
                ? "הועתק"
                : copyState === "error"
                  ? "נסה שוב"
                  : "העתק"}
            </button>
          </div>
        </section>

        {isAdmin ? (
          <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[12px] font-bold text-white">
                בקשות הצטרפות
              </h2>
              <span className="rounded-full bg-[var(--elevated)] px-2.5 py-1 text-[8px] font-bold text-[var(--muted)]">
                {dashboard.pendingRequests.length}
              </span>
            </div>

            {dashboard.pendingRequests.length === 0 ? (
              <p className="mt-3 rounded-xl bg-[var(--elevated)] px-3 py-4 text-center text-[9px] text-[var(--muted)]">
                אין בקשות שממתינות לאישור.
              </p>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {dashboard.pendingRequests.map((request) => {
                  const state = decisionState[request.requestId];
                  return (
                    <div
                      key={request.requestId}
                      className="rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-[10px] font-bold text-[var(--text)]">
                            {request.displayName || request.username}
                          </p>
                          <p className="truncate text-[8px] text-[var(--muted)]">
                            @{request.username}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1.5">
                          <button
                            type="button"
                            disabled={state === "approving" || state === "rejecting"}
                            onClick={() => void decide(request.requestId, "rejected")}
                            className="h-8 rounded-lg border border-[var(--border)] px-3 text-[8px] font-bold text-[var(--muted)] disabled:opacity-45"
                          >
                            {state === "rejecting" ? "דוחה…" : "דחה"}
                          </button>
                          <button
                            type="button"
                            disabled={state === "approving" || state === "rejecting"}
                            onClick={() => void decide(request.requestId, "approved")}
                            className="h-8 rounded-lg bg-[var(--success)] px-3 text-[8px] font-bold text-white disabled:opacity-45"
                          >
                            {state === "approving" ? "מאשר…" : "אשר"}
                          </button>
                        </div>
                      </div>
                      {state === "error" ? (
                        <p className="mt-2 text-[8px] font-medium text-red-400">
                          הפעולה נכשלה. אפשר לנסות שוב.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ) : null}

        <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[12px] font-bold text-white">חברי הקבוצה</h2>
            <span className="text-[8px] font-medium text-[var(--muted)]">
              {dashboard.memberCount} פעילים
            </span>
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {dashboard.members.map((member) => (
              <div
                key={member.userId}
                className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--elevated)] px-3 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-[10px] font-bold text-[var(--text)]">
                      {member.displayName || member.username}
                    </p>
                    {member.isCurrentUser ? (
                      <span className="rounded-full bg-[var(--kapiloto-deep)] px-2 py-0.5 text-[7px] font-bold text-white">
                        אני
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-[8px] text-[var(--muted)]">
                    @{member.username} · הצטרף {joinedLabel(member.joinedAt)}
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-[var(--border)] px-2.5 py-1 text-[8px] font-bold text-[var(--muted)]">
                  {roleLabel(member.role)}
                </span>
              </div>
            ))}
          </div>
        </section>
      </main>

      <MobileAppNav active="group" groupId={dashboard.groupId} />
    </div>
  );
}
