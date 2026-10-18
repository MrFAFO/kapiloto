import { NextResponse } from "next/server";

import {
  parseRecoveryIdentifier,
  passwordValidationError,
  usernameValidationError,
  normalizeUsername,
} from "@/lib/auth/identity";
import { consumeAuthRateLimit } from "@/lib/auth/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function response(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  let createdUserId: string | null = null;

  try {
    const raw = (await request.json()) as {
      username?: unknown;
      password?: unknown;
      recovery?: unknown;
    };

    const username =
      typeof raw.username === "string" ? raw.username.trim() : "";
    const normalizedUsername = normalizeUsername(username);
    const password = typeof raw.password === "string" ? raw.password : "";
    const recovery =
      typeof raw.recovery === "string"
        ? parseRecoveryIdentifier(raw.recovery)
        : null;

    if (
      usernameValidationError(username) ||
      passwordValidationError(password) ||
      !recovery
    ) {
      return response(
        { error: { code: "invalid_registration", message: "Invalid registration." } },
        400,
      );
    }

    const allowed = await consumeAuthRateLimit({
      bucket: "signup_username",
      key: normalizedUsername,
      limit: 5,
      windowSeconds: 15 * 60,
    });
    if (!allowed) {
      return response(
        { error: { code: "rate_limited", message: "Try again later." } },
        429,
      );
    }

    const admin = createAdminClient();
    const { data: existing, error: existingError } = await admin.rpc(
      "kapiloto_resolve_username",
      { p_normalized_username: normalizedUsername },
    );

    if (existingError) {
      console.error("[auth] username availability lookup failed", existingError.code);
      return response(
        { error: { code: "registration_unavailable", message: "Registration unavailable." } },
        503,
      );
    }
    if ((existing?.length ?? 0) > 0) {
      return response(
        { error: { code: "username_unavailable", message: "Username unavailable." } },
        409,
      );
    }

    const sessionClient = await createClient();
    const redirectTo = new URL("/auth/confirm?next=/", request.url).toString();

    const signUp =
      recovery.type === "email"
        ? await sessionClient.auth.signUp({
            email: recovery.value,
            password,
            options: { emailRedirectTo: redirectTo },
          })
        : await sessionClient.auth.signUp({
            phone: recovery.value,
            password,
          });

    if (signUp.error || !signUp.data.user) {
      console.error(
        "[auth] sign up failed",
        signUp.error?.code ?? "missing_user",
      );
      return response(
        { error: { code: "registration_failed", message: "Registration failed." } },
        400,
      );
    }

    const identities = signUp.data.user.identities;
    if (Array.isArray(identities) && identities.length === 0) {
      return response(
        { error: { code: "registration_failed", message: "Registration failed." } },
        400,
      );
    }

    createdUserId = signUp.data.user.id;

    const { error: identityError } = await admin.rpc(
      "kapiloto_register_identity",
      {
        p_user_id: createdUserId,
        p_username: username,
        p_preferred_auth_identifier: recovery.value,
        p_identifier_type: recovery.type,
      },
    );

    if (identityError) {
      console.error("[auth] identity registration failed", identityError.code);
      await admin.auth.admin.deleteUser(createdUserId);
      createdUserId = null;

      if (identityError.code === "23505") {
        return response(
          { error: { code: "username_unavailable", message: "Username unavailable." } },
          409,
        );
      }

      return response(
        { error: { code: "registration_failed", message: "Registration failed." } },
        400,
      );
    }

    return response(
      {
        ok: true,
        channel: recovery.type,
        needsVerification: signUp.data.session == null,
        hasSession: signUp.data.session != null,
      },
      201,
    );
  } catch (error) {
    if (createdUserId) {
      try {
        await createAdminClient().auth.admin.deleteUser(createdUserId);
      } catch {
        // Best-effort cleanup only; the original error is logged below.
      }
    }
    console.error("[auth] register route failed", error);
    return response(
      { error: { code: "registration_unavailable", message: "Registration unavailable." } },
      503,
    );
  }
}
