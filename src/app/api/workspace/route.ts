import { z } from "zod";
import { cloudActor } from "@/lib/supabase/actor";
import { failure, HttpError, json, readJson, sameOrigin } from "@/lib/http";
import {
  canonicalWorkspace,
  validateWorkspace,
} from "@/modules/cloud/validation";
import { deltaEnvelope } from "@/modules/cloud/delta";
import type { AppState } from "@/modules/core/model";

function rpcError(error: { code?: string; message: string }): never {
  if (error.code === "PGRST202")
    throw new HttpError(
      503,
      "请先在 Supabase 应用 V1.5 迁移。原有数据仍保留。",
    );
  if (
    /REVISION_CONFLICT|IMPORT_NOT_EMPTY|IDEMPOTENCY_MISMATCH/.test(
      error.message,
    )
  )
    throw new HttpError(
      409,
      "云端已有更新，本次更改未覆盖。请保留变更副本，再同步最新数据。",
    );
  if (
    /INVALID_|SCHEDULE_CONFLICT/.test(error.message) ||
    /^(22|23)/.test(error.code ?? "")
  )
    throw new HttpError(400, "数据或安排未通过校验，云端没有部分保存。");
  throw new HttpError(503, "云端暂时无法确认结果，请稍后重试。");
}

export async function GET(request: Request) {
  try {
    const { client } = await cloudActor(request);
    const date =
      new URL(request.url).searchParams.get("today") ??
      new Date().toISOString().slice(0, 10);
    if (!z.iso.date().safeParse(date).success)
      throw new HttpError(400, "日期无效。");
    const { data, error } = await client.rpc("flowday_bootstrap", {
      p_today: date,
    });
    if (error) rpcError(error);
    return json({ state: validateWorkspace(data) });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    sameOrigin(request);
    const { client } = await cloudActor(request);
    const parsed = deltaEnvelope.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "保存请求格式无效。");
    const { revision, mutationId, changes } = parsed.data;
    if (changes.settings?.growth?.personalize) {
      const access = await client.rpc("flowday_access");
      if (access.error) rpcError(access.error);
      if (!access.data?.personalization)
        throw new HttpError(403, "当前账户权益不支持启用个性化。");
    }
    const { data, error } = await client.rpc("flowday_apply_delta", {
      p_revision: revision,
      p_mutation: mutationId,
      p_delta: changes,
    });
    if (error) rpcError(error);
    return json(data);
  } catch (error) {
    return failure(error);
  }
}

const importEnvelope = z.object({
  state: z.unknown(),
  expectedRevision: z.number().int().nonnegative(),
  mutationId: z.uuid(),
  importLocal: z.literal(true),
});
function canonicalImport(state: AppState) {
  const comparable = {
    ...state,
    executionVersion: 1 as const,
    executionLog: state.executionLog ?? [],
  };
  return canonicalWorkspace(comparable);
}
export async function PUT(request: Request) {
  try {
    sameOrigin(request);
    const { client } = await cloudActor(request);
    const parsed = importEnvelope.safeParse(await readJson(request));
    if (!parsed.success)
      throw new HttpError(400, "此接口仅用于旧数据导入，请刷新到新版后保存。");
    let state: AppState;
    try {
      state = validateWorkspace(parsed.data.state);
    } catch {
      throw new HttpError(400, "导入数据未通过校验，浏览器原始数据仍保留。");
    }
    if (state.revision !== parsed.data.expectedRevision)
      throw new HttpError(409, "数据版本已变化。");
    const normalized = JSON.parse(canonicalWorkspace(state));
    normalized.revision = state.revision;
    const { data, error } = await client.rpc("flowday_import_v15", {
      p_state: normalized,
      p_expected: state.revision,
      p_mutation: parsed.data.mutationId,
    });
    if (error) rpcError(error);
    const saved = validateWorkspace(data.state);
    if (
      !data.alreadyImported &&
      canonicalImport(saved) !== canonicalImport(state)
    )
      throw new HttpError(
        503,
        "导入回读尚未确认。请保留原始数据并重新同步，避免重复导入。",
      );
    return json({
      state: saved,
      alreadyImported: !!data.alreadyImported,
      receipt: data.receipt ?? null,
      verified: !data.alreadyImported,
    });
  } catch (error) {
    return failure(error);
  }
}
