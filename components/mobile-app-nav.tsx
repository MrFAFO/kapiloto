import Link from "next/link";

export type MobileAppNavDestination =
  | "home"
  | "matches"
  | "tickets"
  | "group"
  | "profile";

const ITEMS: Array<{
  key: MobileAppNavDestination;
  label: string;
  href: string;
}> = [
  { key: "home", label: "ראשי", href: "/" },
  { key: "matches", label: "משחקים", href: "/matches" },
  { key: "tickets", label: "טפסים", href: "/tickets" },
  { key: "group", label: "קבוצה", href: "/group" },
  { key: "profile", label: "אישי", href: "/profile" },
];

export function MobileAppNav({
  active,
  groupId = null,
}: {
  active: MobileAppNavDestination;
  groupId?: string | null;
}) {
  return (
    <nav
      aria-label="ניווט ראשי"
      className="fixed inset-x-0 bottom-0 z-30 mx-auto grid h-[72px] max-w-[430px] grid-cols-5 border-t border-[var(--border)] bg-[var(--nav)] px-2 pb-3 pt-[9px]"
    >
      {ITEMS.map((item) => {
        const isActive = item.key === active;
        const unavailable = item.key === "group" && !groupId;
        const href =
          item.key === "group" && groupId
            ? `/group?group=${groupId}`
            : item.href;

        if (unavailable) {
          return (
            <span
              key={item.key}
              aria-disabled="true"
              className="flex h-11 items-center justify-center rounded-xl text-[9px] font-medium text-[var(--muted-strong)]"
            >
              {item.label}
            </span>
          );
        }

        return (
          <Link
            key={item.key}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={[
              "flex h-11 items-center justify-center rounded-xl text-[9px] transition-colors",
              isActive
                ? "bg-[var(--elevated)] font-bold text-[var(--kapiloto)]"
                : "font-medium text-[var(--muted)]",
            ].join(" ")}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
