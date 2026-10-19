import { NextResponse } from "next/server";

import type { KapilotoFixtureEnvelope } from "@/lib/kapiloto/api-types";
import { computeFixtureFreshness } from "@/lib/kapiloto/freshness";
import {
  KapilotoAuthorizationError,
  loadGroupRoundKapilotoContext,
} from "@/lib/kapiloto/group-context";
import {
  parseKapilotoConsultBody,
  requireIdempotencyKey,
} from "@/lib/kapiloto/http-contract";
import { loadPublicFixtureAnalysis } from "@/lib/kapiloto/public-analysis";
import {
  deriveKapilotoApiState,
  type KapilotoFreshness,
  type KapilotoRequestOutcome,
} from "@/lib/kapiloto/response-state";
import { ensureServerKapilotoResearch } from "@/lib/kapiloto/server-research";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ roundId: string }>;
};

function jsonError(
  status: number,
  code: string,
  message: string,
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code,
        message,
      },
    },
    { status },
  );
}

function isKnownOutcome(
  value: string,
): value is KapilotoRequestOutcome {
  return [
    "served_cache",
    "served_newer",
    "joined_run",
    "created_run",
    "refresh_ineligible",
    "limit_reached",
    "round_closed",
    "breaker_open",
  ].includes(value);
}

function analysisRunIdForResponse(
  outcome: KapilotoRequestOutcome,
  currentRunId: string | null | undefined,
  requestRunId: string | null | undefined,
): string | null {
  if (currentRunId) return currentRunId;

  if (outcome === "created_run" || outcome === "joined_run") {
    return null;
  }

  return requestRunId ?? null;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { roundId } = await context.params;
    if (!UUID_RE.test(roundId)) {
      return jsonError(400, "invalid_round_id", "roundId must be a UUID.");
    }

    const idempotencyKey = requireIdempotencyKey(
      request.headers.get("idempotency-key"),
    );

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonError(400, "invalid_json", "Request body must be valid JSON.");
    }

    const body = parseKapilotoConsultBody(rawBody);

    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return jsonError(401, "unauthorized", "Authentication is required.");
    }

    const admin = createAdminClient();

    const { data: roundGame, error: roundGameError } = await admin
      .from("round_games")
      .select("id,round_id,fixture_id")
      .eq("id", body.roundGameId)
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

    const groupContext = await loadGroupRoundKapilotoContext(
      admin,
      userId,
      body.groupId,
      roundId,
    );

    const research = await ensureServerKapilotoResearch(admin, {
      userId: userId,
      roundId,
      roundGameId: body.roundGameId,
      intent: body.intent,
      idempotencyKey,
      basedOnRunId: body.basedOnRunId,
      breakerOpen: false,
    });

    if (!isKnownOutcome(research.outcome)) {
      throw new Error(
        `Unexpected Kapiloto research outcome: ${research.outcome}`,
      );
    }

    const analysisRunId = analysisRunIdForResponse(
      research.outcome,
      research.current_run_id,
      research.run_id,
    );

    const analysis =
      analysisRunId == null
        ? null
        : await loadPublicFixtureAnalysis(
            admin,
            analysisRunId,
            body.roundGameId,
            groupContext.maxDoubles,
          );

    let freshness: KapilotoFreshness = null;
    let staleReasons: string[] = [];

    if (analysis) {
      const fresh = await computeFixtureFreshness(admin, {
        fixtureId: String(roundGame.fixture_id),
        analysisOutcome: analysis.outcome,
        generatedAt: analysis.generatedAt,
        validUntil: analysis.validUntil,
        groupLocked: groupContext.groupLocked,
      });

      freshness = fresh.freshness;
      staleReasons = fresh.staleReasons;
    }

    const derived = deriveKapilotoApiState({
      outcome: research.outcome,
      hasAnalysis: analysis != null,
      freshness,
    });

    const activeRunId =
      research.active_run_id ??
      (research.outcome === "created_run" ||
      research.outcome === "joined_run"
        ? research.run_id ?? null
        : null);

    const response: KapilotoFixtureEnvelope = {
      state: derived.state,
      analysis,
      analysis_run:
        analysisRunId == null
          ? null
          : {
              id: analysisRunId,
            },
      freshness:
        freshness == null
          ? null
          : {
              state: freshness,
              stale_reasons: staleReasons,
            },
      research: {
        active_run_id: activeRunId,
        current_run_id: research.current_run_id ?? null,
        runs_used: research.runs_consumed,
        runs_max: 3,
        runs_remaining: Math.max(0, 3 - research.runs_consumed),
      },
      request: {
        outcome: research.outcome,
        replayed: research.replayed,
        request_id: research.request_id ?? null,
      },
      group: {
        max_doubles: groupContext.maxDoubles,
        locked: groupContext.groupLocked,
      },
      poll:
        derived.state === "researching"
          ? { retry_after_seconds: 3 }
          : null,
    };

    return NextResponse.json(response, {
      status: derived.httpStatus,
      headers:
        derived.state === "researching"
          ? { "Retry-After": "3" }
          : undefined,
    });
  } catch (error) {
    if (error instanceof KapilotoAuthorizationError) {
      return jsonError(403, "forbidden", error.message);
    }

    const message =
      error instanceof Error ? error.message : "Unexpected Kapiloto error.";

    if (message.includes("idempotency key reused")) {
      return jsonError(422, "idempotency_conflict", message);
    }

    if (
      message.includes("must be a UUID") ||
      message.includes("Idempotency-Key") ||
      message.includes("intent must")
    ) {
      return jsonError(400, "invalid_request", message);
    }

    return jsonError(503, "kapiloto_unavailable", message);
  }
}
