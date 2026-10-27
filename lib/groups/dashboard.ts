import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import {
  GroupJoinRequestService,
  type PendingGroupJoinRequest,
} from "./join-requests";

export type GroupMemberView = {
  userId: string;
  username: string;
  displayName: string | null;
  role: "owner" | "admin" | "member";
  joinedAt: string;
  isCurrentUser: boolean;
};

export type GroupDashboard = {
  groupId: string;
  name: string;
  joinCode: string;
  defaultMaxDoubles: number;
  role: "owner" | "admin" | "member";
  memberCount: number;
  members: GroupMemberView[];
  pendingRequests: PendingGroupJoinRequest[];
};

type MembershipRow = {
  user_id: string;
  role: string;
  status: string;
  joined_at: string;
};

type ProfileRow = {
  id: string;
  username: string;
  display_name: string | null;
};

function normalizeRole(value: string): "owner" | "admin" | "member" {
  if (value === "owner" || value === "admin" || value === "member") {
    return value;
  }
  throw new Error("Group membership contains an invalid role.");
}

export async function loadGroupDashboard(
  client: SupabaseClient<Database>,
  userId: string,
  groupId: string,
): Promise<GroupDashboard> {
  const { data: ownMembership, error: ownMembershipError } = await client
    .from("group_members")
    .select("role,status")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();

  if (ownMembershipError) {
    throw new Error(
      `Failed to validate group membership: ${ownMembershipError.message}`,
    );
  }

  if (!ownMembership || ownMembership.status !== "active") {
    throw new Error("group_membership_required");
  }

  const role = normalizeRole(ownMembership.role);

  const [{ data: group, error: groupError }, { data: membershipData, error: membersError }] =
    await Promise.all([
      client
        .from("groups")
        .select("id,name,join_code,default_max_doubles")
        .eq("id", groupId)
        .maybeSingle(),
      client
        .from("group_members")
        .select("user_id,role,status,joined_at")
        .eq("group_id", groupId)
        .eq("status", "active")
        .order("joined_at", { ascending: true }),
    ]);

  if (groupError) {
    throw new Error(`Failed to load group: ${groupError.message}`);
  }
  if (!group) {
    throw new Error("group_not_found");
  }
  if (membersError) {
    throw new Error(`Failed to load group members: ${membersError.message}`);
  }

  const memberships = (membershipData ?? []) as MembershipRow[];
  const memberUserIds = memberships.map((membership) => membership.user_id);

  let profiles: ProfileRow[] = [];
  if (memberUserIds.length > 0) {
    const { data: profileData, error: profilesError } = await client
      .from("profiles")
      .select("id,username,display_name")
      .in("id", memberUserIds);

    if (profilesError) {
      throw new Error(`Failed to load member profiles: ${profilesError.message}`);
    }

    profiles = (profileData ?? []) as ProfileRow[];
  }

  const byUser = new Map(profiles.map((profile) => [profile.id, profile]));

  const members = memberships.map((membership) => {
    const profile = byUser.get(membership.user_id);
    if (!profile) {
      throw new Error(
        `Active membership is missing profile ${membership.user_id}.`,
      );
    }

    return {
      userId: membership.user_id,
      username: profile.username,
      displayName: profile.display_name,
      role: normalizeRole(membership.role),
      joinedAt: membership.joined_at,
      isCurrentUser: membership.user_id === userId,
    };
  });

  const pendingRequests =
    role === "owner" || role === "admin"
      ? await new GroupJoinRequestService(client).listPending(userId, groupId)
      : [];

  return {
    groupId: group.id,
    name: group.name,
    joinCode: group.join_code,
    defaultMaxDoubles: group.default_max_doubles,
    role,
    memberCount: members.length,
    members,
    pendingRequests,
  };
}
