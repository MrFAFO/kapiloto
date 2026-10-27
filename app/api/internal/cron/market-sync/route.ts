import { createAdminClient } from "@/lib/supabase/admin";
import { getApiFootballMinRequestIntervalMs } from "@/lib/kapiloto/research-config";
import { ApiFootballClient } from "@/lib/providers/api-football";
import { SupabaseApiFootballSyncStore } from "@/lib/providers/api-football-supabase-store";
import { syncApiFootballRoundMarket } from "@/lib/providers/api-football-sync";
import { SupabaseCurrentRoundLoader } from "@/lib/rounds/current-round";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function persistControl(
  admin: ReturnType<typeof createAdminClient>,
  status: string,
  startedAt: string,
  finishedAt: string | null,
  detail: unknown,
): Promise<void> {
  const { error } = await admin
    .from("round_sync_control")
    .update({
      last_started_at: startedAt,
      last_finished_at: finishedAt,
      last_status: status,
      last_detail: JSON.parse(JSON.stringify(detail)),
      updated_at: finishedAt ?? startedAt,
    })
    .eq("id", 1);

  if (error) {
    console.error("Kapiloto market cron control write failed", {
      error: error.message,
    });
  }
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const startedAt = new Date().toISOString();
  await persistControl(admin, "market_running", startedAt, null, {
    kind: "market_sync",
  });

  try {
    const currentRound = await new SupabaseCurrentRoundLoader(admin).load();
    if (!currentRound) {
      const finishedAt = new Date().toISOString();
      const detail = { kind: "market_sync", error: "current_round_missing" };
      await persistControl(admin, "market_failure", startedAt, finishedAt, detail);
      return Response.json({ ok: false, ...detail }, { status: 503 });
    }

    const apiFootballKey = process.env.API_FOOTBALL_API_KEY?.trim();
    if (!apiFootballKey) {
      const finishedAt = new Date().toISOString();
      const detail = {
        kind: "market_sync",
        roundId: currentRound.roundId,
        error: "API_FOOTBALL_API_KEY_missing",
      };
      await persistControl(admin, "market_failure", startedAt, finishedAt, detail);
      return Response.json({ ok: false, ...detail }, { status: 503 });
    }

    const apiFootball = new ApiFootballClient(apiFootballKey, {
      minRequestIntervalMs: getApiFootballMinRequestIntervalMs(),
    });
    const result = await syncApiFootballRoundMarket(
      new SupabaseApiFootballSyncStore(admin),
      apiFootball,
      currentRound.roundId,
    );
    const finishedAt = new Date().toISOString();
    const detail = {
      kind: "market_sync",
      roundId: currentRound.roundId,
      externalRoundNumber: currentRound.externalRoundNumber,
      result,
    };
    await persistControl(
      admin,
      result.summary.saved > 0 ? "market_ok" : "market_no_data",
      startedAt,
      finishedAt,
      detail,
    );

    return Response.json({
      ok: result.summary.saved > 0,
      checkedAt: finishedAt,
      ...detail,
    }, { status: result.summary.saved > 0 ? 200 : 207 });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const detail = { kind: "market_sync", error: message };
    await persistControl(admin, "market_failure", startedAt, finishedAt, detail);
    console.error("Kapiloto market cron failed", { error: message });
    return Response.json(
      { ok: false, checkedAt: finishedAt, ...detail },
      { status: 503 },
    );
  }
}
