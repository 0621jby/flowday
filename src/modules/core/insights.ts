import { type Task, localDate } from "./model";
import { addDays } from "../planning/calendar";
export function completionTrend(tasks: Task[], endDate: string, days: 7 | 30) {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.status !== "done" || !task.completedAt) continue;
    const d = new Date(task.completedAt);
    if (Number.isNaN(d.getTime())) continue;
    const day = localDate(d);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(endDate, i - days + 1);
    return { date, count: counts.get(date) ?? 0 };
  });
}
