import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "./database.types";

export type ServerSupabaseOptions = {
  remember?: boolean;
};

export async function createClient(options: ServerSupabaseOptions = {}) {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options: cookieOptions }) => {
              if (options.remember === false) {
                const {
                  maxAge: _maxAge,
                  expires: _expires,
                  ...sessionOnlyOptions
                } = cookieOptions;
                cookieStore.set(name, value, sessionOnlyOptions);
                return;
              }
              cookieStore.set(name, value, cookieOptions);
            });
          } catch {
            // Server Components cannot write cookies. proxy.ts will refresh
            // the session on requests once authentication routes are enabled.
          }
        },
      },
    },
  );
}
