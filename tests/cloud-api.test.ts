import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedState } from "../src/modules/core/model";
const mock = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  config: vi.fn(),
}));
vi.mock("@/lib/supabase/config", () => ({ cloudConfig: mock.config }));
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({ auth: mock, rpc: mock.rpc }),
}));
import { GET, PUT, PATCH } from "../src/app/api/workspace/route";
import { POST } from "../src/app/api/auth/[action]/route";

const account = "11111111-1111-4111-8111-111111111111";
const origin = "http://127.0.0.1:3100";
function request(body?: unknown, owner = account) {
  return new Request(`${origin}/api/workspace`, {
    method: body ? "PUT" : "GET",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "x-flowday-account": owner,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function payload() {
  const state = seedState();
  return {
    state,
    expectedRevision: 0,
    mutationId: crypto.randomUUID(),
    importLocal: true,
  };
}
function auth(action: string, body?: unknown) {
  return POST(
    new Request(`${origin}/api/auth/${action}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    { params: Promise.resolve({ action }) },
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", origin);
  mock.config.mockReturnValue({
    url: "https://example.invalid",
    key: "test-only",
  });
  mock.getUser.mockResolvedValue({
    data: { user: { id: account } },
    error: null,
  });
});
describe("API authorization / persistence contract (provider mocked)", () => {
  it("rejects unauthenticated reads/writes before querying data", async () => {
    mock.getUser.mockResolvedValue({
      data: { user: null },
      error: new Error("expired"),
    });
    expect((await GET(request())).status).toBe(401);
    expect((await PUT(request(payload()))).status).toBe(401);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("rejects stale tabs after account switch", async () => {
    expect((await GET(request(undefined, "other-account"))).status).toBe(401);
    expect((await PUT(request(payload(), "other-account"))).status).toBe(401);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("sets private no-store responses and validates cloud data", async () => {
    mock.rpc.mockResolvedValue({ data: seedState(), error: null });
    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toContain("no-store");
    expect((await result.json()).state.tasks).toHaveLength(4);
  });
  it("validates before writing and maps stale versions to 409", async () => {
    const invalid = payload();
    invalid.state.tasks[0].minutes = 0;
    expect((await PUT(request(invalid))).status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
    mock.rpc.mockResolvedValue({
      error: { message: "REVISION_CONFLICT", code: "P0001" },
    });
    expect((await PUT(request(payload()))).status).toBe(409);
  });
  it("applies only the submitted changes and returns an idempotent receipt", async () => {
    mock.rpc.mockResolvedValue({
      data: { revision: 1, savedRevision: 1 },
      error: null,
    });
    const changes = { tasks: { put: [seedState().tasks[0]], remove: [] } };
    const input = new Request(origin + "/api/workspace", {
      method: "PATCH",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-flowday-account": account,
      },
      body: JSON.stringify({
        revision: 0,
        mutationId: crypto.randomUUID(),
        changes,
      }),
    });
    expect(await (await PATCH(input)).json()).toEqual({
      revision: 1,
      savedRevision: 1,
    });
    expect(mock.rpc.mock.calls[0][0]).toBe("flowday_apply_delta");
    expect(mock.rpc.mock.calls[0][1].p_delta.tasks.put).toHaveLength(1);
  });
  it("checks every saved field rather than claiming success from row counts alone", async () => {
    const data = payload();
    const changed = structuredClone(data.state);
    changed.tasks[0].title = "different";
    mock.rpc.mockResolvedValue({
      data: { state: changed, alreadyImported: false },
      error: null,
    });
    expect((await PUT(request(data))).status).toBe(503);
    mock.rpc.mockResolvedValue({
      data: { state: { ...data.state, revision: 1 }, alreadyImported: false },
      error: null,
    });
    const ok = await PUT(request(data));
    expect(ok.status).toBe(200);
    expect((await ok.json()).verified).toBe(true);
  });
  it("fails closed when unconfigured and does not expose SQL details", async () => {
    mock.config.mockReturnValue(null);
    expect((await GET(request())).status).toBe(503);
    mock.config.mockReturnValue({});
    mock.rpc.mockResolvedValue({
      error: { message: "secret connection details" },
    });
    const r = await GET(request());
    expect(await r.text()).not.toContain("secret");
  });
});
describe("authentication route contract (provider mocked)", () => {
  it("enforces signup password rules before contacting the provider", async () => {
    expect(
      (await auth("signup", { email: "a@example.com", password: "short" }))
        .status,
    ).toBe(400);
    expect(mock.signUp).not.toHaveBeenCalled();
  });
  it("distinguishes email verification from an authenticated session", async () => {
    mock.signUp.mockResolvedValue({ data: { session: null }, error: null });
    const r = await auth("signup", {
      email: "a@example.com",
      password: "safe-test-password123",
    });
    expect((await r.json()).authenticated).toBe(false);
    expect(mock.signUp.mock.calls[0][0].options.emailRedirectTo).toBe(
      `${origin}/auth/callback`,
    );
  });
  it("supports login/logout and reports provider throttling without leaking details", async () => {
    mock.signInWithPassword.mockResolvedValue({
      data: { session: { access_token: "test-only" } },
      error: null,
    });
    expect(
      (
        await (
          await auth("login", { email: "a@example.com", password: "password" })
        ).json()
      ).authenticated,
    ).toBe(true);
    mock.signOut.mockResolvedValue({ error: null });
    expect((await auth("logout")).status).toBe(200);
    mock.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { status: 429, message: "private" },
    });
    const r = await auth("login", {
      email: "a@example.com",
      password: "password",
    });
    expect(r.status).toBe(429);
    expect(await r.text()).not.toContain("private");
  });
});
