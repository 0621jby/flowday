export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function sameOrigin(request: Request) {
  const expected = process.env.APP_ORIGIN || new URL(request.url).origin;
  if (
    request.headers.get("origin") !== expected ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new HttpError(403, "请求来源不匹配，请从本站重新操作。");
}
export async function readJson(
  request: Request,
  limit = 5 * 1024 * 1024,
): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "需要 JSON 请求。");
  if (Number(request.headers.get("content-length")) > limit)
    throw new HttpError(
      413,
      "数据量超出本阶段上限，请先导出备份并联系维护者。",
    );
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "请求为空。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "数据量超出本阶段上限。");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "数据格式无效。");
  }
}
export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
}
export function failure(error: unknown) {
  if (error instanceof HttpError)
    return json({ error: error.message }, error.status);
  // Never return SQL details, tokens or user content to logs / responses.
  return json(
    { error: "服务暂时不可用，操作未确认成功。请保留当前内容后重试。" },
    503,
  );
}
