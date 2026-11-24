import { describe, expect, it, vi, afterEach } from "vitest";
import { seedState } from "../src/modules/core/model";
import {
  canonicalWorkspace,
  validateWorkspace,
} from "../src/modules/cloud/validation";
import { saveCloud } from "../src/modules/cloud/client";
import { HttpError, readJson, sameOrigin } from "../src/lib/http";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("cloud boundary", () => {
  it("accepts legacy IDs but rejects duplicate / dangling references / invalid dates", () => {
    const s = seedState();
    expect(validateWorkspace(s).tasks[0].id).toBe("t1");
    s.tasks.push(s.tasks[0]);
    expect(() => validateWorkspace(s)).toThrow();
    s.tasks.pop();
    s.tasks[0].goalId = "missing";
    expect(() => validateWorkspace(s)).toThrow();
    s.tasks[0].goalId = null;
    s.tasks[0].date = "2026-02-30";
    expect(() => validateWorkspace(s)).toThrow();
  });
  it("canonicalizes DB date and optional field formats without losing business data", () => {
    const a = seedState();
    const b = structuredClone(a);
    b.revision = 100;
    b.tasks[0].createdAt = new Date(a.tasks[0].createdAt)
      .toISOString()
      .replace("Z", "+00:00");
    expect(canonicalWorkspace(a)).toBe(canonicalWorkspace(b));
  });
  it("rejects cross-site mutations, missing origin and oversized chunked payloads", async () => {
    vi.stubEnv("APP_ORIGIN", "https://flowday.example");
    expect(() =>
      sameOrigin(
        new Request("https://flowday.example/api/workspace", {
          headers: { Origin: "https://evil.example" },
        }),
      ),
    ).toThrow(HttpError);
    expect(() =>
      sameOrigin(new Request("https://flowday.example/api/workspace")),
    ).toThrow(HttpError);
    expect(() =>
      sameOrigin(
        new Request("https://flowday.example/api/workspace", {
          headers: { Origin: "https://flowday.example" },
        }),
      ),
    ).not.toThrow();
    await expect(
      readJson(
        new Request("https://flowday.example", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "x".repeat(100) }),
        }),
        20,
      ),
    ).rejects.toThrow(/上限/);
  });
  it("retries a lost response with exactly the same idempotency ID and explicit account binding", async () => {
    const s = seedState();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network lost"))
      .mockResolvedValueOnce(Response.json({ state: { ...s, revision: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      (await saveCloud({ id: "account-a", email: "a@example.com" }, s)).state
        .revision,
    ).toBe(1);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      fetchMock.mock.calls[1][1].body,
    );
    expect(fetchMock.mock.calls[0][1].headers["x-flowday-account"]).toBe(
      "account-a",
    );
  });
  it("does not retry conflicts or authentication failures as a new write", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "冲突" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      saveCloud({ id: "a", email: "" }, seedState()),
    ).rejects.toThrow("冲突");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
