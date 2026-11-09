// Server-side E2E for DESIGN.md §38 against a side preview whose default model is mock-model.mjs.
// SCENARIO=steer : a reply is streaming; two messages arrive through the inbox and one through a second
//                  /run request (the old 409 path). Nothing is rejected, the running reply is not
//                  interrupted, every message ends up in the transcript and is answered.
// SCENARIO=worker: the bot delegates; the card state moves queued→running→done with a plan; a steer
//                  message reaches the worker; the result comes back into the thread with a summary.
const BASE = process.env.BASE || "http://127.0.0.1:3098";
const BOT = process.env.BOT;
const SCENARIO = process.env.SCENARIO || "steer";
const H = { "content-type": "application/json", origin: BASE };
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
let failures = 0;
const check = (ok, what) => { log(ok ? "PASS" : "FAIL", what); if (!ok) failures++; };

async function run(threadId, messages, label) {
  const runId = uuid();
  const response = await fetch(`${BASE}/api/conversations/agent/${BOT}/run`, {
    method: "POST", headers: { ...H, accept: "text/event-stream" },
    body: JSON.stringify({ threadId, runId, messages, tools: [], context: [], state: {}, forwardedProps: {} }),
  });
  log(label, "run status", response.status);
  const events = [];
  if (!response.ok) return { status: response.status, events, text: await response.text() };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop();
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try { events.push(JSON.parse(line.slice(6))); } catch {}
    }
  }
  return { status: response.status, events };
}
const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join(""));
const messages = async (threadId) => (await (await fetch(`${BASE}/api/conversations/threads/${threadId}/messages`, { headers: H })).json()).messages;
const inbox = async (threadId) => (await (await fetch(`${BASE}/api/conversations/threads/${threadId}/inbox`, { headers: H })).json());
const queue = async (threadId, text) => {
  const response = await fetch(`${BASE}/api/conversations/threads/${threadId}/inbox`, { method: "POST", headers: H, body: JSON.stringify({ id: uuid(), text }) });
  return { status: response.status, body: await response.json() };
};

if (SCENARIO === "steer") {
  const threadId = uuid();
  const first = { id: uuid(), role: "user", content: "WORK 帮我做三步" };
  const started = Date.now();
  const main = run(threadId, [first], "main");
  await sleep(2500);
  const q1 = await queue(threadId, "只看 2026 年的");
  log("queue 1", q1.status, JSON.stringify(q1.body));
  check(q1.status === 200 && q1.body.queued === true, "message sent mid-reply is queued, not rejected");
  await sleep(1500);
  const q2 = await queue(threadId, "再加上价格");
  check(q2.status === 200 && q2.body.queued === true, "second mid-reply message queued");
  // The old 409 path: a second /run while the first streams. It now joins the running reply.
  const joinMessage = { id: uuid(), role: "user", content: "顺便列出来源" };
  const joined = run(threadId, [first, joinMessage], "join");
  const state = await inbox(threadId);
  log("inbox while running", JSON.stringify(state.items.map((i) => [i.message.content, i.status])));
  check(state.running === true, "inbox reports the thread as running");
  const [mainResult, joinResult] = await Promise.all([main, joined]);
  log("main took", Date.now() - started, "ms; events", mainResult.events.length, "; join events", joinResult.events.length);
  check(joinResult.status === 200, "second /run while running is not a 409");
  const types = mainResult.events.map((e) => e.type);
  check(types.filter((t) => t === "RUN_STARTED").length === 1 && types.filter((t) => t === "RUN_FINISHED").length === 1, "one continuous run (one RUN_STARTED, one RUN_FINISHED)");
  check(!types.includes("RUN_ERROR"), "no RUN_ERROR");
  check(types.includes("MESSAGES_SNAPSHOT"), "injection pushed to the live stream (MESSAGES_SNAPSHOT)");
  await sleep(500);
  const saved = await messages(threadId);
  const order = saved.map((m) => `${m.role}:${textOf(m).slice(0, 30)}`);
  log("transcript", JSON.stringify(order, null, 0));
  for (const text of ["只看 2026 年的", "再加上价格", "顺便列出来源"]) {
    const at = saved.findIndex((m) => m.role === "user" && textOf(m) === text);
    check(at > 0, `「${text}」is in the transcript`);
    const answer = saved.slice(at).find((m) => m.role === "assistant" && (/已按补充调整/.test(textOf(m)) || /^收到：/.test(textOf(m))) && textOf(m).includes(text));
    check(Boolean(answer), `「${text}」is answered after it`);
  }
  const firstAnswerAt = saved.findIndex((m) => m.role === "assistant" && /第 1 步/.test(textOf(m)));
  const q1At = saved.findIndex((m) => textOf(m) === "只看 2026 年的");
  check(firstAnswerAt > 0 && firstAnswerAt < q1At, "the running reply was not interrupted: step 1 precedes the injected message");
  const after = await inbox(threadId);
  log("inbox after", JSON.stringify(after.items.map((i) => [i.message.content, i.status])));
  check(after.running === false && after.items.filter((i) => i.message.content !== undefined).every((i) => i.status === "answered"), "every inbox item ended answered");
  // idle thread: inbox tells the client to send normally
  const idle = await queue(threadId, "现在发");
  check(idle.body.queued === false, "idle thread: client is told to send normally");
}

if (SCENARIO === "worker") {
  const threadId = uuid();
  const first = { id: uuid(), role: "user", content: "DELEGATE 帮我在后台做个测试任务" };
  const r = await run(threadId, [first], "delegate");
  check(r.status === 200 && !r.events.some((e) => e.type === "RUN_ERROR"), "delegating turn finished");
  const workers = async () => (await (await fetch(`${BASE}/api/conversations/threads/${threadId}/workers`, { headers: H })).json()).workers;
  let list = await workers();
  log("workers", JSON.stringify(list));
  check(list.length === 1, "one worker created");
  const id = list[0]?.id;
  let steered = false;
  const seen = new Set();
  const plans = new Set();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    list = await workers();
    const w = list[0];
    seen.add(w.status);
    if (w.plan?.length) plans.add(w.plan.map((s) => s.status[0]).join(""));
    log("worker", w.status, "|", w.step, "|", w.plan?.map((s) => `${s.text}:${s.status}`).join(", "));
    if (w.status === "running" && !steered && w.plan?.some((s) => s.status === "done")) {
      const s = await fetch(`${BASE}/api/conversations/threads/${threadId}/workers`, { method: "POST", headers: H, body: JSON.stringify({ workerId: id, action: "steer", text: "结果里写上日期" }) });
      check(s.status === 200, "steer accepted while running");
      steered = true;
    }
    if (!["queued", "running"].includes(w.status)) break;
    await sleep(700);
  }
  const final = (await workers())[0];
  log("final", JSON.stringify(final));
  check(seen.has("running") && final.status === "done", "worker ran and finished");
  check(plans.size >= 2, `plan moved through states (${[...plans].join(" → ")})`);
  check(Boolean(final.summary && final.summary.includes("后台结果")), "result summary on the card");
  check(Boolean(final.summary && final.summary.includes("日期")), "steer message reached the worker");
  // delivery: worker-result message + assistant summary in the thread (headless turn)
  let saved = [];
  for (let i = 0; i < 40; i++) {
    saved = await messages(threadId);
    if (saved.some((m) => m.role === "assistant" && /后台任务做完了/.test(textOf(m)))) break;
    await sleep(500);
  }
  log("transcript", JSON.stringify(saved.map((m) => `${m.role}:${textOf(m).slice(0, 40)}`)));
  const resultAt = saved.findIndex((m) => m.role === "user" && textOf(m).startsWith("⟦chisabot:worker-result:"));
  check(resultAt > 0 && saved[resultAt].id === final.resultMessageId, "worker result came back into the thread");
  check(saved.slice(resultAt).some((m) => m.role === "assistant" && /后台任务做完了/.test(textOf(m))), "main bot summarised the result");
  // cancel path (after the summarising turn has fully ended)
  for (let i = 0; i < 20 && (await inbox(threadId)).running; i++) await sleep(300);
  const r2 = await run(threadId, [...saved, { id: uuid(), role: "user", content: "DELEGATE 再来一个" }], "delegate2");
  log("delegate2 events", r2.events.map((e) => e.type + (e.message ? ":" + e.message : "")).join(","));
  check(r2.status === 200 && !r2.events.some((e) => e.type === "RUN_ERROR"), "second delegation turn");
  await sleep(1500);
  list = await workers();
  const second = list[list.length - 1];
  const c = await fetch(`${BASE}/api/conversations/threads/${threadId}/workers`, { method: "POST", headers: H, body: JSON.stringify({ workerId: second.id, action: "cancel" }) });
  check(c.status === 200, "cancel accepted");
  await sleep(1500);
  const cancelled = (await workers()).find((w) => w.id === second.id);
  check(cancelled.status === "cancelled", "worker cancelled");
}

log(failures ? `RESULT FAIL (${failures})` : "RESULT PASS");
process.exit(failures ? 1 : 0);
