import type { AppState, Goal } from "./model";
import { removeTaskLinks } from "./execution";

export function removeGoal(
  state: AppState,
  expected: Goal,
  deleteTasks: boolean,
): AppState {
  const current = state.goals.find((g) => g.id === expected.id);
  if (JSON.stringify(current) !== JSON.stringify(expected))
    throw new Error("这个目标已在其他地方修改，请重新打开后确认删除。");
  const taskIds = new Set(
    state.tasks.filter((t) => t.goalId === expected.id).map((t) => t.id),
  );
  if (deleteTasks && state.session && taskIds.has(state.session.taskId))
    throw new Error(
      "关联任务正在专注，请先结束专注，再一起删除；也可以选择保留关联任务。",
    );
  return {
    ...state,
    goals: state.goals.filter((g) => g.id !== expected.id),
    tasks: deleteTasks
      ? removeTaskLinks(state.tasks, taskIds)
      : state.tasks.map((t) =>
          taskIds.has(t.id) ? { ...t, goalId: null } : t,
        ),
    blocks: deleteTasks
      ? state.blocks.filter((b) => !taskIds.has(b.taskId))
      : state.blocks,
    // Execution history survives deletion, matching single-task deletion.
  };
}
