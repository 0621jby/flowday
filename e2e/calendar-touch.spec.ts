import { expect, test } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 740 },
  hasTouch: true,
  timezoneId: "Asia/Shanghai",
});

test("touch calendar skips elapsed time and saves the chosen task and slot", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-26T10:12:30+08:00"));
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "移动导航" })
    .getByRole("button", { name: "计划日历" })
    .tap();
  await expect(
    page.getByRole("button", { name: "日", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "2026-11-26 09:00 安排任务" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "2026-11-26 10:15 安排任务" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "2026-11-26 15:00 安排任务" }).tap();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /完成首页的第一版草图/ })
    .tap();
  const editor = page.getByRole("region", { name: "编辑任务安排" });
  await expect(editor.getByLabel("开始时间")).toHaveValue("15:00");
  await editor.getByRole("button", { name: "保存时间安排" }).tap();
  await expect(
    page.locator(".event-content").filter({ hasText: "完成首页的第一版草图" }),
  ).toContainText("15:00");
  await page.getByRole("button", { name: "上一段日期" }).tap();
  await expect(page.locator(".day-lane.past")).toBeVisible();
  await expect(page.getByRole("button", { name: /安排任务$/ })).toHaveCount(0);
});

test("the mobile task pool sits above the calendar and schedules without a cross-screen drag", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-26T10:12:30+08:00"));
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "移动导航" })
    .getByRole("button", { name: "计划日历" })
    .tap();
  const pool = page.getByRole("button", { name: /选择要安排的任务/ });
  const board = page.locator(".calendar-board");
  const [poolBox, boardBox] = await Promise.all([
    pool.boundingBox(),
    board.boundingBox(),
  ]);
  expect(poolBox!.y + poolBox!.height).toBeLessThanOrEqual(boardBox!.y);
  await pool.tap();
  await page
    .locator("#pool-options")
    .getByRole("button", { name: /完成首页的第一版草图/ })
    .tap();
  await expect(page.locator("#pool-options")).toBeHidden();
  await page.getByRole("button", { name: "2026-11-26 14:00 安排任务" }).tap();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("完成首页的第一版草图");
  await expect(confirm).toContainText("14:00–15:00");
  await confirm.getByRole("button", { name: "确认安排" }).tap();
  await expect(
    board.locator(".event-content").filter({ hasText: "完成首页的第一版草图" }),
  ).toContainText("14:00–15:00");
  await expect(pool).toBeVisible();
});
