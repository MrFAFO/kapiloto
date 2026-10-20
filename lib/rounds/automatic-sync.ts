import type { SupabaseClient } from "@supabase/supabase-js";

import { SportmonksClient } from "@/lib/providers/sportmonks";
import {
  parseTotoRoundImportResult,
  serializeTotoRoundSnapshot,
  type TotoRoundImportResult,
} from "./toto-round";
import {
  completeMissingKickoffsFromFixtures,
  deriveConservativeOperationalLock,
  sportmonksCompletionWindow,
} from "./automatic-resolution";
import { TelesportWinner16Provider } from "./telesport";
import { discoveryToImportSnapshot } from "./toto-source";

export type AutomaticRoundSyncResult =
  | {
      status: "imported";
      roundNumber: string;
      result: TotoRoundImportResult;
      resolvedBySportmonks: number[];
      lockAt: string;
      lockSource: "derived_safety";
    }
  | {
      status: "deferred";
      roundNumber: string;
      reason: "missing_kickoffs" | "no_completion_window";
      unresolvedGameNumbers: number[];
    }
  | {
      status: "locked_unchanged";
      roundNumber: string;
    };

function configuredSafetyMinutes(): number {
  const parsed = Number(process.env.TOTO_SAFETY_LOCK_MINUTES ?? "30");
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > 180) return 30;
  return parsed;
}

export async function runAutomaticRoundSync(
  client: SupabaseClient,
  options: {
    now?: Date;
    sportmonksToken?: string | null;
  } = {},
): Promise<AutomaticRoundSyncResult> {
  const now = options.now ?? new Date();
  const provider = new TelesportWinner16Provider({ now: () => now });

  let discovery = await provider.discoverCurrent();
  let resolvedBySportmonks: Array<{
    gameNumber: number;
    providerFixtureId: string;
    kickoffAt: string;
    score: number;
  }> = [];

  if (!discovery.completeKickoffs) {
    const window = sportmonksCompletionWindow(discovery);
    if (!window) {
      return {
        status: "deferred",
        roundNumber: discovery.externalRoundNumber,
        reason: "no_completion_window",
        unresolvedGameNumbers: discovery.games
          .filter((game) => !game.kickoffAt)
          .map((game) => game.gameNumber),
      };
    }

    const token =
      options.sportmonksToken?.trim() ||
      process.env.SPORTMONKS_API_TOKEN?.trim() ||
      null;

    if (token) {
      const sportmonks = new SportmonksClient(token);
      const fixtures = await sportmonks.getFixturesBetween(
        window.startDate,
        window.endDate,
      );
      const completion = completeMissingKickoffsFromFixtures(
        discovery,
        fixtures,
      );
      discovery = completion.discovery;
      resolvedBySportmonks = completion.resolvedBySportmonks;
    }
  }

  if (!discovery.completeKickoffs) {
    return {
      status: "deferred",
      roundNumber: discovery.externalRoundNumber,
      reason: "missing_kickoffs",
      unresolvedGameNumbers: discovery.games
        .filter((game) => !game.kickoffAt)
        .map((game) => game.gameNumber),
    };
  }

  const lock = deriveConservativeOperationalLock(
    discovery,
    configuredSafetyMinutes(),
  );
  const firstKickoff = Math.min(
    ...discovery.games.map((game) => Date.parse(game.kickoffAt as string)),
  );
  const nowMs = now.getTime();
  const status =
    nowMs < Date.parse(lock.lockAt)
      ? "open"
      : nowMs < firstKickoff
        ? "locked"
        : "live";

  const snapshot = discoveryToImportSnapshot(discovery, {
    lockAt: lock.lockAt,
    status,
  });
  const basePayload = serializeTotoRoundSnapshot(snapshot);
  if (!basePayload || typeof basePayload !== "object" || Array.isArray(basePayload)) {
    throw new Error("Serialized Winner 16 snapshot must be an object.");
  }

  const payload = {
    ...basePayload,
    lock_source_type: lock.sourceType,
    lock_source_ref: lock.sourceRef,
    lock_is_derived: lock.derived,
    source_metadata: {
      discovery_source_url: discovery.sourceUrl,
      discovery_fetched_at: discovery.fetchedAt,
      resolution_chain: [
        "telesport",
        ...(resolvedBySportmonks.length > 0 ? ["sportmonks"] : []),
      ],
      sportmonks_resolutions: resolvedBySportmonks,
      lock_policy: {
        kind: lock.sourceType,
        safety_minutes: lock.safetyMinutes,
      },
    },
  };

  const { data, error } = await client.rpc(
    "toto_import_round_snapshot_v2",
    { p_snapshot: payload },
  );

  if (error) {
    if (
      error.message.includes("round_schedule_locked_immutable") ||
      error.message.includes("round_game_schedule_locked_immutable")
    ) {
      return {
        status: "locked_unchanged",
        roundNumber: discovery.externalRoundNumber,
      };
    }

    throw new Error(`Automatic Winner 16 import failed: ${error.message}`);
  }

  return {
    status: "imported",
    roundNumber: discovery.externalRoundNumber,
    result: parseTotoRoundImportResult(data),
    resolvedBySportmonks: resolvedBySportmonks.map((item) => item.gameNumber),
    lockAt: lock.lockAt,
    lockSource: "derived_safety",
  };
}
