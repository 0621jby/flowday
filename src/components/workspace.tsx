"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  CloudOff,
  Flag,
  Focus,
  Leaf,
  ListTodo,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Target,
  Trash2,
  X,
} from "lucide-react";
import {
  AdaptivePanel,
  GrowthPanel,
  GrowthPreferences,
  TaskExecutionDetails,
} from "./adaptive-execution";
import {
  executionCommand,
  isPending,
  removeTaskLinks,
  taskPhase,
  taskStatusLabels,
} from "@/modules/core/execution";
import { estimateFor, loadForDay } from "@/modules/core/growth";
import { taskKinds } from "@/modules/core/model";
import { AiCoachPanel } from "./ai-coach";
import type { CoachInput } from "@/modules/coach/schema";
import { ReviewJournal } from "@/components/review-journal";
import { CompletionChart } from "@/components/completion-chart";
import {
  DataControls,
  FirstRun,
  HistoryList,
  useAccess,
} from "./saas-controls";
import { STORAGE_KEY } from "@/modules/core/repository";
import { cloudData, downloadBackup } from "@/modules/cloud/client";
import { HourSelect } from "./time-controls";
import { CloudAccount } from "./cloud-account";
import { type Account } from "@/modules/cloud/client";
import "./cloud.css";
import { useWorkspace } from "@/modules/core/use-workspace";
import { removeGoal } from "@/modules/core/goals";
import { orderTasks } from "@/modules/core/task-order";
import {
  type AppState,
  type Task,
  type Goal,
  localDate,
  uid,
} from "@/modules/core/model";
import { PlanningCalendar } from "@/components/planning-calendar";
import { applyCalendarChange } from "@/modules/planning/calendar";
import { recoverySuggestion, type Obstacle } from "@/modules/coach/coach";

type View =
  "today" | "tasks" | "plan" | "goals" | "review" | "insights" | "settings";
const navItems = [
  { id: "today", label: "我的一天", icon: Sun },
  { id: "tasks", label: "所有任务", icon: ListTodo },
  { id: "plan", label: "计划日历", icon: CalendarDays },
  { id: "goals", label: "我的目标", icon: Target },
  { id: "review", label: "每日复盘", icon: BookOpen },
  { id: "insights", label: "数据洞察", icon: BarChart3 },
] as const;
const priorityLabel = { high: "高优先级", medium: "中优先级", low: "低优先级" };
function minutesLabel(m: number) {
  return m >= 60
    ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ""}`
    : `${m} 分钟`;
}
function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Leaf size={30} />
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const first = ref.current?.querySelector<HTMLElement>(
      "input,textarea,select,button",
    );
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const elements = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,textarea,[tabindex="0"]',
        );
        const visible = Array.from(elements ?? []).filter(
          (el) => el.getClientRects().length > 0,
        );
        if (!visible.length) return;
        const first = visible[0],
          last = visible[visible.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export function Workspace({ account }: { account?: Account }) {
  const {
    state,
    update,
    error,
    setError,
    ready,
    saving,
    refresh,
    importLocal,
    pending,
    conflict,
    online,
    syncIssue,
    retry,
    discardPending,
    hydrate,
  } = useWorkspace(account);
  const access = useAccess(account);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [localSource, setLocalSource] = useState(false);
  const [totals, setTotals] = useState<{
    completed: number;
    focusMinutes: number;
    reviews: number;
  } | null>(null);
  useEffect(() => {
    if (account) {
      try {
        setLocalSource(!!localStorage.getItem(STORAGE_KEY));
      } catch {}
    }
  }, [account]);
  const [view, setView] = useState<View>("today");
  useEffect(() => {
    if (!account || view !== "insights") return;
    let active = true;
    void cloudData<{
      completed: number;
      focusMinutes: number;
      reviews: number;
    }>(account, { kind: "totals" })
      .then((data) => {
        if (active) setTotals(data);
      })
      .catch(() => {
        if (active) setTotals(null);
      });
    return () => {
      active = false;
    };
  }, [account, view, state?.revision]);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<Task | "new" | null>(null);
  const [newTaskDate, setNewTaskDate] = useState(localDate());
  const [goalOpen, setGoalOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [deletingGoal, setDeletingGoal] = useState<Goal | null>(null);
  const [deleteGoalTasks, setDeleteGoalTasks] = useState(false);
  const [adaptiveOpen, setAdaptiveOpen] = useState(false);
  const [adaptiveTask, setAdaptiveTask] = useState<string>();
  const [coachTask, setCoachTask] = useState<Task | null>(null);
  const [aiRequest, setAiRequest] = useState<{
    mode: CoachInput["mode"];
    goalId?: string;
  } | null>(null);
  const [obstacle, setObstacle] = useState<Obstacle>("large");
  const [toast, setToast] = useState("");
  const [notifications, setNotifications] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [goalFilter, setGoalFilter] = useState<string | null>(null);
  const [deleteTask, setDeleteTask] = useState<Task | null>(null);
  const today = localDate(new Date(now));
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.key.toLowerCase() === "n" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !target.closest(
          'input,textarea,select,[contenteditable], [role="dialog"]',
        )
      ) {
        event.preventDefault();
        openNewTask();
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  function openNewTask(date = localDate()) {
    setNewTaskDate(date);
    setEditor("new");
  }
  const notify = (message: string) => setToast(message);
  if (!ready)
    return (
      <div className="loading">
        <span className="brand-mark">
          <Leaf />
        </span>
        <h2>FlowDay</h2>
        <p>给重要的事，留一点时间。</p>
        <LoaderCircle className="spin" />
      </div>
    );
  if (!state)
    return (
      <main className="loading">
        <h2>数据需要检查</h2>
        <p>{error}</p>
        <p>请保留浏览器中的 flowday.workspace.v1 数据，不要清除存储。</p>
        <button
          className="button secondary"
          onClick={() => window.location.reload()}
        >
          重新读取
        </button>
        {account && (
          <a href="/auth" className="text-button">
            重新登录
          </a>
        )}
      </main>
    );
  const orderedTasks = orderTasks(state.tasks);
  const todayTasks = orderedTasks.filter(
    (t) =>
      t.date === today &&
      (t.status === "done" || isPending(t)) &&
      !state.tasks.some((child) => child.execution?.parentId === t.id),
  );
  const doneToday = todayTasks.filter((t) => t.status === "done");
  const pendingToday = todayTasks.filter((t) => t.status === "todo");
  const topTask = pendingToday[0];
  const plannedMinutes = pendingToday.reduce((n, t) => n + t.minutes, 0);
  const progress = todayTasks.length
    ? Math.round((doneToday.length / todayTasks.length) * 100)
    : 0;
  const session = state.session;
  const sessionTask = state.tasks.find((t) => t.id === session?.taskId);
  const elapsed = session
    ? session.accumulated +
      (session.running
        ? Math.max(0, Math.floor((now - session.startedAt) / 1000))
        : 0)
    : 0;
  const goalOf = (t: Task) => state.goals.find((g) => g.id === t.goalId);
  const focusSeconds = state.events
    .filter((e) => e.type === "focus" && localDate(new Date(e.at)) === today)
    .reduce((n, e) => n + (e.seconds ?? 0), 0);
  async function commit(
    change: (s: AppState) => AppState,
    message?: string,
    options?: Parameters<typeof update>[1],
  ) {
    if (await update(change, options)) {
      if (message) notify(message);
      return true;
    }
    return false;
  }
  function toggleTask(task: Task) {
    const command = task.execution?.abandonedAt
      ? "restore"
      : task.status === "done"
        ? "reopen"
        : "complete";
    return commit(
      (s) => executionCommand(s, task.id, command),
      command === "complete" ? "任务已完成" : "任务已重新打开",
    );
  }
  async function startTask(task: Task) {
    if (session && session.taskId !== task.id) {
      setFocusOpen(true);
      notify("请先结束当前专注，再开始另一项任务。");
      return;
    }
    if (
      !session &&
      !(await commit((s) => executionCommand(s, task.id, "start")))
    )
      return;
    setFocusOpen(true);
  }
  async function stopFocus() {
    if (
      sessionTask &&
      (await commit(
        (s) => executionCommand(s, sessionTask.id, "stop"),
        "专注时长已记录",
      ))
    )
      setFocusOpen(false);
  }
  function openAdaptive(taskId?: string) {
    setAdaptiveTask(taskId);
    setAdaptiveOpen(true);
  }
  function navigate(next: View) {
    setView(next);
    setGoalFilter(null);
    setQuery("");
  }
  const renderTaskRow = (task: Task, compact = false) => (
    <div
      key={task.id}
      className={`task-row ${task.status === "done" ? "is-done" : ""}`}
    >
      <button
        className="task-check"
        onClick={() => toggleTask(task)}
        aria-label={
          task.execution?.abandonedAt
            ? `恢复 ${task.title}`
            : task.status === "done"
              ? `重新打开 ${task.title}`
              : `完成 ${task.title}`
        }
      >
        {task.status === "done" ? <Check size={14} /> : null}
      </button>
      <button className="task-main" onClick={() => setEditor(task)}>
        <strong>{task.title}</strong>
        <span>
          <small>{taskStatusLabels[taskPhase(state, task, today)]}</small>
          {goalOf(task) && (
            <>
              <i className={`dot ${goalOf(task)?.color}`} />
              {goalOf(task)?.title}
              <b>·</b>
            </>
          )}
          <Clock3 size={12} />
          {task.minutes} 分钟
          {!compact && task.date !== today && (
            <>
              <b>·</b>
              {task.date || "未安排日期"}
            </>
          )}
        </span>
      </button>
      <span className={`priority ${task.priority}`}>
        <Flag size={12} />
        <span>{priorityLabel[task.priority]}</span>
      </span>
      {isPending(task) && (
        <button
          className="icon-btn row-play"
          onClick={() => startTask(task)}
          aria-label={`开始 ${task.title}`}
        >
          <Play size={15} />
        </button>
      )}
    </div>
  );
  const heading = {
    today: "我的一天",
    tasks: "所有任务",
    plan: "计划日历",
    goals: "我的目标",
    review: "每日复盘",
    insights: "数据洞察",
    settings: "个人设置",
  }[view];
  return (
    <>
      {saving && (
        <div className="cloud-saving" role="status">
          正在保存，请稍候…
        </div>
      )}
      <div className="app-shell" inert={saving} aria-busy={saving}>
        <aside className="sidebar">
          <a
            className="brand"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              navigate("today");
            }}
          >
            <span className="brand-mark">
              <Leaf size={22} />
            </span>
            FlowDay<span className="brand-period">.</span>
          </a>
          <button className="quick-add" onClick={() => openNewTask()}>
            <Plus size={18} />
            新建任务<span>N</span>
          </button>
          <div className="nav-caption">工作空间</div>
          <nav aria-label="主导航">
            {navItems.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? "active" : ""}`}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={19} />
                {item.label}
                {item.id === "today" && (
                  <span className="nav-count">{pendingToday.length}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="quiet-card">
              <span className="quiet-art">✳</span>
              <strong>进步，不必匆忙。</strong>
              <p>每天一小步，也能走很远。</p>
            </div>
            <button
              className={`nav-item ${view === "settings" ? "active" : ""}`}
              onClick={() => navigate("settings")}
            >
              <Settings2 size={18} />
              个人设置
            </button>
            <button className="profile" onClick={() => navigate("settings")}>
              <span className="avatar">{state.settings.name.slice(0, 1)}</span>
              <span>
                <strong>{state.settings.name}</strong>
                <small>{account ? "云端账户" : "本地体验版"}</small>
              </span>
              <ChevronDown size={15} />
            </button>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb">
              工作空间 <ChevronRight size={13} />
              <span>{heading}</span>
            </div>
            <div className="topbar-actions">
              <span className="local-badge">
                <span />
                {saving
                  ? "正在保存…"
                  : error
                    ? "请检查保存状态"
                    : account
                      ? "云端已同步"
                      : "本地已保存"}
              </span>
              <button
                className="icon-btn notification-button"
                aria-label="查看通知"
                onClick={() => setNotifications(!notifications)}
              >
                <Bell size={19} />
                <i />
              </button>
              <div className="avatar small">
                {state.settings.name.slice(0, 1)}
              </div>
            </div>
            {notifications && (
              <div className="notification-popover">
                <h3>通知中心</h3>
                <p>
                  <CloudOff size={16} />
                  {account
                    ? "当前使用云端账户，数据按账户隔离保存。"
                    : "当前为本地版本，数据保存在此浏览器。"}
                </p>
                <p>
                  AI
                  教练提供预览后确认的建议，真实模型连接状态见教练面板；规则教练仍可直接使用。
                </p>
                <button
                  className="text-button"
                  onClick={() => {
                    navigate("settings");
                    setNotifications(false);
                  }}
                >
                  查看数据与设置 <ArrowRight size={14} />
                </button>
              </div>
            )}
          </header>
          <main className="workspace-content" id="main">
            {account && (!online || pending || syncIssue) && (
              <section
                className="soft-note execution-load"
                aria-label="云端保存状态"
              >
                <span role="status">
                  {conflict
                    ? "检测到云端版本冲突。可以导出未保存变更，再同步云端。"
                    : !online
                      ? "当前离线。云端原有数据仍保留。"
                      : pending
                        ? "有一笔保存尚待确认。"
                        : "自动同步暂未连接，当前保留最近一次读取的数据。"}
                </span>
                {!pending && online && syncIssue && (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void refresh()}
                  >
                    重试同步
                  </button>
                )}
                {pending && (
                  <>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={!online || conflict}
                      onClick={() => void retry()}
                    >
                      重试这笔保存
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        downloadBackup(
                          JSON.stringify(pending, null, 2),
                          "flowday-pending-change.json",
                        )
                      }
                    >
                      导出待保存变更
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        if (
                          window.confirm(
                            "放弃本标签待保存的变更并读取最新数据？建议先导出。",
                          )
                        ) {
                          discardPending();
                          void refresh();
                        }
                      }}
                    >
                      放弃并同步
                    </button>
                  </>
                )}
              </section>
            )}
            {account &&
              view === "today" &&
              !state.settings.onboardingComplete &&
              !state.tasks.length &&
              !state.goals.length && (
                <section className="panel cloud-panel">
                  <h2>开始你的第一个计划</h2>
                  <p>
                    {localSource
                      ? "发现此浏览器已有 FlowDay 本地数据。建议先迁移，再建立新的计划。"
                      : "设置可用时间，再试着安排今天第一件要做的事。"}
                  </p>
                  <div className="execution-actions">
                    {localSource && (
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => navigate("settings")}
                      >
                        查看本地数据迁移
                      </button>
                    )}
                    <button
                      type="button"
                      className={
                        localSource ? "button secondary" : "button primary"
                      }
                      onClick={() => setOnboardingOpen(true)}
                    >
                      开始设置
                    </button>
                    {!localSource && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          void commit((s) => ({
                            ...s,
                            settings: {
                              ...s.settings,
                              onboardingComplete: true,
                            },
                          }))
                        }
                      >
                        跳过引导
                      </button>
                    )}
                  </div>
                </section>
              )}
            {error && (
              <div className="error-banner" role="alert">
                {error}
                <button onClick={() => setError("")} aria-label="关闭提示">
                  <X size={16} />
                </button>
              </div>
            )}
            {state.tasks.some((t) =>
              ["t1", "t2", "t3", "t4"].includes(t.id),
            ) && (
              <div className="sample-banner">
                <Leaf size={13} />
                <span>
                  这里有几件示例任务，帮你感受
                  FlowDay。你可以编辑它们，或添加自己的第一件事。
                </span>
                <button onClick={() => openNewTask()}>
                  添加我的任务 <ArrowRight size={13} />
                </button>
              </div>
            )}
            {view === "today" && (
              <>
                <section className="page-heading">
                  <div>
                    <div className="eyebrow">
                      <Sun size={15} />
                      {new Date(now).toLocaleDateString("zh-CN", {
                        month: "long",
                        day: "numeric",
                        weekday: "long",
                      })}
                    </div>
                    <h1>
                      我的一天<span className="sun-doodle">☀</span>
                    </h1>
                  </div>
                  <button
                    className="button secondary"
                    onClick={() => {
                      setView("plan");
                    }}
                  >
                    <CalendarDays size={16} />
                    规划今天
                  </button>
                </section>
                <div className="dashboard-grid">
                  <div className="main-column">
                    <section className="focus-hero">
                      <div className="hero-top">
                        <span>
                          <span className="pulse-dot" />
                          当前任务
                        </span>
                      </div>
                      <div className="hero-content">
                        <div className="hero-copy">
                          <h2>
                            {topTask?.title ??
                              (doneToday.length
                                ? "今日任务已完成"
                                : "今天还没有任务")}
                          </h2>
                          {topTask?.notes && <p>{topTask.notes}</p>}
                          <div className="hero-meta">
                            {topTask && (
                              <span>
                                <Clock3 size={14} />
                                预计 {topTask.minutes} 分钟
                              </span>
                            )}
                            {topTask && goalOf(topTask) && (
                              <span>
                                <Target size={14} />
                                {goalOf(topTask)?.title}
                              </span>
                            )}
                          </div>
                          <div className="hero-buttons">
                            <button
                              className="button light"
                              onClick={() =>
                                topTask ? startTask(topTask) : openNewTask()
                              }
                            >
                              <Play size={15} fill="currentColor" />
                              {topTask ? "开始专注" : "添加新的任务"}
                            </button>
                            {topTask && (
                              <button
                                className="hero-link"
                                onClick={() => {
                                  setCoachTask(topTask);
                                  setObstacle("large");
                                }}
                              >
                                有点难开始？
                                <ArrowUpRight size={14} />
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="hero-visual" aria-hidden="true">
                          <div className="orbit one" />
                          <div className="orbit two" />
                          <div className="plant-stem" />
                          <div className="plant-leaf leaf-one" />
                          <div className="plant-leaf leaf-two" />
                          <div className="plant-leaf leaf-three" />
                          <div className="plant-pot" />
                          <span className="star s1">✧</span>
                          <span className="star s2">✦</span>
                        </div>
                      </div>
                    </section>
                    <section className="panel task-panel">
                      <div className="section-heading">
                        <h2>
                          今日任务{" "}
                          <span className="count-badge">
                            {todayTasks.length}
                          </span>
                        </h2>
                        <button
                          className="text-button"
                          onClick={() => openNewTask()}
                        >
                          <Plus size={15} />
                          添加任务
                        </button>
                      </div>
                      <div className="tabs">
                        <button
                          className={filter === "all" ? "selected" : ""}
                          onClick={() => setFilter("all")}
                        >
                          全部 <span>{todayTasks.length}</span>
                        </button>
                        <button
                          className={filter === "todo" ? "selected" : ""}
                          onClick={() => setFilter("todo")}
                        >
                          待完成 <span>{pendingToday.length}</span>
                        </button>
                        <button
                          className={filter === "done" ? "selected" : ""}
                          onClick={() => setFilter("done")}
                        >
                          已完成 <span>{doneToday.length}</span>
                        </button>
                      </div>
                      <div>
                        {todayTasks
                          .filter(
                            (t) => filter === "all" || t.status === filter,
                          )
                          .map((task) => renderTaskRow(task, true))}
                      </div>
                      {todayTasks.filter(
                        (t) => filter === "all" || t.status === filter,
                      ).length === 0 && (
                        <Empty
                          title={
                            filter === "done"
                              ? "每一步，都值得记录"
                              : "这里留着一点空白"
                          }
                          detail={
                            filter === "done"
                              ? "完成一项任务后，它会出现在这里。"
                              : "添加一件今天想推进的小事吧。"
                          }
                        />
                      )}
                      <button
                        className="inline-add"
                        onClick={() => openNewTask()}
                      >
                        <Plus size={16} />
                        添加一个小小的行动…
                      </button>
                    </section>
                    <section className="review-nudge">
                      <span className="review-icon">
                        <BookOpen size={21} />
                      </span>
                      <div>
                        <h3>给今天留一个小结</h3>
                        <p>看见自己的进步，比追赶待办更重要。</p>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => setView("review")}
                      >
                        去复盘 <ArrowRight size={16} />
                      </button>
                    </section>
                  </div>
                  <aside className="right-column">
                    <section className="panel rhythm-panel">
                      <div className="section-heading">
                        <h2>今天的节奏</h2>
                        <span className="muted-label">一步一步来</span>
                      </div>
                      <div className="progress-area">
                        <div
                          className="progress-ring"
                          style={{
                            background: `conic-gradient(var(--green) ${progress}%, #edf0e9 0)`,
                          }}
                        >
                          <div>
                            <strong>
                              {doneToday.length}
                              <span> / {todayTasks.length}</span>
                            </strong>
                            <small>任务已完成</small>
                          </div>
                        </div>
                        <div className="progress-caption">
                          {progress === 100 && todayTasks.length
                            ? "今天也很棒！"
                            : "每一个开始，都算数。"}
                        </div>
                      </div>
                      <div className="rhythm-stats">
                        <div>
                          <span>
                            <Clock3 size={14} />
                            预计投入
                          </span>
                          <strong>{minutesLabel(plannedMinutes)}</strong>
                        </div>
                        <div>
                          <span>
                            <Focus size={14} />
                            已专注
                          </span>
                          <strong>
                            {Math.floor(focusSeconds / 60)} <small>分钟</small>
                          </strong>
                        </div>
                      </div>
                      <div className="capacity-line">
                        <span>今天的可用时间</span>
                        <strong>{minutesLabel(state.settings.capacity)}</strong>
                      </div>
                      <div className="capacity-track">
                        <span
                          style={{
                            width: `${Math.min(100, (plannedMinutes / state.settings.capacity) * 100)}%`,
                            background:
                              plannedMinutes > state.settings.capacity
                                ? "#c1814c"
                                : undefined,
                          }}
                        />
                      </div>
                      <p className="capacity-note">
                        {plannedMinutes > state.settings.capacity
                          ? "任务有些多，试着把一件事留给明天。"
                          : "留一点缓冲，让计划更从容。"}
                      </p>
                    </section>
                    <section className="coach-card">
                      <div className="coach-title">
                        <span className="coach-icon">
                          <Sparkles size={18} />
                        </span>
                        <h2>Flow 教练</h2>
                        <span className="tiny-tag">规则版</span>
                      </div>
                      <h3>
                        {plannedMinutes > state.settings.capacity
                          ? "今天，试着做少一点。"
                          : "先开始，再慢慢进入状态。"}
                      </h3>
                      <p>
                        {plannedMinutes > state.settings.capacity
                          ? "你的待办超过了可用时间。挑出真正重要的事，其他的可以晚一点。"
                          : "如果一项任务让你迟迟无法开始，不妨把它变成一个 10 分钟就能做的小行动。"}
                      </p>
                      <button
                        className="coach-action"
                        onClick={() => {
                          if (topTask) {
                            setCoachTask(topTask);
                            setObstacle("large");
                          } else openNewTask();
                        }}
                      >
                        帮我迈出第一步 <ArrowRight size={16} />
                      </button>
                      <div className="coach-footnote">
                        <span />
                        你决定节奏，我帮你找到下一步。
                      </div>
                    </section>
                    <section className="goal-peek">
                      <div className="section-heading">
                        <h2>持续向前</h2>
                        <button
                          className="icon-btn"
                          aria-label="查看目标"
                          onClick={() => setView("goals")}
                        >
                          <ArrowUpRight size={16} />
                        </button>
                      </div>
                      {state.goals.slice(0, 2).map((goal) => {
                        const tasks = state.tasks.filter(
                          (t) => t.goalId === goal.id,
                        );
                        const done = tasks.filter(
                          (t) => t.status === "done",
                        ).length;
                        return (
                          <button
                            className="mini-goal"
                            key={goal.id}
                            onClick={() => {
                              setView("tasks");
                              setGoalFilter(goal.id);
                            }}
                          >
                            <span className={`goal-icon ${goal.color}`}>
                              <Target size={17} />
                            </span>
                            <div>
                              <strong>{goal.title}</strong>
                              <span>
                                {done} / {tasks.length} 个行动已完成
                              </span>
                            </div>
                            <ChevronRight size={14} />
                          </button>
                        );
                      })}
                    </section>
                  </aside>
                </div>
                <footer className="page-footer">
                  <Leaf size={12} />
                  用自己的节奏，做重要的事。
                  <span>FLOWDAY · YOUR DAY, YOUR PACE</span>
                </footer>
              </>
            )}
            {view === "tasks" && (
              <>
                <PageHeading
                  title={
                    goalFilter
                      ? (state.goals.find((g) => g.id === goalFilter)?.title ??
                        "目标任务")
                      : "所有任务"
                  }
                  action={
                    <button
                      className="button primary"
                      onClick={() => openNewTask()}
                    >
                      <Plus size={16} />
                      新建任务
                    </button>
                  }
                />
                <section className="panel">
                  <div className="list-toolbar">
                    <div className="tabs">
                      <button
                        className={filter === "all" ? "selected" : ""}
                        onClick={() => setFilter("all")}
                      >
                        全部
                      </button>
                      <button
                        className={filter === "todo" ? "selected" : ""}
                        onClick={() => setFilter("todo")}
                      >
                        待完成
                      </button>
                      <button
                        className={filter === "done" ? "selected" : ""}
                        onClick={() => setFilter("done")}
                      >
                        已完成
                      </button>
                    </div>
                    <label className="search-input">
                      <Search size={16} />
                      <input
                        aria-label="搜索任务"
                        placeholder="搜索任务…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                  </div>
                  <p className="task-order-hint">
                    未完成按高 → 中 → 低优先级排列 · 已完成置底
                  </p>
                  {orderedTasks
                    .filter(
                      (t) =>
                        (filter === "all" ||
                          (filter === "todo"
                            ? isPending(t)
                            : t.status === filter)) &&
                        (!goalFilter || t.goalId === goalFilter) &&
                        t.title.toLowerCase().includes(query.toLowerCase()),
                    )
                    .map((task) => renderTaskRow(task))}
                  {!state.tasks.some(
                    (t) =>
                      (filter === "all" ||
                        (filter === "todo"
                          ? isPending(t)
                          : t.status === filter)) &&
                      (!goalFilter || t.goalId === goalFilter) &&
                      t.title.toLowerCase().includes(query.toLowerCase()),
                  ) && (
                    <Empty
                      title="没有找到任务"
                      detail="试试其他关键词，或者添加一件新的小事。"
                    />
                  )}
                </section>
              </>
            )}
            {account && view === "tasks" && !goalFilter && (
              <section className="panel cloud-panel">
                <h2>已完成任务历史</h2>
                <HistoryList<Task>
                  account={account}
                  kind="tasks"
                  revision={state.revision}
                  render={(task, loadedRevision) => (
                    <>
                      <span>
                        {task.title} · {task.completedAt?.slice(0, 10)}
                      </span>{" "}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          if (hydrate({ tasks: [task] }, loadedRevision))
                            setEditor(task);
                          else
                            setError(
                              "历史结果已过期，请刷新历史记录后再打开。",
                            );
                        }}
                      >
                        查看详情
                      </button>
                    </>
                  )}
                />
              </section>
            )}
            {view === "plan" && (
              <PlanningCalendar
                state={state}
                update={update}
                onAdd={(date) => openNewTask(date)}
                onEditTask={setEditor}
                onDeleteTask={setDeleteTask}
                onSettings={() => navigate("settings")}
                notify={notify}
              />
            )}
            {view === "goals" && (
              <>
                <PageHeading
                  title="我的目标"
                  action={
                    <button
                      className="button primary"
                      onClick={() => setGoalOpen(true)}
                    >
                      <Plus size={16} />
                      新建目标
                    </button>
                  }
                />
                <div className="goals-grid">
                  {state.goals.map((goal) => {
                    const tasks = state.tasks.filter(
                      (t) => t.goalId === goal.id,
                    );
                    const done = tasks.filter(
                      (t) => t.status === "done",
                    ).length;
                    return (
                      <article className="panel goal-card" key={goal.id}>
                        <button
                          className="goal-card-main"
                          aria-label={`查看目标 ${goal.title}`}
                          onClick={() => {
                            setView("tasks");
                            setGoalFilter(goal.id);
                            setFilter("all");
                          }}
                        >
                          <span className={`goal-icon ${goal.color}`}>
                            <Target size={23} />
                          </span>
                          <ArrowUpRight className="goal-arrow" size={19} />
                          <h2>{goal.title}</h2>
                          <p>{goal.description}</p>
                          <div className="goal-meta">
                            <span>行动进度</span>
                            <strong>
                              {done} / {tasks.length}
                            </strong>
                          </div>
                          <div className="capacity-track">
                            <span
                              style={{
                                width: `${tasks.length ? (done / tasks.length) * 100 : 0}%`,
                              }}
                            />
                          </div>
                          <small>
                            {goal.targetDate
                              ? `目标日期 ${goal.targetDate}`
                              : "按照自己的节奏，持续前进"}
                          </small>
                        </button>
                        <div className="goal-card-actions">
                          <button
                            className="text-button"
                            aria-label={`编辑目标 ${goal.title}`}
                            onClick={() => setEditingGoal(goal)}
                          >
                            编辑目标
                          </button>
                          <button
                            className="text-button"
                            aria-label={`AI 拆解目标 ${goal.title}`}
                            onClick={() =>
                              setAiRequest({ mode: "goal", goalId: goal.id })
                            }
                          >
                            <Sparkles size={14} /> AI 拆解
                          </button>
                        </div>
                      </article>
                    );
                  })}
                  <button
                    className="new-goal"
                    onClick={() => setGoalOpen(true)}
                  >
                    <Plus size={26} />
                    <strong>种下一个新目标</strong>
                    <span>你想让什么慢慢发生？</span>
                  </button>
                </div>
              </>
            )}
            <div hidden={view !== "review"}>
              <ReviewJournal
                cloud={!!account}
                account={account}
                historyVisible={view === "review"}
                hydrate={hydrate}
                state={state}
                update={update}
                notify={notify}
              />
            </div>
            {view === "insights" && (
              <>
                <PageHeading title="数据洞察" />
                <div className="metric-grid">
                  <Metric
                    title="累计已完成"
                    value={
                      account
                        ? (totals?.completed ?? "—")
                        : state.tasks.filter((t) => t.status === "done").length
                    }
                    unit="个任务"
                    icon={<CheckCheck />}
                  />
                  <Metric
                    title="累计专注"
                    value={
                      account
                        ? (totals?.focusMinutes ?? "—")
                        : Math.floor(
                            state.events
                              .filter((e) => e.type === "focus")
                              .reduce((n, e) => n + (e.seconds ?? 0), 0) / 60,
                          )
                    }
                    unit="分钟"
                    icon={<Focus />}
                  />
                  <Metric
                    title="留下的回顾"
                    value={
                      account ? (totals?.reviews ?? "—") : state.reviews.length
                    }
                    unit="天"
                    icon={<BookOpen />}
                  />
                </div>
                <CompletionChart tasks={state.tasks} />
                <GrowthPanel
                  account={account}
                  advanced={access?.advancedGrowth}
                  state={state}
                  onCoach={() => setAiRequest({ mode: "profile" })}
                />
                <div className="soft-note">
                  <Leaf size={18} />
                  <p>
                    数据还在慢慢积累。完成次数不等于个人价值；计时也不等于全部的有效工作。
                  </p>
                </div>
              </>
            )}
            {view === "settings" && (
              <>
                <PageHeading
                  title="个人设置"
                  description={
                    account
                      ? "偏好与业务数据保存在当前云端账户。"
                      : "当前为本地体验。你的数据仅保存在这个浏览器中。"
                  }
                />
                {account && (
                  <CloudAccount
                    account={account}
                    revision={state.revision}
                    saving={saving}
                    refresh={refresh}
                    importLocal={importLocal}
                  />
                )}
                <DataControls
                  account={account}
                  state={state}
                  access={access}
                  update={update}
                  hasPending={!!pending}
                  onClear={refresh}
                />
                <GrowthPreferences
                  state={state}
                  update={update}
                  personalization={access?.personalization}
                />
                <SettingsForm
                  state={state}
                  onSave={(settings) =>
                    commit((s) => ({ ...s, settings }), "偏好已保存")
                  }
                />
                <section className="panel integration-panel">
                  <h2>回顾与进步</h2>
                  <div>
                    <button
                      className="text-button"
                      onClick={() => navigate("review")}
                    >
                      <BookOpen size={17} />
                      每日复盘 <ArrowRight size={14} />
                    </button>
                  </div>
                  <div>
                    <button
                      className="text-button"
                      onClick={() => navigate("insights")}
                    >
                      <BarChart3 size={17} />
                      数据洞察 <ArrowRight size={14} />
                    </button>
                  </div>
                </section>
              </>
            )}
            {(view === "plan" ||
              (view === "today" && pendingToday.length > 0)) && (
              <div className="soft-note execution-load">
                <Clock3 size={17} />
                <span>
                  {(() => {
                    const load = loadForDay(state, today, new Date(now));
                    return `今日剩余 ${load.available} 分钟 · 待执行 ${Math.round(load.requested)} 分钟 · 高优先级 ${load.high} 项${load.over > 0 ? " · 建议留出缓冲" : ""}`;
                  })()}
                </span>
                <button
                  className="button secondary"
                  onClick={() => openAdaptive()}
                >
                  自适应排程
                </button>
              </div>
            )}
            {(view === "today" || view === "goals") && (
              <div className="ai-entry" aria-label="AI 教练入口">
                <span className="muted">
                  <Sparkles size={14} /> AI 执行教练
                </span>
                <button
                  className="button secondary"
                  onClick={() =>
                    setAiRequest({
                      mode: "goal",
                      ...(goalFilter ? { goalId: goalFilter } : {}),
                    })
                  }
                >
                  AI 拆解新目标
                </button>
                {view === "today" && (
                  <>
                    <button
                      className="button secondary"
                      onClick={() => setAiRequest({ mode: "plan" })}
                    >
                      AI 调整今日计划
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setAiRequest({ mode: "profile" })}
                    >
                      查看执行画像
                    </button>
                  </>
                )}
              </div>
            )}
          </main>
        </div>
        <nav className="mobile-nav" aria-label="移动导航">
          {navItems.slice(0, 4).map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={20} />
              <span>{item.label}</span>
            </button>
          ))}
          <button
            onClick={() => navigate("settings")}
            className={view === "settings" ? "active" : ""}
          >
            <Settings2 size={20} />
            <span>设置</span>
          </button>
        </nav>
        {session && sessionTask && !focusOpen && (
          <button
            className="floating-session"
            onClick={() => setFocusOpen(true)}
          >
            <span className="pulse-dot" />
            <span>{sessionTask.title}</span>
            <strong>{formatSeconds(elapsed)}</strong>
            <Focus size={18} />
          </button>
        )}
        {toast && (
          <div className="toast" role="status">
            <Check size={17} />
            {toast}
          </div>
        )}
        {editor && (
          <Modal
            title={editor === "new" ? "添加一件想做的事" : "任务详情"}
            onClose={() => {
              if (!saving) setEditor(null);
            }}
          >
            <TaskForm
              workspace={state}
              task={editor === "new" ? null : editor}
              goals={state.goals}
              date={newTaskDate}
              onSave={async (task) => {
                if (
                  await commit(
                    (s) => {
                      const existing = s.tasks.find((t) => t.id === task.id);
                      if (
                        editor !== "new" &&
                        JSON.stringify(existing) !== JSON.stringify(editor)
                      )
                        throw new Error(
                          "这项任务已在其他地方修改，请复制草稿后重新打开任务。",
                        );
                      if (existing && existing.date !== task.date) {
                        if (s.session?.taskId === task.id)
                          throw new Error("请先结束专注再修改日期");
                        if (s.blocks.some((b) => b.taskId === task.id))
                          s = applyCalendarChange(
                            s,
                            task.date
                              ? {
                                  type: "date",
                                  taskId: task.id,
                                  date: task.date,
                                }
                              : { type: "unschedule", taskId: task.id },
                          );
                      }
                      return {
                        ...s,
                        tasks:
                          editor === "new"
                            ? [...s.tasks, task]
                            : s.tasks.map((t) => (t.id === task.id ? task : t)),
                      };
                    },
                    editor === "new"
                      ? "新任务已添加"
                      : "任务已保存，时间安排已保留",
                  )
                )
                  setEditor(null);
              }}
              onDelete={
                editor !== "new"
                  ? () => {
                      setDeleteTask(editor);
                      setEditor(null);
                    }
                  : undefined
              }
            />
            {editor !== "new" && (
              <TaskExecutionDetails
                account={account}
                state={state}
                task={state.tasks.find((t) => t.id === editor.id) ?? editor}
                update={update}
                onPlan={() => {
                  setEditor(null);
                  openAdaptive(editor.id);
                }}
              />
            )}
            {editor !== "new" && (
              <details className="ai-rule-fallback">
                <summary>AI 帮我推进这项任务（基于已保存的内容）</summary>
                <AiCoachPanel
                  key={editor.id}
                  state={state}
                  update={update}
                  account={account}
                  initialMode="help"
                  taskId={editor.id}
                />
              </details>
            )}
          </Modal>
        )}
        {editingGoal && (
          <Modal
            title={deletingGoal ? "删除这个目标？" : "编辑目标"}
            onClose={() => {
              if (saving) return;
              if (deletingGoal) setDeletingGoal(null);
              else setEditingGoal(null);
            }}
          >
            <div hidden={!!deletingGoal}>
              <GoalForm
                goal={editingGoal}
                onDelete={() => {
                  setDeleteGoalTasks(false);
                  setDeletingGoal(editingGoal);
                }}
                onSave={async (title, description, targetDate) => {
                  if (
                    await commit((s) => {
                      const current = s.goals.find(
                        (g) => g.id === editingGoal.id,
                      );
                      if (
                        JSON.stringify(current) !== JSON.stringify(editingGoal)
                      )
                        throw new Error(
                          "这个目标已在其他地方修改，请保留草稿并重新打开。",
                        );
                      return {
                        ...s,
                        goals: s.goals.map((g) =>
                          g.id === editingGoal.id
                            ? { ...g, title, description, targetDate }
                            : g,
                        ),
                      };
                    }, "目标已保存")
                  )
                    setEditingGoal(null);
                }}
              />
            </div>
            {deletingGoal && (
              <>
                <p className="dialog-description">
                  确认删除「{deletingGoal.title}
                  」？此操作无法撤销。请选择如何处理关联的{" "}
                  {
                    state.tasks.filter((t) => t.goalId === deletingGoal.id)
                      .length
                  }{" "}
                  项任务（含已完成任务）。
                </p>
                <fieldset className="goal-delete-options">
                  <legend>关联任务如何处理？</legend>
                  <label>
                    <input
                      type="radio"
                      name="goal-delete-mode"
                      checked={!deleteGoalTasks}
                      onChange={() => setDeleteGoalTasks(false)}
                    />
                    保留关联任务，改为独立任务
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="goal-delete-mode"
                      checked={deleteGoalTasks}
                      onChange={() => setDeleteGoalTasks(true)}
                    />
                    同时删除关联任务和它们的时间安排
                  </label>
                </fieldset>
                <p className="dialog-description">
                  {deleteGoalTasks
                    ? "关联任务和时间块将一并删除，历史执行记录仍保留。"
                    : "只删除目标，任务、日期、时间安排和执行记录都会保留。"}
                </p>
                <div className="form-footer">
                  <button
                    autoFocus
                    className="button secondary"
                    onClick={() => setDeletingGoal(null)}
                  >
                    返回编辑
                  </button>
                  <button
                    className="button danger"
                    onClick={async () => {
                      if (
                        await commit(
                          (s) => removeGoal(s, deletingGoal, deleteGoalTasks),
                          deleteGoalTasks
                            ? "目标及关联任务已删除，历史执行记录已保留"
                            : "目标已删除，关联任务已保留",
                          deleteGoalTasks
                            ? { removeGoalsWithTasks: [deletingGoal.id] }
                            : undefined,
                        )
                      ) {
                        if (goalFilter === deletingGoal.id) setGoalFilter(null);
                        setDeletingGoal(null);
                        setEditingGoal(null);
                      }
                    }}
                  >
                    {deleteGoalTasks
                      ? "确认删除目标及关联任务"
                      : "确认删除目标"}
                  </button>
                </div>
              </>
            )}
          </Modal>
        )}
        {goalOpen && (
          <Modal
            title="种下一个新目标"
            onClose={() => {
              if (!saving) setGoalOpen(false);
            }}
          >
            <GoalForm
              onSave={async (title, description, targetDate) => {
                if (
                  await commit(
                    (s) => ({
                      ...s,
                      goals: [
                        ...s.goals,
                        {
                          id: uid(),
                          title,
                          description,
                          targetDate,
                          color: "green",
                        },
                      ],
                    }),
                    "目标已创建",
                  )
                )
                  setGoalOpen(false);
              }}
            />
          </Modal>
        )}
        {deleteTask && (
          <Modal
            title="删除这项任务？"
            onClose={() => {
              if (!saving) setDeleteTask(null);
            }}
          >
            <p className="dialog-description">
              「{deleteTask.title}
              」将从任务列表和计划中移除。历史执行事件会保留，其他任务和拆分步骤不会随之删除。
            </p>
            <div className="form-footer">
              <button
                className="button secondary"
                onClick={() => setDeleteTask(null)}
              >
                保留任务
              </button>
              <button
                className="button danger"
                onClick={async () => {
                  if (session?.taskId === deleteTask.id) {
                    notify("请先结束这项任务的专注");
                    return;
                  }
                  if (
                    await commit(
                      (s) => ({
                        ...s,
                        tasks: removeTaskLinks(
                          s.tasks,
                          new Set([deleteTask.id]),
                        ),
                        blocks: s.blocks.filter(
                          (b) => b.taskId !== deleteTask.id,
                        ),
                      }),
                      "任务已删除",
                    )
                  )
                    setDeleteTask(null);
                }}
              >
                确认删除
              </button>
            </div>
          </Modal>
        )}
        {aiRequest && (
          <Modal
            title="AI 执行教练"
            onClose={() => {
              if (!saving) setAiRequest(null);
            }}
          >
            <AiCoachPanel
              state={state}
              update={update}
              account={account}
              initialMode={aiRequest.mode}
              goalId={aiRequest.goalId ?? null}
            />
          </Modal>
        )}
        {coachTask && (
          <Modal
            title="一起找到更容易的开始"
            onClose={() => {
              if (!saving) setCoachTask(null);
            }}
          >
            <AiCoachPanel
              state={state}
              update={update}
              account={account}
              initialMode="help"
              taskId={coachTask.id}
            />
            <details className="ai-rule-fallback">
              <summary>使用原规则教练（不调用模型）</summary>
              <div className="coach-context">
                <Sparkles size={19} />
                <div>
                  <strong>{coachTask.title}</strong>
                  <span>规则教练 · 选择你此刻的感受</span>
                </div>
              </div>
              <div className="obstacle-options">
                {(
                  [
                    { id: "large", label: "任务太大了" },
                    { id: "unclear", label: "不知道从哪开始" },
                    { id: "tired", label: "有点累了" },
                  ] as const
                ).map((item) => (
                  <button
                    className={obstacle === item.id ? "chosen" : ""}
                    key={item.id}
                    onClick={() => setObstacle(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="suggestion">
                <span className="eyebrow">
                  建议的下一步 ·{" "}
                  {recoverySuggestion(coachTask.title, obstacle).minutes} 分钟
                </span>
                <h3>{recoverySuggestion(coachTask.title, obstacle).step}</h3>
                <p>{recoverySuggestion(coachTask.title, obstacle).detail}</p>
              </div>
              <p className="dialog-description">
                确认后添加一项小任务，原任务会保留，不会自动改期或完成。
              </p>
              <div className="form-footer">
                <button
                  className="button secondary"
                  onClick={() => setCoachTask(null)}
                >
                  先不调整
                </button>
                <button
                  className="button primary"
                  onClick={async () => {
                    const suggestion = recoverySuggestion(
                      coachTask.title,
                      obstacle,
                    );
                    if (
                      await commit(
                        (s) => ({
                          ...s,
                          tasks: [
                            ...s.tasks,
                            {
                              ...coachTask,
                              id: uid(),
                              title: suggestion.step.slice(0, 200),
                              notes: suggestion.detail,
                              minutes: suggestion.minutes,
                              status: "todo",
                              completedAt: null,
                              createdAt: new Date().toISOString(),
                              date: today,
                            },
                          ],
                        }),
                        "小行动已添加，由你决定何时开始",
                      )
                    )
                      setCoachTask(null);
                  }}
                >
                  <Plus size={16} />
                  添加这个小行动
                </button>
              </div>
            </details>
          </Modal>
        )}
        {onboardingOpen && (
          <Modal
            title="初次设置"
            onClose={() => {
              if (!saving) setOnboardingOpen(false);
            }}
          >
            <FirstRun
              state={state}
              update={update}
              onClose={() => setOnboardingOpen(false)}
            />
          </Modal>
        )}
        {adaptiveOpen && (
          <Modal
            title="自适应排程"
            onClose={() => {
              if (!saving) setAdaptiveOpen(false);
            }}
          >
            <AdaptivePanel
              state={state}
              account={account}
              taskId={adaptiveTask}
              update={update}
              onSaved={() => {
                setAdaptiveOpen(false);
                notify("调整后的计划已保存");
              }}
            />
          </Modal>
        )}
        {focusOpen && sessionTask && session && (
          <Modal
            title="此刻，只做这一件事"
            onClose={() => {
              if (!saving) setFocusOpen(false);
            }}
          >
            <div className="focus-dialog">
              <span className="focus-flower">✳</span>
              <h2>{sessionTask.title}</h2>
              <p>{sessionTask.notes || "不用做得完美，只需向前一点。"}</p>
              <div className="timer">{formatSeconds(elapsed)}</div>
              <span className="muted">
                {session.running
                  ? "正在专注 · 切换页面后仍会计时"
                  : "已暂停 · 休息一下也很好"}
              </span>
              <div className="focus-controls">
                <button
                  className="button secondary"
                  onClick={() =>
                    commit((s) =>
                      executionCommand(
                        s,
                        sessionTask.id,
                        session.running ? "pause" : "resume",
                      ),
                    )
                  }
                >
                  {session.running ? <Pause size={17} /> : <Play size={17} />}{" "}
                  {session.running ? "暂停" : "继续"}
                </button>
                <button
                  className="button primary"
                  onClick={async () => {
                    if (await toggleTask(sessionTask)) setFocusOpen(false);
                  }}
                >
                  <Check size={17} />
                  完成任务
                </button>
              </div>
              <button className="text-button" onClick={stopFocus}>
                结束本次专注，保留任务
              </button>
              <small>
                有效专注表只累计运行时间，暂停期间计入经过时间。计时仍依赖手动暂停。
              </small>
              {elapsed > sessionTask.minutes * 60 && (
                <p role="status">
                  这一项已超过估时。结束专注后可在自适应排程里补留时间。
                </p>
              )}
            </div>
          </Modal>
        )}
      </div>
    </>
  );
}
function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <section className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </section>
  );
}
function Metric({
  title,
  value,
  unit,
  icon,
}: {
  title: string;
  value: number | string;
  unit: string;
  icon: ReactNode;
}) {
  return (
    <section className="panel metric">
      <span className="goal-icon green">{icon}</span>
      <p>{title}</p>
      <strong>
        {value}
        <small>{unit}</small>
      </strong>
    </section>
  );
}
function formatSeconds(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
function TaskForm({
  task,
  workspace,
  goals,
  date,
  onSave,
  onDelete,
}: {
  task: Task | null;
  workspace: AppState;
  goals: AppState["goals"];
  date: string;
  onSave: (t: Task) => void;
  onDelete?: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [minutes, setMinutes] = useState(task?.minutes ?? 30);
  const [priority, setPriority] = useState<Task["priority"]>(
    task?.priority ?? "medium",
  );
  const [goalId, setGoalId] = useState(task?.goalId ?? "");
  const [taskDate, setTaskDate] = useState(task?.date ?? date);
  const [kind, setKind] = useState<keyof typeof taskKinds | "">(
    task?.execution?.kind ?? "",
  );
  const [dueDate, setDueDate] = useState(task?.execution?.dueDate ?? "");
  const [dependencies, setDependencies] = useState(
    task?.execution?.dependencies ?? [],
  );
  const estimate = kind
    ? estimateFor(workspace, {
        id: task?.id ?? "",
        minutes,
        execution: { kind },
      })
    : null;
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;
        onSave({
          id: task?.id ?? uid(),
          title: title.trim(),
          notes,
          minutes,
          priority,
          goalId: goalId || null,
          date: taskDate,
          createdAt: task?.createdAt ?? new Date().toISOString(),
          status: task?.status ?? "todo",
          completedAt: task?.completedAt ?? null,
          ...((task?.execution || kind || dueDate || dependencies.length) && {
            execution: {
              ...task?.execution,
              kind: kind || undefined,
              dueDate: dueDate || undefined,
              dependencies,
            },
          }),
        });
      }}
    >
      <label className="field">
        想做什么？
        <input
          required
          maxLength={200}
          placeholder="例如：写下项目的三个核心功能"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="field">
        下一步或补充说明
        <textarea
          rows={3}
          maxLength={2000}
          placeholder="写得具体一点，更容易开始。"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <div className="form-grid">
        <label className="field">
          预计分钟
          <input
            type="number"
            required
            min={5}
            max={480}
            step={5}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
        <label className="field">
          优先级
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Task["priority"])}
          >
            <option value="high">高优先级</option>
            <option value="medium">中优先级</option>
            <option value="low">低优先级</option>
          </select>
        </label>
        <label className="field">
          安排日期
          <input
            type="date"
            value={taskDate}
            onChange={(e) => setTaskDate(e.target.value)}
          />
        </label>
        <label className="field">
          关联目标
          <select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
            <option value="">独立的小事</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details
        className="execution-details"
        open={task?.execution?.dueDate ? true : undefined}
      >
        <summary>任务类型、截止日期与依赖</summary>
        <div className="form-grid">
          <label className="field">
            任务类型
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="">未分类</option>
              {Object.entries(taskKinds).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            截止日期
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </label>
        </div>
        <fieldset className="execution-dependencies">
          <legend>必须先完成</legend>
          {workspace.tasks
            .filter(
              (t) =>
                t.id !== task?.id &&
                (!t.execution?.abandonedAt || dependencies.includes(t.id)),
            )
            .map((t) => (
              <label key={t.id}>
                <input
                  type="checkbox"
                  checked={dependencies.includes(t.id)}
                  onChange={(e) =>
                    setDependencies(
                      e.target.checked
                        ? [...dependencies, t.id]
                        : dependencies.filter((id) => id !== t.id),
                    )
                  }
                />{" "}
                {t.title}
              </label>
            ))}
        </fieldset>
        {estimate ? (
          <div className="soft-note">
            <span>
              参考 {estimate.samples} 项同类完整计时。建议 {estimate.minutes}{" "}
              分钟，同类任务的典型记录为 {estimate.typicalMinutes} 分钟。
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => setMinutes(estimate.minutes)}
            >
              采用建议
            </button>
          </div>
        ) : (
          kind && (
            <p className="muted">
              个人估时需要至少 5 项同类完整计时。可在设置管理个性化。
            </p>
          )
        )}
      </details>
      <div className="form-footer">
        {onDelete ? (
          <button
            type="button"
            className="text-button delete-text"
            onClick={onDelete}
          >
            <Trash2 size={15} />
            删除任务
          </button>
        ) : (
          <span className="muted">先记录下来，不必一次想清楚。</span>
        )}
        <button className="button primary" type="submit">
          <Check size={16} />
          {task ? "保存修改" : "添加任务"}
        </button>
      </div>
    </form>
  );
}
function GoalForm({
  onSave,
  onDelete,
  goal,
}: {
  goal?: Goal;
  onDelete?: () => void;
  onSave: (title: string, description: string, date: string) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const title = String(data.get("title")).trim();
        if (title)
          onSave(
            title,
            String(data.get("description")),
            String(data.get("date")),
          );
      }}
    >
      <label className="field">
        你想实现什么？
        <input
          name="title"
          defaultValue={goal?.title}
          required
          maxLength={200}
          placeholder="例如：完成我的第一个 Web 项目"
        />
      </label>
      <label className="field">
        什么样的结果，算是完成？
        <textarea
          name="description"
          defaultValue={goal?.description}
          maxLength={1000}
          rows={4}
          placeholder="描述一个可以看得见的结果…"
        />
      </label>
      <label className="field">
        目标日期（可选）
        <input type="date" name="date" defaultValue={goal?.targetDate} />
      </label>
      <div className="form-footer">
        {onDelete ? (
          <button
            type="button"
            className="text-button delete-text"
            onClick={onDelete}
          >
            <Trash2 size={15} />
            删除目标
          </button>
        ) : (
          <span className="muted">接下来，为它添加第一个小行动。</span>
        )}
        <button className="button primary" type="submit">
          <Plus size={16} />
          {goal ? "保存目标修改" : "创建目标"}
        </button>
      </div>
    </form>
  );
}
function SettingsForm({
  state,
  onSave,
}: {
  state: AppState;
  onSave: (settings: AppState["settings"]) => void;
}) {
  const [message, setMessage] = useState("");
  return (
    <section className="panel settings-panel">
      <h2>基本偏好</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const dayStart = Number(data.get("dayStart")),
            dayEnd = Number(data.get("dayEnd"));
          const name = String(data.get("name")).trim();
          if (dayEnd <= dayStart) {
            setMessage("结束时间需要晚于开始时间。");
            return;
          }
          if (!name) {
            setMessage("请输入你的称呼。");
            return;
          }
          setMessage("");
          onSave({
            ...state.settings,
            name,
            dayStart,
            dayEnd,
            capacity: Number(data.get("capacity")),
            bufferPercent: Number(data.get("bufferPercent")),
          });
        }}
      >
        <div className="form-grid">
          <label className="field">
            怎么称呼你
            <input
              name="name"
              required
              maxLength={30}
              defaultValue={state.settings.name}
            />
          </label>
          <label className="field">
            每日可用分钟
            <input
              name="capacity"
              type="number"
              required
              min={30}
              max={720}
              step={15}
              defaultValue={state.settings.capacity}
            />
          </label>
          <label className="field">
            默认开始
            <HourSelect
              name="dayStart"
              min={0}
              max={23}
              defaultValue={state.settings.dayStart}
            />
          </label>
          <label className="field">
            默认结束
            <HourSelect
              name="dayEnd"
              min={1}
              max={24}
              defaultValue={state.settings.dayEnd}
            />
          </label>
          <label className="field">
            自动排程缓冲
            <select
              name="bufferPercent"
              defaultValue={state.settings.bufferPercent ?? 20}
            >
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((percent) => (
                <option key={percent} value={percent}>
                  {percent}%
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted">
          当前时区：{Intl.DateTimeFormat().resolvedOptions().timeZone} ·
          日期与日程遵循当前浏览器时区；跨时区旅行时请检查计划时间。
        </p>
        {message && (
          <p role="alert" className="delete-text">
            {message}
          </p>
        )}
        <div className="form-footer">
          <button className="button primary" type="submit">
            保存偏好
          </button>
        </div>
      </form>
    </section>
  );
}
