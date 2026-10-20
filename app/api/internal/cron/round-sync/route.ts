import { createAdminClient } from "@/lib/supabase/admin";
import { runAutomaticRoundSync } from "@/lib/rounds/automatic-sync";
import { SupabaseCurrentRoundLoader } from "@/lib/rounds/current-round";
import { runAutomaticLiveSync } from "@/lib/rounds/live-sync";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization");

  if (!secret || authorization !== `Bearer ${secret}`) {
    return Response.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  try {
    const admin = createAdminClient();
    const roundSync = await runAutomaticRoundSync(admin);
    const currentRound = await new SupabaseCurrentRoundLoader(admin).load();
    const liveSync = currentRound
      ? await runAutomaticLiveSync(admin, currentRound.roundId)
      : null;

    return Response.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      roundSync,
      liveSync,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
