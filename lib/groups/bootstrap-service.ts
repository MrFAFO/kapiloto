import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

export type CreatedGroup = {
  groupId: string;
  name: string;
  joinCode: string;
  role: "owner";
  defaultMaxDoubles: number;
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
