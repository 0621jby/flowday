import { z } from "zod";
import { adviceSchema, type CoachAdvice } from "./schema";

export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  providerCalls: number;
};
export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly usage: ModelUsage,
  ) {
    super(message);
  }
}
export type OutputFormat = "json_object" | "strict" | "plain";
type Config = {
  url: string;
  key: string;
  model: string;
  format: OutputFormat;
  tokenField: "max_tokens" | "max_completion_tokens";
  retry: boolean;
};
function parse(content: string) {
  const trimmed = content.trim().replace(/^\uFEFF/, "");
  const fenced = /^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i.exec(trimmed);
  try {
    return adviceSchema.safeParse(JSON.parse(fenced?.[1] ?? trimmed));
  } catch {
    return null;
  }
}
async function responseJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("模型未返回内容。");
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 160000) {
      await reader.cancel();
      throw new Error("模型返回内容过大。");
    }
    result += decoder.decode(value, { stream: true });
  }
  return JSON.parse(result + decoder.decode()) as {
    choices?: {
      finish_reason?: string;
      message?: { content?: string; refusal?: string };
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
}
function rate(key: string) {
  const value = process.env[key]?.trim();
  return value && Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value)
    : null;
}
function sum(previous: number | null, next: unknown) {
  return previous !== null &&
    typeof next === "number" &&
    Number.isSafeInteger(next) &&
    next >= 0
    ? previous + next
    : null;
}
export async function requestAdvice(
  config: Config,
  system: string,
  payload: unknown,
): Promise<ModelUsage & { advice: CoachAdvice }> {
  const schema = z.toJSONSchema(adviceSchema);
  delete schema.$schema;
  const sample = {
    analysis: "说明当前困难",
    hypotheses: [],
    clarifications: [],
    recommendation: "写下一个具体完成标准",
    adjustPlan: false,
    goalTitle: null,
    goalDescription: null,
    stages: [],
    steps: [],
    moves: [],
    scheduleTaskIds: [],
    cautions: [],
  };
  const format =
    config.format === "strict"
      ? {
          type: "json_schema",
          json_schema: { name: "flowday_coach", strict: true, schema },
        }
      : config.format === "json_object"
        ? { type: "json_object" }
        : undefined;
  const contract =
    config.format === "strict"
      ? ""
      : `\n输出一个 JSON 对象。JSON 示例 ${JSON.stringify(sample)}\n字段规范 ${JSON.stringify(schema)}`;
  const usage: ModelUsage = {
    providerCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: null,
  };
  const inputRate = rate("AI_INPUT_USD_PER_MILLION");
  const outputRate = rate("AI_OUTPUT_USD_PER_MILLION");
  const cost = () =>
    usage.inputTokens !== null &&
    usage.outputTokens !== null &&
    inputRate !== null &&
    outputRate !== null
      ? (usage.inputTokens * inputRate + usage.outputTokens * outputRate) / 1e6
      : null;
  const signal = AbortSignal.timeout(32000);
  for (let attempt = 0; attempt < (config.retry ? 2 : 1); attempt++) {
    usage.providerCalls++;
    let raw: Awaited<ReturnType<typeof responseJson>>;
    try {
      const response = await fetch(config.url, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.key}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: "system",
              content:
                system +
                contract +
                (attempt
                  ? "\n上次输出格式无效。仅输出完整的 JSON 对象，保留全部字段，缩短文字。"
                  : ""),
            },
            { role: "user", content: JSON.stringify(payload) },
          ],
          response_format: format,
          [config.tokenField]: 2500,
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "模型供应商暂时限流。"
            : response.status === 401 || response.status === 403
              ? "模型凭证或模型权限无效。"
              : response.status === 400
                ? "模型拒绝当前参数，请检查模型权限及 AI_OUTPUT_FORMAT、AI_TOKEN_FIELD。"
                : "模型暂不可用。",
        );
      raw = await responseJson(response);
    } catch (error) {
      const safe =
        error instanceof Error && error.message.startsWith("模型")
          ? error.message
          : "模型请求超时或连接失败。";
      throw new ModelCallError(safe, {
        ...usage,
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
      });
    }
    usage.inputTokens = sum(usage.inputTokens, raw.usage?.prompt_tokens);
    usage.outputTokens = sum(usage.outputTokens, raw.usage?.completion_tokens);
    usage.estimatedCostUsd = cost();
    const choice = raw.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter")
      throw new ModelCallError("模型拒绝生成这份建议。", usage);
    const result =
      choice?.finish_reason === "stop" &&
      typeof choice.message?.content === "string"
        ? parse(choice.message.content)
        : null;
    if (result?.success) return { ...usage, advice: result.data };
  }
  throw new ModelCallError(
    "模型返回的 JSON 未通过校验。请缩小请求范围后重试。",
    usage,
  );
}
