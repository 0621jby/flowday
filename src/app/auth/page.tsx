import { AuthForm } from "@/components/auth-form";
import { cloudConfig } from "@/lib/supabase/config";

export const dynamic = "force-dynamic";
export default function AuthPage() {
  return <AuthForm configured={!!cloudConfig()} />;
}
