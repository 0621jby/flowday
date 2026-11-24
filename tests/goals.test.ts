import { describe, expect, it } from "vitest";
import { seedState } from "../src/modules/core/model";
import { removeGoal } from "../src/modules/core/goals";
import { validateWorkspace } from "../src/modules/cloud/validation";

function workspace() {
  const state = seedState();
  state.tasks[0].status = "done";
  state.tasks[0].completedAt = new Date().toISOString();
  state.blocks = [
    {
      taskId: "t2",
      date: state.tasks[1].date,
      start: 540,
      end: 600,
      locked: true,
    },
  ];
  state.events = [
    { id: "e1", taskId: "t1", type: "complete", at: new Date().toISOString() },
  ];
  return state;
}
describe("goal deletion choices", () => {
  it("keeps all tasks and scheduled time when only deleting the goal", () => {
    const state = workspace();
    const before = structuredClone(state);
    const result = removeGoal(state, state.goals[0], false);
    expect(result.tasks).toHaveLength(4);
    expect(result.tasks.slice(0, 2).every((t) => t.goalId === null)).toBe(true);
    expect(result.tasks[0].completedAt).toBe(state.tasks[0].completedAt);
    expect(result.blocks).toEqual(state.blocks);
    expect(result.events).toEqual(state.events);
    expect(state).toEqual(before);
    expect(() => validateWorkspace(result)).not.toThrow();
  });
  it("deletes associated completed and pending tasks plus their locked blocks, retaining historical facts", () => {
    const state = workspace();
    const result = removeGoal(state, state.goals[0], true);
    expect(result.tasks.map((t) => t.id)).toEqual(["t3", "t4"]);
    expect(result.blocks).toEqual([]);
    expect(result.events).toEqual(state.events);
    expect(() => validateWorkspace(result)).not.toThrow();
  });
  it("blocks deleting an active focus task but permits keeping it as an independent task", () => {
    const state = workspace();
    state.session = {
      taskId: "t2",
      startedAt: Date.now(),
      accumulated: 0,
      running: false,
    };
    expect(() => removeGoal(state, state.goals[0], true)).toThrow(/先结束专注/);
    expect(removeGoal(state, state.goals[0], false).session).toEqual(
      state.session,
    );
    expect(state.goals).toHaveLength(2);
  });
  it("rejects deleting a changed or missing goal", () => {
    const state = workspace();
    const original = structuredClone(state.goals[0]);
    state.goals[0].title = "已更新";
    expect(() => removeGoal(state, original, true)).toThrow(/其他地方修改/);
    state.goals.shift();
    expect(() => removeGoal(state, original, false)).toThrow(/其他地方修改/);
  });
});
