import type { Task } from "./model";

const priorityRank = { high: 0, medium: 1, low: 2 } as const;

/** Presentation order only: never rewrites storage order or calendar blocks. */
export function orderTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.status !== b.status) return a.status === "done" ? 1 : -1;
    if (a.status === "done") return 0;
    // Stable sort retains the existing order within each priority.
    return priorityRank[a.priority] - priorityRank[b.priority];
  });
}
