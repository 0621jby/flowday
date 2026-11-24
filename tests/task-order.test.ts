import { describe, it, expect } from "vitest";
import { seedState, type Task } from "../src/modules/core/model";
import { orderTasks } from "../src/modules/core/task-order";

function task(
  id: string,
  priority: Task["priority"],
  status: Task["status"] = "todo",
): Task {
  return { ...seedState().tasks[0], id, priority, status };
}

describe("task list priority order", () => {
  it("puts a newly added high-priority task above lower priorities and all completed tasks", () => {
    const tasks = [
      task("low", "low"),
      task("done", "high", "done"),
      task("medium", "medium"),
      task("new-high", "high"),
    ];
    expect(orderTasks(tasks).map((t) => t.id)).toEqual([
      "new-high",
      "medium",
      "low",
      "done",
    ]);
  });
  it("preserves ties and source storage order without mutating tasks", () => {
    const tasks = [
      task("first", "high"),
      task("low", "low"),
      task("second", "high"),
    ];
    const original = structuredClone(tasks);
    expect(orderTasks(tasks).map((t) => t.id)).toEqual([
      "first",
      "second",
      "low",
    ]);
    expect(tasks).toEqual(original);
  });
  it("returns reopened tasks to their priority group while completed entries stay stable", () => {
    const tasks = [
      task("done-low", "low", "done"),
      task("done-high", "high", "done"),
      task("pending", "medium"),
    ];
    expect(orderTasks(tasks).map((t) => t.id)).toEqual([
      "pending",
      "done-low",
      "done-high",
    ]);
    tasks[1] = { ...tasks[1], status: "todo" };
    expect(orderTasks(tasks).map((t) => t.id)).toEqual([
      "done-high",
      "pending",
      "done-low",
    ]);
  });
});
