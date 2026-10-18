import { NextResponse } from "next/server";

import {
  parseRecoveryIdentifier,
  passwordValidationError,
} from "@/lib/auth/identity";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const raw = (await request.json()) as {
      phone?: unknown;
      token?: unknown;
      password?: unknown;
    };
    const phone =
      typeof raw.phone === "string" ? parseRecoveryIdentifier(raw.phone) : null;
    const token = typeof raw.token === "string" ? raw.token.trim() : "";
    const password = typeof raw.password === "string" ? raw.password : "";

    if (
      !phone ||
      phone.type !== "phone" ||
      !/^\d{6}$/.test(token) ||
      passwordValidationError(password)
    ) {
      return NextResponse.json(
        { error: { code: "invalid_recovery", message: "Invalid recovery." } },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      );
    }

    const client = await createClient({ remember: false });
    const verified = await client.auth.verifyOtp({
      phone: phone.value,
      token,
      type: "sms",
    });
    if (verified.error) {
      return NextResponse.json(
        { error: { code: "invalid_recovery", message: "Invalid recovery." } },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      );
    }

    const updated = await client.auth.updateUser({ password });
    if (updated.error) {
      return NextResponse.json(
        { error: { code: "invalid_recovery", message: "Invalid recovery." } },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      );
    }

    await client.auth.signOut();

    return NextResponse.json(
      { ok: true },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[auth] phone recovery verification failed", error);
    return NextResponse.json(
      { error: { code: "recovery_unavailable", message: "Recovery unavailable." } },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
}
