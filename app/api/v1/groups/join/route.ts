import { NextResponse } from "next/server";

import { GroupBootstrapService } from "@/lib/groups/bootstrap-service";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) return error(401, "unauthorized", "Authentication is required.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, "invalid_request", "Request body must be valid JSON.");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return error(400, "invalid_request", "Request body must be an object.");
  }

  const joinCode = (body as Record<string, unknown>).joinCode;
  if (
    typeof joinCode !== "string" ||
    joinCode.trim().length < 4 ||
    joinCode.trim().length > 32
  ) {
    return error(400, "join_code_invalid", "Join code is invalid.");
  }

  try {
    const result = await new GroupBootstrapService(
      createAdminClient(),
    ).requestJoin(userId, joinCode);

    return NextResponse.json(result, {
      status: result.status === "already_member" ? 200 : 202,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    if (message.includes("join_code_not_found")) {
      return error(404, "join_code_not_found", "Group code was not found.");
    }

    return error(503, "join_request_failed", message);
  }
}
