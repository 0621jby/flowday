import { z } from "zod";
import { coachGuide } from "./guidance";
export const coachInputSchema = z
  .object({
    mode: z.enum(["goal", "help", "plan", "profile"]),
    text: z.string().trim().max(1200),
    choices: z.array(z.string().min(1).max(40)).max(12).optional(),
    taskId: z.string().max(128).nullable(),
    goalId: z.string().max(128).nullable(),
    timezone: z.string().min(1).max(80),
    allowReplan: z.boolean(),
    includeReviews: z.boolean(),
    latestDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .superRefine((input, ctx) => {
    const choices = input.choices ?? [];
    const groups = coachGuide[input.mode];
    const invalid =
      new Set(choices).size !== choices.length ||
      choices.some(
        (id) =>
          !groups.some((group) => group.options.some(([key]) => key === id)),
      ) ||
      groups.some(
        (group) =>
          !group.multiple &&
          group.options.filter(([id]) => choices.includes(id)).length > 1,
      );
    if (invalid)
      ctx.addIssue({
        code: "custom",
        path: ["choices"],
        message: "请选择当前模式下的选项。",
      });
    if (input.text.length < 2 && (input.mode === "goal" || !choices.length))
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message:
          input.mode === "goal"
            ? "请写下想实现的具体目标。"
            : "请选择一个选项，或补充你的情况。",
      });
  });
export type CoachInput = z.infer<typeof coachInputSchema>;
const suggestedTask = z.strictObject({
  title: z.string().min(1).max(200),
  notes: z.string().max(1000),
  minutes: z.number().int().min(5).max(240),
  priority: z.enum(["high", "medium", "low"]),
  dayOffset: z.number().int().min(0).max(60),
});
export const adviceSchema = z.strictObject({
  analysis: z.string().min(1).max(1200),
  hypotheses: z.array(z.string().max(300)).max(5),
  clarifications: z.array(z.string().max(300)).max(4),
  recommendation: z.string().min(1).max(600),
  adjustPlan: z.boolean(),
  goalTitle: z.string().min(1).max(200).nullable(),
  goalDescription: z.string().max(1000).nullable(),
  stages: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(100),
        tasks: z.array(suggestedTask).min(1).max(4),
      }),
    )
    .max(4),
  steps: z.array(suggestedTask).max(6),
  moves: z
    .array(
      z.strictObject({
        taskId: z.string().min(1).max(128),
        dayOffset: z.number().int().min(0).max(60),
      }),
    )
    .max(20),
  scheduleTaskIds: z.array(z.string().min(1).max(128)).max(20),
  cautions: z.array(z.string().max(300)).max(5),
});
export type CoachAdvice = z.infer<typeof adviceSchema>;
export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
});
