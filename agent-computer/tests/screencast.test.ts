import { describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  egressDocumentProblem,
  type InputMessage,
  navigationProblem,
  startScreencast,
} from "../src/screencast";

/**
 * What a person's keystroke turns into on the wire.
 *
 * `screencast.ts` imports Playwright for its types only, and a type import is gone at run time, so
 * this reaches the translation without a browser. What it cannot reach is what Chrome then does with
 * it, which is the half that was wrong: `rawKeyDown` and `keyDown` are both delivered to the page,
 * and only one of them makes Chrome carry out what the key means. That difference was measured
 * against Chromium 151 rather than guessed, and this file pins the parameters that measurement
 * settled on.
 */

/** A CDP session that records what was asked of it, and answers everything. */
function recording() {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    on() {},
    async send(method: string, params: Record<string, unknown> = {}) {
      sent.push({ method, params });
    },
    async detach() {},
  };
  const page = {
    context: () => ({ newCDPSession: async () => client }),
  } as unknown as Page;
  return { page, sent };
}

/** The parameters of the one key event a message produced. */
async function dispatched(message: InputMessage) {
  const { page, sent } = recording();
  const cast = await startScreencast(page, () => {});
  sent.length = 0;
  await cast.send(message);
  const keyEvents = sent.filter(
    (call) => call.method === "Input.dispatchKeyEvent",
  );
  expect(keyEvents).toHaveLength(1);
  return keyEvents[0]?.params as Record<string, unknown>;
}

/** A keystroke exactly as the live screen sends one: text only for a printable character. */
function typed(
  event: "down" | "up",
  key: string,
  code: string,
  keyCode: number,
): InputMessage {
  return {
    type: "key",
    event,
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    ...(key.length === 1 ? { text: key } : {}),
    modifiers: 0,
  };
}

describe("a key a person presses while they hold the wheel", () => {
  test("Enter is a press the page acts on, not one it merely hears", async () => {
    // Measured through this file against Chromium 151: as a `rawKeyDown` the page's own `keydown`
    // listener saw Enter and nothing else happened -- the sign-in form did not submit, a textarea
    // did not take a new line, and a focused button was not pressed.
    const params = await dispatched(typed("down", "Enter", "Enter", 13));
    expect(params.type).toBe("keyDown");
    expect(params.text).toBe("\r");
  });

  test("a printable character keeps the text the person typed", async () => {
    const params = await dispatched(typed("down", "a", "KeyA", 65));
    expect(params.type).toBe("keyDown");
    expect(params.text).toBe("a");
  });

  test("a key that produces no character is still a rawKeyDown", async () => {
    // Backspace, Delete, Tab, Home, End and the arrows were all measured to do what they mean
    // without text, so filling one in for them would be inventing an insertion.
    for (const [key, code, keyCode] of [
      ["Backspace", "Backspace", 8],
      ["Delete", "Delete", 46],
      ["Tab", "Tab", 9],
      ["ArrowLeft", "ArrowLeft", 37],
      ["Home", "Home", 36],
    ] as const) {
      const params = await dispatched(typed("down", key, code, keyCode));
      expect(params.type).toBe("rawKeyDown");
      expect(params).not.toHaveProperty("text");
    }
  });

  test("Enter going up is a key up carrying nothing it was not given", async () => {
    // The fill-in belongs to the way down, where a default action happens. A key up that carried a
    // carriage return would be a second one.
    const params = await dispatched(typed("up", "Enter", "Enter", 13));
    expect(params.type).toBe("keyUp");
    expect(params).not.toHaveProperty("text");
  });

  test("the virtual key code the surface offered is the one that is sent", async () => {
    // A form field ignores a bare Enter or Backspace without this, which is why it is sent at all.
    const params = await dispatched(typed("down", "Enter", "Enter", 13));
    expect(params.windowsVirtualKeyCode).toBe(13);
    expect(params.nativeVirtualKeyCode).toBe(13);
  });
});

/** A CDP session that answers a screenshot, and a page that can navigate. */
function castable(
  options: {
    screenshot?: string;
    gotoFails?: string;
    /** Main-frame navigation requests that fail before goto rejects (a redirect chain's hops). */
    failedRequests?: string[];
    /** Document the committed navigation returns (plain-HTTP filter 403/502/504). */
    gotoResponse?: {
      status: number;
      headers?: Record<string, string>;
      url?: string;
    };
  } = {},
) {
  const sent: string[] = [];
  let handler: ((event: unknown) => void) | undefined;
  const client = {
    on(_event: string, listener: (event: unknown) => void) {
      handler = listener;
    },
    async send(method: string) {
      sent.push(method);
      if (method === "Page.captureScreenshot")
        return options.screenshot ? { data: options.screenshot } : {};
      return {};
    },
    async detach() {},
  };
  let url = "about:blank";
  const mainFrame = {};
  const listeners = new Set<(request: unknown) => void>();
  const responseListeners = new Set<(response: unknown) => void>();
  /** A main-frame navigation request failing, as Playwright reports it. */
  const failMainFrame = (
    failed: string,
    errorText = "net::ERR_TUNNEL_CONNECTION_FAILED",
    frame: unknown = mainFrame,
  ) => {
    for (const listener of listeners)
      listener({
        url: () => failed,
        isNavigationRequest: () => true,
        frame: () => frame,
        failure: () => ({ errorText }),
      });
  };
  const page = {
    context: () => ({ newCDPSession: async () => client }),
    url: () => url,
    viewportSize: () => ({ width: 1280, height: 800 }),
    mainFrame: () => mainFrame,
    on: (event: string, listener: (value: unknown) => void) => {
      if (event === "requestfailed") listeners.add(listener);
      if (event === "response") responseListeners.add(listener);
    },
    off: (event: string, listener: (value: unknown) => void) => {
      if (event === "requestfailed") listeners.delete(listener);
      if (event === "response") responseListeners.delete(listener);
    },
    listenerCount: () => listeners.size,
    goto: async (target: string) => {
      for (const failed of options.failedRequests ?? []) failMainFrame(failed);
      if (options.gotoFails) throw new Error(options.gotoFails);
      url = target;
      const documented = options.gotoResponse;
      if (!documented) return null;
      const responseUrl = documented.url ?? target;
      const response = documentResponse(
        responseUrl,
        documented.status,
        documented.headers ?? {},
        mainFrame,
      );
      for (const listener of responseListeners) listener(response);
      return response;
    },
    goBack: async () => {},
    goForward: async () => {},
    reload: async () => {},
  } as unknown as Page;
  const emitDocument = (
    documentUrl: string,
    status: number,
    headers: Record<string, string> = {},
    frame: unknown = mainFrame,
  ) => {
    const response = documentResponse(documentUrl, status, headers, frame);
    for (const listener of responseListeners) listener(response);
    return response;
  };
  return {
    page,
    sent,
    emit: (event: unknown) => handler?.(event),
    failMainFrame,
    emitDocument,
    listenerCount: () => listeners.size,
  };
}

/** A Playwright-shaped main-frame document response. */
function documentResponse(
  documentUrl: string,
  status: number,
  headers: Record<string, string>,
  frame: unknown,
) {
  const lowered = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    url: () => documentUrl,
    status: () => status,
    headers: () => lowered,
    request: () => ({
      url: () => documentUrl,
      isNavigationRequest: () => true,
      frame: () => frame,
    }),
  };
}

/** Collect messages, and wait for the next one that matches without a fixed sleep. */
function inbox() {
  const messages: { type?: string; ok?: boolean; error?: string }[] = [];
  const waiters: { match: (m: unknown) => boolean; resolve: () => void }[] = [];
  return {
    messages,
    push(message: unknown) {
      messages.push(message as { type?: string });
      for (const waiter of [...waiters])
        if (waiter.match(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
    },
    next(
      match: (m: { type?: string; ok?: boolean; error?: string }) => boolean,
    ) {
      if (messages.some(match)) return Promise.resolve();
      return new Promise<void>((resolve) =>
        waiters.push({ match: match as (m: unknown) => boolean, resolve }),
      );
    },
  };
}

describe("开场帧与地址栏", () => {
  test("开播后先发一张截图，静止的页面也有画面", async () => {
    const { page } = castable({ screenshot: "SHOT" });
    const frames: unknown[] = [];
    await startScreencast(page, (frame) => frames.push(frame));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames).toEqual([
      {
        type: "frame",
        data: "SHOT",
        width: 1280,
        height: 800,
        url: "about:blank",
      },
    ]);
  });

  test("Chrome 自己的帧先到时，不再补开场帧", async () => {
    const { page, emit } = castable({ screenshot: "SHOT" });
    const frames: { data?: string }[] = [];
    const cast = startScreencast(page, (frame) =>
      frames.push(frame as { data?: string }),
    );
    await cast;
    emit({
      data: "CAST",
      sessionId: 1,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames.map((f) => f.data)).toContain("CAST");
  });

  test("地址栏打开网址，结果发回去", async () => {
    const { page } = castable();
    const messages: unknown[] = [];
    const cast = await startScreencast(page, (m) => messages.push(m));
    await cast.send({ type: "navigate", url: "https://example.com/" });
    expect(messages).toContainEqual({
      type: "navigation",
      ok: true,
      url: "https://example.com/",
    });
  });

  test("打不开时是一句中文说明，不是断线", async () => {
    const { page } = castable({
      gotoFails: "net::ERR_TUNNEL_CONNECTION_FAILED at https://x.test/",
    });
    const messages: unknown[] = [];
    const cast = await startScreencast(page, (m) => messages.push(m));
    await cast.send({ type: "navigate", url: "https://x.test/" });
    expect(messages).toContainEqual({
      type: "navigation",
      ok: false,
      url: "about:blank",
      error: "连不上这个网址。",
    });
  });
});

describe("跳转到内网时按实际被拦的那一跳说明", () => {
  test("Chromium 的 at 是起始网址；按失败的那个请求（跳转目标）说安全原因", async () => {
    const { page } = castable({
      // What real Chromium reports for a public page that 302s to https://10.0.0.1/.
      gotoFails:
        "page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://redir.example.com/start",
      failedRequests: ["https://10.0.0.1/"],
    });
    const messages: unknown[] = [];
    const cast = await startScreencast(page, (m) => messages.push(m));
    await cast.send({
      type: "navigate",
      url: "https://redir.example.com/start",
    });
    expect(messages).toContainEqual({
      type: "navigation",
      ok: false,
      url: "about:blank",
      error: "出于安全原因不允许访问内网地址。",
    });
    // One listener for the whole cast, gone when it stops, so navigations do not pile them up.
    expect(
      (page as unknown as { listenerCount: () => number }).listenerCount(),
    ).toBe(1);
    await cast.stop();
    expect(
      (page as unknown as { listenerCount: () => number }).listenerCount(),
    ).toBe(0);
  });

  test("goto 在中间页 commit 成功后，下一跳被代理拦到内网：再推一条安全原因", async () => {
    const { page, failMainFrame } = castable();
    const box = inbox();
    const cast = await startScreencast(page, (m) => box.push(m));
    await cast.send({ type: "navigate", url: "https://hop1.example.com/" });
    expect(box.messages).toContainEqual({
      type: "navigation",
      ok: true,
      url: "https://hop1.example.com/",
    });
    // The committed page then does location.replace('https://10.0.0.1/'), and the proxy refuses it.
    failMainFrame("https://10.0.0.1/");
    await box.next((m) => m.type === "navigation" && m.ok === false);
    const last = box.messages.filter((m) => m.type === "navigation").at(-1);
    expect(last).toMatchObject({
      ok: false,
      error: "出于安全原因不允许访问内网地址。",
    });
    await cast.stop();
  });

  test("commit 之后、goto 返回之前失败的一跳，在 ok 之后补发", async () => {
    const { page } = castable({ failedRequests: ["https://[::1]/"] });
    const box = inbox();
    const cast = await startScreencast(page, (m) => box.push(m));
    await cast.send({ type: "navigate", url: "https://hop1.example.com/" });
    await box.next((m) => m.type === "navigation" && m.ok === false);
    const navigations = box.messages.filter((m) => m.type === "navigation");
    expect(navigations.map((m) => m.ok)).toEqual([true, false]);
    expect(navigations[1]?.error).toBe("出于安全原因不允许访问内网地址。");
    await cast.stop();
  });

  test("ERR_ABORTED、子 frame 的失败和停播之后的失败都不推", async () => {
    const { page, failMainFrame } = castable();
    const box = inbox();
    const cast = await startScreencast(page, (m) => box.push(m));
    failMainFrame("https://10.0.0.1/", "net::ERR_ABORTED");
    failMainFrame("https://10.0.0.1/", "net::ERR_TUNNEL_CONNECTION_FAILED", {});
    await cast.stop();
    failMainFrame("https://10.0.0.1/");
    await Promise.resolve();
    expect(box.messages.filter((m) => m.type === "navigation")).toEqual([]);
  });

  test("失败的那一跳比错误里的起始网址优先", async () => {
    expect(
      await navigationProblem(
        new Error(
          "net::ERR_TUNNEL_CONNECTION_FAILED at https://redir.example.com/start",
        ),
        "https://redir.example.com/start",
        "https://[2002:c0a8:1::1]/",
      ),
    ).toBe("出于安全原因不允许访问内网地址。");
  });
});

describe("跳到 DNS 失败的域名：连不上，不是没有响应", () => {
  test("经代理的隧道被对端关掉（ERR_CONNECTION_CLOSED）说连不上", async () => {
    expect(
      await navigationProblem(
        new Error("net::ERR_CONNECTION_CLOSED at https://nope.invalid/"),
        "https://redir.example.com/to-dns",
        "https://nope.invalid/",
      ),
    ).toBe("连不上这个网址。");
    expect(await navigationProblem(new Error("net::ERR_EMPTY_RESPONSE"))).toBe(
      "连不上这个网址。",
    );
  });
});

describe("navigationProblem", () => {
  test("内网地址被拦时说安全原因，不说成普通连不上", async () => {
    expect(
      await navigationProblem(
        new Error("net::ERR_TUNNEL_CONNECTION_FAILED at https://192.168.1.1/"),
        "https://192.168.1.1/",
      ),
    ).toBe("出于安全原因不允许访问内网地址。");
    expect(
      await navigationProblem(
        new Error("net::ERR_TUNNEL_CONNECTION_FAILED"),
        "http://[::]:80/",
      ),
    ).toBe("出于安全原因不允许访问内网地址。");
  });

  test("公网隧道失败且过滤器未起时如实说连不上", async () => {
    expect(
      await navigationProblem(
        new Error("net::ERR_TUNNEL_CONNECTION_FAILED at https://claude.com/"),
        "https://claude.com/",
      ),
    ).toBe("连不上这个网址。");
  });

  test("其它常见错误仍是对应中文", async () => {
    expect(
      await navigationProblem(new Error("net::ERR_NAME_NOT_RESOLVED")),
    ).toBe("找不到这个网址。");
    expect(
      await navigationProblem(new Error("net::ERR_CONNECTION_REFUSED")),
    ).toBe("连不上这个网址。");
    expect(
      await navigationProblem(new Error("net::ERR_CONNECTION_TIMED_OUT")),
    ).toBe("网站没有响应，请稍后再试。");
    expect(
      await navigationProblem(
        new Error("page.goto: Timeout 20000ms exceeded."),
      ),
    ).toBe("网站没有响应，请稍后再试。");
    expect(
      await navigationProblem(new Error("net::ERR_CERT_AUTHORITY_INVALID")),
    ).toBe("网站的安全证书有问题。");
  });

  test("公网跳转到内网时按失败那一跳说安全原因", async () => {
    expect(
      await navigationProblem(
        new Error("net::ERR_TUNNEL_CONNECTION_FAILED at https://10.0.0.1/"),
        "https://example.com/",
      ),
    ).toBe("出于安全原因不允许访问内网地址。");
  });
});

describe("纯 HTTP 过滤器错误页要记成导航失败", () => {
  test("504 超时页是「没有响应」，不是 ok", async () => {
    const { page } = castable({
      gotoResponse: {
        status: 504,
        headers: { "x-chisabot-egress-class": "timeout" },
      },
    });
    const messages: unknown[] = [];
    const cast = await startScreencast(page, (m) => messages.push(m));
    await cast.send({ type: "navigate", url: "http://slow.example.com/" });
    expect(messages).toContainEqual({
      type: "navigation",
      ok: false,
      url: "http://slow.example.com/",
      error: "网站没有响应，请稍后再试。",
    });
    await cast.stop();
  });

  test("502 连不上、403 DNS 失败都说连不上；内网 403 说安全原因", async () => {
    for (const [status, klass, url, error] of [
      [502, "unreachable", "http://down.example.com/", "连不上这个网址。"],
      [403, "unresolved", "http://nope.invalid/", "连不上这个网址。"],
      [403, "private", "http://10.0.0.1/", "出于安全原因不允许访问内网地址。"],
    ] as const) {
      const { page } = castable({
        gotoResponse: {
          status,
          headers: { "x-chisabot-egress-class": klass },
        },
      });
      const messages: unknown[] = [];
      const cast = await startScreencast(page, (m) => messages.push(m));
      await cast.send({ type: "navigate", url });
      expect(messages).toContainEqual({
        type: "navigation",
        ok: false,
        url,
        error,
      });
      await cast.stop();
    }
  });

  test("网站自己的 502（没有过滤器的头）仍是成功打开的文档", async () => {
    const { page } = castable({
      gotoResponse: { status: 502, headers: { "content-type": "text/html" } },
    });
    const messages: unknown[] = [];
    const cast = await startScreencast(page, (m) => messages.push(m));
    await cast.send({ type: "navigate", url: "http://example.com/bad" });
    expect(messages).toContainEqual({
      type: "navigation",
      ok: true,
      url: "http://example.com/bad",
    });
    await cast.stop();
  });

  test("commit 之后再打开过滤器的 HTTP 错误页，补发失败而不是只靠页体", async () => {
    const { page, emitDocument } = castable();
    const box = inbox();
    const cast = await startScreencast(page, (m) => box.push(m));
    await cast.send({ type: "navigate", url: "http://hop1.example.com/" });
    expect(box.messages).toContainEqual({
      type: "navigation",
      ok: true,
      url: "http://hop1.example.com/",
    });
    emitDocument("http://10.0.0.1/", 403, {
      "x-chisabot-egress-class": "private",
    });
    await box.next((m) => m.type === "navigation" && m.ok === false);
    const last = box.messages.filter((m) => m.type === "navigation").at(-1);
    expect(last).toMatchObject({
      ok: false,
      error: "出于安全原因不允许访问内网地址。",
    });
    await cast.stop();
  });

  test("子 frame 的过滤器错误页不推导航失败", async () => {
    const { page, emitDocument } = castable();
    const box = inbox();
    const cast = await startScreencast(page, (m) => box.push(m));
    emitDocument(
      "http://10.0.0.1/",
      403,
      { "x-chisabot-egress-class": "private" },
      {},
    );
    await Promise.resolve();
    expect(box.messages.filter((m) => m.type === "navigation")).toEqual([]);
    await cast.stop();
  });
});

describe("egressDocumentProblem", () => {
  test("按 x-chisabot-egress-class 分类；没有过滤器的头则忽略", () => {
    const headers = (klass?: string) => ({
      status: () => 502,
      headers: () =>
        klass
          ? { "x-chisabot-egress-class": klass }
          : { "content-type": "text/plain" },
    });
    expect(egressDocumentProblem(headers("timeout"))).toBe(
      "网站没有响应，请稍后再试。",
    );
    expect(egressDocumentProblem(headers("unreachable"))).toBe(
      "连不上这个网址。",
    );
    expect(egressDocumentProblem(headers())).toBeNull();
    expect(
      egressDocumentProblem({
        status: () => 200,
        headers: () => ({ "x-chisabot-egress-class": "timeout" }),
      }),
    ).toBeNull();
  });
});
