import { redirect } from "next/navigation";

import { AuthScreen } from "@/components/auth-screen";
import { getAuthenticatedUserId } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (await getAuthenticatedUserId()) redirect("/");
  return <AuthScreen mode="signup" />;
}
