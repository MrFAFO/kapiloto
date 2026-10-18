import { redirect } from "next/navigation";

import { CurrentRoundTicket } from "@/components/current-round-ticket";
import { parseKapilotoDemoScenario } from "@/lib/kapiloto/demo-fetch";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

// Prototype identifiers until round/group context is loaded from Supabase.
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

  if (!demoScenario && !(await getAuthenticatedUserId())) {
    redirect("/login");
  }

  return (
    <CurrentRoundTicket
      kapiloto={{
        roundId: PROTOTYPE_ROUND_ID,
        groupId: PROTOTYPE_GROUP_ID,
        demoScenario,
      }}
    />
  );
}
