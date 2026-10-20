import { createAdminClient } from "@/lib/supabase/admin";
import { runAutomaticRoundSync } from "@/lib/rounds/automatic-sync";

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
    const result = await runAutomaticRoundSync(createAdminClient());
    return Response.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      result,
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
