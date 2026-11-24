import { HttpError } from "@/lib/http";
import { cloudConfig } from "./config";
import { supabaseServer } from "./server";

export async function cloudActor(request: Request) {
  if (!cloudConfig()) throw new HttpError(503, "云端服务尚未配置。");
  const client = await supabaseServer();
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (!user || error)
    throw new HttpError(401, "登录已失效。请重新登录后继续。");
  if (request.headers.get("x-flowday-account") !== user.id)
    throw new HttpError(401, "账户已切换。请重新打开页面。");
  return { client, user };
}
