import type { SupabaseClient } from "@supabase/supabase-js";

export class KapilotoAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KapilotoAuthorizationError";
  }
}

export type GroupRoundKapilotoContext = {
  maxDoubles: number;
  groupLocked: boolean;
};

export async function loadGroupRoundKapilotoContext(
  admin: SupabaseClient,
  userId: string,
  groupId: string,
  roundId: string,
): Promise<GroupRoundKapilotoContext> {
  const { data: membership, error: membershipError } = await admin
    .from("group_members")
    .select("role,status")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (membershipError) {
    throw new Error(
      `Failed to validate group membership: ${membershipError.message}`,
    );
  }
  if (!membership) {
    throw new KapilotoAuthorizationError(
      "Active group membership is required.",
    );
  }

  const { data: settings, error: settingsError } = await admin
    .from("group_round_settings")
    .select("max_doubles,locked_at")
    .eq("group_id", groupId)
    .eq("round_id", roundId)
    .maybeSingle();

  if (settingsError) {
    throw new Error(
      `Failed to load group round settings: ${settingsError.message}`,
    );
  }
  if (!settings) {
    throw new KapilotoAuthorizationError(
      "This group is not configured for the requested round.",
    );
  }

  return {
    maxDoubles: Number(settings.max_doubles),
    groupLocked: settings.locked_at != null,
  };
}
