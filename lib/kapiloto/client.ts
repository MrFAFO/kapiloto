import type {
  KapilotoFixtureEnvelope,
  KapilotoRoundStateEnvelope,
} from "./api-types";

/**
 * Typed browser client for the Kapiloto HTTP API. It only transports
 * requests: eligibility, budget and freshness are decided server-side.
 */

export type KapilotoFixtureRef = {
  roundId: string;
  roundGameId: string;
  groupId: string | null;
};

export type KapilotoRoundRef = {
  roundId: string;
  groupId: string | null;
};

export type KapilotoRequestOptions = {
  signal?: AbortSignal;
};

export type KapilotoFailure =
  | { kind: "invalid_request"; status: 400; code: string; message: string }
  | { kind: "unauthorized"; status: 401 }
  | { kind: "forbidden"; status: 403 }
  | { kind: "not_found"; status: 404 }
  | { kind: "idempotency_conflict"; status: 422; message: string }
  | { kind: "rate_limited"; status: 429; retryAfterSeconds: number | null }
  | { kind: "unavailable"; status: number; retryAfterSeconds: number | null }
  | { kind: "network_error"; message: string }
  | { kind: "aborted" };

export type KapilotoOk<T> = {
  kind: "ok";
  status: number;
  data: T;
  etag: string | null;
  retryAfterSeconds: number | null;
};

export type KapilotoResult<T> = KapilotoOk<T> | KapilotoFailure;

export type KapilotoActionResult = KapilotoResult<KapilotoFixtureEnvelope> & {
  idempotencyKey: string;
};

export type KapilotoFixtureReadResult =
  | KapilotoResult<KapilotoFixtureEnvelope>
  | { kind: "not_modified"; status: 304; etag: string | null };

export type KapilotoActionOptions = KapilotoRequestOptions & {
  /** Reuse a key to replay the same explicit action (e.g. manual retry). */
  idempotencyKey?: string;
};

export type KapilotoClient = {
  consultFixture(
    ref: KapilotoFixtureRef,
    options?: KapilotoActionOptions,
  ): Promise<KapilotoActionResult>;
  recheckFixture(
    ref: KapilotoFixtureRef & { basedOnRunId: string | null },
    options?: KapilotoActionOptions,
  ): Promise<KapilotoActionResult>;
  getFixtureAnalysis(
    ref: KapilotoFixtureRef,
    options?: KapilotoRequestOptions & { etag?: string | null },
  ): Promise<KapilotoFixtureReadResult>;
  getRoundResearchState(
    ref: KapilotoRoundRef,
    options?: KapilotoRequestOptions,
  ): Promise<KapilotoResult<KapilotoRoundStateEnvelope>>;
};

export type KapilotoClientConfig = {
  fetch?: typeof fetch;
  baseUrl?: string;
  randomUUID?: () => string;
  /** Extra attempts after a transport failure; the idempotency key is reused. */
  maxNetworkRetries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function parseRetryAfter(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

async function readErrorBody(
  response: Response,
): Promise<{ code: string; message: string }> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    return {
      code: typeof body.error?.code === "string" ? body.error.code : "error",
      message:
        typeof body.error?.message === "string" ? body.error.message : "",
    };
  } catch {
    return { code: "error", message: "" };
  }
}

async function toResult<T>(response: Response): Promise<KapilotoResult<T>> {
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));

  if (response.status === 200 || response.status === 202) {
    try {
      return {
        kind: "ok",
        status: response.status,
        data: (await response.json()) as T,
        etag: response.headers.get("etag"),
        retryAfterSeconds,
      };
    } catch {
      return { kind: "unavailable", status: response.status, retryAfterSeconds };
    }
  }

  switch (response.status) {
    case 400: {
      const { code, message } = await readErrorBody(response);
      return { kind: "invalid_request", status: 400, code, message };
    }
    case 401:
      return { kind: "unauthorized", status: 401 };
    case 403:
      return { kind: "forbidden", status: 403 };
    case 404:
      return { kind: "not_found", status: 404 };
    case 422: {
      const { message } = await readErrorBody(response);
      return { kind: "idempotency_conflict", status: 422, message };
    }
    case 429:
      return { kind: "rate_limited", status: 429, retryAfterSeconds };
    default:
      return {
        kind: "unavailable",
        status: response.status,
        retryAfterSeconds,
      };
  }
}

function defaultRandomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export function createKapilotoClient(
  config: KapilotoClientConfig = {},
): KapilotoClient {
  const doFetch: typeof fetch =
    config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = config.baseUrl ?? "";
  const randomUUID = config.randomUUID ?? defaultRandomUUID;
  const maxNetworkRetries = config.maxNetworkRetries ?? 2;
  const sleep = config.sleep ?? abortableSleep;

  const roundPath = (roundId: string) =>
    `${baseUrl}/api/v1/rounds/${encodeURIComponent(roundId)}/kapiloto`;

  async function send(
    url: string,
    init: RequestInit,
    retries: number,
  ): Promise<Response | KapilotoFailure> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await doFetch(url, init);
      } catch (error) {
        if (isAbort(error, init.signal ?? undefined)) return { kind: "aborted" };
        if (attempt >= retries) {
          return {
            kind: "network_error",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        try {
          await sleep(400 * 2 ** attempt, init.signal ?? undefined);
        } catch {
          return { kind: "aborted" };
        }
      }
    }
  }

  async function postAction(
    ref: KapilotoFixtureRef,
    intent: "consult" | "recheck",
    basedOnRunId: string | null,
    options: KapilotoActionOptions,
  ): Promise<KapilotoActionResult> {
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    const response = await send(
      `${roundPath(ref.roundId)}/requests`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          groupId: ref.groupId,
          roundGameId: ref.roundGameId,
          intent,
          basedOnRunId,
        }),
        signal: options.signal,
        credentials: "same-origin",
      },
      maxNetworkRetries,
    );

    if (!(response instanceof Response)) return { ...response, idempotencyKey };
    if (options.signal?.aborted) return { kind: "aborted", idempotencyKey };

    return {
      ...(await toResult<KapilotoFixtureEnvelope>(response)),
      idempotencyKey,
    };
  }

  return {
    consultFixture(ref, options = {}) {
      return postAction(ref, "consult", null, options);
    },

    recheckFixture(ref, options = {}) {
      return postAction(ref, "recheck", ref.basedOnRunId, options);
    },

    async getFixtureAnalysis(ref, options = {}) {
      const groupQuery =
        ref.groupId == null
          ? ""
          : `?group_id=${encodeURIComponent(ref.groupId)}`;
      const url = `${roundPath(ref.roundId)}/fixtures/${encodeURIComponent(
        ref.roundGameId,
      )}${groupQuery}`;
      const response = await send(
        url,
        {
          method: "GET",
          headers: options.etag ? { "if-none-match": options.etag } : {},
          signal: options.signal,
          credentials: "same-origin",
        },
        maxNetworkRetries,
      );

      if (!(response instanceof Response)) return response;
      if (options.signal?.aborted) return { kind: "aborted" };
      if (response.status === 304) {
        return {
          kind: "not_modified",
          status: 304,
          etag: response.headers.get("etag") ?? options.etag ?? null,
        };
      }
      return toResult<KapilotoFixtureEnvelope>(response);
    },

    async getRoundResearchState(ref, options = {}) {
      const response = await send(
        `${roundPath(ref.roundId)}/state${ref.groupId == null
          ? ""
          : `?group_id=${encodeURIComponent(ref.groupId)}`}`,
        {
          method: "GET",
          signal: options.signal,
          credentials: "same-origin",
        },
        maxNetworkRetries,
      );

      if (!(response instanceof Response)) return response;
      if (options.signal?.aborted) return { kind: "aborted" };
      return toResult<KapilotoRoundStateEnvelope>(response);
    },
  };
}

export type KapilotoPollOutcome =
  | { kind: "published"; envelope: KapilotoFixtureEnvelope }
  | { kind: "ended_without_publish"; envelope: KapilotoFixtureEnvelope }
  | { kind: "failed"; failure: Exclude<KapilotoFailure, { kind: "aborted" }> }
  | { kind: "timeout" }
  | { kind: "aborted" };

export type KapilotoPollOptions = {
  signal?: AbortSignal;
  /** current_run_id observed when research started; a change means published. */
  baselineCurrentRunId: string | null;
  initialRetryAfterSeconds?: number | null;
  maxWaitMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

const DEFAULT_POLL_SECONDS = 3;
const MIN_POLL_SECONDS = 1;
const MAX_POLL_SECONDS = 30;

function clampPollSeconds(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_POLL_SECONDS;
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, value));
}

/**
 * Waits for a shared research run to settle using read-only GETs. It never
 * POSTs and never creates idempotency keys, so polling cannot start research.
 */
export async function pollFixtureResearch(
  client: Pick<KapilotoClient, "getFixtureAnalysis" | "getRoundResearchState">,
  ref: KapilotoFixtureRef,
  options: KapilotoPollOptions,
): Promise<KapilotoPollOutcome> {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const maxWaitMs = options.maxWaitMs ?? 30 * 60 * 1000;
  const startedAt = now();
  let delaySeconds = clampPollSeconds(options.initialRetryAfterSeconds);
  let backoffSeconds = DEFAULT_POLL_SECONDS;

  const readFixture = async (
    settle: (envelope: KapilotoFixtureEnvelope) => KapilotoPollOutcome,
  ): Promise<KapilotoPollOutcome> => {
    const fixture = await client.getFixtureAnalysis(ref, {
      signal: options.signal,
    });
    if (fixture.kind === "ok") return settle(fixture.data);
    if (fixture.kind === "aborted") return { kind: "aborted" };
    if (fixture.kind === "not_modified") {
      return {
        kind: "failed",
        failure: { kind: "unavailable", status: 304, retryAfterSeconds: null },
      };
    }
    return { kind: "failed", failure: fixture };
  };

  for (;;) {
    try {
      await sleep(delaySeconds * 1000, options.signal);
    } catch {
      return { kind: "aborted" };
    }
    if (options.signal?.aborted) return { kind: "aborted" };
    if (now() - startedAt > maxWaitMs) return { kind: "timeout" };

    const state = await client.getRoundResearchState(ref, {
      signal: options.signal,
    });

    if (state.kind === "aborted") return { kind: "aborted" };

    if (state.kind === "ok") {
      backoffSeconds = DEFAULT_POLL_SECONDS;
      const research = state.data.research;

      if (
        research.current_run_id != null &&
        research.current_run_id !== options.baselineCurrentRunId
      ) {
        return readFixture((envelope) => ({ kind: "published", envelope }));
      }

      if (research.active_run_id == null) {
        return readFixture((envelope) =>
          envelope.research.current_run_id != null &&
          envelope.research.current_run_id !== options.baselineCurrentRunId
            ? { kind: "published", envelope }
            : { kind: "ended_without_publish", envelope },
        );
      }

      delaySeconds = clampPollSeconds(
        state.retryAfterSeconds ?? state.data.poll?.retry_after_seconds,
      );
      continue;
    }

    if (
      state.kind === "rate_limited" ||
      state.kind === "unavailable" ||
      state.kind === "network_error"
    ) {
      const hinted = "retryAfterSeconds" in state ? state.retryAfterSeconds : null;
      backoffSeconds = Math.min(MAX_POLL_SECONDS, backoffSeconds * 2);
      delaySeconds = clampPollSeconds(hinted ?? backoffSeconds);
      continue;
    }

    return { kind: "failed", failure: state };
  }
}

const defaultClient = createKapilotoClient();

export const consultFixture: KapilotoClient["consultFixture"] = (ref, options) =>
  defaultClient.consultFixture(ref, options);

export const recheckFixture: KapilotoClient["recheckFixture"] = (ref, options) =>
  defaultClient.recheckFixture(ref, options);

export const getFixtureAnalysis: KapilotoClient["getFixtureAnalysis"] = (
  ref,
  options,
) => defaultClient.getFixtureAnalysis(ref, options);

export const getRoundResearchState: KapilotoClient["getRoundResearchState"] = (
  ref,
  options,
) => defaultClient.getRoundResearchState(ref, options);
