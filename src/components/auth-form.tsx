"use client";
import { useEffect, useState } from "react";
import { Leaf } from "lucide-react";
import "./cloud.css";

export function AuthForm({ configured }: { configured: boolean }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (new URLSearchParams(location.search).has("verification"))
      setMessage(
        "验证链接未能完成登录，请在收到邮件的同一浏览器打开，或尝试使用密码登录。",
      );
  }, []);
  return (
    <main className="auth-shell">
      <section className="panel auth-card">
        <a className="auth-brand" href="/">
          <Leaf /> FlowDay.
        </a>
        <h1>
          {mode === "login" ? "回来，继续向前一点" : "给重要的事，留一个位置"}
        </h1>
        <p className="muted">登录后，任务、目标和复盘会保存在你的账户中。</p>
        {!configured ? (
          <>
            <p role="status">
              云端服务尚未配置。当前数据仍保存在本浏览器，不会上传。
            </p>
            <a className="button primary" href="/">
              继续本地体验
            </a>
          </>
        ) : (
          <>
            <div className="auth-tabs">
              <button
                className={
                  mode === "login" ? "button primary" : "button secondary"
                }
                disabled={busy}
                onClick={() => {
                  setMode("login");
                  setMessage("");
                }}
              >
                登录
              </button>
              <button
                className={
                  mode === "signup" ? "button primary" : "button secondary"
                }
                disabled={busy}
                onClick={() => {
                  setMode("signup");
                  setMessage("");
                }}
              >
                注册
              </button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (busy) return;
                const form = e.currentTarget;
                const data = new FormData(form);
                setBusy(true);
                setMessage("");
                try {
                  const response = await fetch(`/api/auth/${mode}`, {
                    signal: AbortSignal.timeout(25000),
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      email: data.get("email"),
                      password: data.get("password"),
                    }),
                  });
                  const result = await response.json();
                  if (!response.ok) throw new Error(result.error);
                  if (result.authenticated) {
                    window.location.assign("/");
                    return;
                  }
                  form.reset();
                  setMessage(result.message);
                } catch (e) {
                  setMessage(
                    e instanceof Error ? e.message : "网络连接失败，请重试。",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                邮箱
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  disabled={busy}
                />
              </label>
              <label>
                密码
                <input
                  key={mode}
                  name="password"
                  type="password"
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  minLength={mode === "signup" ? 12 : 1}
                  maxLength={128}
                  required
                  disabled={busy}
                />
              </label>
              {mode === "signup" && (
                <small>至少 12 位，包含字母和数字。请使用独立密码。</small>
              )}
              <button className="button primary" type="submit" disabled={busy}>
                {busy
                  ? "正在处理…"
                  : mode === "login"
                    ? "登录 FlowDay"
                    : "创建账户"}
              </button>
            </form>
            <p className="muted">
              本地数据不会自动上传。登录后可以预览并确认迁移。
            </p>
          </>
        )}
        {message && (
          <p className="cloud-message" role="status">
            {message}
          </p>
        )}
      </section>
    </main>
  );
}
