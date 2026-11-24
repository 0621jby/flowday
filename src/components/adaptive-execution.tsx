"use client";
import { useEffect, useMemo, useState } from "react";
import {
  cloudData,
  type Account,
  type UpdateWorkspace,
} from "@/modules/cloud/client";
import { HistoryList } from "./saas-controls";
import { AiCoachPanel } from "./ai-coach";
import {
  executionCommand,
  growthDefaults,
  isPending,
  taskPhase,
  taskStatusLabels,
} from "@/modules/core/execution";
import {
  growthReport,
  growthRecommendations,
  loadForDay,
  type GrowthComparison,
  type GrowthPeriod,
} from "@/modules/core/growth";
import {
  localDate,
  uid,
  type AppState,
  type ExecutionEntry,
  type Task,
} from "@/modules/core/model";
import {
  adaptivePlan,
  confirmAdaptive,
  createSplit,
  type AdaptiveOptions,
} from "@/modules/planning/adaptive";
import { dayAvailability } from "@/modules/planning/availability";
import { addDays } from "@/modules/planning/calendar";
import { clockTime } from "@/modules/planning/scheduler";
import "./adaptive-execution.css";

export function AdaptivePanel({
  state,
  taskId,
  update,
  onSaved,
  account,
}: {
  state: AppState;
  taskId?: string;
  update: UpdateWorkspace;
  onSaved: () => void;
  account?: Account;
}) {
  const today = localDate();
  const [horizon, setHorizon] = useState<AdaptiveOptions["horizon"]>(3);
  const [urgentId, setUrgent] = useState(taskId ?? "");
  const [extra, setExtra] = useState(0);
  const [replan, setReplan] = useState(false);
  const [history, setHistory] = useState(
    (state.settings.growth ?? growthDefaults).personalize,
  );
  const [deferId, setDeferId] = useState("");
  const [deferDate, setDeferDate] = useState(addDays(today, 1));
  const [preview, setPreview] = useState<ReturnType<typeof adaptivePlan>>();
  const [message, setMessage] = useState("");
  const [explain, setExplain] = useState(false);
  const [recentPlan, setRecentPlan] = useState<{
    planned: number;
    matched: number;
  }>();
  useEffect(() => {
    if (!account || !(state.settings.growth ?? growthDefaults).personalize)
      return;
    let alive = true;
    const read = (days: string) =>
      cloudData<GrowthComparison>(account, {
        kind: "growth",
        days,
        end: today,
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    void read("30")
      .catch(() => read("7"))
      .then((data) => {
        if (alive) setRecentPlan(data.current);
      })
      .catch(() => {
        if (alive) setRecentPlan(undefined);
      });
    return () => {
      alive = false;
    };
  }, [account, today, state.revision, state.settings.growth]);
  const load = loadForDay(state, today);
  const eligible = state.tasks.filter(isPending);
  function edit() {
    setPreview(undefined);
    setMessage("");
    setExplain(false);
  }
  const explanation = [
    "请解释排程变更与取舍，以清单中的理由为准。",
    ...(preview?.changes
      .slice(0, 5)
      .map((c) => `${c.title}：${c.before} → ${c.after}（${c.reason}）`) ?? []),
  ]
    .join("\n")
    .slice(0, 1200);
  return (
    <div className="execution-controls">
      <p>
        今天还剩 {load.available} 分钟可用时间。待执行约{" "}
        {Math.round(load.requested)} 分钟，其中 {load.high} 项为高优先级。
      </p>
      {load.over > 0 && (
        <p className="execution-hint">
          比含休息的建议预算多 {Math.ceil(load.over)}{" "}
          分钟。可以延期低优先级任务，或先拆分大任务。
        </p>
      )}
      <fieldset onChange={edit} className="execution-fields">
        <label className="field">
          预览范围
          <select
            value={horizon}
            onChange={(e) =>
              setHorizon(Number(e.target.value) as typeof horizon)
            }
          >
            {[1, 3, 7, 14].map((n) => (
              <option key={n} value={n}>
                {n === 1 ? "今天" : `未来 ${n} 天（含今天）`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          优先处理临时或超时任务
          <select value={urgentId} onChange={(e) => setUrgent(e.target.value)}>
            <option value="">按截止日期与优先级</option>
            {eligible.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        {urgentId && (
          <label className="field">
            额外预留分钟（超时可填）
            <input
              type="number"
              min={0}
              max={240}
              step={5}
              value={extra}
              onChange={(e) => setExtra(Number(e.target.value))}
            />
          </label>
        )}
        <label className="execution-check">
          <input
            type="checkbox"
            checked={replan}
            onChange={(e) => setReplan(e.target.checked)}
          />
          允许重排未锁定、尚未开始的预约或已错过的预约
        </label>
        <label className="execution-check">
          <input
            type="checkbox"
            checked={history}
            disabled={!(state.settings.growth ?? growthDefaults).personalize}
            onChange={(e) => setHistory(e.target.checked)}
          />
          依据同类耗时和近期计划表现留出空间
        </label>
        <label className="field">
          为降低负荷明确延期一项
          <select value={deferId} onChange={(e) => setDeferId(e.target.value)}>
            <option value="">不指定延期</option>
            {eligible.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        {deferId && (
          <label className="field">
            延期到
            <input
              type="date"
              min={today}
              value={deferDate}
              onChange={(e) => setDeferDate(e.target.value)}
            />
          </label>
        )}
      </fieldset>
      <button
        type="button"
        className="button secondary"
        onClick={() => {
          edit();
          try {
            if (
              !Number.isInteger(extra) ||
              extra < 0 ||
              extra > 240 ||
              extra % 5 !== 0
            )
              throw new Error("额外时间请填 0–240 分钟，按 5 分钟递增。");
            setPreview(
              adaptivePlan(state, {
                horizon,
                replan,
                recentPlan,
                useHistory: history,
                urgentId: urgentId || undefined,
                extraMinutes: extra,
                defer: deferId
                  ? { taskId: deferId, date: deferDate }
                  : undefined,
              }),
            );
          } catch (e) {
            setMessage((e as Error).message);
          }
        }}
      >
        预览调整
      </button>
      {message && (
        <p role="alert" className="execution-hint">
          {message}
        </p>
      )}
      {preview && (
        <div className="execution-preview">
          <h3>调整前后对比</h3>
          {preview.conflicts.length > 0 && (
            <div className="execution-hint">
              <strong>原计划与当前条件的冲突</strong>
              <ul>
                {preview.conflicts.map((c) => (
                  <li key={c.id}>
                    {c.title} · {c.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p>
            保留 {preview.protectedCount}{" "}
            项已有或受保护的安排。新安排使用剩余可用时间的大约{" "}
            {Math.round(preview.bufferRatio * 100)}%，同时在任务间留出休息。
          </p>
          {!preview.changes.length && (
            <p>当前条件下无需或无法新增安排。已有计划保持原样。</p>
          )}
          {preview.changes.map((item) => (
            <article key={item.id}>
              <strong>{item.title}</strong>
              <p>
                原安排 · {item.before}
                <br />
                建议 · {item.after}
              </p>
              <small>{item.reason}</small>
            </article>
          ))}
          {preview.skipped.length > 0 && (
            <details open={!preview.changes.length}>
              <summary>{preview.skipped.length} 项未安排</summary>
              <ul>
                {preview.skipped.map((item) => (
                  <li key={item.id}>
                    {item.title} · {item.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {preview.changes.length > 0 && (
            <button
              type="button"
              className="button primary"
              disabled={preview.revision !== state.revision}
              onClick={async () => {
                try {
                  confirmAdaptive(state, preview);
                  if (await update((s) => confirmAdaptive(s, preview)))
                    onSaved();
                  else setMessage("保存未确认。请检查同步状态后重新预览。");
                } catch (e) {
                  setMessage((e as Error).message);
                }
              }}
            >
              确认保存此计划
            </button>
          )}
          {preview.changes.length > 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() => setExplain(!explain)}
            >
              用 AI 解读计划变化
            </button>
          )}
          {explain && (
            <AiCoachPanel
              state={state}
              account={account}
              update={update}
              initialMode="profile"
              initialText={explanation}
            />
          )}
          {preview.revision !== state.revision && (
            <p role="alert">数据已更新，请重新预览。</p>
          )}
        </div>
      )}
    </div>
  );
}

const logLabels = {
  start: "开始",
  pause: "暂停",
  resume: "恢复专注",
  stop: "结束专注",
  complete: "完成",
  reopen: "重新打开",
  defer: "延期",
  abandon: "放弃",
  restore: "恢复任务",
  commit: "确认预约",
  split: "拆分",
};
export function TaskExecutionDetails({
  account,
  state,
  task,
  update,
  onPlan,
}: {
  account?: Account;
  state: AppState;
  task: Task;
  update: UpdateWorkspace;
  onPlan: () => void;
}) {
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [steps, setSteps] = useState([
    { title: "", minutes: 25 },
    { title: "", minutes: 25 },
  ]);
  const [showSplit, setShowSplit] = useState(false);
  const [message, setMessage] = useState("");
  const children = state.tasks.filter((t) => t.execution?.parentId === task.id);
  const timeline = (state.executionLog ?? []).filter(
    (e) => e.taskId === task.id,
  );
  const focus = state.events
    .filter((e) => e.taskId === task.id && e.type === "focus")
    .reduce((sum, e) => sum + (e.seconds ?? 0), 0);
  const elapsed = timeline.reduce((sum, e) => sum + (e.elapsedSeconds ?? 0), 0);
  const phase = taskPhase(state, task);
  const locked = state.blocks.some((b) => b.taskId === task.id && b.locked);
  const pending = isPending(task);
  async function change(command: "abandon" | "restore") {
    setMessage("");
    if (await update((s) => executionCommand(s, task.id, command)))
      setConfirmAbandon(false);
    else setMessage("没有保存成功。请检查任务状态和同步提示。");
  }
  return (
    <details className="execution-details">
      <summary>执行记录与后续安排</summary>
      <p>
        {account && "近期记录 · "}
        {taskStatusLabels[phase]} · 已记录专注 {Math.round(focus / 60)} 分钟 ·
        已记录经过 {Math.round(elapsed / 60)} 分钟
      </p>
      <p>
        暂停 {timeline.filter((e) => e.type === "pause").length} 次 · 向后改期{" "}
        {timeline.filter((e) => e.type === "defer").length} 次
      </p>
      {children.length > 0 && (
        <p>
          拆分进度 {children.filter((t) => t.status === "done").length}/
          {children.length} · {children.map((t) => t.title).join("、")}
        </p>
      )}
      {account ? (
        <>
          <HistoryList<ExecutionEntry>
            account={account}
            kind="execution"
            task={task.id}
            revision={state.revision}
            render={(entry) => (
              <>
                {new Date(entry.at).toLocaleString("zh-CN")} ·{" "}
                {logLabels[entry.type]}{" "}
                {entry.from && entry.to && `· ${entry.from} → ${entry.to}`}
              </>
            )}
          />
          <details>
            <summary>专注片段</summary>
            <HistoryList<AppState["events"][number]>
              account={account}
              kind="focus"
              task={task.id}
              revision={state.revision}
              render={(event) => (
                <>
                  {new Date(event.at).toLocaleString("zh-CN")} ·{" "}
                  {Math.round((event.seconds ?? 0) / 60)} 分钟
                </>
              )}
            />
          </details>
        </>
      ) : timeline.length > 0 ? (
        <ol className="execution-history">
          {[...timeline].reverse().map((e) => (
            <li key={e.id}>
              <time dateTime={e.at}>
                {new Date(e.at).toLocaleString("zh-CN")}
              </time>{" "}
              · {logLabels[e.type]}
              {e.firstAt && (
                <> · 开始于 {new Date(e.firstAt).toLocaleString("zh-CN")}</>
              )}
              {e.focusSeconds !== undefined && (
                <> · 专注 {Math.round(e.focusSeconds / 60)} 分钟</>
              )}
              {e.elapsedSeconds !== undefined && (
                <> / 经过 {Math.round(e.elapsedSeconds / 60)} 分钟</>
              )}
              {e.from && e.to && (
                <>
                  {" "}
                  · {e.from} → {e.to}
                </>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">
          新版执行记录从下一次操作开始积累。旧版专注分钟仍计入。
        </p>
      )}
      <div className="execution-actions">
        {pending && (
          <button type="button" className="button secondary" onClick={onPlan}>
            预览延期或重排
          </button>
        )}
        {pending &&
          !children.length &&
          !task.execution?.parentId &&
          !locked &&
          phase !== "running" &&
          phase !== "paused" && (
            <button
              type="button"
              className="button secondary"
              onClick={() => setShowSplit(!showSplit)}
            >
              拆分任务
            </button>
          )}
        {pending && phase !== "running" && phase !== "paused" && !locked && (
          <button
            type="button"
            className="text-button delete-text"
            onClick={() => setConfirmAbandon(true)}
          >
            放弃任务
          </button>
        )}
        {phase === "abandoned" && (
          <button
            type="button"
            className="button secondary"
            onClick={() => void change("restore")}
          >
            恢复为待开始
          </button>
        )}
      </div>
      {confirmAbandon && (
        <div className="execution-hint">
          <p>放弃后会移出待办与日历，执行历史保留。你可随时恢复。</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => setConfirmAbandon(false)}
          >
            取消
          </button>
          <button
            type="button"
            className="button danger"
            onClick={() => void change("abandon")}
          >
            确认放弃
          </button>
        </div>
      )}
      {showSplit && (
        <div className="execution-preview">
          <p>
            填写可独立执行的步骤。原任务保留并展示步骤进度，原预约会释放，步骤可以跨日排程。
          </p>
          {steps.map((step, i) => (
            <div className="form-grid" key={i}>
              <label className="field">
                步骤 {i + 1}
                <input
                  maxLength={200}
                  value={step.title}
                  onChange={(e) =>
                    setSteps(
                      steps.map((s, j) =>
                        i === j ? { ...s, title: e.target.value } : s,
                      ),
                    )
                  }
                />
              </label>
              <label className="field">
                步骤 {i + 1} 预计分钟
                <input
                  type="number"
                  min={5}
                  max={480}
                  value={step.minutes}
                  onChange={(e) =>
                    setSteps(
                      steps.map((s, j) =>
                        i === j ? { ...s, minutes: Number(e.target.value) } : s,
                      ),
                    )
                  }
                />
              </label>
            </div>
          ))}
          <div className="execution-actions">
            <button
              type="button"
              className="button secondary"
              disabled={steps.length >= 6}
              onClick={() => setSteps([...steps, { title: "", minutes: 25 }])}
            >
              追加步骤
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={steps.length <= 2}
              onClick={() => setSteps(steps.slice(0, -1))}
            >
              移除最后一步
            </button>
            <button
              type="button"
              className="button primary"
              onClick={async () => {
                try {
                  createSplit(state, task.id, steps);
                  if (await update((s) => createSplit(s, task.id, steps))) {
                    setShowSplit(false);
                    setMessage("拆分已保存。");
                  } else setMessage("拆分未确认保存。");
                } catch (e) {
                  setMessage((e as Error).message);
                }
              }}
            >
              确认创建 {steps.length} 个步骤
            </button>
          </div>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}

export function GrowthPanel({
  account,
  advanced,
  state,
  onCoach,
}: {
  account?: Account;
  advanced?: boolean;
  state: AppState;
  onCoach: () => void;
}) {
  const [days, setDays] = useState<1 | 7 | 30 | 90>(7);
  const today = localDate();
  const [end, setEnd] = useState("");
  const [cloudReport, setCloudReport] = useState<GrowthComparison | null>(null);
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!account) return;
    let current = true;
    setCloudReport(null);
    setFailure("");
    void cloudData<GrowthComparison>(account, {
      kind: "growth",
      days: String(days),
      end: end || today,
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
      .then((value) => {
        if (current) setCloudReport(value);
      })
      .catch((error) => {
        if (current) setFailure(error.message);
      });
    return () => {
      current = false;
    };
  }, [account, days, end, today, attempt, state.revision]);
  const report = useMemo(() => {
    if (!account)
      return growthReport(state, days, end || today, undefined, today);
    if (!cloudReport) return null;
    const preferences = state.settings.growth ?? growthDefaults;
    return {
      ...cloudReport,
      preference: preferences.preferred,
      suggestions: preferences.personalize
        ? growthRecommendations(cloudReport.current)
        : [],
    };
  }, [account, cloudReport, state, days, end, today]);
  const row = (label: string, a: number | string, b: number | string) => (
    <tr key={label}>
      <th scope="row">{label}</th>
      <td>{a}</td>
      <td>{b}</td>
    </tr>
  );
  const ratio = (p: GrowthPeriod) =>
    p.planned ? `${p.matched} / ${p.planned}` : "暂无到期预约记录";
  const error = (p: GrowthPeriod) =>
    p.estimateError === null
      ? `样本不足（${p.samples}）`
      : `${p.estimateError}%（${p.samples} 项）`;
  return (
    <section className="panel growth-report">
      <h2>个人执行画像与成长报告</h2>
      <div className="execution-actions">
        {(
          [
            [1, "每日"],
            [7, "每周"],
            [30, "每月"],
            [90, "长期"],
          ] as const
        ).map(([count, title]) => (
          <button
            key={count}
            type="button"
            disabled={count > 7 && advanced === false}
            aria-pressed={days === count}
            className={`button ${days === count ? "primary" : "secondary"}`}
            onClick={() => setDays(count)}
          >
            {title}
          </button>
        ))}
        <button type="button" className="text-button" onClick={onCoach}>
          请 AI 解读趋势
        </button>
      </div>
      <label className="field">
        统计截至日期
        <input
          type="date"
          max={today}
          value={end || today}
          onChange={(e) =>
            setEnd(
              e.target.value && e.target.value <= today ? e.target.value : "",
            )
          }
        />
      </label>
      {!report ? (
        <p role={failure ? "alert" : "status"}>
          {failure || "正在汇总云端报告…"}
          {failure && (
            <button
              type="button"
              className="text-button"
              onClick={() => setAttempt((n) => n + 1)}
            >
              重试
            </button>
          )}
        </p>
      ) : (
        <>
          <p>
            {report.current.first} 至 {report.current.last} · 对比前一个等长周期
          </p>
          <div className="growth-table">
            <table>
              <thead>
                <tr>
                  <th>记录</th>
                  <th>本期</th>
                  <th>前期</th>
                </tr>
              </thead>
              <tbody>
                {row(
                  "完成次数",
                  report.current.completed,
                  report.previous.completed,
                )}
                {row(
                  "有执行记录的天数",
                  report.current.activeDays,
                  report.previous.activeDays,
                )}
                {row(
                  "专注分钟",
                  report.current.focusMinutes,
                  report.previous.focusMinutes,
                )}
                {row(
                  "向后改期次数",
                  report.current.postponements,
                  report.previous.postponements,
                )}
                {row(
                  "预约日完成 / 已到期预约",
                  ratio(report.current),
                  ratio(report.previous),
                )}
                {row(
                  "估时典型偏差",
                  error(report.current),
                  error(report.previous),
                )}
              </tbody>
            </table>
          </div>
          <details className="execution-details">
            <summary>不同时段与任务类型</summary>
            <ul>
              {report.current.periods.map((p) => (
                <li key={p.label}>
                  {p.label} · {p.completed} 次完成 · {p.focusMinutes}{" "}
                  分钟专注（按结束时段归类）
                </li>
              ))}
            </ul>
            <ul>
              {report.current.categories.map((c) => (
                <li key={c.kind}>
                  {c.label} · {c.completed} 次完成 · {c.delays} 次向后改期 ·{" "}
                  {c.typicalMinutes === null
                    ? `耗时样本不足（${c.samples}）`
                    : `典型专注 ${c.typicalMinutes} 分钟（${c.samples} 项）`}
                </li>
              ))}
            </ul>
            <p>
              偏好节奏 ·{" "}
              {
                {
                  any: "任意时段",
                  morning: "上午",
                  afternoon: "下午",
                  evening: "晚上",
                }[report.preference]
              }
            </p>
          </details>
          <h3>可试的下一步</h3>
          {report.suggestions.length ? (
            <ul>
              {report.suggestions.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : (
            <p>
              目前可用样本不足，或你已关闭个性化建议。按自己的节奏积累记录即可。
            </p>
          )}
          <small>
            计划对比只使用新版已确认预约，今天的预约尚未结算。时段分布无法判断因果，计时也无法衡量全部工作。
          </small>
        </>
      )}
    </section>
  );
}

export function GrowthPreferences({
  state,
  update,
  personalization,
}: {
  state: AppState;
  update: UpdateWorkspace;
  personalization?: boolean;
}) {
  const [date, setDate] = useState(localDate());
  const [message, setMessage] = useState("");
  const prefs = state.settings.growth ?? growthDefaults;
  const day = dayAvailability(state, date);
  function save(action: (s: AppState) => AppState) {
    setMessage("");
    void update(action).then((ok) =>
      setMessage(
        ok
          ? "设置已保存。已有预约原样保留，可在自适应排程预览冲突和调整。"
          : "未确认保存，请检查同步提示。",
      ),
    );
  }
  return (
    <section className="panel growth-report">
      <h2>执行节奏与隐私</h2>
      <label className="execution-check">
        <input
          type="checkbox"
          checked={prefs.personalize}
          disabled={personalization === false}
          onChange={(e) => {
            const checked = e.target.checked;
            save((s) => ({
              ...s,
              settings: {
                ...s.settings,
                growth: {
                  ...(s.settings.growth ?? growthDefaults),
                  personalize: checked,
                },
              },
            }));
          }}
        />
        本地使用历史生成个性化估时与负荷建议
      </label>
      <label className="execution-check">
        <input
          type="checkbox"
          checked={prefs.shareWithAi}
          onChange={(e) => {
            const checked = e.target.checked;
            save((s) => ({
              ...s,
              settings: {
                ...s.settings,
                growth: {
                  ...(s.settings.growth ?? growthDefaults),
                  shareWithAi: checked,
                },
              },
            }));
          }}
        />
        允许 AI 读取成长统计摘要（默认关闭，复盘文字仍单独授权）
      </label>
      <label className="field">
        偏好安排时段
        <select
          value={prefs.preferred}
          onChange={(e) => {
            const preferred = e.target.value as typeof prefs.preferred;
            save((s) => ({
              ...s,
              settings: {
                ...s.settings,
                growth: { ...(s.settings.growth ?? growthDefaults), preferred },
              },
            }));
          }}
        >
          <option value="any">任意时段</option>
          <option value="morning">上午</option>
          <option value="afternoon">下午</option>
          <option value="evening">晚上</option>
        </select>
      </label>
      <details className="execution-details">
        <summary>临时可用时间和固定日程</summary>
        <label className="field">
          配置哪一天
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value || localDate())}
          />
        </label>
        <form
          key={`${date}-${day.start}-${day.end}-${day.capacity}`}
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const start = toMinute(String(form.get("start")));
            const end = toMinute(String(form.get("end")));
            const capacity = Number(form.get("capacity"));
            if (end <= start) {
              setMessage("结束时间应晚于开始时间。");
              return;
            }
            save((s) => ({
              ...s,
              availability: [
                ...(s.availability ?? []).filter((d) => d.date !== date),
                { date, start, end, capacity },
              ],
            }));
          }}
        >
          <div className="form-grid">
            <label className="field">
              可用开始
              <input
                name="start"
                type="time"
                required
                defaultValue={clockTime(day.start)}
              />
            </label>
            <label className="field">
              可用结束
              <input
                name="end"
                type="time"
                required
                defaultValue={clockTime(Math.min(day.end, 1439))}
              />
            </label>
            <label className="field">
              当天可用分钟
              <input
                name="capacity"
                type="number"
                min={0}
                max={720}
                required
                defaultValue={day.capacity}
              />
            </label>
          </div>
          <div className="execution-actions">
            <button className="button primary" type="submit">
              保存当天可用时间
            </button>
            {state.availability?.some((d) => d.date === date) && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  save((s) => ({
                    ...s,
                    availability: s.availability?.filter(
                      (d) => d.date !== date,
                    ),
                  }))
                }
              >
                恢复默认时段
              </button>
            )}
          </div>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const title = String(form.get("fixedTitle")).trim();
            const start = toMinute(String(form.get("fixedStart")));
            const end = toMinute(String(form.get("fixedEnd")));
            if (!title || end <= start) {
              setMessage("请输入名称和有效的固定时间。");
              return;
            }
            save((s) => ({
              ...s,
              fixedTimes: [
                ...(s.fixedTimes ?? []),
                { id: uid(), title, date, start, end },
              ],
            }));
          }}
        >
          <div className="form-grid">
            <label className="field">
              固定日程名称
              <input
                name="fixedTitle"
                required
                maxLength={100}
                placeholder="例如：午休或会议"
              />
            </label>
            <label className="field">
              固定开始
              <input name="fixedStart" type="time" required />
            </label>
            <label className="field">
              固定结束
              <input name="fixedEnd" type="time" required />
            </label>
          </div>
          <button className="button secondary" type="submit">
            添加固定日程
          </button>
        </form>
        <ul>
          {state.fixedTimes
            ?.filter((b) => b.date === date)
            .map((b) => (
              <li key={b.id}>
                {b.title} · {clockTime(b.start)}–{clockTime(b.end)}{" "}
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    save((s) => ({
                      ...s,
                      fixedTimes: s.fixedTimes?.filter((t) => t.id !== b.id),
                    }))
                  }
                >
                  移除
                </button>
              </li>
            ))}
        </ul>
      </details>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
function toMinute(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}
