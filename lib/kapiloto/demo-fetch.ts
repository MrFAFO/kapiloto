import {
  KAPILOTO_RUNS_MAX,
  type KapilotoFixtureEnvelope,
  type KapilotoPublicFixtureAnalysis,
  type KapilotoRoundStateEnvelope,
} from "./api-types";

/**
 * Deterministic in-memory stand-in for the Kapiloto HTTP API, for local UI
 * development only. It speaks the same wire contract as the real routes so
 * the typed client, idempotency and polling paths are exercised unchanged.
 * It never performs network, Supabase or Sol calls.
 */

export const KAPILOTO_DEMO_SCENARIOS = [
  "unresearched",
  "fresh",
  "stale",
  "shared",
  "exhausted",
  "error",
  "rate_limited",
] as const;

export type KapilotoDemoScenario = (typeof KAPILOTO_DEMO_SCENARIOS)[number];

export function parseKapilotoDemoScenario(
  value: string | null | undefined,
): KapilotoDemoScenario {
  return KAPILOTO_DEMO_SCENARIOS.includes(value as KapilotoDemoScenario)
    ? (value as KapilotoDemoScenario)
    : "unresearched";
}

export type KapilotoDemoConfig = {
  scenario: KapilotoDemoScenario;
  roundId: string;
  roundGameIds: string[];
  maxDoubles?: number;
  latencyMs?: number;
  /** Number of state polls before an active run settles. */
  pollsPerRun?: number;
  now?: () => number;
};

type DemoRun = { id: string; seq: number; publishedAt: number };

const PICKS = ["1", "X", "2"] as const;
const DOUBLES = { "1": "1X", X: "X2", "2": "X2" } as const;
const BANDS = ["high", "medium", "low", "medium"] as const;

const SUMMARIES = [
  "המארחת בכושר ביתי יציב ומגיעה עם הרכב כמעט מלא; היתרון מתון אך עקבי.",
  "שתי קבוצות עם מאזן דומה בחודש האחרון; מגמת שערים נמוכה מעלה את סיכוי התיקו.",
  "האורחת חזקה יותר בנתוני יצירת מצבים, אך עומס משחקים עלול לשחוק אותה.",
  "משחק פתוח עם שונות גבוהה; הנתונים אינם מכריעים בבירור לטובת צד אחד.",
];

const RISKS = [
  "היעדרות אפשרית של בלם מרכזי שטרם אושרה רשמית.",
  "רוטציה צפויה לקראת משחק אירופי באמצע השבוע.",
  "שינוי מאמן לאחרונה מקשה להסתמך על נתוני העבר.",
  "תנאי מזג אוויר צפויים לפגוע בקצב המשחק.",
];

function demoUuid(prefix: number, index: number): string {
  const tail = index.toString(16).padStart(12, "0");
  const head = prefix.toString(16).padStart(8, "0");
  return `${head}-0000-4000-8000-${tail}`;
}

export function createKapilotoDemoFetch(config: KapilotoDemoConfig): typeof fetch {
  const now = config.now ?? Date.now;
  const latencyMs = config.latencyMs ?? 250;
  const pollsPerRun = config.pollsPerRun ?? 2;
  const maxDoubles = config.maxDoubles ?? 7;
  const scenario = config.scenario;

  let runsUsed = 0;
  let current: DemoRun | null = null;
  let active: (DemoRun & { pollsLeft: number; fails: boolean }) | null = null;
  let stale = false;
  let version = 0;
  let nextSeq = 1;
  const requests = new Map<string, string>();

  const newRun = (): DemoRun => {
    const seq = nextSeq;
    nextSeq += 1;
    return { id: demoUuid(0xdead, seq), seq, publishedAt: now() };
  };

  if (scenario === "fresh" || scenario === "stale") {
    current = newRun();
    runsUsed = 1;
    stale = scenario === "stale";
  } else if (scenario === "exhausted") {
    newRun();
    newRun();
    current = newRun();
    runsUsed = 3;
    stale = true;
  } else if (scenario === "shared") {
    active = { ...newRun(), pollsLeft: pollsPerRun + 1, fails: false };
    runsUsed = 1;
  }

  const startRun = () => {
    active = { ...newRun(), pollsLeft: pollsPerRun, fails: scenario === "error" };
    runsUsed += 1;
    version += 1;
  };

  const tick = () => {
    if (!active) return;
    active.pollsLeft -= 1;
    if (active.pollsLeft > 0) return;
    if (!active.fails) {
      current = { id: active.id, seq: active.seq, publishedAt: now() };
      stale = false;
    }
    active = null;
    version += 1;
  };

  const analysisFor = (
    run: DemoRun,
    index: number,
  ): KapilotoPublicFixtureAnalysis => {
    const shift = run.seq > 1 && index % 3 === 0 ? run.seq - 1 : 0;
    const primaryPick = PICKS[(index + shift) % PICKS.length];
    const rank = ((index * 7 + run.seq * (shift ? 3 : 0)) % 16) + 1;
    return {
      analysisId: demoUuid(0xa1a1, run.seq * 100 + index),
      runId: run.id,
      outcome: "analyzed",
      primaryPick,
      suggestedDouble: DOUBLES[primaryPick],
      doublePriorityRank: rank,
      doubleRecommended: rank <= maxDoubles,
      reliabilityBand: BANDS[index % BANDS.length],
      summary: `[דמו] ${SUMMARIES[(index + shift) % SUMMARIES.length]}`,
      mainRisk: RISKS[index % RISKS.length],
      generatedAt: new Date(run.publishedAt).toISOString(),
      validUntil: new Date(run.publishedAt + 6 * 3600_000).toISOString(),
    };
  };

  const research = (): KapilotoRoundStateEnvelope["research"] => ({
    active_run_id: active?.id ?? null,
    current_run_id: current?.id ?? null,
    runs_used: runsUsed,
    runs_max: KAPILOTO_RUNS_MAX,
    runs_remaining: Math.max(0, KAPILOTO_RUNS_MAX - runsUsed),
    closed: false,
    version,
  });

  const fixtureEnvelope = (roundGameId: string): KapilotoFixtureEnvelope => {
    const index = config.roundGameIds.indexOf(roundGameId);
    const analysis = current ? analysisFor(current, index) : null;
    const researching = active != null;
    const r = research();
    return {
      state: researching
        ? "researching"
        : analysis
          ? stale
            ? "stale"
            : "ready"
          : r.runs_remaining <= 0
            ? "limit_reached"
            : "unresearched",
      analysis,
      analysis_run: analysis ? { id: analysis.runId } : null,
      freshness: analysis
        ? {
            state: stale ? "stale" : "fresh",
            stale_reasons: stale
              ? [index % 2 === 0 ? "ttl_expired" : "signal:lineup_change"]
              : [],
          }
        : null,
      research: r,
      group: { max_doubles: maxDoubles, locked: false },
      poll: researching ? { retry_after_seconds: 1 } : null,
    };
  };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const handlePost = (
    roundGameId: string,
    body: { intent?: string; basedOnRunId?: string | null },
    key: string,
  ): Response => {
    if (scenario === "rate_limited") {
      return json(
        { error: { code: "rate_limited", message: "Too many requests." } },
        429,
        { "retry-after": "20" },
      );
    }

    const replayed = requests.has(key);
    let outcome = requests.get(key);

    if (!outcome) {
      if (active) outcome = "joined_run";
      else if (body.intent === "consult") {
        if (current) outcome = "served_cache";
        else if (runsUsed >= KAPILOTO_RUNS_MAX) outcome = "limit_reached";
        else {
          startRun();
          outcome = "created_run";
        }
      } else if (body.basedOnRunId && current && body.basedOnRunId !== current.id) {
        outcome = "served_newer";
      } else if (runsUsed >= KAPILOTO_RUNS_MAX) {
        outcome = "limit_reached";
      } else if (!stale) {
        outcome = "refresh_ineligible";
      } else {
        startRun();
        outcome = "created_run";
      }
      requests.set(key, outcome);
    }

    const envelope = fixtureEnvelope(roundGameId);
    if (outcome === "limit_reached" && envelope.state !== "ready") {
      envelope.state = "limit_reached";
    }
    const researching = envelope.state === "researching";

    return json(
      {
        ...envelope,
        request: {
          outcome,
          replayed,
          request_id: demoUuid(0xbeef, requests.size),
        },
      },
      researching ? 202 : 200,
      researching ? { "retry-after": "1" } : {},
    );
  };

  return async (input, init) => {
    const signal = init?.signal ?? undefined;
    if (latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, latencyMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    }

    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "http://demo.local",
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const base = `/api/v1/rounds/${config.roundId}/kapiloto`;

    if (method === "POST" && url.pathname === `${base}/requests`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        roundGameId?: string;
        intent?: string;
        basedOnRunId?: string | null;
      };
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      if (!body.roundGameId || !config.roundGameIds.includes(body.roundGameId)) {
        return json({ error: { code: "fixture_not_found", message: "" } }, 404);
      }
      return handlePost(body.roundGameId, body, key);
    }

    if (method === "GET" && url.pathname === `${base}/state`) {
      tick();
      const r = research();
      return json(
        {
          round_id: config.roundId,
          research: r,
          poll: r.active_run_id ? { retry_after_seconds: 1 } : null,
        } satisfies KapilotoRoundStateEnvelope,
        200,
        r.active_run_id ? { "retry-after": "1" } : {},
      );
    }

    const fixturePrefix = `${base}/fixtures/`;
    if (method === "GET" && url.pathname.startsWith(fixturePrefix)) {
      const roundGameId = url.pathname.slice(fixturePrefix.length);
      if (!config.roundGameIds.includes(roundGameId)) {
        return json({ error: { code: "fixture_not_found", message: "" } }, 404);
      }
      const envelope = fixtureEnvelope(roundGameId);
      return json(
        envelope,
        200,
        envelope.state === "researching" ? { "retry-after": "1" } : {},
      );
    }

    return json({ error: { code: "not_found", message: "" } }, 404);
  };
}
