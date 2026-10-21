import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { safeNextPath } from "@/lib/auth/identity";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const EMAIL_OTP_TYPES = new Set<EmailOtpType>([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const next = safeNextPath(url.searchParams.get("next"));
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;

  try {
    const client = await createClient();
    let error = null;

    if (code) {
      ({ error } = await client.auth.exchangeCodeForSession(code));
    } else if (tokenHash && type && EMAIL_OTP_TYPES.has(type)) {
      ({ error } = await client.auth.verifyOtp({
        token_hash: tokenHash,
        type,
      }));
    } else {
      return NextResponse.redirect(new URL("/login?confirmed=1", request.url));
    }

    if (error) {
      return NextResponse.redirect(new URL("/login?auth_error=1", request.url));
    }

    return NextResponse.redirect(new URL(next, request.url));
  } catch (error) {
    console.error("[auth] confirmation failed", error);
    return NextResponse.redirect(new URL("/login?auth_error=1", request.url));
  }
}
