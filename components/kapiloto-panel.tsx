"use client";

import { useMemo, useSyncExternalStore } from "react";

import type { KapilotoPublicFixtureAnalysis } from "@/lib/kapiloto/api-types";
import {
  kapilotoRecommendation,
  type KapilotoPanelController,
  type KapilotoPanelErrorReason,
} from "@/lib/kapiloto/panel-controller";
import {
  deriveKapilotoPanelView,
  type KapilotoPanelView,
} from "@/lib/kapiloto/panel-view";

/*
 * Inline Kapiloto panel — Dark Stadium screens 10.2 (expanded), 10.12
 * (researching), 10.13 (stale) and 10.14 (research error) in Figma file
 * 2Pp5ae9bgqhTfwcU2JcIlK. Every state reuses the same card anatomy:
 * header (title + status pill), body lines, double-priority row and two
 * action slots (dark secondary, purple primary). The purple slot is a
 * display badge except for "start research"; there is no Apply action.
 */

export function useKapilotoPanel(
  controller: KapilotoPanelController,
): KapilotoPanelView {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  return useMemo(() => deriveKapilotoPanelView(state), [state]);
}

const BAND_LABEL: Record<"low" | "medium" | "high", string> = {
  low: "נמוכה",
  medium: "בינונית",
  high: "גבוהה",
};

const ERROR_LINES: Record<KapilotoPanelErrorReason, string> = {
  unauthorized: "יש להתחבר כדי להתייעץ עם קפילוטו.",
  forbidden: "אין לך הרשאה לקבוצה הזו במחזור הזה.",
  not_found: "המשחק לא נמצא במחזור הזה.",
  invalid_request: "הבקשה לא תקינה ולא נשלחה למחקר.",
  unavailable: "קפילוטו לא זמין כרגע.",
  network: "אין חיבור לשרת. הבקשה לא נשלחה פעמיים.",
  research_failed:
    "חלק ממקורות המידע לא זמינים כרגע ולכן קפילוטו לא יוצר המלצה חדשה על בסיס מידע חלקי.",
  timeout: "המחקר נמשך זמן רב מהצפוי. אפשר לבדוק שוב בעוד רגע.",
};

const RETRIABLE: ReadonlySet<KapilotoPanelErrorReason> = new Set([
  "unavailable",
  "network",
  "research_failed",
  "timeout",
]);

export function formatAnalysisAge(generatedAt: string, now: number): string {
  const ms = now - Date.parse(generatedAt);
  if (!Number.isFinite(ms) || ms < 60_000) return "עכשיו";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `לפני ${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `לפני ${hours} שע׳`;
  return `לפני ${Math.floor(hours / 24)} ימים`;
}

function staleReasonLine(reasons: string[]): string {
  if (reasons.some((reason) => reason.startsWith("signal:"))) {
    return "התקבל עדכון מהותי מאז הבדיקה הקודמת ולכן ההמלצה הישנה מסומנת כלא עדכנית.";
  }
  return "עבר זמן מאז העדכון האחרון ולכן ההמלצה הישנה מסומנת כלא עדכנית.";
}

type Tone = "success" | "signal" | "live";
type Action = "consult" | "recheck" | "retry";

type CardModel = {
  pill: { text: string; tone: Tone; marker?: string };
  title: string;
  lines: string[];
  analysis: KapilotoPublicFixtureAnalysis | null;
  priority: { pill: string; label: string } | null;
  secondary: { label: string; action?: Action } | null;
  primary: { label: string; action?: Action; recommendation?: string } | null;
};

const TONE_CLASS: Record<Tone, string> = {
  success: "text-[var(--success)]",
  signal: "text-[var(--diego)]",
  live: "text-[var(--live)]",
};

function priorityFor(
  analysis: KapilotoPublicFixtureAnalysis,
  maxDoubles: number | null,
  previous = false,
): CardModel["priority"] {
  const rank = analysis.doublePriorityRank;
  const pill =
    rank != null && maxDoubles != null
      ? previous
        ? `עדיפות קודמת ${rank}/${maxDoubles}`
        : `עדיפות ${rank} מתוך ${maxDoubles}`
      : "ללא דירוג כפולה";
  const answer = analysis.doubleRecommended ? "כן" : "לא";
  return {
    pill,
    label: previous ? `כפולה קודמת: ${answer}` : `כפולה מומלצת: ${answer}`,
  };
}

function cardModel(view: KapilotoPanelView, now: number): CardModel {
  const analysis = view.analysis;
  const research = view.research;
  const recommendation = analysis ? kapilotoRecommendation(analysis) ?? "—" : null;
  const runsMax = research?.runs_max ?? 3;
  const recheck = view.canRecheck
    ? { label: "בדיקה חוזרת", action: "recheck" as const }
    : null;
  const researchingActions = {
    secondary: { label: "בדיקה מתבצעת" },
    primary: { label: "מחשב המלצה..." },
  };

  switch (view.kind) {
    case "loading":
      return {
        pill: { text: "טוען", tone: "success" },
        title: "ניתוח קפילוטו",
        lines: ["טוען את הניתוח השמור של המחזור. אין מחקר חדש בלי בקשה מפורשת."],
        analysis: null,
        priority: null,
        secondary: null,
        primary: null,
      };

    case "unresearched":
      return {
        pill: { text: "טרם נחקר", tone: "signal" },
        title: "קפילוטו עוד לא חקר את המחזור",
        lines: [
          "מחקר אחד מכסה את כל 16 משחקי המחזור ומשותף לכל המשתמשים.",
          "המחקר מתחיל רק כשמבקשים אותו במפורש.",
          "הבחירה שלך בטופס לא משתנה אוטומטית.",
        ],
        analysis: null,
        priority: {
          pill: `${research?.runs_remaining ?? runsMax}/${runsMax} מחקרים זמינים`,
          label: "מחקר משותף למחזור",
        },
        secondary: null,
        primary: view.canConsult
          ? { label: "התחל מחקר", action: "consult" }
          : { label: "אין מחקרים זמינים" },
      };

    case "first_loading":
    case "shared_researching":
      return {
        pill:
          view.kind === "first_loading"
            ? { text: "מחקר חדש", tone: "success" }
            : { text: "מחקר משותף", tone: "success" },
        title:
          view.kind === "first_loading"
            ? "קפילוטו בודק את המחזור"
            : "מחקר משותף כבר רץ",
        lines:
          view.kind === "first_loading"
            ? [
                "אוסף נתוני כושר עדכניים, בית וחוץ, פציעות והשעיות.",
                "בודק עומס משחקים, התאמות טקטיות וחדשות אחרונות.",
                "משווה גם תנועת שוק ומקורות חיצוניים רלוונטיים.",
                "הבחירה הנוכחית שלך נשארת ללא שינוי בזמן הבדיקה.",
              ]
            : [
                "משתמש אחר כבר ביקש מחקר לכל 16 משחקי המחזור.",
                "התוצאה תופיע כאן אוטומטית, בלי מחקר נוסף.",
                "הבחירה הנוכחית שלך נשארת ללא שינוי בזמן הבדיקה.",
              ],
        analysis: null,
        priority: { pill: "מחשב דירוג", label: "מחשב ערך כפולה..." },
        ...researchingActions,
      };

    case "rechecking":
      return {
        pill: { text: "בודק מחדש", tone: "success" },
        title: "ניתוח קפילוטו",
        lines: [
          "קפילוטו מריץ מחקר משותף חדש לכל משחקי המחזור.",
          "הניתוח הקודם מוצג עד לסיום. הבחירה שלך לא משתנה.",
        ],
        analysis,
        priority: analysis
          ? { pill: priorityFor(analysis, view.maxDoubles)!.pill, label: "מחשב ערך כפולה..." }
          : null,
        secondary: researchingActions.secondary,
        primary: recommendation
          ? { label: `המלצה נוכחית · ${recommendation}`, recommendation }
          : researchingActions.primary,
      };

    case "stale":
      return {
        pill: { text: "נדרש עדכון", tone: "signal" },
        title: "הניתוח התיישן",
        lines: [
          staleReasonLine(view.freshness?.stale_reasons ?? []),
          "קפילוטו שומר את הגרסה הקודמת לצפייה, אבל לא מציג אותה כהמלצה טרייה.",
          "הסימון שלך בטופס לא משתנה אוטומטית.",
        ],
        analysis,
        priority: analysis ? priorityFor(analysis, view.maxDoubles, true) : null,
        secondary: recheck,
        primary: recommendation
          ? { label: `המלצה קודמת · ${recommendation}`, recommendation }
          : null,
      };

    case "changed": {
      const previous = view.previousAnalysis
        ? kapilotoRecommendation(view.previousAnalysis)
        : null;
      return {
        pill: { text: "ההמלצה השתנתה", tone: "signal" },
        title: "ניתוח קפילוטו",
        lines: [
          `ההמלצה עודכנה אחרי בדיקה חוזרת: \u2066${previous ?? "—"} → ${recommendation ?? "—"}\u2069.`,
          "הבחירה שלך בטופס לא שונתה.",
        ],
        analysis,
        priority: analysis ? priorityFor(analysis, view.maxDoubles) : null,
        secondary: recheck,
        primary: recommendation
          ? { label: `המלצה סופית · ${recommendation}`, recommendation }
          : null,
      };
    }

    case "budget_exhausted":
      return {
        pill: {
          text: "אין רענון נוסף",
          tone: "signal",
          marker: "data-kapiloto-budget-exhausted",
        },
        title: analysis ? "הניתוח העדכני ביותר" : "נוצלו כל המחקרים",
        lines: [
          `נוצלו כל ${runsMax} המחקרים המשותפים של המחזור.`,
          analysis
            ? "מוצג הניתוח העדכני ביותר; אין רענון נוסף למחזור הזה."
            : "אין רענון נוסף למחזור הזה.",
        ],
        analysis,
        priority: analysis ? priorityFor(analysis, view.maxDoubles) : null,
        secondary: { label: `${research?.runs_used ?? runsMax}/${runsMax} מחקרים נוצלו` },
        primary: recommendation
          ? { label: `המלצה אחרונה · ${recommendation}`, recommendation }
          : null,
      };

    case "rate_limited": {
      const seconds =
        view.notice?.kind === "rate_limited" ? view.notice.retryAfterSeconds : null;
      return {
        pill: {
          text: "יותר מדי בקשות",
          tone: "live",
          marker: "data-kapiloto-rate-limited",
        },
        title: "נסה שוב בעוד רגע",
        lines: [
          seconds
            ? `יותר מדי בקשות ברצף. אפשר לנסות שוב בעוד ${seconds} שניות.`
            : "יותר מדי בקשות ברצף. אפשר לנסות שוב בעוד רגע.",
          "זו הגבלת קצב בקשות, לא מכסת המחקרים של המחזור.",
        ],
        analysis,
        priority: analysis ? priorityFor(analysis, view.maxDoubles) : null,
        secondary: { label: "נסה שוב", action: "retry" },
        primary: recommendation
          ? { label: `המלצה נוכחית · ${recommendation}`, recommendation }
          : null,
      };
    }

    case "error": {
      const reason =
        view.notice?.kind === "error" ? view.notice.reason : "research_failed";
      return {
        pill: { text: "שגיאת מחקר", tone: "live", marker: `data-kapiloto-error=${reason}` },
        title: "לא הצלחנו להשלים בדיקה",
        lines: [
          ERROR_LINES[reason],
          "הבחירה שלך נשמרה ולא בוצע בה שום שינוי.",
          ...(analysis ? ["הניתוח הקודם עדיין מוצג."] : []),
        ],
        analysis,
        priority: analysis
          ? priorityFor(analysis, view.maxDoubles, true)
          : { pill: "אין דירוג חדש", label: "אין המלצת כפולה חדשה" },
        secondary:
          !view.busy && RETRIABLE.has(reason)
            ? { label: "נסה שוב", action: "retry" }
            : null,
        primary: { label: "הבחירה שלך נשמרה" },
      };
    }

    default: {
      const lines: string[] = [];
      if (view.recheckOutcome === "unchanged") {
        lines.push("בדיקה חוזרת הושלמה. ההמלצה לא השתנתה.");
      }
      if (view.notice?.kind === "refresh_ineligible") {
        lines.push("אין עדיין מידע חדש שמצדיק בדיקה חוזרת.");
      }
      if (analysis && research?.runs_remaining === 0) {
        lines.push(`נוצלו כל ${runsMax} המחקרים המשותפים; אין רענון נוסף למחזור הזה.`);
      }
      return {
        pill: {
          text: analysis ? `עודכן ${formatAnalysisAge(analysis.generatedAt, now)}` : "עדכני",
          tone: "success",
        },
        title: "ניתוח קפילוטו",
        lines,
        analysis,
        priority: analysis ? priorityFor(analysis, view.maxDoubles) : null,
        secondary: recheck,
        primary: recommendation
          ? { label: `המלצה סופית · ${recommendation}`, recommendation }
          : null,
      };
    }
  }
}

function Pill({
  children,
  className,
  marker,
}: {
  children: React.ReactNode;
  className: string;
  marker?: string;
}) {
  const [name, value] = marker?.split("=") ?? [];
  const markerProps = name ? { [name]: value ?? "true" } : {};
  return (
    <span
      {...markerProps}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full px-[9px] py-[5px] text-[9px] font-bold leading-none ${className}`}
    >
      {children}
    </span>
  );
}

function AnalysisDetails({
  analysis,
  view,
}: {
  analysis: KapilotoPublicFixtureAnalysis;
  view: KapilotoPanelView;
}) {
  return (
    <div
      className="space-y-1.5 text-[10px] leading-[1.6] text-[var(--muted)]"
      data-kapiloto-analysis={analysis.analysisId}
    >
      {analysis.summary ? <p data-summary>{analysis.summary}</p> : null}
      {analysis.mainRisk ? (
        <p data-main-risk>
          <span className="font-bold text-[var(--text)]">סיכון עיקרי: </span>
          {analysis.mainRisk}
        </p>
      ) : null}
      <p>
        <span className="font-bold text-[var(--text)]">אמינות הניתוח: </span>
        <span data-reliability>
          {analysis.reliabilityBand ? BAND_LABEL[analysis.reliabilityBand] : "לא ידועה"}
        </span>
        {" · "}איכות המחקר והמקורות, לא סיכוי זכייה
        {view.freshness ? (
          <span className="sr-only" data-freshness={view.freshness.state} />
        ) : null}
      </p>
      <section
        aria-label="מקורות"
        data-kapiloto-sources
        className="flex items-center justify-between rounded-[10px] border border-dashed border-[var(--border)] px-2.5 py-1.5 text-[9px]"
      >
        <span className="font-bold text-[var(--text)]">מקורות</span>
        <span>יוצגו לאחר אימות שרת</span>
      </section>
    </div>
  );
}

type PanelProps = {
  view: KapilotoPanelView;
  panelId: string;
  now: number;
  demo?: boolean;
  onConsult: () => void;
  onRecheck: () => void;
  onRetry: () => void;
};

/** Toggle bar inside the fixture card (screens 10.1 and 10.2). */
export function KapilotoToggleBar({
  view,
  panelId,
  onToggle,
}: {
  view: KapilotoPanelView;
  panelId: string;
  onToggle: () => void;
}) {
  const expanded = view.kind !== "closed" && view.kind !== "collapsed";
  const cached =
    view.kind === "collapsed" && view.analysis
      ? kapilotoRecommendation(view.analysis)
      : null;
  const label = expanded
    ? "סגור ניתוח קפילוטו"
    : view.kind === "collapsed" && view.busy
      ? "קפילוטו בודק…"
      : cached
        ? "ניתוח קפילוטו"
        : "התייעץ עם קפילוטו";

  return (
    <button
      type="button"
      data-action={expanded ? "collapse" : "expand"}
      data-kapiloto-view={view.kind === "collapsed" ? "collapsed" : undefined}
      aria-expanded={expanded}
      aria-controls={panelId}
      onClick={onToggle}
      className="flex h-10 w-full items-center justify-between rounded-[11px] bg-[var(--kapiloto-surface)] px-3"
    >
      <span className="text-[10px] font-bold text-[var(--text)]">
        {label}
        {cached ? (
          <span className="text-[var(--muted)]">
            {" · "}
            <span dir="ltr">{cached}</span>
            {view.freshness?.state === "stale" ? " · נדרש עדכון" : ""}
          </span>
        ) : null}
      </span>
      <Pill className="bg-[var(--kapiloto)] text-white">{expanded ? "סגור" : "K"}</Pill>
    </button>
  );
}

export function KapilotoPanel(props: PanelProps) {
  const { view, panelId, now, demo } = props;
  if (view.kind === "closed" || view.kind === "collapsed") return null;

  const model = cardModel(view, now);
  const handlers: Record<Action, () => void> = {
    consult: props.onConsult,
    recheck: props.onRecheck,
    retry: props.onRetry,
  };

  return (
    <section
      id={panelId}
      role="region"
      aria-label="ניתוח קפילוטו"
      aria-busy={view.busy}
      data-kapiloto-view={view.kind}
      className="flex w-full flex-col gap-2 rounded-[14px] border border-[var(--kapiloto-border)] bg-gradient-to-r from-[var(--kapiloto-deep)] to-[var(--elevated)] p-3"
    >
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-[11px] font-bold text-white">
          {model.title}
          {demo ? (
            <span className="ms-1.5 text-[9px] font-medium text-[var(--muted)]">· דמו</span>
          ) : null}
        </h3>
        <Pill
          className={`bg-[var(--elevated)] ${TONE_CLASS[model.pill.tone]}`}
          marker={model.pill.marker}
        >
          {model.pill.text}
        </Pill>
      </div>

      {model.lines.length > 0 ? (
        <div aria-live="polite" className="space-y-0.5 text-[10px] leading-[1.6] text-[var(--muted)]">
          {model.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}

      {model.analysis ? <AnalysisDetails analysis={model.analysis} view={view} /> : null}

      {model.priority ? (
        <div className="flex min-h-[30px] items-center justify-between gap-2">
          <span className="text-[10px] font-bold text-[var(--text)]" data-double-recommended>
            {model.priority.label}
          </span>
          <Pill className="bg-[var(--kapiloto)] text-white">
            <span data-double-rank>{model.priority.pill}</span>
          </Pill>
        </div>
      ) : null}

      {model.primary || model.secondary ? (
        <div className="flex min-h-[42px] items-center justify-between gap-2">
          {model.primary ? (
            model.primary.action ? (
              <button
                type="button"
                data-action={model.primary.action}
                onClick={handlers[model.primary.action]}
                className="flex h-[38px] w-[172px] items-center justify-center rounded-xl bg-[var(--kapiloto)] text-[11px] font-bold text-white"
              >
                {model.primary.label}
              </button>
            ) : (
              <div
                className="flex h-[38px] w-[172px] items-center justify-center rounded-xl bg-[var(--kapiloto)] text-[11px] font-bold text-white"
                data-recommendation-badge
              >
                {model.primary.recommendation ? (
                  <>
                    {model.primary.label.split(" · ")[0]}
                    <span aria-hidden className="mx-1">·</span>
                    <span dir="ltr" data-recommendation>
                      {model.primary.recommendation}
                    </span>
                  </>
                ) : (
                  model.primary.label
                )}
              </div>
            )
          ) : (
            <span />
          )}
          {model.secondary ? (
            model.secondary.action ? (
              <button
                type="button"
                data-action={model.secondary.action}
                onClick={handlers[model.secondary.action]}
                className="flex h-[38px] w-[126px] items-center justify-center rounded-xl bg-[var(--elevated)] text-[10px] font-bold text-[var(--text)]"
              >
                {model.secondary.label}
              </button>
            ) : (
              <div
                aria-disabled
                className="flex h-[38px] w-[126px] items-center justify-center rounded-xl bg-[var(--elevated)] text-[10px] font-bold text-[var(--muted)]"
              >
                {model.secondary.label}
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Page note shown under an expanded fixture card (screens 10.2, 10.12–10.14). */
export function KapilotoDoubleContextNote() {
  return (
    <div className="flex flex-col gap-1 rounded-[15px] border border-[var(--border)] bg-[var(--panel)] px-3 py-2.5">
      <p className="text-[10px] font-bold text-[var(--text)]">
        המלצת כפולה מחושבת מול כל המחזור
      </p>
      <p className="text-[8px] text-[var(--muted)]">
        קפילוטו מדרג את ערך הכפולה במשחק הזה ביחס לשאר המשחקים ולמכסה שנותרה בטופס.
      </p>
    </div>
  );
}
