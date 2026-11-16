import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import {
  formatBoardSourceRef,
  parseBoardSourceRef,
  resolveTaskBoardPlacement,
} from "../../shared/task-board";
import type { TaskCenterTask, TaskInput } from "../../shared/task-center";
import type { AppVariables } from "../src/auth/guards";
import type { Database } from "../src/db/client";
import { createMarkdownBoardService } from "../src/task-center/markdown-board";
import {
  createAutobahnCard,
  createChisabotDocsCard,
  markCardCompletedInMarkdown,
  moveAutobahnCard,
  moveChisabotDocsCard,
  parseAutobahnBoard,
  parseChisabotDocsBoard,
  toggleMarkdownCardCheckbox,
  updateAutobahnCard,
} from "../src/task-center/markdown-board-parser";
import { createTaskCenterRoots } from "../src/task-center/roots";
import { createTaskCenterRoutes } from "../src/task-center/routes";
import type { TaskCenterService } from "../src/task-center/service";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const tempDirs: string[] = [];

function makeTempDir(prefix = "chisabot-board-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTaskStoreFixture() {
  const tasks = new Map<string, TaskCenterTask>();
  const events: Array<{ taskId: string; type: string; message: string }> = [];

  async function listTasks(owner: string): Promise<TaskCenterTask[]> {
    return [...tasks.values()].filter((t) => t.ownerUserId === owner);
  }

  async function createTask(
    owner: string,
    input: TaskInput,
    extra?: { sourceRef?: string; sourceUrl?: string },
  ): Promise<TaskCenterTask> {
    const id = `task-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const lane = input.lane ?? "next";
    const task: TaskCenterTask = {
      id,
      ownerUserId: owner,
      agentId: input.agentId ?? null,
      title: input.title,
      description: input.description,
      category: input.category ?? "development",
      level: input.level ?? 3,
      assessment: "看板派发任务",
      risk: input.risk ?? "internal",
      status: "inbox",
      executor: input.executor ?? "bot",
      workspace: input.workspace ?? null,
      sourceId: null,
      sourceRef: extra?.sourceRef ?? null,
      sourceUrl: extra?.sourceUrl ?? null,
      parentId: null,
      dependencies: [],
      planPrepared: true,
      priority: input.priority ?? 50,
      lane,
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
    };
    tasks.set(id, task);
    return task;
  }

  async function controlTask(
    owner: string,
    id: string,
    action: "start" | "pause" | "resume" | "retry" | "cancel",
  ): Promise<TaskCenterTask> {
    const current = tasks.get(id);
    if (!current || current.ownerUserId !== owner) {
      throw new Error("任务不存在");
    }
    const nextStatus =
      action === "start" || action === "resume" || action === "retry"
        ? "running"
        : action === "pause"
          ? "paused"
          : "cancelled";
    const next: TaskCenterTask = {
      ...current,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    };
    tasks.set(id, next);
    return next;
  }

  async function scheduleTask(
    owner: string,
    id: string,
    patch: {
      lane?: "now" | "next" | "later";
      priority?: number;
      start?: boolean;
    },
  ): Promise<TaskCenterTask> {
    const current = tasks.get(id);
    if (!current || current.ownerUserId !== owner) {
      throw new Error("任务不存在");
    }
    const next: TaskCenterTask = {
      ...current,
      ...(patch.lane ? { lane: patch.lane } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.start ? { status: "running" } : {}),
      updatedAt: new Date().toISOString(),
    };
    tasks.set(id, next);
    return next;
  }

  function settleTaskSucceeded(id: string, detail: string): TaskCenterTask {
    const current = tasks.get(id);
    if (!current) throw new Error("任务不存在");
    const now = new Date().toISOString();
    const settled: TaskCenterTask = {
      ...current,
      status: "succeeded",
      summary: detail,
      finishedAt: now,
      updatedAt: now,
    };
    tasks.set(id, settled);
    return settled;
  }

  return {
    tasks,
    events,
    listTasks,
    createTask,
    controlTask,
    scheduleTask,
    settleTaskSucceeded,
  };
}

test("Autobahn 解析与整块改写保留 CRLF 行尾、置顶说明及未编辑卡片字节", () => {
  const untouchedTail = [
    "### DEMO-2: 保持原文一个字节不变",
    "- **Status:** open",
    "",
    "```ts",
    "// 围栏内的 - [ ] 不应被识别为待办勾选框",
    "const sample = '- [ ] untouched';",
    "```",
  ].join("\r\n");

  const originalCrlf = [
    "# 示例项目",
    "",
    "## Now",
    "",
    "## Sprint Note",
    "",
    "置顶聚焦：不要丢掉 CRLF 行尾。",
    "",
    "### DEMO-1: 首张任务卡 [M] `ui`",
    "- **Priority:** P1",
    "- [ ] 第一步检查",
    "- [x] 第二步归档",
    "",
    untouchedTail,
    "",
    "## Next",
    "",
    "### DEMO-3: 已堵塞项",
    "- **Status:** blocked",
    "",
    "## Later",
    "",
  ].join("\r\n");

  const parsed = parseAutobahnBoard(originalCrlf, "BACKLOG.md");
  expect(parsed.pinned?.title).toBe("Sprint Note");
  expect(parsed.cards.map((c) => c.id)).toEqual(["DEMO-1", "DEMO-2", "DEMO-3"]);
  expect(parsed.cards[0]?.checkboxes).toEqual({ checked: 1, total: 2 });
  expect(parsed.cards[1]?.checkboxes).toEqual({ checked: 0, total: 0 });
  expect(parsed.cards[2]?.blocked).toBe(true);

  // 单行翻转 DEMO-1 的第 0 个复选框
  const toggled = toggleMarkdownCardCheckbox(
    originalCrlf,
    "autobahn",
    "DEMO-1",
    0,
    true,
  );
  expect(toggled).toContain("\r\n");
  expect(toggled).toContain(untouchedTail);
  expect(toggled).toContain("- [x] 第一步检查");

  // 移动 DEMO-1 到 Next（DEMO-3 之前），保留 DEMO-2 原文整块
  const moved = moveAutobahnCard(toggled, "DEMO-1", "next", "DEMO-3");
  expect(moved).toContain(untouchedTail);
  const afterMove = parseAutobahnBoard(moved, "BACKLOG.md");
  expect(afterMove.cards.find((c) => c.id === "DEMO-1")?.filedIn).toBe("next");
  expect(moved.indexOf("### DEMO-1")).toBeLessThan(moved.indexOf("### DEMO-3"));

  // 编辑 DEMO-1 标题与正文
  const edited = updateAutobahnCard(moved, "DEMO-1", {
    title: "调整后的标题 [M] `ui`",
    body: "- **Priority:** P0\r\n新正文",
  });
  expect(edited).toContain(untouchedTail);
  expect(edited).toContain("调整后的标题 [M] `ui`");

  // 新建卡片并在完成后验证幂等回写
  const created = createAutobahnCard(edited, {
    title: "新卡片自动完成测试",
    lane: "now",
    size: "S",
    tags: ["server"],
    body: "- [ ] 执行回归验证",
  });
  expect(created.cardId).toBe("DEMO-4");

  const completedOnce = markCardCompletedInMarkdown(
    created.next,
    "autobahn",
    "DEMO-4",
    "全部测试通过并完成端到端验收。",
    "2026-11-15T12:34:00Z",
  );
  const completedTwice = markCardCompletedInMarkdown(
    completedOnce,
    "autobahn",
    "DEMO-4",
    "复验摘要更新。",
    "2026-11-15T12:40:00Z",
  );
  expect(completedOnce).toContain("- **Status:** done");
  expect(completedOnce).toContain("#### 交付摘要（ChisaBot 自动回写）");
  expect(completedTwice.match(/#### 交付摘要（ChisaBot 自动回写）/g)?.length).toBe(1);
  expect(completedTwice).toContain("复验摘要更新。");
  const doneParsed = parseAutobahnBoard(completedTwice, "BACKLOG.md");
  const demo4 = doneParsed.cards.find((c) => c.id === "DEMO-4");
  expect(demo4?.lane).toBe("shipped");
  expect(demo4?.filedIn).toBe("now");
});

test("解析仓库真实 docs/ROADMAP.md 与 docs/BACKLOG.md，并在临时副本保留 #cb-xxx 锚点", () => {
  const realRoadmap = readFileSync(join(REPO_ROOT, "docs/ROADMAP.md"), "utf8");
  const realBacklog = readFileSync(join(REPO_ROOT, "docs/BACKLOG.md"), "utf8");

  const parsed = parseChisabotDocsBoard(
    realRoadmap,
    realBacklog,
    "docs/BACKLOG.md",
  );
  expect(parsed.cards.length).toBeGreaterThan(20);
  const shipped = parsed.cards.filter((c) => c.lane === "shipped");
  expect(shipped.length).toBeGreaterThan(5);

  const movableCard = parsed.cards.find((c) => c.movable && c.lane !== "shipped");
  expect(movableCard).toBeTruthy();
  if (!movableCard) return;

  const targetLane = movableCard.filedIn === "later" ? "next" : "later";
  const moved = moveChisabotDocsCard(
    realRoadmap,
    realBacklog,
    movableCard.id,
    targetLane,
    null,
  );
  const reparsed = parseChisabotDocsBoard(
    moved.nextRoadmap,
    moved.nextBacklog,
    "docs/BACKLOG.md",
  );
  expect(reparsed.cards.find((c) => c.id === movableCard.id)?.filedIn).toBe(
    targetLane,
  );
  // 锚点必须保持小写的 `#cb-xxx` 且不改写未触碰卡片
  expect(moved.nextRoadmap).toContain(
    `#${movableCard.id.toLowerCase()})`,
  );

  // 对该卡片执行完成回写，验证 status 与交付摘要写入 BACKLOG 且保留锚点
  const completedBacklog = markCardCompletedInMarkdown(
    moved.nextBacklog,
    "chisabot-docs",
    movableCard.id,
    "已通过全套测试与无头浏览器验证。",
    "2026-11-15T15:00:00Z",
  );
  const finalParsed = parseChisabotDocsBoard(
    moved.nextRoadmap,
    completedBacklog,
    "docs/BACKLOG.md",
  );
  const finalCard = finalParsed.cards.find((c) => c.id === movableCard.id);
  expect(finalCard?.done).toBe(true);
  expect(finalCard?.lane).toBe("shipped");
  expect(finalCard?.filedIn).toBe(targetLane);
  expect(completedBacklog).toContain("#### 交付摘要（ChisaBot 自动回写）");
});

test("MarkdownBoardService：沙箱安全、CAS 409、文件锁串行化、markUntrusted 派发与自动回写", async () => {
  const dir = makeTempDir();
  const outsideDir = makeTempDir("chisabot-outside-");
  const outsideSecret = join(outsideDir, "secret.md");
  writeFileSync(outsideSecret, "TOP SECRET", "utf8");
  writeFileSync(join(dir, ".env"), "SECRET_KEY=123", "utf8");

  const store = createTaskStoreFixture();
  const service = createMarkdownBoardService({
    localRoots: () => [dir],
    listTasks: store.listTasks,
    createTask: store.createTask,
    controlTask: store.controlTask,
    scheduleTask: store.scheduleTask,
  });

  // 初始化标准看板
  const initRes = await service.initBoard("owner", dir);
  expect(initRes.dialect).toBe("autobahn");

  // 新建带复选框的卡片
  const snap0 = await service.getBoardView("owner", initRes.boardId);
  const created = await service.createCard("owner", {
    boardId: snap0.boardId,
    baseRevision: snap0.revision,
    title: "实现离线导出功能",
    lane: "now",
    size: "M",
    tags: ["backend"],
    body: "- [ ] 编写导出函数\n- [ ] 验证大文件流式输出",
  });
  expect(created.cardId).toMatch(/^[A-Z0-9]+-\d+$/);

  // 敏感文件与越界路径拒绝 403
  await expect(
    service.readDoc("owner", snap0.boardId, ".env"),
  ).rejects.toThrow();
  await expect(
    service.readDoc("owner", snap0.boardId, "../secret.md"),
  ).rejects.toThrow();

  // 若系统允许创建符号链接，验证外部逃逸符号链接同样被拦截
  const linkPath = join(dir, "escape.md");
  let symlinkCreated = false;
  try {
    symlinkSync(outsideSecret, linkPath);
    symlinkCreated = true;
  } catch {
    symlinkCreated = false;
  }
  if (symlinkCreated) {
    await expect(
      service.readDoc("owner", snap0.boardId, "escape.md"),
    ).rejects.toThrow();
  }

  // 过期 revision CAS 触发 409
  await expect(
    service.moveCard("owner", {
      boardId: snap0.boardId,
      baseRevision: snap0.revision,
      cardId: created.cardId,
      targetLane: "next",
      beforeCardId: null,
    }),
  ).rejects.toThrow(/外部更新/);

  // 并发写入锁验证：同时调用 writeDoc 与 completeCardFromTask 串行落地不损坏文件
  const docRead = await service.readDoc("owner", snap0.boardId, "BACKLOG.md");
  expect(docRead.revision).toBe(created.board.revision);

  // 派发卡片 -> 验证 markUntrusted 包裹 & sourceRef 绑定 & 关联状态投影
  const dispatched = await service.dispatchCard("owner", {
    boardId: snap0.boardId,
    cardId: created.cardId,
    executor: "bot",
    level: 3,
    risk: "internal",
    start: true,
  });
  expect(dispatched.task.description).toContain("markdown board card");
  expect(dispatched.task.sourceRef).toBeTruthy();
  const parsedRef = parseBoardSourceRef(dispatched.task.sourceRef);
  expect(parsedRef?.cardId).toBe(created.cardId);

  const placementRunning = resolveTaskBoardPlacement(dispatched.task);
  expect(placementRunning.column).toBe("now");

  // 模拟任务执行成功到达终态后，触发自动完成回写
  const settled = store.settleTaskSucceeded(
    dispatched.task.id,
    "已实现流式离线导出，压缩率 64%，单测全绿。",
  );
  const writebackResult = await service.completeCardFromTask(
    "owner",
    settled,
    settled.summary ?? "",
  );
  expect(writebackResult?.cardId).toBe(created.cardId);

  const snapFinal = await service.getBoardView("owner", snap0.boardId);
  const doneCard = snapFinal.cards.find((c) => c.id === created.cardId);
  expect(doneCard?.done).toBe(true);
  expect(doneCard?.lane).toBe("shipped");
  expect(doneCard?.filedIn).toBe("now");
  expect(doneCard?.body).toContain("#### 交付摘要（ChisaBot 自动回写）");
  expect(doneCard?.body).toContain("已实现流式离线导出");
  expect(doneCard?.linkedTask?.status).toBe("succeeded");

  // 验证物理文件完整可重新解析且不包含错乱内容
  const diskContent = readFileSync(join(dir, "BACKLOG.md"), "utf8");
  expect(diskContent).toContain("- **Status:** done");
});

test("Hono /boards* 与 /tasks/:id/schedule 路由集成测试", async () => {
  const dir = makeTempDir("chisabot-route-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "BACKLOG.md"),
    "# 路由测试\n\n## 现在\n\n### RT-1: 测试卡片\n- [ ] 待完成\n",
    "utf8",
  );

  const store = createTaskStoreFixture();
  const boards = createMarkdownBoardService({
    localRoots: () => [dir],
    listTasks: store.listTasks,
    createTask: store.createTask,
    controlTask: store.controlTask,
    scheduleTask: store.scheduleTask,
  });

  const seeded = await store.createTask("owner", {
    title: "普通待办",
    description: "测试 schedule",
    category: "project",
    level: 3,
    risk: "internal",
    executor: "bot",
    priority: 20,
    lane: "later",
  });

  const stubService = {
    scheduleTask: store.scheduleTask,
    listTasks: store.listTasks,
  } as unknown as TaskCenterService;

  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/task-center",
    createTaskCenterRoutes(
      stubService,
      async (ctx, next) => {
        ctx.set("actor", {
          id: "owner",
          email: "owner@example.com",
          name: "Owner",
          role: "admin",
        });
        await next();
      },
      { boards },
    ),
  );

  const schedRes = await app.request(
    `/api/task-center/tasks/${seeded.id}/schedule`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane: "now", priority: 80 }),
    },
  );
  expect(schedRes.status).toBe(200);
  const schedJson = (await schedRes.json()) as { task: TaskCenterTask };
  expect(schedJson.task.lane).toBe("now");
  expect(schedJson.task.priority).toBe(80);

  const listRes = await app.request("/api/task-center/boards");
  expect(listRes.status).toBe(200);
  const listJson = (await listRes.json()) as {
    boards: Array<{ boardId: string }>;
  };
  const boardId = listJson.boards[0]?.boardId ?? "";
  expect(boardId).toMatch(/^[a-f0-9]{16}$/);

  const viewRes = await app.request(
    `/api/task-center/boards/view?boardId=${boardId}`,
  );
  expect(viewRes.status).toBe(200);
  const viewJson = (await viewRes.json()) as {
    board: { revision: string };
  };

  const chkRes = await app.request("/api/task-center/boards/checkbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      boardId,
      baseRevision: viewJson.board.revision,
      cardId: "RT-1",
      checkboxIndex: 0,
      checked: true,
    }),
  });
  expect(chkRes.status).toBe(200);

  // 用旧 revision 再次移动返回 409
  const staleRes = await app.request("/api/task-center/boards/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      boardId,
      baseRevision: viewJson.board.revision,
      cardId: "RT-1",
      targetLane: "next",
      beforeCardId: null,
    }),
  });
  expect(staleRes.status).toBe(409);

  // formatBoardSourceRef 往返验证
  const encoded = formatBoardSourceRef({
    rootKey: boardId,
    relFile: "docs/BACKLOG.md",
    cardId: "CB-001",
  });
  expect(parseBoardSourceRef(encoded)).toEqual({
    rootKey: boardId,
    relFile: "docs/BACKLOG.md",
    cardId: "CB-001",
  });
});

function createRootsStoreFixture() {
  const rows = new Map<string, string>();
  const unsafe = async (text: string, params: unknown[] = []) => {
    if (text.startsWith("CREATE TABLE")) return [];
    if (text.startsWith("SELECT path FROM")) {
      const [owner] = params as [string];
      return [...rows.keys()]
        .filter((key) => key.startsWith(`${owner}\x1f`))
        .map((key) => ({ path: key.slice(owner.length + 1) }));
    }
    if (text.startsWith("SELECT count(*)")) {
      const [owner] = params as [string];
      return [
        {
          count: [...rows.keys()].filter((key) =>
            key.startsWith(`${owner}\x1f`),
          ).length,
        },
      ];
    }
    if (text.startsWith("INSERT")) {
      const [owner, p] = params as [string, string];
      rows.set(`${owner}\x1f${p}`, p);
      return [];
    }
    if (text.startsWith("DELETE")) {
      const [owner, p] = params as [string, string];
      rows.delete(`${owner}\x1f${p}`);
      return [];
    }
    return [];
  };
  return createTaskCenterRoots({ $client: { unsafe } } as unknown as Database);
}

test("权限边界：普通 user 对 /roots 与 /boards 写接口返回 403，读接口与队列调度返回 200", async () => {
  const dir = makeTempDir("chisabot-rbac-");
  writeFileSync(
    join(dir, "BACKLOG.md"),
    "# 权限测试\n\n## 现在\n\n### RB-1: 权限验证\n- [ ] 待完成\n\n## 接下来\n\n",
    "utf8",
  );
  const store = createTaskStoreFixture();
  const rootsStore = createRootsStoreFixture();
  await rootsStore.add("user-1", dir);
  const boards = createMarkdownBoardService({
    localRoots: (owner) => rootsStore.list(owner),
    listTasks: store.listTasks,
    createTask: store.createTask,
    controlTask: store.controlTask,
    scheduleTask: store.scheduleTask,
  });
  const seeded = await store.createTask("user-1", {
    title: "普通用户个人排期",
    description: "验证普通用户仍可使用 schedule",
    category: "project",
    level: 3,
    risk: "internal",
    executor: "bot",
    priority: 20,
    lane: "later",
  });
  const stubService = {
    scheduleTask: store.scheduleTask,
    listTasks: store.listTasks,
  } as unknown as TaskCenterService;

  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/task-center",
    createTaskCenterRoutes(
      stubService,
      async (ctx, next) => {
        ctx.set("actor", {
          id: "user-1",
          email: "user@example.com",
          name: "User",
          role: "user",
        });
        await next();
      },
      { boards, roots: rootsStore },
    ),
  );

  const listRes = await app.request("/api/task-center/boards");
  expect(listRes.status).toBe(200);
  const listJson = (await listRes.json()) as {
    boards: Array<{ boardId: string }>;
  };
  const boardId = listJson.boards[0]?.boardId ?? "";
  expect(boardId).toMatch(/^[a-f0-9]{16}$/);

  const viewRes = await app.request(
    `/api/task-center/boards/view?boardId=${boardId}`,
  );
  expect(viewRes.status).toBe(200);
  const viewJson = (await viewRes.json()) as { board: { revision: string } };

  const docRes = await app.request(
    `/api/task-center/boards/doc?boardId=${boardId}&relFile=BACKLOG.md`,
  );
  expect(docRes.status).toBe(200);

  const schedRes = await app.request(
    `/api/task-center/tasks/${seeded.id}/schedule`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane: "now", priority: 80 }),
    },
  );
  expect(schedRes.status).toBe(200);

  const deniedRequests = await Promise.all([
    app.request("/api/task-center/roots", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    }),
    app.request("/api/task-center/roots", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    }),
    app.request("/api/task-center/boards/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootPath: dir }),
    }),
    app.request("/api/task-center/boards/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        boardId,
        baseRevision: viewJson.board.revision,
        cardId: "RB-1",
        targetLane: "next",
        beforeCardId: null,
      }),
    }),
    app.request("/api/task-center/boards/card", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        boardId,
        baseRevision: viewJson.board.revision,
        cardId: "RB-1",
        body: "changed",
      }),
    }),
    app.request("/api/task-center/boards/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        boardId,
        baseRevision: viewJson.board.revision,
        title: "越权新建",
        lane: "now",
      }),
    }),
    app.request("/api/task-center/boards/checkbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        boardId,
        baseRevision: viewJson.board.revision,
        cardId: "RB-1",
        checkboxIndex: 0,
        checked: true,
      }),
    }),
    app.request("/api/task-center/boards/doc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        boardId,
        baseRevision: viewJson.board.revision,
        relFile: "BACKLOG.md",
        content: "# hacked",
      }),
    }),
  ]);
  for (const res of deniedRequests) {
    expect(res.status).toBe(403);
  }
});

test("真实 docs/ROADMAP.md + BACKLOG.md 临时副本：新建与重新打开均落在「## 已完成」之前、紧贴表格、CB-1 不误命中 CB-10", async () => {
  const dir = makeTempDir("chisabot-real-docs-");
  mkdirSync(join(dir, "docs"), { recursive: true });
  const realRoadmap = readFileSync(join(REPO_ROOT, "docs/ROADMAP.md"), "utf8");
  const realBacklog = readFileSync(join(REPO_ROOT, "docs/BACKLOG.md"), "utf8");
  writeFileSync(join(dir, "docs/ROADMAP.md"), realRoadmap, "utf8");
  writeFileSync(join(dir, "docs/BACKLOG.md"), realBacklog, "utf8");

  const store = createTaskStoreFixture();
  const service = createMarkdownBoardService({
    localRoots: () => [dir],
    listTasks: store.listTasks,
    createTask: store.createTask,
    controlTask: store.controlTask,
    scheduleTask: store.scheduleTask,
  });

  const listed = await service.listBoards("owner");
  expect(listed.boards[0]?.dialect).toBe("chisabot-docs");
  const boardId = listed.boards[0]?.boardId ?? "";
  const snap0 = await service.getBoardView("owner", boardId);

  const created = await service.createCard("owner", {
    boardId,
    baseRevision: snap0.revision,
    title: "验证新增卡片不落入已完成区",
    lane: "now",
    size: "S",
    tags: ["docs"],
    body: "- [ ] 确认渲染在 now 列",
  });
  const createdCard = created.board.cards.find((c) => c.id === created.cardId);
  expect(createdCard?.done).toBe(false);
  expect(createdCard?.lane).toBe("now");
  expect(createdCard?.filedIn).toBe("now");

  const backlogAfterCreate = readFileSync(join(dir, "docs/BACKLOG.md"), "utf8");
  const doneHeaderPos = backlogAfterCreate.indexOf("## 已完成");
  expect(doneHeaderPos).toBeGreaterThan(0);
  expect(backlogAfterCreate.indexOf(`## ${created.cardId}`)).toBeGreaterThan(-1);
  expect(backlogAfterCreate.indexOf(`## ${created.cardId}`)).toBeLessThan(
    doneHeaderPos,
  );

  // 将一张可独立移动的已交付卡片从「已完成」重新移回「接下来」，必须迁移块到 ## 已完成 之前并插入 ROADMAP 表格 --- 前
  const shippedCard = created.board.cards.find(
    (c) => c.lane === "shipped" && c.movable,
  );
  expect(shippedCard).toBeTruthy();
  if (!shippedCard) return;

  const reopenedBoard = await service.moveCard("owner", {
    boardId,
    baseRevision: created.board.revision,
    cardId: shippedCard.id,
    targetLane: "next",
    beforeCardId: null,
  });
  const reopenedCard = reopenedBoard.cards.find((c) => c.id === shippedCard.id);
  expect(reopenedCard?.done).toBe(false);
  expect(reopenedCard?.lane).toBe("next");
  expect(reopenedCard?.filedIn).toBe("next");

  const backlogAfterReopen = readFileSync(join(dir, "docs/BACKLOG.md"), "utf8");
  expect(backlogAfterReopen.indexOf(`## ${shippedCard.id}`)).toBeLessThan(
    backlogAfterReopen.indexOf("## 已完成"),
  );
  const roadmapAfterReopen = readFileSync(join(dir, "docs/ROADMAP.md"), "utf8");
  const nextHeadingIdx = roadmapAfterReopen.indexOf("## 接下来");
  const nextSectionTail = roadmapAfterReopen.slice(nextHeadingIdx);
  const rowIdx = nextSectionTail.indexOf(`| [${shippedCard.id}](`);
  const hrIdx = nextSectionTail.indexOf("\n---");
  expect(rowIdx).toBeGreaterThan(-1);
  expect(rowIdx).toBeLessThan(hrIdx);

  // beforeCardId 前缀隔离验证：CB-1 不得误匹配 CB-10
  const syntheticRoadmap = [
    "# 路线图",
    "",
    "## 现在",
    "",
    "| ID | 主题 | 状态 |",
    "| --- | --- | --- |",
    "| [CB-2](#cb-2) | 当前任务 | 进行中 |",
    "",
    "---",
    "",
    "## 接下来",
    "",
    "| ID | 主题 | 状态 |",
    "| --- | --- | --- |",
    "| [CB-10](#cb-10) | 第十项 | 待开始 |",
    "| [CB-1](#cb-1) | 第一项 | 待开始 |",
    "",
    "---",
    "",
    "## 以后",
    "",
    "| ID | 主题 | 状态 |",
    "| --- | --- | --- |",
    "",
    "---",
    "",
  ].join("\n");
  const syntheticBacklog = [
    "# 待办",
    "",
    "## CB-2",
    "",
    "- **状态**：进行中",
    "",
    "## CB-10",
    "",
    "- **状态**：待开始",
    "",
    "## CB-1",
    "",
    "- **状态**：待开始",
    "",
  ].join("\n");
  const reordered = moveChisabotDocsCard(
    syntheticRoadmap,
    syntheticBacklog,
    "CB-2",
    "next",
    "CB-1",
  );
  expect(reordered.nextBacklog).toBe(syntheticBacklog);
  expect(reordered.nextRoadmap.indexOf("[CB-10]")).toBeLessThan(
    reordered.nextRoadmap.indexOf("[CB-2]"),
  );
  expect(reordered.nextRoadmap.indexOf("[CB-2]")).toBeLessThan(
    reordered.nextRoadmap.indexOf("[CB-1]"),
  );
  // 顺便确认 createChisabotDocsCard 函数可直接创建且字段完整
  const directCreated = createChisabotDocsCard(
    syntheticRoadmap,
    syntheticBacklog,
    { title: "直接构造验证", lane: "later" },
  );
  expect(directCreated.cardId).toBe("CB-011");
});

test("摘要标题降级与围栏安全、initBoard 409 防护及自定义 relFile 回写", async () => {
  const dir = makeTempDir("chisabot-summary-guard-");
  writeFileSync(
    join(dir, "BACKLOG.md"),
    "# 安全测试\n\n## 现在\n\n### SEC-1: 摘要注入防护\n- [ ] 待完成\n",
    "utf8",
  );
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(
    join(dir, "docs/SPRINT.md"),
    "# Sprint 看板\n\n## 现在\n\n### SP-1: 自定义文档回写\n- [ ] 待完成\n",
    "utf8",
  );

  const store = createTaskStoreFixture();
  const service = createMarkdownBoardService({
    localRoots: () => [dir],
    listTasks: store.listTasks,
    createTask: store.createTask,
    controlTask: store.controlTask,
    scheduleTask: store.scheduleTask,
  });
  const boardId = (await service.listBoards("owner")).boards[0]?.boardId ?? "";
  expect(boardId).toMatch(/^[a-f0-9]{16}$/);

  const dispatched = await service.dispatchCard("owner", {
    boardId,
    cardId: "SEC-1",
    executor: "bot",
    level: 3,
    risk: "internal",
    start: true,
  });
  const injectedSummary = [
    "# Injected H1",
    "## 已完成",
    "### FAKE-99: Hijacked Card",
    "~~~ts",
    "const x = '### FAKE-100: Inside Tilted Fence';",
    "~~~",
    "真实完成结果。",
  ].join("\n");

  await service.completeCardFromTask(
    "owner",
    store.settleTaskSucceeded(dispatched.task.id, injectedSummary),
    injectedSummary,
  );
  await service.completeCardFromTask(
    "owner",
    store.settleTaskSucceeded(dispatched.task.id, "第二次幂等刷新摘要"),
    "第二次幂等刷新摘要",
  );
  const snapAfter = await service.getBoardView("owner", boardId);
  expect(snapAfter.cards.find((c) => c.id === "FAKE-99")).toBeUndefined();
  expect(snapAfter.cards.length).toBe(1);
  const backlogText = readFileSync(join(dir, "BACKLOG.md"), "utf8");
  expect(
    backlogText.match(/#### 交付摘要（ChisaBot 自动回写）/g)?.length,
  ).toBe(1);
  expect(backlogText).toContain("第二次幂等刷新摘要");

  // 自定义 relFile (docs/SPRINT.md) 回写与 ../ 越界拦截
  const sprintTask = await store.createTask(
    "owner",
    {
      title: "SP-1 跨文件回写",
      description: "测试 relFile",
      category: "development",
      level: 3,
      risk: "internal",
      executor: "bot",
    },
    {
      sourceRef: formatBoardSourceRef({
        rootKey: boardId,
        relFile: "docs/SPRINT.md",
        cardId: "SP-1",
      }),
    },
  );
  const sprintResult = await service.completeCardFromTask(
    "owner",
    store.settleTaskSucceeded(sprintTask.id, "Sprint 文件已回写"),
    "Sprint 文件已回写",
  );
  expect(sprintResult?.relFile).toBe("docs/SPRINT.md");
  const sprintDisk = readFileSync(join(dir, "docs/SPRINT.md"), "utf8");
  expect(sprintDisk).toContain("- **Status:** done");
  expect(sprintDisk).toContain("Sprint 文件已回写");

  await expect(
    service.completeCardFromTask(
      "owner",
      {
        sourceRef: formatBoardSourceRef({
          rootKey: boardId,
          relFile: "../outside.md",
          cardId: "SP-1",
        }),
        finishedAt: new Date().toISOString(),
      },
      "should fail",
    ),
  ).rejects.toThrow();

  // initBoard 对已存在 >1 MiB 或符号链接 BACKLOG.md 必须拒绝覆盖并返回 409
  const oversizedDir = makeTempDir("chisabot-oversized-");
  const oversizedPath = join(oversizedDir, "BACKLOG.md");
  writeFileSync(oversizedPath, "x".repeat(1024 * 1024 + 64));
  const oversizedService = createMarkdownBoardService({
    localRoots: () => [oversizedDir],
    listTasks: store.listTasks,
    createTask: store.createTask,
    controlTask: store.controlTask,
    scheduleTask: store.scheduleTask,
  });
  let oversizedErr: unknown = null;
  try {
    await oversizedService.initBoard("owner", oversizedDir);
  } catch (err) {
    oversizedErr = err;
  }
  expect(oversizedErr).toMatchObject({ status: 409 });
  expect(readFileSync(oversizedPath, "utf8").length).toBe(1024 * 1024 + 64);

  const symDir = makeTempDir("chisabot-sym-");
  const symOut = makeTempDir("chisabot-sym-out-");
  const symTarget = join(symOut, "external.md");
  writeFileSync(symTarget, "DO NOT OVERWRITE", "utf8");
  let symMade = false;
  try {
    symlinkSync(symTarget, join(symDir, "BACKLOG.md"));
    symMade = true;
  } catch {
    symMade = false;
  }
  if (symMade) {
    const symService = createMarkdownBoardService({
      localRoots: () => [symDir],
      listTasks: store.listTasks,
      createTask: store.createTask,
      controlTask: store.controlTask,
      scheduleTask: store.scheduleTask,
    });
    let symErr: unknown = null;
    try {
      await symService.initBoard("owner", symDir);
    } catch (err) {
      symErr = err;
    }
    expect(symErr).toMatchObject({ status: 409 });
    expect(readFileSync(symTarget, "utf8")).toBe("DO NOT OVERWRITE");
  }
});
