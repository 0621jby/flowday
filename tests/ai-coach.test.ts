import { afterEach, describe, expect, it, vi } from "vitest";
import { seedState, type AppState } from "../src/modules/core/model";
import {
  coachClock,
  executionProfile,
  buildCoachContext,
} from "../src/modules/coach/context";
import { compileProposal, makeProposal } from "../src/modules/coach/proposal";
import {
  adviceSchema,
  type CoachAdvice,
  type CoachInput,
} from "../src/modules/coach/schema";
import { createProvider } from "../src/modules/coach/provider";
import { signProposal, verifyProposal } from "../src/modules/coach/signing";

const now = new Date("2026-11-19T08:00:00Z");
const input: CoachInput = {
  mode: "goal",
  text: "两个月学 Python 并做 Web 项目，每天45分钟",
  taskId: null,
  goalId: null,
  timezone: "UTC",
  allowReplan: false,
  includeReviews: false,
};
function state() {
  const s = seedState();
  s.tasks = s.tasks.map((t) => ({ ...t, date: "2026-11-19" }));
  return s;
}
function advice(): CoachAdvice {
  return {
    analysis: "先确认起点和成果。",
    hypotheses: [],
    clarifications: [],
    recommendation: "先做一个最小练习。",
    adjustPlan: false,
    goalTitle: null,
    goalDescription: null,
    stages: [],
    steps: [],
    moves: [],
    scheduleTaskIds: [],
    cautions: [],
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("AI proposal program guards", () => {
  it("enforces a guided plan budget including buffers, without counting preserved reservations", () => {
    const s = state();
    s.tasks[0].minutes = 25;
    s.blocks = [
      {
        taskId: "t2",
        date: s.tasks[1].date,
        start: 540,
        end: 600,
        locked: true,
      },
    ];
    const plan = makeProposal(
      s,
      {
        ...input,
        mode: "plan",
        text: "",
        choices: ["plan-30"],
      },
      { ...advice(), scheduleTaskIds: ["t1", "t3"] },
      now,
    );
    const result = compileProposal(s, plan, now);
    expect(result.state.blocks).toContainEqual(s.blocks[0]);
    expect(
      result.state.blocks.find((block) => block.taskId === "t1"),
    ).toMatchObject({ start: 600, end: 625 });
    expect(result.state.blocks.some((block) => block.taskId === "t3")).toBe(
      false,
    );
    expect(result.impact).toEqual(
      expect.arrayContaining([expect.stringContaining("30 / 30 分钟")]),
    );
  });
  it("checks an explicit latest date in code and rejects impossible deadlines", () => {
    const s = state();
    const a = advice();
    a.goalTitle = "限期目标";
    a.stages = [
      {
        title: "阶段",
        tasks: [
          {
            title: "晚于约束",
            notes: "",
            minutes: 20,
            priority: "high",
            dayOffset: 2,
          },
        ],
      },
    ];
    expect(() =>
      compileProposal(
        s,
        makeProposal(s, { ...input, latestDate: "2026-11-20" }, a, now),
        now,
      ),
    ).toThrow(/最晚安排日期/);
    expect(() =>
      compileProposal(
        s,
        makeProposal(s, { ...input, latestDate: "2026-11-18" }, a, now),
        now,
      ),
    ).toThrow(/已过去/);
  });
  it("creates stable goal/task IDs and phase notes without mutating the original", () => {
    const s = state();
    const a = advice();
    a.goalTitle = "Python 项目";
    a.stages = [
      {
        title: "基础练习",
        tasks: [
          {
            title: "运行第一个程序",
            notes: "打印一行结果",
            minutes: 20,
            priority: "high",
            dayOffset: 1,
          },
        ],
      },
    ];
    const p = makeProposal(s, input, a, now);
    const first = compileProposal(s, p, now);
    expect(s.goals).toHaveLength(2);
    expect(first.state.goals).toHaveLength(3);
    expect(first.state.tasks.at(-1)?.notes).toContain("基础练习");
    expect(compileProposal(s, p, now).state).toEqual(first.state);
  });
  it("adds actions to an existing goal without creating a duplicate goal", () => {
    const s = state();
    const a = advice();
    a.goalTitle = "不应重建";
    a.stages = [
      {
        title: "下一阶段",
        tasks: [
          {
            title: "完成练习",
            notes: "",
            minutes: 15,
            priority: "low",
            dayOffset: 0,
          },
        ],
      },
    ];
    const result = compileProposal(
      s,
      makeProposal(s, { ...input, goalId: "g1" }, a, now),
      now,
    );
    expect(result.state.goals).toHaveLength(2);
    expect(result.state.tasks.at(-1)?.goalId).toBe("g1");
  });
  it("does not apply until explicitly requested, rejects stale revision and expiry", () => {
    const s = state();
    const p = makeProposal(s, input, advice(), now);
    expect(() => compileProposal({ ...s, revision: 1 }, p, now)).toThrow(
      /数据已变化/,
    );
    expect(() =>
      compileProposal(s, p, new Date(now.getTime() + 600001)),
    ).toThrow(/过期/);
  });
  it("rejects hidden delete commands, invalid durations and nonexistent references", () => {
    expect(() =>
      adviceSchema.parse({ ...advice(), deleteTaskIds: ["t1"] }),
    ).toThrow();
    expect(() =>
      adviceSchema.parse({
        ...advice(),
        steps: [
          {
            title: "无效",
            notes: "",
            minutes: -5,
            priority: "high",
            dayOffset: 0,
          },
        ],
      }),
    ).toThrow();
    const s = state();
    expect(() =>
      compileProposal(
        s,
        makeProposal(
          s,
          { ...input, mode: "plan" },
          { ...advice(), scheduleTaskIds: ["foreign-task"] },
          now,
        ),
        now,
      ),
    ).toThrow(/无效任务/);
  });
  it("preserves existing confirmed blocks unless explicitly authorized, never moves locked/active blocks", () => {
    const s = state();
    s.blocks = [
      { taskId: "t1", date: "2026-11-19", start: 600, end: 660, locked: false },
    ];
    const change = { ...advice(), moves: [{ taskId: "t1", dayOffset: 1 }] };
    expect(() =>
      compileProposal(
        s,
        makeProposal(s, { ...input, mode: "plan" }, change, now),
        now,
      ),
    ).toThrow(/允许调整/);
    s.blocks[0].locked = true;
    expect(() =>
      compileProposal(
        s,
        makeProposal(
          s,
          { ...input, mode: "plan", allowReplan: true },
          change,
          now,
        ),
        now,
      ),
    ).toThrow(/锁定/);
    s.blocks[0].locked = false;
    s.session = {
      taskId: "t1",
      startedAt: now.getTime(),
      accumulated: 0,
      running: true,
    };
    expect(() =>
      compileProposal(
        s,
        makeProposal(
          s,
          { ...input, mode: "plan", allowReplan: true },
          change,
          now,
        ),
        now,
      ),
    ).toThrow(/专注/);
  });
  it("rejects moving historical blocks even with replan permission", () => {
    const s = state();
    s.blocks = [{ taskId: "t1", date: "2026-11-19", start: 420, end: 480 }];
    expect(() =>
      compileProposal(
        s,
        makeProposal(
          s,
          { ...input, mode: "plan", allowReplan: true },
          { ...advice(), moves: [{ taskId: "t1", dayOffset: 1 }] },
          now,
        ),
        now,
      ),
    ).toThrow(/过去/);
  });
  it("uses deterministic scheduling with conflict/capacity protection and never silently changes preview times", () => {
    const s = state();
    s.blocks = [
      { taskId: "t2", date: "2026-11-19", start: 540, end: 600, locked: true },
    ];
    const p = makeProposal(
      s,
      { ...input, mode: "plan" },
      { ...advice(), scheduleTaskIds: ["t1"] },
      now,
    );
    const result = compileProposal(s, p, now);
    expect(result.state.blocks[0]).toEqual(s.blocks[0]);
    const created = result.state.blocks.find((b) => b.taskId === "t1")!;
    expect(created.start).toBeGreaterThanOrEqual(600);
    expect(
      compileProposal(s, p, new Date(now.getTime() + 60000)).state.blocks,
    ).toEqual(result.state.blocks);
  });
  it("requires regenerating a preview when its reservation has already started", () => {
    const s = state();
    s.settings.dayStart = 8;
    const p = makeProposal(
      s,
      { ...input, mode: "plan" },
      { ...advice(), scheduleTaskIds: ["t1"] },
      now,
    );
    expect(() =>
      compileProposal(s, p, new Date(now.getTime() + 6 * 60000)),
    ).toThrow(/开始时间已过去/);
  });
  it("keeps profile requests read-only and unknown personal habits explicit", () => {
    const s = state();
    const profile = executionProfile(s, "2026-11-19");
    expect(profile.comparisonSamples).toBe(0);
    expect(profile.recordedToEstimatedRatio).toBeNull();
    expect(profile.limitations.join()).toContain("不足");
    expect(() =>
      compileProposal(
        s,
        makeProposal(
          s,
          { ...input, mode: "profile" },
          { ...advice(), moves: [{ taskId: "t1", dayOffset: 1 }] },
          now,
        ),
        now,
      ),
    ).toThrow(/不能修改/);
  });
  it("uses the supplied IANA time zone, including day rollover", () => {
    expect(
      coachClock("Asia/Shanghai", new Date("2026-11-19T23:00:00Z")).day,
    ).toBe("2026-11-20");
    expect(() => coachClock("Invalid/Zone", now)).toThrow();
  });
  it("excludes private reviews by default and includes only bounded opted-in fragments", () => {
    const s = state();
    s.reviews = [{ date: "2026-11-19", text: "私密内容".repeat(100), mood: 1 }];
    expect(buildCoachContext(s, input).reviews).toEqual([]);
    expect(
      buildCoachContext(s, { ...input, includeReviews: true }).reviews[0].text
        .length,
    ).toBe(200);
  });
  it("binds confirmation signatures to the account and exact immutable plan", () => {
    vi.stubEnv(
      "AI_PROPOSAL_SECRET",
      "test-only-secret-at-least-thirty-two-characters",
    );
    const p = makeProposal(state(), input, advice(), now);
    const token = signProposal("a", p);
    expect(verifyProposal("a", token)).toEqual(p);
    expect(() => verifyProposal("b", token)).toThrow(/账户/);
    const parts = token.split(".");
    const data = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    data.proposal.advice.goalTitle = "篡改";
    expect(() =>
      verifyProposal(
        "a",
        `${Buffer.from(JSON.stringify(data)).toString("base64url")}.${parts[1]}`,
      ),
    ).toThrow(/修改/);
  });
});
describe("provider adapter", () => {
  it("defaults to transparent Mock and requires explicit paid-call opt-in", async () => {
    vi.stubEnv("AI_PROVIDER", "mock");
    const provider = createProvider();
    const s = state();
    const result = await provider.generate(input, buildCoachContext(s, input));
    expect(result.advice.analysis).toContain("Mock");
    expect(result.estimatedCostUsd).toBe(0);
    vi.stubEnv("AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AI_ENABLE_PAID_CALLS", "false");
    expect(() => createProvider()).toThrow(/未启用/);
  });
  it("validates structured responses and reports unknown cost instead of zero", async () => {
    vi.stubEnv("AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AI_ENABLE_PAID_CALLS", "true");
    vi.stubEnv("AI_API_KEY", "test-not-real");
    vi.stubEnv("AI_OUTPUT_FORMAT", "strict");
    vi.stubEnv("AI_API_URL", "https://provider.invalid/chat/completions");
    vi.stubEnv("AI_MODEL", "test-model");
    vi.stubEnv(
      "AI_PROPOSAL_SECRET",
      "test-only-secret-at-least-thirty-two-characters",
    );
    vi.stubEnv("AI_INPUT_USD_PER_MILLION", "");
    const mock = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(advice()) },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );
    vi.stubGlobal("fetch", mock);
    const result = await createProvider().generate(
      input,
      buildCoachContext(state(), input),
    );
    expect(result.inputTokens).toBe(100);
    expect(result.estimatedCostUsd).toBeNull();
    expect(
      JSON.parse(mock.mock.calls[0][1].body).response_format.json_schema.strict,
    ).toBe(true);
    mock.mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: '{"deleteEverything":true}' },
          },
        ],
      }),
    );
    await expect(
      createProvider().generate(input, buildCoachContext(state(), input)),
    ).rejects.toThrow();
  });
});
