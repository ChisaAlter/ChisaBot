import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { WORK_STYLE_GUIDANCE } from "../../shared/bot-prompt";
import type { ChatFileView } from "../../shared/chat-files";
import type { PageView } from "../../shared/pages";
import { groupArtifactsByBucket } from "@/components/bot-profile/files-section";
import { PANEL_PRESETS, panelPresetBatch } from "@/components/panels/panel-rail";
import { isWorkCall } from "@/lib/chat/work-steps";
import { BotExchangeCard, describeHandoffStatus } from "@/lib/copilot/handoff-tool";
import { HANDED_OVER } from "@/lib/copilot/markers";
import {
  CONNECTED_ACCOUNTS_TABS,
  normalizeConnectedAccountsTab,
} from "@/routes/_authed/settings/connected-accounts";
import { VAULT_SECURITY_NOTE } from "@/routes/_authed/settings/vault";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost:3000/" });
  }
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

describe("CB-092: Bot profile files & pages bucketing", () => {
  const now = new Date("2026-10-25T15:00:00.000Z");

  const makeFile = (id: string, createdAt: string): ChatFileView => ({
    id,
    name: `${id}.pdf`,
    mimeType: "application/pdf",
    size: 2048,
    kind: "shared",
    url: `/api/chat-files/${id}`,
    workspacePath: `reports/${id}.pdf`,
    createdAt,
  });

  const makePage = (id: string, updatedAt: string): PageView => ({
    id,
    slug: "abcdefghijklmnop",
    title: `页面 ${id}`,
    description: null,
    published: true,
    version: 1,
    versions: 1,
    assets: 0,
    agentId: "bot-1",
    path: "/p/abcdefghijklmnop/",
    createdAt: updatedAt,
    updatedAt,
  });

  test("groups files and pages into 今天 / 本周 / 更早 and omits empty buckets", () => {
    const buckets = groupArtifactsByBucket(
      [
        makeFile("f-today", "2026-10-25T10:00:00.000Z"),
        makeFile("f-old", "2026-09-01T10:00:00.000Z"),
      ],
      [makePage("p-week", "2026-10-22T10:00:00.000Z")],
      now,
    );
    expect(buckets.map((b) => b.label)).toEqual(["今天", "本周", "更早"]);
    expect(buckets[0]?.items[0]?.id).toBe("file:f-today");
    expect(buckets[1]?.items[0]?.id).toBe("page:p-week");
    expect(buckets[2]?.items[0]?.id).toBe("file:f-old");
  });

  test("returns empty array when bot has no files and no pages (§47)", () => {
    expect(groupArtifactsByBucket([], [], now)).toEqual([]);
  });
});

describe("CB-094: Right rail panel presets & shuffle", () => {
  test("panelPresetBatch returns non-overlapping batches of 3 and wraps around", () => {
    expect(PANEL_PRESETS.length).toBeGreaterThanOrEqual(6);
    const batch0 = panelPresetBatch(0, 3);
    const batch1 = panelPresetBatch(1, 3);
    const batchWrap = panelPresetBatch(Math.ceil(PANEL_PRESETS.length / 3), 3);
    expect(batch0).toHaveLength(3);
    expect(batch1).toHaveLength(3);
    expect(batch0[0]?.label).not.toBe(batch1[0]?.label);
    expect(batchWrap).toEqual(batch0);
  });
});

describe("CB-095: Connected accounts tabs & vault copy", () => {
  test("normalizeConnectedAccountsTab defaults unknown values to all and preserves valid tabs", () => {
    expect(CONNECTED_ACCOUNTS_TABS.map((t) => t.id)).toEqual([
      "all",
      "connections",
      "logins",
      "api-keys",
    ]);
    expect(normalizeConnectedAccountsTab(undefined)).toBe("all");
    expect(normalizeConnectedAccountsTab("invalid")).toBe("all");
    expect(normalizeConnectedAccountsTab("connections")).toBe("connections");
    expect(normalizeConnectedAccountsTab("logins")).toBe("logins");
    expect(normalizeConnectedAccountsTab("api-keys")).toBe("api-keys");
  });

  test("vault security note states server-side encryption without claiming zero-knowledge", () => {
    expect(VAULT_SECURITY_NOTE).toContain("服务器加密保存，机器人看不到明文");
    expect(VAULT_SECURITY_NOTE).not.toContain("零知识");
  });
});

describe("CB-093: Bot-to-Bot exchange anchor card", () => {
  test("describeHandoffStatus distinguishes running, handed-over, depth-cap, and deleted bot", () => {
    expect(
      describeHandoffStatus({ asked: "数据分析师", running: true }),
    ).toMatchObject({
      state: "running",
      badge: "询问中",
    });

    expect(
      describeHandoffStatus({
        asked: "数据分析师",
        running: false,
        result: `${HANDED_OVER} Handed over to 数据分析师.`,
      }),
    ).toMatchObject({
      state: "handed-over",
      badge: "已转交",
    });

    expect(
      describeHandoffStatus({
        asked: "数据分析师",
        running: false,
        result: "This is already 1 Bot deep, which is as far as this deployment allows.",
      }),
    ).toMatchObject({
      state: "depth-cap",
      badge: "已达上限",
    });

    expect(
      describeHandoffStatus({
        asked: "旧机器人",
        running: false,
        result: `${HANDED_OVER} Handed over to 旧机器人.`,
        targetDeleted: true,
      }),
    ).toMatchObject({
      state: "deleted",
      badge: "对方已删除",
    });
  });

  test("BotExchangeCard expands on click to show task, constraints, expecting, and deleted status", () => {
    const { getByTestId, queryByTestId } = render(
      <BotExchangeCard
        asked="已删助手"
        constraints="只看本周数据"
        expecting="Markdown 表格"
        knownBots={[{ id: "other", name: "现存助手" }]}
        result={`${HANDED_OVER} Handed over to 已删助手.`}
        running={false}
        task="汇总本周销售额"
      />,
    );
    const card = getByTestId("bot-exchange-card");
    expect(card.getAttribute("data-state")).toBe("deleted");
    expect(card.textContent).toContain("对方已删除");
    expect(queryByTestId("bot-exchange-body")).toBeNull();

    fireEvent.click(card.querySelector("button")!);
    const body = getByTestId("bot-exchange-body");
    expect(body.textContent).toContain("汇总本周销售额");
    expect(body.textContent).toContain("只看本周数据");
    expect(body.textContent).toContain("Markdown 表格");
  });

  test("message_bot is excluded from work-step folding and WORK_STYLE_GUIDANCE includes choice prompt", () => {
    expect(isWorkCall("message_bot")).toBe(false);
    expect(WORK_STYLE_GUIDANCE).toContain("choice: true");
  });
});
