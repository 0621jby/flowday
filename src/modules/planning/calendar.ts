import { type AppState, localDate } from "../core/model";
import { schedule, type Slot } from "./scheduler";
import { dayAvailability } from "./availability";
import { isPending } from "../core/execution";
export type CalendarChange =
  | {
      type: "schedule";
      taskId: string;
      date: string;
      start: number;
      end: number;
    }
  | { type: "date"; taskId: string; date: string }
  | { type: "unschedule"; taskId: string }
  | { type: "lock"; taskId: string; locked: boolean };
export function parseDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("请选择有效日期");
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12);
  if (localDate(date) !== day) throw new Error("日期不存在");
  return date;
}
export function addDays(day: string, count: number) {
  const d = parseDay(day);
  d.setDate(d.getDate() + count);
  return localDate(d);
}
export function weekDays(day: string) {
  const d = parseDay(day);
  const monday = addDays(day, -((d.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
export function monthDays(day: string) {
  const d = parseDay(day);
  d.setDate(1);
  const first = weekDays(localDate(d))[0];
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}
export function shiftMonth(day: string, delta: number) {
  const d = parseDay(day);
  d.setDate(1);
  d.setMonth(d.getMonth() + delta);
  return localDate(d);
}
export function dayLoad(state: AppState, date: string) {
  return state.blocks
    .filter((b) => b.date === date)
    .reduce((n, b) => n + b.end - b.start, 0);
}
function validTime(date: string, start: number, end: number, now: Date) {
  parseDay(date);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > 1440 ||
    end - start < 5 ||
    end - start > 480
  )
    throw new Error("时间块需要为 5–480 分钟，并在同一天内");
  if (
    date < localDate(now) ||
    (date === localDate(now) &&
      start < now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60)
  )
    throw new Error("不能把任务安排到已经过去的时间");
  // 本地模式不假装支持 DST 跳时或重复时刻的精确排程。
  const d = parseDay(date);
  d.setHours(0, 0, 0, 0);
  const next = new Date(d);
  next.setDate(next.getDate() + 1);
  if ((next.getTime() - d.getTime()) / 60000 !== 1440)
    throw new Error(
      "当天有夏令时切换；本地版暂仅支持安排日期，不支持精确时间块",
    );
}
export function applyCalendarChange(
  state: AppState,
  change: CalendarChange,
  now = new Date(),
): AppState {
  const task = state.tasks.find((t) => t.id === change.taskId);
  if (!task) throw new Error("任务已不存在，请刷新后重试");
  if (!isPending(task)) throw new Error("已完成任务不能重新安排，请先重新打开");
  if (state.session?.taskId === task.id)
    throw new Error("请先结束当前专注，再调整这项任务");
  const previous = state.blocks.find((b) => b.taskId === task.id);
  if (change.type === "lock") {
    if (!previous) throw new Error("先为任务安排一个时间块");
    return {
      ...state,
      blocks: state.blocks.map((b) =>
        b.taskId === task.id ? { ...b, locked: change.locked } : b,
      ),
    };
  }
  if (previous?.locked) throw new Error("这个时间块已锁定，请先解锁");
  if (change.type === "unschedule")
    return {
      ...state,
      blocks: state.blocks.filter((b) => b.taskId !== task.id),
    };
  parseDay(change.date);
  if (change.date < localDate(now)) throw new Error("请选择今天或未来的日期");
  if (task.execution?.dueDate && change.date > task.execution.dueDate)
    throw new Error("计划日期超过任务截止日期，请调整日期。");
  const proposal =
    change.type === "schedule"
      ? {
          taskId: task.id,
          date: change.date,
          start: change.start,
          end: change.end,
          locked: false,
        }
      : previous
        ? { ...previous, date: change.date }
        : null;
  if (proposal) {
    if (state.tasks.some((t) => t.execution?.parentId === task.id))
      throw new Error("请安排拆分步骤，原任务用于查看进度。");
    validTime(proposal.date, proposal.start, proposal.end, now);
    const window = dayAvailability(state, proposal.date);
    if (proposal.start < window.start || proposal.end > window.end)
      throw new Error("超出可用时段，请调整时间或前往设置修改可用时段");
    const fixed = state.fixedTimes?.find(
      (b) =>
        b.date === proposal.date &&
        proposal.start < b.end &&
        b.start < proposal.end,
    );
    if (fixed) throw new Error(`与固定时段「${fixed.title}」冲突。`);
    for (const dependency of task.execution?.dependencies ?? []) {
      if (state.tasks.find((t) => t.id === dependency)?.status === "done")
        continue;
      const reserved = state.blocks.find((b) => b.taskId === dependency);
      if (
        !reserved ||
        reserved.date < localDate(now) ||
        (reserved.date === localDate(now) &&
          reserved.end <= now.getHours() * 60 + now.getMinutes()) ||
        reserved.date > proposal.date ||
        (reserved.date === proposal.date && reserved.end > proposal.start)
      )
        throw new Error("请先安排依赖任务，再安排此任务。");
    }
    if (
      state.tasks.some(
        (t) =>
          t.execution?.dependencies?.includes(task.id) &&
          state.blocks.some(
            (b) =>
              b.taskId === t.id &&
              (b.date < proposal.date ||
                (b.date === proposal.date && b.start < proposal.end)),
          ),
      )
    )
      throw new Error("这个时间会排在已预约的后续任务之后。");
    const others = state.blocks.filter(
      (b) => b.taskId !== task.id && b.date === proposal.date,
    );
    const conflict = others.find(
      (b) => proposal.start < b.end && proposal.end > b.start,
    );
    if (conflict)
      throw new Error(
        `与「${state.tasks.find((t) => t.id === conflict.taskId)?.title ?? "其他任务"}」时间冲突，原安排保持不变`,
      );
    if (
      others.reduce((n, b) => n + b.end - b.start, 0) +
        proposal.end -
        proposal.start >
      window.capacity
    )
      throw new Error("超过每日可用分钟，请换一天或调整容量");
  }
  return {
    ...state,
    tasks: state.tasks.map((t) =>
      t.id === task.id ? { ...t, date: change.date } : t,
    ),
    blocks: [
      ...state.blocks.filter((b) => b.taskId !== task.id),
      ...(proposal ? [proposal] : []),
    ],
  };
}
export function fillDay(
  state: AppState,
  date: string,
  now = new Date(),
  included?: Set<string>,
  maxBudget = Infinity,
) {
  parseDay(date);
  const window = dayAvailability(state, date);
  const occupied = [...state.blocks, ...(state.fixedTimes ?? [])]
    .filter((b) => b.date === date)
    .sort((a, b) => a.start - b.start);
  const free: Slot[] = [];
  let cursor = window.start;
  for (const b of occupied) {
    if (b.start > cursor)
      free.push({
        start: cursor,
        end: Math.min(b.start, window.end),
      });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  const remaining = Math.max(
    0,
    Math.min(
      Math.floor(window.capacity * 0.8) - dayLoad(state, date),
      maxBudget,
    ),
  );
  const tasks = state.tasks.filter(
    (t) =>
      t.date === date &&
      (!included || included.has(t.id)) &&
      isPending(t) &&
      (!t.execution?.dueDate || t.execution.dueDate >= date) &&
      !(t.execution?.dependencies ?? []).some(
        (id) => state.tasks.find((other) => other.id === id)?.status !== "done",
      ) &&
      !state.tasks.some((child) => child.execution?.parentId === t.id) &&
      !state.blocks.some((b) => b.taskId === t.id) &&
      state.session?.taskId !== t.id,
  );
  const minute =
    date < localDate(now)
      ? 1440
      : date === localDate(now)
        ? Math.ceil(
            now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60,
          )
        : 0;
  return schedule(tasks, free, remaining / 0.8, minute);
}
export function undoCalendar(
  state: AppState,
  before: AppState,
  expectedRevision: number,
  now = new Date(),
) {
  if (state.revision !== expectedRevision)
    throw new Error("之后已有其他更改，不能覆盖撤销");
  const changed = state.tasks
    .filter(
      (t) =>
        JSON.stringify(state.blocks.find((b) => b.taskId === t.id)) !==
          JSON.stringify(before.blocks.find((b) => b.taskId === t.id)) ||
        before.tasks.find((p) => p.id === t.id)?.date !== t.date,
    )
    .map((t) => t.id);
  if (state.session && changed.includes(state.session.taskId))
    throw new Error("请先结束专注再撤销安排");
  for (const block of before.blocks.filter((b) => changed.includes(b.taskId)))
    validTime(block.date, block.start, block.end, now);
  return { ...state, tasks: before.tasks, blocks: before.blocks };
}
