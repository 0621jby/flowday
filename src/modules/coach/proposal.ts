import { z } from "zod";
import { stateSchema, type AppState } from "../core/model";
import { validateWorkspace } from "../cloud/validation";
import {
  addDays,
  applyCalendarChange,
  fillDay,
  parseDay,
} from "../planning/calendar";
import { clockTime } from "../planning/scheduler";
import { coachClock } from "./context";
import { isPending } from "../core/execution";
import { planBudget } from "./guidance";
import {
  adviceSchema,
  coachInputSchema,
  type CoachAdvice,
  type CoachInput,
} from "./schema";

export const proposalSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  expiresAt: z.number(),
  day: z.string(),
  input: coachInputSchema,
  advice: adviceSchema,
});
export type CoachProposal = z.infer<typeof proposalSchema>;
export function compileProposal(
  state: AppState,
  proposal: CoachProposal,
  now = new Date(),
) {
  const p = proposalSchema.parse(proposal);
  const advice = p.advice;
  const input = p.input;
  if (p.revision !== state.revision)
    throw new Error("数据已变化，请重新生成建议，避免覆盖已有更改。");
  if (now.getTime() > p.expiresAt) throw new Error("建议已过期，请重新生成。");
  const currentClock = coachClock(input.timezone, now);
  if (input.latestDate) {
    parseDay(input.latestDate);
    if (input.latestDate < currentClock.day)
      throw new Error("本次最晚安排日期已过去，请重新选择。");
  }
  const clock = coachClock(input.timezone, new Date(p.createdAt));
  if (currentClock.day !== p.day)
    throw new Error("日期已变化，请重新生成今天的建议。");
  if (
    input.mode === "profile" &&
    (advice.stages.length ||
      advice.steps.length ||
      advice.moves.length ||
      advice.scheduleTaskIds.length ||
      advice.goalTitle)
  )
    throw new Error("执行画像不能修改工作区。");
  if (input.mode !== "goal" && (advice.goalTitle || advice.stages.length))
    throw new Error("当前求助不能额外创建目标。");
  if (
    input.mode !== "plan" &&
    (advice.moves.length || advice.scheduleTaskIds.length)
  )
    throw new Error("改期和排程仅能在计划调整中预览确认。");
  if (
    input.mode === "goal" &&
    (advice.steps.length || (!advice.goalTitle && advice.stages.length))
  )
    throw new Error("目标拆解格式不完整。");
  let next = structuredClone(state);
  const impact: string[] = [];
  let index = 0;
  const goalId =
    input.goalId ??
    (advice.goalTitle
      ? `ai-${p.id}-goal`
      : (state.tasks.find((t) => t.id === input.taskId)?.goalId ?? null));
  if (input.goalId && !state.goals.some((g) => g.id === input.goalId))
    throw new Error("目标已不存在。");
  const allTasks = [
    ...advice.stages.flatMap((stage) =>
      stage.tasks.map((t) => ({
        ...t,
        notes: `阶段：${stage.title}\n${t.notes}`,
      })),
    ),
    ...advice.steps,
  ];
  if (allTasks.length > 16) throw new Error("建议任务过多，请缩小目标范围。");
  if (advice.goalTitle && !input.goalId) {
    next.goals.push({
      id: goalId!,
      title: advice.goalTitle,
      description: advice.goalDescription ?? "",
      color: "green",
      targetDate: allTasks.length
        ? addDays(p.day, Math.max(...allTasks.map((t) => t.dayOffset)))
        : "",
    });
    impact.push(`新建目标：${advice.goalTitle}`);
  }
  const newIds: string[] = [];
  for (const task of allTasks) {
    const id = `ai-${p.id}-${index++}`;
    newIds.push(id);
    const date = addDays(p.day, task.dayOffset);
    next.tasks.push({
      id,
      title: task.title,
      notes: task.notes,
      minutes: task.minutes,
      priority: task.priority,
      date,
      goalId,
      createdAt: p.createdAt,
      completedAt: null,
      status: "todo",
    });
    impact.push(`新增：${task.title} · ${task.minutes}分钟 · ${date}`);
  }
  if (input.mode === "help" && allTasks.length)
    impact.push("原任务保持不变；新增小行动不代表原任务已经完成。");
  const moveIds = new Set<string>();
  for (const move of advice.moves) {
    if (moveIds.has(move.taskId)) throw new Error("同一任务存在重复改期建议。");
    moveIds.add(move.taskId);
    const task = next.tasks.find((t) => t.id === move.taskId);
    if (!task || !isPending(task))
      throw new Error("AI 引用了不存在或已完成的任务。");
    if (next.session?.taskId === task.id)
      throw new Error("正在专注的任务不能改期。");
    if (next.blocks.some((b) => b.taskId === task.id)) {
      const existing = next.blocks.find((b) => b.taskId === task.id)!;
      if (
        existing.date < clock.day ||
        (existing.date === clock.day && existing.start <= clock.minute)
      )
        throw new Error("已开始或过去的时间块不能由 AI 改期，请手动处理。");
      if (!input.allowReplan)
        throw new Error("建议涉及已有时间块，请允许调整已有计划后重新生成。");
      next = applyCalendarChange(
        next,
        { type: "unschedule", taskId: task.id },
        clock.wall,
      );
      impact.push(`移出原时间块：${task.title}`);
    }
    const date = addDays(p.day, move.dayOffset);
    next = applyCalendarChange(
      next,
      { type: "date", taskId: task.id, date },
      clock.wall,
    );
    impact.push(`改期：${task.title} · ${task.date || "未定日期"} → ${date}`);
  }
  const selected = new Set([
    ...advice.scheduleTaskIds,
    ...(input.mode === "plan"
      ? newIds.filter(
          (id) => next.tasks.find((t) => t.id === id)?.date === p.day,
        )
      : []),
  ]);
  const rebook = new Set<string>();
  for (const id of selected) {
    const task = next.tasks.find((t) => t.id === id);
    if (!task || !isPending(task)) throw new Error("AI 排程引用无效任务。");
    if (task.date !== p.day)
      throw new Error("排程任务不属于今天，请先提出明确的改期建议。");
    const existing = next.blocks.find((b) => b.taskId === id);
    if (existing) {
      if (
        !input.allowReplan ||
        existing.locked ||
        next.session?.taskId === id ||
        existing.start <= clock.minute
      )
        continue;
      next = applyCalendarChange(
        next,
        { type: "unschedule", taskId: id },
        clock.wall,
      );
      rebook.add(id);
      impact.push(`重新安排：${task.title}`);
    }
  }
  const budget = input.mode === "plan" ? planBudget(input.choices) : undefined;
  const result = fillDay(next, p.day, clock.wall, selected, budget);
  if (
    [...rebook].some(
      (id) => !result.blocks.some((block) => block.taskId === id),
    )
  )
    throw new Error(
      "已有预约缺少可替代时段。原计划保留，请缩小调整范围后重试。",
    );
  for (const block of result.blocks) {
    next = applyCalendarChange(
      next,
      { type: "schedule", ...block, date: p.day },
      clock.wall,
    );
    impact.push(
      `预约：${next.tasks.find((t) => t.id === block.taskId)!.title} · ${clockTime(block.start)}–${clockTime(block.end)}`,
    );
  }
  for (const deferred of result.deferred)
    impact.push(
      `未预约：${next.tasks.find((t) => t.id === deferred.taskId)!.title}（${deferred.reason}，保留待办）`,
    );
  if (budget !== undefined)
    impact.push(
      `本次预约与缓冲使用 ${result.used} / ${budget} 分钟，已保留的时间块不计入本次额度。`,
    );
  validateWorkspace(next);
  if (
    state.blocks.some(
      (old) =>
        old.date === p.day &&
        old.start <= currentClock.minute &&
        !next.blocks.some(
          (block) =>
            block.taskId === old.taskId &&
            block.date === old.date &&
            block.start === old.start &&
            block.end === old.end,
        ),
    )
  )
    throw new Error("已有预约已经开始，请重新生成建议。");
  if (input.latestDate) {
    const affected = new Set([
      ...newIds,
      ...advice.moves.map((m) => m.taskId),
      ...advice.scheduleTaskIds,
    ]);
    if (
      next.tasks.some((t) => affected.has(t.id) && t.date > input.latestDate!)
    )
      throw new Error(
        "建议超出你指定的最晚安排日期，请减少范围或补充可用时间后重新生成。",
      );
  }
  if (
    next.blocks.some(
      (b) =>
        b.date === p.day &&
        b.start <= currentClock.minute &&
        !state.blocks.some((old) => JSON.stringify(old) === JSON.stringify(b)),
    )
  )
    throw new Error("建议预约的开始时间已过去，请重新生成，不会静默更换时间。");
  return {
    state: stateSchema.parse(next),
    impact,
    hasChanges: JSON.stringify(next) !== JSON.stringify(state),
  };
}
export function makeProposal(
  state: AppState,
  input: CoachInput,
  advice: CoachAdvice,
  now = new Date(),
): CoachProposal {
  return {
    id: crypto.randomUUID(),
    revision: state.revision,
    createdAt: now.toISOString(),
    expiresAt: now.getTime() + 10 * 60 * 1000,
    day: coachClock(input.timezone, now).day,
    input,
    advice,
  };
}
