"use client";
import { useEffect, useState } from "react";
import { type AppState } from "@/modules/core/model";
import { STORAGE_KEY } from "@/modules/core/repository";
import {
  canonicalWorkspace,
  validateWorkspace,
} from "@/modules/cloud/validation";
import { type Account, downloadBackup, importComparable } from "@/modules/cloud/client";
import "./cloud.css";

type ImportResult = {
  state: AppState;
  alreadyImported?: boolean;
  verified?: boolean;
};
export function CloudAccount({
  account,
  revision,
  saving,
  refresh,
  importLocal,
}: {
  account: Account;
  revision: number;
  saving: boolean;
  refresh: () => Promise<boolean>;
  importLocal: (state: AppState) => Promise<ImportResult>;
}) {
  const [source, setSource] = useState<AppState | null>(null);
  const [raw, setRaw] = useState("");
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [imported, setImported] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    try {
      const text = localStorage.getItem(STORAGE_KEY);
      if (text) {
        setRaw(text);
        setSource(validateWorkspace(JSON.parse(text)));
      }
    } catch {
      setMessage(
        "检测到本地数据，但校验未通过。请先下载原始备份；不会自动覆盖或清空。",
      );
    }
  }, []);
  return (
    <section className="panel cloud-panel">
      <h2>你的云端账户</h2>
      <p className="cloud-account">{account.email}</p>
      <p className="muted">
        保存成功后可跨设备读取。其他设备的更改可通过重新同步获取。
      </p>
      <div className="cloud-actions">
        <button
          className="button secondary"
          disabled={saving || busy}
          onClick={async () => {
            if (await refresh())
              setMessage("已读取最新云端数据。未保存的表单草稿仍留在页面中。");
          }}
        >
          重新同步
        </button>
        <button
          className="text-button"
          disabled={saving || busy}
          onClick={async () => {
            if (!window.confirm("确认退出？请先保存尚未提交的任务或复盘草稿。"))
              return;
            setBusy(true);
            try {
              const r = await fetch("/api/auth/logout", {
                method: "POST",
                signal: AbortSignal.timeout(25000),
              });
              if (!r.ok) throw new Error("退出失败，请重试。");
              window.location.assign("/auth");
            } catch (e) {
              setMessage((e as Error).message);
              setBusy(false);
            }
          }}
        >
          退出登录
        </button>
        <a
          className="text-button"
          href="/auth"
          target="_blank"
          rel="noopener noreferrer"
        >
          重新登录
        </a>
      </div>
      {raw && !imported && (
        <>
          <hr />
          <h2>发现此浏览器的本地数据</h2>
          <p>
            确认后将以下内容导入 <strong>{account.email}</strong>
            。原始浏览器数据会保留。共享设备请先检查内容是否属于你。
          </p>
          {source && (
            <>
              <div className="cloud-counts">
                <span>{source.tasks.length} 项任务</span>
                <span>{source.goals.length} 个目标</span>
                <span>{source.blocks.length} 个时间块</span>
                <span>{source.reviews.length} 天复盘</span>
                <span>{source.events.length} 条执行记录</span>
              </div>
              <details>
                <summary>查看待迁移内容</summary>
                <p>
                  偏好：{source.settings.name} · 每日 {source.settings.capacity}{" "}
                  分钟。
                  {source.session
                    ? "包含正在记录的专注计时。"
                    : "没有进行中的专注。"}
                  文字、心情与涂鸦会一起迁移。
                </p>
                <ul>
                  {source.goals.map((g) => (
                    <li key={g.id}>目标：{g.title}</li>
                  ))}
                  {source.tasks.map((t) => (
                    <li key={t.id}>
                      {t.title} · {t.date || "未定日期"} ·{" "}
                      {t.status === "done" ? "已完成" : "待完成"}
                    </li>
                  ))}
                  {source.reviews.map((r) => (
                    <li key={r.date}>
                      复盘 {r.date}：{r.text.slice(0, 80)}
                      {r.drawing?.length ? "（含涂鸦）" : ""}
                    </li>
                  ))}
                </ul>
              </details>
              {revision > 0 && (
                <p>
                  云端已有修改：仅允许确认同一份数据此前是否已导入，不会覆盖现有内容或自动合并。
                </p>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy || saving}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />{" "}
                我已核对内容及目标账户，确认迁移
              </label>
            </>
          )}
          <div className="cloud-actions">
            <button
              className="button secondary"
              onClick={() => downloadBackup(raw, "flowday-local-original.json")}
            >
              下载原始备份
            </button>
            {source && (
              <button
                className="button primary"
                disabled={!confirmed || busy || saving}
                onClick={async () => {
                  setBusy(true);
                  setMessage("");
                  try {
                    if (localStorage.getItem(STORAGE_KEY) !== raw)
                      throw new Error(
                        "本地数据刚刚发生变化，请刷新页面后重新预览，避免漏掉新内容。",
                      );
                    const result = await importLocal(source);
                    if (
                      !result.alreadyImported &&
                      (!result.verified ||
                        canonicalWorkspace(importComparable(result.state)) !==
                          canonicalWorkspace(importComparable(source)))
                    )
                      throw new Error(
                        "完整性验证未通过。原始数据已保留，请重新同步检查。",
                      );
                    setImported(true);
                    setMessage(
                      result.alreadyImported
                        ? "这份数据此前已成功导入，未重复写入。当前显示最新云端内容，本地原始数据仍保留。"
                        : "迁移完成，已逐项回读核对。原始本地数据仍保留，可继续下载备份。",
                    );
                  } catch (e) {
                    setMessage(
                      e instanceof Error
                        ? e.message
                        : "迁移未成功，原始数据仍保留。",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy
                  ? "正在核对与迁移…"
                  : revision > 0
                    ? "核对迁移记录"
                    : "确认迁移到此账户"}
              </button>
            )}
          </div>
        </>
      )}
      {imported && (
        <button
          className="text-button"
          onClick={() => downloadBackup(raw, "flowday-local-original.json")}
        >
          下载保留的本地原始备份
        </button>
      )}
      {message && (
        <p className="cloud-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
