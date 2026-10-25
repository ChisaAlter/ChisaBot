import { describe, expect, test } from "bun:test";
import { normalizeDirectiveCards, parseStatusCardsFence } from "../src/components/chat/bot-bubbles";
import { MAX_BUBBLES, splitBubbles } from "../src/lib/chat/bubbles";

describe("splitBubbles（DESIGN.md §69）", () => {
  test("空行分段，一段一个气泡", () => {
    const s = splitBubbles("东京现在 13:15。\n\n要我做个世界时钟面板吗？");
    expect(s.map((x) => x.text)).toEqual(["东京现在 13:15。", "要我做个世界时钟面板吗？"]);
    expect(s.every((x) => x.kind === "text" && !x.wide)).toBe(true);
  });

  test("空文本没有气泡", () => {
    expect(splitBubbles("  \n\n ")).toEqual([]);
  });

  test("代码块不会从中间的空行切开，代码块宽", () => {
    const md = "回文判断：\n\n```python\ndef f(s):\n\n    return s == s[::-1]\n```\n\n要忽略大小写吗？";
    const s = splitBubbles(md);
    expect(s.length).toBe(3);
    expect(s[1]?.kind).toBe("code");
    expect(s[1]?.text).toContain("return s == s[::-1]");
    expect(s[1]?.wide).toBe(true);
  });

  test("流式时没闭合的代码块是一整段", () => {
    const s = splitBubbles("看这个：\n\n```ts\nconst a = 1;\n\nconst b");
    expect(s.length).toBe(2);
    expect(s[1]?.kind).toBe("code");
  });

  test("```draft = 草稿卡，标题行拿出来", () => {
    const s = splitBubbles("写好了，可以直接发：\n\n```draft\n标题：给房东\n房东您好，厨房水管漏水了。\n\n周六上午方便来修吗？\n```\n\n要更客气一点吗？");
    expect(s.map((x) => x.kind)).toEqual(["text", "draft", "text"]);
    expect(s[1]?.title).toBe("给房东");
    expect(s[1]?.text).toBe("房东您好，厨房水管漏水了。\n\n周六上午方便来修吗？");
  });

  test("段首引用 = 回复引用；只有引用的段落照普通段落", () => {
    const s = splitBubbles("iPhone 17 Pro 起售价 8999 元。\n\n> 只要 256G 的价格\n256GB 就是 8999 元。");
    expect(s[1]?.quote).toBe("只要 256G 的价格");
    expect(s[1]?.text).toBe("256GB 就是 8999 元。");
    const only = splitBubbles("> 一句名言");
    expect(only[0]?.quote).toBeUndefined();
    expect(only[0]?.text).toBe("> 一句名言");
  });

  test("引用行后面空一行也算同一段", () => {
    const s = splitBubbles("> 只要国行\n\n国行 256GB 8999 元。");
    expect(s.length).toBe(1);
    expect(s[0]?.quote).toBe("只要国行");
  });

  test("引导句 + 列表合成一段；松散列表合成一段；三项以上的列表宽", () => {
    const s = splitBubbles("主要配置：\n\n- A19 Pro\n\n- 6.3 英寸\n\n- 三摄\n\n要对比 Pro Max 吗？");
    expect(s.length).toBe(2);
    expect(s[0]?.text).toContain("主要配置：");
    expect(s[0]?.text).toContain("- 三摄");
    expect(s[0]?.wide).toBe(true);
  });

  test("引导句 + 表格合成一段，表格宽", () => {
    const s = splitBubbles("对比：\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(s.length).toBe(1);
    expect(s[0]?.wide).toBe(true);
  });

  test("标题跟着下一段", () => {
    const s = splitBubbles("## 价格\n\n8999 元起。");
    expect(s.length).toBe(1);
  });

  test(`最多 ${MAX_BUBBLES} 个气泡，多的并进最后一个，不丢内容`, () => {
    const parts = Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 段。`);
    const s = splitBubbles(parts.join("\n\n"));
    expect(s.length).toBe(MAX_BUBBLES);
    expect(s[MAX_BUBBLES - 1]?.text).toContain("第 9 段。");
    expect(s[MAX_BUBBLES - 1]?.text).toContain(`第 ${MAX_BUBBLES} 段。`);
  });
  test("```doc / ```summary = 文档卡（§76）：标题行拿出来，正文 Markdown 原样（含空行、列表）", () => {
    const s = splitBubbles("React 19 主要是表单和异步更省事。\n\n```doc\n标题：React 19 新特性\n## Actions\n- useActionState\n- useFormStatus\n\n## 其他\nref 可以当 prop。\n```\n\n要我按升级顺序再排一下吗？");
    expect(s.map((x) => x.kind)).toEqual(["text", "doc", "text"]);
    expect(s[1]?.title).toBe("React 19 新特性");
    expect(s[1]?.text).toBe("## Actions\n- useActionState\n- useFormStatus\n\n## 其他\nref 可以当 prop。");
    expect(s[1]?.wide).toBe(true);
    expect(splitBubbles("```summary\n要点一\n```")[0]?.kind).toBe("doc");
  });
  test("流式时没闭合的 ```doc 也是文档卡", () => {
    const s = splitBubbles("先说结论。\n\n```doc\n标题：笔记\n第一点\n\n第二点");
    expect(s.map((x) => x.kind)).toEqual(["text", "doc"]);
    expect(s[1]?.text).toBe("第一点\n\n第二点");
  });
  test("标题行 + 草稿 / 文档卡：标题当卡片标题，不塞进正文", () => {
    const s = splitBubbles("## 给房东的消息\n\n```draft\n房东您好。\n```");
    expect(s).toEqual([{ kind: "draft", text: "房东您好。", title: "给房东的消息", wide: true }]);
    const d = splitBubbles("### 学习计划\n```doc\n标题：Rust 四周\n第一周\n```");
    expect(d[0]?.kind).toBe("doc");
    expect(d[0]?.title).toBe("Rust 四周");
    expect(d[0]?.text).toBe("第一周");
  });
  test("并进最后一个气泡的文档卡写回 ```doc", () => {
    const parts = Array.from({ length: MAX_BUBBLES }, (_, i) => `第 ${i + 1} 段。`);
    const s = splitBubbles([...parts, "```doc\n标题：附录\n内容\n```"].join("\n\n"));
    expect(s[MAX_BUBBLES - 1]?.text).toContain("```doc\n标题：附录\n内容\n```");
  });
  test("````doc 里面可以放 ``` 代码块（收尾围栏至少一样长）", () => {
    const s = splitBubbles("````doc\n标题：用法\n```ts\nconst a = 1;\n```\n说明\n````\n\n好了。");
    expect(s.map((x) => x.kind)).toEqual(["doc", "text"]);
    expect(s[0]?.text).toBe("```ts\nconst a = 1;\n```\n说明");
  });

  test(":::group 与 :::card 指令块归一化并解析为原生状态卡片组", () => {
    const raw = [
      "已为你整理外部服务全景：",
      "",
      ":::group",
      ':::card{title="📬 邮件与日历" status="2 项已连"}',
      "- 电子邮箱（已连接）",
      "- 日历日程（已连接）",
      ":::",
      ':::card{title="🔔 随手推与入站触发" status="随时可用"}',
      "- Webhook（已就绪）",
      ":::",
      ":::",
      "",
      "还需要连接哪个？",
    ].join("\n");
    const normalized = normalizeDirectiveCards(raw);
    const segments = splitBubbles(normalized);
    expect(segments.map((x) => x.kind)).toEqual(["text", "code", "text"]);
    const cards = parseStatusCardsFence(segments[1]!.text);
    expect(cards).toEqual([
      {
        title: "📬 邮件与日历",
        status: "2 项已连",
        body: "- 电子邮箱（已连接）\n- 日历日程（已连接）",
      },
      {
        title: "🔔 随手推与入站触发",
        status: "随时可用",
        body: "- Webhook（已就绪）",
      },
    ]);
  });

  test("Hark 三段式自动折叠：多小节结构化 Markdown 自动折叠为 doc 卡片并保留导语与跟进句", () => {
    const raw = [
      "我已经把今天下午的执行清单整理好了，重点都标出来了：",
      "",
      "## 下午执行总览",
      "### 1. 优先处理事项",
      "- **客户邮件回复**：确认 Q4 报价单细节",
      "- **技术方案评审**：15:00 与后端团队对齐接口",
      "",
      "### 2. 待跟进任务",
      "- 检查生产环境日志告警",
      "- 更新项目排期表",
      "",
      "需要的话，我可以帮你直接起草客户邮件的回复。",
    ].join("\n");
    const normalized = normalizeDirectiveCards(raw);
    const segments = splitBubbles(normalized);
    expect(segments.map((x) => x.kind)).toEqual(["text", "doc", "text"]);
    expect(segments[0]?.text).toBe("我已经把今天下午的执行清单整理好了，重点都标出来了：");
    expect(segments[1]?.title).toBe("下午执行总览");
    expect(segments[1]?.text).toContain("### 1. 优先处理事项");
    expect(segments[2]?.text).toBe("需要的话，我可以帮你直接起草客户邮件的回复。");
  });

  test("Hark 站内操作胶囊行：自动拆分为独立段落供 HarkActionPill 渲染", () => {
    const raw = [
      "你目前还没有连接 Google 日历与邮箱，连接后我就能直接帮你读取今日日程。",
      "[连接 Google](/settings/connected-accounts)",
    ].join("\n");
    const normalized = normalizeDirectiveCards(raw);
    const segments = splitBubbles(normalized);
    expect(segments.map((x) => x.text)).toEqual([
      "你目前还没有连接 Google 日历与邮箱，连接后我就能直接帮你读取今日日程。",
      "[连接 Google](/settings/connected-accounts)",
    ]);
  });
});
