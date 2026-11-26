import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  markTurnTainted,
  withConfirmActor,
  withConfirmToolCall,
  withConfirmTurn,
  withTurnTaint,
} from "../src/confirmations/context";
import {
  createConfirmations,
  registrableDomain,
} from "../src/confirmations/service";
import type { Database } from "../src/db/client";

type StoredRequest = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  thread_id: string | null;
  tool_call_id: string | null;
  category: string;
  tool: string;
  title: string;
  target: string | null;
  details: unknown;
  digest: string;
  status: string;
  decided_via: string | null;
  external: string | null;
  consumed_at: string | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string;
  continuation: unknown | null;
};

/** 轻量内存数据库桩：仅覆盖 confirmations/service.ts 的窗口查询、审批写入与决策路径。 */
function createMemoryConfirmDatabase() {
  const prefs: Array<{
    owner_user_id: string;
    category: string;
    mode: string;
    note: string | null;
    updated_at: string;
  }> = [];
  const rules: Array<{
    id: string;
    owner_user_id: string;
    text: string;
    category: string;
    mode: string;
    keywords: unknown;
    source: string;
    agent_id: string | null;
    created_at: string;
  }> = [];
  const requests: StoredRequest[] = [];

  const unsafe = async <T = unknown>(
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const q = query.replace(/\s+/g, " ").trim();
    if (
      q.startsWith("CREATE TABLE") ||
      q.startsWith("CREATE INDEX") ||
      q.startsWith("ALTER TABLE")
    ) {
      return [] as T[];
    }
    if (
      q.startsWith(
        "SELECT category, mode, note, updated_at FROM chisabot_confirm_prefs",
      )
    ) {
      const owner = String(params[0]);
      return prefs.filter((p) => p.owner_user_id === owner) as unknown as T[];
    }
    if (
      q.startsWith("SELECT * FROM chisabot_confirm_rules WHERE owner_user_id")
    ) {
      const owner = String(params[0]);
      return rules.filter((r) => r.owner_user_id === owner) as unknown as T[];
    }
    if (
      q.startsWith(
        "SELECT * FROM chisabot_confirm_requests WHERE owner_user_id = $1 AND id = $2",
      )
    ) {
      const [owner, id] = params as [string, string];
      return requests.filter(
        (r) => r.owner_user_id === owner && r.id === id,
      ) as unknown as T[];
    }
    if (
      q.startsWith("SELECT status FROM chisabot_confirm_requests WHERE id = $1")
    ) {
      const id = String(params[0]);
      const found = requests.find((r) => r.id === id);
      return (found ? [{ status: found.status }] : []) as unknown as T[];
    }
    if (q.startsWith("INSERT INTO chisabot_confirm_requests")) {
      const [
        id,
        ownerUserId,
        agentId,
        threadId,
        toolCallId,
        category,
        tool,
        title,
        target,
        detailsJson,
        digest,
        external,
        expiresAt,
        continuationJson,
      ] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string,
        string,
        string | null,
        string,
        string,
        string | null,
        string,
        string | null,
      ];
      const nowIso = new Date().toISOString();
      const row: StoredRequest = {
        id,
        owner_user_id: ownerUserId,
        agent_id: agentId,
        thread_id: threadId,
        tool_call_id: toolCallId,
        category,
        tool,
        title,
        target,
        details: JSON.parse(detailsJson),
        digest,
        status: "pending",
        decided_via: null,
        external,
        consumed_at: null,
        created_at: nowIso,
        decided_at: null,
        expires_at: expiresAt,
        continuation: continuationJson ? JSON.parse(continuationJson) : null,
      };
      requests.push(row);
      return [row] as unknown as T[];
    }
    if (q.startsWith("UPDATE chisabot_confirm_requests SET status = $2")) {
      const [id, status, via] = params as [string, string, string | null];
      const row = requests.find((r) => r.id === id && r.status === "pending");
      if (!row) return [] as T[];
      row.status = status;
      if (via !== null) row.decided_via = via;
      if (!row.decided_at) row.decided_at = new Date().toISOString();
      return [row] as unknown as T[];
    }
    if (
      q.startsWith(
        "UPDATE chisabot_confirm_requests SET consumed_at = now() WHERE id = $1",
      )
    ) {
      const id = String(params[0]);
      const row = requests.find((r) => r.id === id);
      if (row) row.consumed_at = new Date().toISOString();
      return [] as T[];
    }
    if (
      q.startsWith(
        "UPDATE chisabot_confirm_requests SET consumed_at = now() WHERE id = (SELECT id FROM chisabot_confirm_requests",
      )
    ) {
      const [owner, threadId, digest, category, windowMs] = params as [
        string,
        string,
        string | null,
        string | null,
        number,
      ];
      const cutoff = Date.now() - windowMs;
      const candidate = requests
        .filter(
          (r) =>
            r.owner_user_id === owner &&
            r.thread_id === threadId &&
            r.status === "approved" &&
            r.consumed_at === null &&
            r.decided_at !== null &&
            Date.parse(r.decided_at) > cutoff &&
            ((digest !== null && r.digest === digest) ||
              (digest === null && r.category === category)),
        )
        .sort((a, b) =>
          String(b.decided_at).localeCompare(String(a.decided_at)),
        )[0];
      if (!candidate) return [] as T[];
      candidate.consumed_at = new Date().toISOString();
      return [{ id: candidate.id }] as unknown as T[];
    }
    if (
      q.startsWith(
        "SELECT target FROM chisabot_confirm_requests WHERE owner_user_id = $1 AND thread_id = $2 AND category = 'purchase'",
      )
    ) {
      const [owner, threadId, windowMs] = params as [string, string, number];
      const cutoff = Date.now() - windowMs;
      return requests
        .filter(
          (r) =>
            r.owner_user_id === owner &&
            r.thread_id === threadId &&
            r.category === "purchase" &&
            r.status === "approved" &&
            r.decided_at !== null &&
            Date.parse(r.decided_at) > cutoff,
        )
        .sort((a, b) =>
          String(b.decided_at).localeCompare(String(a.decided_at)),
        )
        .map((r) => ({ target: r.target })) as unknown as T[];
    }
    if (
      q.startsWith(
        "SELECT target FROM chisabot_confirm_requests WHERE owner_user_id = $1 AND thread_id = $2 AND category = $3",
      )
    ) {
      const [owner, threadId, category, windowMs] = params as [
        string,
        string,
        string,
        number,
      ];
      const cutoff = Date.now() - windowMs;
      return requests
        .filter(
          (r) =>
            r.owner_user_id === owner &&
            r.thread_id === threadId &&
            r.category === category &&
            r.status === "approved" &&
            r.decided_at !== null &&
            Date.parse(r.decided_at) > cutoff,
        )
        .sort((a, b) =>
          String(b.decided_at).localeCompare(String(a.decided_at)),
        )
        .map((r) => ({ target: r.target })) as unknown as T[];
    }
    if (q.startsWith("SELECT c.* FROM chisabot_confirm_requests c")) {
      const [owner, threadId] = params as [string, string | null];
      return requests
        .filter(
          (r) =>
            r.owner_user_id === owner &&
            (threadId === null || r.thread_id === threadId),
        )
        .sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)),
        ) as unknown as T[];
    }
    return [] as T[];
  };

  const database = {
    $client: { unsafe },
  } as unknown as Database;

  return { database, requests };
}

describe("confirmations 审批窗口域名绑定与污点回合防豁免", () => {
  test("registrableDomain 正确识别同站子域与多段公共后缀", () => {
    expect(registrableDomain("https://cart.example.com/step1")).toBe(
      "example.com",
    );
    expect(registrableDomain("https://pay.example.com/confirm")).toBe(
      "example.com",
    );
    expect(registrableDomain("checkout.amazon.co.uk")).toBe("amazon.co.uk");
    expect(registrableDomain("https://pay.amazon.co.uk/order")).toBe(
      "amazon.co.uk",
    );
    expect(registrableDomain("https://evil.co.uk/phish")).toBe("evil.co.uk");
    expect(registrableDomain("京东商城")).toBe("");
    expect(registrableDomain("")).toBe("");
  });

  test("purchaseConfirmed 支持同站多步结账，跨站立即失效，污点回合禁止放行", async () => {
    const { database, requests } = createMemoryConfirmDatabase();
    const confirm = createConfirmations(database);
    const owner = `owner-${randomUUID().slice(0, 8)}`;
    const threadId = `thread-${randomUUID().slice(0, 8)}`;
    const turn = { threadId, runId: "run-1", stopped: () => false };

    // 模拟用户在 https://cart.example.com/cart 确认一次付款（confirm_action）
    const actionTool = confirm
      .tools(owner, "bot-1")
      .find((t) => t.name === "confirm_action");
    expect(actionTool).toBeDefined();

    const pendingCall = withConfirmTurn(turn, () =>
      withConfirmToolCall("call-buy", "confirm_action", () =>
        actionTool?.execute({
          category: "purchase",
          title: "在示例商城下单",
          target: "https://cart.example.com/cart?token=secret",
        }),
      ),
    );

    let cardId = "";
    for (let i = 0; i < 30 && !cardId; i++) {
      const card = requests.find((r) => r.tool_call_id === "call-buy");
      if (card) cardId = card.id;
      else await new Promise((r) => setTimeout(r, 20));
    }
    expect(cardId).not.toBe("");
    const storedCard = requests.find((r) => r.id === cardId);
    // URL target 应规范化为 origin 存入，不保留查询串敏感参数
    expect(storedCard?.target).toBe("https://cart.example.com");

    await confirm.decide(owner, cardId, "approve");
    expect(await pendingCall).toContain("已确认");

    // 1. 同站多步结账（cart.example.com -> pay.example.com -> cashier.example.com）：多次跳转均放行，不作废窗口
    expect(
      await confirm.purchaseConfirmed(
        owner,
        threadId,
        "https://pay.example.com/step1",
      ),
    ).toBe(true);
    expect(
      await confirm.purchaseConfirmed(
        owner,
        threadId,
        "https://cashier.example.com/step2",
      ),
    ).toBe(true);

    // 2. 跨站跳转立即失效
    expect(
      await confirm.purchaseConfirmed(
        owner,
        threadId,
        "https://evil-phish.com/pay",
      ),
    ).toBe(false);

    // 3. 缺失 pageUrl 时拒绝豁免（fail-closed）
    expect(await confirm.purchaseConfirmed(owner, threadId)).toBe(false);
    expect(await confirm.purchaseConfirmed(owner, threadId, "")).toBe(false);

    // 4. 污点回合严禁走时间窗放行（即便在同站同窗口内）
    const taintedAllowed = await withTurnTaint(async () => {
      markTurnTainted("web:untrusted-page");
      return confirm.purchaseConfirmed(
        owner,
        threadId,
        "https://pay.example.com/step3",
      );
    });
    expect(taintedAllowed).toBe(false);
  });

  test("pageAction：同站非污点延续免问，跨站或污点回合强制重走审批", async () => {
    const { database, requests } = createMemoryConfirmDatabase();
    const confirm = createConfirmations(database);
    const owner = `owner-${randomUUID().slice(0, 8)}`;
    const threadId = `thread-${randomUUID().slice(0, 8)}`;
    const turn = { threadId, runId: "run-page", stopped: () => false };

    const pending = withConfirmTurn(turn, () =>
      withConfirmToolCall("call-send", "computer_click", () =>
        withConfirmActor({ kind: "person" }, () =>
          confirm.pageAction({
            ownerUserId: owner,
            agentId: "bot-1",
            element: { role: "button", name: "发送" },
            pageUrl: "https://mail.example.com/compose",
          }),
        ),
      ),
    );

    let cardId = "";
    for (let i = 0; i < 30 && !cardId; i++) {
      const card = requests.find((r) => r.tool_call_id === "call-send");
      if (card) cardId = card.id;
      else await new Promise((r) => setTimeout(r, 20));
    }
    expect(cardId).not.toBe("");
    await confirm.decide(owner, cardId, "approve");
    expect(await pending).toMatchObject({ ok: true });

    // 同可注册域名、非污点回合：放行
    const sameSiteOutcome = await withConfirmTurn(turn, () =>
      confirm.pageAction({
        ownerUserId: owner,
        agentId: "bot-1",
        element: { role: "button", name: "Send" },
        pageUrl: "https://app.example.com/inbox",
      }),
    );
    expect(sameSiteOutcome).toMatchObject({ ok: true, via: "grant" });

    // 跨站跳转（非交互后台回合下会触发 check 并拒签，绝不走 grant 放行）
    const crossSiteOutcome = await withConfirmActor(
      { kind: "routine", id: "schedule:cross-site" },
      () =>
        confirm.pageAction({
          ownerUserId: owner,
          agentId: "bot-1",
          threadId,
          element: { role: "button", name: "Send" },
          pageUrl: "https://attacker.org/post",
        }),
    );
    expect(crossSiteOutcome).toMatchObject({ ok: false });

    // 污点回合（即便在同站 mail.example.com 上）：禁止窗口豁免，必须重走 check()
    const taintedOutcome = await withTurnTaint(async () => {
      markTurnTainted("web:injected-html");
      return withConfirmActor({ kind: "routine", id: "schedule:tainted" }, () =>
        confirm.pageAction({
          ownerUserId: owner,
          agentId: "bot-1",
          threadId,
          element: { role: "button", name: "Send" },
          pageUrl: "https://mail.example.com/compose",
        }),
      );
    });
    expect(taintedOutcome).toMatchObject({ ok: false });
  });
});
