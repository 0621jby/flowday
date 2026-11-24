import { z } from "zod";
export const strokeSchema = z.object({
  color: z.enum(["#467d5d", "#b78160", "#657da5", "#b89b40", "#454b45"]),
  size: z.union([z.literal(2), z.literal(5), z.literal(9)]),
  points: z
    .array(
      z.tuple([
        z.number().int().min(0).max(1000),
        z.number().int().min(0).max(600),
      ]),
    )
    .min(1)
    .max(200),
});
export type DoodleStroke = z.infer<typeof strokeSchema>;
export const taskKinds = {
  study: "学习",
  project: "项目",
  admin: "事务",
  routine: "日常",
} as const;
export const taskKindSchema = z.enum(["study", "project", "admin", "routine"]);
export const taskExecutionSchema = z.object({
  kind: taskKindSchema.optional(),
  dueDate: z.string().optional(),
  dependencies: z.array(z.string().min(1).max(128)).max(20).optional(),
  abandonedAt: z.iso.datetime().optional(),
  parentId: z.string().min(1).max(128).optional(),
});
export const executionEntrySchema = z.object({
  id: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  title: z.string().max(200),
  at: z.iso.datetime(),
  type: z.enum([
    "start",
    "pause",
    "resume",
    "stop",
    "complete",
    "reopen",
    "defer",
    "abandon",
    "restore",
    "commit",
    "split",
  ]),
  kind: taskKindSchema.optional(),
  estimate: z.number().int().min(5).max(480).optional(),
  firstAt: z.iso.datetime().optional(),
  elapsedSeconds: z.number().int().nonnegative().optional(),
  focusSeconds: z.number().int().nonnegative().optional(),
  sampleFocusSeconds: z.number().int().nonnegative().optional(),
  pauses: z.number().int().nonnegative().optional(),
  completeCoverage: z.boolean().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ExecutionEntry = z.infer<typeof executionEntrySchema>;
export const availabilitySchema = z.object({
  date: z.string(),
  start: z.number().int().min(0).max(1439),
  end: z.number().int().min(1).max(1440),
  capacity: z.number().int().min(0).max(720),
});
export const fixedTimeSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().trim().min(1).max(100),
  date: z.string(),
  start: z.number().int().min(0).max(1439),
  end: z.number().int().min(1).max(1440),
});
export const taskSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  notes: z.string().max(2000),
  minutes: z.number().int().min(5).max(480),
  priority: z.enum(["high", "medium", "low"]),
  status: z.enum(["todo", "done"]),
  goalId: z.string().nullable(),
  date: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  execution: taskExecutionSchema.optional(),
});
export type Task = z.infer<typeof taskSchema>;
export const stateSchema = z.object({
  schemaVersion: z.literal(1),
  executionVersion: z.literal(1).optional(),
  revision: z.number().int().nonnegative(),
  tasks: z.array(taskSchema).max(10000),
  goals: z.array(
    z.object({
      id: z.string(),
      title: z.string().min(1).max(200),
      description: z.string().max(1000),
      color: z.enum(["green", "blue", "orange"]),
      targetDate: z.string(),
    }),
  ),
  blocks: z.array(
    z.object({
      taskId: z.string(),
      date: z.string(),
      start: z.number().int().min(0).max(1439),
      end: z.number().int().min(1).max(1440),
      locked: z.boolean().optional(),
    }),
  ),
  reviews: z.array(
    z.object({
      date: z.string(),
      text: z.string().max(2000),
      mood: z.number().int().min(1).max(3),
      drawing: z.array(strokeSchema).max(40).optional(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.string(),
      taskId: z.string(),
      type: z.enum(["complete", "reopen", "focus"]),
      at: z.string(),
      seconds: z.number().nonnegative().optional(),
    }),
  ),
  settings: z.object({
    name: z.string().min(1).max(30),
    dayStart: z.number().int().min(0).max(23),
    dayEnd: z.number().int().min(1).max(24),
    capacity: z.number().int().min(30).max(720),
    onboardingComplete: z.boolean().optional(),
    aiEnabled: z.boolean().optional(),
    growth: z
      .object({
        personalize: z.boolean(),
        shareWithAi: z.boolean(),
        preferred: z.enum(["any", "morning", "afternoon", "evening"]),
      })
      .optional(),
  }),
  executionLog: z.array(executionEntrySchema).max(50000).optional(),
  availability: z.array(availabilitySchema).max(730).optional(),
  fixedTimes: z.array(fixedTimeSchema).max(3000).optional(),
  session: z
    .object({
      taskId: z.string(),
      startedAt: z.number(),
      accumulated: z.number().nonnegative(),
      running: z.boolean(),
      tracking: z
        .object({
          firstAt: z.iso.datetime(),
          estimate: z.number().int().min(5).max(480),
          pauses: z.number().int().nonnegative(),
          kind: taskKindSchema.optional(),
        })
        .optional(),
    })
    .nullable(),
});
export type AppState = z.infer<typeof stateSchema>;
export type Goal = AppState["goals"][number];
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function uid() {
  return crypto.randomUUID();
}
export function seedState(): AppState {
  const date = localDate();
  const iso = new Date().toISOString();
  return {
    schemaVersion: 1,
    revision: 0,
    settings: { name: "朋友", dayStart: 9, dayEnd: 18, capacity: 240 },
    session: null,
    reviews: [],
    events: [],
    blocks: [],
    goals: [
      {
        id: "g1",
        title: "做出我的第一个 Web 项目",
        description: "从想法到上线，每天向前一小步。",
        color: "green",
        targetDate: "",
      },
      {
        id: "g2",
        title: "建立持续阅读的习惯",
        description: "让阅读成为日常，而不是待办。",
        color: "blue",
        targetDate: "",
      },
    ],
    tasks: [
      {
        id: "t1",
        title: "梳理个人项目的核心功能",
        notes: "先写下用户最需要解决的一个问题，再列出 3 个必需功能。",
        minutes: 45,
        priority: "high",
        status: "todo",
        goalId: "g1",
        date,
        createdAt: iso,
        completedAt: null,
      },
      {
        id: "t2",
        title: "完成首页的第一版草图",
        notes: "先用纸笔或熟悉的工具画出主要区域，不用追求精细。",
        minutes: 60,
        priority: "high",
        status: "todo",
        goalId: "g1",
        date,
        createdAt: iso,
        completedAt: null,
      },
      {
        id: "t3",
        title: "阅读 20 分钟，记下一点启发",
        notes: "选一本正在读的书，记录一句对今天有用的话。",
        minutes: 20,
        priority: "medium",
        status: "todo",
        goalId: "g2",
        date,
        createdAt: iso,
        completedAt: null,
      },
      {
        id: "t4",
        title: "整理工作空间",
        notes: "清理桌面，关掉暂时用不到的标签页。",
        minutes: 15,
        priority: "low",
        status: "todo",
        goalId: null,
        date,
        createdAt: iso,
        completedAt: null,
      },
    ],
  };
}
