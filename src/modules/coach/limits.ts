import type { coachSession } from "./server";
import { HttpError } from "@/lib/http";
import { PROMPT_VERSION } from "./provider";
type Session = Awaited<ReturnType<typeof coachSession>>;
type Entry = {
  id: string;
  at: number;
  hash: string;
  status: "reserved" | "success" | "failed";
  result: unknown;
  usage: unknown;
};
const memory = new Map<string, Entry[]>();
export async function reserve(
  session: Session,
  hash: string,
  provider: string,
  model: string,
) {
  if (session.client) {
    const { data, error } = await session.client.rpc("flowday_ai_reserve", {
      p_hash: hash,
      p_provider: provider,
      p_model: model,
    });
    if (error)
      throw new HttpError(
        /AI_RATE_LIMIT|AI_BUSY/.test(error.message)
          ? 429
          : /AI_DISABLED/.test(error.message)
            ? 403
            : 503,
        /AI_BUSY/.test(error.message)
          ? "相同请求正在处理，请稍后再试。"
          : /AI_RATE_LIMIT/.test(error.message)
            ? "已达到当前账户调用限额，额度可在个人设置查看。"
            : /AI_DISABLED/.test(error.message)
              ? "AI 已在个人设置关闭。"
              : "AI 用量记录尚不可用，请先执行新增数据库迁移。",
      );
    return data as { id: string; cached: unknown };
  }
  const now = Date.now();
  for (const [key, list] of memory)
    if (!list.some((e) => now - e.at < 86400000)) memory.delete(key);
  if (!memory.has(session.actor) && memory.size >= 256)
    throw new HttpError(429, "演示会话过多，请稍后重试。");
  const rows = (memory.get(session.actor) ?? []).filter(
    (e) => now - e.at < 86400000,
  );
  memory.set(session.actor, rows);
  const match = rows.findLast(
    (e) => e.hash === hash && now - e.at < 300000 && e.status !== "failed",
  );
  if (match) {
    if (match.status === "success")
      return { id: match.id, cached: match.result };
    throw new HttpError(429, "相同请求正在处理，请稍后再试。");
  }
  if (rows.filter((e) => now - e.at < 60000).length >= 6 || rows.length >= 60)
    throw new HttpError(429, "已达到演示限额：每分钟6次、每天60次。");
  const id = crypto.randomUUID();
  rows.push({
    id,
    at: now,
    hash,
    status: "reserved",
    result: null,
    usage: null,
  });
  return { id, cached: null };
}
export async function finish(
  session: Session,
  id: string,
  result: unknown,
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number | null;
    providerCalls: number;
  } | null,
) {
  if (session.client) {
    const { error } = await session.client.rpc("flowday_ai_finish_v15", {
      p_id: id,
      p_success: !!result,
      p_input: usage?.inputTokens ?? null,
      p_output: usage?.outputTokens ?? null,
      p_cost: usage?.estimatedCostUsd ?? null,
      p_calls: usage?.providerCalls ?? 0,
      p_prompt: PROMPT_VERSION,
      p_result: result,
    });
    if (error)
      throw new HttpError(
        503,
        "用量记录未确认成功；未执行任何业务更改，请稍后重试。",
      );
    return;
  }
  const row = memory.get(session.actor)?.find((e) => e.id === id);
  if (row) {
    row.status = result ? "success" : "failed";
    row.result = result;
    row.usage = usage;
  }
}
