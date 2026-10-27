import { NextResponse } from "next/server";

import { GroupJoinRequestService } from "@/lib/groups/join-requests";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ groupId: string }>;
};

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) return error(401, "unauthorized", "Authentication is required.");

  const { groupId } = await context.params;
  if (!UUID_RE.test(groupId)) {
    return error(400, "invalid_group_id", "groupId must be a UUID.");
  }

  try {
    const requests = await new GroupJoinRequestService(
      createAdminClient(),
    ).listPending(userId, groupId);

    return NextResponse.json({ requests });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    if (message.includes("join_admin_required")) {
      return error(403, "forbidden", "Group administrator access is required.");
    }

    return error(503, "join_requests_unavailable", message);
  }
}
