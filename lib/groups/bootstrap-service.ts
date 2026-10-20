import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

export type CreatedGroup = {
  groupId: string;
  name: string;
  joinCode: string;
  role: "owner";
  defaultMaxDoubles: number;
};

export type GroupJoinRequestResult = {
  groupId: string;
  groupName: string;
  status: "pending" | "already_member";
  requestId: string | null;
};

export type GroupJoinDecisionResult = {
  requestId: string;
  groupId: string;
  userId: string;
  status: "approved" | "rejected";
  replayed: boolean;
};

export type GroupRoundSettings = {
  groupId: string;
  roundId: string;
  maxDoubles: number;
  consensusDoublePolicy: "up_to_max" | "exact_max";
  visibilityPolicy: "after_own_submission" | "after_round_lock" | "immediate";
  lockedAt: string | null;
};

function object(value: Json, label: string): Record<string, Json | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid payload.`);
  }
  return value as Record<string, Json | undefined>;
}

export class GroupBootstrapService {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async create(userId: string, name: string): Promise<CreatedGroup> {
    const { data, error } = await this.client.rpc("kapiloto_create_group", {
      p_user_id: userId,
      p_name: name,
    });

    if (error) {
      throw new Error(error.message);
    }

    const row = object(data, "Create group");
    if (
      typeof row.group_id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.join_code !== "string" ||
      row.role !== "owner" ||
      typeof row.default_max_doubles !== "number"
    ) {
      throw new Error("Create group response is incomplete.");
    }

    return {
      groupId: row.group_id,
      name: row.name,
      joinCode: row.join_code,
      role: "owner",
      defaultMaxDoubles: row.default_max_doubles,
    };
  }

  async requestJoin(
    userId: string,
    joinCode: string,
  ): Promise<GroupJoinRequestResult> {
    const { data, error } = await this.client.rpc(
      "kapiloto_request_group_join",
      {
        p_user_id: userId,
        p_join_code: joinCode,
      },
    );

    if (error) {
      throw new Error(error.message);
    }

    const row = object(data, "Join group");
    if (
      typeof row.group_id !== "string" ||
      typeof row.group_name !== "string" ||
      (row.status !== "pending" && row.status !== "already_member") ||
      (row.request_id !== null && typeof row.request_id !== "string")
    ) {
      throw new Error("Join group response is incomplete.");
    }

    return {
      groupId: row.group_id,
      groupName: row.group_name,
      status: row.status,
      requestId: typeof row.request_id === "string" ? row.request_id : null,
    };
  }

  async decideJoin(
    actorUserId: string,
    requestId: string,
    decision: "approved" | "rejected",
  ): Promise<GroupJoinDecisionResult> {
    const { data, error } = await this.client.rpc(
      "kapiloto_decide_group_join",
      {
        p_actor_user_id: actorUserId,
        p_request_id: requestId,
        p_decision: decision,
      },
    );

    if (error) {
      throw new Error(error.message);
    }

    const row = object(data, "Decide group join");
    if (
      typeof row.request_id !== "string" ||
      typeof row.group_id !== "string" ||
      typeof row.user_id !== "string" ||
      (row.status !== "approved" && row.status !== "rejected") ||
      typeof row.replayed !== "boolean"
    ) {
      throw new Error("Decide group join response is incomplete.");
    }

    return {
      requestId: row.request_id,
      groupId: row.group_id,
      userId: row.user_id,
      status: row.status,
      replayed: row.replayed,
    };
  }

  async ensureRoundSettings(
    userId: string,
    groupId: string,
    roundId: string,
  ): Promise<GroupRoundSettings> {
    const { data, error } = await this.client.rpc(
      "kapiloto_ensure_group_round_settings",
      {
        p_user_id: userId,
        p_group_id: groupId,
        p_round_id: roundId,
      },
    );

    if (error) {
      throw new Error(error.message);
    }

    const row = object(data, "Group round settings");
    if (
      typeof row.group_id !== "string" ||
      typeof row.round_id !== "string" ||
      typeof row.max_doubles !== "number" ||
      (row.consensus_double_policy !== "up_to_max" &&
        row.consensus_double_policy !== "exact_max") ||
      (row.visibility_policy !== "after_own_submission" &&
        row.visibility_policy !== "after_round_lock" &&
        row.visibility_policy !== "immediate")
    ) {
      throw new Error("Group round settings response is incomplete.");
    }

    return {
      groupId: row.group_id,
      roundId: row.round_id,
      maxDoubles: row.max_doubles,
      consensusDoublePolicy: row.consensus_double_policy,
      visibilityPolicy: row.visibility_policy,
      lockedAt: typeof row.locked_at === "string" ? row.locked_at : null,
    };
  }
}
