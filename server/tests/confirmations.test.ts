import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { categoryOfPageAction, categoryOfTool, decideMode, detailsFromArgs } from "../src/confirmations/classify";
import { withConfirmActor, withConfirmToolCall, withConfirmTurn } from "../src/confirmations/context";
import { createConfirmations } from "../src/confirmations/service";
import { createDatabase } from "../src/db/client";
import type { GrantedTool } from "../src/plugins/tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { z } from "zod";

/** 确认卡片 + 审批偏好（DESIGN.md §58）：分类、偏好 / 规则、等确认、取消、非网页回合、后来才确认。 */
describe("classify", () => {
  test("tool categories", () => {
    expect(categoryOfTool("delete_routine", "chisabot-routines/delete_routine")).toBe("delete");
    expect(categoryOfTool("panel_remove", "live-panels/panel_remove")).toBe("delete");
    expect(categoryOfTool("panel_update", "live-panels/panel_update")).toBeNull();
    expect(categoryOfTool("GMAIL_SEND_EMAIL", "composio/GMAIL_SEND_EMAIL")).toBe("message");
    expect(categoryOfTool("GMAIL_LIST_EMAILS", "composio/GMAIL_LIST_EMAILS")).toBeNull();
    expect(categoryOfTool("stripe_create_payment", "mcp/stripe/create_payment")).toBe("purchase");
    expect(categoryOfTool("memory_forget", "memory/memory_forget")).toBeNull();
    expect(categoryOfTool("device_run_shell", "devices/run_shell")).toBeNull();
    expect(categoryOfTool("post_to_group")).toBeNull();
    expect(categoryOfTool("github_comment", "github/github_comment")).toBeNull();
    expect(categoryOfTool("web_search", "web/web_search")).toBeNull();
    expect(categoryOfTool("page_delete", "pages/page_delete")).toBe("delete");
    expect(categoryOfTool("page_publish", "pages/page_publish")).toBeNull();
    expect(categoryOfTool("page_create", "pages/page_create")).toBeNull();
    expect(categoryOfTool("file_share", "chat-files/file_share")).toBeNull(); // 聊天里给用户看的文件卡，不是对外发
    expect(categoryOfTool("schedule_cancel", "chisabot/schedule_cancel")).toBeNull();
  });
  test("decideMode: purchase locked, keyword rules, ask beats auto, pref fallback", () => {
    expect(decideMode({ category: "purchase", text: "x", pref: "auto", rules: [] })).toMatchObject({ mode: "ask", source: "safety" });
    expect(decideMode({ category: "message", text: "发给张三", pref: undefined, rules: [] })).toMatchObject({ mode: "ask", source: "default" });
    expect(decideMode({ category: "message", text: "发给张三", pref: "auto", rules: [] })).toMatchObject({ mode: "auto", source: "preference" });
    const rules = [
      { id: "a", category: "message" as const, mode: "auto" as const, keywords: ["张三"] },
      { id: "b", category: "message" as const, mode: "ask" as const, keywords: ["张三", "工资"] },
    ];
    expect(decideMode({ category: "message", text: "给张三发微信", pref: "ask", rules })).toMatchObject({ mode: "auto", ruleId: "a" });
    expect(decideMode({ category: "message", text: "给张三说工资的事", pref: "auto", rules })).toMatchObject({ mode: "ask", ruleId: "b" });
    expect(decideMode({ category: "delete", text: "给张三", pref: undefined, rules })).toMatchObject({ mode: "ask", source: "default" });
  });
  test("page buttons: send / delete labels, not text fields or long text", () => {
    expect(categoryOfPageAction({ role: "button", name: "发送" })).toBe("message");
    expect(categoryOfPageAction({ role: "button", name: "Send" })).toBe("message");
    expect(categoryOfPageAction({ role: "button", name: "发送(S)" })).toBe("message");
    expect(categoryOfPageAction({ role: "button", name: "Post ➤" })).toBe("message");
    expect(categoryOfPageAction({ role: "link", name: "Move to trash" })).toBe("delete");
    expect(categoryOfPageAction({ role: "menuitem", name: "删除" })).toBe("delete");
    expect(categoryOfPageAction({ role: "button", name: "立即购买" })).toBeNull(); // 付款归上游的付款安全规则
    expect(categoryOfPageAction({ role: "textbox", name: "发送" })).toBeNull();
    expect(categoryOfPageAction({ role: "heading", name: "删除" })).toBeNull();
    expect(categoryOfPageAction({ role: "button", name: "发送验证码给我的手机看看会不会到" })).toBeNull();
    expect(categoryOfPageAction({ role: "button", name: "搜索" })).toBeNull();
    expect(categoryOfPageAction(undefined)).toBeNull();
  });
  test("details skip secrets and mark code", () => {
    const details = detailsFromArgs({ to: "a@b.c", api_key: "sk-1", command: "rm -rf x" });
    expect(details.map((d) => d.label)).toEqual(["发给", "命令"]);
    expect(details[1]!.code).toBe(true);
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("confirmations service", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const confirm = url ? createConfirmations(database) : (null as never);
  const owner = `cftest-${randomUUID().slice(0, 8)}`;
  const thread = `thread-${randomUUID().slice(0, 8)}`;
  const resumed: { threadId: string; text: string }[] = [];
  beforeAll(async () => {
    await confirm.ensure();
    confirm.setResume(async (input) => {
      resumed.push({ threadId: input.threadId, text: input.text });
    });
  });
  afterAll(async () => {
    for (const table of ["chisabot_confirm_prefs", "chisabot_confirm_rules", "chisabot_confirm_requests", "chisabot_bot_permissions"])
      await database.$client.unsafe(`DELETE FROM ${table} WHERE owner_user_id = $1`, [owner]);
  });
  const executed: unknown[] = [];
  const deleteTool: GrantedTool = {
    name: "delete_routine",
    ref: "chisabot-routines/delete_routine",
    description: "x",
    parameters: z.object({ routineId: z.string() }),
    execute: async (args) => {
      executed.push(args);
      return "deleted";
    },
  };
  const turn = (stopped = () => false) => ({ threadId: thread, runId: "run-1", stopped });
  const pendingFor = async (toolCallId: string) => {
    for (let i = 0; i < 40; i++) {
      const found = (await confirm.list(owner, { threadId: thread })).find((r) => r.toolCallId === toolCallId);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no card");
  };

  test("defaults are ask; purchase cannot be auto", async () => {
    const prefs = await confirm.prefs(owner);
    expect(prefs.map((p) => p.mode)).toEqual(["ask", "ask", "ask", "ask"]);
    expect(prefs.find((p) => p.category === "purchase")!.locked).toBe(true);
    await expect(confirm.setPref(owner, "purchase", "auto")).rejects.toThrow("安全底线");
  });

  test("ask → card in the thread under the tool call → approve runs the tool once", async () => {
    const [wrapped] = confirm.wrap([deleteTool], { ownerUserId: owner, agentId: "bot-1" });
    const run = withConfirmTurn(turn(), () => withConfirmToolCall("call-1", "delete_routine", () => wrapped!.execute({ routineId: "r1" })));
    const card = await pendingFor("call-1");
    expect(card.status).toBe("pending");
    expect(card.category).toBe("delete");
    expect(card.details[0]).toMatchObject({ label: "任务", value: "r1" });
    expect(executed.length).toBe(0);
    await confirm.decide(owner, card.id, "approve");
    expect(await run).toBe("deleted");
    expect(executed.length).toBe(1);
    expect(resumed.length).toBe(0);
  });

  test("deny → not executed, bot told it was the person's decision", async () => {
    const [wrapped] = confirm.wrap([deleteTool], { ownerUserId: owner, agentId: "bot-1" });
    const run = withConfirmTurn(turn(), () => withConfirmToolCall("call-2", "delete_routine", () => wrapped!.execute({ routineId: "r2" })));
    const card = await pendingFor("call-2");
    await confirm.decide(owner, card.id, "deny");
    expect(await run).toContain("取消");
    expect(executed.length).toBe(1);
  });

  test("stop closes the card", async () => {
    let stopped = false;
    const [wrapped] = confirm.wrap([deleteTool], { ownerUserId: owner, agentId: "bot-1" });
    const run = withConfirmTurn(turn(() => stopped), () => withConfirmToolCall("call-3", "delete_routine", () => wrapped!.execute({ routineId: "r3" })));
    await pendingFor("call-3");
    stopped = true;
    expect(await run).toContain("停止");
    expect((await pendingFor("call-3")).status).toBe("cancelled");
  });

  test("non-web turn leaves a card for later instead of refusing (§101)", async () => {
    const [wrapped] = confirm.wrap([deleteTool], { ownerUserId: owner, agentId: "bot-1", initiator: { kind: "routine", id: "im:abc" } });
    const out = await withConfirmTurn(turn(), () => wrapped!.execute({ routineId: "r4" }));
    expect(out).toContain("用户不在场");
    expect(executed.length).toBe(1);
    const cards = (await confirm.list(owner, { threadId: thread })).filter((c) => c.status === "pending" && c.tool === "delete_routine");
    expect(cards.length).toBe(1);
    // 再触发一次：旧卡片作废，只留最新的一张
    await withConfirmTurn(turn(), () => wrapped!.execute({ routineId: "r4b" }));
    const after = (await confirm.list(owner, { threadId: thread })).filter((c) => c.status === "pending" && c.tool === "delete_routine");
    expect(after.length).toBe(1);
    expect(after[0]!.id).not.toBe(cards[0]!.id);
    for (const c of after) await confirm.decide(owner, c.id, "deny");
  });

  test("a late approval resumes the conversation and lets the retry through once", async () => {
    const card = await confirm.insertRequest({
      ownerUserId: owner,
      agentId: "bot-1",
      threadId: thread,
      toolCallId: "call-old",
      category: "delete",
      tool: "delete_routine",
      title: "删除一个长期任务",
      digest: (await import("../src/confirmations/service")).digestOf("delete_routine", { routineId: "r5" }),
    });
    await confirm.decide(owner, card.id, "approve");
    await new Promise((r) => setTimeout(r, 50));
    expect(resumed.at(-1)?.threadId).toBe(thread);
    expect(resumed.at(-1)?.text).toContain("用户确认了");
    const [wrapped] = confirm.wrap([deleteTool], { ownerUserId: owner, agentId: "bot-1", initiator: { kind: "routine", id: `confirm:${card.id}` } });
    expect(await withConfirmTurn(turn(), () => wrapped!.execute({ routineId: "r5" }))).toBe("deleted");
    // 只放行一次：再来一次又要确认（非网页回合 → 拒绝而不是挂起）。
    const [again] = confirm.wrap([deleteTool], { ownerUserId: owner, agentId: "bot-1", initiator: { kind: "routine", id: "im:x" } });
    expect(await withConfirmTurn(turn(), () => again!.execute({ routineId: "r5" }))).toContain("用户不在场");
  });

  test("auto preference and keyword rules skip the card", async () => {
    await confirm.setPref(owner, "delete", "auto", "以后删东西不用问我");
    const [wrapped] = confirm.wrap([deleteTool], { ownerUserId: owner, agentId: "bot-1", initiator: { kind: "routine", id: "im:x" } });
    expect(await withConfirmTurn(turn(), () => wrapped!.execute({ routineId: "r6" }))).toBe("deleted");
    await confirm.addRule(owner, { text: "删除重要任务要先问我", category: "delete", mode: "ask", keywords: ["重要"] });
    expect(await withConfirmTurn(turn(), () => wrapped!.execute({ routineId: "重要-r7" }))).toContain("用户不在场");
    expect(await withConfirmTurn(turn(), () => wrapped!.execute({ routineId: "r8" }))).toBe("deleted");
  });

  test("bot tools: preference save with and without keywords; confirm_action follows prefs", async () => {
    const tools = confirm.tools(owner, "bot-2");
    const save = tools.find((t) => t.name === "approval_preference_save")!;
    expect(await save.execute({ text: "给张三发微信不用问我", category: "message", mode: "auto", keywords: ["张三"] })).toContain("记下了规则");
    expect(await save.execute({ text: "以后付款都直接做", category: "purchase", mode: "auto" })).toContain("安全底线");
    const rules = await confirm.rules(owner);
    expect(rules.some((r) => r.text === "给张三发微信不用问我" && r.source === "bot" && r.agentId === "bot-2")).toBe(true);
    const action = tools.find((t) => t.name === "confirm_action")!;
    expect(await action.execute({ category: "message", title: "微信发给张三：晚上见", target: "张三" })).toContain("不用问");
    const ctx = await confirm.context(owner);
    expect(ctx).toContain("给张三发微信不用问我");
    expect(ctx).toContain("付款购买=先问我（固定）");
  });

  test("page action: server asks before a web 发送 click; a confirm_action earlier in the thread covers it", async () => {
    const pageThread = `t-page-${randomUUID()}`;
    const pageTurn = { threadId: pageThread, runId: "run-p", stopped: () => false };
    expect(await confirm.pageAction({ ownerUserId: owner, agentId: "bot-3", element: { role: "button", name: "搜索" } })).toBeNull();
    // 网页聊天：出卡片，等确认
    const run = withConfirmTurn(pageTurn, () =>
      withConfirmToolCall("call-page", "computer_click", () =>
        withConfirmActor({ kind: "person" }, () =>
          confirm.pageAction({ ownerUserId: owner, agentId: "bot-3", element: { role: "button", name: "发送" }, pageUrl: "https://mail.example.com/compose" }),
        ),
      ),
    );
    let card = null as Awaited<ReturnType<typeof confirm.list>>[number] | null;
    for (let i = 0; i < 40 && !card; i++) {
      card = (await confirm.list(owner, { threadId: pageThread })).find((r) => r.toolCallId === "call-page") ?? null;
      if (!card) await new Promise((r) => setTimeout(r, 100));
    }
    expect(card?.category).toBe("message");
    expect(card?.title).toContain("发送");
    expect(card?.target).toBe("mail.example.com");
    await confirm.decide(owner, card!.id, "approve");
    expect(await run).toMatchObject({ ok: true });
    // 刚确认过：同一段对话里再点「发送」不再问
    expect(await withConfirmTurn(pageTurn, () => confirm.pageAction({ ownerUserId: owner, agentId: "bot-3", element: { name: "Send" } }))).toMatchObject({ ok: true, via: "grant" });
    // 定时任务这类后台回合：弹不出卡片 → 不点
    const bg = await withConfirmTurn({ ...pageTurn, threadId: `t-page-${randomUUID()}` }, () =>
      withConfirmActor({ kind: "routine", id: "schedule:x" }, () => confirm.pageAction({ ownerUserId: owner, agentId: "bot-3", element: { name: "Reply" } })),
    );
    expect(bg).toMatchObject({ ok: false });
  });

  test("device hook: auto preference skips, ask links a card that follows the device decision", async () => {
    expect(await confirm.deviceHook.before({ ownerUserId: owner, botId: "b", operation: "screenshot", operationLabel: "截图", summary: "截一张图", args: {} })).toBe("ask");
    await confirm.setPref(owner, "device", "auto");
    expect(await confirm.deviceHook.before({ ownerUserId: owner, botId: "b", operation: "screenshot", operationLabel: "截图", summary: "截一张图", args: {} })).toBe("auto");
    await withConfirmTurn(turn(), () =>
      withConfirmToolCall("call-dev", "device_run_shell", () =>
        confirm.deviceHook.opened({
          approvalId: "hub-1",
          ownerUserId: owner,
          botId: "b",
          deviceName: "我的 PC",
          operationLabel: "运行命令",
          summary: "dir",
          args: { command: "dir" },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    );
    let decided: [string, boolean] | null = null;
    confirm.setDeviceDecider((id, approved) => {
      decided = [id, approved];
      void confirm.deviceHook.closed(id, approved ? "approve" : "deny", "web");
      return true;
    });
    const card = await pendingFor("call-dev");
    expect(card.title).toContain("运行命令");
    await confirm.decide(owner, card.id, "approve");
    expect(decided).toEqual(["hub-1", true]);
    await new Promise((r) => setTimeout(r, 50));
    expect((await pendingFor("call-dev")).status).toBe("approved");

    // 设备改文件：卡片带着色的 diff（DESIGN.md §62）
    await withConfirmTurn(turn(), () =>
      withConfirmToolCall("call-edit", "device_edit_file", () =>
        confirm.deviceHook.opened({
          approvalId: "hub-2",
          ownerUserId: owner,
          botId: "b",
          deviceName: "我的 PC",
          operationLabel: "修改文件",
          summary: "修改 /work/a.js（1 处）",
          args: { path: "/work/a.js" },
          diff: "--- a/work/a.js\n+++ b/work/a.js\n@@ -1 +1 @@\n-let i = 1;\n+let i = 0;",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    );
    const editCard = await pendingFor("call-edit");
    const diffRow = editCard.details.find((d: { diff?: boolean }) => d.diff);
    expect(diffRow?.value).toContain("+let i = 0;");
  });

  test("bot permission (§97): inherit → ask overrides auto pref → full needs acknowledgement, audits, auto-approves device, keeps ask rules", async () => {
    const audits: unknown[] = [];
    const audited = createConfirmations(database, { auditStore: { insert: async (event) => void audits.push(event) } });
    let allowed = true;
    audited.setBotAccess(async () => allowed);
    const actor = { id: owner, role: "user" };
    const op = { ownerUserId: owner, botId: "bot-p", operation: "shell", operationLabel: "运行命令", summary: "npm install", args: { command: "npm install" } };
    // 上一个测试把「操作你的电脑」设成了直接做：没单独设过的机器人沿用它，显示成完全访问。
    expect(await audited.botPermission(owner, "bot-p")).toMatchObject({ mode: "full", stored: null });
    expect(await audited.deviceHook.before(op)).toBe("auto");
    // 请求批准：始终问，不管审批偏好。
    expect(await audited.setBotPermission(actor, "bot-p", { mode: "ask" })).toMatchObject({ mode: "ask", stored: "ask" });
    expect(await audited.deviceHook.before(op)).toBe("ask");
    // 完全访问：不带确认 → 拒绝；带上 → 存下、写审计。
    await expect(audited.setBotPermission(actor, "bot-p", { mode: "full" })).rejects.toThrow("确认");
    expect(await audited.setBotPermission(actor, "bot-p", { mode: "full", acknowledged: true })).toMatchObject({ mode: "full", stored: "full" });
    expect(audits.at(-1)).toMatchObject({ eventType: "configuration.changed", targetType: "bot", targetId: "bot-p", payload: { change: "bot_permission", from: "ask", to: "full" } });
    expect(await audited.deviceHook.before(op)).toBe("full");
    // 只对这个机器人：别的机器人照旧沿用偏好。
    expect(await audited.deviceHook.before({ ...op, botId: "bot-other" })).toBe("auto");
    // confirm_action 的「操作你的电脑」也直接放行。
    expect(await audited.check({ ownerUserId: owner, agentId: "bot-p", category: "device", tool: "confirm_action", title: "装软件", matchText: "装软件", digest: "d" })).toMatchObject({ ok: true, via: "bot" });
    // 付款照旧要问（完全访问放不开）：非网页回合 → 不执行。
    expect(await audited.check({ ownerUserId: owner, agentId: "bot-p", category: "purchase", tool: "confirm_action", title: "买", matchText: "买", digest: "e", initiator: { kind: "routine", id: "schedule:x" } })).toMatchObject({ ok: false });
    // 用户写的带关键词「先问我」规则仍然算。
    await audited.addRule(owner, { text: "动 C 盘系统目录要先问我", category: "device", mode: "ask", keywords: ["windows\\system32"] });
    expect(await audited.deviceHook.before({ ...op, summary: "删除 C:\\Windows\\System32\\x.dll", args: {} })).toBe("ask");
    // 看不到的机器人：404。
    allowed = false;
    await expect(audited.setBotPermission(actor, "bot-p", { mode: "ask" })).rejects.toThrow("找不到");
    allowed = true;
    expect((await audited.botPermissions(owner)).map((p) => p.agentId)).toContain("bot-p");
  });
});
