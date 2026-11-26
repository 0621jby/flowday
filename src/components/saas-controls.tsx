"use client";
import { HourSelect } from "./time-controls";
import { useEffect, useState, type ReactNode } from "react";
import {
  cloudData,
  downloadBackup,
  type Account,
  type CloudAccess,
  type HistoryPage,
  type UpdateWorkspace,
} from "@/modules/cloud/client";
import { growthDefaults } from "@/modules/core/execution";
import { localDate, uid, type AppState, type Task } from "@/modules/core/model";
import { adaptivePlan, confirmAdaptive } from "@/modules/planning/adaptive";
import { clockTime } from "@/modules/planning/scheduler";
import "./cloud.css";

export function useAccess(account?: Account) {
  const [access, setAccess] = useState<CloudAccess | null>(null);
  useEffect(() => {
    if (!account) return;
    let alive = true;
    const load = () => {
      void cloudData<CloudAccess>(account, { kind: "access" })
        .then((value) => {
          if (alive) setAccess(value);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 30000);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [account]);
  return access;
}

export function DataControls({
  account,
  state,
  access,
  update,
  hasPending,
  onClear,
}: {
  account?: Account;
  state: AppState;
  access: CloudAccess | null;
  update: UpdateWorkspace;
  hasPending: boolean;
  onClear: () => Promise<boolean>;
}) {
  const [action, setAction] = useState<"clear" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const phrase = action === "clear" ? "清空云端数据" : "永久删除账户";
  return (
    <section className="panel cloud-panel">
      <h2>数据与 AI 权限</h2>
      {account && (
        <p>
          {access
            ? `${access.plan === "pro" ? "Pro" : "Free"} · 今日 AI 请求 ${access.usedToday} / ${access.aiPerDay}，每分钟上限 ${access.aiPerMinute}（按 UTC 日期重置）。`
            : "正在读取账户权益…"}
        </p>
      )}
      {access && (
        <p className="muted">
          模型请求 {access.providerCallsToday} 次 · 输入{" "}
          {access.inputTokensToday} Token · 输出 {access.outputTokensToday}{" "}
          Token · 已知估算费用{" "}
          {access.estimatedCostToday === null
            ? "暂无"
            : `$${Number(access.estimatedCostToday).toFixed(6)}`}
          {access.unknownUsageToday
            ? ` · ${access.unknownUsageToday} 笔用量或费用未确认`
            : ""}
        </p>
      )}
      <label className="execution-check">
        <input
          type="checkbox"
          checked={state.settings.aiEnabled !== false}
          onChange={(e) => {
            const aiEnabled = e.target.checked;
            void update((s) => ({
              ...s,
              settings: { ...s.settings, aiEnabled },
            }));
          }}
        />
        允许使用 AI 教练
      </label>
      <p className="muted">成长统计与复盘分享权限在执行节奏设置中单独管理。</p>
      {account && (
        <>
          <div className="cloud-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setMessage("");
                try {
                  const backup = await cloudData<Record<string, unknown>>(
                    account,
                    { kind: "export" },
                  );
                  downloadBackup(
                    JSON.stringify(backup, null, 2),
                    `flowday-cloud-${localDate()}.json`,
                  );
                } catch (e) {
                  setMessage((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              导出完整云端数据
            </button>
            <button
              type="button"
              className="text-button delete-text"
              disabled={busy || hasPending}
              onClick={() => {
                setAction("clear");
                setMessage("");
              }}
            >
              清理云端工作区
            </button>
            <button
              type="button"
              className="text-button delete-text"
              disabled={busy || hasPending || !access?.accountDeletion}
              onClick={() => {
                setAction("delete");
                setMessage("");
              }}
            >
              删除账户
            </button>
          </div>
          {access && !access.accountDeletion && (
            <p className="muted">此部署尚未启用自助删除账户。</p>
          )}
          {action && (
            <form
              key={action}
              className="execution-hint"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                if (form.get("phrase") !== phrase) {
                  setMessage("确认文字不一致。");
                  return;
                }
                setBusy(true);
                setMessage("");
                try {
                  const response = await fetch("/api/workspace/data", {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "x-flowday-account": account.id,
                    },
                    body: JSON.stringify({
                      action,
                      phrase,
                      revision: state.revision,
                      ...(action === "delete" && {
                        password: form.get("password"),
                      }),
                    }),
                    signal: AbortSignal.timeout(25000),
                  });
                  const payload = await response.json();
                  if (!response.ok) throw new Error(payload.error);
                  if (action === "delete") {
                    window.location.replace("/auth");
                    return;
                  }
                  setAction(null);
                  setMessage(
                    (await onClear())
                      ? "云端工作区已清空。"
                      : "已确认清理，请重新同步云端。",
                  );
                } catch (e) {
                  setMessage((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p>
                {action === "clear"
                  ? "将清除云端任务、目标、复盘、时间块、执行历史和偏好。保留账户及不含内容的额度记录。"
                  : "将永久删除账户和关联的云端数据。"}{" "}
                原始浏览器本地工作区仍保留。建议先导出。
              </p>
              <label className="field">
                输入「{phrase}」
                <input name="phrase" autoComplete="off" required />
              </label>
              {action === "delete" && (
                <label className="field">
                  重新输入登录密码
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    disabled={busy}
                  />
                </label>
              )}
              <div className="execution-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setAction(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="button danger"
                  disabled={busy || hasPending}
                >
                  {busy ? "正在处理…" : phrase}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

export function HistoryList<T>({
  account,
  kind,
  task,
  render,
  revision,
  empty = "暂无记录",
}: {
  account: Account;
  kind: string;
  task?: string;
  revision: number;
  render: (row: T, loadedRevision: number) => ReactNode;
  empty?: string;
}) {
  const [page, setPage] = useState<HistoryPage<T> | null>(null);
  const [items, setItems] = useState<T[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadedRevision, setLoadedRevision] = useState<number>();
  const stale = loadedRevision !== undefined && loadedRevision !== revision;
  async function load() {
    setBusy(true);
    setError("");
    try {
      const next = await cloudData<HistoryPage<T>>(account, {
        kind,
        ...(task ? { task } : {}),
        ...(!stale && page?.next
          ? (Object.fromEntries(
              Object.entries(page.next).filter(
                ([, value]) => typeof value === "string",
              ),
            ) as Record<string, string>)
          : {}),
      });
      setItems((current) =>
        page && !stale ? [...current, ...next.items] : next.items,
      );
      setPage(next);
      setLoadedRevision(revision);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="cloud-history">
      {items.length > 0 && (
        <ol>
          {items.map((item, index) => (
            <li key={index}>{render(item, loadedRevision!)}</li>
          ))}
        </ol>
      )}
      {page && !items.length && <p className="muted">{empty}</p>}
      {error && (
        <p className="execution-hint" role="alert">
          {error}
        </p>
      )}
      {(!page || page.next || stale) && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy
            ? "正在读取…"
            : stale
              ? "刷新记录"
              : page
                ? "加载更多"
                : "读取历史记录"}
        </button>
      )}
    </div>
  );
}

export function FirstRun({
  state,
  update,
  onClose,
}: {
  state: AppState;
  update: UpdateWorkspace;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [capacity, setCapacity] = useState(state.settings.capacity);
  const [start, setStart] = useState(state.settings.dayStart);
  const [end, setEnd] = useState(state.settings.dayEnd);
  const [preferred, setPreferred] = useState(
    (state.settings.growth ?? growthDefaults).preferred,
  );
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState(25);
  const [preview, setPreview] = useState<ReturnType<typeof adaptivePlan>>();
  const [message, setMessage] = useState("");
  function draft() {
    const next = structuredClone(state);
    next.settings = {
      ...next.settings,
      capacity,
      dayStart: start,
      dayEnd: end,
      onboardingComplete: true,
      growth: { ...(next.settings.growth ?? growthDefaults), preferred },
    };
    const goalId = goal.trim() ? uid() : null;
    if (goalId)
      next.goals.push({
        id: goalId,
        title: goal.trim(),
        description: "",
        color: "green",
        targetDate: "",
      });
    if (title.trim()) {
      const task: Task = {
        id: uid(),
        title: title.trim(),
        notes: "",
        minutes,
        priority: "medium",
        status: "todo",
        goalId,
        date: localDate(),
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      next.tasks.push(task);
    }
    return next;
  }
  return (
    <div className="execution-controls">
      <p>只需几个安排就能开始，之后随时可以修改。</p>
      {step === 0 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (end <= start) {
              setMessage("结束时间应晚于开始时间。");
              return;
            }
            setMessage("");
            setStep(1);
          }}
        >
          <div className="form-grid">
            <label className="field">
              每天可用分钟
              <input
                type="number"
                min={30}
                max={720}
                required
                value={capacity}
                onChange={(e) => setCapacity(+e.target.value)}
              />
            </label>
            <label className="field">
              默认开始
              <HourSelect
                min={0}
                max={23}
                value={start}
                onChange={(e) => setStart(+e.target.value)}
              />
            </label>
            <label className="field">
              默认结束
              <HourSelect
                min={1}
                max={24}
                value={end}
                onChange={(e) => setEnd(+e.target.value)}
              />
            </label>
            <label className="field">
              偏好节奏
              <select
                value={preferred}
                onChange={(e) =>
                  setPreferred(e.target.value as typeof preferred)
                }
              >
                <option value="any">都可以</option>
                <option value="morning">上午</option>
                <option value="afternoon">下午</option>
                <option value="evening">晚上</option>
              </select>
            </label>
          </div>
          <button className="button primary" type="submit">
            继续
          </button>
        </form>
      )}
      {step === 1 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setMessage("");
            try {
              const next = draft();
              setPreview(
                adaptivePlan(next, {
                  horizon: 1,
                  replan: false,
                  useHistory: false,
                }),
              );
              setStep(2);
            } catch (error) {
              setMessage((error as Error).message);
            }
          }}
        >
          <label className="field">
            第一个目标（选填）
            <input
              maxLength={200}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </label>
          <label className="field">
            第一个任务（选填）
            <input
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          {title.trim() && (
            <label className="field">
              预计分钟
              <input
                required
                type="number"
                min={5}
                max={480}
                value={minutes}
                onChange={(e) => setMinutes(+e.target.value)}
              />
            </label>
          )}
          <div className="execution-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => setStep(0)}
            >
              上一步
            </button>
            <button type="submit" className="button primary">
              预览第一份计划
            </button>
          </div>
        </form>
      )}
      {step === 2 && preview && (
        <>
          <h3>你的第一份计划</h3>
          {goal.trim() && <p>目标 · {goal.trim()}</p>}
          {title.trim() && (
            <p>
              任务 · {title.trim()} · {minutes} 分钟
            </p>
          )}
          {preview.state.blocks.length ? (
            <ul>
              {preview.state.blocks.map((b) => (
                <li key={b.taskId}>
                  {b.date} · {clockTime(b.start)}–{clockTime(b.end)}
                </li>
              ))}
            </ul>
          ) : (
            <p>目前没有预约时段。可先保存任务，再从计划日历安排。</p>
          )}
          <div className="execution-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => setStep(1)}
            >
              返回修改
            </button>
            <button
              type="button"
              className="button primary"
              onClick={async () => {
                if (
                  await update((s) => {
                    if (s.tasks.length || s.goals.length)
                      throw new Error("已存在任务或目标，请回到工作台。");
                    return confirmAdaptive(s, preview);
                  })
                )
                  onClose();
                else setMessage("尚未保存。请检查同步状态，必要时重新预览。");
              }}
            >
              确认并开始
            </button>
          </div>
        </>
      )}
      <button type="button" className="text-button" onClick={onClose}>
        稍后设置
      </button>
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
