import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

export type ActiveGroupContext = {
  groupId: string;
  name: string;
  defaultMaxDoubles: number;
  role: "owner" | "admin" | "member";
};

type MembershipRow = {
  group_id: string;
  role: string;
  joined_at: string;
};

type GroupRow = {
  id: string;
  name: string;
  default_max_doubles: number;
};

export async function loadActiveGroups(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<ActiveGroupContext[]> {
  const { data: membershipsData, error: membershipsError } = await client
    .from("group_members")
    .select("group_id,role,joined_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("joined_at", { ascending: true });

  if (membershipsError) {
    throw new Error(
      `Failed to load active group memberships: ${membershipsError.message}`,
    );
  }

  const memberships = (membershipsData ?? []) as MembershipRow[];
  if (memberships.length === 0) return [];

  const groupIds = memberships.map((membership) => membership.group_id);
  const { data: groupsData, error: groupsError } = await client
    .from("groups")
    .select("id,name,default_max_doubles")
    .in("id", groupIds);

  if (groupsError) {
    throw new Error(`Failed to load active groups: ${groupsError.message}`);
  }

  const groups = new Map(
    ((groupsData ?? []) as GroupRow[]).map((group) => [group.id, group]),
  );

  return memberships.map((membership) => {
    const group = groups.get(membership.group_id);
    if (!group) {
      throw new Error(
        `Active membership references missing group ${membership.group_id}.`,
      );
    }
    if (
      membership.role !== "owner" &&
      membership.role !== "admin" &&
      membership.role !== "member"
    ) {
      throw new Error("Active membership contains an invalid role.");
    }

    return {
      groupId: group.id,
      name: group.name,
      defaultMaxDoubles: group.default_max_doubles,
      role: membership.role,
    };
  });
}

export async function loadSingleActiveGroup(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<ActiveGroupContext | null> {
  const groups = await loadActiveGroups(client, userId);
  return groups.length === 1 ? groups[0] : null;
}


export function selectActiveGroup(
  groups: ActiveGroupContext[],
  requestedGroupId?: string | null,
): ActiveGroupContext | null {
  if (groups.length === 0) return null;

  if (requestedGroupId) {
    const requested = groups.find((group) => group.groupId === requestedGroupId);
    if (requested) return requested;
  }

  return groups[0];
}
