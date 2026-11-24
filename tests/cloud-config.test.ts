import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudConfig, cookieOptions } from "../src/lib/supabase/config";

afterEach(() => vi.unstubAllEnvs());
describe("cloud configuration and session cookies", () => {
  it("keeps explicit local mode but rejects partial cloud configuration", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    expect(cloudConfig()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    expect(() => cloudConfig()).toThrow(/不完整/);
  });
  it("rejects both modern secret keys and legacy service_role JWTs", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_secret_test_only");
    expect(() => cloudConfig()).toThrow(/密钥/);
    const encoded = Buffer.from(JSON.stringify({role:"service_role"})).toString("base64url");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", `test.${encoded}.test`);
    expect(() => cloudConfig()).toThrow(/anon/);
  });
  it("restricts insecure cookies to an explicitly enabled loopback origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FLOWDAY_ALLOW_LOCAL_HTTP", "1");
    vi.stubEnv("APP_ORIGIN", "http://public.example");
    expect(cookieOptions()).toMatchObject({secure:true,httpOnly:true,sameSite:"lax"});
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3100");
    expect(cookieOptions().secure).toBe(false);
    vi.stubEnv("FLOWDAY_ALLOW_LOCAL_HTTP", "");
    expect(cookieOptions().secure).toBe(true);
  });
});
