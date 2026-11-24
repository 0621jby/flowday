import { describe, it, expect } from "vitest";
import { seedState, stateSchema } from "../src/modules/core/model";
import {
  addDays,
  weekDays,
  monthDays,
  shiftMonth,
  parseDay,
  applyCalendarChange,
  fillDay,
  undoCalendar,
} from "../src/modules/planning/calendar";
const now = new Date(2026, 10, 19, 8, 0);
const date = "2026-11-20";
function initial() {
  const state = seedState();
  state.tasks = state.tasks.map((t) => ({ ...t, date }));
  return state;
}
function placed() {
  return applyCalendarChange(
    initial(),
    { type: "schedule", taskId: "t1", date, start: 540, end: 600 },
    now,
  );
}
describe("calendar commands", () => {
  it("handles month/year/leap boundaries without UTC date drift", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekDays("2026-11-19")).toEqual([
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-21",
      "2026-11-22",
    ]);
    expect(monthDays(date)).toHaveLength(42);
    expect(shiftMonth("2026-01-31", 1)).toBe("2026-02-01");
    expect(() => parseDay("2026-02-30")).toThrow();
  });
  it("moves dates and preserves scheduled times", () => {
    const s = placed();
    const n = applyCalendarChange(
      s,
      { type: "date", taskId: "t1", date: "2026-12-20" },
      now,
    );
    expect(n.tasks[0].date).toBe("2026-12-20");
    expect(n.blocks[0]).toMatchObject({
      date: "2026-12-20",
      start: 540,
      end: 600,
    });
    expect(s.blocks[0].date).toBe(date);
  });
  it("date-only task does not fabricate a time block", () => {
    const n = applyCalendarChange(
      initial(),
      { type: "date", taskId: "t1", date: "2026-12-01" },
      now,
    );
    expect(n.blocks).toEqual([]);
  });
  it("resizing updates reserved time without rewriting the estimate", () => {
    const n = applyCalendarChange(
      placed(),
      { type: "schedule", taskId: "t1", date, start: 540, end: 630 },
      now,
    );
    expect(n.blocks).toHaveLength(1);
    expect(n.tasks[0].minutes).toBe(45);
    expect(n.tasks[0].status).toBe("todo");
    expect(n.blocks[0].end).toBe(630);
  });
  it("rejects overlap without mutating state but permits adjacent blocks", () => {
    const s = placed();
    const original = JSON.stringify(s);
    expect(() =>
      applyCalendarChange(
        s,
        { type: "schedule", taskId: "t2", date, start: 585, end: 645 },
        now,
      ),
    ).toThrow("冲突");
    expect(JSON.stringify(s)).toBe(original);
    expect(
      applyCalendarChange(
        s,
        { type: "schedule", taskId: "t2", date, start: 600, end: 660 },
        now,
      ).blocks,
    ).toHaveLength(2);
  });
  it("protects locked blocks, including month date moves and removal", () => {
    const s = applyCalendarChange(
      placed(),
      { type: "lock", taskId: "t1", locked: true },
      now,
    );
    expect(() =>
      applyCalendarChange(
        s,
        { type: "date", taskId: "t1", date: "2026-11-21" },
        now,
      ),
    ).toThrow("锁定");
    expect(() =>
      applyCalendarChange(s, { type: "unschedule", taskId: "t1" }, now),
    ).toThrow("锁定");
    expect(
      applyCalendarChange(s, { type: "lock", taskId: "t1", locked: false }, now)
        .blocks[0].locked,
    ).toBe(false);
  });
  it("protects active and completed tasks", () => {
    const s = placed();
    s.session = { taskId: "t1", startedAt: 0, running: true, accumulated: 0 };
    expect(() =>
      applyCalendarChange(s, { type: "unschedule", taskId: "t1" }, now),
    ).toThrow("专注");
    s.session = null;
    s.tasks[0].status = "done";
    expect(() =>
      applyCalendarChange(s, { type: "date", taskId: "t1", date }, now),
    ).toThrow("已完成");
  });
  it("rejects past dates, past times, out-of-hours and invalid durations", () => {
    for (const [day, start, end] of [
      ["2026-11-18", 540, 600],
      ["2026-11-19", 420, 480],
      [date, 480, 540],
      [date, 540, 541],
      [date, 1000, 1500],
    ] as const) {
      expect(() =>
        applyCalendarChange(
          initial(),
          { type: "schedule", taskId: "t1", date: day, start, end },
          now,
        ),
      ).toThrow();
    }
  });
  it("enforces daily capacity", () => {
    const s = placed();
    s.settings.capacity = 90;
    expect(() =>
      applyCalendarChange(
        s,
        { type: "schedule", taskId: "t2", date, start: 600, end: 660 },
        now,
      ),
    ).toThrow("每日可用");
  });
  it("unscheduling preserves task and date", () => {
    const n = applyCalendarChange(
      placed(),
      { type: "unschedule", taskId: "t1" },
      now,
    );
    expect(n.blocks).toHaveLength(0);
    expect(n.tasks[0].date).toBe(date);
    expect(n.tasks).toHaveLength(4);
  });
  it("auto-fills holes and preserves all existing blocks", () => {
    const s = placed();
    const result = fillDay(s, date, now);
    expect(
      result.blocks.every(
        (b) => b.taskId !== "t1" && (b.end <= 540 || b.start >= 600),
      ),
    ).toBe(true);
    let next = s;
    for (const b of result.blocks)
      next = applyCalendarChange(next, { type: "schedule", ...b, date }, now);
    expect(next.blocks.find((b) => b.taskId === "t1")).toEqual(s.blocks[0]);
    expect(result.used + 60).toBeLessThanOrEqual(192);
  });
  it("supports undo only if no intervening edits occurred", () => {
    const before = initial();
    const after = { ...placed(), revision: 1 };
    expect(undoCalendar(after, before, 1, now).blocks).toHaveLength(0);
    expect(() =>
      undoCalendar({ ...after, revision: 2 }, before, 1, now),
    ).toThrow("其他更改");
  });
  it("reads previous local records without the optional lock field", () => {
    const s = placed();
    delete s.blocks[0].locked;
    expect(stateSchema.safeParse(s).success).toBe(true);
  });
  it("never resurrects an expired block on undo", () => {
    const before = placed();
    const after = applyCalendarChange(
      before,
      { type: "date", taskId: "t1", date: "2026-11-21" },
      now,
    );
    after.revision = 1;
    expect(() =>
      undoCalendar(after, before, 1, new Date(2026, 10, 20, 10)),
    ).toThrow("过去");
  });
});
