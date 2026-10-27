import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { KAPILOTO_REMEMBER_COOKIE } from "@/lib/auth/session";
import type { Database } from "@/lib/supabase/database.types";

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    return response;
  }

  const remember =
    request.cookies.get(KAPILOTO_REMEMBER_COOKIE)?.value !== "0";

  const supabase = createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });

        response = NextResponse.next({ request });

        cookiesToSet.forEach(({ name, value, options }) => {
          if (!remember) {
            const {
              maxAge: _maxAge,
              expires: _expires,
              ...sessionOnlyOptions
            } = options;
            response.cookies.set(name, value, sessionOnlyOptions);
          } else {
            response.cookies.set(name, value, options);
          }
        });

        Object.entries(headers).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
      },
    },
  });

  // Keep identity validation adjacent to client creation. The proxy exists to
  // refresh cookie-backed sessions; authorization still happens in routes/RLS.
  await supabase.auth.getClaims();

  return response;
}
