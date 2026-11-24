import { test, expect } from "@playwright/test";
import { seedState } from "../src/modules/core/model";

test.beforeEach(async ({ page }) => {
  const state = seedState();
  state.blocks = [
    {
      taskId: "t1",
      date: state.tasks[0].date,
      start: 570,
      end: 660,
      locked: false,
    },
  ];
  state.events = [
    {
      id: "retained-event",
      taskId: "t1",
      type: "focus",
      at: new Date().toISOString(),
      seconds: 60,
    },
  ];
  await page.addInitScript((s) => {
    if (!localStorage.getItem("flowday.workspace.v1"))
      localStorage.setItem("flowday.workspace.v1", JSON.stringify(s));
  }, state);
  await page.goto("/");
});

test("calendar task can be edited and permanently deleted, with cancel and history preserved", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "计划日历", exact: true })
    .first()
    .click();
  await page
    .locator(".event-content")
    .filter({ hasText: "梳理个人项目的核心功能" })
    .click();
  await page.getByRole("button", { name: "编辑任务详情", exact: true }).click();
  await page.getByLabel("想做什么？").fill("日历中修改的任务");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator(".event-content").filter({ hasText: "日历中修改的任务" }),
  ).toBeVisible();
  await page
    .locator(".event-content")
    .filter({ hasText: "日历中修改的任务" })
    .click();
  await page.getByRole("button", { name: "删除任务", exact: true }).click();
  await page.getByRole("button", { name: "保留任务", exact: true }).click();
  await expect(
    page.locator(".event-content").filter({ hasText: "日历中修改的任务" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "删除任务", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "编辑任务安排" })).toHaveCount(
    0,
  );
  await page.reload();
  const result = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
  );
  expect(result.tasks.some((t: { id: string }) => t.id === "t1")).toBe(false);
  expect(result.blocks).toHaveLength(0);
  expect(result.events).toHaveLength(1);
});

test("goal edit persists; goal delete keeps tasks, calendar blocks and execution history", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "我的目标", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: "编辑目标 做出我的第一个 Web 项目",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("你想实现什么？")).toHaveValue(
    "做出我的第一个 Web 项目",
  );
  await page.getByLabel("你想实现什么？").fill("修改后的目标");
  await page.getByLabel("什么样的结果，算是完成？").fill("新的目标说明");
  await page.getByLabel("目标日期（可选）").fill("2027-01-31");
  await page.getByRole("button", { name: "保存目标修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await page
    .getByRole("button", { name: "我的目标", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "修改后的目标", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("目标日期 2027-01-31", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "删除目标", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "编辑目标 修改后的目标", exact: true })
    .click();
  await page
    .getByLabel("什么样的结果，算是完成？")
    .fill("保留这份未保存的草稿");
  await page.getByRole("button", { name: "删除目标", exact: true }).click();
  await expect(page.getByText(/关联的 2 项任务/)).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "保留关联任务，改为独立任务" }),
  ).toBeChecked();
  await page.getByRole("button", { name: "返回编辑", exact: true }).click();
  await expect(page.getByLabel("什么样的结果，算是完成？")).toHaveValue(
    "保留这份未保存的草稿",
  );
  await page.getByRole("button", { name: "删除目标", exact: true }).click();
  await page.getByRole("button", { name: "确认删除目标", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "修改后的目标", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  const result = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
  );
  expect(result.goals.some((g: { id: string }) => g.id === "g1")).toBe(false);
  expect(result.tasks).toHaveLength(4);
  expect(
    result.tasks
      .filter((t: { id: string; goalId: string | null }) =>
        ["t1", "t2"].includes(t.id),
      )
      .every((t: { goalId: string | null }) => t.goalId === null),
  ).toBe(true);
  expect(result.blocks).toHaveLength(1);
  expect(result.events).toHaveLength(1);
});

test("deleting a goal can explicitly include its tasks and time blocks", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "我的目标", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: "编辑目标 做出我的第一个 Web 项目",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "删除目标", exact: true }).click();
  await page
    .getByRole("radio", { name: "同时删除关联任务和它们的时间安排" })
    .check();
  await page
    .getByRole("button", { name: "确认删除目标及关联任务", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  const result = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("flowday.workspace.v1")!),
  );
  expect(result.goals.map((g: { id: string }) => g.id)).toEqual(["g2"]);
  expect(result.tasks.map((t: { id: string }) => t.id)).toEqual(["t3", "t4"]);
  expect(result.blocks).toHaveLength(0);
  expect(result.events).toHaveLength(1);
});
