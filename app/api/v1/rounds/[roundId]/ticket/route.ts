import { NextResponse } from "next/server";

import { TotoTicketService } from "@/lib/ticket-service";
import type { Pick } from "@/lib/toto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ roundId: string }>;
};

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    { status },
  );
}

function isPick(value: unknown): value is Pick {
  return ["1", "X", "2", "1X", "X2", "12"].includes(String(value));
}

function parseGroupId(value: string | null): string {
  if (!value || !UUID_RE.test(value)) {
    throw new Error("groupId must be a UUID.");
  }
  return value;
}

function parseExpectedRevision(value: unknown): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error("expectedRevision must be a non-negative integer.");
  }
  return Number(value);
}

function parsePicks(value: unknown): Array<{ roundGameId: string; pick: Pick }> {
  if (!Array.isArray(value)) {
    throw new Error("picks must be an array.");
  }
  if (value.length > 16) {
    throw new Error("picks may contain at most 16 fixtures.");
  }

  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Each pick must be an object.");
    }

    const row = item as Record<string, unknown>;
    if (
      typeof row.roundGameId !== "string" ||
      !UUID_RE.test(row.roundGameId)
    ) {
      throw new Error("roundGameId must be a UUID.");
    }
    if (!isPick(row.pick)) {
      throw new Error("pick must be 1, X, 2, 1X, X2, or 12.");
    }

    return {
      roundGameId: row.roundGameId,
      pick: row.pick,
    };
  });
}

function mapTicketError(error: unknown): NextResponse {
  const message =
    error instanceof Error ? error.message : "Unexpected ticket error.";

  if (message.includes("ticket_revision_conflict")) {
    return jsonError(409, "revision_conflict", "The ticket changed on another device.");
  }
  if (
    message.includes("ticket_round_locked") ||
    message.includes("ticket_is_locked")
  ) {
    return jsonError(423, "ticket_locked", "The ticket can no longer be edited.");
  }
  if (message.includes("ticket_user_not_active_member")) {
    return jsonError(403, "forbidden", "Active group membership is required.");
  }
  if (
    message.includes("ticket_requires_16_picks") ||
    message.includes("ticket_maximum_doubles_exceeded") ||
    message.includes("ticket_fixture_not_in_round") ||
    message.includes("ticket_invalid_pick_payload") ||
    message.includes("ticket_duplicate_fixture") ||
    message.includes("ticket_too_many_picks") ||
    message.includes("ticket_not_found")
  ) {
    return jsonError(422, "invalid_ticket", message);
  }
  if (
    message.includes("must be a UUID") ||
    message.includes("expectedRevision") ||
    message.includes("picks must") ||
    message.includes("Each pick") ||
    message.includes("pick must")
  ) {
    return jsonError(400, "invalid_request", message);
  }

  return jsonError(503, "ticket_unavailable", message);
}

async function authenticatedService() {
  const userId = await getAuthenticatedUserId();
  if (!userId) return null;

  return {
    userId,
    service: new TotoTicketService(createAdminClient()),
  };
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { roundId } = await context.params;
    if (!UUID_RE.test(roundId)) {
      return jsonError(400, "invalid_round_id", "roundId must be a UUID.");
    }

    const auth = await authenticatedService();
    if (!auth) {
      return jsonError(401, "unauthorized", "Authentication is required.");
    }

    const url = new URL(request.url);
    const groupId = parseGroupId(url.searchParams.get("groupId"));

    const ticket = await auth.service.load(groupId, roundId, auth.userId);
    return NextResponse.json(ticket);
  } catch (error) {
    return mapTicketError(error);
  }
}

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { roundId } = await context.params;
    if (!UUID_RE.test(roundId)) {
      return jsonError(400, "invalid_round_id", "roundId must be a UUID.");
    }

    const auth = await authenticatedService();
    if (!auth) {
      return jsonError(401, "unauthorized", "Authentication is required.");
    }

    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError(400, "invalid_request", "Request body must be an object.");
    }

    const row = body as Record<string, unknown>;
    const groupId = parseGroupId(
      typeof row.groupId === "string" ? row.groupId : null,
    );
    const expectedRevision = parseExpectedRevision(row.expectedRevision);
    const picks = parsePicks(row.picks);

    const result = await auth.service.saveDraft({
      groupId,
      roundId,
      userId: auth.userId,
      expectedRevision,
      picks,
    });

    return NextResponse.json(result);
  } catch (error) {
    return mapTicketError(error);
  }
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

    const auth = await authenticatedService();
    if (!auth) {
      return jsonError(401, "unauthorized", "Authentication is required.");
    }

    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError(400, "invalid_request", "Request body must be an object.");
    }

    const row = body as Record<string, unknown>;
    const groupId = parseGroupId(
      typeof row.groupId === "string" ? row.groupId : null,
    );
    const expectedRevision = parseExpectedRevision(row.expectedRevision);

    const result = await auth.service.submit({
      groupId,
      roundId,
      userId: auth.userId,
      expectedRevision,
    });

    return NextResponse.json(result);
  } catch (error) {
    return mapTicketError(error);
  }
}
