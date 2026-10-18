import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import type { KapilotoReadDeps } from "./read-api";

export const serverKapilotoReadDeps: KapilotoReadDeps = {
  async getUserId() {
    const sessionClient = await createClient();
    const {
      data: { user },
      error,
    } = await sessionClient.auth.getUser();

    return error || !user ? null : user.id;
  },
  getAdmin: createAdminClient,
};
