import { redirect } from "next/navigation";

import { GroupDashboardScreen } from "@/components/group-dashboard-screen";
import {
  loadActiveGroups,
  selectActiveGroup,
} from "@/lib/groups/current-group";
import { loadGroupDashboard } from "@/lib/groups/dashboard";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function GroupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");

  const params = await searchParams;
  const requestedGroup = Array.isArray(params.group)
    ? params.group[0]
    : params.group;

  const admin = createAdminClient();
  const groups = await loadActiveGroups(admin, userId);
  const selected = selectActiveGroup(groups, requestedGroup ?? null);

  if (!selected) {
    redirect("/");
  }

  const dashboard = await loadGroupDashboard(
    admin,
    userId,
    selected.groupId,
  );

  return (
    <GroupDashboardScreen
      dashboard={dashboard}
      groups={groups}
    />
  );
}
