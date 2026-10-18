import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  KAPILOTO_RUNS_MAX,
  type KapilotoFixtureEnvelope,
  type KapilotoResearchSummary,
  type KapilotoRoundStateEnvelope,
} from "./api-types";
import { computeFixtureFreshness } from "./freshness";
import {
  KapilotoAuthorizationError,
  loadGroupRoundKapilotoContext,
  type GroupRoundKapilotoContext,
} from "./group-context";
import { loadPublicFixtureAnalysis } from "./public-analysis";
import { deriveKapilotoReadState } from "./response-state";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const POLL_RETRY_AFTER_SECONDS = 3;

/**
 * Read handlers receive their side-effect boundaries explicitly. The admin
 * client is only ever used for SELECTs here: these handlers must never call
 * provider sync, Sol or the create-run RPC.
 */
export type KapilotoReadDeps = {
  getUserId: () => Promise<string | null>;
  getAdmin: () => SupabaseClient;
};

type RoundResearchStateRow = {
  active_run_id: string | null;
  current_run_id: string | null;
  runs_consumed: number;
  research_closed_at: string | null;
  version: number;
};

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-cache",
      ...headers,
    },
  });
}

function jsonError(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

class ReadRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReadRequestError";
  }
}

function requireUuidParam(value: string | null, code: string, field: string) {
  if (!value || !UUID_RE.test(value)) {
    throw new ReadRequestError(400, code, `${field} must be a UUID.`);
  }
  return value;
}

async function authorize(
  request: Request,
  roundId: string,
  deps: KapilotoReadDeps,
): Promise<{
  admin: SupabaseClient;
  groupContext: GroupRoundKapilotoContext;
}> {
  requireUuidParam(roundId, "invalid_round_id", "roundId");
  const groupId = requireUuidParam(
    new URL(request.url).searchParams.get("group_id"),
    "invalid_group_id",
    "group_id query parameter",
  );

  const userId = await deps.getUserId();
  if (!userId) {
    throw new ReadRequestError(401, "unauthorized", "Authentication is required.");
  }

  const admin = deps.getAdmin();
  const groupContext = await loadGroupRoundKapilotoContext(
    admin,
    userId,
    groupId,
    roundId,
  );

  return { admin, groupContext };
}

async function loadRoundResearchState(
  admin: SupabaseClient,
  roundId: string,
): Promise<RoundResearchStateRow> {
  const { data, error } = await admin
    .from("kapiloto_round_research_state")
    .select(
      "active_run_id,current_run_id,runs_consumed,research_closed_at,version",
    )
    .eq("round_id", roundId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Kapiloto round state: ${error.message}`);
  }

  if (!data) {
    return {
      active_run_id: null,
      current_run_id: null,
      runs_consumed: 0,
      research_closed_at: null,
      version: 0,
    };
  }

  return {
    active_run_id: data.active_run_id == null ? null : String(data.active_run_id),
    current_run_id:
      data.current_run_id == null ? null : String(data.current_run_id),
    runs_consumed: Number(data.runs_consumed ?? 0),
    research_closed_at:
      data.research_closed_at == null ? null : String(data.research_closed_at),
    version: Number(data.version ?? 0),
  };
}

function researchSummary(
  state: RoundResearchStateRow,
): Required<KapilotoResearchSummary> {
  return {
    active_run_id: state.active_run_id,
    current_run_id: state.current_run_id,
    runs_used: state.runs_consumed,
    runs_max: KAPILOTO_RUNS_MAX,
    runs_remaining: Math.max(0, KAPILOTO_RUNS_MAX - state.runs_consumed),
    closed: state.research_closed_at != null,
    version: state.version,
  };
}

export function buildFixtureEtag(input: {
  state: string;
  currentRunId: string | null;
  analysisId: string | null;
  freshness: string | null;
  staleReasons: string[];
  activeRunId: string | null;
  runsUsed: number;
  closed: boolean;
  maxDoubles: number;
  groupLocked: boolean;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        input.currentRunId,
        input.analysisId,
        input.freshness,
        input.staleReasons,
        input.state,
        input.activeRunId,
        input.runsUsed,
        input.closed,
        input.maxDoubles,
        input.groupLocked,
      ]),
    )
    .digest("base64url")
    .slice(0, 32);

  return `W/"kap-${digest}"`;
}

export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = strip(etag);

  return ifNoneMatch
    .split(",")
    .some((candidate) => candidate.trim() === "*" || strip(candidate) === target);
}

function handleError(error: unknown, route: string): Response {
  if (error instanceof ReadRequestError) {
    return jsonError(error.status, error.code, error.message);
  }
  if (error instanceof KapilotoAuthorizationError) {
    return jsonError(403, "forbidden", error.message);
  }

  console.error(`[kapiloto] ${route} failed`, error);
  return jsonError(
    503,
    "kapiloto_unavailable",
    "Kapiloto is temporarily unavailable.",
  );
}

export async function handleFixtureAnalysisGet(
  request: Request,
  params: { roundId: string; roundGameId: string },
  deps: KapilotoReadDeps,
): Promise<Response> {
  try {
    const { roundId, roundGameId } = params;
    requireUuidParam(roundGameId, "invalid_round_game_id", "roundGameId");

    const { admin, groupContext } = await authorize(request, roundId, deps);

    const { data: roundGame, error: roundGameError } = await admin
      .from("round_games")
      .select("id,round_id")
      .eq("id", roundGameId)
      .eq("round_id", roundId)
      .maybeSingle();

    if (roundGameError) {
      throw new Error(
        `Failed to validate round fixture: ${roundGameError.message}`,
      );
    }
    if (!roundGame) {
      return jsonError(
        404,
        "fixture_not_found",
        "The requested fixture does not belong to this round.",
      );
    }

    const roundState = await loadRoundResearchState(admin, roundId);
    const research = researchSummary(roundState);

    const analysis =
      roundState.current_run_id == null
        ? null
        : await loadPublicFixtureAnalysis(
            admin,
            roundState.current_run_id,
            roundGameId,
            groupContext.maxDoubles,
          );

    const freshness = analysis
      ? await computeFixtureFreshness(admin, {
          roundGameId,
          analysisOutcome: analysis.outcome,
          generatedAt: analysis.generatedAt,
          validUntil: analysis.validUntil,
          groupLocked: groupContext.groupLocked,
        })
      : null;

    const state = deriveKapilotoReadState({
      hasAnalysis: analysis != null,
      freshness: freshness?.freshness ?? null,
      activeRunId: research.active_run_id,
      runsRemaining: research.runs_remaining,
    });

    const etag = buildFixtureEtag({
      state,
      currentRunId: research.current_run_id,
      analysisId: analysis?.analysisId ?? null,
      freshness: freshness?.freshness ?? null,
      staleReasons: freshness?.staleReasons ?? [],
      activeRunId: research.active_run_id,
      runsUsed: research.runs_used,
      closed: research.closed,
      maxDoubles: groupContext.maxDoubles,
      groupLocked: groupContext.groupLocked,
    });

    const researching = state === "researching";
    const headers: Record<string, string> = { etag };
    if (researching) headers["retry-after"] = String(POLL_RETRY_AFTER_SECONDS);

    if (etagMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, {
        status: 304,
        headers: { ...headers, "cache-control": "private, no-cache" },
      });
    }

    const body: KapilotoFixtureEnvelope = {
      state,
      analysis,
      analysis_run: analysis ? { id: analysis.runId } : null,
      freshness:
        freshness?.freshness == null
          ? null
          : {
              state: freshness.freshness,
              stale_reasons: freshness.staleReasons,
            },
      research,
      group: {
        max_doubles: groupContext.maxDoubles,
        locked: groupContext.groupLocked,
      },
      poll: researching
        ? { retry_after_seconds: POLL_RETRY_AFTER_SECONDS }
        : null,
    };

    return jsonResponse(body, 200, headers);
  } catch (error) {
    return handleError(error, "fixture analysis GET");
  }
}

export async function handleRoundResearchStateGet(
  request: Request,
  params: { roundId: string },
  deps: KapilotoReadDeps,
): Promise<Response> {
  try {
    const { roundId } = params;
    const { admin } = await authorize(request, roundId, deps);

    const research = researchSummary(
      await loadRoundResearchState(admin, roundId),
    );
    const researching = research.active_run_id != null;

    const body: KapilotoRoundStateEnvelope = {
      round_id: roundId,
      research,
      poll: researching
        ? { retry_after_seconds: POLL_RETRY_AFTER_SECONDS }
        : null,
    };

    return jsonResponse(
      body,
      200,
      researching ? { "retry-after": String(POLL_RETRY_AFTER_SECONDS) } : {},
    );
  } catch (error) {
    return handleError(error, "round state GET");
  }
}
