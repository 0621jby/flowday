import { supabaseServer } from "@/lib/supabase/server";
import { cloudConfig, cookieOptions } from "@/lib/supabase/config";
import { HttpError } from "@/lib/http";
import { validateWorkspace } from "../cloud/validation";
import { providerConfig } from "./provider";
import { cookies } from "next/headers";
import { coachClock, coachGrowthReport } from "./context";
import { reportWindow } from "./guidance";
import type { CoachInput } from "./schema";
import type { CloudAccess } from "../cloud/client";

export async function coachSession(
  request: Request,
  localState: unknown,
  input?: CoachInput,
) {
  if (cloudConfig()) {
    const client = await supabaseServer();
    const {
      data: { user },
      error,
    } = await client.auth.getUser();
    if (error || !user) throw new HttpError(401, "请先登录，当前输入会保留。");
    if (request.headers.get("x-flowday-account") !== user.id)
      throw new HttpError(401, "账户已变化，请重新打开页面。");
    if (
      !process.env.AI_PROPOSAL_SECRET ||
      process.env.AI_PROPOSAL_SECRET.length < 32
    )
      throw new HttpError(
        503,
        "AI 服务需要配置 AI_PROPOSAL_SECRET（至少32字符）。",
      );
    const date = coachClock(input?.timezone ?? "UTC").day;
    const [{ data, error: loadError }, policy] = await Promise.all([
      client.rpc("flowday_bootstrap", { p_today: date }),
      client.rpc("flowday_access"),
    ]);
    if (loadError) throw new HttpError(503, "读取云端上下文失败，未调用模型。");
    if (policy.error || !policy.data)
      throw new HttpError(503, "账户权益暂不可用。");
    const access = policy.data as CloudAccess;
    if (!access.aiEnabled) throw new HttpError(403, "AI 已在个人设置关闭。");
    const state = validateWorkspace(data);
    let growth = null;
    if (input && state.settings.growth?.shareWithAi) {
      const selection = reportWindow(input.choices);
      if (selection.days === 30 && !access.advancedGrowth) {
        throw new HttpError(403, "当前账户不支持 30 天画像。请选择近 7 天。");
      }
      const result = await client.rpc("flowday_growth_report", {
        p_end: date,
        p_days: selection.days,
        p_zone: input.timezone,
      });
      if (!result.error && result.data)
        growth = coachGrowthReport(
          result.data,
          selection,
          state.settings.growth.personalize,
        );
      else if (input.mode === "profile")
        throw new HttpError(
          503,
          "所选范围的统计暂时读不到，请稍后再试。本次未调用模型。",
        );
    }
    if (input?.includeReviews) {
      const recent = await client.rpc("flowday_history", {
        p_kind: "reviews",
        p_limit: 3,
      });
      if (!recent.error && Array.isArray(recent.data))
        state.reviews = recent.data.slice(0, 3).map((row) => row.entry);
    }
    return { actor: user.id, state, client, growth };
  }
  if (providerConfig().mode !== "mock")
    throw new HttpError(
      401,
      "真实模型仅对已登录的云端账户开放。请先配置认证。",
    );
  const jar = await cookies();
  let actor = jar.get("flowday.coach.demo")?.value;
  if (!actor || !/^demo-[a-f0-9-]{36}$/.test(actor)) {
    actor = `demo-${crypto.randomUUID()}`;
    jar.set("flowday.coach.demo", actor, { ...cookieOptions(), maxAge: 86400 });
  }
  const state = validateWorkspace(localState);
  if (state.settings.aiEnabled === false)
    throw new HttpError(403, "AI 已在个人设置关闭。");
  return { actor, state, client: null, growth: null };
}
export function coachFailure(e: unknown): never {
  if (e instanceof HttpError) throw e;
  throw new HttpError(
    400,
    e instanceof Error &&
      e.name !== "ZodError" &&
      !/JSON|Unexpected|fetch|aborted/i.test(e.message)
      ? e.message
      : "AI 输出未通过校验或请求超时，未执行任何业务更改。请缩小范围后重试。",
  );
}
