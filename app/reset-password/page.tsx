import { redirect } from "next/navigation";

import { AuthScreen } from "@/components/auth-screen";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  if (!(await getAuthenticatedUserId())) redirect("/recover");
  return <AuthScreen mode="reset" />;
}
