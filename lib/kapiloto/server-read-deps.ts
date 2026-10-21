import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

import type { KapilotoReadDeps } from "./read-api";

export const serverKapilotoReadDeps: KapilotoReadDeps = {
  getUserId: getAuthenticatedUserId,
  getAdmin: createAdminClient,
};
