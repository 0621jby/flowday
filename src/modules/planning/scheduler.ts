import type { Task } from "../core/model";
export interface Slot {
  start: number;
  end: number;
}
export interface ScheduleResult {
  blocks: Array<Slot & { taskId: string }>;
  deferred: Array<{ taskId: string; reason: string }>;
  used: number;
  budget: number;
}
// 本地首版：单日、不可拆任务。所有计算均为确定性程序逻辑。
export function schedule(
  tasks: Task[],
  windows: Slot[],
  capacity: number,
  nowMinute = 0,
): ScheduleResult {
  const slots = windows
    .filter(
      (s) =>
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
    )
    .map((s) => ({
      start: Math.max(0, Math.ceil(Math.max(s.start, nowMinute) / 5) * 5),
      end: Math.min(1440, Math.floor(s.end / 5) * 5),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const merged: Slot[] = [];
  for (const slot of slots) {
    const last = merged.at(-1);
    if (last && slot.start <= last.end) last.end = Math.max(last.end, slot.end);
    else merged.push({ ...slot });
  }
  const budget = Math.max(
    0,
    Math.min(
      Math.floor(capacity * 0.8),
      merged.reduce((n, s) => n + s.end - s.start, 0),
    ),
  );
  let used = 0;
  const blocks: ScheduleResult["blocks"] = [];
  const deferred: ScheduleResult["deferred"] = [];
  const priority = { high: 3, medium: 2, low: 1 };
  const ordered = [...tasks]
    .filter((t) => t.status !== "done")
    .sort(
      (a, b) =>
        priority[b.priority] - priority[a.priority] ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  for (const task of ordered) {
    const minutes = Math.ceil(task.minutes / 5) * 5;
    const buffer = minutes >= 45 ? 10 : 5;
    const slot = merged.find(
      (s) => s.end - s.start >= minutes && used + minutes + buffer <= budget,
    );
    if (!slot) {
      deferred.push({
        taskId: task.id,
        reason:
          used + minutes + buffer > budget
            ? "今天的计划容量已满"
            : "没有足够的连续时间",
      });
      continue;
    }
    blocks.push({
      taskId: task.id,
      start: slot.start,
      end: slot.start + minutes,
    });
    slot.start += minutes + buffer;
    used += minutes + buffer;
  }
  return { blocks, deferred, used, budget };
}
export function clockTime(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
