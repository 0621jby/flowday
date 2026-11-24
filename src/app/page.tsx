import { Workspace } from "@/components/workspace";
import { cloudConfig } from "@/lib/supabase/config";
import { supabaseServer } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function Page() {
  if (!cloudConfig()) return <Workspace />;
  const client = await supabaseServer(true);
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) redirect("/auth");
  return <Workspace account={{ id: user.id, email: user.email ?? "" }} />;
}
