import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./database.types";

let adminClient: SupabaseClient<Database> | null = null;

export function createAdminClient(): SupabaseClient<Database> {
  if (adminClient) return adminClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is required.");
  }
  if (!secretKey) {
    throw new Error(
      "SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY is required on the server.",
    );
  }

  adminClient = createClient<Database>(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return adminClient;
}
