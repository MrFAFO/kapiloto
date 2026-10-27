import type { SupabaseClient } from "@supabase/supabase-js";

import type { KapilotoFreshness } from "./response-state";

export async function computeFixtureFreshness(
  admin: SupabaseClient,
  input: {
    fixtureId: string;
    analysisOutcome: string;
    generatedAt: string;
    validUntil: string | null;
    groupLocked: boolean;
  },
): Promise<{
  freshness: KapilotoFreshness;
  staleReasons: string[];
}> {
  if (input.analysisOutcome === "void") {
    return { freshness: "void", staleReasons: [] };
  }

  if (input.groupLocked) {
    return { freshness: "locked", staleReasons: [] };
  }

  const staleReasons: string[] = [];
  const now = Date.now();

  if (
    input.validUntil != null &&
    Number.isFinite(Date.parse(input.validUntil)) &&
    Date.parse(input.validUntil) <= now
  ) {
    staleReasons.push("ttl_expired");
  }

  const { data, error } = await admin
    .from("kapiloto_freshness_signals")
    .select("signal_type,severity,observed_at")
    .eq("fixture_id", input.fixtureId)
    .gte("severity", 2)
    .gt("observed_at", input.generatedAt)
    .order("observed_at", { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(
      `Failed to load Kapiloto freshness signals: ${error.message}`,
    );
  }

  for (const signal of data ?? []) {
    const reason = `signal:${String(signal.signal_type)}`;
    if (!staleReasons.includes(reason)) staleReasons.push(reason);
  }

  return {
    freshness: staleReasons.length > 0 ? "stale" : "fresh",
    staleReasons,
  };
}
