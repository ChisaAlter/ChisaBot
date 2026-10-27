import {
  IconArrowLeft,
  IconArrowRight,
  IconBolt,
  IconCalendarEvent,
  IconClipboardText,
  IconCommand,
  IconMail,
  IconMessageReply,
  IconPlugConnected,
  IconSparkles,
  IconSun,
  IconWand,
  IconX,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { BotBubbles } from "@/components/chat/bot-bubbles";
import { toast } from "@/components/ui/toast";
import {
  CHISABOT_QUOTE_EVENT,
  type ComposerQuotePayload,
  dispatchComposerQuote,
} from "@/lib/chat/quote-event";
import { botsTarget, isBotsChatPath } from "@/lib/bots-location";

export const CHISABOT_SPOTLIGHT_EVENT = "chisabot-spotlight";

export function openQuickSpotlight() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHISABOT_SPOTLIGHT_EVENT));
}

export function sendPromptToChat(
  navigate: ReturnType<typeof useNavigate>,
  text: string,
  sourceLabel?: string,
) {
  const trimmed = text.trim();
  if (!trimmed || typeof window === "undefined") return;
  const fire = () => {
    if (sourceLabel) {
      dispatchComposerQuote({ text: trimmed, source: sourceLabel });
    } else {
      window.dispatchEvent(new CustomEvent("chisabot-prefill", { detail: trimmed }));
    }
  };
  const hadComposer = Boolean(document.querySelector(".glass-composer"));
  if (!isBotsChatPath(window.location.pathname)) {
    const target = botsTarget();
    void navigate(target as never);
  }
  if (hadComposer) {
    fire();
  } else {
    window.setTimeout(fire, 120);
  }
}

export function QuickSpotlight() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [briefMarkdown, setBriefMarkdown] = useState<string | null>(null);
  const [loadingBrief, setLoadingBrief] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Alt+Space summons Quick Spotlight (Ctrl+K is reserved for sidebar conversation search)
      const isAltSpace = e.altKey && !e.ctrlKey && !e.metaKey && e.code === "Space";
      if (isAltSpace) {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    const onCustomOpen = () => {
      setOpen(true);
    };
    const onQuote = (ev: Event) => {
      const detail = (ev as CustomEvent<ComposerQuotePayload & { __forwarded?: boolean }>).detail;
      if (open) {
        setOpen(false);
        setBriefMarkdown(null);
      }
      if (
        detail &&
        !detail.__forwarded &&
        !document.querySelector(".glass-composer") &&
        !isBotsChatPath(window.location.pathname)
      ) {
        const target = botsTarget();
        void navigate(target as never);
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent(CHISABOT_QUOTE_EVENT, {
              detail: { ...detail, __forwarded: true },
            }),
          );
        }, 140);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(CHISABOT_SPOTLIGHT_EVENT, onCustomOpen);
    window.addEventListener(CHISABOT_QUOTE_EVENT, onQuote);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(CHISABOT_SPOTLIGHT_EVENT, onCustomOpen);
      window.removeEventListener(CHISABOT_QUOTE_EVENT, onQuote);
    };
  }, [open, navigate]);

  useEffect(() => {
    if (!open) {
      setBriefMarkdown(null);
      return;
    }
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 20);
    return () => window.clearTimeout(id);
  }, [open]);

  if (!open) return null;

  const submitToComposer = (text: string, sourceLabel?: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setOpen(false);
    setQuery("");
    sendPromptToChat(navigate, trimmed, sourceLabel);
  };

  const handlePreviewMorningBrief = async () => {
    setLoadingBrief(true);
    try {
      const res = await fetch("/api/personal-sources/morning-brief", {
        method: "POST",
        credentials: "include",
      });
      const data = (await res.json()) as { markdown?: string; error?: string };
      if (!res.ok || !data.markdown) {
        throw new Error(data.error || "生成晨报失败");
      }
      setBriefMarkdown(data.markdown);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "生成晨报失败");
    } finally {
      setLoadingBrief(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 遮罩点击关闭；键盘走 Esc（window 级 keydown 已处理）
    <div
      aria-label="快捷指令与随手问浮窗"
      aria-modal="true"
      className="chat-spotlight-backdrop"
      data-testid="quick-spotlight"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
      role="dialog"
    >
      <div className="chat-spotlight-panel">
        <form
          className="chat-spotlight-bar"
          onSubmit={(e) => {
            e.preventDefault();
            submitToComposer(query);
          }}
        >
          <span className="chat-spotlight-icon" aria-hidden="true">
            <IconSparkles className="size-4" />
          </span>
          <input
            aria-label="快捷输入或指令"
            className="chat-spotlight-input"
            data-testid="quick-spotlight-input"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="随手问 ChisaBot，或输入引用内容回车直达输入框… (Alt+Space)"
            ref={inputRef}
            value={query}
          />
          <kbd className="chat-spotlight-kbd">{"Alt+Space"}</kbd>
          <button
            aria-label="关闭快捷浮窗"
            className="chat-spotlight-close"
            data-testid="quick-spotlight-close"
            onClick={() => setOpen(false)}
            type="button"
          >
            <IconX className="size-4" />
          </button>
        </form>

        {briefMarkdown ? (
          <div className="chat-spotlight-brief" data-testid="quick-spotlight-brief">
            <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-border/50 pb-2">
              <button
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                data-testid="spotlight-brief-back-btn"
                onClick={() => setBriefMarkdown(null)}
                type="button"
              >
                <IconArrowLeft className="size-3.5" />
                {"返回快捷指令列表"}
              </button>
              <button
                className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                data-testid="spotlight-brief-quote-btn"
                onClick={() =>
                  submitToComposer(
                    "请根据今日晨报帮我梳理今天最重要的 3 件事并安排优先级",
                    "今日晨报摘要",
                  )
                }
                type="button"
              >
                <IconMessageReply className="size-3.5" />
                {"带入聊天继续追问"}
              </button>
            </div>
            <BotBubbles text={briefMarkdown} />
          </div>
        ) : (
          <div className="chat-spotlight-actions">
            <button
              className="chat-spotlight-action"
              data-testid="spotlight-action-brief"
              disabled={loadingBrief}
              onClick={() => void handlePreviewMorningBrief()}
              type="button"
            >
              <IconSun className="size-4 text-amber-500" />
              <span className="chat-spotlight-action-main">
                <span className="chat-spotlight-action-title">
                  {loadingBrief ? "正在生成今日晨报卡片…" : "🌅 立即生成今日晨报卡片（Morning Brief）"}
                </span>
                <span className="chat-spotlight-action-sub">
                  {"汇总实时天气、今日日历安排、重要未读邮件与待办记忆"}
                </span>
              </span>
              <IconArrowRight className="size-3.5 opacity-55" />
            </button>

            <button
              className="chat-spotlight-action"
              data-testid="spotlight-action-updates"
              onClick={() =>
                submitToComposer(
                  "请调用 personal_check_updates 主动巡检我即将开始的日程、未读重要邮件与外部事件",
                )
              }
              type="button"
            >
              <IconBolt className="size-4 text-orange-500" />
              <span className="chat-spotlight-action-main">
                <span className="chat-spotlight-action-title">
                  {"⚡ 主动巡检今日动态（会议 / 未读邮件 / 外部事件）"}
                </span>
                <span className="chat-spotlight-action-sub">
                  {"一键检查 2 小时内临近会议、最新未读收件箱与 Webhook 推送"}
                </span>
              </span>
              <IconArrowRight className="size-3.5 opacity-55" />
            </button>

            <button
              className="chat-spotlight-action"
              data-testid="spotlight-action-quote"
              onClick={() =>
                submitToComposer(
                  query.trim() || "请帮我针对刚才的内容做进一步拆解与总结",
                  "快捷追问",
                )
              }
              type="button"
            >
              <IconMessageReply className="size-4 text-sky-500" />
              <span className="chat-spotlight-action-main">
                <span className="chat-spotlight-action-title">
                  {"💬 作为引用追问带入聊天框"}
                </span>
                <span className="chat-spotlight-action-sub">
                  {"将上方输入内容挂为引用胶囊，发给当前机器人"}
                </span>
              </span>
              <IconArrowRight className="size-3.5 opacity-55" />
            </button>

            <button
              className="chat-spotlight-action"
              data-testid="spotlight-action-clipboard"
              onClick={async () => {
                try {
                  const clip = (await navigator.clipboard.readText())?.trim();
                  if (clip) {
                    submitToComposer(clip.slice(0, 2000), "剪贴板上下文");
                  } else {
                    submitToComposer("请调用 device_desktop_context 读取我电脑当前的剪贴板内容并帮我分析");
                  }
                } catch {
                  submitToComposer("请调用 device_desktop_context 读取我电脑当前的剪贴板内容并帮我分析");
                }
              }}
              type="button"
            >
              <IconClipboardText className="size-4 text-cyan-500" />
              <span className="chat-spotlight-action-main">
                <span className="chat-spotlight-action-title">
                  {"📋 附带剪贴板 / 桌面上下文追问"}
                </span>
                <span className="chat-spotlight-action-sub">
                  {"一键读取当前复制的报错、代码或段落挂入聊天框分析"}
                </span>
              </span>
              <IconArrowRight className="size-3.5 opacity-55" />
            </button>

            <button
              className="chat-spotlight-action"
              data-testid="spotlight-action-calendar"
              onClick={() => submitToComposer("请调用 calendar_list_events 查看我未来 7 天的日程安排")}
              type="button"
            >
              <IconCalendarEvent className="size-4 text-emerald-500" />
              <span className="chat-spotlight-action-main">
                <span className="chat-spotlight-action-title">
                  {"📅 询问未来 7 天日历安排"}
                </span>
                <span className="chat-spotlight-action-sub">
                  {"读取已连接的 ICS / WebCal 个人日程"}
                </span>
              </span>
              <IconArrowRight className="size-3.5 opacity-55" />
            </button>

            <button
              className="chat-spotlight-action"
              data-testid="spotlight-action-email"
              onClick={() => submitToComposer("请调用 email_list_recent 查看我最近的收件箱邮件并总结重点")}
              type="button"
            >
              <IconMail className="size-4 text-violet-500" />
              <span className="chat-spotlight-action-main">
                <span className="chat-spotlight-action-title">
                  {"📬 检查收件箱重要未读邮件"}
                </span>
                <span className="chat-spotlight-action-sub">
                  {"通过 IMAP 汇总近期邮件主题与发件人，支持审批回复"}
                </span>
              </span>
              <IconArrowRight className="size-3.5 opacity-55" />
            </button>

            <button
              className="chat-spotlight-action"
              data-testid="spotlight-action-connectors"
              onClick={() =>
                submitToComposer("请调用 connect_service (action='list') 查看我当前所有连接器与插件状态")
              }
              type="button"
            >
              <IconPlugConnected className="size-4 text-indigo-500" />
              <span className="chat-spotlight-action-main">
                <span className="chat-spotlight-action-title">
                  {"🔌 查看所有可用连接器与插件状态"}
                </span>
                <span className="chat-spotlight-action-sub">
                  {"全景巡检邮箱、日历、通知推送、知识库与三方 MCP 状态"}
                </span>
              </span>
              <IconArrowRight className="size-3.5 opacity-55" />
            </button>

            <button
              className="chat-spotlight-action"
              data-testid="spotlight-action-skills"
              onClick={() => {
                setOpen(false);
                void navigate({ to: "/settings/skills" });
              }}
              type="button"
            >
              <IconWand className="size-4 text-pink-500" />
              <span className="chat-spotlight-action-main">
                <span className="chat-spotlight-action-title">
                  {"✨ 精选技能库与 SKILL.md 导入"}
                </span>
                <span className="chat-spotlight-action-sub">
                  {"前往设置 → 技能，一键安装 8 款个人助理技能或导入 GitHub 技能"}
                </span>
              </span>
              <IconArrowRight className="size-3.5 opacity-55" />
            </button>

            <button
              className="chat-spotlight-action"
              data-testid="spotlight-action-settings"
              onClick={() => {
                setOpen(false);
                void navigate({ to: "/settings/connected-accounts" });
              }}
              type="button"
            >
              <IconCommand className="size-4 text-muted-foreground" />
              <span className="chat-spotlight-action-main">
                <span className="chat-spotlight-action-title">
                  {"⚙️ 配置日历、收件箱与账号连接"}
                </span>
                <span className="chat-spotlight-action-sub">
                  {"前往偏好设置 → 账号连接"}
                </span>
              </span>
              <IconArrowRight className="size-3.5 opacity-55" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
