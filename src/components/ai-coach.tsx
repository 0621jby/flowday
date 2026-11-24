"use client";
import { useEffect, useRef, useState } from "react";
import type { AppState } from "@/modules/core/model";
import type { Account, UpdateWorkspace } from "@/modules/cloud/client";
import { proposalSchema, type CoachProposal } from "@/modules/coach/proposal";
import { deltaSchema, mergeWorkspaceDelta } from "@/modules/cloud/delta";
import type { CoachInput } from "@/modules/coach/schema";
import {
  coachGuide,
  guideCopy,
  type CoachMode,
} from "@/modules/coach/guidance";
import type { executionProfile } from "@/modules/coach/context";
import { isPending } from "@/modules/core/execution";
import "./ai-coach.css";

type Preview = {
  proposal: CoachProposal;
  token: string;
  impact: string[];
  hasChanges: boolean;
  profile: ReturnType<typeof executionProfile>;
  mode: string;
  model: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number | null;
  };
  cached: boolean;
};
const modes = {
  goal: "目标拆解",
  help: "任务求助",
  plan: "调整计划",
  profile: "执行画像",
};
type CoachDraft = {
  text: string;
  choices: string[];
  allowReplan: boolean;
  latestDate: string;
  includeReviews: boolean;
};

function starterDraft(mode: CoachMode, text = ""): CoachDraft {
  return {
    text,
    allowReplan: false,
    latestDate: "",
    includeReviews: false,
    choices: text
      ? []
      : mode === "plan"
        ? ["plan-today"]
        : mode === "profile"
          ? ["profile-progress"]
          : [],
  };
}

function GuidanceOptions({
  mode,
  choices,
  onChange,
}: {
  mode: CoachMode;
  choices: string[];
  onChange: (choices: string[]) => void;
}) {
  const groups = coachGuide[mode];
  const extraCount = groups
    .filter((g) => g.extra)
    .flatMap((g) => g.options)
    .filter(([id]) => choices.includes(id)).length;
  function renderGroup(group: (typeof groups)[number]) {
    return (
      <fieldset className="ai-guide-group" key={group.label}>
        <legend>
          {group.label}
          {group.multiple && <small> · 可多选</small>}
        </legend>
        <div className="ai-guide-options">
          {group.options.map(([id, label]) => {
            const selected = choices.includes(id);
            return (
              <button
                key={id}
                type="button"
                className="ai-guide-option"
                aria-pressed={selected}
                onClick={() => {
                  const others = choices.filter(
                    (key) =>
                      key !== id &&
                      (selected ||
                        group.multiple ||
                        !group.options.some(([option]) => option === key)),
                  );
                  onChange(selected ? others : [...others, id]);
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }
  return (
    <div className="ai-guide" aria-label="快速描述情况">
      {groups.filter((g) => !g.extra).map(renderGroup)}
      <details key={mode} className="ai-guide-extra">
        <summary>
          更多可选条件{extraCount > 0 && `（已选 ${extraCount} 项）`}
        </summary>
        {groups.filter((g) => g.extra).map(renderGroup)}
        {mode === "plan" && <small>仅计入本次新增或重排的时间块和缓冲。</small>}
      </details>
    </div>
  );
}
export function AiCoachPanel({
  state,
  update,
  account,
  initialMode = "help",
  initialText,
  taskId = null,
  goalId = null,
  onApplied,
}: {
  state: AppState;
  update: UpdateWorkspace;
  account?: Account;
  initialMode?: CoachInput["mode"];
  initialText?: string;
  taskId?: string | null;
  goalId?: string | null;
  onApplied?: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const goal = state.goals.find((g) => g.id === goalId);
  const [selectedTask, setSelectedTask] = useState(taskId ?? "");
  const [drafts, setDrafts] = useState<Record<CoachMode, CoachDraft>>(() => {
    const result = {
      goal: starterDraft(
        "goal",
        goal ? `${goal.title}。${goal.description}` : "",
      ),
      help: starterDraft("help"),
      plan: starterDraft("plan"),
      profile: starterDraft("profile"),
    };
    if (initialText !== undefined)
      result[initialMode] = starterDraft(initialMode, initialText);
    return result;
  });
  const { text, choices, allowReplan, latestDate, includeReviews } =
    drafts[mode];
  const canDescribe =
    text.trim().length >= 2 || (mode !== "goal" && choices.length > 0);
  const hasHelpTask = state.tasks.some(
    (task) => task.id === selectedTask && isPending(task),
  );
  const [status, setStatus] = useState<{
    mode: string;
    model?: string;
    ready: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [success, setSuccess] = useState("");
  const lock = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    fetch("/api/coach", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    })
      .then((r) => r.json())
      .then((s) => {
        if (active.current) setStatus(s);
      })
      .catch(() => {
        if (active.current) setStatus({ mode: "unavailable", ready: false });
      });
    return () => {
      active.current = false;
    };
  }, []);
  const changed = () => {
    setPreview(null);
    setSuccess("");
    setError("");
  };
  function editDraft(patch: Partial<CoachDraft>) {
    setDrafts((current) => ({
      ...current,
      [mode]: { ...current[mode], ...patch },
    }));
    changed();
  }
  async function post(path: string, body: unknown) {
    const r = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(account ? { "x-flowday-account": account.id } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "AI 服务暂不可用。");
    return data;
  }
  return (
    <section className="ai-coach" aria-label="AI 执行教练">
      <div className="ai-coach-heading">
        <span className="tiny-tag">
          {!status
            ? "正在检查服务…"
            : status.mode === "mock"
              ? "Mock 演示 · 未连接真实 AI"
              : status.ready
                ? `模型：${status.model}`
                : "AI 未配置或不可用"}
        </span>
      </div>
      {state.settings.aiEnabled === false && (
        <p role="status">AI 已关闭，可以在个人设置中重新启用。</p>
      )}
      <div className="ai-coach-tabs">
        {Object.entries(modes).map(([key, label]) => (
          <button
            type="button"
            className={`button ${mode === key ? "primary" : "secondary"}`}
            key={key}
            disabled={busy}
            aria-pressed={mode === key}
            onClick={() => {
              setMode(key as CoachInput["mode"]);
              changed();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <fieldset disabled={busy} className="ai-coach-input">
        {mode === "help" && (
          <label>
            针对哪项任务？
            <select
              aria-label="AI 求助任务"
              value={selectedTask}
              onChange={(e) => {
                setSelectedTask(e.target.value);
                changed();
              }}
            >
              <option value="">选择任务</option>
              {state.tasks.filter(isPending).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <GuidanceOptions
          mode={mode}
          choices={choices}
          onChange={(choices) => editDraft({ choices })}
        />
        <label>
          {guideCopy[mode].label}
          {mode !== "goal" && "（可选）"}
          <textarea
            aria-label="给 AI 的情况说明"
            rows={3}
            maxLength={1200}
            value={text}
            onChange={(e) => editDraft({ text: e.target.value })}
            placeholder={guideCopy[mode].placeholder}
          />
        </label>
        {mode === "plan" && (
          <label className="ai-check">
            <input
              type="checkbox"
              checked={allowReplan}
              onChange={(e) => editDraft({ allowReplan: e.target.checked })}
            />
            允许调整已有时间块（锁定、已开始或专注中的除外）
          </label>
        )}
        {(mode === "goal" || mode === "plan") && (
          <label>
            本次最晚安排日期（可选）
            <input
              aria-label="本次最晚安排日期"
              type="date"
              value={latestDate}
              onChange={(e) => editDraft({ latestDate: e.target.value })}
            />
          </label>
        )}
        <label className="ai-check">
          <input
            type="checkbox"
            checked={includeReviews}
            onChange={(e) => editDraft({ includeReviews: e.target.checked })}
          />
          本次允许使用最近3篇复盘片段（每篇最多200字，不含涂鸦）
        </label>
        {mode === "profile" && !state.settings.growth?.shareWithAi && (
          <small>成长统计分享已关闭，可在个人设置中开启。</small>
        )}
        {status?.ready && status.mode !== "mock" && (
          <small>
            {mode === "profile"
              ? "模型服务会收到你的输入、可用时间及已授权分享的数据。"
              : "模型服务会收到你的输入、可用时间、相关任务（最多 40 项）、目标（最多 8 个）、排程及已授权分享的数据。"}
          </small>
        )}
        <button
          type="button"
          className="button primary"
          disabled={
            !status?.ready ||
            state.settings.aiEnabled === false ||
            !canDescribe ||
            (mode === "help" && !hasHelpTask)
          }
          onClick={async () => {
            if (lock.current) return;
            lock.current = true;
            setBusy(true);
            setError("");
            setPreview(null);
            setSuccess("");
            try {
              const input: CoachInput = {
                mode,
                text,
                ...(choices.length && { choices: [...choices].sort() }),
                taskId: mode === "help" ? selectedTask : null,
                goalId: mode === "goal" ? goalId : null,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                allowReplan,
                includeReviews,
                ...((mode === "goal" || mode === "plan") && latestDate
                  ? { latestDate }
                  : {}),
              };
              const result = await post("/api/coach", {
                input,
                ...(!account ? { state } : {}),
              });
              proposalSchema.parse(result.proposal);
              if (active.current) setPreview(result);
            } catch (e) {
              if (active.current)
                setError(
                  e instanceof Error && e.name !== "AbortError"
                    ? e.message
                    : "请求超时，未执行任何业务更改。请稍后重试。",
                );
            } finally {
              lock.current = false;
              if (active.current) setBusy(false);
            }
          }}
        >
          {busy ? "正在处理…" : "生成建议与预览"}
        </button>
      </fieldset>
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="ai-success" role="status">
          {success}
        </p>
      )}
      {preview && (
        <div className="ai-preview">
          <h3>分析结果</h3>
          <p>{preview.proposal.advice.analysis}</p>
          {preview.proposal.advice.hypotheses.length > 0 && (
            <>
              <h4>可能原因</h4>
              <ul>
                {preview.proposal.advice.hypotheses.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
          {preview.proposal.advice.clarifications.length > 0 && (
            <>
              <h4>需要澄清</h4>
              <ul>
                {preview.proposal.advice.clarifications.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
          <h3>建议内容</h3>
          <p>{preview.proposal.advice.recommendation}</p>
          {preview.proposal.advice.adjustPlan && <p>建议调整原计划。</p>}
          {preview.proposal.advice.stages.map((stage, i) => (
            <div className="ai-stage" key={i}>
              <h4>
                {i + 1}. {stage.title}
              </h4>
              <ul>
                {stage.tasks.map((t, j) => (
                  <li key={j}>
                    {t.title} · 预计{t.minutes}分钟 · 第{t.dayOffset + 1}天
                    {t.notes && <p>{t.notes}</p>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {preview.proposal.advice.steps.map((t, i) => (
            <p key={i}>
              {t.title} · 预计{t.minutes}分钟
              {t.notes && (
                <>
                  <br />
                  {t.notes}
                </>
              )}
            </p>
          ))}
          <details open={mode === "profile"}>
            <summary>参考记录</summary>
            <p>
              {preview.profile.window} · 已完成 {preview.profile.completedTasks}{" "}
              项任务，记录专注 {preview.profile.recordedFocusMinutes}{" "}
              分钟；有估时对比记录 {preview.profile.comparisonSamples}{" "}
              项；当前过期计划任务 {preview.profile.currentlyOverdueTasks} 项。
            </p>
            {preview.profile.recordedToEstimatedRatio !== null && (
              <p>
                记录片段总时长 / 样本估时：
                {preview.profile.recordedToEstimatedRatio}（不是完整实际耗时）
              </p>
            )}
            <ul>
              {preview.profile.limitations.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </details>
          <h3>预计影响</h3>
          {preview.impact.length ? (
            <ul>
              {preview.impact.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          ) : (
            <p>仅提供分析，不修改任务或计划。</p>
          )}
          {preview.proposal.advice.cautions.length > 0 && (
            <ul className="muted">
              {preview.proposal.advice.cautions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
          {preview.mode !== "mock" && (
            <details>
              <summary>模型用量与费用</summary>
              <small>
                {preview.cached && "复用已有建议 · "}输入{" "}
                {preview.usage.inputTokens ?? "未知"} / 输出{" "}
                {preview.usage.outputTokens ?? "未知"} Token · 估计费用{" "}
                {preview.usage.estimatedCostUsd === null
                  ? "未配置单价或服务未返回用量"
                  : `$${preview.usage.estimatedCostUsd.toFixed(6)}`}
              </small>
            </details>
          )}
          {preview.hasChanges && (
            <div className="ai-confirm">
              <p>
                确认后保存全部改动。方案 10 分钟内有效，数据变化后需重新生成。
              </p>
              <button
                type="button"
                className="button primary"
                disabled={busy || preview.proposal.revision !== state.revision}
                onClick={async () => {
                  if (lock.current) return;
                  lock.current = true;
                  setBusy(true);
                  setError("");
                  try {
                    const result = await post("/api/coach/confirm", {
                      token: preview.token,
                      ...(!account ? { state } : {}),
                    });
                    const changes = deltaSchema.parse(result.changes);
                    const ok = await update((current) => {
                      if (current.revision !== preview.proposal.revision)
                        throw new Error("数据已变化，请重新生成建议。");
                      return mergeWorkspaceDelta(current, changes);
                    });
                    if (!ok)
                      throw new Error(
                        "保存未确认成功，方案仍保留。请查看保存错误并重新同步后再生成，勿重复提交。",
                      );
                    setPreview(null);
                    setSuccess("建议已确认并保存，可回到任务或计划中查看。");
                    onApplied?.();
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : "确认失败，未确认保存成功。",
                    );
                  } finally {
                    lock.current = false;
                    setBusy(false);
                  }
                }}
              >
                确认执行此方案
              </button>
              {preview.proposal.revision !== state.revision && (
                <p role="alert">数据已变化，请重新生成建议。</p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
