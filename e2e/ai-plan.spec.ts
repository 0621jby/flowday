import { test, expect } from "@playwright/test";
import { seedState } from "../src/modules/core/model";
test("AI plan preview preserves confirmed blocks and only defers low-priority work on confirmation", async ({
  page,
}) => {
  const state = seedState();
  state.blocks = [
    {
      taskId: "t1",
      date: state.tasks[0].date,
      start: 570,
      end: 660,
      locked: true,
    },
  ];
  await page.addInitScript((s) => {
    if (!localStorage.getItem("flowday.workspace.v1"))
      localStorage.setItem("flowday.workspace.v1", JSON.stringify(s));
  }, state);
  await page.goto("/");
  await page
    .getByRole("button", { name: "AI 调整今日计划", exact: true })
    .click();
  await page
    .getByLabel("给 AI 的情况说明")
    .fill("今天任务太多，请降低今天的任务负荷。");
  await page
    .getByRole("button", { name: "生成建议与预览", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "预计影响", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
    ),
  ).toEqual(state);
  await page
    .getByRole("button", { name: "确认执行此方案", exact: true })
    .click();
  await expect(
    page.getByText("建议已确认并保存，可回到任务或计划中查看。", {
      exact: true,
    }),
  ).toBeVisible();
  const after = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
  );
  expect(
    after.blocks.find((b: { taskId: string }) => b.taskId === "t1"),
  ).toEqual(state.blocks[0]);
  expect(after.tasks.find((t: { id: string }) => t.id === "t4").date).not.toBe(
    state.tasks[3].date,
  );
  expect(after.tasks).toHaveLength(4);
});
