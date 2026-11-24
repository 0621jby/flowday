import { cloudConfig } from "@/lib/supabase/config";
export function GET() {
  return Response.json(
    {
      status: "ok",
      service: "flowday",
      release: process.env.FLOWDAY_RELEASE || "dev",
      mode: cloudConfig() ? "cloud-configured" : "local",
      databaseConnectivity: "not-probed",
      schemaVersion: 1,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
