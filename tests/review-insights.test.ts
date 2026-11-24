import { describe, it, expect } from "vitest";
import {
  seedState,
  stateSchema,
  type DoodleStroke,
} from "../src/modules/core/model";
import { completionTrend } from "../src/modules/core/insights";
const stroke: DoodleStroke = {
  color: "#467d5d",
  size: 5,
  points: [
    [0, 0],
    [500, 300],
    [1000, 600],
  ],
};
describe("review compatibility and drawing persistence", () => {
  it("reads old text-only reviews without data migration", () => {
    const state = seedState();
    state.reviews = [{ date: "2026-11-18", text: "旧记录", mood: 2 }];
    expect(stateSchema.parse(state).reviews[0].drawing).toBeUndefined();
  });
  it("round trips vector drawings alongside historical text and mood", () => {
    const state = seedState();
    state.reviews = [
      { date: "2026-11-18", text: "昨天", mood: 1, drawing: [stroke] },
      { date: "2026-11-19", text: "今天", mood: 3, drawing: [] },
    ];
    expect(
      stateSchema.parse(JSON.parse(JSON.stringify(state))).reviews,
    ).toEqual(state.reviews);
  });
  it("rejects oversized or unsafe drawing data", () => {
    const s = seedState();
    s.reviews = [
      {
        date: "2026-11-19",
        text: "",
        mood: 2,
        drawing: Array(41).fill(stroke),
      },
    ];
    expect(stateSchema.safeParse(s).success).toBe(false);
    s.reviews[0].drawing = [{ ...stroke, points: [[1001, 0]] }];
    expect(stateSchema.safeParse(s).success).toBe(false);
    s.reviews[0].drawing = [{ ...stroke, points: Array(201).fill([10, 10]) }];
    expect(stateSchema.safeParse(s).success).toBe(false);
  });
});
describe("completion trend windows", () => {
  it("returns exactly 30 local dates including today across months", () => {
    const data = completionTrend([], "2026-11-19", 30);
    expect(data).toHaveLength(30);
    expect(data[0].date).toBe("2026-10-21");
    expect(data.at(-1)?.date).toBe("2026-11-19");
    expect(data.every((d) => d.count === 0)).toBe(true);
  });
  it("counts actual completion dates instead of planned dates", () => {
    const task = {
      ...seedState().tasks[0],
      status: "done" as const,
      date: "2026-12-01",
      completedAt: new Date(2026, 10, 18, 12).toISOString(),
    };
    const data = completionTrend([task], "2026-11-19", 7);
    expect(data.find((d) => d.date === "2026-11-18")?.count).toBe(1);
    expect(data.at(-1)?.count).toBe(0);
  });
  it("excludes reopened, invalid and out-of-window records", () => {
    const task = seedState().tasks[0];
    const tasks = [
      {
        ...task,
        status: "todo" as const,
        completedAt: new Date(2026, 10, 19, 12).toISOString(),
      },
      { ...task, id: "bad", status: "done" as const, completedAt: "invalid" },
      {
        ...task,
        id: "old",
        status: "done" as const,
        completedAt: new Date(2026, 8, 1, 12).toISOString(),
      },
    ];
    expect(
      completionTrend(tasks, "2026-11-19", 30).reduce((s, d) => s + d.count, 0),
    ).toBe(0);
  });
});
