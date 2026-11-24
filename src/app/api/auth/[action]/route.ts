import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { cloudConfig } from "@/lib/supabase/config";
import { failure, HttpError, json, readJson, sameOrigin } from "@/lib/http";

const credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
});
export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  try {
    sameOrigin(request);
    if (!cloudConfig())
      throw new HttpError(503, "云端服务尚未配置。当前仍可使用本地版本。");
    const { action } = await context.params;
    if (!["login", "signup", "logout"].includes(action))
      throw new HttpError(404, "操作不存在。");
    const client = await supabaseServer();
    if (action === "logout") {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw new HttpError(503, "退出未成功，请重试。");
      return json({ ok: true });
    }
    const parsed = credentials.safeParse(await readJson(request, 4096));
    if (!parsed.success)
      throw new HttpError(400, "请输入有效邮箱和密码（最多 128 个字符）。");
    const { email, password } = parsed.data;
    if (
      action === "signup" &&
      (password.length < 12 ||
        !/[a-zA-Z]/.test(password) ||
        !/[0-9]/.test(password))
    )
      throw new HttpError(400, "密码至少 12 位，包含字母和数字。");
    const result =
      action === "login"
        ? await client.auth.signInWithPassword({ email, password })
        : await client.auth.signUp({
            email,
            password,
            options: {
              emailRedirectTo: `${process.env.APP_ORIGIN || new URL(request.url).origin}/auth/callback`,
            },
          });
    if (result.error) {
      if (result.error.status === 429)
        throw new HttpError(429, "操作过于频繁，请稍后再试。");
      throw new HttpError(
        400,
        action === "login"
          ? "登录失败，请核对邮箱、密码及邮箱验证状态。"
          : "暂时无法完成注册。请稍后重试；已有账号可直接登录。",
      );
    }
    return json({
      ok: true,
      authenticated: !!result.data.session,
      message: "如果邮箱可用于注册，验证邮件将发送到你的邮箱。验证后回来登录。",
    });
  } catch (e) {
    return failure(e);
  }
}
