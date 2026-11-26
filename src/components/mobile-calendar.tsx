"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
  LockKeyhole,
  Plus,
  Search,
  X,
} from "lucide-react";
import {
  blockKey,
  localDate,
  type AppState,
  type Task,
} from "@/modules/core/model";
import { isPending } from "@/modules/core/execution";
import { dayAvailability } from "@/modules/planning/availability";
import {
  addDays,
  applyCalendarChange,
  dayLoad,
  undoCalendar,
  fillDay,
  parseDay,
  weekDays,
  type CalendarChange,
} from "@/modules/planning/calendar";
import { clockTime } from "@/modules/planning/scheduler";
import { TimeInput } from "./time-controls";
import type { CalendarProps } from "./planning-calendar";

type Block = AppState["blocks"][number];
type Draft = {
  taskId: string;
  blockId: string;
  adding: boolean;
  dragged?: boolean;
  date: string;
  start: number;
  duration: number;
  revision: number;
};

const hourHeight = 64;
const priority = { high: "高优先级", medium: "中优先级", low: "低优先级" };
const fromTime = (value: string, empty: number) => {
  if (!value) return empty;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
};

export function MobileCalendar({
  state,
  accountMode,
  update,
  onAdd,
  onEditTask,
  onSettings,
  notify,
}: CalendarProps) {
  const now = new Date();
  const today = localDate(now);
  const minute = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const [date, setDate] = useState(today);
  const [scope, setScope] = useState<"day" | "week">("week");
  const [page, setPage] = useState(0);
  const [dropMinute, setDropMinute] = useState<number | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const poolRef = useRef<HTMLElement>(null);
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    moved: boolean;
    frame: number;
  } | null>(null);
  useEffect(
    () => () => {
      if (drag.current) cancelAnimationFrame(drag.current.frame);
    },
    [],
  );
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    date: string;
    revision: number;
    result: ReturnType<typeof fillDay>;
  } | null>(null);
  const [autoError, setAutoError] = useState("");
  const [undo, setUndo] = useState<{
    before: AppState;
    revision: number;
  } | null>(null);
  const inFlight = useRef(false);
  const confirmTouch = useRef<{ id: number; x: number; y: number } | null>(
    null,
  );
  const confirmTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const modal = dialog.current;
    if (draft && modal && !modal.open) modal.showModal();
    if (!draft && modal?.open) modal.close();
  }, [draft]);

  const totals = new Map<string, number>();
  const parents = new Set(
    state.tasks.flatMap((task) =>
      task.execution?.parentId ? [task.execution.parentId] : [],
    ),
  );
  for (const block of state.blocks)
    totals.set(
      block.taskId,
      (totals.get(block.taskId) ?? 0) + block.end - block.start,
    );
  const minutesLeft = (task: Task) =>
    Math.max(0, task.minutes - (totals.get(task.id) ?? 0));
  const available = state.tasks.filter(
    (task) =>
      isPending(task) &&
      task.id !== state.session?.taskId &&
      !parents.has(task.id) &&
      minutesLeft(task) > 0,
  );
  const selected = available.find((task) => task.id === selectedId);
  const editedTask = state.tasks.find((task) => task.id === draft?.taskId);
  const editedBlock =
    draft && !draft.adding
      ? state.blocks.find(
          (block) =>
            blockKey(block) === draft.blockId && block.taskId === draft.taskId,
        )
      : undefined;
  const blocks = state.blocks.filter((block) => block.date === date);
  const fixed = (state.fixedTimes ?? []).filter((block) => block.date === date);
  const availability = dayAvailability(state, date);
  const rangeStart = Math.min(
    availability.start,
    ...blocks.map((b) => b.start),
    ...fixed.map((b) => b.start),
  );
  const rangeEnd = Math.max(
    availability.end,
    ...blocks.map((b) => b.end),
    ...fixed.map((b) => b.end),
  );
  const first = Math.floor(rangeStart / 60);
  const last = Math.ceil(rangeEnd / 60);
  const hours = Array.from({ length: last - first }, (_, i) => first + i);
  const ticks = [
    rangeStart,
    ...hours
      .map((hour) => hour * 60)
      .filter((at) => at > rangeStart + 15 && at < rangeEnd - 15),
    rangeEnd,
  ];
  const pos = (at: number) => ((at - rangeStart) / 60) * hourHeight;
  const occupied = [...blocks, ...fixed].sort((a, b) => a.start - b.start);
  const startLimit = Math.max(
    availability.start,
    date === today ? Math.ceil(minute / 5) * 5 : 0,
  );
  const slots = hours.flatMap((hour) => {
    const end = Math.min((hour + 1) * 60, availability.end);
    let cursor = Math.max(hour * 60, startLimit);
    const gaps: Array<{ start: number; end: number }> = [];
    for (const block of occupied) {
      if (block.end <= cursor || block.start >= end) continue;
      if (block.start - cursor >= 5)
        gaps.push({ start: cursor, end: block.start });
      cursor = Math.max(cursor, block.end);
    }
    if (end - cursor >= 5) gaps.push({ start: cursor, end });
    return gaps;
  });

  const calendarWeek = weekDays(date);
  const matches = available.filter((task) => {
    const dates = [
      task.date,
      task.execution?.dueDate,
      ...state.blocks.filter((b) => b.taskId === task.id).map((b) => b.date),
    ].filter(Boolean);
    const visible =
      scope === "day"
        ? dates.includes(date)
        : !dates.length ||
          dates.some((day) => calendarWeek.some((d) => d === day));
    return (
      visible && task.title.toLowerCase().includes(query.trim().toLowerCase())
    );
  });
  const lastPage = Math.max(0, Math.ceil(matches.length / 3) - 1);
  const currentPage = Math.min(page, lastPage);
  function setDay(day: string) {
    setDate(day);
    setPage(0);
    setError("");
  }
  function gapEnd(start: number) {
    return Math.min(
      availability.end,
      ...occupied.filter((b) => b.start > start).map((b) => b.start),
    );
  }
  function targetAt(x: number, y: number) {
    const box = laneRef.current?.getBoundingClientRect();
    if (
      !box ||
      x < box.left ||
      x > box.right ||
      y < Math.max(0, box.top) ||
      y >= Math.min(box.bottom, window.innerHeight - 70)
    )
      return null;
    const minute =
      Math.floor((rangeStart + ((y - box.top) * 60) / hourHeight) / 5) * 5;
    return date >= today &&
      slots.some((slot) => slot.start <= minute && minute + 5 <= slot.end)
      ? minute
      : null;
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!selected || busy || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      frame: 0,
    };
    const tick = () => {
      const current = drag.current;
      if (!current) return;
      if (current.moved) {
        const delta =
          current.y < 72 ? -10 : current.y > window.innerHeight - 110 ? 10 : 0;
        if (delta) window.scrollBy({ top: delta, behavior: "instant" });
        setDropMinute(targetAt(current.x, current.y));
      }
      current.frame = requestAnimationFrame(tick);
    };
    drag.current.frame = requestAnimationFrame(tick);
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    current.moved ||=
      Math.hypot(current.x - event.clientX, current.y - event.clientY) > 3;
    current.x = event.clientX;
    current.y = event.clientY;
  }
  function endDrag(event: PointerEvent<HTMLButtonElement>, canceled = false) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    cancelAnimationFrame(current.frame);
    drag.current = null;
    setDropMinute(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const start =
      canceled || !current.moved
        ? null
        : targetAt(event.clientX, event.clientY);
    if (selected && start !== null)
      requestAnimationFrame(() =>
        openDraft(selected, start, gapEnd(start), undefined, true),
      );
  }
  function openDraft(
    task: Task,
    start: number,
    maxEnd: number,
    block?: Block,
    dragged = false,
  ) {
    setError("");
    setDraft({
      taskId: task.id,
      blockId: block ? blockKey(block) : crypto.randomUUID(),
      adding: !block,
      dragged,
      date,
      start,
      duration: block
        ? block.end - block.start
        : Math.min(480, Math.max(5, minutesLeft(task)), maxEnd - start),
      revision: state.revision,
    });
  }
  async function save(change: CalendarChange) {
    if (!draft || inFlight.current) return;
    if (
      change.type === "append" &&
      state.blocks.some(
        (block) =>
          blockKey(block) === change.blockId &&
          block.taskId === change.taskId &&
          block.date === change.date &&
          block.start === change.start &&
          block.end === change.end,
      )
    ) {
      setDate(change.date);
      setDraft(null);
      notify("已同步此时间段");
      return;
    }
    if (draft.revision !== state.revision) {
      setError(
        "日历已有更新。已保留本次输入，重新确认后会按最新日历检查冲突。",
      );
      if (draft.adding || editedBlock)
        setDraft({ ...draft, revision: state.revision });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      applyCalendarChange(state, change);
      const ok = await update((current) => {
        if (current.revision !== draft.revision)
          throw new Error("日历已更新，请重新确认。");
        return applyCalendarChange(current, change);
      });
      if (!ok) {
        setError(
          accountMode
            ? "云端尚未确认保存。已保留所选任务和时间，请查看同步状态。"
            : "本机尚未确认保存。已保留所选任务和时间，请重试。",
        );
        return;
      }
      setUndo({ before: state, revision: state.revision + 1 });
      setDate(draft.date);
      setDraft(null);
      if (
        draft.adding &&
        selectedId === draft.taskId &&
        editedTask &&
        draft.duration >= minutesLeft(editedTask)
      )
        setSelectedId("");
      notify(
        change.type === "unschedule" ? "已删除此时间段" : "已保存时间安排",
      );
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : "保存失败，请重试。",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const { taskId, blockId, date, start, duration, adding } = draft;
    void save({
      type: adding ? "append" : "schedule",
      taskId,
      blockId,
      date,
      start,
      end: start + duration,
    });
  }

  async function confirmAuto() {
    if (!preview || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setAutoError("");
    try {
      const ok = await update((current) => {
        if (current.revision !== preview.revision)
          throw new Error("日历已更新，请重新预览。");
        return preview.result.blocks.reduce(
          (next, block) =>
            applyCalendarChange(next, {
              type: "schedule",
              date: preview.date,
              ...block,
            }),
          current,
        );
      });
      if (!ok) setAutoError("未确认保存，请检查同步状态后重新预览。");
      else {
        setUndo({ before: state, revision: state.revision + 1 });
        setPreview(null);
        notify("已填入空闲时间");
      }
    } catch (problem) {
      setAutoError(
        problem instanceof Error ? problem.message : "自动安排失败，请重试。",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="mobile-calendar" aria-label="手机计划日历">
      <div className="mobile-week-header">
        <button
          className="icon-btn"
          aria-label="上一周"
          onClick={() => setDay(addDays(date, -7))}
        >
          <ChevronLeft size={20} />
        </button>
        <h1>
          {date.slice(0, 4)} 年 {Number(date.slice(5, 7))} 月
        </h1>
        <button className="text-button" onClick={() => setDay(today)}>
          今天
        </button>
        <button
          className="icon-btn"
          aria-label="下一周"
          onClick={() => setDay(addDays(date, 7))}
        >
          <ChevronRight size={20} />
        </button>
      </div>
      <div className="mobile-week-days" role="group" aria-label="选择本周日期">
        {weekDays(date).map((day) => {
          const ids = new Set(
            state.blocks
              .filter((block) => block.date === day)
              .map((block) => block.taskId),
          );
          state.tasks
            .filter((task) => task.date === day && !task.execution?.abandonedAt)
            .forEach((task) => ids.add(task.id));
          return (
            <button
              type="button"
              key={day}
              aria-pressed={day === date}
              aria-current={day === today ? "date" : undefined}
              aria-label={`${day}，${ids.size} 项任务`}
              onClick={() => setDay(day)}
            >
              <span>
                {parseDay(day).toLocaleDateString("zh-CN", {
                  weekday: "short",
                })}
              </span>
              <strong>{Number(day.slice(-2))}</strong>
              <small>{ids.size} 项</small>
            </button>
          );
        })}
      </div>
      {undo && (
        <button
          className="text-button"
          disabled={busy || undo.revision !== state.revision}
          onClick={async () => {
            if (inFlight.current) return;
            inFlight.current = true;
            setBusy(true);
            try {
              const next = undoCalendar(state, undo.before, undo.revision);
              if (await update(() => next)) {
                setUndo(null);
                notify("已撤销上次安排");
              }
            } catch (problem) {
              notify(problem instanceof Error ? problem.message : "无法撤销");
            } finally {
              inFlight.current = false;
              setBusy(false);
            }
          }}
        >
          撤销上次安排
        </button>
      )}
      <div className="mobile-arrange-grid">
        <section className="mobile-arrange-time" aria-label="当天可用时间">
          <div className="mobile-availability">
            <strong>可用时间</strong>
            <span>
              {clockTime(availability.start)}–{clockTime(availability.end)}
            </span>
          </div>
          <div className="mobile-timeline panel" aria-label={`${date} 时间轴`}>
            <div
              className="mobile-time-labels"
              style={{ height: pos(rangeEnd) }}
            >
              {ticks.map((at) => (
                <span
                  key={at}
                  style={at === rangeEnd ? { bottom: 1 } : { top: pos(at) }}
                >
                  {clockTime(at)}
                </span>
              ))}
            </div>
            <div
              ref={laneRef}
              className="mobile-time-lane"
              style={{ height: pos(rangeEnd) }}
            >
              {hours.map((hour) => (
                <div
                  className="mobile-hour-line"
                  key={hour}
                  style={{ top: Math.max(0, pos(hour * 60)) }}
                />
              ))}
              {date <= today && (
                <div
                  className="elapsed-time"
                  style={{
                    height:
                      date < today
                        ? "100%"
                        : Math.max(0, Math.min(pos(rangeEnd), pos(minute))),
                  }}
                />
              )}
              {date === today && minute >= rangeStart && minute < rangeEnd && (
                <div
                  className="now-line"
                  style={{ top: pos(minute) }}
                  aria-label={`现在 ${clockTime(Math.floor(minute))}`}
                >
                  <span>{clockTime(Math.floor(minute))}</span>
                </div>
              )}
              {date >= today &&
                slots.map((slot) => (
                  <button
                    type="button"
                    className="mobile-slot"
                    key={slot.start}
                    aria-label={`${date} ${clockTime(slot.start)} 安排任务`}
                    style={{
                      top: pos(slot.start),
                      height: pos(slot.end) - pos(slot.start),
                    }}
                    onClick={(e) => {
                      if (!selected) {
                        poolRef.current?.focus({ preventScroll: true });
                        return;
                      }
                      const box = e.currentTarget.getBoundingClientRect();
                      const fractional =
                        e.detail && box.height
                          ? Math.min(
                              1,
                              Math.max(0, (e.clientY - box.top) / box.height),
                            )
                          : 0;
                      const clicked = Math.min(
                        slot.end - 5,
                        slot.start +
                          Math.floor(
                            (fractional * (slot.end - slot.start)) / 5,
                          ) *
                            5,
                      );
                      openDraft(selected, clicked, gapEnd(clicked));
                    }}
                  />
                ))}
              {dropMinute !== null && (
                <div
                  className="mobile-drop-target"
                  style={{ top: pos(dropMinute) }}
                >
                  {clockTime(dropMinute)}
                </div>
              )}
              {fixed.map((block) => (
                <div
                  className="calendar-fixed"
                  key={block.id}
                  style={{
                    top: pos(block.start),
                    height: pos(block.end) - pos(block.start),
                  }}
                >
                  {block.title}
                </div>
              ))}
              {blocks.map((block) => {
                const task = state.tasks.find(
                  (item) => item.id === block.taskId,
                );
                if (!task) return null;
                return (
                  <button
                    type="button"
                    className={`mobile-segment ${task.priority}`}
                    key={blockKey(block)}
                    style={{
                      top: pos(block.start),
                      height: pos(block.end) - pos(block.start),
                    }}
                    aria-label={`${task.title}，${clockTime(block.start)}–${clockTime(block.end)}`}
                    onClick={() =>
                      openDraft(task, block.start, block.end, block)
                    }
                  >
                    {block.locked && <LockKeyhole size={13} />}{" "}
                    <strong>{task.title}</strong>
                    <span>
                      {clockTime(block.start)}–{clockTime(block.end)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
        <aside
          ref={poolRef}
          className="panel mobile-rail"
          aria-label="待安排任务"
          tabIndex={-1}
        >
          <h2>待安排任务</h2>
          {selected && (
            <div className="mobile-pinned-task">
              <strong>{selected.title}</strong>
              <span role="status">剩余 {minutesLeft(selected)} 分</span>
              <div className="mobile-pinned-actions">
                <button
                  type="button"
                  className="mobile-task-grip"
                  aria-label="拖动选中任务"
                  title="拖动到时间轴"
                  onPointerDown={startDrag}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={(e) => endDrag(e, true)}
                  onLostPointerCapture={(e) => endDrag(e, true)}
                >
                  <GripVertical size={15} />
                  拖动
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setSelectedId("")}
                >
                  取消
                </button>
              </div>
            </div>
          )}
          <div
            className="mobile-rail-filters"
            role="group"
            aria-label="任务范围"
          >
            <button
              type="button"
              aria-pressed={scope === "day"}
              onClick={() => {
                setScope("day");
                setPage(0);
              }}
            >
              日
            </button>
            <button
              type="button"
              aria-pressed={scope === "week"}
              onClick={() => {
                setScope("week");
                setPage(0);
              }}
            >
              周
            </button>
          </div>
          <label className="mobile-rail-search">
            <Search size={12} />
            <input
              aria-label="搜索待安排任务"
              placeholder="搜索任务"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <div className="mobile-rail-list">
            {matches.slice(currentPage * 3, currentPage * 3 + 3).map((task) => (
              <button
                type="button"
                key={task.id}
                aria-pressed={selectedId === task.id}
                onClick={() => setSelectedId(task.id)}
              >
                <strong>{task.title}</strong>
                <small>
                  {priority[task.priority]} · 剩 {minutesLeft(task)} 分
                </small>
              </button>
            ))}
            {!matches.length && <p>暂无任务</p>}
          </div>
          {lastPage > 0 && (
            <div className="mobile-rail-page">
              <button
                type="button"
                aria-label="上一组任务"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft size={15} />
              </button>
              <span>
                {currentPage + 1}/{lastPage + 1}
              </span>
              <button
                type="button"
                aria-label="下一组任务"
                disabled={currentPage === lastPage}
                onClick={() => setPage(currentPage + 1)}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          )}
          <button
            type="button"
            className="text-button mobile-rail-add"
            onClick={() => onAdd(date)}
          >
            <Plus size={14} />
            新建任务
          </button>
        </aside>
      </div>
      <div className="mobile-day-footer">
        <span>
          已预约 {dayLoad(state, date)} / {availability.capacity} 分钟
        </span>
        <button className="text-button" onClick={onSettings}>
          调整可用时间
        </button>
      </div>
      <button
        className="button secondary"
        disabled={date < today || busy}
        onClick={() => {
          setAutoError("");
          setPreview({
            date,
            revision: state.revision,
            result: fillDay(state, date),
          });
        }}
      >
        预览当天自动安排
      </button>
      {preview && (
        <section className="panel calendar-auto" aria-label="自动安排预览">
          <header>
            <h2>{preview.date} 自动安排</h2>
            <button
              className="icon-btn"
              disabled={busy}
              aria-label="关闭自动安排"
              onClick={() => setPreview(null)}
            >
              <X size={18} />
            </button>
          </header>
          {preview.result.blocks.map((b) => (
            <div className="auto-row" key={b.taskId}>
              <span>
                {clockTime(b.start)}–{clockTime(b.end)}
              </span>
              <strong>
                {state.tasks.find((t) => t.id === b.taskId)?.title}
              </strong>
            </div>
          ))}
          {preview.result.deferred.map((b) => (
            <div className="auto-row deferred-row" key={b.taskId}>
              <span>{b.reason}</span>
              <strong>
                {state.tasks.find((t) => t.id === b.taskId)?.title}
              </strong>
            </div>
          ))}
          {!preview.result.blocks.length && <p>没有可新增的安排。</p>}
          {autoError && <p role="alert">{autoError}</p>}
          <button
            className="button primary"
            disabled={busy || !preview.result.blocks.length}
            onClick={() => void confirmAuto()}
          >
            确认填入安排
          </button>
        </section>
      )}
      <dialog
        className="calendar-picker mobile-schedule-dialog"
        ref={dialog}
        aria-label="安排时间"
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) setDraft(null);
        }}
      >
        {draft && (
          <form onSubmit={submit}>
            <header>
              <h2>{editedTask?.title ?? "安排时间"}</h2>
              <button
                className="icon-btn"
                type="button"
                aria-label="关闭安排"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                <X size={18} />
              </button>
            </header>
            <fieldset disabled={busy || !!editedBlock?.locked}>
              <label className="field">
                日期
                <input
                  type="date"
                  required
                  value={draft.date}
                  onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                />
              </label>
              <div className="mobile-time-fields">
                <label className="field">
                  开始时间
                  <TimeInput
                    required
                    value={
                      Number.isFinite(draft.start) ? clockTime(draft.start) : ""
                    }
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        start: fromTime(e.target.value, NaN),
                      })
                    }
                  />
                </label>
                <label className="field">
                  结束时间
                  <TimeInput
                    value={
                      draft.start + draft.duration < 1440
                        ? clockTime(draft.start + draft.duration)
                        : ""
                    }
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        duration: fromTime(e.target.value, 1440) - draft.start,
                      })
                    }
                  />
                  <small>留空表示 24:00</small>
                </label>
              </div>
              <label className="field">
                持续分钟
                <input
                  type="number"
                  required
                  min={5}
                  max={480}
                  value={Number.isFinite(draft.duration) ? draft.duration : ""}
                  onChange={(e) =>
                    setDraft({ ...draft, duration: e.target.valueAsNumber })
                  }
                />
              </label>
            </fieldset>
            {error && (
              <p role="alert" className="mobile-schedule-error">
                {error}
              </p>
            )}
            <div className="calendar-editor-actions">
              {!editedBlock?.locked && (
                <button
                  className="button primary"
                  type="submit"
                  disabled={busy || !editedTask}
                  onClick={() => window.clearTimeout(confirmTimer.current)}
                  onPointerDown={(event) => {
                    confirmTouch.current =
                      draft.dragged && event.pointerType === "touch"
                        ? {
                            id: event.pointerId,
                            x: event.clientX,
                            y: event.clientY,
                          }
                        : null;
                  }}
                  onPointerCancel={() => {
                    confirmTouch.current = null;
                  }}
                  onPointerUp={(event) => {
                    const touch = confirmTouch.current;
                    confirmTouch.current = null;
                    if (
                      touch?.id === event.pointerId &&
                      Math.hypot(
                        event.clientX - touch.x,
                        event.clientY - touch.y,
                      ) <= 8
                    ) {
                      const button = event.currentTarget;
                      window.clearTimeout(confirmTimer.current);
                      confirmTimer.current = window.setTimeout(() => {
                        if (button.isConnected && !button.disabled)
                          button.form?.requestSubmit(button);
                      }, 350);
                    }
                  }}
                >
                  {busy ? "保存中…" : "确认安排"}
                </button>
              )}
              {editedBlock && (
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void save({
                      type: "lock",
                      taskId: draft.taskId,
                      blockId: draft.blockId,
                      locked: !editedBlock.locked,
                    })
                  }
                >
                  {editedBlock.locked ? "解锁" : "锁定"}
                </button>
              )}
              {editedBlock && !editedBlock.locked && (
                <button
                  className="text-button delete-text"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void save({
                      type: "unschedule",
                      taskId: draft.taskId,
                      blockId: draft.blockId,
                    })
                  }
                >
                  删除此时间段
                </button>
              )}
              {editedBlock && editedTask && (
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    dialog.current?.close();
                    setDraft(null);
                    onEditTask(editedTask);
                  }}
                >
                  打开任务
                </button>
              )}
            </div>
          </form>
        )}
      </dialog>
    </section>
  );
}
