import { NextResponse } from "next/server";

import { passwordValidationError } from "@/lib/auth/identity";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const raw = (await request.json()) as { password?: unknown };
    const password = typeof raw.password === "string" ? raw.password : "";

    if (passwordValidationError(password)) {
      return NextResponse.json(
        { error: { code: "invalid_password", message: "Invalid password." } },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      );
    }

    const client = await createClient({ remember: false });
    const { data: claims, error: claimsError } = await client.auth.getClaims();
    if (claimsError || !claims?.claims?.sub) {
      return NextResponse.json(
        { error: { code: "unauthorized", message: "Authentication required." } },
        { status: 401, headers: { "cache-control": "private, no-store" } },
      );
    }

    const { error } = await client.auth.updateUser({ password });
    if (error) {
      return NextResponse.json(
        { error: { code: "password_update_failed", message: "Password update failed." } },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      );
    }

    await client.auth.signOut();

    return NextResponse.json(
      { ok: true },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[auth] password update failed", error);
    return NextResponse.json(
      { error: { code: "auth_unavailable", message: "Authentication unavailable." } },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
}
