import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type HTMLButtonElement, type HTMLElement, Window } from "happy-dom";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

type StartupReport = {
  id: string;
  event: string;
  stage: string;
  resource?: string;
  category?: string;
  name?: string;
  line?: number;
  column?: number;
};

function startup(
  fetchMode: "working" | "missing" | "throwing" | "rejecting" = "working",
) {
  const window = new Window({ url: "https://app.example.test/admin/models" });
  const reports: StartupReport[] = [];
  const requests: { url: string; options: RequestInit }[] = [];
  window.fetch = (
    fetchMode === "missing"
      ? undefined
      : (url: unknown, options: RequestInit) => {
          if (fetchMode === "throwing")
            throw new Error("report transport failed");
          if (fetchMode === "rejecting")
            return Promise.reject(new Error("report transport failed"));
          requests.push({ url: String(url), options });
          reports.push(JSON.parse(String(options.body)) as StartupReport);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
  ) as typeof window.fetch;
  window.document.write(
    html.replace(/<script type="module"[^>]*><\/script>/g, ""),
  );
  const script = window.document.querySelector("#chisabot-startup-script");
  const timers: (() => void)[] = [];
  if (script)
    new Function("window", "document", "setTimeout", script.textContent ?? "")(
      window,
      window.document,
      (callback: () => void) => {
        timers.push(callback);
        return timers.length;
      },
    );
  return { window, document: window.document, timers, reports, requests };
}

function applicationError(window: Window, name = "Error") {
  const error = new Error("private-message");
  error.name = name;
  return new window.ErrorEvent("error", {
    filename:
      "https://app.example.test/assets/index-example.js?secret=private-query",
    error,
    message: "private-message",
  });
}

function entryScript(document: Window["document"], source: string) {
  const entry = document.createElement("script");
  entry.type = "module";
  document.head.append(entry);
  // Simulate the browser's resource event without Happy DOM attempting a real download.
  Object.defineProperty(entry, "src", { value: source });
  return entry;
}

function stageEvent(window: Window, detail: string) {
  // Happy DOM accepts string detail at runtime, but its declaration permits only objects.
  const event = new window.CustomEvent("chisabot-boot-stage");
  Object.defineProperty(event, "detail", { value: detail });
  return event;
}

test("the initial document remains visible before its application bundle arrives", () => {
  const { document } = startup();
  /*
   * 启动画面现在是一张骨架（先占住版式，脚本到了再换内容），屏幕上没有一行字——「正在加载」从可见文字
   * 变成了这张骨架的无障碍名字，骨架节点本身还在 DOM 里。
   */
  const status = document.querySelector("[role=status]");
  expect(status?.getAttribute("aria-label")).toContain("正在加载");
  expect(status?.querySelectorAll(".boot-bar").length).toBeGreaterThan(0);
});

test("a failed application script offers a safe manual reload", () => {
  const { window, document } = startup();
  let reloads = 0;
  window.location.reload = () => {
    reloads++;
  };
  window.dispatchEvent(applicationError(window));
  expect(document.querySelector("[role=alert]")?.textContent).toContain(
    "无法加载",
  );
  const retry = document.querySelector<HTMLButtonElement>("#chisabot-reload");
  expect(retry?.hidden).toBe(false);
  retry?.click();
  expect(reloads).toBe(1);
  expect(document.body.textContent).not.toContain("private-message");
});

test("a stalled bundle remains visible and offers retry instead of automatic navigation", () => {
  const { document, timers, window } = startup();
  for (const callback of timers) callback();
  /*
   * 超时说「慢」，不说「坏」：`role` 还是 `status`（只有 `showFailure` 会把它改成 `alert`），骨架还在，
   * 只是提示条露出来、标题换成超时那一句。
   */
  expect(
    document.querySelector("[role=status]")?.getAttribute("aria-label"),
  ).toContain("正在加载");
  expect(
    document.querySelector<HTMLElement>("#chisabot-startup-note")?.hidden,
  ).toBe(false);
  expect(document.querySelector("#chisabot-startup-title")?.textContent).toBe(
    "加载时间较长，请检查网络连接",
  );
  expect(
    document.querySelector<HTMLButtonElement>("#chisabot-reload")?.hidden,
  ).toBe(false);
  expect(window.location.pathname).toBe("/admin/models");
});

test("the bootstrap guard leaves a successfully mounted application alone", () => {
  const { document, timers, window } = startup();
  document.getElementById("root")!.textContent = "已打开模型设置";
  for (const callback of timers) callback();
  window.dispatchEvent(
    new window.ErrorEvent("error", { message: "later request error" }),
  );
  expect(document.getElementById("root")?.textContent).toBe("已打开模型设置");
  expect(document.querySelector("#chisabot-reload")).toBeNull();
});

test("the startup deadline preserves the first script failure instead of replacing it with a timeout", () => {
  const { window, document, timers, reports } = startup();
  window.dispatchEvent(applicationError(window));
  for (const callback of timers) callback();
  expect(document.querySelector("#chisabot-startup-title")?.textContent).toBe(
    "无法加载 ChisaBot，请检查网络连接",
  );
  expect(reports.map((report) => report.event)).toEqual(["shell", "error"]);
});

test("boot reports contain only a page id, stage and safe resource classification", () => {
  const { window, document, reports, requests } = startup();
  const entry = entryScript(
    document,
    "/assets/index-example.js?secret=private-query",
  );
  entry.dispatchEvent(new window.Event("error"));
  expect(reports).toHaveLength(2);
  expect(reports[0]?.id).toMatch(/^[A-Za-z0-9_-]{8,32}$/);
  expect(reports[1]).toEqual({
    id: reports[0]!.id,
    event: "error",
    stage: "shell",
    resource: "index-example.js",
    category: "resource",
  });
  expect(JSON.stringify(reports)).not.toContain("private-query");
  expect(
    requests.every((request) => request.url === "/auth/startup-report"),
  ).toBe(true);
  expect(requests[0]?.options).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    cache: "no-store",
  });
});

test("React commitment stops further startup reports and recovery timers", () => {
  const { window, document, timers, reports } = startup();
  const entry = entryScript(document, "/assets/index-example.js");
  entry.dispatchEvent(new window.Event("load"));
  window.dispatchEvent(
    stageEvent(window, "entry-executing"),
  );
  window.dispatchEvent(
    stageEvent(window, "react-mounted"),
  );
  document.getElementById("root")!.textContent = "已打开模型设置";
  window.dispatchEvent(
    new window.ErrorEvent("error", { message: "private-later-error" }),
  );
  window.dispatchEvent(
    stageEvent(window, "entry-executing"),
  );
  for (const callback of timers) callback();
  expect(reports.map((report) => report.event)).toEqual([
    "shell",
    "entry-loaded",
    "entry-executing",
    "react-mounted",
  ]);
  expect(new Set(reports.map((report) => report.id)).size).toBe(1);
  expect(document.getElementById("root")?.textContent).toBe("已打开模型设置");
});

test("untrusted event details and exception text never enter diagnostics", () => {
  const { window, reports } = startup();
  window.dispatchEvent(
    stageEvent(window, "private-token"),
  );
  window.dispatchEvent(applicationError(window, "SyntaxError"));
  expect(reports.map((report) => report.event)).toEqual(["shell", "error"]);
  expect(reports[1]?.category).toBe("syntax");
  expect(JSON.stringify(reports)).not.toContain("private-token");
  expect(reports[1]?.resource).toBe("index-example.js");
});

test("unsupported or failed diagnostic transport never interrupts startup recovery", async () => {
  for (const mode of ["missing", "throwing", "rejecting"] as const) {
    const { window, document, timers } = startup(mode);
    window.dispatchEvent(applicationError(window));
    for (const callback of timers) callback();
    await Promise.resolve();
    expect(document.querySelector("#chisabot-startup-title")?.textContent).toBe(
      "无法加载 ChisaBot，请检查网络连接",
    );
    expect(window.location.pathname).toBe("/admin/models");
  }
});

test("third-party scripts and their runtime errors cannot mark the application as failed", () => {
  const { window, document, reports } = startup();
  const beacon = entryScript(
    document,
    "https://static.cloudflareinsights.com/beacon.min.js?token=private",
  );
  beacon.dispatchEvent(new window.Event("error"));
  window.dispatchEvent(
    new window.ErrorEvent("error", {
      filename:
        "https://static.cloudflareinsights.com/beacon.min.js?token=private",
      error: new TypeError("private-error"),
      message: "private-error",
    }),
  );
  /*
   * 第三方脚本的失败连「坏」都算不上：骨架原地不动，`role` 没变成 `alert`，提示条也没露出来。
   */
  expect(document.querySelector("#chisabot-startup-title")?.textContent).toBe(
    "加载时间比平时长一些…",
  );
  expect(document.querySelector("[role=alert]")).toBeNull();
  expect(
    document.querySelector<HTMLElement>("#chisabot-startup-note")?.hidden,
  ).toBe(true);
  expect(reports.map((report) => report.event)).toEqual(["shell"]);
});

test("an application stylesheet failure is classified without exposing its request query", () => {
  const { window, document, reports } = startup();
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  document.head.append(stylesheet);
  Object.defineProperty(stylesheet, "href", {
    value: "/assets/index-example.css?private=query",
  });
  stylesheet.dispatchEvent(new window.Event("error"));
  expect(reports[1]).toMatchObject({
    event: "error",
    resource: "index-example.css",
    category: "resource",
  });
  expect(JSON.stringify(reports)).not.toContain("private=query");
});

test("runtime reports retain only allowlisted error names and bounded source coordinates", () => {
  const { window, reports } = startup();
  window.dispatchEvent(
    new window.ErrorEvent("error", {
      filename:
        "https://app.example.test/assets/index-example.js?private=query",
      error: new TypeError("private-message"),
      message: "private-message",
      lineno: 12,
      colno: 345,
    }),
  );
  expect(reports[1]).toMatchObject({
    event: "error",
    category: "runtime",
    name: "TypeError",
    line: 12,
    column: 345,
  });
  expect(JSON.stringify(reports)).not.toContain("private-message");
  expect(JSON.stringify(reports)).not.toContain("private=query");
});

test("unknown error names and invalid source coordinates are omitted", () => {
  const { window, reports } = startup();
  const error = new Error("private-message");
  error.name = "private-name";
  window.dispatchEvent(
    new window.ErrorEvent("error", {
      filename: "https://app.example.test/assets/index-example.js",
      error,
      lineno: 10_000_001,
      colno: 1.5,
    }),
  );
  expect(reports[1]?.name).toBeUndefined();
  expect(reports[1]?.line).toBeUndefined();
  expect(reports[1]?.column).toBeUndefined();
  expect(JSON.stringify(reports)).not.toContain("private-name");
});

test("promise failures can report their allowlisted name but never stack coordinates", () => {
  const { window, reports } = startup();
  const event = new window.Event("unhandledrejection");
  const reason = new Error("private-message");
  reason.name = "ReferenceError";
  reason.stack =
    "private-message at https://app.example.test/assets/index-example.js?private=query:12:345";
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
  expect(reports[1]).toMatchObject({
    event: "error",
    category: "promise",
    name: "ReferenceError",
  });
  expect(reports[1]?.line).toBeUndefined();
  expect(reports[1]?.column).toBeUndefined();
  expect(JSON.stringify(reports)).not.toContain("private-message");
  expect(JSON.stringify(reports)).not.toContain("private=query");
});
