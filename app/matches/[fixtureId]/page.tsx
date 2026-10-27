import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { KapilotoWordmark } from "@/components/kapiloto-wordmark";
import { MobileAppNav } from "@/components/mobile-app-nav";
import { loadActiveGroups, selectActiveGroup } from "@/lib/groups/current-group";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

const dateTime = new Intl.DateTimeFormat("he-IL", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Jerusalem",
});

const shortTime = new Intl.DateTimeFormat("he-IL", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Jerusalem",
});

function percent(bp: number | null): string {
  if (bp == null) return "—";
  return `${(bp / 100).toFixed(1)}%`;
}

function reliabilityLabel(value: string | null): string {
  switch (value) {
    case "high":
      return "גבוהה";
    case "medium":
      return "בינונית";
    case "low":
      return "נמוכה";
    default:
      return "לא זמינה";
  }
}

function pickLabel(
  pick: string | null,
  home: string,
  away: string,
): string {
  if (pick === "1") return `1 · ${home}`;
  if (pick === "X") return "X · תיקו";
  if (pick === "2") return `2 · ${away}`;
  return "טרם פורסמה";
}

function watchItems(value: unknown): Array<{
  condition: string;
  impact: string;
}> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.condition !== "string") return [];

    const impact =
      record.impact_if_triggered === "favors_home"
        ? "עשוי לחזק את הבית"
        : record.impact_if_triggered === "favors_draw"
          ? "עשוי לחזק תרחיש תיקו"
          : record.impact_if_triggered === "favors_away"
            ? "עשוי לחזק את החוץ"
            : "עשוי לשנות את רמת הוודאות";

    return [{ condition: record.condition, impact }];
  });
}

function availabilityItems(value: unknown): Array<{
  player: string;
  status: string;
  team: string;
}> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.player_name !== "string") return [];

    const status =
      record.status === "out"
        ? "בחוץ"
        : record.status === "doubtful"
          ? "בספק"
          : record.status === "suspended"
            ? "מושעה"
            : record.status === "returning"
              ? "חוזר"
              : record.status === "rotation_risk"
                ? "סיכון לרוטציה"
                : "עדכון סגל";

    return [{
      player: record.player_name,
      status,
      team: record.team === "away" ? "חוץ" : "בית",
    }];
  });
}

function expectedLineup(value: unknown, side: "home" | "away"): {
  status: string;
  formation: string | null;
  starters: Array<{ name: string; position: string; confidence: string }>;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[side];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const starters = Array.isArray(record.starters)
    ? record.starters.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const starter = item as Record<string, unknown>;
        if (typeof starter.player_name !== "string") return [];
        return [{
          name: starter.player_name,
          position:
            typeof starter.position === "string" ? starter.position : "unknown",
          confidence:
            typeof starter.confidence === "string" ? starter.confidence : "low",
        }];
      })
    : [];

  return {
    status: typeof record.status === "string" ? record.status : "insufficient_data",
    formation: typeof record.formation === "string" ? record.formation : null,
    starters,
  };
}

function tacticalFactItems(value: unknown): Array<{
  team: string;
  phase: string;
  attribute: string;
  value: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.team !== "string" ||
      typeof record.phase !== "string" ||
      typeof record.attribute !== "string" ||
      typeof record.value !== "string"
    ) {
      return [];
    }
    return [{
      team: record.team,
      phase: record.phase,
      attribute: record.attribute,
      value: record.value,
    }];
  });
}

function matchupItems(value: unknown): Array<{
  kind: string;
  favors: string;
  magnitude: string;
  description: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.description !== "string") return [];
    return [{
      kind: typeof record.kind === "string" ? record.kind : "matchup",
      favors: typeof record.favors === "string" ? record.favors : "none",
      magnitude:
        typeof record.magnitude === "string" ? record.magnitude : "small",
      description: record.description,
    }];
  });
}

function tacticalLabel(value: string): string {
  const labels: Record<string, string> = {
    possession: "התקפה מסודרת",
    attacking_transition: "מעבר להתקפה",
    defending: "הגנה מסודרת",
    defensive_transition: "מעבר להגנה",
    set_pieces: "מצבים נייחים",
    build_up: "בניית משחק",
    progression: "התקדמות",
    width: "רוחב",
    counter: "מתפרצות",
    outlet: "מוצא למעבר",
    press_height: "גובה לחץ",
    block: "בלוק הגנתי",
    line: "קו הגנה",
    reaction: "תגובה לאיבוד",
    rest_defence: "Rest defence",
    attacking: "התקפי",
    defending_set_piece: "הגנתי",
    aerial: "משחק אווירי",
    short: "קצר",
    mixed: "מעורב",
    direct: "ישיר",
    central: "מרכז",
    wide: "אגפים",
    long: "ארוך",
    narrow: "צר",
    overload_left: "עומס שמאל",
    overload_right: "עומס ימין",
    fast_direct: "מהיר וישיר",
    measured: "מבוקר",
    rare: "נדיר",
    target_forward: "חלוץ מטרה",
    pace_runners: "רצים לעומק",
    none: "ללא יתרון",
    high: "גבוה",
    mid: "בינוני",
    low: "נמוך",
    medium: "בינוני",
    deep: "עמוק",
    counterpress: "לחץ מיד לאחר איבוד",
    retreat: "נסיגה",
    secure: "יציב",
    exposed: "חשוף",
    strong: "חזק",
    average: "ממוצע",
    weak: "חלש",
  };
  return labels[value] ?? value.replaceAll("_", " ");
}

function signalLabel(value: string): string {
  switch (value) {
    case "lineup":
      return "הרכב";
    case "injury":
      return "פציעה";
    case "suspension":
      return "השעיה";
    case "odds_move":
      return "תנועת שוק";
    case "kickoff_change":
      return "שעת משחק";
    case "coach_news":
      return "חדשות מאמן";
    case "weather":
      return "מזג אוויר";
    case "postponement":
      return "דחייה";
    default:
      return value.replaceAll("_", " ");
  }
}

export default async function MatchPage({
  params,
}: {
  params: Promise<{ fixtureId: string }>;
}) {
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");

  const { fixtureId } = await params;
  const admin = createAdminClient();
  const groups = await loadActiveGroups(admin, userId);
  const activeGroup = selectActiveGroup(groups, null);

  const { data: fixture, error: fixtureError } = await admin
    .from("fixtures")
    .select(
      "id,competition_id,home_team_id,away_team_id,kickoff_at,actual_kickoff_at,status,home_score,away_score,neutral_venue",
    )
    .eq("id", fixtureId)
    .maybeSingle();

  if (fixtureError) {
    throw new Error(`Failed to load match: ${fixtureError.message}`);
  }
  if (!fixture) notFound();

  const [
    teamsResult,
    competitionResult,
    intelligenceResult,
    signalsResult,
  ] = await Promise.all([
    admin
      .from("teams")
      .select("id,canonical_name")
      .in("id", [fixture.home_team_id, fixture.away_team_id]),
    fixture.competition_id
      ? admin
          .from("competitions")
          .select("canonical_name")
          .eq("id", fixture.competition_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    admin
      .from("kapiloto_fixture_intelligence_state")
      .select("current_analysis_id,version,updated_at")
      .eq("fixture_id", fixture.id)
      .maybeSingle(),
    admin
      .from("kapiloto_freshness_signals")
      .select("id,signal_type,severity,observed_at")
      .eq("fixture_id", fixture.id)
      .order("observed_at", { ascending: false })
      .limit(6),
  ]);

  if (teamsResult.error) {
    throw new Error(`Failed to load match teams: ${teamsResult.error.message}`);
  }
  if (competitionResult.error) {
    throw new Error(
      `Failed to load match competition: ${competitionResult.error.message}`,
    );
  }
  if (intelligenceResult.error) {
    throw new Error(
      `Failed to load match intelligence state: ${intelligenceResult.error.message}`,
    );
  }
  if (signalsResult.error) {
    throw new Error(
      `Failed to load match updates: ${signalsResult.error.message}`,
    );
  }

  const teamNames = new Map(
    (teamsResult.data ?? []).map((team) => [team.id, team.canonical_name]),
  );
  const home = teamNames.get(fixture.home_team_id) ?? "קבוצת הבית";
  const away = teamNames.get(fixture.away_team_id) ?? "קבוצת החוץ";
  const competition =
    competitionResult.data?.canonical_name ?? "תחרות לא ידועה";

  const analysisId = intelligenceResult.data?.current_analysis_id ?? null;
  let analysis:
    | {
        id: string;
        outcome: string;
        carried_from_analysis_id: string | null;
        p_final_1_bp: number | null;
        p_final_x_bp: number | null;
        p_final_2_bp: number | null;
        reliability: number | null;
        reliability_band: string | null;
        reliability_reasons: unknown;
        primary_pick: string | null;
        suggested_double: string | null;
        summary: string | null;
        main_risk: string | null;
        availability: unknown;
        expected_lineups: unknown;
        tactical_facts: unknown;
        matchup_analysis: unknown;
        regime_changes: unknown;
        watch_items: unknown;
        generated_at: string;
        valid_until: string | null;
      }
    | null = null;
  let factors: Array<{
    id: string;
    dimension: string;
    favors: string;
    magnitude: string;
    rationale: string;
  }> = [];
  let evidence: Array<{
    id: string;
    claim: string;
    domain: string;
    url_canonical: string;
    published_at: string | null;
  }> = [];

  if (analysisId) {
    const analysisResult = await admin
      .from("kapiloto_analyses")
      .select(
        "id,outcome,carried_from_analysis_id,p_final_1_bp,p_final_x_bp,p_final_2_bp,reliability,reliability_band,reliability_reasons,primary_pick,suggested_double,summary,main_risk,availability,expected_lineups,tactical_facts,matchup_analysis,regime_changes,watch_items,generated_at,valid_until",
      )
      .eq("id", analysisId)
      .eq("fixture_id", fixture.id)
      .maybeSingle();

    if (analysisResult.error) {
      throw new Error(
        `Failed to load current match analysis: ${analysisResult.error.message}`,
      );
    }

    analysis = analysisResult.data;

    if (analysisResult.data) {
      const contentAnalysisId =
        analysisResult.data.carried_from_analysis_id ?? analysisId;
      const [factorsResult, evidenceResult] = await Promise.all([
        admin
          .from("kapiloto_factors")
          .select("id,dimension,favors,magnitude,rationale")
          .eq("analysis_id", contentAnalysisId)
          .limit(5),
        admin
          .from("kapiloto_evidence")
          .select("id,claim,domain,url_canonical,published_at")
          .eq("analysis_id", contentAnalysisId)
          .eq("status", "accepted")
          .order("trust_tier", { ascending: false, nullsFirst: false })
          .limit(5),
      ]);

      if (factorsResult.error) {
        throw new Error(
          `Failed to load match factors: ${factorsResult.error.message}`,
        );
      }
      if (evidenceResult.error) {
        throw new Error(
          `Failed to load match evidence: ${evidenceResult.error.message}`,
        );
      }

      factors = factorsResult.data ?? [];
      evidence = evidenceResult.data ?? [];
    }
  }

  const availability = availabilityItems(analysis?.availability);
  const homeLineup = expectedLineup(analysis?.expected_lineups, "home");
  const awayLineup = expectedLineup(analysis?.expected_lineups, "away");
  const tacticalFacts = tacticalFactItems(analysis?.tactical_facts);
  const matchups = matchupItems(analysis?.matchup_analysis);
  const watches = watchItems(analysis?.watch_items);
  const hasProbabilities =
    analysis?.p_final_1_bp != null &&
    analysis.p_final_x_bp != null &&
    analysis.p_final_2_bp != null;

  const kickoff = new Date(fixture.actual_kickoff_at ?? fixture.kickoff_at);
  const score =
    fixture.home_score != null && fixture.away_score != null
      ? `${fixture.home_score}–${fixture.away_score}`
      : null;

  return (
    <div
      dir="rtl"
      className="mx-auto min-h-screen w-full max-w-[430px] bg-[var(--canvas)] pb-[84px] text-[var(--text)]"
    >
      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--canvas)]/95 px-[18px] py-3 backdrop-blur">
        <div className="flex items-center justify-between">
          <Link
            href="/tickets/toto"
            className="rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-[9px] font-bold text-[var(--muted)]"
          >
            חזרה לטוטו
          </Link>
          <KapilotoWordmark />
          <span className="w-[72px]" aria-hidden="true" />
        </div>
      </header>

      <main className="flex flex-col gap-3 px-[18px] py-4">
        <section className="rounded-[20px] border border-[var(--border)] bg-[var(--panel)] p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[9px] font-bold text-[var(--kapiloto)]">
                MATCH INTELLIGENCE
              </p>
              <p className="mt-1 text-[9px] text-[var(--muted)]">
                {competition} · {dateTime.format(kickoff)}
              </p>
            </div>
            <span className="rounded-full bg-[var(--elevated)] px-2.5 py-1.5 text-[9px] font-bold text-[var(--muted)]">
              {fixture.status === "live"
                ? "חי"
                : fixture.status === "halftime"
                  ? "מחצית"
                  : fixture.status === "finished"
                    ? "הסתיים"
                    : "לפני משחק"}
            </span>
          </div>

          <div className="mt-5 grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center">
            <div>
              <p className="text-[15px] font-bold">{home}</p>
              <p className="mt-1 text-[8px] text-[var(--muted)]">בית</p>
            </div>
            <div className="min-w-14 text-center">
              <p className="text-[21px] font-black">{score ?? "—"}</p>
              {fixture.neutral_venue ? (
                <p className="mt-1 text-[8px] text-[var(--muted)]">מגרש ניטרלי</p>
              ) : null}
            </div>
            <div>
              <p className="text-[15px] font-bold">{away}</p>
              <p className="mt-1 text-[8px] text-[var(--muted)]">חוץ</p>
            </div>
          </div>
        </section>

        {!analysis ? (
          <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
            <p className="text-[12px] font-bold">טרם פורסם ניתוח קפילוטו</p>
            <p className="mt-2 text-[9px] leading-5 text-[var(--muted)]">
              העמוד הזה מיועד לצפייה בלבד. מחקר חדש מופעל רק ברמת מחזור
              Winner 16 המשותף לכל המשתמשים. כשהמחקר המרכזי יפורסם,
              ההסתברויות, הגורמים, הסיכון והמקורות יופיעו כאן אוטומטית.
            </p>
          </section>
        ) : (
          <>
            <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[9px] font-bold text-[var(--kapiloto)]">
                    פסק הדין של קפילוטו
                  </p>
                  <p className="mt-1 text-[17px] font-black">
                    {pickLabel(analysis.primary_pick, home, away)}
                  </p>
                  {analysis.suggested_double ? (
                    <p className="mt-1 text-[9px] font-bold text-[var(--diego)]">
                      כפולה מוצעת · {analysis.suggested_double}
                    </p>
                  ) : null}
                </div>
                <div className="text-left">
                  <p className="text-[8px] text-[var(--muted)]">אמינות</p>
                  <p className="text-[11px] font-bold">
                    {reliabilityLabel(analysis.reliability_band)}
                  </p>
                  {analysis.reliability != null ? (
                    <p className="text-[8px] text-[var(--muted)]">
                      {analysis.reliability}/100
                    </p>
                  ) : null}
                </div>
              </div>

              {analysis.outcome === "carried_forward" ? (
                <p className="mt-3 rounded-lg bg-[var(--elevated)] px-3 py-2 text-[8px] font-bold text-[var(--muted)]">
                  הניתוח נשמר מהגרסה הקודמת משום שלא היה בטוח לבצע מחקר חדש.
                </p>
              ) : analysis.outcome === "research_unavailable" ? (
                <p className="mt-3 rounded-lg bg-[var(--elevated)] px-3 py-2 text-[8px] font-bold text-[var(--muted)]">
                  מחקר חדש לא היה זמין למשחק הזה בסבב הנוכחי.
                </p>
              ) : null}

              {analysis.summary ? (
                <p className="mt-3 text-[10px] leading-5 text-[var(--text)]">
                  {analysis.summary}
                </p>
              ) : null}

              {hasProbabilities ? (
                <div className="mt-4">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {[
                      ["1", percent(analysis.p_final_1_bp), home],
                      ["X", percent(analysis.p_final_x_bp), "תיקו"],
                      ["2", percent(analysis.p_final_2_bp), away],
                    ].map(([key, value, label]) => (
                      <div
                        key={key}
                        className="rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-2.5"
                      >
                        <p className="text-[8px] text-[var(--muted)]">{label}</p>
                        <p className="mt-1 text-[14px] font-black">{value}</p>
                        <p className="mt-0.5 text-[9px] font-bold text-[var(--kapiloto)]">
                          {key}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <p className="mt-3 text-[8px] text-[var(--muted)]">
                עודכן {shortTime.format(new Date(analysis.generated_at))}
                {analysis.valid_until
                  ? ` · תקף עד ${shortTime.format(new Date(analysis.valid_until))}`
                  : ""}
              </p>
            </section>

            {factors.length > 0 ? (
              <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
                <p className="text-[11px] font-bold">הגורמים המרכזיים</p>
                <div className="mt-3 flex flex-col gap-2">
                  {factors.map((factor, index) => (
                    <div
                      key={factor.id}
                      className="rounded-xl bg-[var(--elevated)] p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[9px] font-bold text-[var(--kapiloto)]">
                          #{index + 1}
                        </span>
                        <span className="text-[8px] text-[var(--muted)]">
                          {factor.magnitude === "large"
                            ? "השפעה גבוהה"
                            : factor.magnitude === "medium"
                              ? "השפעה בינונית"
                              : "השפעה נמוכה"}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[9px] leading-5">{factor.rationale}</p>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {availability.length > 0 ? (
              <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
                <p className="text-[11px] font-bold">חיסורים וזמינות</p>
                <div className="mt-3 flex flex-col gap-2">
                  {availability.slice(0, 6).map((item, index) => (
                    <div
                      key={`${item.player}-${index}`}
                      className="flex items-center justify-between rounded-xl bg-[var(--elevated)] px-3 py-2.5"
                    >
                      <div>
                        <p className="text-[9px] font-bold">{item.player}</p>
                        <p className="text-[8px] text-[var(--muted)]">
                          {item.team}
                        </p>
                      </div>
                      <span className="text-[8px] font-bold text-[var(--diego)]">
                        {item.status}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {(homeLineup?.starters.length ?? 0) > 0 ||
            (awayLineup?.starters.length ?? 0) > 0 ||
            homeLineup?.formation ||
            awayLineup?.formation ? (
              <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
                <p className="text-[11px] font-bold">הרכבים ומערכים צפויים</p>
                <p className="mt-1 text-[8px] leading-4 text-[var(--muted)]">
                  מוצגים רק פרטים שעברו אימות מקורות. הרכב חלקי אינו מושלם באמצעות ניחוש.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {[
                    [home, homeLineup],
                    [away, awayLineup],
                  ].map(([team, lineup]) => {
                    const typed = lineup as ReturnType<typeof expectedLineup>;
                    return (
                      <div
                        key={String(team)}
                        className="min-w-0 rounded-xl bg-[var(--elevated)] p-3"
                      >
                        <p className="break-words text-[9px] font-bold">{String(team)}</p>
                        <p className="mt-1 text-[8px] text-[var(--kapiloto)]">
                          {typed?.formation
                            ? `מערך ${typed.formation}`
                            : "מערך לא מאומת"}
                        </p>
                        <p className="mt-0.5 text-[8px] text-[var(--muted)]">
                          {typed?.status === "supported"
                            ? "הרכב מלא מאומת"
                            : typed?.status === "partial"
                              ? "הרכב חלקי"
                              : "אין הרכב מאומת"}
                        </p>
                        <div className="mt-2 flex flex-col gap-1">
                          {(typed?.starters ?? []).map((starter) => (
                            <p
                              key={starter.name}
                              dir="auto"
                              className="break-words text-[8px] leading-4 text-[var(--muted)]"
                            >
                              {starter.position} · {starter.name}
                            </p>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {tacticalFacts.length > 0 ? (
              <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
                <p className="text-[11px] font-bold">פרופיל טקטי מאומת</p>
                <div className="mt-3 flex flex-col gap-2">
                  {tacticalFacts.map((fact, index) => (
                    <div
                      key={`${fact.team}-${fact.phase}-${fact.attribute}-${index}`}
                      className="rounded-xl bg-[var(--elevated)] p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[8px] font-bold text-[var(--kapiloto)]">
                          {fact.team === "home" ? home : away}
                        </span>
                        <span className="text-[8px] text-[var(--muted)]">
                          {tacticalLabel(fact.phase)}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[9px]">
                        {tacticalLabel(fact.attribute)} · {tacticalLabel(fact.value)}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {matchups.length > 0 ? (
              <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
                <p className="text-[11px] font-bold">מאצ׳אפים טקטיים</p>
                <div className="mt-3 flex flex-col gap-2">
                  {matchups.map((matchup, index) => (
                    <div
                      key={`${matchup.kind}-${index}`}
                      className="rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[8px] text-[var(--muted)]">
                          {tacticalLabel(matchup.kind)}
                        </span>
                        <span className="text-[8px] font-bold text-[var(--kapiloto)]">
                          {matchup.favors === "home"
                            ? `יתרון ${home}`
                            : matchup.favors === "away"
                              ? `יתרון ${away}`
                              : matchup.favors === "draw"
                                ? "תומך בתיקו"
                                : "ללא יתרון מובהק"}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[9px] leading-5">
                        {matchup.description}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
              <p className="text-[11px] font-bold">הסיכון המרכזי</p>
              <p className="mt-2 text-[9px] leading-5 text-[var(--muted)]">
                {analysis.main_risk ?? "לא פורסם סיכון מרכזי בניתוח הנוכחי."}
              </p>
            </section>

            {watches.length > 0 ? (
              <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
                <p className="text-[11px] font-bold">מה יכול לשנות את ההערכה</p>
                <div className="mt-3 flex flex-col gap-2">
                  {watches.map((item, index) => (
                    <div
                      key={`${item.condition}-${index}`}
                      className="rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-3"
                    >
                      <p className="text-[9px] font-medium">{item.condition}</p>
                      <p className="mt-1 text-[8px] font-bold text-[var(--kapiloto)]">
                        {item.impact}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {evidence.length > 0 ? (
              <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
                <p className="text-[11px] font-bold">מקורות</p>
                <div className="mt-3 flex flex-col gap-2">
                  {evidence.map((item) => (
                    <a
                      key={item.id}
                      href={item.url_canonical}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-xl bg-[var(--elevated)] p-3 transition-colors hover:bg-[var(--border)]"
                    >
                      <p className="text-[9px] leading-5">{item.claim}</p>
                      <p className="mt-1 text-[8px] text-[var(--muted)]">
                        {item.domain}
                        {item.published_at
                          ? ` · ${shortTime.format(new Date(item.published_at))}`
                          : ""}
                      </p>
                    </a>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}

        {(signalsResult.data ?? []).length > 0 ? (
          <section className="rounded-[18px] border border-[var(--border)] bg-[var(--panel)] p-4">
            <p className="text-[11px] font-bold">ציר עדכונים</p>
            <div className="mt-3 flex flex-col gap-2">
              {(signalsResult.data ?? []).map((signal) => (
                <div
                  key={signal.id}
                  className="flex items-center justify-between gap-3 rounded-xl bg-[var(--elevated)] px-3 py-2.5"
                >
                  <div>
                    <p className="text-[9px] font-bold">
                      {signalLabel(signal.signal_type)}
                    </p>
                    <p className="text-[8px] text-[var(--muted)]">
                      {shortTime.format(new Date(signal.observed_at))}
                    </p>
                  </div>
                  <span className="text-[8px] font-bold text-[var(--kapiloto)]">
                    חשיבות {signal.severity}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="rounded-[18px] border border-dashed border-[var(--border)] bg-[var(--panel)] p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold">Winner · תצוגת שווקים</p>
              <p className="mt-1 text-[8px] leading-4 text-[var(--muted)]">
                שכבת Winner תשתמש באותו Match Intelligence. בשלב הזה איננו
                מציגים קטלוג שווקים או המלצות שאין להן מודל ודאטה מאומתים.
              </p>
            </div>
            <span className="rounded-full bg-[var(--elevated)] px-2.5 py-1.5 text-[8px] font-bold text-[var(--muted)]">
              בהכנה
            </span>
          </div>
        </section>
      </main>
      <MobileAppNav active="matches" groupId={activeGroup?.groupId ?? null} />
    </div>
  );
}