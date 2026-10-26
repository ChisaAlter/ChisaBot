// turn.mjs — DESIGN §100 e2e：原生 <select> 选择 + 回合异常结束有提示。预览（pv.sh）或生产（prod.sh，临时会话）都能跑。
// 一次性机器人（guard.mjs 建 / 删），不碰任何已有机器人和对话。
import fs from "node:fs";
import { api, base, browser, context, errors, log, mkBot, newPage, chisaBot, send, transcript, waitIdle } from "./lib.mjs";
import { guardInit, guardedDeleteBot, trackBot } from "./guard.mjs";

const PARTS = (process.env.PARTS || "A,B,C,D").split(",");
const results = [];
const ok = (name, pass, info = "") => { results.push({ name, pass, info }); log(pass ? "PASS" : "FAIL", name, String(info).slice(0, 400)); };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Birthday test</title></head><body style="font:16px sans-serif;padding:40px">
<h1>When's your birthday?</h1>
<label>Month <select id="m" aria-label="Month"><option value="" disabled selected>Month</option>${MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join("")}</select></label>
<label>Day <select id="d" aria-label="Day"><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => `<option>${i + 1}</option>`).join("")}</select></label>
<label>Year <select id="y" aria-label="Year"><option value="">Year</option>${Array.from({ length: 100 }, (_, i) => `<option>${2026 - i}</option>`).join("")}</select></label>
<p id="out">已选：未选</p>
<script>
const pad = (n) => String(n).padStart(2, "0");
const show = () => { const m = document.getElementById("m").value, d = document.getElementById("d").value, y = document.getElementById("y").value;
  document.getElementById("out").textContent = "已选：" + (y || "????") + "-" + (m === "" ? "??" : pad(Number(m) + 1)) + "-" + (d ? pad(d) : "??"); };
for (const s of document.querySelectorAll("select")) s.addEventListener("change", show);
</script></body></html>`;
const URL_ = "https://workspace.local/sel-form.html";

const ctx = await context("light", { width: 1280, height: 860 });
const page = await newPage(ctx, "sel");
await page.goto(base + "/", { waitUntil: "domcontentloaded" });
const call = (p, o) => api(page, p, o);
await guardInit(call);
const r = await call("/api/agents", { method: "POST", body: JSON.stringify({ name: "临时测试 下拉框", title: "临时测试（会删除）", roleDescription: "你是测试助手，回答简短，用中文。", visibility: "private" }) });
const bot = trackBot(JSON.parse(r.body).agent.id);
fs.appendFileSync("/out/bots.txt", bot + "\n");
log("bot", bot);
const C = (path, body) => call(`/api/computers/${bot}${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
const J = (x) => { try { return JSON.parse(x.body); } catch { return {}; } };
const readOut = async () => (J(await call(`/api/computers/${bot}/read`, {})).text || "").match(/已选：\S+/)?.[0] ?? "";

try {
  const w = await C("/files/write", { path: "sel-form.html", contents: FORM });
  ok("write form", w.status === 200, w.status + " " + w.body.slice(0, 120));

  if (PARTS.includes("A")) {
    const nav = await C("/navigate", { url: URL_ });
    ok("A navigate", nav.status === 200, nav.status + " " + nav.body.slice(0, 120));
    const snap = J(await C("/snapshot"));
    const els = snap.elements || [];
    const month = els.find((e) => e.role === "combobox" && /Month/.test(e.name));
    const day = els.find((e) => e.role === "combobox" && /Day/.test(e.name));
    const year = els.find((e) => e.role === "combobox" && /Year/.test(e.name));
    ok("A snapshot lists selects with options", !!month && Array.isArray(month.options) && month.options.includes("Jul") && year?.options?.length === 61 && !els.some((e) => e.role === "option"), JSON.stringify(month) + " total " + els.length);
    const click = await C("/click", { ref: month.ref, snapshotId: snap.snapshotId });
    const cj = J(click);
    ok("A click on a select does not open it, lists options", click.status === 200 && cj.nativeSelect === true && Array.isArray(cj.options), click.status + " " + click.body.slice(0, 200));
    for (const [el, text] of [[month, "7"], [day, "12"], [year, "2000"]]) {
      const t = await C("/type", { ref: el.ref, snapshotId: snap.snapshotId, text });
      ok(`A type ${el.name}=${text}`, t.status === 200 && J(t).action === "select", t.status + " " + t.body.slice(0, 200));
    }
    const out = await readOut();
    ok("A page shows 2000-07-12", out === "已选：2000-07-12", out);
    const bad = await C("/type", { ref: year.ref, snapshotId: snap.snapshotId, text: "1800" });
    ok("A missing option is a 400 with the choices", bad.status === 400 && /没有「1800」/.test(bad.body), bad.status + " " + bad.body.slice(0, 160));
    const key = await C("/key", { ref: month.ref, snapshotId: snap.snapshotId, key: "Enter" });
    ok("A Enter on a select does not hang", key.status === 200 && J(key).nativeSelect === true, key.status + " " + key.body.slice(0, 160));
    await C("/navigate", { url: URL_ });
  }

  if (PARTS.includes("B")) {
    await chisaBot(page, bot);
    const q = `用你的浏览器打开 ${URL_} ，把出生日期选成 2000 年 7 月 12 日（三个都是下拉框）。选好后读一下页面，告诉我「已选：」后面显示的是什么。`;
    await send(page, q);
    const ms = await waitIdle(page, { max: 300000 });
    const t = await transcript(page);
    const out = await readOut();
    const stopped = await page.locator('[data-testid="transcript-stopped"]').isVisible().catch(() => false);
    ok("B bot selected 2000-07-12 on the page", out === "已选：2000-07-12", `${out} in ${Math.round(ms / 1000)}s`);
    ok("B bot answered with the result", /2000-07-12/.test(t.split("告诉我「已选：」后面显示的是什么。").pop() || ""), (t.split("后面显示的是什么。").pop() || "").slice(-300));
    ok("B no error notice", !stopped);
    await page.screenshot({ path: "/out/sel-B.png" });
  }

  if (PARTS.includes("C")) {
    // 一轮里接力的第二个 run 失败（模拟上游 500）：以前 awaitingReply 在第一个 run 结束时就放下了，这种失败不报。
    if (!PARTS.includes("B")) await chisaBot(page, bot);
    let runs = 0;
    await page.route("**/api/copilotkit/agent/*/run", async (route) => {
      runs += 1;
      if (runs === 2) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "simulated upstream failure (e2e)" }) });
      return route.continue();
    });
    await send(page, "先调用 computer_read 读取当前页面，然后告诉我月份下拉框选的是什么。");
    await waitIdle(page, { max: 180000 });
    await page.unroute("**/api/copilotkit/agent/*/run");
    const card = page.locator('[data-testid="transcript-stopped"]');
    const visible = await card.isVisible().catch(() => false);
    const text = visible ? await card.innerText() : "";
    const retry = visible ? await card.getByRole("button", { name: "重试" }).isVisible().catch(() => false) : false;
    ok("C failed follow-up run shows a notice", visible && runs >= 2, `runs=${runs} ${text.replace(/\s+/g, " ").slice(0, 200)}`);
    ok("C notice has 重试", retry);
    await page.screenshot({ path: "/out/sel-C.png" });
  }

  if (PARTS.includes("D")) {
    // 生产事故本身：计算机改动请求回 500。修好后机器人拿到「没做成」的结果，接着做并说明，不会静默结束。
    if (!PARTS.includes("B") && !PARTS.includes("C")) await chisaBot(page, bot);
    let failed = 0;
    await page.route("**/api/approvals/computer/*", async (route) => {
      if (failed === 0) { failed += 1; return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Element e99 is not on the page any more. Take a fresh snapshot and use the refs from it." }) }); }
      return route.continue();
    });
    const before = (await transcript(page)).length;
    await send(page, "把年份改成 1999，改好后告诉我「已选：」后面显示什么。");
    await waitIdle(page, { max: 300000 });
    await page.unroute("**/api/approvals/computer/*");
    const t = (await transcript(page)).slice(before);
    const stopped = await page.locator('[data-testid="transcript-stopped"]').isVisible().catch(() => false);
    const out = await readOut();
    ok("D injected computer failure happened", failed === 1);
    ok("D turn did not end silently (bot kept going or said why)", out === "已选：1999-07-12" || stopped || /1999|没有成功|失败|重新/.test(t), `${out} stopped=${stopped} tail=${t.slice(-240).replace(/\s+/g, " ")}`);
    ok("D bot recovered and selected 1999", out === "已选：1999-07-12", out);
    await page.screenshot({ path: "/out/sel-D.png" });
  }
} catch (error) {
  ok("script", false, String(error?.stack || error).slice(0, 600));
} finally {
  const d = await guardedDeleteBot(call, bot);
  log("deleted bot", bot, JSON.stringify(d).slice(0, 160));
  log("ERRORS", JSON.stringify(errors.filter((e) => !/simulated|e99|approvals\/computer/.test(e)).slice(0, 12)));
  const pass = results.filter((x) => x.pass).length;
  log("SUMMARY", `${pass}/${results.length}`, results.filter((x) => !x.pass).map((x) => x.name).join(" | "));
  await browser.close();
}
