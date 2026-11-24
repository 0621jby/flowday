import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { cloudActor } from "@/lib/supabase/actor";
import { cloudConfig } from "@/lib/supabase/config";
import { failure, HttpError, json, readJson, sameOrigin } from "@/lib/http";

const historyKinds = [
  "tasks",
  "execution",
  "focus",
  "reviews",
  "review",
] as const;
const historyQuery = z.object({
  kind: z.enum(historyKinds),
  afterAt: z.iso.datetime({ offset: true }).optional(),
  afterId: z.string().min(1).max(128).optional(),
  day: z.iso.date().optional(),
  task: z.string().min(1).max(128).optional(),
});
const reportQuery = z.object({
  end: z.iso.date(),
  days: z.coerce
    .number()
    .pipe(z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)])),
  zone: z.string().min(1).max(80),
});
export async function GET(request: Request) {
  try {
    const { client } = await cloudActor(request);
    const params = Object.fromEntries(new URL(request.url).searchParams);
    if (
      params.kind === "access" ||
      params.kind === "totals" ||
      params.kind === "export"
    ) {
      const result = await client.rpc(
        params.kind === "access"
          ? "flowday_access"
          : params.kind === "totals"
            ? "flowday_totals"
            : "flowday_privacy_export",
      );
      if (result.error)
        throw new HttpError(503, "云端数据暂不可用，请检查数据库迁移。");
      return json(
        params.kind === "access"
          ? {
              ...result.data,
              accountDeletion: !!process.env.SUPABASE_ACCOUNT_ADMIN_KEY,
            }
          : result.data,
      );
    }
    if (params.kind === "growth") {
      const parsed = reportQuery.safeParse(params);
      if (!parsed.success) throw new HttpError(400, "报告日期或范围无效。");
      const { days, end, zone } = parsed.data;
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
      } catch {
        throw new HttpError(400, "时区无效。");
      }
      const { data, error } = await client.rpc("flowday_growth_report", {
        p_end: end,
        p_days: days,
        p_zone: zone,
      });
      if (error?.message.includes("ADVANCED_GROWTH_REQUIRED"))
        throw new HttpError(403, "当前账户权益不包含此报告范围。");
      if (error) throw new HttpError(503, "成长报告暂不可用，请重试。");
      return json(data);
    }
    const parsed = historyQuery.safeParse(params);
    if (!parsed.success) throw new HttpError(400, "历史查询无效。");
    const { kind, afterAt, afterId, day, task } = parsed.data;
    if (kind === "review" && !day) throw new HttpError(400, "请选择复盘日期。");
    if (
      afterId &&
      (kind === "reviews" ? !z.iso.date().safeParse(afterId).success : !afterAt)
    )
      throw new HttpError(400, "分页位置无效。");
    const pageSize = 25;
    const { data, error } = await client.rpc("flowday_history", {
      p_kind: kind,
      p_limit: pageSize,
      p_at: afterAt ?? null,
      p_id: afterId ?? null,
      p_task: task ?? null,
      p_day: day ?? null,
    });
    if (error) throw new HttpError(503, "历史记录暂不可用，请重试。");
    const rows = (data as { entry: unknown; at: string; id: string }[]).slice(
      0,
      pageSize,
    );
    const last = rows.at(-1);
    return json({
      items: rows.map((r) => r.entry),
      next:
        last && data.length > pageSize
          ? {
              afterId: last.id,
              ...(kind !== "reviews" && { afterAt: last.at }),
            }
          : null,
    });
  } catch (error) {
    return failure(error);
  }
}

const destructive = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("clear"),
    phrase: z.literal("清空云端数据"),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("delete"),
    phrase: z.literal("永久删除账户"),
    password: z.string().min(1).max(256),
  }),
]);
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { client, user } = await cloudActor(request);
    const parsed = destructive.safeParse(await readJson(request, 4096));
    if (!parsed.success)
      throw new HttpError(400, "请完整输入确认文字和所需凭据。");
    if (parsed.data.action === "clear") {
      const { error } = await client.rpc("flowday_clear", {
        p_revision: parsed.data.revision,
      });
      if (error?.message.includes("REVISION_CONFLICT"))
        throw new HttpError(409, "云端数据已变更，请先同步再确认清理。");
      if (error) throw new HttpError(503, "云端尚未确认清理成功。");
      return json({ ok: true });
    }
    const key = process.env.SUPABASE_ACCOUNT_ADMIN_KEY;
    const config = cloudConfig()!;
    if (!key) throw new HttpError(503, "此部署尚未配置账户删除权限。");
    if (!user.email)
      throw new HttpError(400, "当前账户无法通过邮箱密码重新验证。");
    const options = {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
      },
    };
    const verify = createClient(config.url, config.key, options);
    const { data, error } = await verify.auth.signInWithPassword({
      email: user.email,
      password: parsed.data.password,
    });
    if (error || data.user?.id !== user.id)
      throw new HttpError(403, "密码验证失败，请检查后重试。");
    const admin = createClient(config.url, key, options);
    const deleted = await admin.auth.admin.deleteUser(user.id);
    if (deleted.error) {
      await verify.auth.signOut({ scope: "local" }).catch(() => {});
      throw new HttpError(503, "账户删除尚未确认，请稍后检查或重试。");
    }
    await client.auth.signOut({ scope: "local" }).catch(() => {});
    return json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
