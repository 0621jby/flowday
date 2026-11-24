export type Obstacle = "unclear" | "large" | "tired";
export function recoverySuggestion(title: string, obstacle: Obstacle) {
  const plans = {
    unclear: {
      step: `为「${title}」写下一个明确的完成标准`,
      detail: "先回答：做到什么程度，就算今天有了进展？只写一句话。",
      minutes: 5,
    },
    large: {
      step: `用 10 分钟启动「${title}」`,
      detail:
        "只打开需要的材料，完成最小的一部分。时间到了可以停，不必一次做完。",
      minutes: 10,
    },
    tired: {
      step: `为「${title}」做一点轻量准备`,
      detail: "先离开屏幕休息一下。回来后只整理材料，不要求完成原任务。",
      minutes: 5,
    },
  };
  return plans[obstacle];
}
