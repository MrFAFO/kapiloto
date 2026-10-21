import { NextResponse } from "next/server";

import { GroupJoinRequestService } from "@/lib/groups/join-requests";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ groupId: string; requestId: string }>;
};

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) return error(401, "unauthorized", "Authentication is required.");

  const { groupId, requestId } = await context.params;
  if (!UUID_RE.test(groupId) || !UUID_RE.test(requestId)) {
    return error(
      400,
      "invalid_identifier",
      "groupId and requestId must be UUIDs.",
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, "invalid_request", "Request body must be valid JSON.");
  }

  const decision =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).decision
      : null;

  if (decision !== "approved" && decision !== "rejected") {
    return error(
      400,
      "invalid_decision",
      "decision must be approved or rejected.",
    );
  }

  try {
    const result = await new GroupJoinRequestService(
      createAdminClient(),
    ).decide(userId, groupId, requestId, decision);

    return NextResponse.json(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    if (message.includes("join_admin_required")) {
      return error(403, "forbidden", "Group administrator access is required.");
    }
    if (message.includes("join_request_not_found")) {
      return error(404, "join_request_not_found", "Join request was not found.");
    }

    return error(503, "join_decision_failed", message);
  }
}
