export function cloudConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (process.env.FLOWDAY_REQUIRE_CLOUD === "1") {
    const origin = new URL(process.env.APP_ORIGIN ?? "");
    if (origin.protocol !== "https:" || origin.origin !== process.env.APP_ORIGIN)
      throw new Error("APP_ORIGIN 必须是完整的 HTTPS 站点来源，不带路径或末尾斜杠。");
    if (!url || !key) throw new Error("生产工作区必须配置 Supabase。");
  }
  if (!url && !key) return null;
  if (!url || !key) throw new Error("Supabase 配置不完整，请检查环境变量。");
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(parsed.hostname)
  )
    throw new Error("Supabase 必须使用 HTTPS。");
  if (key.startsWith("sb_secret_"))
    throw new Error("禁止使用服务端密钥作为公开密钥。");
  // Legacy anon JWTs are accepted; service_role JWTs are never accepted.
  if (key.split(".").length === 3) {
    const payload = JSON.parse(
      Buffer.from(key.split(".")[1], "base64url").toString(),
    );
    if (payload.role !== "anon")
      throw new Error("请使用 Supabase publishable 或 anon 密钥。");
  }
  return { url, key };
}

export function cookieOptions() {
  const localHttp =
    process.env.FLOWDAY_ALLOW_LOCAL_HTTP === "1" &&
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(
      process.env.APP_ORIGIN ?? "",
    );
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production" && !localHttp,
  };
}
