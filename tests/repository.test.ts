import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  LocalWorkspaceRepository,
  STORAGE_KEY,
} from "../src/modules/core/repository";
import { seedState, stateSchema } from "../src/modules/core/model";
describe("local repository", () => {
  beforeEach(() => {
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => map.set(key, value),
    });
  });
  it("round trips data with an incremented revision", () => {
    const repo = new LocalWorkspaceRepository();
    const saved = repo.save(seedState(), 0);
    expect(saved.revision).toBe(1);
    expect(repo.load()).toEqual(saved);
  });
  it("rejects a stale write instead of overwriting newer changes", () => {
    const repo = new LocalWorkspaceRepository();
    repo.save(seedState(), 0);
    expect(() => repo.save(seedState(), 0)).toThrow("其他标签页");
  });
  it("does not silently replace corrupted data", () => {
    localStorage.setItem(STORAGE_KEY, "bad JSON");
    expect(() => new LocalWorkspaceRepository().load()).toThrow();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("bad JSON");
  });
  it("rejects invalid durations and wrong schema versions", () => {
    const state = seedState();
    state.tasks[0].minutes = -10;
    expect(stateSchema.safeParse(state).success).toBe(false);
    expect(
      stateSchema.safeParse({ ...seedState(), schemaVersion: 3 }).success,
    ).toBe(false);
  });
});
