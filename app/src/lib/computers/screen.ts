import { tryClient } from "@/lib/client";

/**
 * One frame of a Bot's screen.
 *
 * Not a cached read. Frames are polled while somebody is watching and are stale the moment after
 * they arrive, so holding one in a query cache would mean serving a picture of a screen that has
 * since moved.
 */
export type Screenshot = {
  base64: string;
  width: number;
  height: number;
  capturedAt: string;
  /** `about:blank` when the browser has not been sent anywhere yet. Absent on older computers. */
  url?: string;
  /** 空白页上已经画了本地起始页（新标签页），这张图可以直接显示，不是一片白。 */
  startPage?: boolean;
};

/** 面板上给人看的默认句（英文服务端文案不直接上屏）。 */
export const SCREEN_UNAVAILABLE_ZH = "暂时看不到屏幕。";

/** 503 / 电脑未就绪时的说明（DOG-05）。 */
export const SCREEN_BUSY_ZH = "电脑正忙或还没就绪，屏幕暂时拿不到。";

/** 大屏 LiveScreen 正在出图时，HTTP 截图主动让路（0.1.41）。 */
export const SCREEN_LIVE_CAST_ZH =
  "大屏正在直播，卡片截图已暂停，避免抢电脑。";

/** 页面绘制超时（422 / pageTimeout），不是电脑挂了。 */
export const SCREEN_PAGE_TIMEOUT_ZH =
  "页面还在忙，屏幕暂时拿不到。稍后再试。";

export type ScreenshotErrorFlags = {
  captureBusy?: boolean;
  liveCast?: boolean;
  pageTimeout?: boolean;
};

/**
 * 把 HTTP 状态 / 服务端 error 翻成中文面板文案。
 * 服务端 `describe` 常是英文；有中文（含「暂时」「不可用」等）时原样用。
 * `captureBusy` / `liveCast` / `pageTimeout` 是 0.1.41 起网关透传的忙态码。
 */
export function screenshotErrorMessage(
  status: number | undefined,
  serverError: string | undefined,
  flags: ScreenshotErrorFlags = {},
): string {
  const raw = serverError?.trim();
  if (raw && /[\u4e00-\u9fff]/.test(raw)) return raw;
  if (flags.liveCast) return SCREEN_LIVE_CAST_ZH;
  if (flags.captureBusy) return SCREEN_BUSY_ZH;
  if (flags.pageTimeout || status === 422) return SCREEN_PAGE_TIMEOUT_ZH;
  if (status === 503 || status === 502 || status === 504) return SCREEN_BUSY_ZH;
  if (status === 404) return "找不到这台计算机的屏幕。";
  if (status === 403) return "没有权限查看这台计算机的屏幕。";
  if (status === 409) return SCREEN_BUSY_ZH;
  return SCREEN_UNAVAILABLE_ZH;
}

/**
 * Read the current frame.
 *
 * Fails closed, and says why: the screen going unavailable is something the person watching needs
 * told, and it is not a reason to tear down the panel they are watching it in. The caller decides
 * whether to keep polling — and MUST clear any previous frame so a stale shot is not shown as live
 * (DOG-05).
 */
export async function readScreenshot(
  computerId: string,
): Promise<{
  frame?: Screenshot;
  error?: string;
  status?: number;
  captureBusy?: boolean;
  liveCast?: boolean;
  pageTimeout?: boolean;
}> {
  try {
    const response = await tryClient(`/api/computers/${computerId}/screenshot`);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        captureBusy?: boolean;
        liveCast?: boolean;
        pageTimeout?: boolean;
      } | null;
      const flags: ScreenshotErrorFlags = {
        captureBusy: body?.captureBusy === true,
        liveCast: body?.liveCast === true,
        pageTimeout: body?.pageTimeout === true,
      };
      return {
        status: response.status,
        error: screenshotErrorMessage(response.status, body?.error, flags),
        ...flags,
      };
    }
    return parseScreenshot(await response.json().catch(() => null));
  } catch {
    return { error: SCREEN_UNAVAILABLE_ZH };
  }
}

function parseScreenshot(body: unknown): {
  frame?: Screenshot;
  error?: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: SCREEN_UNAVAILABLE_ZH };
  }
  const frame = (body as { frame?: unknown }).frame ?? body;
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    return { error: SCREEN_UNAVAILABLE_ZH };
  }
  const { base64, width, height } = frame as {
    base64?: unknown;
    width?: unknown;
    height?: unknown;
  };
  // A mistyped frame used to reach `atob` in the viewer and throw there. Refused here instead.
  if (
    typeof base64 !== "string" ||
    !base64 ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return { error: SCREEN_UNAVAILABLE_ZH };
  }
  return { frame: frame as Screenshot };
}

/** The frame a page was showing when a Bot opened it. */
export type PageFrame = { url: string; title: string | null; frame: string };

/**
 * What this turn had on screen when it opened its page, or nothing if it was never kept.
 *
 * Nothing here writes. The frame is taken on the server at the moment the navigation succeeds, which
 * is the only moment the screen is certainly showing the page that was asked for. Capturing it here
 * instead meant capturing it after the turn, from a computer other conversations are also driving,
 * and filing whatever it happened to show.
 */
export async function readPageFrame(
  computerId: string,
  toolCallId: string,
): Promise<PageFrame | null> {
  try {
    const response = await tryClient(
      `/api/computers/${computerId}/page-frame/${encodeURIComponent(toolCallId)}`,
    );
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const frame = (body as { frame?: unknown }).frame;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      return null;
    }
    const { frame: image } = frame as { frame?: unknown };
    if (typeof image !== "string" || !image) return null;
    return frame as PageFrame;
  } catch {
    // A missing picture is a smaller sentence, not a broken conversation.
    return null;
  }
}
