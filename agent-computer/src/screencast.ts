/**
 * Live screen and live input over one WebSocket, using Chrome's own screencast.
 *
 * Chrome pushes frames as the page changes, which supports human takeover better than polling a PNG
 * once a second.
 *
 * This follows permissively-licensed references: `steel-dev/steel-browser`'s `casting.handler.ts`
 * (Apache-2.0) for the server loop and Chrome DevTools' `InputModel.ts` (BSD-3) for key event
 * translation.
 *
 * noVNC is not used because it requires Xvfb, x11vnc and websockify, while this container runs
 * headless. This implementation streams the page and forwards input through the Chrome DevTools
 * Protocol.
 */
import type { CDPSession, Page, Request, Response } from "playwright";
import {
  classifyEgressTunnel,
  isPrivateEgressHost,
  recentEgressOutcome,
  trustedEgressClass,
} from "./egress";
import { whileNavigating } from "./start-page";

/** What the surface sends us. */
export type InputMessage =
  | {
      type: "mouse";
      event: "pressed" | "released" | "moved";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      clickCount?: number;
      modifiers?: number;
    }
  | {
      type: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: number;
    }
  | {
      type: "key";
      event: "down" | "up";
      key: string;
      code: string;
      text?: string;
      /** Legacy browser keyCode, which CDP uses as its Windows virtual key code. */
      windowsVirtualKeyCode?: number;
      modifiers?: number;
    }
  | { type: "text"; text: string }
  /**
   * 接管时的地址栏：在 Bot 的浏览器里打开一个网址。只收 http(s)（request-validation.ts 已检查）；
   * 出站仍经过网络策略代理，和点链接一样受同一套限制。
   */
  | { type: "navigate"; url: string }
  /** 接管时的后退 / 前进 / 刷新。 */
  | { type: "history"; action: "back" | "forward" | "reload" };

/**
 * 地址栏操作的结果，发回给正在接管的人。不是 `error`：打不开一个网址只是这一下没成功，
 * 屏幕本身还在，不应该像断线那样盖住整个画面。
 */
export type NavigationMessage = {
  type: "navigation";
  ok: boolean;
  url: string;
  error?: string;
};

/** What we send back. */
export type FrameMessage = {
  type: "frame";
  /** Base64 JPEG. Chrome's own encoding; we do not re-encode. */
  data: string;
  width: number;
  height: number;
  /** 这一帧所在页面的网址，接管时的地址栏显示它。旧的计算机不带。 */
  url?: string;
};

/**
 * Chrome's virtual key codes, for the keys that need one.
 *
 * `Input.dispatchKeyEvent` is not satisfied by `key` alone. A form field will ignore a bare Backspace
 * or Enter unless `windowsVirtualKeyCode` is set, which is the common reason a hand-written
 * screencast works for letters but not editing keys. Lifted from the mapping DevTools uses for the
 * same purpose.
 */
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  ";": 186,
  "=": 187,
  ",": 188,
  "-": 189,
  ".": 190,
  "/": 191,
  "`": 192,
  "[": 219,
  "\\": 220,
  "]": 221,
  "'": 222,
};

/**
 * The character a key stands for, where Chrome will not act on the key without one.
 *
 * `Input.dispatchKeyEvent` has two kinds of key-down. `rawKeyDown` is a key that produces no
 * character: Chrome delivers it to the page and stops there, so a listener fires and nothing else
 * happens. `keyDown` carries text, and that is what makes Chrome perform the key's own default
 * action.
 *
 * Sending text only for a printable character therefore left Enter as a key a page could hear and
 * not act on. Measured against Chromium 151 through this file: with a person holding the wheel,
 * Enter did not submit the form they had just filled in, did not start a new line in a textarea and
 * did not press the button they had tabbed to, while the page's own `keydown` listener saw every
 * one of them. Which is the sign-in at the end of almost every takeover.
 *
 * One key rather than a list, measured the same way: Backspace, Delete, Tab, Home, End and the four
 * arrows all do what they mean as a `rawKeyDown`, because their default action is not the insertion
 * of a character.
 *
 * A carriage return, which is what a keyboard's Enter carries. Chrome turns it into whatever the
 * field it lands in needs, so a single-line input is left holding no extra character.
 */
const TEXT_FOR_KEY: Record<string, string | undefined> = { Enter: "\r" };

function virtualKeyCode(key: string): number {
  if (VIRTUAL_KEY_CODES[key] !== undefined) return VIRTUAL_KEY_CODES[key];
  // A single printable character carries its own code point, upper-cased, which is what Chrome expects
  // for a key event as opposed to the text it produces.
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return 0;
}

/** A main-frame navigation request that failed, as Playwright reported it. */
type MainFrameFailure = { url: string; errorText: string };

export type Screencast = {
  /** Stop the cast and detach. Safe to call twice. */
  stop: () => Promise<void>;
  /** Apply one thing the person did. */
  send: (message: InputMessage) => Promise<void>;
};

/**
 * Start casting `page` to `onFrame`, and return a handle that accepts input.
 *
 * `maxWidth`/`maxHeight` cap what Chrome encodes; it scales to fit and tells us the real dimensions in
 * the metadata, which the surface needs in order to map a click back. Capping matters because the cost
 * of a frame is mostly encoding, and oversized casts waste bandwidth.
 */
export async function startScreencast(
  page: Page,
  onFrame: (frame: FrameMessage | NavigationMessage) => void,
  options: { maxWidth?: number; maxHeight?: number; quality?: number } = {},
): Promise<Screencast> {
  const client: CDPSession = await page.context().newCDPSession(page);
  let stopped = false;
  /** Whether Chrome has sent a frame of its own yet; the opening frame below is skipped if so. */
  let castFrameSeen = false;
  const pageUrl = () => {
    try {
      return typeof page.url === "function" ? page.url() : undefined;
    } catch {
      return undefined;
    }
  };

  /*
   * 主 frame 的导航失败（含 goto 返回之后才发生的那一跳）。
   *
   * goto 用 `waitUntil: "commit"`，第一个文档一提交就返回。之后页面自己再跳（302 链里晚到的一跳、
   * `location.replace`、点链接）被代理拒绝时，goto 早已成功，不会再抛错。所以整场直播都听着主
   * frame 的 requestfailed：goto 进行中的失败交给 goto 自己（失败时按最后一跳说明，成功时补发）；
   * 其余的直接按失败的那一跳推一条 navigation 错误。不靠等固定时间。
   */
  let inFlight: MainFrameFailure[] | null = null;
  /** Filter error pages (plain HTTP 403/502/504) committed as documents while goto is in flight. */
  let inFlightPages: { url: string; error: string }[] | null = null;
  /** Bumped by every navigation the person starts, so a slow late report cannot cover a newer one. */
  let generation = 0;
  const pushNavigationError = (url: string, error: string, seen: number) => {
    if (stopped || seen !== generation) return;
    onFrame({
      type: "navigation",
      ok: false,
      url: pageUrl() ?? url,
      error,
    });
  };
  const reportLateFailure = (failure: MainFrameFailure) => {
    const seen = generation;
    void navigationProblem(
      new Error(`${failure.errorText} at ${failure.url}`),
      failure.url,
      failure.url,
    ).then((error) => pushNavigationError(failure.url, error, seen));
  };
  const reportEgressPage = (page: { url: string; error: string }) => {
    pushNavigationError(page.url, page.error, generation);
  };
  const onMainFrameFailed = (request: Request) => {
    let failure: MainFrameFailure;
    try {
      if (
        !request.isNavigationRequest() ||
        request.frame() !== page.mainFrame()
      )
        return;
      failure = {
        url: request.url(),
        errorText: request.failure()?.errorText ?? "",
      };
    } catch {
      // A request with no frame (a service worker's) is not a navigation of this page.
      return;
    }
    // Superseded navigations and downloads end as ERR_ABORTED; nothing failed that a person must see.
    if (/ERR_ABORTED/i.test(failure.errorText)) return;
    if (inFlight) inFlight.push(failure);
    else if (!stopped) reportLateFailure(failure);
  };
  const onMainFrameDocument = (response: Response) => {
    let denied: { url: string; error: string };
    try {
      const request = response.request();
      if (
        !request.isNavigationRequest() ||
        request.frame() !== page.mainFrame()
      )
        return;
      const error = egressDocumentProblem(response);
      if (!error) return;
      denied = { url: request.url(), error };
    } catch {
      return;
    }
    if (inFlightPages) inFlightPages.push(denied);
    else if (!stopped) reportEgressPage(denied);
  };
  const listening = typeof page.on === "function";
  if (listening) {
    page.on("requestfailed", onMainFrameFailed);
    page.on("response", onMainFrameDocument);
  }

  type ScreencastFrame = {
    data: string;
    sessionId: number;
    metadata: { deviceWidth: number; deviceHeight: number };
  };

  client.on("Page.screencastFrame", (event: ScreencastFrame) => {
    const { data, sessionId, metadata } = event;
    // Acknowledge every frame. Chrome will not send the next one until the current is acked, which is
    // the backpressure that stops a slow client drowning in frames. Forgetting this is why a naive
    // implementation delivers one frame and then appears to hang.
    void client
      .send("Page.screencastFrameAck", { sessionId })
      .catch(() => undefined);
    if (stopped) return;
    castFrameSeen = true;
    const url = pageUrl();
    onFrame({
      type: "frame",
      data,
      width: metadata.deviceWidth,
      height: metadata.deviceHeight,
      ...(url ? { url } : {}),
    });
  });

  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality: options.quality ?? 70,
    maxWidth: options.maxWidth ?? 1280,
    maxHeight: options.maxHeight ?? 800,
    // One frame per change, not per interval. Chrome decides when something moved.
    everyNthFrame: 1,
  });

  /*
   * 开场帧：保证每次连上都先有一张画面。
   *
   * Chrome 的 screencast 只在合成器出新帧时才推送。一个已经静止的页面（空白页、加载完的文章、
   * 重连之后的同一页）可能一帧都不发，查看的人就只看到一块黑色画布，以为屏幕坏了。所以开播后
   * 主动截一张同尺寸的 JPEG 先发过去；Chrome 自己的帧一到就以它为准，这张若晚到则丢弃。
   */
  void (async () => {
    try {
      const shot = (await client.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: options.quality ?? 70,
      })) as { data?: string } | undefined;
      if (stopped || castFrameSeen || !shot?.data) return;
      const size =
        typeof page.viewportSize === "function" ? page.viewportSize() : null;
      const url = pageUrl();
      onFrame({
        type: "frame",
        data: shot.data,
        width: size?.width ?? options.maxWidth ?? 1280,
        height: size?.height ?? options.maxHeight ?? 800,
        ...(url ? { url } : {}),
      });
    } catch {
      // 截不到就等 Chrome 自己的帧；这只是兜底。
    }
  })();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      if (listening) {
        page.off("requestfailed", onMainFrameFailed);
        page.off("response", onMainFrameDocument);
      }
      await client.send("Page.stopScreencast").catch(() => undefined);
      await client.detach().catch(() => undefined);
    },

    async send(message: InputMessage) {
      if (stopped) return;
      if (message.type === "mouse") {
        await client.send("Input.dispatchMouseEvent", {
          type:
            message.event === "pressed"
              ? "mousePressed"
              : message.event === "released"
                ? "mouseReleased"
                : "mouseMoved",
          x: message.x,
          y: message.y,
          button: message.button ?? "left",
          // Chrome needs a non-zero clickCount on press/release or the page sees a move that happens
          // to have a button set, and no click ever fires.
          clickCount: message.event === "moved" ? 0 : (message.clickCount ?? 1),
          modifiers: message.modifiers ?? 0,
        });
        return;
      }

      if (message.type === "wheel") {
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: message.x,
          y: message.y,
          deltaX: message.deltaX,
          deltaY: message.deltaY,
          modifiers: message.modifiers ?? 0,
        });
        return;
      }

      if (message.type === "key") {
        const offeredCode = message.windowsVirtualKeyCode;
        const code =
          Number.isInteger(offeredCode) &&
          (offeredCode ?? 0) > 0 &&
          (offeredCode ?? 0) <= 255
            ? (offeredCode as number)
            : virtualKeyCode(message.key);
        /*
         * The text this key carries: the surface supplies it for a printable character, and
         * `TEXT_FOR_KEY` fills in the keys whose default action Chrome will not perform without one.
         *
         * Only on the way down, because that is where a default action happens. A key going up
         * carries whatever it was given and nothing more.
         */
        const text =
          message.event === "up"
            ? message.text
            : (message.text ?? TEXT_FOR_KEY[message.key]);
        await client.send("Input.dispatchKeyEvent", {
          // `keyDown` only when there is text to insert; otherwise `rawKeyDown`, which is what Chrome
          // expects for keys that do not produce a character. Sending keyDown with no text makes
          // editing keys arrive as nothing.
          type:
            message.event === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
          key: message.key,
          code: message.code,
          ...(text ? { text } : {}),
          windowsVirtualKeyCode: code,
          nativeVirtualKeyCode: code,
          modifiers: message.modifiers ?? 0,
        });
        return;
      }

      if (message.type === "navigate" || message.type === "history") {
        const from = pageUrl() ?? "";
        // Main-frame failures while this goto runs belong to it (see `onMainFrameFailed`).
        const failures: MainFrameFailure[] = [];
        const pages: { url: string; error: string }[] = [];
        inFlight = failures;
        inFlightPages = pages;
        generation += 1;
        try {
          // 导航途中网址还是 about:blank，标记一下，别让起始页和这次导航抢文档。
          const committed = await whileNavigating(page, async () => {
            if (message.type === "navigate") {
              return await page.goto(message.url, {
                waitUntil: "commit",
                timeout: 20_000,
              });
            }
            if (message.action === "back") {
              return await page.goBack({
                waitUntil: "commit",
                timeout: 20_000,
              });
            }
            if (message.action === "forward") {
              return await page.goForward({
                waitUntil: "commit",
                timeout: 20_000,
              });
            }
            return await page.reload({
              waitUntil: "commit",
              timeout: 20_000,
            });
          });
          inFlight = null;
          inFlightPages = null;
          const problem = egressDocumentProblem(committed);
          const committedUrl = (() => {
            try {
              return committed && typeof committed.url === "function"
                ? committed.url()
                : undefined;
            } catch {
              return undefined;
            }
          })();
          if (!stopped) {
            if (problem)
              onFrame({
                type: "navigation",
                ok: false,
                url: pageUrl() ?? from,
                error: problem,
              });
            else
              onFrame({ type: "navigation", ok: true, url: pageUrl() ?? from });
          }
          // `commit` resolves on the first document. A hop that failed after it (a redirect the
          // committed page started) but before goto returned is reported now, after the ok.
          for (const failure of failures) reportLateFailure(failure);
          for (const denied of pages) {
            if (problem && committedUrl && denied.url === committedUrl)
              continue;
            reportEgressPage(denied);
          }
        } catch (error) {
          inFlight = null;
          inFlightPages = null;
          if (!stopped) {
            const url = pageUrl() ?? from;
            const target = message.type === "navigate" ? message.url : url;
            onFrame({
              type: "navigation",
              ok: false,
              url,
              error:
                pages.at(-1)?.error ??
                (await navigationProblem(error, target, failures.at(-1)?.url)),
            });
          }
        } finally {
          if (inFlight === failures) inFlight = null;
          if (inFlightPages === pages) inFlightPages = null;
        }
        return;
      }

      // A block of text at once: a paste, or a one-time code the person did not type character by
      // character. `Input.insertText` bypasses key events entirely, which is correct here, it is not
      // pretending to be a keyboard.
      await client.send("Input.insertText", { text: message.text });
    },
  };
}

/**
 * 打不开网址时给人看的一句话（中文），不带 Playwright 的调用日志。
 *
 * Chromium 对代理 CONNECT 的 403（策略）和 502（上游连不上）都报 ERR_TUNNEL。这里用目标地址
 * 和出口过滤代理的一次探测区分：内网 / SSRF 底线 → 安全提示；其它策略拒绝 → 策略提示；
 * 连不上 → 如实说连不上。
 *
 * 判哪一跳：`failedHop`（实际失败的那个请求，跳转后就是跳转目标）优先；没有时退回错误里
 * `at …` 的网址和导航目标。Chromium 错误里的 `at` 是起始网址，不是失败的那一跳，所以公网页
 * 302 到内网时只靠它会被说成「连不上」。
 */
export async function navigationProblem(
  error: unknown,
  targetUrl?: string,
  failedHop?: string,
): Promise<string> {
  const text = error instanceof Error ? error.message : String(error);
  const tunnel = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_BLOCKED/i.test(
    text,
  );
  if (tunnel) {
    const namedInError = /\bat\s+(https?:\/\/\S+?)(?:\s|$)/i.exec(text)?.[1];
    const hop = parseNavigationTarget(failedHop);
    // The hop that failed decides when it is known. Otherwise any internal address among the
    // candidates is the likely reason: the error's `at` and the navigate target can disagree.
    const candidates = hop
      ? [hop]
      : [namedInError, targetUrl].flatMap((raw) => {
          const parsed = parseNavigationTarget(raw);
          return parsed ? [parsed] : [];
        });
    if (candidates.some((candidate) => isPrivateEgressHost(candidate.host)))
      return "出于安全原因不允许访问内网地址。";
    const parsed = candidates[0];
    if (parsed) {
      const kind = await classifyEgressTunnel(parsed.host, parsed.port);
      if (kind === "private") return "出于安全原因不允许访问内网地址。";
      if (kind === "refused") return "网络策略不允许访问这个网址。";
      if (kind === "timeout") return NO_ANSWER;
    }
    return UNREACHABLE;
  }
  if (/ERR_NAME_NOT_RESOLVED/i.test(text)) return "找不到这个网址。";
  // Only a real timeout is "没有响应". Refused / reset / closed is "连不上": through the filter a name
  // that did not resolve, or a tunnel the far side dropped, ends as ERR_CONNECTION_CLOSED.
  if (
    /ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|Timeout \d+ms exceeded/i.test(text)
  )
    return NO_ANSWER;
  if (
    /ERR_CONNECTION_(CLOSED|RESET|REFUSED|FAILED)|ERR_EMPTY_RESPONSE|ERR_ADDRESS_(UNREACHABLE|INVALID)/i.test(
      text,
    )
  ) {
    const parsed =
      parseNavigationTarget(failedHop) ??
      parseNavigationTarget(
        /\bat\s+(https?:\/\/\S+?)(?:\s|$)/i.exec(text)?.[1],
      ) ??
      parseNavigationTarget(targetUrl);
    if (parsed && recentEgressOutcome(parsed.host, parsed.port) === "timeout")
      return NO_ANSWER;
    return UNREACHABLE;
  }
  if (/ERR_CERT|SSL/i.test(text)) return "网站的安全证书有问题。";
  // Unrecognized errors (including Playwright "Not attached to an active page" on an
  // immediate reload) still take the destination: a blocked address should not become
  // a generic 「打不开」.
  const parsed =
    parseNavigationTarget(failedHop) ??
    parseNavigationTarget(
      /\bat\s+(https?:\/\/\S+?)(?:\s|$)/i.exec(text)?.[1],
    ) ??
    parseNavigationTarget(targetUrl);
  if (parsed) {
    if (isPrivateEgressHost(parsed.host))
      return "出于安全原因不允许访问内网地址。";
    const kind = await classifyEgressTunnel(parsed.host, parsed.port);
    if (kind === "private") return "出于安全原因不允许访问内网地址。";
    if (kind === "refused") return "网络策略不允许访问这个网址。";
    if (kind === "timeout") return NO_ANSWER;
    if (kind === "unreachable") return UNREACHABLE;
  }
  return "这个网址打不开。";
}

const UNREACHABLE = "连不上这个网址。";
const NO_ANSWER = "网站没有响应，请稍后再试。";

const EGRESS_CLASS_MESSAGE: Record<string, string> = {
  private: "出于安全原因不允许访问内网地址。",
  refused: "网络策略不允许访问这个网址。",
  unresolved: UNREACHABLE,
  credentials: "代理凭据不正确，无法出网。",
  timeout: NO_ANSWER,
  unreachable: UNREACHABLE,
};

/**
 * 纯 HTTP 经过滤器被拦或上游失败时，代理会回 403/502/504 文档。Chromium 把它当成一次成功的
 * 文档提交，goto / requestfailed 都不会失败，所以这里按响应头分类。只认带过滤器进程令牌的
 * 头：网站自己写的 x-chisabot-egress-class（尤其在 HTTPS 隧道里过滤器看不见）不能假造文案。
 */
export function egressDocumentProblem(
  response:
    | { status?: () => number; headers?: () => Record<string, string> }
    | null
    | undefined,
): string | null {
  if (!response || typeof response.status !== "function") return null;
  let status: number;
  try {
    status = response.status();
  } catch {
    return null;
  }
  if (status !== 403 && status !== 502 && status !== 504) return null;
  let headers: Record<string, string> = {};
  try {
    headers = response.headers?.() ?? {};
  } catch {
    return null;
  }
  const klass = trustedEgressClass(headers);
  if (!klass) return null;
  if (EGRESS_CLASS_MESSAGE[klass]) return EGRESS_CLASS_MESSAGE[klass];
  return status === 504 ? NO_ANSWER : UNREACHABLE;
}

function parseNavigationTarget(
  raw: string | undefined,
): { host: string; port: number } | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!host) return null;
    const port = Number(
      url.port ||
        (url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : 0),
    );
    if (!Number.isInteger(port) || port < 1) return null;
    return { host, port };
  } catch {
    return null;
  }
}
