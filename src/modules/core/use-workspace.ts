"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AppState, localDate, seedState } from "./model";
import { LocalWorkspaceRepository, STORAGE_KEY } from "./repository";
import { recordPlanChanges } from "./execution";
import { validateExecutionData } from "./execution-validation";
import {
  type Account,
  CloudError,
  loadCloud,
  patchCloud,
  saveCloud,
} from "../cloud/client";
import {
  deltaEnvelope,
  mergeWorkspaceDelta,
  workspaceDelta,
  type DeltaRequest,
} from "../cloud/delta";

export function useWorkspace(account?: Account) {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const uncertain = useRef(false);
  const pendingRef = useRef<DeltaRequest | null>(null);
  const [pending, setPending] = useState<DeltaRequest | null>(null);
  const [conflict, setConflict] = useState(false);
  const [online, setOnline] = useState(true);
  const [syncIssue, setSyncIssue] = useState(false);
  const pendingKey = account ? `flowday.pending.${account.id}` : "";
  const current = useRef<AppState | null>(null);
  const apply = useCallback((next: AppState) => {
    current.current = next;
    setState(next);
  }, []);
  const remember = useCallback(
    (operation: DeltaRequest | null) => {
      pendingRef.current = operation;
      setPending(operation);
      if (!pendingKey) return;
      try {
        if (operation)
          sessionStorage.setItem(pendingKey, JSON.stringify(operation));
        else sessionStorage.removeItem(pendingKey);
      } catch {
        /* Keep the pending operation in memory if tab storage is unavailable. */
      }
    },
    [pendingKey],
  );
  useEffect(() => {
    setOnline(navigator.onLine);
    function status() {
      setOnline(navigator.onLine);
    }
    window.addEventListener("online", status);
    window.addEventListener("offline", status);
    return () => {
      window.removeEventListener("online", status);
      window.removeEventListener("offline", status);
    };
  }, []);
  useEffect(() => {
    if (!saving && previousFocus.current) {
      const element = previousFocus.current;
      const frame = requestAnimationFrame(() => {
        if (element.isConnected) element.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [saving]);
  useEffect(() => {
    let active = true;
    if (pendingKey) {
      try {
        const operation = deltaEnvelope.safeParse(
          JSON.parse(sessionStorage.getItem(pendingKey) ?? "null"),
        );
        if (operation.success) remember(operation.data);
      } catch {
        /* Ignore unreadable draft metadata. */
      }
    }
    (async () => {
      try {
        const repo = new LocalWorkspaceRepository();
        const next = account
          ? await loadCloud(account)
          : (repo.load() ?? repo.save(seedState(), 0));
        if (active) apply(next);
      } catch (e) {
        if (active)
          setError(
            e instanceof Error
              ? e.message
              : "数据无法读取。请保留浏览器原始数据，不要清除存储。",
          );
      } finally {
        if (active) setReady(true);
      }
    })();
    const sync = (event: StorageEvent) => {
      if (!account && event.key === STORAGE_KEY) {
        try {
          const next = new LocalWorkspaceRepository().load();
          if (next) apply(next);
          setError(
            next
              ? "其他标签页的更改已同步。"
              : "其他标签页删除了本地数据。请导出当前数据并刷新，避免意外覆盖。",
          );
          if (!next) uncertain.current = true;
        } catch {
          setError("同步失败，请保留草稿后刷新。");
          uncertain.current = true;
        }
      }
    };
    window.addEventListener("storage", sync);
    return () => {
      active = false;
      window.removeEventListener("storage", sync);
    };
  }, [account, apply, pendingKey, remember]);
  useEffect(() => {
    if (!account) return;
    let active = true,
      running = false,
      lastDay = localDate();
    async function synchronize() {
      if (
        !active ||
        running ||
        busy.current ||
        pendingRef.current ||
        document.hidden ||
        !navigator.onLine
      )
        return;
      const base = current.current;
      if (!base) return;
      running = true;
      try {
        const next = await loadCloud(account!);
        if (active) setSyncIssue(false);
        if (
          active &&
          !busy.current &&
          !pendingRef.current &&
          current.current === base &&
          (next.revision > base.revision || lastDay !== localDate())
        ) {
          lastDay = localDate();
          apply(next);
        }
      } catch {
        if (active) setSyncIssue(true);
      } finally {
        running = false;
      }
    }
    window.addEventListener("focus", synchronize);
    window.addEventListener("online", synchronize);
    document.addEventListener("visibilitychange", synchronize);
    const timer = window.setInterval(synchronize, 30000);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", synchronize);
      window.removeEventListener("online", synchronize);
      document.removeEventListener("visibilitychange", synchronize);
    };
  }, [account, apply]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (busy.current || pendingRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const refresh = useCallback(async () => {
    if (!account || busy.current || pendingRef.current) return false;
    previousFocus.current = document.activeElement as HTMLElement;
    busy.current = true;
    setSaving(true);
    try {
      apply(await loadCloud(account));
      setSyncIssue(false);
      uncertain.current = false;
      setError("");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "同步失败，请重试。");
      return false;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [account, apply]);
  const savePending = useCallback(
    async (operation: DeltaRequest, next?: AppState) => {
      if (!account) return false;
      remember(operation);
      try {
        const receipt = await patchCloud(account, operation);
        const original = current.current;
        const saved =
          original?.revision === operation.revision &&
          receipt.revision === receipt.savedRevision
            ? {
                ...(next ?? mergeWorkspaceDelta(original, operation.changes)),
                revision: receipt.revision,
              }
            : await loadCloud(account);
        apply(saved);
        setSyncIssue(false);
        remember(null);
        setConflict(false);
        setError("");
        return true;
      } catch (error) {
        const clientError = error instanceof CloudError ? error : null;
        setConflict(clientError?.status === 409);
        if (clientError && [400, 403, 413, 415].includes(clientError.status))
          remember(null);
        setError(
          clientError?.message ??
            "连接中断，无法确认保存。更改保留在此标签页，可重新提交同一笔保存。",
        );
        return false;
      }
    },
    [account, apply, remember],
  );
  const retry = useCallback(async () => {
    if (!pendingRef.current || busy.current) return false;
    busy.current = true;
    setSaving(true);
    try {
      return await savePending(pendingRef.current);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [savePending]);
  const discardPending = useCallback(() => {
    if (busy.current) return;
    remember(null);
    setConflict(false);
    setError("");
  }, [remember]);
  const hydrate = useCallback(
    (patch: Pick<Partial<AppState>, "tasks" | "reviews">, revision: number) => {
      const source = current.current;
      if (
        !source ||
        source.revision !== revision ||
        busy.current ||
        pendingRef.current
      )
        return false;
      const next = { ...source };
      if (patch.tasks)
        next.tasks = [
          ...new Map(
            [...source.tasks, ...patch.tasks].map((row) => [row.id, row]),
          ).values(),
        ];
      if (patch.reviews)
        next.reviews = [
          ...new Map(
            [...source.reviews, ...patch.reviews].map((row) => [row.date, row]),
          ).values(),
        ];
      apply(next);
      return true;
    },
    [apply],
  );
  const update = useCallback(
    async (
      change: (s: AppState) => AppState,
      options?: { removeGoalsWithTasks?: string[] },
    ) => {
      if (!state || busy.current) {
        setError("正在保存，请稍候再操作。");
        return false;
      }
      if (uncertain.current) {
        setError("上次保存结果尚未确认。请先重新同步，防止重复写入。");
        return false;
      }
      if (pendingRef.current) {
        setError("上一笔保存尚未确认，请先重试或导出待保存变更。");
        return false;
      }
      if (current.current?.revision !== state.revision) {
        setError("数据已更新，请重新操作。");
        return false;
      }
      previousFocus.current = document.activeElement as HTMLElement;
      busy.current = true;
      setSaving(true);
      try {
        const changed = recordPlanChanges(
          state,
          change(structuredClone(state)),
        );
        changed.executionVersion = 1;
        validateExecutionData(changed);
        if (account) {
          const changes = workspaceDelta(state, changed);
          if (options?.removeGoalsWithTasks?.length)
            changes.removeGoalsWithTasks = options.removeGoalsWithTasks;
          if (!Object.values(changes).some((value) => value !== undefined))
            return true;
          return await savePending(
            {
              revision: state.revision,
              mutationId: crypto.randomUUID(),
              changes,
            },
            changed,
          );
        }
        const next = new LocalWorkspaceRepository().save(
          changed,
          state.revision,
        );
        apply(next);
        setError("");
        return true;
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "保存未成功，请保留草稿后重试。",
        );
        return false;
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [state, account, apply, savePending],
  );
  const importLocal = useCallback(
    async (source: AppState) => {
      if (!account || !current.current || busy.current || pendingRef.current)
        throw new Error("请等待当前保存完成。");
      previousFocus.current = document.activeElement as HTMLElement;
      busy.current = true;
      setSaving(true);
      try {
        const result = await saveCloud(
          account,
          { ...source, revision: current.current.revision },
          true,
        );
        apply(await loadCloud(account).catch(() => result.state));
        uncertain.current = false;
        setError("");
        return result;
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [account, apply],
  );
  return {
    state,
    update,
    error,
    setError,
    ready,
    saving,
    refresh,
    importLocal,
    pending,
    conflict,
    online,
    syncIssue,
    retry,
    discardPending,
    hydrate,
  };
}
