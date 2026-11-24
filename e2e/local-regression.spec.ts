import { test, expect } from "@playwright/test";

test("local MVP still creates, edits, focuses and persists a task after async conversion", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("本地已保存", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新建任务" }).first().click();
  await page.getByLabel("想做什么？").fill("V1.1 回归测试任务");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加任务", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await page
    .getByRole("button", { name: "所有任务", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("V1.1 回归测试任务", { exact: true }),
  ).toBeVisible();
  await page.getByText("V1.1 回归测试任务", { exact: true }).click();
  await page.getByLabel("想做什么？").fill("V1.1 已编辑任务");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("flowday.workspace.v1")!).tasks.some(
          (t: { title: string }) => t.title === "V1.1 已编辑任务",
        ),
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "开始 V1.1 已编辑任务", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "结束本次专注，保留任务", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("flowday.workspace.v1")!,
          ).events.filter((e: { type: string }) => e.type === "focus").length,
      ),
    )
    .toBe(1);
});

test("reviews and drawing survive refresh and remain accessible by date", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "每日复盘", exact: true })
    .first()
    .click();
  await page
    .getByLabel("有什么想留给这一天？")
    .fill("云端改造后本地复盘依然保存。");
  await page.getByRole("button", { name: "开始涂鸦", exact: true }).click();
  const canvas = page.getByRole("img", {
    name: "心情涂鸦画布；不方便绘画时可使用上方文字复盘",
  });
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("drawing canvas missing");
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 70, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "保存复盘", exact: true }).click();
  await expect(
    page.getByText("文字、心情和涂鸦已一起保存", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "每日复盘", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("有什么想留给这一天？")).toHaveValue(
    "云端改造后本地复盘依然保存。",
  );
  await expect(page.getByLabel("查看复盘日期")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("flowday.workspace.v1")!).reviews[0]
          .drawing.length,
    ),
  ).toBe(1);
});

test("unconfigured login is honest and mobile workspace fits the viewport", async ({
  page,
}) => {
  await page.goto("/auth");
  await expect(
    page.getByText("云端服务尚未配置。当前数据仍保存在本浏览器，不会上传。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "继续本地体验" }).click();
  await expect(page.getByText("本地已保存", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("goals and calendar reservations save, resize and undo through the async persistence boundary", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "我的目标", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /种下一个新目标/ }).click();
  await page.getByLabel("你想实现什么？").fill("V1.1 测试目标");
  await page.getByRole("button", { name: "创建目标", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("flowday.workspace.v1")!).goals.some(
          (g: { title: string }) => g.title === "V1.1 测试目标",
        ),
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "计划日历", exact: true })
    .first()
    .click();
  const tomorrow = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  await page.getByLabel("跳转日期").fill(tomorrow);
  await page
    .getByRole("button", { name: /梳理个人项目的核心功能/ })
    .last()
    .click();
  // Editor is a labelled section; inputs are the keyboard/mobile alternative to drag.
  await page.getByLabel("预约分钟").fill("60");
  await page.getByRole("button", { name: "保存时间安排", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("flowday.workspace.v1")!).blocks[0]
            ?.end,
      ),
    )
    .toBe(600);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("flowday.workspace.v1")!).blocks
            .length,
      ),
    )
    .toBe(0);
});
