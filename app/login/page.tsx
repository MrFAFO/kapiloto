import { redirect } from "next/navigation";

import { AuthScreen } from "@/components/auth-screen";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await getAuthenticatedUserId()) redirect("/");

  const params = await searchParams;
  const reset = Array.isArray(params.reset) ? params.reset[0] : params.reset;
  const authError = Array.isArray(params.auth_error)
    ? params.auth_error[0]
    : params.auth_error;

  return (
    <AuthScreen
      mode="login"
      initialNotice={
        reset === "1" ? "הסיסמה עודכנה. אפשר להתחבר." : null
      }
      initialError={
        authError === "1"
          ? "קישור האימות אינו תקין או שפג תוקפו."
          : null
      }
    />
  );
}
