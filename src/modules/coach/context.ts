import type { AppState } from "../core/model";
import { addDays } from "../planning/calendar";
import type { CoachInput } from "./schema";
import {
  growthRecommendations,
  growthReport,
  loadForDay,
  type GrowthComparison,
} from "../core/growth";
import { isPending } from "../core/execution";
import { reportWindow } from "./guidance";

export function coachClock(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (key: string) => parts.find((p) => p.type === key)!.value;
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  const wall = new Date(`${day}T${get("hour")}:${get("minute")}:59`);
  return { day, minute, wall };
}
export function executionProfile(state: AppState, day: string, days = 30) {
  const since = addDays(day, 1 - days);
  const events = state.events.filter(
    (e) => e.at.slice(0, 10) >= since && e.at.slice(0, 10) <= day,
  );
  const focus = events.filter((e) => e.type === "focus");
  const completed = state.tasks.filter(
    (t) =>
      t.status === "done" &&
      t.completedAt &&
      t.completedAt.slice(0, 10) >= since &&
      t.completedAt.slice(0, 10) <= day,
  );
  const compared = completed
    .map((t) => ({
      estimated: t.minutes,
      recorded:
        focus
          .filter((e) => e.taskId === t.id)
          .reduce((n, e) => n + (e.seconds ?? 0), 0) / 60,
    }))
    .filter((t) => t.recorded > 0);
  return {
    window: `最近 ${days} 天（事件按 UTC 日期统计）`,
    completedTasks: completed.length,
    recordedFocusMinutes: Math.floor(
      focus.reduce((n, e) => n + (e.seconds ?? 0), 0) / 60,
    ),
    comparisonSamples: compared.length,
    recordedToEstimatedRatio:
      compared.length >= 5
        ? Math.round(
            (compared.reduce((n, t) => n + t.recorded, 0) /
              compared.reduce((n, t) => n + t.estimated, 0)) *
              100,
          ) / 100
        : null,
    currentlyOverdueTasks: state.tasks.filter(
      (t) => isPending(t) && t.date && t.date < day,
    ).length,
    reviewDays: state.reviews.filter((r) => r.date >= since && r.date <= day)
      .length,
    limitations: [
      "专注片段不等于完整实际耗时，不能据此判断工作效率。",
      "当前只知道已过计划日期的任务数，没有完整改期历史，不能推断拖延次数。",
      compared.length < 5
        ? "完成且含专注记录的样本少于5项，暂不足以判断估时偏差或个人习惯。"
        : "估时对比仅为有记录的样本描述，不代表因果或稳定习惯。",
    ],
  };
}

export function coachGrowthReport(
  report: GrowthComparison,
  selection: ReturnType<typeof reportWindow>,
  personalize: boolean,
) {
  return {
    days: selection.days,
    current: report.current,
    previous: selection.compare ? report.previous : null,
    suggestions: personalize ? growthRecommendations(report.current) : [],
  };
}

export function applyCoachGrowth(
  context: ReturnType<typeof buildCoachContext>,
  report: ReturnType<typeof coachGrowthReport> | null,
) {
  context.growth = report;
  if (!report) {
    context.profile.window = "当前工作区可用记录";
    return;
  }
  const { current } = report;
  context.profile = {
    ...context.profile,
    window: `近 ${report.days} 天（${current.first} 至 ${current.last}）`,
    completedTasks: current.completed,
    recordedFocusMinutes: current.focusMinutes,
    comparisonSamples: current.samples,
    recordedToEstimatedRatio: null,
    limitations: [
      "完成数按完成记录统计；专注时长是计时记录，不代表全部工作。",
      current.samples < 5
        ? "完成且含专注记录的样本少于5项，暂不足以判断估时偏差或个人习惯。"
        : "估时样本来自有完整记录的任务，不能据此推断因果。",
    ],
  };
}
export function buildCoachContext(
  state: AppState,
  input: CoachInput,
  includeLocalGrowth = true,
) {
  const clock = coachClock(input.timezone);
  const selection = reportWindow(input.choices);
  if (input.taskId && !state.tasks.some((t) => t.id === input.taskId))
    throw new Error("任务已不存在，请重新选择。");
  if (input.goalId && !state.goals.some((g) => g.id === input.goalId))
    throw new Error("目标已不存在，请重新选择。");
  const tasks = [...state.tasks]
    .sort(
      (a, b) =>
        Number(b.id === input.taskId) - Number(a.id === input.taskId) ||
        Number(b.goalId === input.goalId && !!input.goalId) -
          Number(a.goalId === input.goalId && !!input.goalId) ||
        Number(b.date === clock.day) - Number(a.date === clock.day),
    )
    .filter((t) => isPending(t) || t.id === input.taskId)
    .slice(0, 40)
    .map((t) => ({ ...t, notes: t.notes.slice(0, 180) }));
  const goals = state.goals
    .filter(
      (g) => g.id === input.goalId || tasks.some((t) => t.goalId === g.id),
    )
    .slice(0, 8)
    .map((g) => ({ ...g, description: g.description.slice(0, 180) }));
  return {
    today: clock.day,
    nowMinute: clock.minute,
    timezone: input.timezone,
    settings: {
      dayStart: state.settings.dayStart,
      dayEnd: state.settings.dayEnd,
      capacity: state.settings.capacity,
    },
    tasks: input.mode === "profile" ? [] : tasks,
    goals: input.mode === "profile" ? [] : goals,
    blocks: (input.mode === "profile" ? [] : state.blocks)
      .filter((b) => tasks.some((t) => t.id === b.taskId))
      .slice(0, 40),
    sessionTaskId:
      input.mode === "profile" ? null : (state.session?.taskId ?? null),
    profile: executionProfile(
      state,
      clock.day,
      input.mode === "profile" ? selection.days : 30,
    ),
    growth:
      includeLocalGrowth && state.settings.growth?.shareWithAi
        ? coachGrowthReport(
            growthReport(state, selection.days, clock.day, input.timezone),
            selection,
            state.settings.growth.personalize,
          )
        : null,
    planLoad: loadForDay(state, clock.day, clock.wall),
    fixedTimes: (state.fixedTimes ?? [])
      .filter((b) => b.date === clock.day)
      .slice(0, 12)
      .map(({ start, end }) => ({ start, end })),
    reviews: input.includeReviews
      ? [...state.reviews]
          .filter((r) => r.date <= clock.day)
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, 3)
          .map((r) => ({
            date: r.date,
            mood: r.mood,
            text: r.text.slice(0, 200),
          }))
      : [],
    limitations:
      "仅提供最多40项任务、8个目标和最近3篇经授权复盘片段；date是计划日期，不是截止时间。不要推断未提供的历史或依赖。",
  };
}
