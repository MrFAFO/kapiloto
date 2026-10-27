import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "./server";

/**
 * Returns the authenticated Supabase user id after JWT signature validation.
 * Server authorization should prefer getClaims() over trusting cookie session
 * payloads directly.
 */
export async function getAuthenticatedUserId(
  client?: SupabaseClient,
): Promise<string | null> {
  if (
    !client &&
    (!process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
  ) {
    return null;
  }

  const supabase = client ?? (await createClient());
  const { data, error } = await supabase.auth.getClaims();

  if (error) return null;

  const subject = data?.claims?.sub;
  return typeof subject === "string" && subject.length > 0 ? subject : null;
}
