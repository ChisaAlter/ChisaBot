import { IconAlertTriangle, IconWorld, IconX } from "@tabler/icons-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supplySecret } from "@/lib/computers/control";
import {
  readPageFrame,
  readScreenshot,
  type Screenshot,
} from "@/lib/computers/screen";
import { useComputerControl } from "@/lib/computers/use-control";
import { ChannelAvatar } from "../channels/avatar";
import { ComputerControlButton } from "./computer-controls";
import { syncStartLinks } from "@/lib/browser-bookmarks";
import { humanTab, useBrowserTabs } from "@/lib/computers/tabs";
import { BookmarkStar, BookmarksBar } from "./bookmarks-bar";
import { TabStrip } from "./browser-tabs";
import { LiveScreen, type LiveScreenController } from "./live-screen";
import { useElementVisible, usePageVisible } from "./preview-visibility";
import { useTakeoverFit } from "./takeover-fit";

/** Explicit blank-browser URLs use placeholder artwork; missing URL fields are treated as real pages. */
function isBlankBrowser(shot: Screenshot): boolean {
  if (shot.url === undefined) return false;
  // 服务端在空白页上画了起始页：那就是一张有内容的画面，直接显示，不再盖「浏览器空闲」卡片。
  if (shot.startPage) return false;
  const url = shot.url.trim();
  return url === "" || url === "about:blank";
}

/** The part of a URL worth putting on screen; the whole thing is rarely readable at this size. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * What each finished turn opened, and the frame it ended on, kept outside any component.
 *
 * MODULE SCOPE, BECAUSE THE TILE DOES NOT SURVIVE. A transcript re-renders freely and remounts the
 * tiles in it, and anything held in component state goes with it: the fresh mount has no page yet,
 * behaves for one render like a live turn, and reaches for the live screen. Keyed on the tool call,
 * which is the identity of the turn rather than of the component drawing it.
 *
 * Bounded, because a long conversation is a lot of screenshots. Oldest out first, and a turn whose
 * frame has been dropped falls back to naming its page.
 */
type RememberedTurn = {
  page?: { url?: string; title?: string };
  frame?: { base64: string; url: string };
  /** Whether the server has already been asked, so a turn with no frame is not asked again. */
  asked?: boolean;
};
const REMEMBERED_TURNS = new Map<string, RememberedTurn>();
const MAX_REMEMBERED_TURNS = 40;

function rememberTurn(toolCallId: string, patch: RememberedTurn): void {
  const existing = REMEMBERED_TURNS.get(toolCallId) ?? {};
  /*
   * A FRAME IS WRITTEN ONCE, which is what the server's own insert says and what this has to agree
   * with. Letting a later write win is exactly what went wrong: the tile restored the right frame and
   * then replaced it, one render later, with a screenshot of whatever the Bot had open by then.
   */
  const merged: RememberedTurn = { ...existing, ...patch };
  if (existing.frame) merged.frame = existing.frame;
  REMEMBERED_TURNS.delete(toolCallId);
  REMEMBERED_TURNS.set(toolCallId, merged);
  while (REMEMBERED_TURNS.size > MAX_REMEMBERED_TURNS) {
    const oldest = REMEMBERED_TURNS.keys().next().value;
    if (oldest === undefined) break;
    REMEMBERED_TURNS.delete(oldest);
  }
}

/** Default browser viewport ratio, reserved before the first screenshot arrives. */
const DEFAULT_ASPECT_RATIO = 1280 / 800;

/** Minimum readable inline screen size. */
const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MIN_HEIGHT = 200;

/** Preload without failing the poll loop when a frame cannot be decoded early. */
async function preloadFrame(base64: string): Promise<void> {
  try {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
  } catch {
    // Let the visible image element handle decode failures.
  }
}

/** Identical frames in a row that mean the page has stopped changing. */
const SETTLED_FRAMES = 3;

/** Hard cap for post-action polling on pages that never settle. */
const SETTLE_TIMEOUT_MS = 30_000;

/** Short confirmation window after a secret is sent to the page. */
const SECRET_CONFIRM_MS = 6_000;

/**
 * What the frame says when there is no picture in it.
 *
 * Shared by the card and the full-size view because it is the same fact at either size, and because
 * the full-size view is now reachable with nothing to draw: the wheel lives down there, so a person
 * whose Bot is looking at a blank browser — or whose screen cannot be read at all — has to be able
 * to open it and be told why it is empty, rather than find a disabled frame and no way in.
 */
function NothingToSee({
  problem,
  blankBrowser,
  settled,
  page,
}: {
  problem: string | null;
  blankBrowser: boolean;
  /** Whether this is a turn that has finished, rather than the browser as it is now. */
  settled?: boolean;
  /** The page that turn opened, named when there is no picture of it. */
  page?: { url?: string; title?: string } | undefined;
}) {
  return (
    <span className="computer-idle absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center text-muted-foreground text-sm">
      {settled ? (
        <>
          {/*
            What this turn had open, named rather than drawn.

            The picture is gone: nothing stored it, and fetching one now would show a different page.
            Naming the page is the honest version of the same sentence, and it stays true however
            many times the Bot has browsed since.

            GATED ON THE TURN BEING OVER, not on whether a live frame happens to be in hand. A tile
            that was live a moment ago keeps its last screenshot in state after it settles, and this
            used to check for that: with one held and no frame stored, it fell through to "Waiting
            for the assistant's screen…" and waited there for ever, because the poll that would have
            ended the wait stops the moment a turn settles.
          */}
          {page?.url ? (
            <>
              <span className="font-medium">{page.title || "一个页面"}</span>
              <span className="break-all">{hostOf(page.url)}</span>
              <span>{"在此轮次中打开。屏幕已在此之后移动。"}</span>
            </>
          ) : (
            /*
             * A turn that ended without getting anywhere: refused by a boundary, stopped, or failed.
             * Saying "opened during this turn" here would describe something that did not happen.
             */
            <span>{"此轮次未打开页面。"}</span>
          )}
        </>
      ) : problem ? (
        <>
          <IconAlertTriangle className="computer-idle-ic is-warn" />
          <span className="computer-idle-t">{"暂时看不到屏幕"}</span>
          <span className="computer-idle-s">{problem}</span>
        </>
      ) : blankBrowser ? (
        /*
         * 空白浏览器是常态（每次服务更新后浏览器都会重开），以前这里只有一行灰字压在深色底上，
         * 看起来就是「黑屏」。现在明确说这是「空闲」，并告诉人接管后可以自己打开网址。
         */
        <>
          <IconWorld className="computer-idle-ic" />
          <span className="computer-idle-t">{"浏览器空闲"}</span>
          <span className="computer-idle-s">
            {"机器人还没有打开网页。接管后可以在地址栏输入网址。"}
          </span>
        </>
      ) : (
        <span className="computer-idle-s">{"正在等待助手的屏幕…"}</span>
      )}
    </span>
  );
}

type Props = {
  /** Which computer to watch. One shared computer unless each Bot has been given its own. */
  computerId: string;
  /** Off by default so idle Bot screens do not poll indefinitely. */
  active?: boolean;
  intervalMs?: number;
  /** Width divided by height. Overridable for a Bot whose computer is not the default shape. */
  aspectRatio?: number;
  minWidth?: number;
  minHeight?: number;
  /** Whose screen this is, drawn as a small badge over the frame. Absent, no badge is drawn. */
  name?: string;
  /**
   * The page this turn left the browser on, for a turn that has finished.
   *
   * A conversation is a record, and a record must not change its mind. Without this, reopening a
   * conversation made every past turn fetch the screen as it is now, so an answer about Hacker News
   * from an hour ago sat under a picture of whatever the Bot has open today. The frame was live, the
   * caption was not, and the turn read as though it had browsed somewhere it never went.
   */
  page?: { url?: string; title?: string };
  /**
   * Whether the turn this tile belongs to has ended.
   *
   * SEPARATE FROM HAVING A PAGE. A navigation that was refused, failed or stopped ends without one,
   * and a tile that decided history by "do I have a page" left exactly those turns polling the live
   * screen for ever, under an answer that had nothing to do with what was on it.
   */
  finished?: boolean;
  /**
   * The tool call this tile belongs to, which is what a kept frame is filed under.
   *
   * Without it the tile can still name the page; with it, it can show the page. Optional because the
   * side panel is not a turn and has nothing to remember.
   */
  toolCallId?: string;
  /** 右栏「计算机」：画面上面显示一条标签（DESIGN §95）。对话里的小卡片不显示。 */
  browserChrome?: boolean;
};

export function ComputerView({
  computerId,
  active = true,
  intervalMs = 1000,
  aspectRatio = DEFAULT_ASPECT_RATIO,
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  name,
  page,
  finished,
  toolCallId,
  browserChrome = false,
}: Props) {
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [streamProblem, setStreamProblem] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  /**
   * A finished turn is history, and history is not polled.
   *
   * While a turn runs, the frames are that turn's own and freeze where it left them, which is right.
   * Reopening the conversation later is the case this guards: the component mounts with no frame,
   * and fetching one would put today's page under yesterday's answer. It shows the page that turn
   * actually left open instead, which is the thing being remembered.
   *
   * `page` is what marks a turn as settled history rather than one still going, so a caller that
   * knows nothing about the page keeps the old behaviour and nothing regresses.
   *
   * DELIBERATELY NOT "AND WE HAVE NO FRAME YET". That is what this said first, and it undid itself:
   * restoring the kept frame set the frame, which made the turn stop counting as history, which
   * restarted the polling this exists to prevent, which replaced the restored picture with the live
   * one. The turn being over is the fact; whether a picture has arrived yet is not.
   */
  if (toolCallId && page?.url) rememberTurn(toolCallId, { page });
  const knownPage =
    page?.url !== undefined
      ? page
      : toolCallId
        ? REMEMBERED_TURNS.get(toolCallId)?.page
        : undefined;
  const keptFrame = toolCallId
    ? (REMEMBERED_TURNS.get(toolCallId)?.frame ?? null)
    : null;
  /** Bumped when a frame arrives, because the store it lands in is not React state. */
  const [, setFrameArrived] = useState(0);

  const settled = !active && (finished || Boolean(knownPage));
  const {
    control,
    busy: changingControl,
    change: changeControl,
    refresh: refreshControl,
  } = useComputerControl(computerId, !settled);
  /** Held only until it is sent. Never lifted into a URL, a log, or anything that outlives this form. */
  const [secret, setSecret] = useState("");
  const [secretProblem, setSecretProblem] = useState<string | null>(null);
  const [sendingSecret, setSendingSecret] = useState(false);
  const pageVisible = usePageVisible();
  const [previewRef, previewIntersecting] = useElementVisible<HTMLElement>();
  const driving = control?.holder === "human" && !control.transitioning;
  /** Read by the polling loop without restarting it on control changes. */
  const drivingRef = useRef(false);
  drivingRef.current = driving;

  /** Secret prompts keep the screen live even though the human does not hold the wheel. */
  const secretPending = Boolean(control?.secretWanted);
  const secretPendingRef = useRef(false);
  secretPendingRef.current = secretPending;
  // Held in a ref so a slow response cannot overwrite a newer frame after the component moved on.
  const generation = useRef(0);
  /** Force a short watch window after non-Bot actions such as secret entry. */
  const watchUntil = useRef(0);

  const visualVisible = pageVisible && (expanded || previewIntersecting);
  const liveController = useRef<LiveScreenController | null>(null);
  const tabsView = useBrowserTabs(computerId, false);
  const activeTab = tabsView?.tabs.find((tab) => tab.id === tabsView.activeId);
  // 起始页上的常用网站 = 收藏夹：右栏画面出现、打开大屏时推一次给这个机器人的浏览器。
  useEffect(() => {
    if (browserChrome || expanded) syncStartLinks(computerId);
  }, [browserChrome, expanded, computerId]);
  const openBookmark = async (url: string, inNewTab: boolean) => {
    if (inNewTab) {
      const opened = await humanTab(computerId, "new");
      if (!opened.ok) return;
    }
    liveController.current?.openUrl(url);
  };

  /*
   * The frame this turn's page was showing, fetched once and then kept.
   *
   * A READ, AND ONLY A READ. The tile used to capture the frame itself once the turn went inactive,
   * and it kept filing the wrong picture: a reopened turn and one that has just finished look
   * identical from in here, the same computer is driven by other conversations between the two, and
   * a resumed computer starts blank. The frame is now taken on the server the moment the navigation
   * succeeds, which is the one moment the screen is certainly showing the page that was asked for,
   * so there is nothing left here to race.
   */
  useEffect(() => {
    if (!toolCallId || !settled) return;
    const remembered = REMEMBERED_TURNS.get(toolCallId);
    /*
     * Asked once per turn, answer or not. Without remembering the empty answer, every turn from
     * before this shipped refetched nothing on every remount, which on a long transcript is one
     * pointless request per turn per scroll.
     */
    if (remembered?.frame || remembered?.asked) return;
    let current = true;

    void (async () => {
      const stored = await readPageFrame(computerId, toolCallId);
      if (!current) return;
      rememberTurn(toolCallId, {
        asked: true,
        ...(stored ? { frame: { base64: stored.frame, url: stored.url } } : {}),
      });
      if (stored) setFrameArrived((n) => n + 1);
    })();

    return () => {
      current = false;
    };
  }, [computerId, toolCallId, settled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `secretPending` intentionally restarts settled polling.
  useEffect(() => {
    if (settled) return;
    if (!visualVisible) return;
    const mine = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    // Consecutive identical frames observed during post-action settling.
    let unchanged = 0;
    let lastFrame = "";
    const graceStartedAt = Date.now();

    /** Continue while active, human-driven, secret-pending, or not yet visually settled. */
    const shouldContinue = () => {
      if (active) return true;
      if (drivingRef.current) return true;
      if (secretPendingRef.current) return true;
      if (Date.now() < watchUntil.current) return true;
      if (Date.now() - graceStartedAt > SETTLE_TIMEOUT_MS) return false;
      return unchanged < SETTLED_FRAMES;
    };

    // Always fetch at least one frame; only repeated refreshes are conditional.
    const tick = async () => {
      try {
        const { frame, error } = await readScreenshot(computerId);
        if (generation.current !== mine) return;

        if (!frame) {
          setProblem(error ?? "屏幕暂时不可用。");
        } else {
          // Exact byte comparison is the settling signal.
          unchanged = frame.base64 === lastFrame ? unchanged + 1 : 0;
          lastFrame = frame.base64;
          // Decode before swapping to avoid blanking the visible image during data URL changes.
          await preloadFrame(frame.base64);
          if (generation.current !== mine) return;
          setShot(frame);
          setProblem(null);
        }
      } finally {
        if (generation.current === mine && shouldContinue()) {
          timer = setTimeout(tick, intervalMs);
        }
      }
    };

    void tick();
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [computerId, active, intervalMs, secretPending, settled, visualVisible]);

  /*
   * 交还之后收起大屏。交还就是「我弄完了」，留着一个只读的大屏还要再点一次关闭，
   * 用户会以为交还没生效。
   */
  const wasDriving = useRef(false);
  useEffect(() => {
    if (wasDriving.current && !driving && !control?.transitioning) setExpanded(false);
    wasDriving.current = driving;
  }, [driving, control?.transitioning]);

  // Input forwarding lives in LiveScreen on the socket.
  // Escape is bound to the window so it works regardless of overlay focus.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 收藏夹的菜单 / 管理面板先处理了这次 Esc（只关它自己）。
      if (event.defaultPrevented) return;
      // 关掉大屏 = 我弄完了：手里有控制权就顺手交还（Hark 的做法）。以前 Esc 只关窗口、控制权
      // 还留在人手里，机器人下一步全部卡在「等待交还」，而人已经看不到交还按钮了。
      if (driving && !settled) void changeControl?.("release");
      setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, driving, settled, changeControl]);

  // Always render the card frame; help/secret controls live below the conditional picture.
  /*
   * A finished turn is never "blank": it opened a page, and that is what it shows or names. Only a
   * live browser can be sitting on about:blank.
   */
  const blankBrowser = !settled && shot ? isBlankBrowser(shot) : false;

  /*
   * Sized from the ratio, never from the payload, so the frame is identical while a screen is
   * loading, once it arrives, and while the browser has nothing open. A blank browser used to
   * collapse to a strip of text; that made the panel change shape the moment a page opened, and a
   * surface whose whole job is showing a screen kept surprising the layout around it.
   */
  const frameStyle = { aspectRatio, minWidth, minHeight };
  /**
   * What this tile draws: the kept frame for a turn that is over, the live one while it runs.
   *
   * A finished turn never draws `shot`. It may hold one, caught in the render between mounting and
   * its result arriving, and that frame is of whatever the Bot has open now rather than of this turn.
   */
  const drawn = settled
    ? keptFrame
    : shot
      ? { base64: shot.base64, url: shot.url ?? "" }
      : null;
  /** Whether there is a page to draw. A blank browser and an unreadable screen are both "no". */
  const showScreen = drawn !== null && !blankBrowser;
  /**
   * Whether the full-size view has a stream worth opening.
   *
   * Nothing to draw, and it says so in the same words the card does — but somebody holding the wheel
   * gets the live socket whatever is on it, because once a person is driving the stream is the truth
   * about the page and a placeholder over it would be the view arguing with them.
   */
  const showLiveScreen = !settled && (showScreen || driving);
  /**
   * Whether the wheel in somebody's hands is the wheel THIS tile is showing.
   *
   * A person can take control mid-navigation, and the turn then settles under them. `driving` stays
   * true, because it is true: they are driving the browser. It is just not the browser in this
   * picture any more. Left ungated, the frozen tile asserted "You have control" over a page from an
   * hour ago, with the hand-back footer already gone and the backdrop refusing to close because it
   * believed somebody was driving it.
   */
  const wheelHere = driving && !settled;

  const takeoverRef = useTakeoverFit(expanded);
  const closeButton = (
    <button
      type="button"
      className="computer-takeover-close"
      aria-label={wheelHere ? "交还并关闭" : "关闭"}
      title={wheelHere ? "交还并关闭（Esc）" : "关闭（Esc）"}
      onClick={() => {
        if (wheelHere) void changeControl?.("release");
        setExpanded(false);
      }}
    >
      <IconX size={16} stroke={2} />
    </button>
  );
  /** 一轮已经结束：没有标签栏，只写这是哪一轮留下的画面。 */
  const recordTitle = (
    <div className="btabs is-empty">
      <div className="btabs-lead">
        <span className="ctk-record-t">
          {name ? <ChannelAvatar participantIds={[computerId]} size={16} /> : null}
          {knownPage?.title || knownPage?.url || "这一轮打开的页面"}
        </span>
      </div>
      <div className="btabs-end">{closeButton}</div>
    </div>
  );

  const polledScreen = showScreen ? (
    <img
      src={`data:image/png;base64,${drawn.base64}`}
      alt={"助理正在查看什么"}
      // Keep unexpected screenshot dimensions inside the reserved frame.
      className="absolute inset-0 h-full w-full object-contain opacity-100 transition-opacity duration-300 starting:opacity-0"
    />
  ) : null;

  return (
    <>
      {/* 右栏小画面上面不放标签栏：标签只在放大的浏览器里出现（用户 2026-10-16「外面不需要标签」，DESIGN §96）。 */}
      <figure ref={previewRef} className="overflow-hidden rounded-2xl border">
        {/* Inline preview remains in transcript; click opens a readable full-size view. */}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          /*
           * Opens whether or not there is a picture in it. It used to be disabled without one, and
           * the wheel is down there: a blank browser, a screen that had not arrived yet, or a
           * computer that could not be reached left a person with no way to take control at all —
           * the states where they most want it. With nothing to draw the full-size view shows these
           * same words, and the wheel below them.
           */
          className="computer-frame relative block w-full cursor-pointer"
          style={frameStyle}
          aria-label={"打开助手屏幕全尺寸"}
        >
          {polledScreen}

          {/* Whose computer this is — and whose hands are on it — said on the picture itself. */}
          {name || wheelHere ? (
            <span className="absolute right-2 bottom-2 flex items-center gap-1.5">
              {name ? (
                <span className="flex items-center gap-1.5 rounded-full bg-black/60 py-1 pr-2.5 pl-1.5 font-medium text-white text-xs backdrop-blur-sm">
                  <ChannelAvatar participantIds={[computerId]} size={16} />
                  {name}
                </span>
              ) : null}
              {wheelHere ? (
                <span className="rounded-full bg-white px-2.5 py-1 font-medium text-black text-xs shadow-sm">
                  {"您拥有控制权"}
                </span>
              ) : null}
            </span>
          ) : null}

          {showScreen ? null : (
            <NothingToSee
              blankBrowser={blankBrowser}
              page={knownPage}
              problem={problem}
              settled={settled}
            />
          )}
        </button>

        {/* The request reason appears above the always-available ownership controls. */}
        {!driving && !settled && control?.requested ? (
          <div className="flex items-start justify-between gap-3 border-t bg-amber-500/10 px-3 py-2 text-sm">
            <span>
              <strong className="font-medium">{"机器人需要你。"}</strong>{" "}
              {control.reason}
            </span>
          </div>
        ) : null}

        {!settled && control?.requested ? (
          <div className="px-3 pb-2 text-sm">
            <button
              type="button"
              className="underline"
              disabled={changingControl}
              onClick={() => void changeControl?.("cancel")}
            >
              {"取消请求"}
            </button>
          </div>
        ) : null}
        {!settled && control?.transitioning ? (
          <p className="px-3 py-2 text-sm">
            {"在将控制权交给您之前完成助理的当前操作…"}
          </p>
        ) : null}
        {!settled && control?.request?.status === "interrupted" ? (
          <p className="px-3 py-2 text-sm">
            {"浏览器被中断。"}
            {control.request.interruption} {"重新打开屏幕并重新接管以检查它。"}
          </p>
        ) : null}
        {/*
          Secret values go directly to the page path and are never included in the conversation.
          Audit records that a secret was supplied, not the value.
        */}
        {control?.secretWanted ? (
          <form
            className="border-t bg-muted/40 px-3 py-2 text-sm"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!secret || sendingSecret) return;
              setSendingSecret(true);
              watchUntil.current = Date.now() + SECRET_CONFIRM_MS;
              const result = await supplySecret(computerId, secret);
              setSendingSecret(false);
              // Clear even on failure so plaintext is not left in the DOM.
              setSecret("");
              setSecretProblem(result.ok ? null : (result.error ?? null));
              await refreshControl?.();
            }}
          >
            <label className="block" htmlFor="openbot-secret">
              <span className="font-medium">{"助手需要"}</span>
              <span>{control.secretWanted}</span>
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="openbot-secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={"在此键入，从不显示给助手"}
                className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
              />
              <button
                type="submit"
                disabled={!secret || sendingSecret}
                className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {sendingSecret ? "发送中…" : "发送到页面"}
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {"此直接跳转到页面。它不会在会话中显示，助手也不会收到。"}
            </p>
            {secretProblem ? (
              <p className="mt-1 text-xs text-destructive">{secretProblem}</p>
            ) : null}
          </form>
        ) : null}

        {!settled ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {!control
                ? "正在检查谁有控制权…"
                : control.transitioning
                  ? "正在完成当前操作…"
                  : driving
                    ? "你在控制浏览器，打开大屏点击和输入，用完点「交还」。"
                    : "机器人在用浏览器，你可以随时接管。"}
            </span>
            <ComputerControlButton
              computerId={computerId}
              onTakeControl={() => setExpanded(true)}
            />
          </div>
        ) : null}
      </figure>

      {/*
        Portal to body so fixed positioning is measured against the viewport, not containing panes.
      */}
      {expanded && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label={"助手的屏幕"}
              // 高于抽屉（窄窗口时右栏是 z-50 的抽屉），接管的大屏永远在最上层、可以点。
              className="computer-takeover fixed inset-0 z-[110] flex items-center justify-center"
            >
              {/*
                Backdrop closes only while read-only; during driving, Escape remains the exit. A
                turn that is over is always read-only, whoever is holding the live browser.
              */}
              <button
                type="button"
                onClick={() => !wheelHere && setExpanded(false)}
                aria-label={"关闭助理的屏幕"}
                aria-hidden={wheelHere}
                tabIndex={wheelHere ? -1 : 0}
                className={`absolute inset-0 bg-black/80 ${wheelHere ? "cursor-default" : "cursor-zoom-out"}`}
              />
              {/*
                放大的浏览器（DESIGN §96）：卡片永远不滚动。上面一块玻璃工具条（标签栏 + 地址栏 + 收藏栏，
                关闭按钮在标签栏最右端），中间是按剩余高度等比缩放的屏幕，底部一行「谁 · 状态 · 交还」
                始终在卡片里面。可用高度由 useTakeoverFit 量出来写进 --ctk-avail。
              */}
              <div
                ref={takeoverRef}
                className={`computer-takeover-card${settled ? " is-record" : ""}`}
                style={{ "--ctk-ar": String(aspectRatio) } as CSSProperties}
              >
                {settled && drawn ? (
                  /*
                   * A record, opened larger. Not a window on the browser.
                   *
                   * Zooming a past turn used to mount the live stream and offer Take control, so
                   * the one gesture for looking closer at what a turn did was also the one that
                   * replaced it with whatever the Bot has open now. The kept frame exists to stop
                   * exactly that; its own zoom control was undoing it.
                   */
                  <>
                    <div className="computer-chrome">{recordTitle}</div>
                    <div className="ctk-stage">
                      <div className="computer-screen ctk-screen relative overflow-hidden rounded-lg" data-ctk-screen style={{ aspectRatio }}>
                        <img
                          alt={"此轮次开放了什么"}
                          className="absolute inset-0 h-full w-full object-contain"
                          src={`data:image/png;base64,${drawn.base64}`}
                        />
                      </div>
                    </div>
                  </>
                ) : showLiveScreen ? (
                  /*
                    Overlay uses the live socket; the inline card keeps low-cost polling.
                  */
                  <div className="ctk-stage is-live">
                    <LiveScreen
                      aboveUrlbar={
                        <TabStrip
                          computerId={computerId}
                          driving={driving}
                          end={closeButton}
                          poll={!showLiveScreen}
                        />
                      }
                      aspectRatio={aspectRatio}
                      belowUrlbar={
                        <BookmarksBar
                          botId={computerId}
                          driving={driving}
                          onOpen={(url, inNewTab) => void openBookmark(url, inNewTab)}
                        />
                      }
                      computerId={computerId}
                      controllerRef={liveController}
                      driving={driving}
                      onProblem={setStreamProblem}
                      retryKey={retryKey}
                      urlbarEnd={(url) => (
                        <BookmarkStar
                          botId={computerId}
                          disabled={!driving}
                          title={activeTab?.url === url ? activeTab.title : undefined}
                          url={url}
                        />
                      )}
                    >
                      {/*
                        A live screen that ends reports why through `onProblem`, and this is the
                        branch that is mounted when it does. Without drawing it here the message
                        landed in `problem`, which only the sibling `NothingToSee` reads, so the
                        screen ended with the stale last frame frozen on the canvas and nothing said.
                      */}
                      {streamProblem ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/85 p-4 text-center text-sm text-muted-foreground">
                          <span>{streamProblem}</span>
                          <button
                            type="button"
                            className="underline"
                            onClick={() => {
                              setStreamProblem(null);
                              setRetryKey((value) => value + 1);
                            }}
                          >
                            {"重试"}
                          </button>
                        </div>
                      ) : null}
                    </LiveScreen>
                  </div>
                ) : (
                  /*
                    With no page to draw it reserves the same frame and says the same thing the
                    card does — the wheel below is the reason this view opens at all in that state.
                  */
                  <>
                    <div className="computer-chrome">
                      {settled ? recordTitle : <TabStrip computerId={computerId} driving={driving} end={closeButton} poll />}
                    </div>
                    <div className="ctk-stage">
                      <div className="computer-frame ctk-screen relative w-full rounded-lg" data-ctk-screen style={{ aspectRatio }}>
                        <NothingToSee
                          blankBrowser={blankBrowser}
                          page={knownPage}
                          problem={problem}
                          settled={settled}
                        />
                      </div>
                    </div>
                  </>
                )}
                {/*
                  NOT ON A TURN THAT IS OVER. Every past turn used to carry the wheel and the
                  standing "who is driving" prose under a picture of a page it opened an hour ago,
                  offering control of whatever the Bot has open now. Those sentences are about the
                  present and this view is a record; a record does not get a steering wheel.
                */}
                {settled ? null : (
                  <div className="ctk-foot computer-takeover-controls">
                    {name ? (
                      <span className="ctk-who">
                        <ChannelAvatar participantIds={[computerId]} size={20} />
                        <span className="ctk-who-n">{name}</span>
                      </span>
                    ) : null}
                    <span
                      className="ctk-status"
                      title={control?.reason ? control.reason : undefined}
                    >
                      {control?.transitioning ? (
                        "正在完成当前操作，马上交给你…"
                      ) : driving ? (
                        "你正在控制浏览器"
                      ) : control?.requested ? (
                        <>
                          <strong className="font-medium text-foreground">{"机器人需要你"}</strong>
                          {control.reason ? `：${control.reason}` : null}
                        </>
                      ) : (
                        "机器人在用浏览器，接管后可以点击和输入"
                      )}
                    </span>
                    <span className="ctk-act">
                      <ComputerControlButton computerId={computerId} />
                    </span>
                  </div>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
