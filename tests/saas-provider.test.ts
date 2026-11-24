import { afterEach, expect, it, vi } from "vitest";
import {
  requestAdvice,
  ModelCallError,
} from "../src/modules/coach/completion-provider";
import { createProvider, providerConfig } from "../src/modules/coach/provider";

const example = {
  analysis: "时间有限",
  hypotheses: [],
  clarifications: [],
  recommendation: "先写下三个要点",
  adjustPlan: false,
  goalTitle: null,
  goalDescription: null,
  stages: [],
  steps: [],
  moves: [],
  scheduleTaskIds: [],
  cautions: [],
};
const config = {
  url: "https://model.invalid/chat/completions",
  key: "test-key-only",
  model: "chosen-by-owner",
  format: "json_object" as const,
  tokenField: "max_tokens" as const,
  retry: true,
};
function model(
  content: string,
  usage = { prompt_tokens: 40, completion_tokens: 10 },
) {
  return Response.json({
    choices: [{ finish_reason: "stop", message: { content } }],
    usage,
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("supports DeepSeek JSON output and normalizes a configured base URL without inventing a model ID", () => {
  vi.stubEnv("AI_PROVIDER", "deepseek");
  vi.stubEnv("AI_ENABLE_PAID_CALLS", "true");
  vi.stubEnv("AI_API_URL", "https://api.deepseek.com");
  vi.stubEnv("AI_API_KEY", "test-only");
  vi.stubEnv("AI_MODEL", "user-selected");
  vi.stubEnv("AI_OUTPUT_FORMAT", "");
  vi.stubEnv("AI_TOKEN_FIELD", "");
  vi.stubEnv(
    "AI_PROPOSAL_SECRET",
    "test-secret-more-than-thirty-two-characters",
  );
  expect(providerConfig()).toMatchObject({
    url: "https://api.deepseek.com/chat/completions",
    model: "user-selected",
    format: "json_object",
    tokenField: "max_tokens",
  });
  vi.stubEnv("AI_ENABLE_PAID_CALLS", "false");
  expect(() => createProvider()).toThrow(/未启用/);
});
it("locally repairs fenced JSON and avoids a second model request", async () => {
  const request = vi
    .fn()
    .mockResolvedValue(
      model("\x60\x60\x60json\n" + JSON.stringify(example) + "\n\x60\x60\x60"),
    );
  vi.stubGlobal("fetch", request);
  expect(await requestAdvice(config, "Only JSON", {})).toMatchObject({
    providerCalls: 1,
    advice: example,
  });
  const body = JSON.parse(request.mock.calls[0][1].body);
  expect(body.response_format).toEqual({ type: "json_object" });
  expect(body.max_tokens).toBe(2500);
  expect(body.messages[0].content).toContain("JSON 示例");
});
it("retries invalid structured content once and accounts for tokens from both calls", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(model('{"wrong":true}'))
    .mockResolvedValueOnce(model(JSON.stringify(example)));
  vi.stubGlobal("fetch", request);
  vi.stubEnv("AI_INPUT_USD_PER_MILLION", "1");
  vi.stubEnv("AI_OUTPUT_USD_PER_MILLION", "2");
  const result = await requestAdvice(config, "Only JSON", {});
  expect(result).toMatchObject({
    providerCalls: 2,
    inputTokens: 80,
    outputTokens: 20,
    estimatedCostUsd: 0.00012,
  });
});
it("does not retry provider rejection or network uncertainty and reports unknown usage", async () => {
  const request = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 429 }));
  vi.stubGlobal("fetch", request);
  try {
    await requestAdvice(config, "Only JSON", {});
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).toMatchObject({
      usage: { providerCalls: 1, inputTokens: null, estimatedCostUsd: null },
    });
  }
  expect(request).toHaveBeenCalledTimes(1);
});
