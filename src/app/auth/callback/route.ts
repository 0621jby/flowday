import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = process.env.APP_ORIGIN || url.origin;
  const code = url.searchParams.get("code");
  if (code) {
    try {
      const client = await supabaseServer();
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(new URL("/", origin));
    } catch {
      /* Fail closed. No provider details or token in the redirect. */
    }
  }
  return NextResponse.redirect(new URL("/auth?verification=failed", origin));
}
