import { createHash } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

export type AuthRateLimitInput = {
  bucket: string;
  key: string;
  limit: number;
  windowSeconds: number;
};

export function hashAuthRateLimitKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export async function consumeAuthRateLimit(
  input: AuthRateLimitInput,
): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc(
    "kapiloto_consume_auth_rate_limit",
    {
      p_bucket: input.bucket,
      p_key_hash: hashAuthRateLimitKey(input.key),
      p_limit: input.limit,
      p_window_seconds: input.windowSeconds,
    },
  );

  if (error) {
    throw new Error(`Auth rate-limit check failed: ${error.code}`);
  }

  return data === true;
}
