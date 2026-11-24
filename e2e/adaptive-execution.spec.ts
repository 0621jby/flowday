import { test, expect } from "@playwright/test";
import { seedState } from "../src/modules/core/model";
import { addDays } from "../src/modules/planning/calendar";

test("adaptive preview is read-only, then commits a dated plan with a retained lock", async ({
  page,
}) => {
  const state = seedState();
  const today = state.tasks[0].date;
  const tomorrow = addDays(today, 1);
  state.tasks[0].date = tomorrow;
  state.blocks = [
    { taskId: "t1", date: tomorrow, start: 600, end: 645, locked: true },
  ];
  state.availability = [{ date: today, start: 540, end: 1080, capacity: 0 }];
  await page.addInitScript((s) => {
    if (!localStorage.getItem("flowday.workspace.v1"))
      localStorage.setItem("flowday.workspace.v1", JSON.stringify(s));
  }, state);
  const saved = () =>
    page.evaluate(() =>
      JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
    );
  await page.goto("/");
  await page.getByRole("button", { name: "自适应排程", exact: true }).click();
  await page.getByRole("button", { name: "预览调整", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "调整前后对比" }),
  ).toBeVisible();
  expect(await saved()).toEqual(state);
  await page
    .getByRole("button", { name: "确认保存此计划", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  const next = await saved();
  expect(next.revision).toBe(state.revision + 1);
  expect(
    next.blocks.find((b: { taskId: string }) => b.taskId === "t1"),
  ).toEqual(state.blocks[0]);
  expect(next.blocks.length).toBeGreaterThan(1);
  expect(
    next.executionLog.some((e: { type: string }) => e.type === "commit"),
  ).toBe(true);
});

test("focus lifecycle survives reload and appears in the growth report", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "所有任务", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "开始 梳理个人项目的核心功能", exact: true })
    .click();
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "完成任务", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  const state = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
  );
  expect(state.executionLog.map((e: { type: string }) => e.type)).toEqual([
    "start",
    "pause",
    "resume",
    "complete",
  ]);
  expect(state.executionLog.at(-1)).toMatchObject({
    pauses: 1,
    completeCoverage: true,
  });
  await page
    .getByRole("button", { name: "数据洞察", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "个人执行画像与成长报告" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "每日", exact: true }).click();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "完成次数" })
      .getByRole("cell")
      .first(),
  ).toHaveText("1");
});
