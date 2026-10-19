import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (process.env.VERCEL_ENV !== "preview") {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const result: Record<string, unknown> = {
    ok: true,
    hasSecret: Boolean(process.env.SUPABASE_SECRET_KEY?.trim()),
  };

  try {
    const admin = createAdminClient();

    const { error: rpcError } = await admin.rpc("kapiloto_resolve_username", {
      p_normalized_username: "__diagnostic__",
    });
    result.rpc = rpcError ? { ok: false, code: rpcError.code } : { ok: true };

    const { error: usersError } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1,
    });
    result.authAdmin = usersError
      ? { ok: false, code: usersError.code, status: usersError.status }
      : { ok: true };

    const client = await createClient();
    const diagnosticEmail =
      "kapiloto-diagnostic-" + Date.now() + "@example.com";
    const redirectTo = new URL("/auth/confirm?next=/", request.url).toString();

    const signup = await client.auth.signUp({
      email: diagnosticEmail,
      password: "KapilotoDiag!2026",
      options: { emailRedirectTo: redirectTo },
    });

    result.signup = signup.error
      ? {
          ok: false,
          code: signup.error.code,
          status: signup.error.status,
          message: signup.error.message,
        }
      : {
          ok: true,
          hasUser: Boolean(signup.data.user),
          hasSession: Boolean(signup.data.session),
        };

    if (signup.data.user?.id) {
      const { error: cleanupError } = await admin.auth.admin.deleteUser(
        signup.data.user.id,
      );
      result.cleanup = cleanupError
        ? { ok: false, code: cleanupError.code, status: cleanupError.status }
        : { ok: true };
    }
  } catch (error) {
    result.ok = false;
    result.exception =
      error instanceof Error ? error.message : "unknown";
  }

  return NextResponse.json(result, {
    headers: { "cache-control": "no-store" },
  });
}
