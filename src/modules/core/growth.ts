import { addDays } from "../planning/calendar";
import {
  availableMinutes,
  dayAvailability,
  planningRatio,
} from "../planning/availability";
import { growthDefaults, isPending } from "./execution";
import {
  localDate,
  taskKinds,
  type AppState,
  type ExecutionEntry,
  type Task,
} from "./model";

const minimumSamples = 5;
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}
function measured(entry: ExecutionEntry) {
  return (
    entry.type === "complete" &&
    entry.completeCoverage &&
    !!sampleFocus(entry) &&
    !!entry.estimate
  );
}
function sampleFocus(entry: ExecutionEntry) {
  return entry.sampleFocusSeconds ?? entry.focusSeconds ?? 0;
}
export function estimateFor(
  state: AppState,
  task: Pick<Task, "id" | "minutes" | "execution">,
  now = new Date(),
) {
  if (
    !task.execution?.kind ||
    !(state.settings.growth ?? growthDefaults).personalize
  )
    return null;
  const since = now.getTime() - 90 * 86400000;
  const matching = new Map<string, ExecutionEntry>();
  for (const entry of state.executionLog ?? []) {
    if (
      entry.taskId !== task.id &&
      entry.kind === task.execution.kind &&
      measured(entry) &&
      entry.estimate! >= task.minutes / 2 &&
      entry.estimate! <= task.minutes * 2 &&
      Date.parse(entry.at) >= since &&
      Date.parse(entry.at) <= now.getTime()
    )
      matching.set(entry.taskId, entry);
  }
  const samples = [...matching.values()];
  if (samples.length < minimumSamples) return null;
  const ratio = median(samples.map((e) => sampleFocus(e) / 60 / e.estimate!));
  const raw = median(samples.map((e) => sampleFocus(e) / 60));
  const minutes = Math.min(480, Math.max(5, Math.round(raw / 5) * 5));
  return {
    minutes,
    samples: samples.length,
    ratio,
    typicalMinutes: Math.round(raw),
  };
}

export function growthReport(
  state: AppState,
  days: 1 | 7 | 30 | 90,
  end = localDate(),
  timezone?: string,
  settlementDay = end,
) {
  const formatter = timezone
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
      })
    : null;
  function clock(at: string) {
    const instant = new Date(at);
    if (!formatter)
      return { date: localDate(instant), hour: instant.getHours() };
    const bits = formatter.formatToParts(instant);
    const part = (key: string) => bits.find((bit) => bit.type === key)?.value;
    return {
      date: `${part("year")}-${part("month")}-${part("day")}`,
      hour: Number(part("hour")),
    };
  }
  const log = (state.executionLog ?? []).map((e) => ({ ...e, ...clock(e.at) }));
  const old = state.events.map((e) => ({ ...e, date: clock(e.at).date }));
  function summarize(last: string) {
    const first = addDays(last, 1 - days);
    const inside = (day: string) => day >= first && day <= last;
    const entries = log.filter((e) => inside(e.date));
    const events = old.filter((e) => inside(e.date));
    const completions = events.filter((e) => e.type === "complete");
    const focused = events.filter((e) => e.type === "focus");
    const latestSamples = new Map<string, ExecutionEntry & { hour: number }>();
    entries.filter(measured).forEach((e) => latestSamples.set(e.taskId, e));
    const samples = [...latestSamples.values()];
    const plan = log.filter(
      (e) =>
        e.type === "commit" && e.to && inside(e.to) && e.to < settlementDay,
    );
    const doneByDay = new Set(
      old
        .filter((e) => e.type === "complete")
        .map((e) => JSON.stringify([e.taskId, e.date])),
    );
    const matched = plan.filter((e) =>
      doneByDay.has(JSON.stringify([e.taskId, e.to])),
    ).length;
    const estimates = samples.map(
      (e) => Math.abs(sampleFocus(e) / 60 - e.estimate!) / e.estimate!,
    );
    const categories = Object.entries(taskKinds).map(([kind, label]) => {
      const group = samples.filter((e) => e.kind === kind);
      return {
        kind,
        label,
        samples: group.length,
        typicalMinutes:
          group.length >= minimumSamples
            ? Math.round(median(group.map((e) => sampleFocus(e) / 60)))
            : null,
        delays: entries.filter((e) => e.type === "defer" && e.kind === kind)
          .length,
        completed: entries.filter(
          (e) => e.type === "complete" && e.kind === kind,
        ).length,
      };
    });
    const periods = [
      { label: "上午", start: 0, end: 12 },
      { label: "下午", start: 12, end: 18 },
      { label: "晚上", start: 18, end: 24 },
    ].map((period) => ({
      label: period.label,
      completed: completions.filter((e) => {
        const hour = clock(e.at).hour;
        return hour >= period.start && hour < period.end;
      }).length,
      focusMinutes: Math.round(
        focused
          .filter((e) => {
            const hour = clock(e.at).hour;
            return hour >= period.start && hour < period.end;
          })
          .reduce((sum, e) => sum + (e.seconds ?? 0), 0) / 60,
      ),
    }));
    return {
      first,
      last,
      completed: completions.length,
      activeDays: new Set(
        [...completions, ...focused.filter((e) => (e.seconds ?? 0) > 0)].map(
          (e) => e.date,
        ),
      ).size,
      focusMinutes: Math.round(
        focused.reduce((sum, e) => sum + (e.seconds ?? 0), 0) / 60,
      ),
      elapsedMinutes: Math.round(
        entries.reduce((sum, e) => sum + (e.elapsedSeconds ?? 0), 0) / 60,
      ),
      postponements: entries.filter((e) => e.type === "defer").length,
      pauses: entries.filter((e) => e.type === "pause").length,
      samples: samples.length,
      estimateError:
        samples.length >= minimumSamples
          ? Math.round(median(estimates) * 100)
          : null,
      planned: plan.length,
      matched,
      categories,
      periods,
    };
  }
  const current = summarize(end);
  const previous = summarize(addDays(end, -days));
  const preference = state.settings.growth ?? growthDefaults;
  return {
    current,
    previous,
    suggestions: preference.personalize ? growthRecommendations(current) : [],
    preference: preference.preferred,
  };
}
export type GrowthPeriod = {
  first: string;
  last: string;
  completed: number;
  activeDays: number;
  focusMinutes: number;
  elapsedMinutes: number;
  postponements: number;
  pauses: number;
  samples: number;
  estimateError: number | null;
  planned: number;
  matched: number;
  categories: {
    kind: string;
    label: string;
    samples: number;
    typicalMinutes: number | null;
    delays: number;
    completed: number;
  }[];
  periods: { label: string; completed: number; focusMinutes: number }[];
};
export type GrowthComparison = {
  current: GrowthPeriod;
  previous: GrowthPeriod;
};
export function growthRecommendations(
  current: Pick<
    GrowthPeriod,
    | "periods"
    | "completed"
    | "planned"
    | "matched"
    | "categories"
    | "estimateError"
    | "samples"
  >,
) {
  const most = [...current.periods].sort((a, b) => b.completed - a.completed);
  const suggestions: string[] = [];
  if (current.completed >= 8 && most[0].completed > most[1].completed)
    suggestions.push(
      `本期 ${most[0].label}完成记录最多（${most[0].completed}/${current.completed}）。可以试着把一项重要任务放在这个时段，观察效果。这里按完成时间分组，只表示分布。`,
    );
  if (current.planned >= 5 && current.matched / current.planned < 0.6)
    suggestions.push(
      `本期有 ${current.planned} 项到期的已预约任务，其中 ${current.matched} 项在预约日完成。可以减少每日安排或拆出可独立完成的小步骤。`,
    );
  const category = current.categories.find((c) => c.delays >= 3);
  if (category)
    suggestions.push(
      `${category.label}类记录了 ${category.delays} 次向后改期。可以回看是否与依赖、时间不足或任务过大有关。`,
    );
  if (current.estimateError !== null && current.estimateError >= 30)
    suggestions.push(
      `有 ${current.samples} 项完整计时样本，估时与记录专注时长的典型差距为 ${current.estimateError}%。下次先核对同类任务的建议估时。`,
    );

  return suggestions;
}

export function loadForDay(state: AppState, day: string, now = new Date()) {
  const parents = new Set(
    state.tasks.flatMap((t) =>
      t.execution?.parentId ? [t.execution.parentId] : [],
    ),
  );
  const dayBlocks = state.blocks.filter((b) => b.date === day);
  const tasks = state.tasks.filter(
    (t) =>
      isPending(t) &&
      !parents.has(t.id) &&
      (t.date === day || dayBlocks.some((b) => b.taskId === t.id)),
  );
  const available = availableMinutes(state, day, now);
  const safeBudget = Math.floor(available * planningRatio(state));
  const minute =
    day === localDate(now) ? now.getHours() * 60 + now.getMinutes() : 0;
  const requested = tasks.reduce((sum, t) => {
    const segments = state.blocks.filter((b) => b.taskId === t.id);
    const active =
      state.session?.taskId === t.id
        ? state.session.accumulated +
          (state.session.running
            ? Math.max(0, now.getTime() - state.session.startedAt) / 1000
            : 0)
        : 0;
    const reserved = segments
      .filter((b) => b.date === day && b.end > minute)
      .reduce((n, b) => n + b.end - Math.max(b.start, minute), 0);
    if (segments.length <= 1)
      return (
        sum +
        (reserved ||
          (t.date === day
            ? Math.max(5, t.minutes - Math.floor(active / 60))
            : 0))
      );
    const alreadyPlanned = segments.reduce((n, b) => n + b.end - b.start, 0);
    return (
      sum +
      reserved +
      (t.date === day
        ? Math.max(0, t.minutes - alreadyPlanned - Math.floor(active / 60))
        : 0)
    );
  }, 0);
  return {
    requested,
    available,
    safeBudget,
    high: tasks.filter((t) => t.priority === "high").length,
    over: Math.max(0, requested - safeBudget),
    capacity: dayAvailability(state, day).capacity,
  };
}
