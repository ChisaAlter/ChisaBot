import {
  IconArrowDown,
  IconArrowUp,
  IconBookmarks,
  IconCheck,
  IconChevronDown,
  IconExternalLink,
  IconLoader2,
  IconPencil,
  IconSettings,
  IconStar,
  IconStarFilled,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import {
  addBookmark,
  type Bookmark,
  bookmarksQueryOptions,
  findBookmark,
  removeBookmark,
  reorderBookmarks,
  updateBookmark,
} from "@/lib/browser-bookmarks";
import { TabFavicon } from "./browser-tabs";

/**
 * 收藏夹（DESIGN.md §95）：地址栏里的星标、地址栏下面的收藏栏（窄屏是「收藏夹」下拉）、管理面板。
 * 每个用户一份，所有机器人的浏览器共用；起始页上的常用网站就是这里的前 12 个。
 *
 * 打开收藏要人拿着控制权（和地址栏一样）；只看着的时候点收藏会提示先接管。编辑 / 删除 / 排序随时可以。
 * 弹出层都画在大屏卡片里面（不走 portal）：大屏是 z-70 的模态，portal 出去的菜单会被盖住。
 */

/** 地址栏右端的星标：收藏 / 取消收藏当前页。 */
export function BookmarkStar({
  url,
  title,
  botId,
  disabled,
}: {
  url: string;
  title?: string;
  botId: string;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: bookmarks } = useQuery(bookmarksQueryOptions());
  const saved = findBookmark(bookmarks, url);
  const [state, setState] = useState<"idle" | "pending" | "done" | "failed">("idle");
  const web = /^https?:\/\//i.test(url);

  useEffect(() => {
    if (state !== "done" && state !== "failed") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);

  const toggle = async () => {
    if (!web || state === "pending") return;
    setState("pending");
    const started = Date.now();
    try {
      if (saved) await removeBookmark(queryClient, saved.id, botId);
      else await addBookmark(queryClient, { url, ...(title ? { title } : {}) }, botId);
      const left = 300 - (Date.now() - started);
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
      setState("done");
    } catch (error) {
      setState("failed");
      toast.error(error instanceof Error ? error.message : "没能收藏");
    }
  };

  const label = saved ? "取消收藏" : "收藏此页";
  return (
    <button
      aria-label={label}
      aria-pressed={Boolean(saved)}
      className={`computer-urlbar-btn bm-star${saved ? " is-on" : ""}`}
      data-state={state}
      disabled={disabled || !web}
      onClick={() => void toggle()}
      title={web ? label : "只能收藏网页"}
      type="button"
    >
      {state === "pending" ? (
        <IconLoader2 className="size-4 animate-spin" />
      ) : state === "done" ? (
        <IconCheck className="size-4" />
      ) : saved ? (
        <IconStarFilled className="size-4" />
      ) : (
        <IconStar className="size-4" />
      )}
    </button>
  );
}

type Opener = (url: string, inNewTab: boolean) => void;

/** 地址栏下面那一条。 */
export function BookmarksBar({
  botId,
  driving,
  onOpen,
}: {
  botId: string;
  driving: boolean;
  onOpen: Opener;
}) {
  const queryClient = useQueryClient();
  const { data: bookmarks, isLoading } = useQuery(bookmarksQueryOptions());
  const [narrow, setNarrow] = useState(false);
  const [menu, setMenu] = useState<{ id: string } | null>(null);
  const [dropdown, setDropdown] = useState(false);
  const [managing, setManaging] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = box.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? 999) < 520));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), 3000);
    return () => clearTimeout(timer);
  }, [hint]);

  // 点外面 / Esc 关掉弹出层。
  useEffect(() => {
    if (!menu && !dropdown) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      // 菜单开着时 Esc 只关菜单（大屏的 Esc 看 defaultPrevented）。
      if (event instanceof KeyboardEvent) event.preventDefault();
      if (event instanceof MouseEvent && box.current?.contains(event.target as Node)) {
        const inside = (event.target as HTMLElement).closest?.(".bm-pop");
        if (inside) return;
      }
      setMenu(null);
      setDropdown(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close, true);
    };
  }, [menu, dropdown]);

  const open = (bookmark: Bookmark, inNewTab = false) => {
    setMenu(null);
    setDropdown(false);
    if (!driving) {
      setHint("接管控制后才能在机器人的浏览器里打开收藏。");
      return;
    }
    onOpen(bookmark.url, inNewTab);
  };

  const list = bookmarks ?? [];
  const drop = (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    const ids = list.map((bookmark) => bookmark.id).filter((id) => id !== dragging);
    ids.splice(ids.indexOf(targetId), 0, dragging);
    setDragging(null);
    void reorderBookmarks(queryClient, ids, botId).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : "没能调整顺序"),
    );
  };

  const menuFor = (bookmark: Bookmark) => (
    <div className="bm-pop bm-menu" role="menu">
      <button className="bm-menu-i" onClick={() => open(bookmark)} role="menuitem" type="button">
        <IconExternalLink size={15} />
        {"打开"}
      </button>
      <button className="bm-menu-i" onClick={() => open(bookmark, true)} role="menuitem" type="button">
        <IconExternalLink size={15} />
        {"在新标签页打开"}
      </button>
      <button
        className="bm-menu-i"
        onClick={() => {
          setMenu(null);
          setManaging(true);
        }}
        role="menuitem"
        type="button"
      >
        <IconPencil size={15} />
        {"编辑…"}
      </button>
      <button
        className="bm-menu-i is-danger"
        onClick={() => {
          setMenu(null);
          void removeWithUndo(queryClient, bookmark, botId);
        }}
        role="menuitem"
        type="button"
      >
        <IconTrash size={15} />
        {"删除"}
      </button>
    </div>
  );

  return (
    <div className={`bm-bar${narrow ? " is-narrow" : ""}`} ref={box}>
      {narrow ? (
        <div className="bm-drop-wrap">
          <button
            aria-expanded={dropdown}
            aria-haspopup="menu"
            className="bm-drop"
            onClick={() => setDropdown((value) => !value)}
            type="button"
          >
            <IconBookmarks size={15} />
            <span>{"收藏夹"}</span>
            <IconChevronDown size={14} />
          </button>
          {dropdown ? (
            <div className="bm-pop bm-menu bm-drop-list" role="menu">
              {list.length === 0 ? <p className="bm-empty">{"还没有收藏。点地址栏里的星标收藏当前页。"}</p> : null}
              {list.map((bookmark) => (
                <button
                  className="bm-menu-i"
                  key={bookmark.id}
                  onClick={() => open(bookmark)}
                  role="menuitem"
                  type="button"
                >
                  <TabFavicon size={15} tab={{ title: bookmark.title, url: bookmark.url }} />
                  <span className="bm-menu-t">{bookmark.title}</span>
                </button>
              ))}
              <div className="bm-menu-sep" />
              <button
                className="bm-menu-i"
                onClick={() => {
                  setDropdown(false);
                  setManaging(true);
                }}
                role="menuitem"
                type="button"
              >
                <IconSettings size={15} />
                {"管理收藏夹"}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div aria-label={"收藏栏"} className="bm-track" role="toolbar">
          {isLoading ? <span className="bm-empty">{"正在加载收藏夹…"}</span> : null}
          {!isLoading && list.length === 0 ? (
            <span className="bm-empty">{"还没有收藏。点地址栏里的星标收藏当前页。"}</span>
          ) : null}
          {list.map((bookmark) => (
            <div className="bm-chip-wrap" key={bookmark.id}>
              <button
                className={`bm-chip${dragging === bookmark.id ? " is-dragging" : ""}`}
                draggable
                onClick={(event) => open(bookmark, event.ctrlKey || event.metaKey)}
                onAuxClick={(event) => {
                  if (event.button === 1) open(bookmark, true);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ id: bookmark.id });
                }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => {
                  if (dragging) event.preventDefault();
                }}
                onDragStart={(event) => {
                  setDragging(bookmark.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", bookmark.url);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  drop(bookmark.id);
                }}
                title={`${bookmark.title}\n${bookmark.url}`}
                type="button"
              >
                <TabFavicon size={14} tab={{ title: bookmark.title, url: bookmark.url }} />
                <span className="bm-chip-t">{bookmark.title}</span>
              </button>
              {menu?.id === bookmark.id ? menuFor(bookmark) : null}
            </div>
          ))}
        </div>
      )}
      {!narrow ? (
        <button
          aria-label={"管理收藏夹"}
          className="bm-manage-btn"
          onClick={() => setManaging(true)}
          title={"管理收藏夹（改名、删除、排序）"}
          type="button"
        >
          <IconSettings size={15} />
        </button>
      ) : null}
      {hint ? (
        <p className="bm-hint" role="status">
          {hint}
        </p>
      ) : null}
      {managing ? <BookmarkManager botId={botId} onClose={() => setManaging(false)} /> : null}
    </div>
  );
}

async function removeWithUndo(queryClient: ReturnType<typeof useQueryClient>, bookmark: Bookmark, botId: string) {
  try {
    await removeBookmark(queryClient, bookmark.id, botId);
    toast.undo(`已删除收藏「${bookmark.title}」`, () => {
      void addBookmark(queryClient, { title: bookmark.title, url: bookmark.url }, botId).catch(() => undefined);
    });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "没能删除");
  }
}

/** 管理面板：添加、改名 / 改网址、上移下移、删除。 */
function BookmarkManager({ botId, onClose }: { botId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: bookmarks } = useQuery(bookmarksQueryOptions());
  const [editing, setEditing] = useState<{ id: string; title: string; url: string } | null>(null);
  const [adding, setAdding] = useState({ title: "", url: "" });
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const list = bookmarks ?? [];

  useEffect(() => {
    // Esc 只关这个面板，不关大屏、不交还控制权：窗口捕获阶段最先拿到，标记 defaultPrevented 并截住。
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const guarded = async (key: string, work: () => Promise<unknown>) => {
    setPending(key);
    setProblem(null);
    try {
      await work();
      return true;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "没能保存");
      return false;
    } finally {
      setPending(null);
    }
  };

  const move = (index: number, delta: number) => {
    const ids = list.map((bookmark) => bookmark.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(index + delta, 0, moved);
    void guarded(`m:${moved}`, () => reorderBookmarks(queryClient, ids, botId));
  };

  const submitAdd = async (event: FormEvent) => {
    event.preventDefault();
    if (!adding.url.trim()) return;
    const ok = await guarded("add", () =>
      addBookmark(queryClient, { url: adding.url.trim(), ...(adding.title.trim() ? { title: adding.title.trim() } : {}) }, botId),
    );
    if (ok) setAdding({ title: "", url: "" });
  };

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const ok = await guarded(`e:${editing.id}`, () =>
      updateBookmark(queryClient, editing.id, { title: editing.title, url: editing.url }, botId),
    );
    if (ok) setEditing(null);
  };

  return (
    <div aria-label={"管理收藏夹"} aria-modal="false" className="bm-pop bm-manager" role="dialog">
      <div className="bm-manager-h">
        <IconBookmarks size={16} />
        <span>{"收藏夹"}</span>
        <span className="bm-manager-n">{list.length}</span>
        <button aria-label={"关闭"} className="bm-icon-btn" onClick={onClose} title={"关闭（Esc）"} type="button">
          <IconX size={15} />
        </button>
      </div>
      <p className="bm-manager-s">{"所有机器人的浏览器共用这一份；前 12 个会显示在新标签页上。"}</p>
      <ul className="bm-manager-list">
        {list.map((bookmark, index) => (
          <li className="bm-row" key={bookmark.id}>
            {editing?.id === bookmark.id ? (
              <form className="bm-edit" onSubmit={(event) => void submitEdit(event)}>
                <input
                  aria-label={"名称"}
                  // biome-ignore lint/a11y/noAutofocus: 刚打开的就地输入框，用户的下一步就是输入
                  autoFocus
                  className="bm-input"
                  maxLength={80}
                  onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                  value={editing.title}
                />
                <input
                  aria-label={"网址"}
                  className="bm-input is-url"
                  onChange={(event) => setEditing({ ...editing, url: event.target.value })}
                  spellCheck={false}
                  value={editing.url}
                />
                <button className="bm-text-btn is-primary" disabled={pending !== null} type="submit">
                  {pending === `e:${bookmark.id}` ? <IconLoader2 className="animate-spin" size={14} /> : null}
                  {pending === `e:${bookmark.id}` ? "保存中…" : "保存"}
                </button>
                <button className="bm-text-btn" onClick={() => setEditing(null)} type="button">
                  {"取消"}
                </button>
              </form>
            ) : (
              <>
                <TabFavicon size={16} tab={{ title: bookmark.title, url: bookmark.url }} />
                <span className="bm-row-main">
                  <span className="bm-row-t">{bookmark.title}</span>
                  <span className="bm-row-u">{bookmark.url}</span>
                </span>
                <button
                  aria-label={`上移「${bookmark.title}」`}
                  className="bm-icon-btn"
                  disabled={index === 0 || pending !== null}
                  onClick={() => move(index, -1)}
                  title={"上移"}
                  type="button"
                >
                  <IconArrowUp size={15} />
                </button>
                <button
                  aria-label={`下移「${bookmark.title}」`}
                  className="bm-icon-btn"
                  disabled={index === list.length - 1 || pending !== null}
                  onClick={() => move(index, 1)}
                  title={"下移"}
                  type="button"
                >
                  <IconArrowDown size={15} />
                </button>
                <button
                  aria-label={`编辑「${bookmark.title}」`}
                  className="bm-icon-btn"
                  onClick={() => setEditing({ id: bookmark.id, title: bookmark.title, url: bookmark.url })}
                  title={"改名 / 改网址"}
                  type="button"
                >
                  <IconPencil size={15} />
                </button>
                <button
                  aria-label={`删除「${bookmark.title}」`}
                  className="bm-icon-btn is-danger"
                  disabled={pending !== null}
                  onClick={() => void removeWithUndo(queryClient, bookmark, botId)}
                  title={"删除"}
                  type="button"
                >
                  <IconTrash size={15} />
                </button>
              </>
            )}
          </li>
        ))}
        {list.length === 0 ? <li className="bm-empty">{"还没有收藏。"}</li> : null}
      </ul>
      <form className="bm-add" onSubmit={(event) => void submitAdd(event)}>
        <input
          aria-label={"新收藏的名称"}
          className="bm-input"
          maxLength={80}
          onChange={(event) => setAdding({ ...adding, title: event.target.value })}
          placeholder={"名称（可不填）"}
          value={adding.title}
        />
        <input
          aria-label={"新收藏的网址"}
          className="bm-input is-url"
          onChange={(event) => setAdding({ ...adding, url: event.target.value })}
          placeholder={"网址，例如 github.com"}
          spellCheck={false}
          value={adding.url}
        />
        <button className="bm-text-btn is-primary" disabled={!adding.url.trim() || pending !== null} type="submit">
          {pending === "add" ? <IconLoader2 className="animate-spin" size={14} /> : null}
          {pending === "add" ? "添加中…" : "添加"}
        </button>
      </form>
      {problem ? (
        <p className="bm-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
