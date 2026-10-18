import { NextResponse } from "next/server";

import { parseRecoveryIdentifier } from "@/lib/auth/identity";
import { consumeAuthRateLimit } from "@/lib/auth/rate-limit";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const raw = (await request.json()) as {
      phone?: unknown;
      token?: unknown;
    };
    const phone =
      typeof raw.phone === "string" ? parseRecoveryIdentifier(raw.phone) : null;
    const token = typeof raw.token === "string" ? raw.token.trim() : "";

    if (!phone || phone.type !== "phone" || !/^\d{6}$/.test(token)) {
      return NextResponse.json(
        { error: { code: "invalid_verification", message: "Invalid verification." } },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      );
    }

    const allowed = await consumeAuthRateLimit({
      bucket: "signup_phone_verify",
      key: phone.value,
      limit: 8,
      windowSeconds: 15 * 60,
    });
    if (!allowed) {
      return NextResponse.json(
        { error: { code: "rate_limited", message: "Try again later." } },
        { status: 429, headers: { "cache-control": "private, no-store" } },
      );
    }

    const client = await createClient();
    const { error } = await client.auth.verifyOtp({
      phone: phone.value,
      token,
      type: "sms",
    });

    if (error) {
      return NextResponse.json(
        { error: { code: "invalid_verification", message: "Invalid verification." } },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      );
    }

    return NextResponse.json(
      { ok: true },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[auth] phone signup verification failed", error);
    return NextResponse.json(
      { error: { code: "verification_unavailable", message: "Verification unavailable." } },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
}
