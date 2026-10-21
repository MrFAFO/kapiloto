import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { KAPILOTO_REMEMBER_COOKIE } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const client = await createClient({ remember: false });
    await client.auth.signOut();
  } catch (error) {
    console.error("[auth] sign out failed", error);
  }

  const cookieStore = await cookies();
  cookieStore.delete(KAPILOTO_REMEMBER_COOKIE);

  return NextResponse.redirect(new URL("/login", request.url), 303);
}
