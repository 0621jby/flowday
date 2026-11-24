import { expect, test } from "@playwright/test";

test("guided choices and free text stay with their modes and reach the server together", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "AI 拆解新目标", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "AI 执行教练" });
  const choice = (name: string) =>
    panel.getByRole("button", { name, exact: true });
  const text = panel.getByLabel("给 AI 的情况说明");
  const generate = choice("生成建议与预览");
  await expect(panel.getByText("Mock 演示 · 未连接真实 AI")).toBeVisible();
  await choice("完成一个项目").click();
  await expect(choice("已有基础")).toBeHidden();
  await expect(generate).toBeDisabled();
  await text.fill("上线一个能导出数据的记账网站");
  await panel.getByText("更多可选条件", { exact: true }).click();
  await choice("已有基础").click();
  await choice("15 分钟").click();
  await choice("按周设里程碑").click();
  await panel.getByLabel(/本次允许使用最近3篇复盘片段/).check();

  await choice("任务求助").click();
  await expect(text).toHaveValue("");
  await expect(
    panel.getByLabel(/本次允许使用最近3篇复盘片段/),
  ).not.toBeChecked();
  await panel.getByLabel("AI 求助任务").selectOption("t1");
  await choice("任务太大").click();
  await choice("缺少信息或材料").click();
  await expect(choice("任务太大")).toHaveAttribute("aria-pressed", "true");
  await expect(choice("缺少信息或材料")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const helpRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/coach",
  );
  await generate.click();
  expect((await helpRequest).postDataJSON().input).toMatchObject({
    mode: "help",
    taskId: "t1",
    text: "",
    choices: ["help-info", "help-size"],
    includeReviews: false,
  });
  await expect(panel.getByRole("heading", { name: "预计影响" })).toBeVisible();

  await choice("调整计划").click();
  await expect(panel.getByRole("heading", { name: "预计影响" })).toHaveCount(0);
  await choice("减轻今日负荷").click();
  await expect(choice("重排今天")).toHaveAttribute("aria-pressed", "false");
  await expect(choice("减轻今日负荷")).toHaveAttribute("aria-pressed", "true");
  await choice("执行画像").click();
  await choice("估时和实际耗时").click();
  await panel.getByText("更多可选条件", { exact: true }).click();
  await choice("近 30 天").click();
  await expect(text).toHaveValue("");
  await choice("目标拆解").click();
  await expect(text).toHaveValue("上线一个能导出数据的记账网站");
  await expect(choice("完成一个项目")).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel.getByText("更多可选条件（已选 3 项）", { exact: true }),
  ).toBeVisible();
  const goalRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/coach",
  );
  await generate.click();
  expect((await goalRequest).postDataJSON().input).toMatchObject({
    mode: "goal",
    text: "上线一个能导出数据的记账网站",
    choices: ["goal-15", "goal-basic", "goal-project", "goal-weekly"],
    includeReviews: true,
  });
  await expect(panel.getByRole("heading", { name: "预计影响" })).toBeVisible();
  await expect(
    panel.getByText("新建目标：上线一个能导出数据的记账网站", { exact: true }),
  ).toBeVisible();
});
