import { EVAL_SAFETY_MARGIN_MINUTES } from "./arms";
import { parseInstant } from "./history";

export const KAPILOTO_SHADOW_CADENCE_VERSION = "kapiloto-shadow-cadence-v1";

export type CadenceWindow = "far" | "mid" | "near" | "final";

export type CadenceConfig = {
  /** Fixtures further away than this are ignored entirely. */
  lookaheadHours: number;
  farIntervalMinutes: number;
  /** Start of the mid window (hours before kickoff). */
  midStartHours: number;
  midIntervalMinutes: number;
  /** Start of the near window (hours before kickoff). */
  nearStartHours: number;
  nearIntervalMinutes: number;
  /**
   * Minutes before the evaluation deadline (kickoff - safety margin) in which
   * one more capture is forced so the last pre-cutoff snapshot is fresh.
   */
  finalWindowMinutes: number;
  /** Tolerance so an hourly scheduler does not drift past an interval. */
  slackMinutes: number;
  retryAfterErrorMinutes: number;
};

export const DEFAULT_CADENCE_CONFIG: CadenceConfig = {
  lookaheadHours: 168,
  farIntervalMinutes: 1440,
  midStartHours: 48,
  midIntervalMinutes: 180,
  nearStartHours: 6,
  nearIntervalMinutes: 60,
  finalWindowMinutes: 75,
  slackMinutes: 10,
  retryAfterErrorMinutes: 60,
};

/**
 * API-Football Free plan (100 requests/day, dates limited to today ±1):
 * one capture at T-24h, one at T-6h and the forced final capture before the
 * deadline. Nothing is attempted further out than the plan can see.
 */
export const FREE_PLAN_CADENCE_CONFIG: CadenceConfig = {
  ...DEFAULT_CADENCE_CONFIG,
  lookaheadHours: 24,
  midStartHours: 24,
  midIntervalMinutes: 1440,
  nearIntervalMinutes: 300,
};

const MINUTE_MS = 60_000;

export function evaluationDeadlineMs(kickoffAt: string): number {
  return parseInstant(kickoffAt, "kickoffAt") - EVAL_SAFETY_MARGIN_MINUTES * MINUTE_MS;
}

/** Window for a fixture at `now`, or null when outside the capture horizon. */
export function cadenceWindow(
  nowMs: number,
  kickoffAt: string,
  config: CadenceConfig = DEFAULT_CADENCE_CONFIG,
): CadenceWindow | null {
  const kickoffMs = parseInstant(kickoffAt, "kickoffAt");
  const deadlineMs = evaluationDeadlineMs(kickoffAt);
  if (nowMs >= deadlineMs) return null;
  const hoursToKickoff = (kickoffMs - nowMs) / 3_600_000;
  if (hoursToKickoff > config.lookaheadHours) return null;
  if (deadlineMs - nowMs <= config.finalWindowMinutes * MINUTE_MS) return "final";
  if (hoursToKickoff <= config.nearStartHours) return "near";
  if (hoursToKickoff <= config.midStartHours) return "mid";
  return "far";
}

function intervalFor(window: CadenceWindow, config: CadenceConfig): number {
  if (window === "far") return config.farIntervalMinutes;
  if (window === "mid") return config.midIntervalMinutes;
  return config.nearIntervalMinutes;
}

export type LastActivity = { at: string; status: string } | null;

export type DueDecision = {
  due: boolean;
  window: CadenceWindow | null;
  reason:
    | "outside_horizon"
    | "never_attempted"
    | "interval_elapsed"
    | "final_snapshot"
    | "retry_after_error"
    | "not_due";
};

/**
 * Whether a fixture needs a new capture (or shadow prediction) now.
 * Budget-skipped attempts do not count as activity.
 */
export function isDue(
  nowMs: number,
  kickoffAt: string,
  last: LastActivity,
  config: CadenceConfig = DEFAULT_CADENCE_CONFIG,
): DueDecision {
  const window = cadenceWindow(nowMs, kickoffAt, config);
  if (!window) return { due: false, window, reason: "outside_horizon" };
  if (!last || last.status === "skipped_budget") {
    return { due: true, window, reason: "never_attempted" };
  }
  const lastMs = parseInstant(last.at, "last.at");
  const elapsedMinutes = (nowMs - lastMs) / MINUTE_MS;

  if (window === "final") {
    const finalStartMs =
      evaluationDeadlineMs(kickoffAt) - config.finalWindowMinutes * MINUTE_MS;
    if (lastMs < finalStartMs) return { due: true, window, reason: "final_snapshot" };
  }
  if (last.status === "error") {
    const retry = Math.min(intervalFor(window, config), config.retryAfterErrorMinutes);
    if (elapsedMinutes >= retry - config.slackMinutes) {
      return { due: true, window, reason: "retry_after_error" };
    }
  }
  if (elapsedMinutes >= intervalFor(window, config) - config.slackMinutes) {
    return { due: true, window, reason: "interval_elapsed" };
  }
  return { due: false, window, reason: "not_due" };
}

const WINDOW_PRIORITY: Record<CadenceWindow, number> = { final: 0, near: 1, mid: 2, far: 3 };

export type CaptureCandidate = {
  fixtureId: string;
  kickoffAt: string;
  window: CadenceWindow;
};

/**
 * Orders due fixtures by urgency (final, near, mid, far; then kickoff, then
 * id) and admits them while the estimated request cost fits the budget.
 */
export function planCaptures(
  candidates: readonly CaptureCandidate[],
  options: { availableRequests: number; requestsPerCapture: number },
): { admitted: CaptureCandidate[]; skipped: CaptureCandidate[] } {
  const ordered = [...candidates].sort(
    (a, b) =>
      WINDOW_PRIORITY[a.window] - WINDOW_PRIORITY[b.window] ||
      Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt) ||
      a.fixtureId.localeCompare(b.fixtureId),
  );
  const admitted: CaptureCandidate[] = [];
  const skipped: CaptureCandidate[] = [];
  let remaining = Math.max(0, Math.floor(options.availableRequests));
  for (const candidate of ordered) {
    if (remaining >= options.requestsPerCapture) {
      admitted.push(candidate);
      remaining -= options.requestsPerCapture;
    } else {
      skipped.push(candidate);
    }
  }
  return { admitted, skipped };
}

/**
 * Simulates an hourly scheduler (at `cronMinute` past each hour) from `fromAt`
 * until every kickoff passes, returning the captures per fixture and window.
 * Used for request-volume estimates; assumes every capture succeeds.
 */
export function simulateCaptureSchedule(
  fixtures: ReadonlyArray<{ fixtureId: string; kickoffAt: string }>,
  options: { fromAt: string; cronMinute: number; config?: CadenceConfig },
): {
  runs: number;
  captures: number;
  byWindow: Record<CadenceWindow, number>;
  perFixture: Record<string, number>;
  capturesPerUtcDay: Record<string, number>;
  lastCaptureMinutesBeforeDeadline: Record<string, number>;
  /**
   * Provider requests if each captured fixture costs one odds request and
   * name-based resolution costs one request per distinct kickoff date per run.
   */
  estimatedRequests: number;
  estimatedRequestsPerUtcDay: Record<string, number>;
  maxRequestsInOneRun: number;
} {
  const config = options.config ?? DEFAULT_CADENCE_CONFIG;
  const startMs = parseInstant(options.fromAt, "fromAt");
  const first = new Date(startMs);
  first.setUTCMinutes(options.cronMinute, 0, 0);
  let tickMs = first.getTime() < startMs ? first.getTime() + 3_600_000 : first.getTime();
  const endMs = Math.max(...fixtures.map((fixture) => evaluationDeadlineMs(fixture.kickoffAt)));

  const last = new Map<string, LastActivity>();
  const byWindow: Record<CadenceWindow, number> = { far: 0, mid: 0, near: 0, final: 0 };
  const perFixture: Record<string, number> = {};
  const perDay: Record<string, number> = {};
  const lastBeforeDeadline: Record<string, number> = {};
  const requestsPerDay: Record<string, number> = {};
  let runs = 0;
  let captures = 0;
  let estimatedRequests = 0;
  let maxRequestsInOneRun = 0;

  for (; tickMs < endMs; tickMs += 3_600_000) {
    runs += 1;
    const at = new Date(tickMs).toISOString();
    const day = at.slice(0, 10);
    const kickoffDates = new Set<string>();
    let runCaptures = 0;
    for (const fixture of fixtures) {
      const decision = isDue(tickMs, fixture.kickoffAt, last.get(fixture.fixtureId) ?? null, config);
      if (!decision.due || !decision.window) continue;
      last.set(fixture.fixtureId, { at, status: "saved" });
      captures += 1;
      runCaptures += 1;
      kickoffDates.add(new Date(fixture.kickoffAt).toISOString().slice(0, 10));
      byWindow[decision.window] += 1;
      perFixture[fixture.fixtureId] = (perFixture[fixture.fixtureId] ?? 0) + 1;
      perDay[day] = (perDay[day] ?? 0) + 1;
      lastBeforeDeadline[fixture.fixtureId] =
        (evaluationDeadlineMs(fixture.kickoffAt) - tickMs) / MINUTE_MS;
    }
    const runRequests = runCaptures + kickoffDates.size;
    estimatedRequests += runRequests;
    if (runRequests > 0) requestsPerDay[day] = (requestsPerDay[day] ?? 0) + runRequests;
    maxRequestsInOneRun = Math.max(maxRequestsInOneRun, runRequests);
  }

  return {
    runs,
    captures,
    byWindow,
    perFixture,
    capturesPerUtcDay: perDay,
    lastCaptureMinutesBeforeDeadline: lastBeforeDeadline,
    estimatedRequests,
    estimatedRequestsPerUtcDay: requestsPerDay,
    maxRequestsInOneRun,
  };
}
