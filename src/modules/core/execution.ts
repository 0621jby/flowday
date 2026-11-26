import {
  localDate,
  uid,
  type AppState,
  type ExecutionEntry,
  type Task,
} from "./model";

export const growthDefaults = {
  personalize: true,
  shareWithAi: false,
  preferred: "any" as const,
};
export const taskStatusLabels = {
  pending: "待开始",
  running: "执行中",
  paused: "已暂停",
  done: "已完成",
  deferred: "已延期",
  abandoned: "已放弃",
} as const;
export function isPending(task: Task) {
  return task.status === "todo" && !task.execution?.abandonedAt;
}
export function taskPhase(
  state: AppState,
  task: Task,
  today = localDate(),
): keyof typeof taskStatusLabels {
  if (task.execution?.abandonedAt) return "abandoned";
  if (task.status === "done") return "done";
  if (state.session?.taskId === task.id)
    return state.session.running ? "running" : "paused";
  const latest = state.executionLog?.findLast(
    (entry) =>
      entry.taskId === task.id &&
      ["defer", "start", "reopen", "restore"].includes(entry.type),
  );
  return latest?.type === "defer" || (task.date && task.date < today)
    ? "deferred"
    : "pending";
}
export function focusSeconds(
  session: NonNullable<AppState["session"]>,
  now: number,
) {
  return Math.floor(
    session.accumulated +
      (session.running ? Math.max(0, (now - session.startedAt) / 1000) : 0),
  );
}
export function record(
  state: AppState,
  task: Task,
  type: ExecutionEntry["type"],
  now: number,
  details: Partial<ExecutionEntry> = {},
) {
  (state.executionLog ??= []).push({
    id: uid(),
    taskId: task.id,
    title: task.title,
    at: new Date(now).toISOString(),
    type,
    kind: task.execution?.kind,
    estimate: task.minutes,
    ...details,
  });
}
export function executionCommand(
  state: AppState,
  taskId: string,
  command:
    | "start"
    | "pause"
    | "resume"
    | "stop"
    | "complete"
    | "reopen"
    | "abandon"
    | "restore",
  now = Date.now(),
) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("任务已不存在。");
  const at = new Date(now).toISOString();
  const session = state.session?.taskId === task.id ? state.session : null;
  if (command === "start" || command === "complete") {
    if (!isPending(task)) throw new Error("请先重新打开这项任务。");
    const required = new Set([
      ...(task.execution?.dependencies ?? []),
      ...state.tasks
        .filter((t) => t.execution?.parentId === task.id)
        .map((t) => t.id),
    ]);
    if (
      [...required].some(
        (id) => state.tasks.find((t) => t.id === id)?.status !== "done",
      )
    )
      throw new Error("请先完成依赖任务或拆分步骤。");
  }
  if (command === "start") {
    if (state.session) throw new Error("请先结束当前专注。");
    state.session = {
      taskId,
      startedAt: now,
      accumulated: 0,
      running: true,
      tracking: {
        firstAt: at,
        estimate: task.minutes,
        kind: task.execution?.kind,
        pauses: 0,
      },
    };
    record(state, task, "start", now);
  }
  if (command === "pause" || command === "resume") {
    if (!session || session.running !== (command === "pause"))
      throw new Error("专注状态已变化。");
    state.session = {
      ...session,
      running: command === "resume",
      startedAt: now,
      accumulated: focusSeconds(session, now),
      ...(session.tracking && {
        tracking: {
          ...session.tracking,
          pauses: session.tracking.pauses + Number(command === "pause"),
        },
      }),
    };
    record(state, task, command, now);
  }
  if (command === "stop" && !session) throw new Error("专注已结束。");
  if (command === "abandon" && (!isPending(task) || session))
    throw new Error("请先结束专注，并确认任务仍待完成。");
  if (
    command === "abandon" &&
    state.blocks.some((b) => b.taskId === taskId && b.locked)
  )
    throw new Error("请先解锁日历时间块。");
  if (command === "stop" || command === "complete") {
    const seconds = session ? focusSeconds(session, now) : 0;
    if (session) {
      state.events.push({ id: uid(), taskId, type: "focus", at, seconds });
      state.session = null;
    }
    const tracking = session?.tracking;
    const previousBoundary = (state.executionLog ?? []).findLastIndex(
      (e) =>
        e.taskId === taskId && (e.type === "reopen" || e.type === "restore"),
    );
    const earlierWork = (state.executionLog ?? [])
      .slice(previousBoundary + 1)
      .filter((e) => e.taskId === taskId && e.type === "stop");
    const priorSegmentsTracked = earlierWork.every(
      (e) => e.firstAt && e.focusSeconds !== undefined,
    );
    const attemptStart =
      previousBoundary < 0 ? "" : state.executionLog![previousBoundary].at;
    const recordedSegments = state.events.filter(
      (e) => e.taskId === taskId && e.type === "focus" && e.at > attemptStart,
    ).length;
    const fullSample =
      command === "complete" &&
      priorSegmentsTracked &&
      !!tracking &&
      recordedSegments === earlierWork.length + 1;
    record(state, task, command, now, {
      ...(session && { focusSeconds: seconds }),
      ...(tracking && {
        firstAt: tracking.firstAt,
        estimate: fullSample
          ? (earlierWork[0]?.estimate ?? tracking.estimate)
          : tracking.estimate,
        kind: fullSample
          ? (earlierWork[0]?.kind ?? tracking.kind)
          : tracking.kind,
        elapsedSeconds: Math.max(
          seconds,
          Math.floor((now - Date.parse(tracking.firstAt)) / 1000),
        ),
        pauses: tracking.pauses,
        completeCoverage: fullSample,
        ...(fullSample && {
          sampleFocusSeconds:
            seconds +
            earlierWork.reduce(
              (sum, entry) => sum + (entry.focusSeconds ?? 0),
              0,
            ),
        }),
      }),
    });
  }
  if (command === "complete" || command === "reopen") {
    if (command === "reopen" && task.status !== "done")
      throw new Error("任务尚未完成。");
    if (command === "reopen") record(state, task, "reopen", now);
    task.status = command === "complete" ? "done" : "todo";
    task.completedAt = command === "complete" ? at : null;
    state.events.push({ id: uid(), taskId, type: command, at });
  }
  if (command === "abandon" || command === "restore") {
    if (command === "restore" && !task.execution?.abandonedAt)
      throw new Error("任务没有被放弃。");
    task.execution = { ...task.execution };
    if (command === "abandon") task.execution.abandonedAt = at;
    else delete task.execution.abandonedAt;
    record(state, task, command, now);
  }
  if (command === "complete" || command === "abandon")
    state.blocks = state.blocks.filter((b) => b.taskId !== taskId);
  return state;
}

// Record confirmed plan transitions across manual edits, calendar, Coach and adaptive planning.
export function recordPlanChanges(
  before: AppState,
  next: AppState,
  now = Date.now(),
) {
  const oldTasks = new Map(before.tasks.map((t) => [t.id, t]));
  const originalDates = new Set(
    before.blocks.map((b) => JSON.stringify([b.taskId, b.date])),
  );
  const commitments = new Set(
    next.executionLog
      ?.filter((e) => e.type === "commit")
      .map((e) => JSON.stringify([e.taskId, e.to])),
  );
  for (const task of next.tasks) {
    if (!isPending(task)) continue;
    const old = oldTasks.get(task.id);
    if (old?.date && task.date > old.date)
      record(next, task, "defer", now, { from: old.date, to: task.date });
    for (const block of next.blocks.filter((b) => b.taskId === task.id)) {
      const key = JSON.stringify([task.id, block.date]);
      if (originalDates.has(key) || commitments.has(key)) continue;
      record(next, task, "commit", now, { to: block.date });
      commitments.add(key);
    }
  }
  return next;
}

export function removeTaskLinks(tasks: Task[], removed: Set<string>) {
  return tasks
    .filter((task) => !removed.has(task.id))
    .map((task) => {
      const metadata = task.execution;
      if (!metadata) return task;
      const detachParent =
        !!metadata.parentId && removed.has(metadata.parentId);
      const detachDependency = metadata.dependencies?.some((id) =>
        removed.has(id),
      );
      if (!detachParent && !detachDependency) return task;
      return {
        ...task,
        execution: {
          ...metadata,
          parentId: detachParent ? undefined : metadata.parentId,
          dependencies: metadata.dependencies?.filter((id) => !removed.has(id)),
        },
      };
    });
}
