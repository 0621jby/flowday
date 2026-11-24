import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { seedState } from "../src/modules/core/model";
import { growthReport } from "../src/modules/core/growth";
const mock = vi.hoisted(() => ({
  config: vi.fn(),
  getUser: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/config", () => ({
  cloudConfig: mock.config,
  cookieOptions: () => ({}),
}));
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: { getUser: mock.getUser },
    rpc: mock.rpc,
  }),
}));
import { POST } from "../src/app/api/coach/route";
import { POST as CONFIRM } from "../src/app/api/coach/confirm/route";
const actor = "11111111-1111-4111-8111-111111111111";
const origin = "http://127.0.0.1:3100";
function request(body: unknown, account = actor, source = origin) {
  return new Request(`${origin}/api/coach`, {
    method: "POST",
    headers: {
      Origin: source,
      "Content-Type": "application/json",
      "x-flowday-account": account,
    },
    body: JSON.stringify(body),
  });
}
const input = {
  mode: "goal",
  text: "建立持续阅读习惯，每天20分钟",
  taskId: null,
  goalId: null,
  timezone: "Asia/Shanghai",
  allowReplan: false,
  includeReviews: false,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("AI_PROVIDER", "mock");
  vi.stubEnv(
    "AI_PROPOSAL_SECRET",
    "test-secret-with-more-than-thirty-two-characters",
  );
  mock.config.mockReturnValue({});
  mock.getUser.mockResolvedValue({
    data: { user: { id: actor } },
    error: null,
  });
  mock.rpc.mockImplementation(async (name: string) =>
    name === "flowday_access"
      ? { data: { aiEnabled: true, advancedGrowth: true }, error: null }
      : name === "flowday_bootstrap"
        ? { data: seedState(), error: null }
        : name === "flowday_ai_reserve"
          ? { data: { id: crypto.randomUUID(), cached: null }, error: null }
          : { data: null, error: null },
  );
});
afterEach(() => vi.unstubAllEnvs());
describe("AI API authenticated boundary (Mock only)", () => {
  it("queries only the selected profile window and keeps the previous period opt-in", async () => {
    const state = seedState();
    const growth = {
      shareWithAi: true,
      personalize: true,
      preferred: "any" as const,
    };
    state.settings.growth = growth;
    mock.rpc.mockImplementation(
      async (
        name: string,
        args?: { p_end: string; p_days: 7 | 30; p_zone: string },
      ) => {
        if (name === "flowday_access")
          return {
            data: { aiEnabled: true, advancedGrowth: true },
            error: null,
          };
        if (name === "flowday_bootstrap") return { data: state, error: null };
        if (name === "flowday_growth_report" && args)
          return {
            data: growthReport(state, args.p_days, args.p_end, args.p_zone),
            error: null,
          };
        if (name === "flowday_ai_reserve")
          return {
            data: { id: crypto.randomUUID(), cached: null },
            error: null,
          };
        return { data: null, error: null };
      },
    );
    const result = await POST(
      request({
        input: {
          ...input,
          mode: "profile",
          text: "",
          choices: ["profile-month"],
        },
      }),
    );
    expect(result.status).toBe(200);
    expect((await result.json()).profile.window).toContain("近 30 天");
    const calls = mock.rpc.mock.calls.filter(
      ([name]) => name === "flowday_growth_report",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ p_days: 30 });
  });

  it("does not load growth statistics unless the account has given permission", async () => {
    const result = await POST(
      request({
        input: {
          ...input,
          mode: "profile",
          text: "",
          choices: ["profile-compare"],
        },
      }),
    );
    expect(result.status).toBe(200);
    expect(
      mock.rpc.mock.calls.some(([name]) => name === "flowday_growth_report"),
    ).toBe(false);
  });
  it("blocks cross-origin, expired session and account switching before model or quota access", async () => {
    expect(
      (await POST(request({ input }, actor, "https://evil.invalid"))).status,
    ).toBe(403);
    mock.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await POST(request({ input }))).status).toBe(401);
    mock.getUser.mockResolvedValue({
      data: { user: { id: actor } },
      error: null,
    });
    expect((await POST(request({ input }, "other-account"))).status).toBe(401);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("ignores browser-supplied cloud data, reads authoritative context and never writes business data during generation/confirmation", async () => {
    const response = await POST(
      request({ input, state: { tasks: [{ title: "伪造他人资料" }] } }),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.mode).toBe("mock");
    expect(data.proposal.revision).toBe(0);
    const confirmed = await CONFIRM(
      request({ token: data.token, state: { bad: true } }),
    );
    expect(confirmed.status).toBe(200);
    expect(mock.rpc.mock.calls.some((c) => c[0] === "flowday_save")).toBe(
      false,
    );
    expect(
      mock.rpc.mock.calls.filter((c) => c[0] === "flowday_bootstrap"),
    ).toHaveLength(2);
  });
  it("rejects tampered confirmations and quota errors without granting changes", async () => {
    const response = await POST(request({ input }));
    const data = await response.json();
    expect(
      (await CONFIRM(request({ token: `${data.token}tampered` }))).status,
    ).toBe(400);
    mock.rpc.mockImplementation(async (name: string) =>
      name === "flowday_access"
        ? { data: { aiEnabled: true, advancedGrowth: true }, error: null }
        : name === "flowday_bootstrap"
          ? { data: seedState(), error: null }
          : { data: null, error: { message: "AI_RATE_LIMIT" } },
    );
    expect((await POST(request({ input }))).status).toBe(429);
  });
  it("fails closed when AI migration is unavailable or the context has changed before confirmation", async () => {
    const response = await POST(request({ input }));
    const data = await response.json();
    mock.rpc.mockImplementation(async (name: string) =>
      name === "flowday_access"
        ? { data: { aiEnabled: true }, error: null }
        : { data: { ...seedState(), revision: 1 }, error: null },
    );
    const r = await CONFIRM(request({ token: data.token }));
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("数据已变化");
    mock.rpc.mockImplementation(async (name: string) =>
      name === "flowday_access"
        ? { data: { aiEnabled: true, advancedGrowth: true }, error: null }
        : name === "flowday_bootstrap"
          ? { data: seedState(), error: null }
          : { error: { message: "function not found" } },
    );
    expect((await POST(request({ input }))).status).toBe(503);
  });
});
