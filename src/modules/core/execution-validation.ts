import type { AppState } from "./model";

function validDay(date: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new Error("请输入有效日期。");
}

export function validateExecutionData(state: AppState) {
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const parents = new Set(
    state.tasks.flatMap((t) =>
      t.execution?.parentId ? [t.execution.parentId] : [],
    ),
  );
  const graph = new Map<string, string[]>();
  for (const task of state.tasks) {
    const data = task.execution;
    if (data?.dueDate) validDay(data.dueDate);
    if (
      data?.abandonedAt &&
      (task.status === "done" || state.session?.taskId === task.id)
    )
      throw new Error("放弃状态与当前执行状态冲突。");
    if (
      data?.parentId &&
      (!tasks.has(data.parentId) ||
        tasks.get(data.parentId)?.execution?.parentId)
    )
      throw new Error("拆分步骤必须关联一个存在的原任务，且只支持一层拆分。");
    const dependencies = data?.dependencies ?? [];
    if (
      new Set(dependencies).size !== dependencies.length ||
      dependencies.some((id) => !tasks.has(id))
    )
      throw new Error("依赖任务必须存在，且不能重复。");
    graph.set(task.id, [...dependencies]);
  }
  for (const task of state.tasks) {
    if (task.execution?.parentId)
      graph.get(task.execution.parentId)!.push(task.id);
  }
  // Kahn traversal also handles long dependency chains without recursion.
  const counts = new Map([...graph].map(([id, deps]) => [id, deps.length]));
  const next = new Map<string, string[]>();
  for (const [id, deps] of graph)
    for (const dep of deps) {
      const list = next.get(dep) ?? [];
      list.push(id);
      next.set(dep, list);
    }
  const ready = [...counts]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  for (let i = 0; i < ready.length; i++)
    for (const id of next.get(ready[i]) ?? []) {
      const count = counts.get(id)! - 1;
      counts.set(id, count);
      if (!count) ready.push(id);
    }
  if (ready.length !== graph.size)
    throw new Error("任务依赖形成了循环，请检查依赖关系。");
  for (const block of state.blocks) {
    if (
      tasks.get(block.taskId)?.execution?.abandonedAt ||
      parents.has(block.taskId)
    )
      throw new Error("已放弃的任务或已拆分的原任务不能预约。");
  }
  const dates = new Set<string>();
  for (const day of state.availability ?? []) {
    validDay(day.date);
    if (day.end <= day.start || dates.has(day.date))
      throw new Error("当天可用时段无效或重复。");
    dates.add(day.date);
  }
  const fixedIds = new Set<string>();
  for (const block of state.fixedTimes ?? []) {
    validDay(block.date);
    if (block.end <= block.start || fixedIds.has(block.id))
      throw new Error("固定时段无效或重复。");
    fixedIds.add(block.id);
  }
  const logIds = new Set<string>();
  for (const event of state.executionLog ?? []) {
    if (
      logIds.has(event.id) ||
      (event.focusSeconds !== undefined &&
        event.elapsedSeconds !== undefined &&
        event.focusSeconds > event.elapsedSeconds)
    )
      throw new Error("执行历史包含重复或不一致的记录。");
    if (event.from) validDay(event.from);
    if (event.to) validDay(event.to);
    logIds.add(event.id);
  }
}
