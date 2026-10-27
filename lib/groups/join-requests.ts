import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { GroupBootstrapService } from "./bootstrap-service";

export type PendingGroupJoinRequest = {
  requestId: string;
  userId: string;
  username: string;
  displayName: string | null;
  requestedAt: string;
};

export class GroupJoinRequestService {
  constructor(private readonly client: SupabaseClient<Database>) {}

  private async assertAdmin(
    actorUserId: string,
    groupId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from("group_members")
      .select("role,status")
      .eq("group_id", groupId)
      .eq("user_id", actorUserId)
      .maybeSingle();

    if (error) {
      throw new Error(
        `Failed to validate group administrator: ${error.message}`,
      );
    }

    if (
      !data ||
      data.status !== "active" ||
      (data.role !== "owner" && data.role !== "admin")
    ) {
      throw new Error("join_admin_required");
    }
  }

  async listPending(
    actorUserId: string,
    groupId: string,
  ): Promise<PendingGroupJoinRequest[]> {
    await this.assertAdmin(actorUserId, groupId);

    const { data: requests, error: requestsError } = await this.client
      .from("join_requests")
      .select("id,user_id,requested_at")
      .eq("group_id", groupId)
      .eq("status", "pending")
      .order("requested_at", { ascending: true });

    if (requestsError) {
      throw new Error(
        `Failed to load pending join requests: ${requestsError.message}`,
      );
    }

    const rows = requests ?? [];
    if (rows.length === 0) return [];

    const userIds = [...new Set(rows.map((row) => row.user_id))];
    const { data: profiles, error: profilesError } = await this.client
      .from("profiles")
      .select("id,username,display_name")
      .in("id", userIds);

    if (profilesError) {
      throw new Error(
        `Failed to load join-request profiles: ${profilesError.message}`,
      );
    }

    const byUser = new Map(
      (profiles ?? []).map((profile) => [profile.id, profile]),
    );

    return rows.map((row) => {
      const profile = byUser.get(row.user_id);
      return {
        requestId: row.id,
        userId: row.user_id,
        username: profile?.username ?? "unknown",
        displayName: profile?.display_name ?? null,
        requestedAt: row.requested_at,
      };
    });
  }

  async decide(
    actorUserId: string,
    groupId: string,
    requestId: string,
    decision: "approved" | "rejected",
  ) {
    await this.assertAdmin(actorUserId, groupId);

    const { data: request, error } = await this.client
      .from("join_requests")
      .select("group_id")
      .eq("id", requestId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load join request: ${error.message}`);
    }
    if (!request || request.group_id !== groupId) {
      throw new Error("join_request_not_found");
    }

    return new GroupBootstrapService(this.client).decideJoin(
      actorUserId,
      requestId,
      decision,
    );
  }
}
