// Local UI evidence with isolated API fixtures; not production sign-in acceptance.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const base = process.env.BASE || "http://127.0.0.1:4317";
const out = process.env.OUT_DIR;
assert(out, "Set OUT_DIR to an evidence directory outside temporary runtimes");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(out, "result.json"),
  JSON.stringify({
    status: "running",
    scope: "local-frontend-isolated-api-fixtures",
  }),
);
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  headless: true,
});
const errors = [];
const checks = [];
const task = {
  id: "modal-task",
  ownerUserId: "ui-owner",
  agentId: null,
  title: "整理项目交付材料",
  description: "整理当前项目资料。",
  category: "project",
  level: 2,
  assessment: "待处理",
  risk: "read",
  status: "inbox",
  executor: "bot",
  dependencies: [],
  artifacts: [],
  usage: {},
  priority: 50,
  attempts: 0,
  maxAttempts: 3,
  timeoutSeconds: 900,
  planPrepared: false,
  version: 1,
  createdAt: "2026-11-13T00:00:00Z",
  updatedAt: "2026-11-13T00:00:00Z",
};
const counts = Object.fromEntries(
  [
    "inbox",
    "queued",
    "planning",
    "running",
    "waiting_dependencies",
    "waiting_approval",
    "paused",
    "succeeded",
    "failed",
    "cancelled",
  ].map((key) => [key, key === "inbox" ? 1 : 0]),
);

try {
  for (const [width, dark] of [
    [1280, false],
    [420, false],
    [1280, true],
  ].filter(
    ([width]) => !process.env.WIDTH || width === Number(process.env.WIDTH),
  )) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      isMobile: width < 600,
      hasTouch: width < 600,
    });
    await context.addInitScript(
      (dark) => localStorage.setItem("chisabot-theme", dark ? "dark" : "light"),
      dark,
    );
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const endpoint = url.pathname;
      const json = (body, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      if (endpoint === "/api/me")
        return json({
          user: {
            id: "ui-owner",
            name: "界面验证",
            email: "ui@example.invalid",
            role: "admin",
            onboarding: null,
            profileNeedsSetup: false,
          },
        });
      if (endpoint === "/api/task-center")
        return json({
          tasks: [task],
          outbox: [],
          sources: [],
          counts,
          running: true,
          concurrency: 2,
          decisionCounts: { pending: 0 },
        });
      if (endpoint === "/api/task-center/tasks")
        return json({
          tasks: url.searchParams.get("view") === "inbox" ? [task] : [],
          total: url.searchParams.get("view") === "inbox" ? 1 : 0,
          nextOffset: null,
        });
      if (endpoint === "/api/task-center/tasks/modal-task")
        return json({ task, events: [], children: [] });
      if (endpoint === "/api/task-center/outbox")
        return json({ outbox: [], total: 0, nextOffset: null });
      if (endpoint === "/api/task-center/capabilities")
        return json({ capabilities: [] });
      if (endpoint === "/api/task-center/allowed-roots")
        return json({ roots: [] });
      if (endpoint === "/api/agents") return json({ agents: [] });
      if (endpoint === "/api/workflows")
        return json({ workflows: [], runs: [], tools: [] });
      if (endpoint === "/api/approvals")
        return json({
          enabled: true,
          requests: [],
          questions: [],
          rules: [],
          teamRules: [],
        });
      if (endpoint === "/api/confirmations/requests")
        return json({ requests: [] });
      if (endpoint === "/api/channels")
        return json({ channels: [], nextCursor: null });
      if (endpoint === "/api/live-panels") return json({ items: [] });
      if (endpoint === "/api/settings/preferences")
        return json({ preferences: {} });
      if (endpoint === "/api/capabilities") return json({ authProviders: [] });
      if (endpoint === "/api/version")
        return json({ version: "modal-local-qa" });
      if (endpoint === "/api/schedules/events") return json({ events: [] });
      return json({ error: "未启用的界面验证接口" }, 404);
    });
    await page.goto(`${base}/approvals`);
    await page.locator(".glass-main .page-scroll").waitFor();
    await page.evaluate(() => {
      window.modalBackground = document.querySelector(
        ".glass-main .page-scroll",
      );
    });
    const account = page
      .getByRole("button", { name: "账号与设置", exact: true })
      .first();
    await account.click();
    await page.getByRole("menuitem", { name: "任务中心", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "任务中心", exact: true });
    await dialog.waitFor();
    const originalUrl = page.url();
    assert.equal(new URL(originalUrl).pathname, "/approvals");
    await page.getByRole("button", { name: /整理项目交付材料/ }).click();
    await dialog
      .getByRole("heading", { name: "任务详情", exact: true })
      .waitFor();
    assert.equal(page.url(), originalUrl);
    await dialog
      .getByRole("button", { name: "关闭任务详情", exact: true })
      .click();
    await dialog.getByRole("button", { name: "历史", exact: true }).click();
    await dialog
      .getByRole("heading", { name: "历史与交付", exact: true })
      .waitFor();
    assert.equal(page.url(), originalUrl);
    await dialog.getByRole("button", { name: /Inbox/ }).click();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: path.join(out, `modal-${width}-${dark ? "dark" : "light"}.png`),
    });
    const box = await dialog.boundingBox();
    assert(
      box &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= width + 1 &&
        box.y + box.height <= 901,
    );
    if (width === 420)
      assert(box.height >= 899, "手机弹层应全屏而不是受 85svh 限制");
    if (width === 420)
      assert.equal(
        await dialog.evaluate((node) => getComputedStyle(node).borderRadius),
        "0px",
      );
    const close = await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .boundingBox();
    const create = await dialog
      .getByRole("button", { name: "新建任务", exact: true })
      .boundingBox();
    assert(
      close &&
        create &&
        (close.x >= create.x + create.width ||
          close.y + close.height <= create.y ||
          create.y + create.height <= close.y),
      "关闭与新建按钮不可重叠",
    );
    await dialog.getByRole("button", { name: "新建任务", exact: true }).click();
    const createDialog = page
      .getByRole("dialog")
      .filter({ has: page.getByLabel("任务名称", { exact: true }) });
    await createDialog.waitFor();
    await page.keyboard.press("Escape");
    await createDialog.waitFor({ state: "hidden" });
    // Role hiding precedes the nested popup's exit animation and focus restoration.
    await page.locator(".tc-create-dialog").waitFor({ state: "detached" });
    await dialog.waitFor();
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".tc-dialog")
          ?.hasAttribute("data-nested-dialog-open"),
    );
    assert(
      await dialog
        .getByRole("button", { name: "新建任务", exact: true })
        .evaluate((node) => node === document.activeElement),
      "关闭新建应把焦点还给任务中心",
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(page.url(), originalUrl);
    assert(
      await page.evaluate(
        () =>
          window.modalBackground ===
          document.querySelector(".glass-main .page-scroll"),
      ),
      "底下的页面不可重新挂载",
    );
    await account.click();
    await page.getByRole("menuitem", { name: "任务中心", exact: true }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(page.url(), originalUrl);
    if (width === 1280) {
      await account.click();
      await page
        .getByRole("menuitem", { name: "任务中心", exact: true })
        .click();
      await dialog.waitFor();
      await page.mouse.click(4, 4);
      await dialog.waitFor({ state: "hidden" });
      assert.equal(page.url(), originalUrl);
    }
    checks.push(
      `${width}/${dark ? "dark" : "light"}: 菜单原位打开、详情、分区、Esc、关闭、重开，地址不变`,
    );
    // Old bookmarks still open the same modal and honor the selected task.
    await page.goto(`${base}/tasks?view=inbox&task=modal-task`);
    await dialog
      .getByRole("heading", { name: "任务详情", exact: true })
      .waitFor();
    checks.push(`${width}/${dark ? "dark" : "light"}: 旧任务深链接`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(
      {
        status: "passed",
        scope: "local-frontend-isolated-api-fixtures",
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, out }));
} catch (error) {
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(
      { status: "failed", checks, errors, failure: String(error) },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
