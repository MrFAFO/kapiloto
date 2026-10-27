import { NextResponse } from "next/server";

import { parseRecoveryIdentifier } from "@/lib/auth/identity";
import { consumeAuthRateLimit } from "@/lib/auth/rate-limit";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const raw = (await request.json()) as { recovery?: unknown };
    const recovery =
      typeof raw.recovery === "string"
        ? parseRecoveryIdentifier(raw.recovery)
        : null;

    if (!recovery) {
      return NextResponse.json(
        { error: { code: "invalid_recovery", message: "Invalid recovery identifier." } },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      );
    }

    const allowed = await consumeAuthRateLimit({
      bucket: "recovery_identifier",
      key: `${recovery.type}:${recovery.value}`,
      limit: 5,
      windowSeconds: 15 * 60,
    });
    if (!allowed) {
      return NextResponse.json(
        { error: { code: "rate_limited", message: "Try again later." } },
        { status: 429, headers: { "cache-control": "private, no-store" } },
      );
    }

    const client = await createClient({ remember: false });

    if (recovery.type === "email") {
      const redirectTo = new URL(
        "/auth/confirm?next=/reset-password",
        request.url,
      ).toString();
      const { error } = await client.auth.resetPasswordForEmail(
        recovery.value,
        { redirectTo },
      );
      if (error) {
        console.warn("[auth] recovery request did not send", error.code);
      }
    } else {
      const { error } = await client.auth.signInWithOtp({
        phone: recovery.value,
        options: { shouldCreateUser: false },
      });
      if (error) {
        console.warn("[auth] phone recovery request did not send", error.code);
      }
    }

    // Always return the same success shape for existing/non-existing accounts.
    return NextResponse.json(
      { ok: true, channel: recovery.type },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[auth] recovery route failed", error);
    return NextResponse.json(
      { error: { code: "recovery_unavailable", message: "Recovery unavailable." } },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
}
