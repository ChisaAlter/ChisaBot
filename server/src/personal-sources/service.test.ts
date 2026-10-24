import { describe, expect, test } from "bun:test";
import { fetchImapInboxSummary, parseIcsEvents } from "./service";
import { normalizeSkillSourceUrl, parseSkillMarkdown, SKILL_HUB_CATALOG } from "../skills-chisa/tools";
import { categoryOfTool, titleForTool } from "../confirmations/classify";
import { renderMermaidToSvg } from "../../../app/src/lib/chat/mermaid-lite";
import { splitBubbles } from "../../../app/src/lib/chat/bubbles";

describe("personal-sources & new Hark features", () => {
  test("parseIcsEvents parses VEVENT blocks and filters upcoming range", () => {
    const now = new Date("2026-10-23T08:00:00Z");
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:evt-1@chisabot",
      "DTSTART:20261023T100000Z",
      "DTEND:20261023T110000Z",
      "SUMMARY:产品架构走查",
      "LOCATION:飞书 Room A",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:evt-old@chisabot",
      "DTSTART:20250101T100000Z",
      "SUMMARY:去年旧会议",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseIcsEvents(ics);
    expect(events.length).toBe(2);
    expect(events[1]?.summary).toBe("产品架构走查");
    expect(events[1]?.location).toBe("飞书 Room A");
  });

  test("fetchImapInboxSummary returns structured demo inbox messages", async () => {
    const messages = await fetchImapInboxSummary({
      host: "demo.imap.local",
      port: 993,
      user: "chisa@demo.imap.local",
      pass: "demo-inbox",
      limit: 5,
    });
    expect(messages.filter((m) => m.unread).length).toBe(2);
    expect(messages.length).toBe(3);
    expect(messages[0]?.unread).toBe(true);
  });

  test("renderMermaidToSvg renders flowchart, sequenceDiagram, and pie to SVG", () => {
    const flow = renderMermaidToSvg("flowchart LR\n  A[用户输入] --> B(Agent 思考)\n  B --> C{调用工具}");
    expect(flow).toContain("<svg");
    expect(flow).toContain("用户输入");
    expect(flow).toContain("Agent 思考");

    const seq = renderMermaidToSvg("sequenceDiagram\n  User->>Bot: 早安\n  Bot-->>User: 每日晨报卡片");
    expect(seq).toContain("<svg");
    expect(seq).toContain("每日晨报卡片");

    const pie = renderMermaidToSvg('pie title 时间分配\n  "研发" : 60\n  "会议" : 25\n  "复盘" : 15');
    expect(pie).toContain("<svg");
    expect(pie).toContain("研发 (60%)");
  });

  test("splitBotBubbles recognizes ```brief fenced block as brief card", () => {
    const md = [
      "> 早安，今天有什么安排？",
      "",
      "早上好！这是为你整理的今日晨报：",
      "",
      "```brief",
      "标题：今日晨报 · 10月23日",
      "### 🌤️ 今日天气",
      "- **上海**：晴转多云，22°C",
      "```",
    ].join("\n");
    const items = splitBubbles(md);
    expect(items[0]?.quote).toBe("早安，今天有什么安排？");
    expect(items.some((i) => i.kind === "brief" && i.title?.includes("今日晨报"))).toBe(true);
  });

  test("SKILL_HUB_CATALOG and parseSkillMarkdown support OpenClaw / GitHub SKILL.md", () => {
    expect(SKILL_HUB_CATALOG.length).toBeGreaterThanOrEqual(8);
    expect(SKILL_HUB_CATALOG.some((s) => s.slug === "morning-brief")).toBe(true);

    const rawUrl = normalizeSkillSourceUrl(
      "https://github.com/openclaw/clawhub/blob/main/skills/inbox-zero/SKILL.md",
    );
    expect(rawUrl).toBe("https://raw.githubusercontent.com/openclaw/clawhub/main/skills/inbox-zero/SKILL.md");

    const parsed = parseSkillMarkdown(
      [
        "---",
        "name: inbox-zero",
        "description: 自动分拣收件箱并起草回信",
        "---",
        "# 收件箱清零助手",
        "1. 先调用 email_list_recent",
        "2. 再调用 email_send",
      ].join("\n"),
    );
    expect(parsed.slug).toBe("inbox-zero");
    expect(parsed.summary).toBe("自动分拣收件箱并起草回信");
    expect(parsed.instructions).toContain("email_send");
  });

  test("email_send requires confirmation as message category while notify_push does not", () => {
    expect(categoryOfTool("email_send", "personal-sources/email_send")).toBe("message");
    expect(titleForTool("email_send", "message")).toBe("通过已连接邮箱发送一封邮件");
    expect(categoryOfTool("notify_push", "personal-sources/notify_push")).toBeNull();
    expect(categoryOfTool("email_connect", "personal-sources/email_connect")).toBeNull();
  });
});
