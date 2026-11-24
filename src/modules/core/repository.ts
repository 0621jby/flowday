import { stateSchema, type AppState } from "./model";
export const STORAGE_KEY = "flowday.workspace.v1";
export interface WorkspaceRepository {
  load(): AppState | null;
  save(state: AppState, expectedRevision: number): AppState;
}
export class LocalWorkspaceRepository implements WorkspaceRepository {
  load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return stateSchema.parse(JSON.parse(raw));
  }
  save(state: AppState, expectedRevision: number) {
    const current = this.load();
    if (current && current.revision !== expectedRevision)
      throw new Error("其他标签页更新了数据，请刷新后重试。");
    const next = stateSchema.parse({
      ...state,
      revision: expectedRevision + 1,
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }
}
