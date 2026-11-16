import type { Page } from "playwright";
import type { BrowserChallenge } from "../../shared/computer-control";
import type { Control } from "./control";

export type ChallengeSignal = {
  cfMitigated?: string | null;
  text: string;
  visibleChallengeControl: boolean;
  hasCnCaptchaWidget?: boolean;
  hasQrLogin?: boolean;
  hasBlockingOverlay?: boolean;
};

type Signal = ChallengeSignal;
type Classification = Omit<BrowserChallenge, "requestId">;

export const CN_CAPTCHA_REASON =
  "检测到国内安全验证或滑块/扫码风控，请在浏览器窗口亲自完成验证后点击「我已完成，继续执行」。";

const CN_CAPTCHA_TEXT_RE =
  /拖动滑块|请按住滑块|向右滑动完成拼图|完成安全验证|请完成人机验证/;
const CN_QR_TEXT_RE = /请使用手机扫码|扫码登录/;

/** Generic access denial and score-only blocks offer no actionable human challenge. */
export function classifyChallenge(signal: Signal): Classification | undefined {
  if (signal.cfMitigated?.trim().toLowerCase() === "challenge")
    return {
      kind: "cloudflare",
      reason:
        "This site presented a Cloudflare security challenge. Please complete it in the existing browser, then hand control back.",
    };
  if (signal.hasCnCaptchaWidget) {
    return {
      kind: "cn-captcha",
      reason: CN_CAPTCHA_REASON,
    };
  }
  const trimmedLength = signal.text.trim().length;
  const intercepted =
    Boolean(signal.hasBlockingOverlay) || signal.visibleChallengeControl;
  if (
    signal.hasQrLogin &&
    (Boolean(signal.hasBlockingOverlay) ||
      trimmedLength === 0 ||
      trimmedLength <= 800)
  ) {
    return {
      kind: "cn-captcha",
      reason: CN_CAPTCHA_REASON,
    };
  }
  if (
    CN_CAPTCHA_TEXT_RE.test(signal.text) &&
    (intercepted || (trimmedLength > 0 && trimmedLength <= 1200))
  ) {
    return {
      kind: "cn-captcha",
      reason: CN_CAPTCHA_REASON,
    };
  }
  if (
    CN_QR_TEXT_RE.test(signal.text) &&
    (intercepted || (trimmedLength > 0 && trimmedLength <= 600))
  ) {
    return {
      kind: "cn-captcha",
      reason: CN_CAPTCHA_REASON,
    };
  }
  if (
    signal.visibleChallengeControl &&
    /verify (?:that )?you (?:are|'re) (?:a )?human|confirm (?:that )?you (?:are|'re) (?:a )?human|i(?:'|’)m not a robot|complete (?:the|this) (?:captcha|security check)|select all (?:images|squares)|prove (?:that )?you (?:are|'re) (?:a )?human/i.test(
      signal.text,
    )
  ) {
    return {
      kind: "visible-challenge",
      reason:
        "This page has a visible human verification challenge. Please complete it in the existing browser, then hand control back.",
    };
  }
}

/** Called only on navigate/read/snapshot. Does not solve, click, or reload a challenge. */
export async function detectChallenge(
  page: Page,
  control: Control,
  options: { cfMitigated?: string | null; toolCallId?: string } = {},
): Promise<BrowserChallenge | undefined> {
  const signal =
    options.cfMitigated?.trim().toLowerCase() === "challenge"
      ? {
          text: "",
          visibleChallengeControl: false,
          cfMitigated: options.cfMitigated,
        }
      : await page.evaluate(() => {
          const visible = (element: Element) => {
            const style = getComputedStyle(element);
            const bounds = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity) !== 0 &&
              bounds.width > 0 &&
              bounds.height > 0 &&
              bounds.bottom > 0 &&
              bounds.right > 0 &&
              bounds.top < innerHeight &&
              bounds.left < innerWidth
            );
          };
          const frames = Array.from(document.querySelectorAll("iframe[src]"));
          const challengeFrames = frames.filter((frame) => {
            const src = frame.getAttribute("src") ?? "";
            return (
              /(?:google\.com\/recaptcha|recaptcha\.net\/recaptcha|hcaptcha\.com\/|challenges\.cloudflare\.com\/)/i.test(
                src,
              ) && visible(frame)
            );
          });
          const cnFrames = frames.some((frame) => {
            const src = frame.getAttribute("src") ?? "";
            return (
              visible(frame) &&
              (/geetest|tcaptcha|captcha\.qq\.com/i.test(src) ||
                (/alicdn/i.test(src) && /captcha|punish/i.test(src)))
            );
          });
          const cnWidgets = Array.from(
            document.querySelectorAll(
              [
                ".geetest_holder",
                ".geetest_panel_box",
                "#tcaptcha_iframe",
                "#tcaptcha_transform_dy",
                "#nc_1_wrapper",
                ".nc-container",
                ".secsdk-captcha-drag-wrapper",
                ".captcha-verify-container",
              ].join(", "),
            ),
          );
          const hasCnCaptchaWidget = cnFrames || cnWidgets.some(visible);
          const cnChallengePromptRe =
            /拖动滑块|请按住滑块|向右滑动完成拼图|完成安全验证|请完成人机验证|请使用手机扫码|扫码登录/;
          const cnQrPromptRe = /请使用手机扫码|扫码登录/;
          const overlays = Array.from(
            document.querySelectorAll(
              '[role="dialog"], [aria-modal="true"], [class*="captcha" i], [class*="verify" i], [class*="qrcode" i], [class*="login" i], [class*="modal" i], [class*="mask" i], [class*="popup" i]',
            ),
          );
          let hasBlockingOverlay = false;
          let hasBlockingQrOverlay = false;
          for (const overlay of overlays) {
            if (!visible(overlay)) continue;
            const bounds = overlay.getBoundingClientRect();
            if (bounds.width < 180 || bounds.height < 120) continue;
            const overlayText = overlay.textContent ?? "";
            if (cnChallengePromptRe.test(overlayText)) {
              hasBlockingOverlay = true;
              if (cnQrPromptRe.test(overlayText)) hasBlockingQrOverlay = true;
            }
          }
          const hasVisibleQrElement = Array.from(
            document.querySelectorAll(
              '[class*="qr" i], [class*="scan" i], img[alt*="扫码"], img[alt*="二维码"], img[src*="qr" i], canvas',
            ),
          ).some((element) => {
            if (!visible(element)) return false;
            const bounds = element.getBoundingClientRect();
            return bounds.width >= 60 && bounds.height >= 60;
          });
          const controls = Array.from(
            document.querySelectorAll(
              'input[type="checkbox"], [role="checkbox"], button',
            ),
          );
          const visibleChallengeControl =
            challengeFrames.length > 0 ||
            controls.some(
              (control) =>
                visible(control) &&
                /human|not a robot|verify|captcha/i.test(
                  control.getAttribute("aria-label") ??
                    control.closest("label")?.textContent ??
                    control.textContent ??
                    "",
                ),
            );
          // biome-ignore lint/performance/useDomNodeTextContent: 要的是渲染后的可见正文，textContent 会带上隐藏节点
          const text = (document.body?.innerText ?? "").slice(0, 20_000);
          const hasQrLogin =
            hasBlockingQrOverlay ||
            (hasVisibleQrElement &&
              text.trim().length <= 600 &&
              cnQrPromptRe.test(text));
          return {
            text,
            visibleChallengeControl,
            hasCnCaptchaWidget,
            hasQrLogin,
            hasBlockingOverlay,
          };
        });
  const result = classifyChallenge(signal);
  if (!result) return undefined;
  const request = control.requestHelp(
    result.reason,
    options.toolCallId,
    result.kind,
  ).request;
  if (!request)
    throw new Error("The challenge handoff did not produce a request.");
  return { ...result, requestId: request.id };
}
