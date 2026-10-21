import { NextResponse } from "next/server";

import { GroupBootstrapService } from "@/lib/groups/bootstrap-service";
import { loadActiveGroups } from "@/lib/groups/current-group";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) return error(401, "unauthorized", "Authentication is required.");

  try {
    const groups = await loadActiveGroups(createAdminClient(), userId);
    return NextResponse.json({ groups });
  } catch (cause) {
    return error(
      503,
      "groups_unavailable",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
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

  const name = (body as Record<string, unknown>).name;
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
    return error(400, "group_name_invalid", "Group name must be 2–80 characters.");
  }

  try {
    const group = await new GroupBootstrapService(createAdminClient()).create(
      userId,
      name,
    );
    return NextResponse.json(group, { status: 201 });
  } catch (cause) {
    return error(
      503,
      "group_create_failed",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}
