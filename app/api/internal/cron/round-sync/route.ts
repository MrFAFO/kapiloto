import { createAdminClient } from "@/lib/supabase/admin";
import { runAutomaticRoundSync } from "@/lib/rounds/automatic-sync";
import { SupabaseCurrentRoundLoader } from "@/lib/rounds/current-round";
import { runAutomaticLiveSync } from "@/lib/rounds/live-sync";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

type CronStep<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

async function runStep<T>(
  step: string,
  work: () => Promise<T>,
): Promise<CronStep<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Kapiloto cron step failed", { step, error: message });
    return { ok: false, error: message };
  }
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization");

  if (!secret || authorization !== `Bearer ${secret}`) {
    return Response.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const admin = createAdminClient();
  const startedAt = new Date().toISOString();

  await admin
    .from("round_sync_control")
    .update({
      last_started_at: startedAt,
      last_finished_at: null,
      last_status: "round_running",
      last_detail: { kind: "round_sync" },
      updated_at: startedAt,
    })
    .eq("id", 1);

  const roundSync = await runStep("round_sync", () =>
    runAutomaticRoundSync(admin),
  );
  const currentRound = await runStep("current_round", () =>
    new SupabaseCurrentRoundLoader(admin).load(),
  );

  let liveSync: CronStep<unknown> | null = null;
  if (currentRound.ok && currentRound.value) {
    liveSync = await runStep("live_sync", () =>
      runAutomaticLiveSync(admin, currentRound.value!.roundId),
    );
  }

  const steps = [roundSync, currentRound, liveSync]
    .filter((step): step is CronStep<unknown> => step !== null);
  const hasFailure = steps.some((step) => !step.ok);
  const checkedAt = new Date().toISOString();
  const detail = {
    kind: "round_sync",
    roundSync,
    currentRound,
    liveSync,
  };
  const persistedDetail = JSON.parse(JSON.stringify(detail));

  const { error: controlError } = await admin
    .from("round_sync_control")
    .update({
      last_finished_at: checkedAt,
      last_status: hasFailure ? "round_partial_failure" : "round_ok",
      last_detail: persistedDetail,
      updated_at: checkedAt,
    })
    .eq("id", 1);

  if (controlError) {
    console.error("Kapiloto round cron control write failed", {
      error: controlError.message,
    });
  }

  return Response.json(
    {
      ok: !hasFailure,
      checkedAt,
      ...detail,
      observability: {
        controlPersisted: !controlError,
      },
    },
    { status: hasFailure ? 207 : 200 },
  );
}
