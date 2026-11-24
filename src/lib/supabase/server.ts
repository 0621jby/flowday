import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cloudConfig, cookieOptions } from "./config";

export async function supabaseServer(readOnly = false) {
  const config = cloudConfig();
  if (!config) throw new Error("云端服务尚未配置。");
  const jar = await cookies();
  return createServerClient(config.url, config.key, {
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000),
        }),
    },
    cookieOptions: cookieOptions(),
    cookies: {
      getAll: () => jar.getAll(),
      setAll(items) {
        if (readOnly) return; // Page cookies are refreshed by proxy before rendering.
        items.forEach(({ name, value, options }) =>
          jar.set(name, value, { ...options, ...cookieOptions() }),
        );
      },
    },
  });
}
