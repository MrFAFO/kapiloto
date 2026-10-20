import { NextResponse } from "next/server";

import { runAutomaticLiveSync } from "@/lib/rounds/live-sync";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ roundId: string }>;
};

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Authentication is required." } },
      { status: 401 },
    );
  }

  const { roundId } = await context.params;
  if (!UUID_RE.test(roundId)) {
    return NextResponse.json(
      { error: { code: "invalid_round_id", message: "roundId must be a UUID." } },
      { status: 400 },
    );
  }

  try {
    const result = await runAutomaticLiveSync(createAdminClient(), roundId);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "live_sync_unavailable",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 503 },
    );
  }
}
