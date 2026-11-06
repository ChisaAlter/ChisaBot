// UI contract and visual QA against the real frontend with isolated API fixtures.
// This does not certify a live database, model execution, or external connectors.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const base = process.env.BASE || "http://127.0.0.1:4317";
const out =
  process.env.OUT_DIR || path.join(os.tmpdir(), "chisabot-task-center-ui");
fs.mkdirSync(out, { recursive: true });
const browserDir = path.join(process.env.LOCALAPPDATA, "ms-playwright");
const chromiumDir = fs
  .readdirSync(browserDir)
  .find((name) => name.startsWith("chromium-") && !name.includes("headless"));
const executablePath =
  process.env.CHROME ||
  path.join(browserDir, chromiumDir, "chrome-win64", "chrome.exe");
const now = "2026-11-06T08:30:00.000Z";
const statuses = [
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
];
const task = (id, title, status = "inbox", overrides = {}) => ({
  id,
  ownerUserId: "ui-owner",
  agentId: "bot-ui",
  title,
  description:
    "读取项目现有资料，梳理剩余事项、相关依赖和下一步建议，交付一份可审阅的 Markdown 报告。",
  category: "development",
  level: 3,
  assessment: "资料与工具已经具备，可以独立生成报告，后续代码修改另行安排。",
  risk: "read",
  status,
  executor: "bot",
  sourceId: null,
  sourceRef: null,
  sourceUrl: null,
  parentId: null,
  dependencies: [],
  planPrepared: false,
  priority: 70,
  attempts: 0,
  maxAttempts: 3,
  timeoutSeconds: 900,
  summary: null,
  artifacts: [],
  usage: {},
  error: null,
  createdAt: now,
  updatedAt: now,
  startedAt: null,
  finishedAt: null,
  nextAttemptAt: now,
  leaseExpiresAt: null,
  version: 1,
  ...overrides,
});
const agent = {
  id: "bot-ui",
  name: "工作助手",
  title: "整理与执行",
  roleDescription: "",
  avatarSeed: "ui",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};
const errors = [];
const mutations = [];
const checks = [];
const browser = await chromium.launch({ headless: true, executablePath });

async function setup(width, dark = false) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    locale: "zh-CN",
    colorScheme: dark ? "dark" : "light",
  });
  await context.addInitScript(
    (dark) => localStorage.setItem("chisabot-theme", dark ? "dark" : "light"),
    dark,
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const tasks = [
    task("inbox-1", "梳理 ChisaBot 项目尚未完成的工作"),
    task("inbox-2", "准备下一次项目讨论的背景材料", "inbox", {
      category: "documents",
      level: 2,
      priority: 55,
    }),
    task("active-1", "核对任务执行器与后台恢复路径", "running", {
      attempts: 1,
      startedAt: now,
    }),
    task("done-1", "项目状态报告", "succeeded", {
      summary: "已梳理 3 项待办，附上影响、依赖及建议顺序。",
      finishedAt: now,
      artifacts: [
        {
          name: "project-status.md",
          content: "# 项目状态\n\n待办与建议已整理。",
          mediaType: "text/markdown",
        },
      ],
    }),
    task("approval-1", "发送项目进展说明", "waiting_approval", {
      risk: "external",
      category: "communication",
      level: 4,
    }),
  ];
  const decisions = [
    {
      id: "decision-1",
      taskId: "approval-1",
      ownerUserId: "ui-owner",
      taskVersion: 1,
      summary: "项目报告已经准备好，发送前需要确认收件人与正文。",
      proposedAction: {
        title: "发送项目进展说明",
        description:
          "收件人：项目协作测试组\n正文：本周项目状态报告已整理，请查看已准备的附件。",
        executor: "bot",
        risk: "external",
      },
      status: "pending",
      createdAt: now,
      decidedAt: null,
      notificationError: null,
    },
  ];
  const sources = [];
  let personalContext = {
    responsibilities: "",
    projects: "",
    goals: "",
    interests: "",
    habits: "",
    preferences: "",
    updatedAt: null,
  };
  const capabilities = [
    {
      id: "bot",
      name: "ChisaBot 机器人",
      available: true,
      detail: "使用当前机器人的模型与工具权限。",
      kind: "executor",
    },
    {
      id: "codex",
      name: "Codex CLI",
      available: true,
      detail: "配置了本地执行入口。",
      kind: "executor",
    },
    {
      id: "pi",
      name: "Pi",
      available: false,
      detail: "尚未配置执行入口。",
      kind: "executor",
    },
    {
      id: "source:repository",
      name: "本地仓库",
      available: true,
      detail: "读取已允许目录中的待办文档。",
      kind: "source",
    },
    {
      id: "source:email",
      name: "邮件",
      available: false,
      detail: "请先在已连接账号中连接邮箱。",
      kind: "source",
    },
  ];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;
    const method = req.method();
    const data = method === "GET" ? null : req.postDataJSON();
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (method !== "GET") mutations.push({ pathname, method, data });
    if (pathname === "/api/me")
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
    if (pathname === "/api/agents") return json({ agents: [agent] });
    if (pathname === "/api/approvals")
      return json({ requests: [], questions: [], rules: [], teamRules: [] });
    if (pathname === "/api/confirmations/requests")
      return json({ requests: [] });
    if (pathname === "/api/channels")
      return json({ channels: [], nextCursor: null });
    if (pathname === "/api/live-panels") return json({ items: [] });
    if (pathname === "/api/settings/preferences")
      return json({ preferences: { mainBotId: "bot-ui" } });
    if (pathname === "/api/capabilities") return json({ authProviders: [] });
    if (pathname === "/api/version") return json({ version: "ui-fixture" });
    if (pathname === "/api/schedules/events") return json({ events: [] });
    if (pathname === "/api/task-center")
      return json({
        tasks,
        outbox: decisions,
        sources,
        counts: Object.fromEntries(
          statuses.map((status) => [
            status,
            tasks.filter((task) => task.status === status).length,
          ]),
        ),
        running: true,
        concurrency: 2,
      });
    if (pathname === "/api/task-center/capabilities")
      return json({ capabilities });
    if (pathname === "/api/task-center/context") {
      if (method === "PUT") personalContext = { ...data, updatedAt: now };
      return json({ context: personalContext });
    }
    if (pathname === "/api/task-center/tasks" && method === "POST") {
      const created = task(
        `created-${tasks.length}`,
        data.title,
        "inbox",
        data,
      );
      tasks.push(created);
      return json({ task: created }, 201);
    }
    const item = pathname.match(
      /^\/api\/task-center\/tasks\/([^/]+)(?:\/(start|pause|resume|retry|cancel))?$/,
    );
    if (item) {
      const current = tasks.find((task) => task.id === item[1]);
      if (!current) return json({ error: "找不到这个任务。" }, 404);
      if (item[2]) {
        current.status =
          item[2] === "pause"
            ? "paused"
            : item[2] === "cancel"
              ? "cancelled"
              : "queued";
        return json({ task: current });
      }
      return json({
        task: current,
        events: [
          {
            id: "event-1",
            taskId: current.id,
            type: "tool_call",
            message: "读取项目待办文档",
            data: { tool: "read_file", path: "docs/BACKLOG.md" },
            createdAt: now,
          },
        ],
        children: [],
      });
    }
    if (pathname.startsWith("/api/task-center/outbox/") && method === "POST") {
      decisions[0] = {
        ...decisions[0],
        status: data.approved ? "approved" : "rejected",
        decidedAt: now,
      };
      return json({ decision: decisions[0] });
    }
    if (pathname === "/api/task-center/sources" && method === "POST") {
      const source = {
        id: "source-created",
        ownerUserId: "ui-owner",
        ...data,
        nextRunAt: now,
        lastRunAt: null,
        lastStatus: "idle",
        lastError: null,
        failures: 0,
        createdAt: now,
        updatedAt: now,
      };
      sources.push(source);
      return json({ source });
    }
    if (pathname.endsWith("/source-created/scan")) {
      sources[0].lastStatus = "failed";
      sources[0].lastError = "指定目录不在允许读取的范围内。";
      return json({ error: sources[0].lastError }, 403);
    }
    if (pathname.endsWith("/source-created") && method === "PATCH") {
      sources[0] = { ...sources[0], ...data };
      return json({ source: sources[0] });
    }
    return json({ error: "未启用的界面验证接口" }, 404);
  });
  await page.goto(`${base}/tasks`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "任务中心", exact: true }).waitFor();
  await page
    .getByRole("button", { name: /梳理 ChisaBot 项目尚未完成的工作/ })
    .waitFor();
  return { page, context };
}
async function capture(page, file) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, file), fullPage: false });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false, `${file}: 页面不可横向溢出`);
}
try {
  const desktop = await setup(1280);
  const p = desktop.page;
  await capture(p, "desktop-inbox.png");
  await p
    .getByRole("button", { name: /梳理 ChisaBot 项目尚未完成的工作/ })
    .click();
  await p.getByRole("button", { name: "开始任务", exact: true }).click();
  await p
    .locator(".tc-detail .tc-status")
    .filter({ hasText: "排队中" })
    .waitFor();
  checks.push("Inbox 开始任务与详情状态同步");
  await p.getByRole("button", { name: /执行日志/ }).click();
  await p.getByText("读取项目待办文档", { exact: true }).waitFor();
  checks.push("工具调用事件可回溯");
  await p.getByRole("button", { name: "新建任务", exact: true }).click();
  await p.getByLabel("任务名称", { exact: true }).fill("界面契约验证任务");
  await p
    .getByLabel("目标与交付标准", { exact: true })
    .fill("生成可下载的项目状态摘要。");
  await p.getByRole("button", { name: "创建并开始", exact: true }).click();
  await p
    .locator(".tc-detail h3")
    .filter({ hasText: "界面契约验证任务" })
    .waitFor();
  assert(
    mutations.some(
      (mutation) =>
        mutation.pathname === "/api/task-center/tasks" &&
        mutation.data.title === "界面契约验证任务",
    ),
  );
  checks.push("任务创建提交真实字段并开始");
  await p.getByRole("button", { name: "信息源", exact: true }).click();
  await p.getByRole("button", { name: "添加来源", exact: true }).click();
  await p.getByLabel("名称", { exact: true }).fill("验证仓库");
  await p
    .getByLabel("仓库完整路径", { exact: true })
    .fill("C:\\Projects\\example");
  await p.getByRole("button", { name: /保存来源|添加并启用|保存并/ }).click();
  await p.getByRole("button", { name: "立即巡检", exact: true }).click();
  await p
    .getByText("指定目录不在允许读取的范围内。", { exact: true })
    .waitFor();
  checks.push("来源创建与巡检失败反馈");
  await p.getByRole("button", { name: "我的上下文", exact: true }).click();
  await p
    .getByLabel("正在推进的项目", { exact: true })
    .fill("完善任务中心的真实闭环。");
  await p.getByRole("button", { name: "保存上下文", exact: true }).click();
  await p.getByText(/上次更新：/).waitFor();
  checks.push("个人上下文保存");
  await capture(p, "desktop-context.png");
  await desktop.context.close();

  const mobile = await setup(420);
  await mobile.page.getByRole("button", { name: /Outbox/ }).click();
  await mobile.page
    .locator('.tc-nav-item[aria-current="page"]')
    .filter({ hasText: "Outbox" })
    .waitFor();
  await capture(mobile.page, "mobile-outbox.png");
  await mobile.page.getByRole("button", { name: "拒绝", exact: true }).click();
  await mobile.page
    .getByRole("heading", { name: "暂时没有待确认事项" })
    .waitFor();
  assert(
    mutations.some(
      (mutation) =>
        mutation.pathname.includes("/outbox/") &&
        mutation.data.approved === false,
    ),
  );
  checks.push("窄屏 Outbox 拒绝准确操作");
  await mobile.context.close();

  const dark = await setup(1280, true);
  await dark.page.getByRole("button", { name: "历史", exact: true }).click();
  await dark.page.getByRole("button", { name: /项目状态报告/ }).click();
  await dark.page.getByText("project-status.md", { exact: true }).waitFor();
  const download = dark.page.waitForEvent("download");
  await dark.page.getByRole("button", { name: "下载", exact: true }).click();
  assert.equal((await download).suggestedFilename(), "project-status.md");
  await capture(dark.page, "desktop-dark-artifact.png");
  checks.push("暗色交付物预览和下载");
  await dark.context.close();
  assert.deepEqual(errors, [], "前端不得有未处理异常");
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(
      {
        scope: "frontend-with-isolated-api-fixtures",
        checks,
        errors,
        screenshots: out,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, checks, out }));
} finally {
  await browser.close();
}
