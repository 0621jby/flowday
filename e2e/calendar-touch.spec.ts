import { expect, test, type Page } from "@playwright/test";
import { seedState } from "../src/modules/core/model";

const title = "120 分钟的项目任务";
async function prepare(page: Page) {
  await page.clock.setFixedTime(new Date("2026-11-26T08:00:00+08:00"));
  const state = seedState();
  state.tasks[0] = {
    ...state.tasks[0],
    title,
    minutes: 120,
    date: "2026-11-26",
  };
  state.settings.dayEnd = 20;
  await page.addInitScript((seed) => {
    if (!localStorage.getItem("flowday.workspace.v1"))
      localStorage.setItem("flowday.workspace.v1", JSON.stringify(seed));
  }, state);
  await page.goto("/");
}
const day = (page: Page, date: string) =>
  page
    .getByRole("group", { name: "选择本周日期" })
    .getByRole("button", { name: new RegExp(date) });
async function openTime(page: Page, date: string, time: string) {
  const slot = page.getByRole("button", {
    name: `${date} ${time} 安排任务`,
    exact: true,
  });
  await slot.tap({ position: { x: 12, y: 2 } });
  return page.getByRole("dialog", { name: "安排时间" });
}

test.describe("mobile calendar", () => {
  test.use({
    viewport: { width: 390, height: 740 },
    hasTouch: true,
    isMobile: true,
    timezoneId: "Asia/Shanghai",
  });

  test("the right task rail stays beside the timeline while scheduling across dates", async ({
    page,
  }) => {
    await prepare(page);
    await page
      .getByRole("navigation", { name: "移动导航" })
      .getByRole("button", { name: "计划日历" })
      .tap();
    await expect(
      page.getByRole("group", { name: "选择本周日期" }).getByRole("button"),
    ).toHaveCount(7);
    await expect(page.locator(".queue-scroll,.calendar-scroll")).toHaveCount(0);
    const rail = page.getByRole("complementary", { name: "待安排任务" });
    await expect(rail).toBeVisible();
    await expect(page.locator(".mobile-timeline")).toBeVisible();
    expect((await rail.boundingBox())!.x).toBeGreaterThan(
      (await page.locator(".mobile-timeline").boundingBox())!.x,
    );
    await rail.getByRole("button", { name: "日", exact: true }).tap();
    await expect(
      rail.getByRole("button", { name: "日", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({
      path: "test-results/flowday-mobile-task-picker.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: new RegExp(title) }).tap();
    const first = await openTime(page, "2026-11-26", "09:00");
    await first.getByLabel("持续分钟").fill("60");
    await first.getByRole("button", { name: "确认安排" }).tap();
    await expect(
      page.locator(".mobile-segment").filter({ hasText: title }),
    ).toContainText("09:00–10:00");
    await expect(
      page.getByRole("status").filter({ hasText: /剩余 60/ }),
    ).toBeVisible();
    await day(page, "2026-11-27").tap();
    await expect(day(page, "2026-11-27")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const second = await openTime(page, "2026-11-27", "14:00");
    await expect(second.getByLabel("持续分钟")).toHaveValue("60");
    await second.getByRole("button", { name: "确认安排" }).tap();
    await expect(
      page.locator(".mobile-segment").filter({ hasText: title }),
    ).toContainText("14:00–15:00");
    await page.screenshot({
      path: "test-results/flowday-mobile-calendar.png",
      fullPage: true,
    });
    await page.locator(".mobile-segment").filter({ hasText: title }).tap();
    await second.getByLabel("开始时间").fill("15:00");
    await second.getByRole("button", { name: "确认安排" }).tap();
    await expect(
      page.locator(".mobile-segment").filter({ hasText: title }),
    ).toContainText("15:00–16:00");
    await day(page, "2026-11-26").tap();
    await expect(
      page.locator(".mobile-segment").filter({ hasText: title }),
    ).toContainText("09:00–10:00");
    await page.locator(".mobile-segment").filter({ hasText: title }).tap();
    await first.getByRole("button", { name: "删除此时间段" }).tap();
    await expect(
      page.locator(".mobile-segment").filter({ hasText: title }),
    ).toHaveCount(0);
    await day(page, "2026-11-27").tap();
    await expect(
      page.locator(".mobile-segment").filter({ hasText: title }),
    ).toContainText("15:00–16:00");
  });

  test("conflict preserves the chosen task and values, then saves a valid 19:00 slot", async ({
    page,
  }) => {
    await prepare(page);
    await page
      .getByRole("navigation", { name: "移动导航" })
      .getByRole("button", { name: "计划日历" })
      .tap();
    await page.getByRole("button", { name: new RegExp(title) }).tap();
    const first = await openTime(page, "2026-11-26", "09:00");
    await first.getByLabel("持续分钟").fill("60");
    await first.getByRole("button", { name: "确认安排" }).tap();
    await expect(first).toBeHidden();
    const second = await openTime(page, "2026-11-26", "19:00");
    await second.getByLabel("开始时间").fill("09:30");
    await second.getByRole("button", { name: "确认安排" }).tap();
    await expect(second.getByRole("alert")).toContainText("时间冲突");
    await expect(second.getByLabel("开始时间")).toHaveValue("09:30");
    await second.getByLabel("开始时间").fill("19:00");
    await second.getByRole("button", { name: "确认安排" }).tap();
    await expect(
      page.locator(".mobile-segment").filter({ hasText: "19:00–20:00" }),
    ).toBeVisible();
  });

  test("the selected task stays visible during page scroll and its handle drops on the left timeline", async ({
    page,
    context,
  }) => {
    await prepare(page);
    await page
      .getByRole("navigation", { name: "移动导航" })
      .getByRole("button", { name: "计划日历" })
      .tap();
    const rail = page.getByRole("complementary", { name: "待安排任务" });
    await rail.getByRole("button", { name: new RegExp(title) }).tap();
    const slot = page.getByRole("button", {
      name: "2026-11-26 15:00 安排任务",
      exact: true,
    });
    await slot.evaluate((el) =>
      el.scrollIntoView({ block: "center", behavior: "instant" }),
    );
    const grip = rail.getByRole("button", { name: "拖动选中任务" });
    await expect(grip).toBeInViewport();
    const [handle, time] = await Promise.all([
      grip.boundingBox(),
      slot.boundingBox(),
    ]);
    const client = await context.newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: handle!.x + 10, y: handle!.y + 10 }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: time!.x + 12, y: time!.y + 3 }],
    });
    await expect(page.locator(".mobile-drop-target")).toHaveText("15:00");
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    const confirmation = page.getByRole("dialog", { name: "安排时间" });
    await expect(confirmation.getByLabel("开始时间")).toHaveValue("15:00");
    const confirmButton = confirmation.getByRole("button", {
      name: "确认安排",
    });
    const confirmBox = (await confirmButton.boundingBox())!;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        {
          x: confirmBox.x + confirmBox.width / 2,
          y: confirmBox.y + confirmBox.height / 2,
        },
      ],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(confirmation).toBeHidden();
    await expect(
      page.locator(".mobile-segment").filter({ hasText: title }),
    ).toContainText("15:00–17:00");
  });
});

test("desktop keeps the seven-column week and drag-to-schedule", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1480, height: 1050 });
  await prepare(page);
  await page
    .getByRole("button", { name: "计划日历", exact: true })
    .first()
    .click();
  await expect(page.locator(".day-header")).toHaveCount(7);
  const source = page
    .locator(".calendar-queue-task")
    .filter({ hasText: title });
  const lane = page.getByTestId("calendar-day-2026-11-27");
  await source.dragTo(lane, { targetPosition: { x: 20, y: 64 } });
  await expect(
    lane.locator(".event-content").filter({ hasText: title }),
  ).toContainText("10:00–12:00");
  await page.screenshot({
    path: "test-results/flowday-desktop-week.png",
    fullPage: true,
  });
});
