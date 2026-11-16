// OpenAI 兼容假模型（DESIGN.md §88 回归用；从 tests/ui-align/mock-model.mjs 复制，加了 SCHED / WORKL），端口 PORT（默认 4012）。最后一条用户消息决定：
//   "DELEGATE" -> delegate_task，参数按 6 字一段、每 300ms 流出（约 6 秒），之后一句话
//   "DELEGATE2"-> 同上，但参数里 task 在 title 前面（CB-023：先用说明头一句）
//   "PAGE2"    -> page_create → page_update → page_update（同一页面），之后一句话
//   "PAGES2"   -> 两个不同页面各 page_create 一次
//   "READ"     -> memory_search / page_list 一类只读工具（有哪个用哪个），之后一句话
import http from "node:http";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join("");
  }
  return "";
}
// 这一轮（最后一条 user 之后）已经有几个工具结果、最近一个结果的文本
function turnTools(messages) {
  let i = messages.length - 1; const res = [];
  for (; i >= 0 && messages[i].role !== "user"; i--) if (messages[i].role === "tool") res.unshift(typeof messages[i].content === "string" ? messages[i].content : JSON.stringify(messages[i].content));
  return res;
}
http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "mock2", object: "model" }] })); }
  let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
  console.log(new Date().toISOString(), req.method, req.url, j.model, (j.messages || []).length, (j.tools || []).length);
  if (j.tools?.length) console.log("TOOLS", j.tools.map((t) => t.function?.name).join(" "));
  const messages = j.messages || []; const user = lastUser(messages); const done = turnTools(messages);
  const tools = (j.tools || []).map((t) => t.function?.name).filter(Boolean);
  const id = `chatcmpl-${Date.now()}`; const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock2" };
  if (!j.stream) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ id, object: "chat.completion", model: "mock2", choices: [{ index: 0, message: { role: "assistant", content: "测试标题" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  const text = async (t) => { send({ ...base, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }); };
  const call = async (name, args, { size = 4000, gap = 0 } = {}) => {
    const cid = `call_${Date.now()}`;
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: cid, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }] });
    const a = Array.from(args);
    for (let i = 0; i < a.length; i += size) { send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(i, i + size).join("") } }] }, finish_reason: null }] }); if (gap) await sleep(gap); }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    res.write("data: [DONE]\n\n"); res.end();
  };
  const pageId = (s) => /(pg_[a-z0-9]+)/i.exec(s || "")?.[1];
  if (/DELEGATE2/.test(user) && done.length === 0 && tools.includes("delegate_task")) {
    await text("好，我交给后台去做。");
    return call("delegate_task", JSON.stringify({ task: "对比索尼 WH-1000XM6、Bose QC Ultra、AirPods Max 的降噪、续航、价格，列成表。这是测试任务，直接回答“测试完成”即可。", title: "对比三款降噪耳机", plan: ["查三款参数", "整理成表"] }), { size: 6, gap: 300 });
  }
  if (/DELEGATE/.test(user) && done.length === 0 && tools.includes("delegate_task")) {
    await text("好，我交给后台去做。");
    return call("delegate_task", JSON.stringify({ title: "对比三款降噪耳机", task: "对比索尼 WH-1000XM6、Bose QC Ultra、AirPods Max 的降噪、续航、价格，列成表。这是测试任务，直接回答“测试完成”即可。", plan: ["查三款参数", "整理成表"] }), { size: 6, gap: 300 });
  }
  if (/PAGES2/.test(user) && done.length < 2 && tools.includes("page_create")) {
    const n = done.length + 1;
    return call("page_create", JSON.stringify({ title: `测试页 ${n}`, html: `<h1>测试页 ${n}</h1><p>CB-021 测试，第 ${n} 个页面。</p>` }));
  }
  if (/PAGE2/.test(user) && tools.includes("page_create")) {
    if (done.length === 0) return call("page_create", JSON.stringify({ title: "测试页", html: "<h1>测试页</h1><p>第一版</p>" }));
    if (done.length < 3) { const pg = pageId(done.join(" ")); return call("page_update", JSON.stringify({ page: pg, edits: [{ find: done.length === 1 ? "第一版" : "第二版", replace: done.length === 1 ? "第二版" : "第三版" }], note: `改到第 ${done.length + 1} 版` }), { size: 8, gap: 120 }); }
  }
  if (/READ/.test(user) && done.length === 0) {
    const name = tools.find((n) => /^(memory_search|page_list|schedule_list|github_list_repos|skill_list)$/.test(n));
    if (name) return call(name, name === "memory_search" ? JSON.stringify({ query: "测试" }) : "{}");
  }
  // §74 干活卡：WORK = 看技能 → 开场一句 + 搜索 → 过程话 + 读网页 → 慢慢写的结果；CARD = 搜索 → 过程话 + 搜索 → 一句 + render_ui 收尾（没有结果文字）
  const pick = (...names) => names.find((n) => tools.includes(n)) || names[names.length - 1];
  const SEARCH = pick("web_search", "memory_search", "page_list");
  const FETCH = pick("web_fetch", "memory_search", "page_list");
  const argsFor = (n, q) => n === "web_search" || n === "memory_search" ? JSON.stringify({ query: q }) : n === "web_fetch" ? JSON.stringify({ url: "https://www.apple.com.cn/iphone/" }) : "{}";
  // cb-state：SCHED = 设一个 10 小时后的提醒（日程卡）后一句话；WORKL = WORK 的步骤 + 30 句慢慢写的长结果
  if (/^SCHED\b/.test(user.trim()) && tools.includes("schedule_create") && done.length === 0) {
    await text("好，我帮你设个提醒。"); await sleep(500);
    return call("schedule_create", JSON.stringify({ title: "测试提醒", instruction: "提醒用户：这是滚动测试（预览）。", in_minutes: 600 }), { size: 8, gap: 80 });
  }
  if (/^WORKL\b/.test(user.trim())) {
    if (done.length === 0) { await sleep(600); return call(SEARCH, argsFor(SEARCH, "准备"), { size: 6, gap: 100 }); }
    if (done.length === 1) { await text("我去查一下。"); await sleep(600); return call(SEARCH, argsFor(SEARCH, "iPhone 17 Pro 国行价格"), { size: 6, gap: 150 }); }
    if (done.length === 2) { await sleep(900); await text("再核对一下官网的价格。"); await sleep(500); return call(FETCH, argsFor(FETCH, "官网价格"), { size: 6, gap: 150 }); }
    await sleep(800);
    for (let i = 0; i < 30; i++) { await text(i === 0 ? "国行起售价 8999 元（256GB）。" : `第${i + 1}句慢慢写出来的结果，用来把回答撑长一点。`); await sleep(160); if (i % 6 === 5) await text("\n\n"); }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    res.write("data: [DONE]\n\n"); return res.end();
  }
  // §77 面板：建卡 → 搜两次（慢慢流出参数）→ panel_update（2 个磁贴 + 1 张图 + 带「·」的一行；来源 5 个、3 个网站）→ 一句话
  if (/^PANEL\b/.test(user.trim()) && tools.includes("panel_create")) {
    if (done.length === 0) { await text("我做一张东京和上海的天气面板。"); await sleep(400); return call("panel_create", JSON.stringify({ title: "东京与上海天气", instruction: "测试面板：东京和上海现在的气温（Open-Meteo），版式 F。", refreshMinutes: 60 })); }
    if (done.length === 1) { await sleep(1800); return call(SEARCH, argsFor(SEARCH, "东京 现在 天气"), { size: 4, gap: 200 }); }
    if (done.length === 2) { await sleep(1800); return call(SEARCH, argsFor(SEARCH, "上海 现在 天气"), { size: 4, gap: 200 }); }
    if (done.length === 3) {
      let id = ""; try { id = JSON.parse(done[0]).id; } catch { id = /"id":"([^"]+)"/.exec(done[0] || "")?.[1] || ""; }
      await sleep(1500);
      const spec = { root: "r", elements: {
        r: { type: "Stack", props: { gap: "md" }, children: ["t", "g", "d", "c"] },
        t: { type: "Text", props: { text: "东京 02:30 · 上海 01:30", tone: "muted", size: "sm" }, children: [] },
        g: { type: "Grid", props: { columns: 2 }, children: ["a", "b"] },
        a: { type: "Metric", props: { label: "东京", value: "15.7℃", icon: "cloud", variant: "tinted", tone: "info" }, children: [] },
        b: { type: "Metric", props: { label: "上海", value: "20.6℃", icon: "cloud", variant: "tinted", tone: "accent" }, children: [] },
        d: { type: "Text", props: { text: "东京降水 0 mm · 风速 5.4 km/h · 上海风速 7.9 km/h", tone: "muted", size: "sm" }, children: [] },
        c: { type: "Chart", props: { kind: "line", labels: ["+1时", "+2时", "+3时", "+4时", "+5时", "+6时"], series: [{ name: "东京", data: [15.4, 15.2, 15.1, 15.3, 15.9, 16.8], tone: "info" }, { name: "上海", data: [20.4, 20.2, 20.0, 19.9, 20.3, 20.9], tone: "accent" }], unit: "°", height: 110 }, children: [] },
      } };
      const sources = [
        { name: "Open-Meteo 东京 forecast API", url: "https://api.open-meteo.com/v1/forecast?latitude=35.68&longitude=139.69" },
        { name: "Open-Meteo 上海 forecast API", url: "https://api.open-meteo.com/v1/forecast?latitude=31.23&longitude=121.47" },
        { name: "Open-Meteo API 文档", url: "https://open-meteo.com/en/docs" },
        { name: "中国天气网", url: "https://www.weather.com.cn/weather/101020100.shtml" },
        { name: "日本气象厅", url: "https://www.jma.go.jp/bosai/forecast/" },
      ];
      return call("panel_update", JSON.stringify({ id, spec: JSON.stringify(spec), sources }), { size: 60, gap: 40 });
    }
    await text("东京和上海的天气面板做好了，每小时自动刷新。");
  } else
  // §78.2 PAUSE：开场一句 → 停 2.5 秒（这时该有小点）→ 搜索 → 结果
  if (/^PAUSE\b/.test(user.trim())) {
    if (done.length === 0) { await text("我先看一下。"); await sleep(2500); return call(SEARCH, argsFor(SEARCH, "停顿测试"), { size: 6, gap: 120 }); }
    await sleep(800);
    for (let i = 0; i < 6; i++) { await text(i === 0 ? "结果：一切正常。" : `第${i + 1}句。`); await sleep(200); }
  } else
  if (/^DOC\b/.test(user.trim())) {
    await text("React 19 主要让表单和异步更新更省事。\n\n```doc\n标题：React 19 新特性\n");
    const lines = ["## Actions", "- `<form action={fn}>` 直接调用异步函数", "- 提交中的状态由 React 处理", "", "## 新 Hook", "- useActionState：拿结果和 pending", "- useFormStatus：读父表单状态", "- useOptimistic：先显示乐观结果", "", "## use API", "渲染时读取 Promise 或 Context，配合 Suspense。", "", "## Server Components", "正式进入稳定版，通常依赖框架。", "", "## 其他", "- ref 可以直接当 prop", "- 文档标题、meta 直接写在组件里", "- 静态预渲染 API", "- Suspense 改进", "", "| 项目 | 说明 |", "|---|---|", "| 升级 | 先看官方升级指南 |", "| 类型 | 旧 API 移除 |"];
    for (const l of lines) { await text(`${l}\n`); await sleep(140); }
    await text("```\n\n要我按升级顺序再排一下吗？");
  } else
  if (/^WORK\b/.test(user.trim())) {
    if (done.length === 0) { await sleep(800); return call(tools.includes("skill_list") ? "skill_list" : SEARCH, tools.includes("skill_list") ? "{}" : argsFor(SEARCH, "准备")); }
    if (done.length === 1) { await text("我去查一下。"); await sleep(600); return call(SEARCH, argsFor(SEARCH, "iPhone 17 Pro 国行价格"), { size: 6, gap: 150 }); }
    if (done.length === 2) { await sleep(1500); for (const t of ["再核对", "一下官网", "的价格。"]) { await text(t); await sleep(300); } await sleep(800); return call(FETCH, argsFor(FETCH, "官网价格"), { size: 6, gap: 150 }); }
    await sleep(1200);
    for (let i = 0; i < 12; i++) { await text(i === 0 ? "国行起售价 8999 元（256GB）。" : `第${i + 1}句结果。`); await sleep(220); if (i === 5) await text("\n\n"); }
  } else if (/^CARD\b/.test(user.trim())) {
    if (done.length === 0) { await text("我去查一下。"); await sleep(500); return call(SEARCH, argsFor(SEARCH, "北京 10 月 平均气温"), { size: 6, gap: 120 }); }
    if (done.length === 1) { await text("深圳没查到，我再核对。"); await sleep(500); return call(SEARCH, argsFor(SEARCH, "深圳 10 月 降水"), { size: 6, gap: 120 }); }
    if (done.length === 2) {
      await text("表里深圳降水未核实。");
      const spec = { root: "r", elements: { r: { type: "Stack", props: { gap: "md" }, children: ["tb"] }, tb: { type: "Table", props: { columns: [{ key: "c", label: "城市" }, { key: "t", label: "气温", align: "right" }], rows: [{ c: "北京", t: "14.5°" }, { c: "深圳", t: "25°" }] }, children: [] } } };
      return call("render_ui", JSON.stringify({ spec: JSON.stringify(spec) }), { size: 40, gap: 60 });
    }
  } else
  // 滚动回归（tests/chat-scroll）用：SLOW = 40 句慢慢流出（每句 260ms），LINK = 一行链接（同 cb-unify/mockcards.mjs）
  if (/^SLOW\b/.test(user.trim())) { for (let i = 0; i < 40; i++) { await text(`第${i + 1}句慢慢写的长回答。`); await sleep(260); } }
  else if (/^LINK\b/.test(user.trim())) await text("链接在这里：\n\nhttps://example.com/\n");
  else await text(done.length ? "好了，都做完了。" : "你好，我是测试模型。");
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  res.write("data: [DONE]\n\n"); res.end();
}).listen(Number(process.env.PORT || 4012), () => console.log("mock3 on 4012"));
