import { stateSchema, localDate, type AppState } from "../core/model";
import type { DeltaRequest } from "./delta";
export type Account = { id: string; email: string };
export type UpdateWorkspace = (
  change: (state: AppState) => AppState,
  options?: { removeGoalsWithTasks?: string[] },
) => Promise<boolean>;
export class CloudError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function loadCloud(account: Account): Promise<AppState> {
  const response = await fetch(`/api/workspace?today=${localDate()}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
    headers: { "x-flowday-account": account.id },
  });
  const result = await response.json();
  if (!response.ok)
    throw new CloudError(response.status, result.error || "读取云端数据失败。");
  return stateSchema.parse(result.state);
}
export async function patchCloud(account: Account, pending: DeltaRequest) {
  const response = await fetch("/api/workspace", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-flowday-account": account.id,
    },
    body: JSON.stringify(pending),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new CloudError(response.status, result.error || "保存未确认成功。");
  if (
    !Number.isSafeInteger(result.revision) ||
    !Number.isSafeInteger(result.savedRevision)
  )
    throw new Error("云端未返回可确认的保存回执。");
  return result as { revision: number; savedRevision: number };
}

export type CloudAccess = {
  plan: "free" | "pro";
  aiPerMinute: number;
  aiPerDay: number;
  advancedGrowth: boolean;
  personalization: boolean;
  aiEnabled: boolean;
  usedToday: number;
  providerCallsToday: number;
  inputTokensToday: number;
  outputTokensToday: number;
  estimatedCostToday: number | null;
  unknownUsageToday: number;
  accountDeletion: boolean;
};
export type HistoryPage<T> = {
  items: T[];
  next: { afterId: string; afterAt?: string } | null;
};
export async function cloudData<T>(
  account: Account,
  parameters: Record<string, string>,
) {
  const response = await fetch(
    `/api/workspace/data?${new URLSearchParams(parameters)}`,
    {
      headers: { "x-flowday-account": account.id },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new CloudError(response.status, result.error || "读取云端数据失败。");
  return result as T;
}
export function importComparable(state: AppState) {
  return {
    ...state,
    executionVersion: 1 as const,
    executionLog: state.executionLog ?? [],
  };
}
export async function saveCloud(
  account: Account,
  state: AppState,
  importLocal = false,
) {
  const body = JSON.stringify({
    state,
    expectedRevision: state.revision,
    mutationId: crypto.randomUUID(),
    importLocal,
  });
  // Retry the exact same mutation once; DB receipt prevents duplicate commits.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch("/api/workspace", {
        method: "PUT",
        signal: AbortSignal.timeout(25000),
        headers: {
          "Content-Type": "application/json",
          "x-flowday-account": account.id,
        },
        body,
      });
      const result = await response.json();
      if (!response.ok)
        throw new CloudError(
          response.status,
          result.error || "保存未确认成功。",
        );
      return { ...result, state: stateSchema.parse(result.state) as AppState };
    } catch (e) {
      if (e instanceof CloudError && e.status < 500) throw e;
      if (attempt === 1) throw e;
    }
  }
  throw new Error("保存未确认成功。");
}
export function downloadBackup(contents: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([contents], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
