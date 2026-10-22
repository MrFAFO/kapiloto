import { createAdminClient } from "@/lib/supabase/admin";
import { syncKapilotoStructuredRound } from "@/lib/kapiloto/structured-data-sync";
import { getApiFootballMinRequestIntervalMs } from "@/lib/kapiloto/research-config";
import { ApiFootballClient } from "@/lib/providers/api-football";
import { SportmonksClient } from "@/lib/providers/sportmonks";
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
    console.error("Kapiloto structured cron control write failed", {
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
  await persistControl(admin, "structured_running", startedAt, null, {
    kind: "structured_sync",
  });

  try {
    const currentRound = await new SupabaseCurrentRoundLoader(admin).load();
    if (!currentRound) {
      const finishedAt = new Date().toISOString();
      const detail = { kind: "structured_sync", error: "current_round_missing" };
      await persistControl(
        admin,
        "structured_failure",
        startedAt,
        finishedAt,
        detail,
      );
      return Response.json({ ok: false, ...detail }, { status: 503 });
    }

    const apiFootballKey = process.env.API_FOOTBALL_API_KEY?.trim();
    const sportmonksToken = process.env.SPORTMONKS_API_TOKEN?.trim();
    const apiFootball = apiFootballKey
      ? new ApiFootballClient(apiFootballKey, {
          minRequestIntervalMs: getApiFootballMinRequestIntervalMs(),
        })
      : null;
    const sportmonks = sportmonksToken
      ? new SportmonksClient(sportmonksToken)
      : null;

    if (!sportmonks && !apiFootball) {
      const finishedAt = new Date().toISOString();
      const detail = {
        kind: "structured_sync",
        roundId: currentRound.roundId,
        error: "provider_keys_missing",
      };
      await persistControl(
        admin,
        "structured_failure",
        startedAt,
        finishedAt,
        detail,
      );
      return Response.json({ ok: false, ...detail }, { status: 503 });
    }

    const result = await syncKapilotoStructuredRound(
      admin,
      currentRound.roundId,
      { sportmonks, apiFootball },
    );
    const finishedAt = new Date().toISOString();
    const saved = result.fixtures.filter((fixture) =>
      fixture.status.startsWith("saved_"),
    ).length;
    const detail = {
      kind: "structured_sync",
      roundId: currentRound.roundId,
      externalRoundNumber: currentRound.externalRoundNumber,
      saved,
      result,
    };
    await persistControl(
      admin,
      saved > 0 ? "structured_ok" : "structured_no_data",
      startedAt,
      finishedAt,
      detail,
    );

    return Response.json({
      ok: saved > 0,
      checkedAt: finishedAt,
      ...detail,
    }, { status: saved > 0 ? 200 : 207 });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const detail = { kind: "structured_sync", error: message };
    await persistControl(
      admin,
      "structured_failure",
      startedAt,
      finishedAt,
      detail,
    );
    console.error("Kapiloto structured cron failed", { error: message });
    return Response.json(
      { ok: false, checkedAt: finishedAt, ...detail },
      { status: 503 },
    );
  }
}
