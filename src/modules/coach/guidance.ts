export type CoachMode = "goal" | "help" | "plan" | "profile";

type GuideGroup = {
  label: string;
  multiple?: boolean;
  extra?: boolean;
  options: readonly (readonly [id: string, label: string])[];
};
const planTimeOptions = [
  { id: "plan-30", label: "最多 30 分钟", minutes: 30 },
  { id: "plan-60", label: "最多 1 小时", minutes: 60 },
  { id: "plan-120", label: "最多 2 小时", minutes: 120 },
  { id: "plan-180", label: "最多 3 小时", minutes: 180 },
  { id: "plan-unknown", label: "按日历剩余容量", minutes: undefined },
] as const;
const reportRanges = [
  { id: "profile-week", label: "近 7 天", days: 7, compare: false },
  { id: "profile-month", label: "近 30 天", days: 30, compare: false },
  { id: "profile-compare", label: "近 7 天与前 7 天", days: 7, compare: true },
] as const;

export const coachGuide: Record<CoachMode, GuideGroup[]> = {
  goal: [
    {
      label: "目标类型",
      options: [
        ["goal-skill", "学习新技能"],
        ["goal-project", "完成一个项目"],
        ["goal-habit", "养成习惯"],
        ["goal-exam", "准备考试"],
      ],
    },
    {
      label: "目前进度",
      extra: true,
      options: [
        ["goal-new", "还没开始"],
        ["goal-basic", "已有基础"],
        ["goal-started", "已经做了一部分"],
        ["goal-final", "接近完成"],
      ],
    },
    {
      label: "每天大约能投入",
      extra: true,
      options: [
        ["goal-15", "15 分钟"],
        ["goal-30", "30 分钟"],
        ["goal-45", "45 分钟"],
        ["goal-60", "1 小时"],
        ["goal-flexible", "每天不固定"],
      ],
    },
    {
      label: "希望怎么拆",
      extra: true,
      options: [
        ["goal-small", "先做出最小成果"],
        ["goal-weekly", "按周设里程碑"],
        ["goal-foundations", "从基础循序推进"],
      ],
    },
  ],
  help: [
    {
      label: "遇到了哪些卡点",
      multiple: true,
      options: [
        ["help-start", "不知道从哪开始"],
        ["help-size", "任务太大"],
        ["help-info", "缺少信息或材料"],
        ["help-perfect", "怕做不好"],
        ["help-energy", "精力不足"],
        ["help-time", "时间不够"],
        ["help-behind", "进度落后"],
      ],
    },
    {
      label: "希望得到的帮助",
      extra: true,
      options: [
        ["help-next", "给我一个具体下一步"],
        ["help-split", "拆成几个小步骤"],
        ["help-missing", "列出缺少的条件"],
        ["help-minimum", "先保住关键部分"],
      ],
    },
    {
      label: "眼下大约有多少时间",
      extra: true,
      options: [
        ["help-5", "5 分钟"],
        ["help-10", "10 分钟"],
        ["help-15", "15 分钟"],
        ["help-25", "25 分钟"],
        ["help-45", "45 分钟"],
      ],
    },
    {
      label: "任务进展",
      extra: true,
      options: [
        ["help-not-started", "还未开始"],
        ["help-partial", "已经做了一部分"],
        ["help-waiting", "正在等回复或材料"],
        ["help-almost", "只剩收尾"],
      ],
    },
  ],
  plan: [
    {
      label: "这次想解决什么",
      options: [
        ["plan-today", "重排今天"],
        ["plan-overdue", "处理延期任务"],
        ["plan-urgent", "给临时任务腾时间"],
        ["plan-reduce", "减轻今日负荷"],
        ["plan-deadline", "优先临近截止"],
      ],
    },
    {
      label: "调整时优先考虑",
      extra: true,
      options: [
        ["plan-important", "先做最重要的事"],
        ["plan-finish", "先收尾接近完成的事"],
        ["plan-breaks", "保留休息和缓冲"],
        ["plan-end-on-time", "按时收工"],
      ],
    },
    {
      label: "本次排程时间上限（含缓冲）",
      extra: true,
      options: planTimeOptions.map(({ id, label }) => [id, label]),
    },
  ],
  profile: [
    {
      label: "想了解哪些方面",
      multiple: true,
      options: [
        ["profile-progress", "完成与延期"],
        ["profile-estimate", "估时和实际耗时"],
        ["profile-focus", "专注时段"],
        ["profile-load", "计划负荷"],
        ["profile-change", "近期变化"],
      ],
    },
    {
      label: "想看的范围",
      extra: true,
      options: reportRanges.map(({ id, label }) => [id, label]),
    },
    {
      label: "希望分析的侧重点",
      extra: true,
      options: [
        ["profile-observe", "看懂记录里的变化"],
        ["profile-reasons", "排查可能的原因"],
        ["profile-action", "给我一个可试的小调整"],
      ],
    },
  ],
};

export function planBudget(choices: readonly string[] = []) {
  return planTimeOptions.find(({ id }) => choices.includes(id))?.minutes;
}

export function reportWindow(choices: readonly string[] = []) {
  const { days, compare } =
    reportRanges.find(({ id }) => choices.includes(id)) ?? reportRanges[0];
  return { days, compare };
}

export const guideCopy: Record<
  CoachMode,
  { label: string; placeholder: string }
> = {
  goal: {
    label: "想实现的具体目标",
    placeholder: "例如：两个月内用 Python 做出一个能上线的记账网站。",
  },
  help: {
    label: "遇到的困难",
    placeholder: "例如：大纲写好了，但不知道用哪个例子开头。",
  },
  plan: {
    label: "今天有什么变化？",
    placeholder: "例如：下午临时加了会，只有报价单必须今天交。",
  },
  profile: {
    label: "你想了解什么？",
    placeholder: "例如：最近哪类任务最容易超出预计时间？",
  },
};

export function guideGroups(mode: CoachMode, choices: readonly string[]) {
  return coachGuide[mode].flatMap((group) => {
    const selected = group.options.filter(([id]) => choices.includes(id));
    return selected.length
      ? [{ group: group.label, selections: selected.map(([, label]) => label) }]
      : [];
  });
}
