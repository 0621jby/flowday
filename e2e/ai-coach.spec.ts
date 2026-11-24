import { test, expect } from "@playwright/test";

test("Mock goal breakdown is preview-only until explicit confirmation, then persists", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "AI 拆解新目标", exact: true })
    .click();
  await expect(
    page.getByText("Mock 演示 · 未连接真实 AI", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("给 AI 的情况说明")
    .fill("两个月学会 Python 并完成 Web 项目，每天45分钟，目前零基础。");
  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
  );
  await page
    .getByRole("button", { name: "生成建议与预览", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "预计影响", exact: true }),
  ).toBeVisible();
  const unconfirmed = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
  );
  expect(unconfirmed).toEqual(before);
  await page
    .getByRole("button", { name: "确认执行此方案", exact: true })
    .click();
  await expect(
    page.getByText("建议已确认并保存，可回到任务或计划中查看。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认执行此方案", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  const after = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
  );
  expect(after.goals.length).toBe(before.goals.length + 1);
  expect(after.tasks.length).toBe(before.tasks.length + 3);
});

test("task details offer contextual help, retain rule fallback, and preserve original task", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "所有任务", exact: true })
    .first()
    .click();
  await page.getByText("梳理个人项目的核心功能", { exact: true }).click();
  await page
    .getByText("AI 帮我推进这项任务（基于已保存的内容）", { exact: true })
    .click();
  await page
    .getByLabel("给 AI 的情况说明")
    .fill("任务太复杂，不知道如何开始，只有15分钟。");
  await page
    .getByRole("button", { name: "生成建议与预览", exact: true })
    .click();
  await expect(
    page.getByText("原任务保持不变；新增小行动不代表原任务已经完成。", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "确认执行此方案", exact: true })
    .click();
  await expect(
    page.getByText("建议已确认并保存，可回到任务或计划中查看。", {
      exact: true,
    }),
  ).toBeVisible();
  const result = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
  );
  expect(result.tasks).toHaveLength(5);
  expect(result.tasks.find((t: { id: string }) => t.id === "t1").status).toBe(
    "todo",
  );
});

test("existing goal decomposition attaches to that goal, and profile stays read-only", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "我的目标", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: "AI 拆解目标 做出我的第一个 Web 项目",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "生成建议与预览", exact: true })
    .click();
  await page
    .getByRole("button", { name: "确认执行此方案", exact: true })
    .click();
  await expect(
    page.getByText("建议已确认并保存，可回到任务或计划中查看。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
  );
  expect(before.goals).toHaveLength(2);
  expect(
    before.tasks.filter((t: { goalId: string }) => t.goalId === "g1"),
  ).toHaveLength(5);
  await page.getByRole("button", { name: "查看执行画像", exact: true }).click();
  await page
    .getByRole("button", { name: "生成建议与预览", exact: true })
    .click();
  await expect(
    page.getByText("仅提供分析，不修改任务或计划。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/完成且含专注记录的样本少于5项/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认执行此方案", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
    ),
  ).toEqual(before);
});
