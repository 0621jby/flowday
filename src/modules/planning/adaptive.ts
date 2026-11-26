import { growthDefaults, isPending, record } from "../core/execution";
import { validateExecutionData } from "../core/execution-validation";
import { estimateFor, growthReport } from "../core/growth";
import { localDate, uid, type AppState, type Task } from "../core/model";
import {
  availableMinutes,
  dayAvailability,
  planningRatio,
} from "./availability";
import { addDays, applyCalendarChange, parseDay } from "./calendar";
import { clockTime } from "./scheduler";

export type AdaptiveOptions = {
  horizon: 1 | 3 | 7 | 14;
  replan: boolean;
  useHistory: boolean;
  urgentId?: string;
  extraMinutes?: number;
  defer?: { taskId: string; date: string };
  recentPlan?: { planned: number; matched: number };
};
type Block = AppState["blocks"][number];
const priority = { high: 0, medium: 1, low: 2 };
function floorMinute(now: Date) {
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}
function canMove(state: AppState, task: Task) {
  return (
    isPending(task) &&
    state.session?.taskId !== task.id &&
    !state.blocks.some((b) => b.taskId === task.id && b.locked) &&
    state.blocks.filter((b) => b.taskId === task.id).length <= 1
  );
}
export function createSplit(
  state: AppState,
  taskId: string,
  steps: { title: string; minutes: number }[],
  now = new Date(),
) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (
    !task ||
    !canMove(state, task) ||
    task.execution?.parentId ||
    state.tasks.some((t) => t.execution?.parentId === taskId)
  )
    throw new Error("请选择未执行、未锁定且尚未拆分的原任务。");
  if (state.blocks.filter((b) => b.taskId === taskId).length > 1)
    throw new Error("请先在日历中调整该任务的分段安排。");
  const existing = state.blocks.find((b) => b.taskId === taskId);
  if (
    state.tasks.some(
      (t) =>
        t.execution?.dependencies?.includes(taskId) &&
        state.blocks.some((b) => b.taskId === t.id),
    )
  )
    throw new Error("请先手动处理已预约的后续任务，再拆分这个前置任务。");
  if (
    existing &&
    existing.date === localDate(now) &&
    existing.start <= floorMinute(now) &&
    existing.end > floorMinute(now)
  )
    throw new Error("这个时间块正在进行，请结束后再拆分。");
  if (
    steps.length < 2 ||
    steps.length > 6 ||
    steps.some(
      (s) =>
        !s.title.trim() ||
        s.title.length > 200 ||
        !Number.isInteger(s.minutes) ||
        s.minutes < 5 ||
        s.minutes > 480,
    )
  )
    throw new Error("请填写 2–6 个具体步骤，每步 5–480 分钟。");
  const next = structuredClone(state);
  let previous: string | undefined;
  for (const { title, minutes } of steps) {
    const id = uid();
    next.tasks.push({
      id,
      title: title.trim(),
      minutes,
      priority: task.priority,
      goalId: task.goalId,
      notes: "",
      status: "todo",
      date: task.date,
      createdAt: now.toISOString(),
      completedAt: null,
      execution: {
        kind: task.execution?.kind,
        dueDate: task.execution?.dueDate,
        parentId: taskId,
        dependencies: previous ? [previous] : task.execution?.dependencies,
      },
    });
    previous = id;
  }
  next.blocks = next.blocks.filter((b) => b.taskId !== taskId);
  record(next, task, "split", now.getTime());
  validateExecutionData(next);
  return next;
}

export function adaptivePlan(
  state: AppState,
  options: AdaptiveOptions,
  now = new Date(),
) {
  validateExecutionData(state);
  const today = localDate(now);
  const days = Array.from({ length: options.horizon }, (_, i) =>
    addDays(today, i),
  );
  const last = days.at(-1)!;
  const next = structuredClone(state);
  const parentIds = new Set(
    state.tasks.flatMap((t) =>
      t.execution?.parentId ? [t.execution.parentId] : [],
    ),
  );
  const oldBlocks = new Map(state.blocks.map((b) => [b.taskId, b]));
  const reasons = new Map<string, string>();
  const skipped: { id: string; title: string; reason: string }[] = [];
  let protectedCount = 0;
  const profile = state.settings.growth ?? growthDefaults;
  const period = options.recentPlan ?? growthReport(state, 30, today).current;
  const lowerLoad =
    options.useHistory &&
    profile.personalize &&
    period.planned >= 5 &&
    period.matched / period.planned < 0.6;
  const bufferRatio = lowerLoad
    ? Math.min(0.65, planningRatio(state))
    : planningRatio(state);
  const overlapsNow = (b: Block) =>
    b.date === today && b.start <= floorMinute(now) && b.end > floorMinute(now);
  const conflicts = state.blocks.flatMap((block) => {
    if (block.date < today || block.date > last) return [];
    const day = dayAvailability(state, block.date);
    const conflicting = (state.fixedTimes ?? []).find(
      (b) =>
        b.date === block.date && block.start < b.end && b.start < block.end,
    );
    const task = state.tasks.find((t) => t.id === block.taskId);
    const reason = conflicting
      ? `与固定日程「${conflicting.title}」重叠`
      : block.start < day.start || block.end > day.end || day.capacity === 0
        ? "超出新的可用时段"
        : task?.execution?.dueDate && block.date > task.execution.dueDate
          ? "超过新的任务截止日期"
          : "";
    return reason
      ? [{ id: block.taskId, title: task?.title ?? "已有预约", reason }]
      : [];
  });
  const protectsDependents = (id: string, workspace: AppState) =>
    workspace.tasks.some(
      (t) =>
        t.execution?.dependencies?.includes(id) &&
        workspace.blocks.some((b) => b.taskId === t.id),
    );
  if (options.defer) {
    const { taskId, date } = options.defer;
    const task = next.tasks.find((t) => t.id === taskId);
    const block = oldBlocks.get(taskId);
    parseDay(date);
    if (
      !task ||
      !canMove(state, task) ||
      (block && overlapsNow(block)) ||
      protectsDependents(taskId, state)
    )
      throw new Error("该任务正在执行、已锁定或已有预约依赖，无法在此延期。");
    if (
      date <= (task.date || today) ||
      date < today ||
      (task.execution?.dueDate && date > task.execution.dueDate)
    )
      throw new Error("延期日期需晚于原计划，且不能超过截止日期。");
    task.date = date;
    next.blocks = next.blocks.filter((b) => b.taskId !== taskId);
    reasons.set(taskId, "按你指定的日期延期，原时间块释放");
  }
  const candidates = state.tasks
    .filter((task) => {
      if (
        !isPending(task) ||
        parentIds.has(task.id) ||
        task.id === options.defer?.taskId
      )
        return false;
      if (task.date > last && task.id !== options.urgentId) return false;
      const block = oldBlocks.get(task.id);
      if (
        !canMove(state, task) ||
        (block && (overlapsNow(block) || !options.replan))
      ) {
        protectedCount++;
        if (block && block.date < today)
          skipped.push({
            id: task.id,
            title: task.title,
            reason: "保留原时间块。仅在允许重排且未锁定时可以重新预约。",
          });
        return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        Number(b.id === options.urgentId) - Number(a.id === options.urgentId) ||
        (a.execution?.dueDate || "9999").localeCompare(
          b.execution?.dueDate || "9999",
        ) ||
        priority[a.priority] - priority[b.priority] ||
        a.date.localeCompare(b.date) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );

  const preferred = profile.preferred;
  const preferredRange =
    preferred === "morning"
      ? [0, 720]
      : preferred === "afternoon"
        ? [720, 1080]
        : preferred === "evening"
          ? [1080, 1440]
          : null;
  const ordered = new Map(candidates.map((t) => [t.id, t]));
  const processed = new Set<string>();
  const backlog = [...candidates];
  while (backlog.length) {
    const index = backlog.findIndex((task) =>
      (task.execution?.dependencies ?? []).every(
        (id) => !ordered.has(id) || processed.has(id),
      ),
    );
    if (index < 0) break; // validated above
    const [task] = backlog.splice(index, 1);
    processed.add(task.id);
    const original = oldBlocks.get(task.id);
    const history = options.useHistory ? estimateFor(state, task, now) : null;
    const baseMinutes =
      history?.minutes ??
      (original ? original.end - original.start : task.minutes);
    const minutes =
      Math.ceil(
        (baseMinutes +
          (task.id === options.urgentId ? (options.extraMinutes ?? 0) : 0)) /
          5,
      ) * 5;
    const gap = minutes >= 45 ? 10 : 5;
    let placed: Block | undefined;
    const working = {
      ...next,
      blocks: next.blocks.filter((b) => b.taskId !== task.id),
    };
    const earliest =
      task.id === options.urgentId
        ? today
        : task.date > today
          ? task.date
          : today;
    const dependents = new Set(
      state.tasks
        .filter((t) => t.execution?.dependencies?.includes(task.id))
        .map((t) => t.id),
    );
    const required = (task.execution?.dependencies ?? []).filter(
      (id) => state.tasks.find((t) => t.id === id)?.status !== "done",
    );
    const dependencyBlocks = required.map((id) =>
      working.blocks.find(
        (b) =>
          b.taskId === id &&
          (b.date > today || (b.date === today && b.end > floorMinute(now))),
      ),
    );
    for (const date of days) {
      if (
        date < earliest ||
        (task.execution?.dueDate && date > task.execution.dueDate)
      )
        continue;
      if (dependencyBlocks.some((b) => !b || b.date > date)) continue;
      const earliestAfterDependency = Math.max(
        0,
        ...dependencyBlocks.map((b) => (b?.date === date ? b.end + 5 : 0)),
      );
      const window = dayAvailability(working, date);
      const busy = [...working.blocks, ...(working.fixedTimes ?? [])].filter(
        (b) => b.date === date,
      );
      const reserved = working.blocks
        .filter((b) => b.date === date)
        .reduce((sum, b) => sum + b.end - b.start, 0);
      const remainingReserved = working.blocks
        .filter((b) => b.date === date)
        .reduce(
          (sum, b) =>
            sum +
            Math.max(
              0,
              b.end - Math.max(b.start, date === today ? floorMinute(now) : 0),
            ),
          0,
        );
      if (
        reserved + minutes > window.capacity ||
        remainingReserved + minutes + gap >
          Math.floor(availableMinutes(working, date, now) * bufferRatio)
      )
        continue;
      const ranges = preferredRange ? [preferredRange, [0, 1440]] : [[0, 1440]];
      for (const [from, to] of ranges) {
        const start =
          Math.ceil(
            Math.max(
              window.start,
              from,
              earliestAfterDependency,
              date === today ? floorMinute(now) : 0,
            ) / 5,
          ) * 5;
        const until = Math.min(window.end, to);
        for (let minute = start; minute + minutes + gap <= until; minute += 5) {
          if (
            busy.some(
              (b) => minute < b.end + 5 && b.start < minute + minutes + gap,
            )
          )
            continue;
          if (
            working.blocks.some(
              (b) =>
                dependents.has(b.taskId) &&
                (b.date < date ||
                  (b.date === date && b.start < minute + minutes)),
            )
          )
            continue;
          const proposal = {
            taskId: task.id,
            date,
            start: minute,
            end: minute + minutes,
            locked: false,
          };
          try {
            const applied = applyCalendarChange(
              working,
              { type: "schedule", ...proposal },
              now,
            );
            next.tasks = applied.tasks;
            next.blocks = applied.blocks;
            placed = proposal;
          } catch {
            break;
          } // Date or dependency violations cannot be repaired by moving earlier.
          if (placed) break;
        }
        if (placed) break;
      }
      if (placed) break;
    }
    if (!placed) {
      const dependency = (task.execution?.dependencies ?? []).some(
        (id) =>
          state.tasks.find((t) => t.id === id)?.status !== "done" &&
          !next.blocks.some((b) => b.taskId === id),
      );
      const pastDeadline =
        !!task.execution?.dueDate && task.execution.dueDate < today;
      skipped.push({
        id: task.id,
        title: task.title,
        reason: pastDeadline
          ? "截止日期已过，请手动更新截止日期或决定是否放弃。"
          : dependency
            ? "依赖尚未完成，也未能先预约。"
            : "可用时段、截止日期或缓冲不足。原安排保留，可拆分或调低负荷。",
      });
      continue;
    }
    const why = [
      task.id === options.urgentId
        ? "你指定为优先处理"
        : task.execution?.dueDate
          ? `考虑截止日期 ${task.execution.dueDate}`
          : "按优先级填入空闲",
      task.date && task.date < today ? "原计划已过" : "",
      history ? `参考 ${history.samples} 条同类记录，预留 ${minutes} 分钟` : "",
      task.id === options.urgentId && options.extraMinutes
        ? `针对超时额外预留 ${options.extraMinutes} 分钟`
        : "",
    ].filter(Boolean);
    reasons.set(task.id, why.join(" · "));
  }
  const blockById = new Map(next.blocks.map((b) => [b.taskId, b]));
  const dates = new Map(next.tasks.map((t) => [t.id, t.date]));
  const format = (block: Block | undefined, date: string) =>
    block
      ? `${block.date} ${clockTime(block.start)}–${clockTime(block.end)}`
      : date
        ? `${date}（未预约）`
        : "未安排";
  const changes = state.tasks.flatMap((t) => {
    const before = format(oldBlocks.get(t.id), t.date);
    const after = format(blockById.get(t.id), dates.get(t.id) ?? "");
    return before === after
      ? []
      : [
          {
            id: t.id,
            title: t.title,
            before,
            after,
            reason: reasons.get(t.id) ?? "按可用容量调整",
          },
        ];
  });
  return {
    revision: state.revision,
    day: today,
    state: next,
    changes,
    skipped,
    conflicts,
    protectedCount,
    bufferRatio,
  };
}

export function confirmAdaptive(
  state: AppState,
  preview: ReturnType<typeof adaptivePlan>,
  now = new Date(),
) {
  if (state.revision !== preview.revision || localDate(now) !== preview.day)
    throw new Error("数据或日期已变化，请重新预览。");
  const diff = new Set(preview.changes.map((c) => c.id));
  const oldBlocks = new Map(state.blocks.map((b) => [b.taskId, b]));
  for (const id of diff) {
    const task = state.tasks.find((t) => t.id === id);
    const old = oldBlocks.get(id);
    if (
      !task ||
      !canMove(state, task) ||
      (old &&
        old.date === preview.day &&
        old.start <= floorMinute(now) &&
        old.end > floorMinute(now))
    )
      throw new Error("有任务已开始、被锁定或状态已更新，请重新预览。");
  }
  if (
    preview.state.blocks.some(
      (b) =>
        diff.has(b.taskId) &&
        b.date === preview.day &&
        b.start < floorMinute(now),
    )
  )
    throw new Error("建议时段已经过去，请重新预览。");
  return structuredClone(preview.state);
}
