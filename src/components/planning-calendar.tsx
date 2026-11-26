"use client";
import { TimeInput } from "./time-controls";
import "./calendar.css";
import { isPending } from "@/modules/core/execution";
import {
  dayAvailability,
  planningRatio,
} from "@/modules/planning/availability";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  GripVertical,
  LockKeyhole,
  Plus,
  Search,
  Sparkles,
  Undo2,
  Unlock,
  X,
} from "lucide-react";
import { type AppState, type Task, localDate } from "@/modules/core/model";
import {
  addDays,
  applyCalendarChange,
  dayLoad,
  fillDay,
  monthDays,
  parseDay,
  shiftMonth,
  undoCalendar,
  weekDays,
  type CalendarChange,
} from "@/modules/planning/calendar";
import { clockTime, type ScheduleResult } from "@/modules/planning/scheduler";
type Props = {
  state: AppState;
  update: (fn: (s: AppState) => AppState) => Promise<boolean>;
  onAdd: (date: string) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
  onSettings: () => void;
  notify: (text: string) => void;
};
type Draft = {
  taskId: string;
  date: string;
  start: number;
  duration: number;
  revision: number;
};
type Resize = {
  taskId: string;
  date: string;
  start: number;
  end: number;
  originalEnd: number;
  y: number;
  revision: number;
};
const MIME = "application/x-flowday-task";
const HOUR = 64;
export function PlanningCalendar({
  state,
  update,
  onAdd,
  onEditTask,
  onDeleteTask,
  onSettings,
  notify,
}: Props) {
  const clock = new Date();
  const today = localDate(clock);
  const minuteNow =
    clock.getHours() * 60 + clock.getMinutes() + clock.getSeconds() / 60;
  const nextStart = Math.ceil(minuteNow / 5) * 5;
  function elapsed(date: string, start?: number) {
    return (
      date < today ||
      (date === today && start !== undefined && start < minuteNow)
    );
  }
  const [poolOpen, setPoolOpen] = useState(false);
  const [chosenId, setChosenId] = useState("");
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px), (pointer: coarse)");
    const syncLayout = () => {
      setCompact(media.matches);
      if (!media.matches) setChosenId("");
    };
    syncLayout();
    media.addEventListener("change", syncLayout);
    return () => media.removeEventListener("change", syncLayout);
  }, []);
  const picker = useRef<HTMLDialogElement>(null);
  const [slot, setSlot] = useState<{
    date: string;
    start: number;
    revision: number;
  } | null>(null);
  useEffect(() => {
    if (slot && !picker.current?.open) picker.current?.showModal();
  }, [slot]);
  const [selected, setSelected] = useState(today);
  const [mode, setMode] = useState<"day" | "week" | "month">("week");
  useEffect(() => {
    const saved = localStorage.getItem("flowday.calendar-view");
    if (saved === "day" || saved === "week" || saved === "month")
      setMode(saved);
  }, []);
  function changeMode(next: typeof mode) {
    setMode(next);
    localStorage.setItem("flowday.calendar-view", next);
  }
  const [query, setQuery] = useState("");
  const [queueFilter, setQueueFilter] = useState("all");
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (draft && !state.tasks.some((t) => t.id === draft.taskId)) {
      setDraft(null);
      setUndo(null);
    }
  }, [state.tasks, draft]);
  const [message, setMessage] = useState("");
  const [hover, setHover] = useState<{
    date: string;
    start: number;
    end: number;
  } | null>(null);
  const [resizing, setResizing] = useState<Resize | null>(null);
  const [auto, setAuto] = useState<{
    date: string;
    revision: number;
    result: ScheduleResult;
  } | null>(null);
  const [undo, setUndo] = useState<{
    before: AppState;
    revision: number;
  } | null>(null);
  const resizeRef = useRef<Resize | null>(null);
  const dragRef = useRef<{
    id: string;
    revision: number;
    offset: number;
  } | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const autoRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (auto)
      autoRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [auto]);
  useEffect(() => {
    if (draft)
      editorRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
  }, [draft?.taskId]);
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        resizeRef.current = null;
        setResizing(null);
        setHover(null);
        dragRef.current = null;
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);
  const visibleDays =
    mode === "month"
      ? monthDays(selected)
      : mode === "day"
        ? [selected]
        : weekDays(selected);
  const startHour = Math.min(
    state.settings.dayStart,
    ...visibleDays.map((day) =>
      Math.floor(dayAvailability(state, day).start / 60),
    ),
    ...state.blocks
      .filter((b) => visibleDays.includes(b.date))
      .map((b) => Math.floor(b.start / 60)),
  );
  const endHour = Math.max(
    20,
    state.settings.dayEnd,
    ...visibleDays.map((day) =>
      Math.ceil(dayAvailability(state, day).end / 60),
    ),
    ...state.blocks
      .filter((b) => visibleDays.includes(b.date))
      .map((b) => Math.ceil(b.end / 60)),
  );
  const hours = Array.from(
    { length: endHour - startHour },
    (_, i) => startHour + i,
  );
  const gridHeight = (endHour - startHour) * HOUR;
  const taskById = (id: string) => state.tasks.find((t) => t.id === id);
  const blockById = (id: string) => state.blocks.find((b) => b.taskId === id);
  const chosen = state.tasks.find((t) => t.id === chosenId && isPending(t));
  const chosenBlock = chosen && blockById(chosen.id);
  const duration = chosenBlock
    ? chosenBlock.end - chosenBlock.start
    : (chosen?.minutes ?? 0);
  const queue = state.tasks.filter(
    (t) =>
      isPending(t) &&
      t.title.toLowerCase().includes(query.toLowerCase()) &&
      (queueFilter === "all" ||
        (queueFilter === "selected" && t.date === selected) ||
        (queueFilter === "undated" && !t.date) ||
        (queueFilter === "overdue" && !!t.date && t.date < today)),
  );
  async function perform(change: CalendarChange, revision = state.revision) {
    if (revision !== state.revision) {
      setMessage("数据已变化，请重新选择任务后再调整");
      return false;
    }
    try {
      const next = applyCalendarChange(state, change);
      if (await update(() => next)) {
        setUndo({ before: state, revision: state.revision + 1 });
        setMessage("");
        setDraft(null);
        setAuto(null);
        notify(
          change.type === "lock"
            ? change.locked
              ? "时间块已锁定"
              : "时间块已解锁"
            : change.type === "unschedule"
              ? "已取消时间安排，任务和日期仍保留"
              : "安排已保存，可撤销上一步",
        );
        return true;
      }
    } catch (e) {
      setMessage((e as Error).message);
    }
    return false;
  }
  function selectTask(
    task: Task,
    date = task.date || selected,
    start?: number,
  ) {
    const block = blockById(task.id);
    setDraft({
      taskId: task.id,
      date,
      start: start ?? block?.start ?? state.settings.dayStart * 60,
      duration: block ? block.end - block.start : task.minutes,
      revision: state.revision,
    });
    setMessage("");
  }
  function startDrag(e: DragEvent, id: string, offset = 0) {
    if (blockById(id)?.locked || state.session?.taskId === id) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(MIME, id);
    e.dataTransfer.effectAllowed = "move";
    dragRef.current = { id, revision: state.revision, offset };
    setMessage("");
  }
  function drop(e: DragEvent, date: string, minute?: number) {
    e.preventDefault();
    const id = e.dataTransfer.getData(MIME);
    const drag = dragRef.current;
    setHover(null);
    dragRef.current = null;
    if (!id || !drag || id !== drag.id) {
      setMessage("请从 FlowDay 任务列表或日历拖入任务");
      return;
    }
    const task = taskById(id);
    if (!task) return;
    const block = blockById(id);
    const duration = block ? block.end - block.start : task.minutes;
    if (elapsed(date, minute ?? block?.start)) return;
    perform(
      minute === undefined
        ? { type: "date", taskId: id, date }
        : {
            type: "schedule",
            taskId: id,
            date,
            start: minute,
            end: minute + duration,
          },
      drag.revision,
    );
  }
  function gridMinute(e: DragEvent) {
    return Math.max(
      startHour * 60,
      Math.round(
        (((e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR) *
          60 +
          startHour * 60 -
          (dragRef.current?.offset ?? 0)) /
          15,
      ) * 15,
    );
  }
  function resizeStart(
    e: PointerEvent<HTMLButtonElement>,
    block: AppState["blocks"][number],
  ) {
    e.stopPropagation();
    e.preventDefault();
    if (block.locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const value = {
      ...block,
      originalEnd: block.end,
      y: e.clientY,
      revision: state.revision,
    };
    resizeRef.current = value;
    setResizing(value);
    setMessage("");
  }
  function resizeMove(e: PointerEvent<HTMLButtonElement>) {
    const current = resizeRef.current;
    if (!current) return;
    const end = Math.max(
      current.start + 15,
      Math.min(
        1440,
        current.start + 480,
        current.originalEnd +
          Math.round((((e.clientY - current.y) / HOUR) * 60) / 15) * 15,
      ),
    );
    const value = { ...current, end };
    resizeRef.current = value;
    setResizing(value);
  }
  function resizeEnd(e: PointerEvent<HTMLButtonElement>) {
    const current = resizeRef.current;
    if (!current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    resizeRef.current = null;
    setResizing(null);
    if (current.end !== current.originalEnd)
      perform(
        {
          type: "schedule",
          taskId: current.taskId,
          date: current.date,
          start: current.start,
          end: current.end,
        },
        current.revision,
      );
  }
  async function commitAuto() {
    if (!auto) return;
    if (auto.revision !== state.revision) {
      setMessage("数据已变化，请重新预览自动安排");
      setAuto(null);
      return;
    }
    try {
      let next = state;
      for (const b of auto.result.blocks)
        next = applyCalendarChange(next, {
          type: "schedule",
          ...b,
          date: auto.date,
        });
      if (await update(() => next)) {
        setUndo({ before: state, revision: state.revision + 1 });
        setAuto(null);
        setMessage("");
        notify("已填入空闲时间，原有安排保持不变");
      }
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  const dateLabel =
    mode === "month"
      ? `${parseDay(selected).getFullYear()} 年 ${parseDay(selected).getMonth() + 1} 月`
      : mode === "week"
        ? `${visibleDays[0].slice(5).replace("-", " / ")} — ${visibleDays[6].slice(5).replace("-", " / ")}`
        : selected;
  return (
    <>
      <section className="page-heading">
        <div>
          <h1>计划日历</h1>
        </div>
        <button className="button secondary" onClick={() => onAdd(selected)}>
          <Plus size={16} />
          新建任务
        </button>
      </section>
      <div className="calendar-toolbar">
        <div className="calendar-navigation">
          <button
            className="icon-btn"
            aria-label="上一段日期"
            onClick={() =>
              setSelected(
                mode === "month"
                  ? shiftMonth(selected, -1)
                  : addDays(selected, mode === "week" ? -7 : -1),
              )
            }
          >
            <ChevronLeft size={19} />
          </button>
          <strong>{dateLabel}</strong>
          <button
            className="icon-btn"
            aria-label="下一段日期"
            onClick={() =>
              setSelected(
                mode === "month"
                  ? shiftMonth(selected, 1)
                  : addDays(selected, mode === "week" ? 7 : 1),
              )
            }
          >
            <ChevronRight size={19} />
          </button>
          <button
            className="button secondary"
            onClick={() => setSelected(today)}
          >
            今天
          </button>
          <input
            type="date"
            aria-label="跳转日期"
            value={selected}
            onChange={(e) => {
              if (e.target.value) {
                try {
                  parseDay(e.target.value);
                  setSelected(e.target.value);
                } catch {
                  setMessage("请选择有效日期");
                }
              }
            }}
          />
        </div>
        <div className="calendar-controls">
          <div className="view-switch" aria-label="日历视图">
            {(
              [
                { id: "day", label: "日" },
                { id: "week", label: "周" },
                { id: "month", label: "月" },
              ] as const
            ).map((v) => (
              <button
                key={v.id}
                aria-pressed={mode === v.id}
                className={mode === v.id ? "selected" : ""}
                onClick={() => changeMode(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
          <button
            className="button secondary"
            disabled={!undo}
            onClick={async () => {
              if (!undo) return;
              try {
                const restored = undoCalendar(
                  state,
                  undo.before,
                  undo.revision,
                );
                if (await update(() => restored)) {
                  setUndo(null);
                  setDraft(null);
                  setMessage("");
                  notify("已撤销上一步日历操作");
                }
              } catch (e) {
                setMessage((e as Error).message);
              }
            }}
          >
            <Undo2 size={15} />
            撤销
          </button>
        </div>
      </div>
      <div className="calendar-tip">
        <GripVertical size={14} />
        <span>点空白时段选择任务，点已有安排可调整时间。</span>
      </div>
      {message && (
        <div className="calendar-error" role="alert">
          {message}
          <button
            className="icon-btn"
            onClick={() => setMessage("")}
            aria-label="关闭日历提示"
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className={`calendar-layout ${compact ? "compact-layout" : ""}`}>
        <aside className="calendar-side">
          <section className="panel calendar-queue">
            {compact ? (
              <button
                type="button"
                className="pool-toggle"
                aria-expanded={poolOpen}
                aria-controls="pool-options"
                onClick={() => setPoolOpen(!poolOpen)}
              >
                <strong>{chosen ? chosen.title : "选择要安排的任务"}</strong>
                <span>
                  {poolOpen
                    ? "收起"
                    : chosen
                      ? "更换任务"
                      : `任务池 · ${queue.length}`}
                </span>
              </button>
            ) : (
              <div className="section-heading">
                <h2>
                  任务池 <span className="count-badge">{queue.length}</span>
                </h2>
                <GripVertical size={17} />
              </div>
            )}
            <div id="pool-options" hidden={compact && !poolOpen}>
              <label className="calendar-search">
                <Search size={14} />
                <input
                  placeholder="搜索待办…"
                  aria-label="搜索待办"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <select
                className="queue-select"
                aria-label="任务池筛选"
                value={queueFilter}
                onChange={(e) => setQueueFilter(e.target.value)}
              >
                <option value="all">全部未完成任务</option>
                <option value="selected">选中日期的任务</option>
                <option value="undated">尚未定日期</option>
                <option value="overdue">过去日期未完成</option>
              </select>
              <div className="queue-scroll">
                {queue.map((task) => (
                  <button
                    className="calendar-queue-task"
                    key={task.id}
                    draggable={
                      !blockById(task.id)?.locked &&
                      state.session?.taskId !== task.id
                    }
                    onDragStart={(e) => startDrag(e, task.id)}
                    onDragEnd={() => {
                      dragRef.current = null;
                      setHover(null);
                    }}
                    onClick={() => {
                      if (
                        !compact ||
                        blockById(task.id)?.locked ||
                        task.id === state.session?.taskId ||
                        state.tasks.some(
                          (t) => t.execution?.parentId === task.id,
                        )
                      ) {
                        selectTask(task, selected);
                        return;
                      }
                      setChosenId(task.id);
                      setPoolOpen(false);
                      setDraft(null);
                      setMessage("");
                    }}
                  >
                    <GripVertical size={14} />
                    <div>
                      <strong>{task.title}</strong>
                      <small>
                        {task.minutes} 分钟估时 ·{" "}
                        {blockById(task.id)
                          ? "已安排"
                          : task.date || "未定日期"}
                      </small>
                    </div>
                    {blockById(task.id)?.locked && <LockKeyhole size={12} />}
                  </button>
                ))}
                {!queue.length && (
                  <p className="calendar-muted">
                    这个分类里没有待办。换个筛选或新建任务。
                  </p>
                )}
              </div>
              <button className="inline-add" onClick={() => onAdd(selected)}>
                <Plus size={15} />
                添加任务
              </button>
            </div>
            {compact && chosen && !poolOpen && (
              <div className="pool-next">
                <span>
                  {mode === "month" ? "点日期，再选时段" : "点日历中的空白时段"}
                </span>
                <button className="text-button" onClick={() => setChosenId("")}>
                  取消选择
                </button>
              </div>
            )}
          </section>
          <section className="panel day-budget">
            <h2>{selected.slice(5)} · 已预约 / 可用</h2>
            <strong>
              {dayLoad(state, selected)}
              <small> / {dayAvailability(state, selected).capacity} 分钟</small>
            </strong>
            <div className="capacity-track">
              <span
                style={{
                  width: `${Math.min(100, (dayLoad(state, selected) / Math.max(1, dayAvailability(state, selected).capacity)) * 100)}%`,
                }}
              />
            </div>
            <button
              className="button secondary"
              onClick={() => {
                setAuto({
                  date: selected,
                  revision: state.revision,
                  result: fillDay(state, selected),
                });
                setMessage("");
              }}
            >
              <Sparkles size={15} />
              预览当天自动安排
            </button>
            <button className="text-button" onClick={onSettings}>
              调整可用时段与容量
            </button>
          </section>
        </aside>
        <section className="panel calendar-board">
          {mode === "month" ? (
            <>
              <div className="month-weekdays">
                {["一", "二", "三", "四", "五", "六", "日"].map((d) => (
                  <span key={d}>周{d}</span>
                ))}
              </div>
              <div className="month-grid">
                {visibleDays.map((day) => {
                  const tasks = state.tasks.filter(
                    (t) => t.date === day && !t.execution?.abandonedAt,
                  );
                  const load = dayLoad(state, day);
                  return (
                    <div
                      key={day}
                      className={`month-cell ${day < today ? "past" : ""} ${day.slice(0, 7) !== selected.slice(0, 7) ? "outside" : ""} ${day === selected ? "chosen" : ""}`}
                      onDragOver={(e) => {
                        if (
                          dragRef.current &&
                          !elapsed(day, blockById(dragRef.current.id)?.start)
                        ) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }
                      }}
                      onDrop={(e) => drop(e, day)}
                    >
                      <button
                        className={`month-date ${day === today ? "is-today" : ""}`}
                        aria-label={`选择 ${day}`}
                        onClick={() => {
                          setSelected(day);
                          if (chosen && mode === "month" && day >= today)
                            setMode("day");
                        }}
                      >
                        {Number(day.slice(-2))}
                        <small>{load ? `${load}分` : ""}</small>
                      </button>
                      {tasks.slice(0, 3).map((task) => (
                        <button
                          key={task.id}
                          className={`month-task ${task.status === "done" ? "completed" : ""}`}
                          draggable={
                            isPending(task) && !blockById(task.id)?.locked
                          }
                          onDragStart={(e) => startDrag(e, task.id)}
                          onDragEnd={() => {
                            dragRef.current = null;
                            setHover(null);
                          }}
                          disabled={!isPending(task)}
                          onClick={() => selectTask(task, day)}
                          title={task.title}
                        >
                          <i
                            className={`dot ${task.priority === "high" ? "orange" : "green"}`}
                          />
                          {blockById(task.id)?.locked && (
                            <LockKeyhole size={10} />
                          )}
                          <span>{task.title}</span>
                        </button>
                      ))}
                      {tasks.length > 3 && (
                        <button
                          className="month-more"
                          onClick={() => {
                            setSelected(day);
                            setMode("day");
                          }}
                        >
                          另 {tasks.length - 3} 项
                        </button>
                      )}
                      <div
                        className={`month-load ${load > dayAvailability(state, day).capacity * planningRatio(state) ? "heavy" : ""}`}
                      >
                        <span
                          style={{
                            width: `${Math.min(100, (load / Math.max(1, dayAvailability(state, day).capacity)) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="calendar-bottom-note">
                月视图拖动保留已有时刻；未安排时间的任务只修改日期。已完成记录不可拖动。
              </div>
            </>
          ) : (
            <div className="calendar-scroll">
              <div
                className={`time-calendar ${mode === "day" ? "single-day" : ""}`}
                style={{
                  gridTemplateColumns: `48px repeat(${visibleDays.length},minmax(${mode === "day" ? "180" : "96"}px,1fr))`,
                }}
              >
                <div className="time-corner">时间</div>
                {visibleDays.map((day) => (
                  <button
                    key={`head-${day}`}
                    className={`day-header ${day === selected ? "selected" : ""}`}
                    onClick={() => setSelected(day)}
                  >
                    <span>
                      {parseDay(day).toLocaleDateString("zh-CN", {
                        weekday: "short",
                      })}
                    </span>
                    <strong className={day === today ? "is-today" : ""}>
                      {Number(day.slice(-2))}
                    </strong>
                    <small
                      className={
                        dayLoad(state, day) >
                        dayAvailability(state, day).capacity *
                          planningRatio(state)
                          ? "heavy-text"
                          : ""
                      }
                    >
                      {dayLoad(state, day)} /{" "}
                      {dayAvailability(state, day).capacity} 分
                    </small>
                  </button>
                ))}
                <div className="hour-axis" style={{ height: gridHeight }}>
                  {[...hours, endHour].map((h) => (
                    <span
                      key={h}
                      style={
                        h === endHour
                          ? { bottom: 5 }
                          : { top: (h - startHour) * HOUR }
                      }
                    >
                      {clockTime(h * 60)}
                    </span>
                  ))}
                </div>
                {visibleDays.map((day) => (
                  <div
                    key={day}
                    data-testid={`calendar-day-${day}`}
                    aria-label={`${day} 时间网格`}
                    className={`day-lane ${day < today ? "past" : ""}`}
                    style={{ height: gridHeight }}
                    onDragOver={(e) => {
                      if (!dragRef.current) return;
                      if (elapsed(day, gridMinute(e))) {
                        setHover(null);
                        e.dataTransfer.dropEffect = "none";
                        return;
                      }
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      const task = taskById(dragRef.current.id);
                      if (!task) return;
                      const block = blockById(task.id);
                      const start = gridMinute(e);
                      setHover({
                        date: day,
                        start,
                        end:
                          start +
                          (block ? block.end - block.start : task.minutes),
                      });
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node))
                        setHover(null);
                    }}
                    onDrop={(e) => drop(e, day, gridMinute(e))}
                  >
                    {day <= today && (
                      <div
                        className="elapsed-time"
                        aria-hidden="true"
                        style={{
                          height:
                            day < today
                              ? gridHeight
                              : Math.min(
                                  gridHeight,
                                  Math.max(
                                    0,
                                    ((minuteNow - startHour * 60) / 60) * HOUR,
                                  ),
                                ),
                        }}
                      />
                    )}
                    {day === today &&
                      minuteNow >= startHour * 60 &&
                      minuteNow < endHour * 60 && (
                        <div
                          className="now-line"
                          aria-label={`现在 ${clockTime(Math.floor(minuteNow))}`}
                          style={{
                            top: ((minuteNow - startHour * 60) / 60) * HOUR,
                          }}
                        />
                      )}
                    {hours.map((h) => {
                      const window = dayAvailability(state, day);
                      const start = Math.max(
                        h * 60,
                        window.start,
                        day === today ? nextStart : 0,
                      );
                      const end = Math.min((h + 1) * 60, window.end);
                      if (day < today || start >= end) return null;
                      return (
                        <button
                          key={h}
                          className="hour-slot"
                          style={{
                            top: (start / 60 - startHour) * HOUR,
                            height: ((end - start) / 60) * HOUR,
                          }}
                          aria-label={`${day} ${clockTime(start)} 安排任务`}
                          onClick={() => {
                            setSelected(day);
                            setSlot({
                              date: day,
                              start,
                              revision: state.revision,
                            });
                          }}
                        />
                      );
                    })}
                    {state.fixedTimes
                      ?.filter(
                        (b) =>
                          b.date === day &&
                          b.start < endHour * 60 &&
                          b.end > startHour * 60,
                      )
                      .map((b) => (
                        <div
                          key={b.id}
                          className="calendar-fixed"
                          aria-label={`固定日程 ${b.title}`}
                          style={{
                            top:
                              ((Math.max(b.start, startHour * 60) -
                                startHour * 60) /
                                60) *
                              HOUR,
                            height:
                              ((Math.min(b.end, endHour * 60) -
                                Math.max(b.start, startHour * 60)) /
                                60) *
                              HOUR,
                          }}
                        >
                          {b.title}
                        </div>
                      ))}
                    {state.blocks
                      .filter((b) => b.date === day)
                      .map((block) => {
                        const task = taskById(block.taskId);
                        if (!task) return null;
                        const end =
                          resizing?.taskId === task.id
                            ? resizing.end
                            : block.end;
                        return (
                          <div
                            key={task.id}
                            className={`calendar-event ${task.priority} ${block.locked ? "locked" : ""}`}
                            style={{
                              top: ((block.start - startHour * 60) / 60) * HOUR,
                              height: Math.max(
                                24,
                                ((end - block.start) / 60) * HOUR,
                              ),
                            }}
                            draggable={
                              !block.locked &&
                              !resizing &&
                              state.session?.taskId !== task.id
                            }
                            onDragStart={(e) =>
                              startDrag(
                                e,
                                task.id,
                                Math.floor(
                                  ((e.clientY -
                                    e.currentTarget.getBoundingClientRect()
                                      .top) /
                                    HOUR) *
                                    60,
                                ),
                              )
                            }
                            onDragEnd={() => {
                              dragRef.current = null;
                              setHover(null);
                            }}
                          >
                            <button
                              className="event-content"
                              onClick={() => selectTask(task, day)}
                              title={`${task.title} · ${clockTime(block.start)}–${clockTime(end)}`}
                            >
                              <span>
                                {block.locked && <LockKeyhole size={11} />}
                                <strong>{task.title}</strong>
                              </span>
                              <small>
                                {clockTime(block.start)}–{clockTime(end)}
                              </small>
                            </button>
                            {!block.locked &&
                              state.session?.taskId !== task.id && (
                                <button
                                  className="resize-handle"
                                  draggable={false}
                                  aria-label={`调整「${task.title}」时长`}
                                  onDragStart={(e) => e.preventDefault()}
                                  onPointerDown={(e) => resizeStart(e, block)}
                                  onPointerMove={resizeMove}
                                  onPointerUp={resizeEnd}
                                  onPointerCancel={() => {
                                    resizeRef.current = null;
                                    setResizing(null);
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    // Pointer release synthesizes a click after resizing.
                                    // Only keyboard activation should open the editor here.
                                    if (e.detail === 0) selectTask(task, day);
                                  }}
                                >
                                  <span />
                                </button>
                              )}
                          </div>
                        );
                      })}
                    {hover?.date === day && (
                      <div
                        className="drop-preview"
                        style={{
                          top: ((hover.start - startHour * 60) / 60) * HOUR,
                          height: Math.max(
                            24,
                            ((hover.end - hover.start) / 60) * HOUR,
                          ),
                        }}
                      >
                        {clockTime(hover.start)}–{clockTime(hover.end)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
      <dialog
        className="calendar-picker"
        ref={picker}
        onClose={() => setSlot(null)}
        aria-labelledby="slot-title"
      >
        {slot && (
          <>
            <header>
              <h2 id="slot-title">
                {slot.date} · {clockTime(slot.start)}
              </h2>
              <button
                autoFocus
                className="icon-btn"
                aria-label="关闭任务选择"
                onClick={() => picker.current?.close()}
              >
                <X size={18} />
              </button>
            </header>
            {chosen ? (
              <div className="slot-confirm">
                <strong>{chosen.title}</strong>
                {chosenBlock && (
                  <p>
                    原安排 · {chosenBlock.date} {clockTime(chosenBlock.start)}–
                    {clockTime(chosenBlock.end)}
                  </p>
                )}
                <p>
                  {clockTime(slot.start)}–{clockTime(slot.start + duration)} ·{" "}
                  {duration} 分钟
                </p>
                <button
                  className="button primary"
                  onClick={async () => {
                    picker.current?.close();
                    if (
                      await perform(
                        {
                          type: "schedule",
                          taskId: chosen.id,
                          date: slot.date,
                          start: slot.start,
                          end: slot.start + duration,
                        },
                        slot.revision,
                      )
                    )
                      setChosenId("");
                  }}
                >
                  确认安排
                </button>
                <button
                  className="text-button"
                  onClick={() => {
                    picker.current?.close();
                    selectTask(chosen, slot.date, slot.start);
                  }}
                >
                  调整开始时间或时长
                </button>
              </div>
            ) : (
              <>
                {" "}
                <div className="slot-tasks">
                  {state.tasks
                    .filter(
                      (t) =>
                        isPending(t) &&
                        t.id !== state.session?.taskId &&
                        !blockById(t.id)?.locked &&
                        !state.tasks.some(
                          (c) => c.execution?.parentId === t.id,
                        ),
                    )
                    .map((task) => (
                      <button
                        className="calendar-queue-task"
                        key={task.id}
                        onClick={() => {
                          picker.current?.close();
                          selectTask(task, slot.date, slot.start);
                        }}
                      >
                        <strong>{task.title}</strong>
                        <small>{task.minutes} 分钟</small>
                      </button>
                    ))}
                </div>
                <button
                  className="inline-add"
                  onClick={() => {
                    picker.current?.close();
                    onAdd(slot.date);
                  }}
                >
                  <Plus size={15} />
                  新建当天任务
                </button>
              </>
            )}
          </>
        )}
      </dialog>
      {draft && (
        <section
          className="panel calendar-editor"
          ref={editorRef}
          aria-label="编辑任务安排"
        >
          <header>
            <div>
              <span className="eyebrow">不想拖动？在这里精确设置</span>
              <h2>{taskById(draft.taskId)?.title}</h2>
            </div>
            <button
              className="icon-btn"
              aria-label="关闭安排编辑"
              onClick={() => setDraft(null)}
            >
              <X size={18} />
            </button>
          </header>
          <p>
            预约时长与任务估时分开：拉伸时间块不会修改原始估时，也不会标记完成。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              perform(
                {
                  type: "schedule",
                  taskId: draft.taskId,
                  date: draft.date,
                  start: draft.start,
                  end: draft.start + draft.duration,
                },
                draft.revision,
              );
            }}
          >
            <div className="calendar-fields">
              <label className="field">
                安排日期
                <input
                  required
                  type="date"
                  min={today}
                  value={draft.date}
                  onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                />
              </label>
              <label className="field">
                开始时间
                <TimeInput
                  required
                  step={300}
                  value={clockTime(draft.start)}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(":").map(Number);
                    setDraft({ ...draft, start: h * 60 + m });
                  }}
                />
              </label>
              <label className="field">
                预约分钟
                <input
                  required
                  type="number"
                  min={5}
                  max={480}
                  step={5}
                  value={draft.duration}
                  onChange={(e) =>
                    setDraft({ ...draft, duration: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <div className="calendar-editor-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  const task = taskById(draft.taskId);
                  if (task) {
                    setDraft(null);
                    onEditTask(task);
                  }
                }}
              >
                编辑任务详情
              </button>
              <button
                className="text-button delete-text"
                type="button"
                onClick={() => {
                  const task = taskById(draft.taskId);
                  if (task) onDeleteTask(task);
                }}
              >
                删除任务
              </button>
              <button className="button primary" type="submit">
                保存时间安排
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() =>
                  perform(
                    { type: "date", taskId: draft.taskId, date: draft.date },
                    draft.revision,
                  )
                }
              >
                只调整日期
              </button>
              {blockById(draft.taskId) && (
                <>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() =>
                      perform(
                        {
                          type: "lock",
                          taskId: draft.taskId,
                          locked: !blockById(draft.taskId)?.locked,
                        },
                        draft.revision,
                      )
                    }
                  >
                    {blockById(draft.taskId)?.locked ? (
                      <Unlock size={15} />
                    ) : (
                      <LockKeyhole size={15} />
                    )}{" "}
                    {blockById(draft.taskId)?.locked ? "解锁" : "锁定"}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() =>
                      perform(
                        { type: "unschedule", taskId: draft.taskId },
                        draft.revision,
                      )
                    }
                  >
                    移出时间轴，保留任务
                  </button>
                </>
              )}
            </div>
          </form>
        </section>
      )}
      {auto && (
        <section
          className="panel calendar-auto"
          aria-label="自动安排预览"
          ref={autoRef}
        >
          <header>
            <h2>{auto.date} · 自动安排预览</h2>
            <button
              className="icon-btn"
              aria-label="关闭自动安排预览"
              onClick={() => setAuto(null)}
            >
              <X size={18} />
            </button>
          </header>
          <p>
            已有时间块（含锁定项）全部保留。这里只安排选中日期中尚未分配时间的任务。
          </p>
          {auto.result.blocks.map((b) => (
            <div className="auto-row" key={b.taskId}>
              <span>
                {clockTime(b.start)}–{clockTime(b.end)}
              </span>
              <strong>{taskById(b.taskId)?.title}</strong>
            </div>
          ))}
          {auto.result.deferred.map((t) => (
            <div className="auto-row deferred-row" key={t.taskId}>
              <strong>{taskById(t.taskId)?.title}</strong>
              <span>{t.reason.replace("今天", "当天")}</span>
            </div>
          ))}
          {!auto.result.blocks.length && (
            <p>
              没有可新增的安排：可能已全部安排、剩余时间不足，或当天没有未安排任务。
            </p>
          )}
          <button
            className="button primary"
            disabled={!auto.result.blocks.length}
            onClick={commitAuto}
          >
            确认填入 {auto.result.blocks.length} 项任务
          </button>
        </section>
      )}
    </>
  );
}
