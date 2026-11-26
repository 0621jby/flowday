import { blockKey } from "../core/model";
import { stateSchema, type AppState } from "../core/model";
import { validateExecutionData } from "../core/execution-validation";

function day(value: string, optional = false) {
  if (optional && value === "") return;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Error("日期无效。");
}
function unique(ids: string[]) {
  if (
    ids.some((id) => !id || id.length > 128) ||
    new Set(ids).size !== ids.length
  )
    throw new Error("记录标识为空、过长或重复。");
}
export function validateWorkspace(input: unknown): AppState {
  const s = stateSchema.parse(input);
  if (
    s.goals.length > 2000 ||
    s.blocks.length > 10000 ||
    s.reviews.length > 10000 ||
    s.events.length > 50000
  )
    throw new Error("记录数量超出本阶段上限。");
  unique(s.tasks.map((t) => t.id));
  unique(s.goals.map((g) => g.id));
  unique(s.events.map((e) => e.id));
  unique(s.reviews.map((r) => r.date));
  unique(s.blocks.map(blockKey));
  const tasks = new Map(s.tasks.map((t) => [t.id, t]));
  const goals = new Set(s.goals.map((g) => g.id));
  if (s.settings.dayStart >= s.settings.dayEnd)
    throw new Error("可用时段无效。");
  for (const g of s.goals) day(g.targetDate, true);
  for (const t of s.tasks) {
    day(t.date, true);
    if (t.goalId !== null && !goals.has(t.goalId))
      throw new Error("任务所属目标不存在。");
    if (
      !Number.isFinite(Date.parse(t.createdAt)) ||
      (t.completedAt !== null && !Number.isFinite(Date.parse(t.completedAt)))
    )
      throw new Error("任务时间无效。");
    if ((t.status === "done") !== (t.completedAt !== null))
      throw new Error("任务完成状态与记录不一致。");
  }
  for (const b of s.blocks) {
    day(b.date);
    const task = tasks.get(b.taskId);
    if (!task || task.status === "done" || b.start >= b.end)
      throw new Error("排程与任务不一致。");
  }
  const blocks = [...s.blocks].sort(
    (a, b) => a.date.localeCompare(b.date) || a.start - b.start,
  );
  for (let i = 1; i < blocks.length; i++)
    if (
      blocks[i].date === blocks[i - 1].date &&
      blocks[i].start < blocks[i - 1].end
    )
      throw new Error("排程时段重叠。");
  s.reviews.forEach((r) => day(r.date));
  for (const e of s.events)
    if (
      !e.taskId ||
      e.taskId.length > 128 ||
      !Number.isFinite(Date.parse(e.at)) ||
      (e.type === "focus" && e.seconds === undefined)
    )
      throw new Error("执行记录无效。");
  if (
    s.session &&
    (!tasks.has(s.session.taskId) ||
      tasks.get(s.session.taskId)?.status !== "todo" ||
      !Number.isSafeInteger(s.session.startedAt) ||
      s.session.startedAt < 0)
  )
    throw new Error("专注会话无效。");
  validateExecutionData(s);
  return s;
}

// Stable round trip representation: PostgreSQL may format UTC dates differently.
export function canonicalWorkspace(input: AppState) {
  const s = stateSchema.parse(input);
  s.revision = 0;
  s.tasks = s.tasks.map((t) => ({
    ...t,
    createdAt: new Date(t.createdAt).toISOString(),
    completedAt: t.completedAt ? new Date(t.completedAt).toISOString() : null,
  }));
  s.blocks = s.blocks.map((b) => ({ ...b, locked: b.locked ?? false }));
  s.reviews = s.reviews.map((r) => ({ ...r, drawing: r.drawing ?? [] }));
  s.events = s.events.map((e) => ({ ...e, at: new Date(e.at).toISOString() }));
  return JSON.stringify(s);
}
export function emptyWorkspace() {
  return stateSchema.parse({
    schemaVersion: 1,
    revision: 0,
    tasks: [],
    goals: [],
    blocks: [],
    reviews: [],
    events: [],
    settings: { name: "朋友", dayStart: 9, dayEnd: 18, capacity: 240 },
    session: null,
  });
}
