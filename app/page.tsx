import { redirect } from "next/navigation";

import {
  CurrentRoundTicket,
  PROTOTYPE_CURRENT_ROUND,
} from "@/components/current-round-ticket";
import { loadSingleActiveGroup } from "@/lib/groups/current-group";
import { parseKapilotoDemoScenario } from "@/lib/kapiloto/demo-fetch";
import { SupabaseCurrentRoundLoader } from "@/lib/rounds/current-round";
import { buildCurrentRoundView } from "@/lib/rounds/presentation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";
import { TotoTicketService } from "@/lib/ticket-service";

// Prototype identifiers remain only for explicit local demo mode.
const PROTOTYPE_ROUND_ID = "00000000-0000-4000-8000-000000264101";
const PROTOTYPE_GROUP_ID = "00000000-0000-4000-8000-0000000000a1";

export const dynamic = "force-dynamic";

function kapilotoDemoEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_KAPILOTO_DEMO === "1" &&
    process.env.NODE_ENV !== "production"
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = Array.isArray(params.kapiloto_demo)
    ? params.kapiloto_demo[0]
    : params.kapiloto_demo;
  const demoScenario = kapilotoDemoEnabled()
    ? parseKapilotoDemoScenario(requested)
    : null;

  const userId = await getAuthenticatedUserId();
  if (!demoScenario && !userId) {
    redirect("/login");
  }

  if (demoScenario) {
    return (
      <CurrentRoundTicket
        round={PROTOTYPE_CURRENT_ROUND}
        kapiloto={{
          roundId: PROTOTYPE_ROUND_ID,
          groupId: PROTOTYPE_GROUP_ID,
          demoScenario,
        }}
      />
    );
  }

  const admin = createAdminClient();
  const [databaseRound, group] = await Promise.all([
    new SupabaseCurrentRoundLoader(admin).load(),
    loadSingleActiveGroup(admin, userId!),
  ]);

  if (!databaseRound) {
    return (
      <CurrentRoundTicket
        round={PROTOTYPE_CURRENT_ROUND}
        kapiloto={{
          roundId: PROTOTYPE_ROUND_ID,
          groupId: null,
          demoScenario: null,
        }}
      />
    );
  }

  let maxDoubles = group?.defaultMaxDoubles ?? 7;
  let initialPicks:
    | Array<{ gameNumber: number; pick: "1" | "X" | "2" | "1X" | "X2" | "12" }>
    | undefined;
  let enabledGroupId: string | null = null;

  if (group) {
    try {
      const ticket = await new TotoTicketService(admin).load(
        group.groupId,
        databaseRound.roundId,
        userId!,
      );
      maxDoubles = ticket.maxDoubles;
      enabledGroupId = group.groupId;

      const gameNumberById = new Map(
        databaseRound.games.map((game) => [game.roundGameId, game.number]),
      );

      initialPicks = ticket.picks.flatMap((pick) => {
        const gameNumber = gameNumberById.get(pick.roundGameId);
        return gameNumber == null
          ? []
          : [{ gameNumber, pick: pick.pick }];
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("ticket_group_round_settings_missing")
      ) {
        throw error;
      }
    }
  }

  const roundView = buildCurrentRoundView(databaseRound, {
    maxDoubles,
    picks: initialPicks,
  });

  return (
    <CurrentRoundTicket
      round={roundView}
      kapiloto={{
        roundId: databaseRound.roundId,
        groupId: enabledGroupId,
        demoScenario: null,
      }}
    />
  );
}
