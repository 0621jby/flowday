import { describe, it, expect } from "vitest";
import { schedule } from "../src/modules/planning/scheduler";
import { seedState } from "../src/modules/core/model";
describe("deterministic scheduler", () => {
  it("preserves hard invariants for 1000 seeded randomized days", () => {
    let seed = 12345;
    const random = () =>
      (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const base = seedState().tasks[0];
    for (let day = 0; day < 1000; day++) {
      const tasks = Array.from(
        { length: 1 + Math.floor(random() * 20) },
        (_, index) => ({
          ...base,
          id: `random-${index}`,
          minutes: 5 + Math.floor(random() * 48) * 5,
        }),
      );
      const now = Math.floor(random() * 1440);
      const result = schedule(
        tasks,
        [
          { start: 540, end: 720 },
          { start: 780, end: 1080 },
        ],
        240,
        now,
      );
      expect(result.used).toBeLessThanOrEqual(result.budget);
      const ordered = [...result.blocks].sort((a, b) => a.start - b.start);
      for (let i = 0; i < ordered.length; i++) {
        const b = ordered[i];
        expect(b.start).toBeGreaterThanOrEqual(now);
        expect(
          (b.start >= 540 && b.end <= 720) || (b.start >= 780 && b.end <= 1080),
        ).toBe(true);
        if (i) expect(b.start).toBeGreaterThanOrEqual(ordered[i - 1].end);
      }
      expect(new Set(result.blocks.map((b) => b.taskId)).size).toBe(
        result.blocks.length,
      );
    }
  });
  it("preserves capacity and never overlaps", () => {
    const result = schedule(
      seedState().tasks,
      [{ start: 540, end: 1080 }],
      240,
    );
    expect(result.used).toBeLessThanOrEqual(192);
    for (let i = 1; i < result.blocks.length; i++)
      expect(result.blocks[i].start).toBeGreaterThanOrEqual(
        result.blocks[i - 1].end,
      );
  });
  it("does not split a two-hour task into one hour", () => {
    const t = { ...seedState().tasks[0], minutes: 120 };
    expect(schedule([t], [{ start: 540, end: 600 }], 240).blocks).toHaveLength(
      0,
    );
  });
  it("does not schedule in the past or completed tasks", () => {
    const tasks = seedState().tasks;
    tasks[0].status = "done";
    const result = schedule(tasks, [{ start: 540, end: 1080 }], 240, 721);
    expect(
      result.blocks.every((b) => b.start >= 725 && b.taskId !== tasks[0].id),
    ).toBe(true);
  });
  it("merges overlapping availability and stays deterministic", () => {
    const t = seedState().tasks;
    const w = [
      { start: 540, end: 660 },
      { start: 600, end: 720 },
    ];
    expect(schedule(t, w, 240)).toEqual(schedule(t, w, 240));
    const r = schedule(t, w, 240);
    expect(r.budget).toBe(180);
  });
  it("handles no availability", () =>
    expect(schedule(seedState().tasks, [], 240).blocks).toHaveLength(0));
});
