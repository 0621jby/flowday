import { describe, expect, it } from "vitest";
import {
  executionCommand,
  recordPlanChanges,
  taskPhase,
} from "../src/modules/core/execution";
import { validateWorkspace } from "../src/modules/cloud/validation";
import { estimateFor, growthReport } from "../src/modules/core/growth";
import { localDate, seedState } from "../src/modules/core/model";
import {
  adaptivePlan,
  confirmAdaptive,
  createSplit,
} from "../src/modules/planning/adaptive";
import { addDays } from "../src/modules/planning/calendar";
import { buildCoachContext } from "../src/modules/coach/context";

const now = new Date(2026, 10, 19, 8);
const day = localDate(now);
const tomorrow = addDays(day, 1);
const options = { horizon: 3 as const, replan: false, useHistory: false };
function seed() {
  const state = seedState();
  state.tasks.forEach((t) => {
    t.date = day;
    t.createdAt = now.toISOString();
  });
  return state;
}
it("retains focus and elapsed measurements through pause/resume/complete", () => {
  const state = seed();
  const start = now.getTime();
  executionCommand(state, "t1", "start", start);
  expect(taskPhase(state, state.tasks[0], day)).toBe("running");
  executionCommand(state, "t1", "pause", start + 15 * 60000);
  expect(taskPhase(state, state.tasks[0], day)).toBe("paused");
  executionCommand(state, "t1", "resume", start + 25 * 60000);
  executionCommand(state, "t1", "complete", start + 35 * 60000);
  expect(state.executionLog?.at(-1)).toMatchObject({
    type: "complete",
    focusSeconds: 1500,
    elapsedSeconds: 2100,
    pauses: 1,
    estimate: 45,
    completeCoverage: true,
  });
  expect(state.events.map((e) => e.type)).toEqual(["focus", "complete"]);
  expect(taskPhase(state, state.tasks[0], day)).toBe("done");
  executionCommand(state, "t1", "reopen", start + 36 * 60000);
  expect(state.executionLog).toHaveLength(5);
});
it("keeps abandoned tasks restorable and out of automatic plans", () => {
  const state = seed();
  executionCommand(state, "t1", "abandon", now.getTime());
  expect(taskPhase(state, state.tasks[0], day)).toBe("abandoned");
  expect(
    adaptivePlan(state, options, now).state.blocks.some(
      (b) => b.taskId === "t1",
    ),
  ).toBe(false);
  executionCommand(state, "t1", "restore", now.getTime() + 1000);
  expect(taskPhase(state, state.tasks[0], day)).toBe("pending");
});
it("fills several days respecting prerequisite order, due dates, capacity, locks and fixed time", () => {
  const state = seed();
  state.tasks[1].execution = { dependencies: ["t1"], dueDate: tomorrow };
  state.tasks[2].execution = { dueDate: addDays(day, -1) };
  state.blocks = [
    { taskId: "t4", date: day, start: 600, end: 625, locked: true },
  ];
  state.fixedTimes = [
    { id: "meeting", title: "会议", date: day, start: 540, end: 600 },
  ];
  state.availability = [{ date: day, start: 540, end: 660, capacity: 30 }];
  const preview = adaptivePlan(state, options, now);
  expect(preview.state.blocks.find((b) => b.taskId === "t4")).toEqual(
    state.blocks[0],
  );
  expect(preview.state.blocks.find((b) => b.taskId === "t1")?.date).toBe(
    tomorrow,
  );
  const t1 = preview.state.blocks.find((b) => b.taskId === "t1")!;
  const t2 = preview.state.blocks.find((b) => b.taskId === "t2")!;
  expect(t2.date).toBe(tomorrow);
  expect(t2.start).toBeGreaterThan(t1.end);
  expect(preview.skipped.find((item) => item.id === "t3")?.reason).toContain(
    "截止",
  );
  expect(state.blocks).toHaveLength(1);
  expect(() =>
    confirmAdaptive({ ...state, revision: state.revision + 1 }, preview, now),
  ).toThrow(/变化/);
  expect(() =>
    validateWorkspace(confirmAdaptive(state, preview, now)),
  ).not.toThrow();
});
it("does not overwrite active or non-rebookable reservations, and rejects a late confirmation", () => {
  const state = seed();
  state.blocks = [
    { taskId: "t1", date: day, start: 540, end: 585 },
    { taskId: "t2", date: day, start: 600, end: 660 },
  ];
  executionCommand(state, "t1", "start", now.getTime());
  state.availability = [{ date: day, start: 540, end: 550, capacity: 0 }];
  const preview = adaptivePlan(
    state,
    { ...options, horizon: 1, replan: true },
    now,
  );
  expect(preview.state.blocks).toEqual(state.blocks);
  const future = adaptivePlan(seed(), options, now);
  expect(() =>
    confirmAdaptive(seed(), future, new Date(2026, 10, 19, 11)),
  ).toThrow(/过去/);
});
it("splits without losing original or double-booking and captures explicit deferrals", () => {
  const state = seed();
  const next = createSplit(
    state,
    "t1",
    [
      { title: "写测试", minutes: 30 },
      { title: "实现", minutes: 45 },
    ],
    now,
  );
  const children = next.tasks.filter((t) => t.execution?.parentId === "t1");
  expect(children[1].execution?.dependencies).toEqual([children[0].id]);
  const preview = adaptivePlan(
    next,
    { ...options, defer: { taskId: "t4", date: tomorrow } },
    now,
  );
  expect(preview.state.blocks.some((b) => b.taskId === "t1")).toBe(false);
  const saved = recordPlanChanges(next, preview.state, now.getTime());
  expect(saved.executionLog?.find((e) => e.type === "defer")).toMatchObject({
    from: day,
    to: tomorrow,
    taskId: "t4",
  });
  expect(
    saved.executionLog?.filter((e) => e.type === "commit").length,
  ).toBeGreaterThan(0);
});
it("uses measured samples and real plan snapshots without automatically changing estimates", () => {
  const state = seed();
  state.tasks[0].execution = { kind: "project" };
  const at = new Date(2026, 10, 18, 10).toISOString();
  state.executionLog = Array.from({ length: 5 }, (_, i) => ({
    id: `e${i}`,
    taskId: `previous${i}`,
    title: "以前的任务",
    at,
    type: "complete",
    kind: "project",
    focusSeconds: 3600,
    estimate: 30,
    completeCoverage: true,
  }));
  expect(estimateFor(state, state.tasks[0], now)).toMatchObject({
    minutes: 60,
    samples: 5,
  });
  expect(state.tasks[0].minutes).toBe(45);
  expect(growthReport(state, 7, day).current.estimateError).toBe(100);
  const preferences = {
    personalize: true,
    shareWithAi: false,
    preferred: "any" as const,
  };
  state.settings.growth = preferences;
  const input = {
    mode: "profile" as const,
    text: "总结近期表现",
    taskId: null,
    goalId: null,
    timezone: "Asia/Shanghai",
    allowReplan: false,
    includeReviews: false,
  };
  expect(buildCoachContext(state, input).growth).toBeNull();
  state.settings.growth = { ...preferences, shareWithAi: true };
  expect(buildCoachContext(state, input).growth?.days).toBe(7);
});
it("rejects circular dependencies", () => {
  const state = seed();
  state.tasks[0].execution = { dependencies: ["t2"] };
  state.tasks[1].execution = { dependencies: ["t1"] };
  expect(() => validateWorkspace(state)).toThrow(/循环/);
});
