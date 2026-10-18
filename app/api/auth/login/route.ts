import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  KAPILOTO_REMEMBER_COOKIE,
  KAPILOTO_REMEMBER_MAX_AGE,
} from "@/lib/auth/session";
import {
  normalizeUsername,
  usernameValidationError,
} from "@/lib/auth/identity";
import { consumeAuthRateLimit } from "@/lib/auth/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function response(
  body: unknown,
  status: number,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

function invalidCredentials() {
  return response(
    { error: { code: "invalid_credentials", message: "Invalid credentials." } },
    401,
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const raw = (await request.json()) as {
      username?: unknown;
      password?: unknown;
      remember?: unknown;
    };

    const username =
      typeof raw.username === "string" ? normalizeUsername(raw.username) : "";
    const password = typeof raw.password === "string" ? raw.password : "";
    const remember = raw.remember !== false;

    if (usernameValidationError(username) || password.length === 0) {
      return invalidCredentials();
    }

    const allowed = await consumeAuthRateLimit({
      bucket: "login_username",
      key: username,
      limit: 10,
      windowSeconds: 15 * 60,
    });
    if (!allowed) {
      return response(
        { error: { code: "rate_limited", message: "Try again later." } },
        429,
      );
    }

    const admin = createAdminClient();
    const { data: resolved, error: resolveError } = await admin.rpc(
      "kapiloto_resolve_username",
      { p_normalized_username: username },
    );

    if (resolveError) {
      console.error("[auth] username resolution failed", resolveError.code);
      return response(
        { error: { code: "auth_unavailable", message: "Authentication unavailable." } },
        503,
      );
    }

    const alias = resolved?.[0] ?? null;
    const sessionClient = await createClient({ remember });

    let signInError = null;
    if (alias?.identifier_type === "email") {
      ({ error: signInError } = await sessionClient.auth.signInWithPassword({
        email: alias.preferred_auth_identifier,
        password,
      }));
    } else if (alias?.identifier_type === "phone") {
      ({ error: signInError } = await sessionClient.auth.signInWithPassword({
        phone: alias.preferred_auth_identifier,
        password,
      }));
    } else {
      const digest = createHash("sha256")
        .update(username)
        .digest("hex")
        .slice(0, 20);
      ({ error: signInError } = await sessionClient.auth.signInWithPassword({
        email: `invalid-${digest}@invalid.kapiloto.local`,
        password,
      }));
    }

    if (signInError || !alias) {
      return invalidCredentials();
    }

    const cookieStore = await cookies();
    cookieStore.set(KAPILOTO_REMEMBER_COOKIE, remember ? "1" : "0", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      ...(remember ? { maxAge: KAPILOTO_REMEMBER_MAX_AGE } : {}),
    });

    return response({ ok: true }, 200);
  } catch (error) {
    console.error("[auth] login route failed", error);
    return response(
      { error: { code: "auth_unavailable", message: "Authentication unavailable." } },
      503,
    );
  }
}
