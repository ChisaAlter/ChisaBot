import {
  IconArrowRight,
  IconCalendarEvent,
  IconCommand,
  IconMail,
  IconMessageReply,
  IconSparkles,
  IconSun,
  IconX,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { BotBubbles } from "@/components/chat/bot-bubbles";
import { dispatchComposerQuote } from "@/lib/chat/quote-event";

export const CHISABOT_SPOTLIGHT_EVENT = "chisabot-spotlight";

export function openQuickSpotlight() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHISABOT_SPOTLIGHT_EVENT));
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
      // Alt+Space or Ctrl/Cmd+K summons Quick Spotlight
      const isAltSpace = e.altKey && !e.ctrlKey && !e.metaKey && e.code === "Space";
      const isCmdK = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
      if (isAltSpace || isCmdK) {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    const onCustomOpen = () => {
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(CHISABOT_SPOTLIGHT_EVENT, onCustomOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(CHISABOT_SPOTLIGHT_EVENT, onCustomOpen);
    };
  }, [open]);

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
    // Focus composer textarea and insert or quote
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="composer-textarea"], .composer textarea, textarea',
    );
    if (sourceLabel) {
      dispatchComposerQuote({ text: trimmed, source: sourceLabel });
      return;
    }
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (setter) {
        setter.call(textarea, trimmed);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      textarea.focus();
    } else {
      dispatchComposerQuote({ text: trimmed, source: "快捷唤起" });
    }
  };

  const handlePreviewMorningBrief = async () => {
    setLoadingBrief(true);
    try {
      const res = await fetch("/api/personal-sources/morning-brief", {
        method: "POST",
        credentials: "include",
      });
      const data = (await res.json()) as { markdown?: string };
      if (data.markdown) {
        setBriefMarkdown(data.markdown);
      }
    } finally {
      setLoadingBrief(false);
    }
  };

  return (
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
            placeholder="随手问 ChisaBot，或输入引用内容回车直达输入框… (Alt+Space / Ctrl+K)"
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
                  {"通过只读 IMAP 汇总近期邮件主题与发件人"}
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
