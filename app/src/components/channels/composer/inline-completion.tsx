import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTimeout } from "@/hooks";
import {
  composerInlineCompletionQueryOptions,
  composerSettingsQueryOptions,
} from "@/lib/composer/queries";

/**
 * 行内补全 ghost text（CB-145 PR6）：草稿停顿时预判续写，灰色投影接在文本末尾，
 * Tab / 右箭头接受，Esc 或继续输入丢弃。
 *
 * 渲染用 mirror-overlay：一个与编辑器同排版同几何的隐形副本叠在编辑器上，
 * 复制纯文本后把 suffix 以可见颜色接在后面——浏览器自己的折行把 suffix 排到
 * 正确的位置，不需要任何 caret 像素测量。
 *
 * 硬约束（与 spec 对齐）：
 * - 只追加：suffix 永远接在草稿末尾，绝不改写已输入的文字；
 * - IME 安全：composition 期间不出、不接受；
 * - caret 必须在文本末尾（用 range 折叠技巧判定，不需要坐标）；
 * - 无 chip 时才出：编辑器内容才是纯文本，mirror 排版才逐字准确。
 */

function resolveEditor(container: HTMLElement | null): HTMLElement | null {
  return container?.querySelector("[contenteditable]") ?? null;
}

/** caret 是否处于编辑器的绝对末尾：把全文档 range 起点裁到 caret，若坍塌则在末尾。 */
export function caretAtEnd(editor: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed)
    return false;
  const anchor = selection.anchorNode;
  if (!anchor || !editor.contains(anchor)) return false;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.setStart(selection.anchorNode, selection.anchorOffset);
  return range.collapsed;
}

function copyTypography(source: HTMLElement, target: HTMLElement) {
  const style = window.getComputedStyle(source);
  for (const property of [
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "word-break",
    "overflow-wrap",
    "white-space",
  ]) {
    target.style.setProperty(property, style.getPropertyValue(property));
  }
}

export function InlineCompletionGhost({
  text,
  hasChips,
  composing,
  containerRef,
  onAccept,
}: {
  /** 当前草稿纯文本（未 trim——续写对尾部空白敏感）。 */
  text: string;
  hasChips: boolean;
  /** IME composition 进行中：不出补全也不接受。 */
  composing: boolean;
  /** composer 外层 ref：内部惰性查询 contenteditable，按它的排版对齐。 */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 接受回调：把 suffix 追加进草稿。 */
  onAccept: (suffix: string) => void;
}) {
  const settingsQuery = useQuery(composerSettingsQueryOptions());
  const completionEnabled = settingsQuery.data?.completionEnabled === true;

  const [settled, setSettled] = useState("");
  useTimeout(() => setSettled(text), 400, text);
  const stable =
    completionEnabled &&
    !hasChips &&
    !composing &&
    settled.length >= 2 &&
    settled === text
      ? settled
      : "";
  const query = useQuery(composerInlineCompletionQueryOptions(stable));
  const suffix = stable ? (query.data?.completion ?? null) : null;

  // 排版 / 几何同步：suffix 出现时把编辑器计算样式抄到 mirror 上，并按编辑器
  // 相对包裹元素的实时几何摆放 overlay。rect 相减对任何嵌套结构都正确。
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: text 变化会改变编辑器几何（折行/高度），必须重量，虽然 effect 体不直接引用它
  useEffect(() => {
    const mirror = mirrorRef.current;
    const overlay = overlayRef.current;
    const editor = resolveEditor(containerRef.current);
    if (!mirror || !overlay || !editor || !suffix) return;
    copyTypography(editor, mirror);
    const host =
      overlay.offsetParent instanceof HTMLElement
        ? overlay.offsetParent
        : overlay.parentElement;
    if (!host) return;
    const editorRect = editor.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    overlay.style.left = `${editorRect.left - hostRect.left}px`;
    overlay.style.top = `${editorRect.top - hostRect.top}px`;
    overlay.style.width = `${editorRect.width}px`;
    overlay.style.height = `${editorRect.height}px`;
    overlay.style.opacity = "1";
  }, [containerRef, suffix, text]);

  // 接受 / 丢弃：capture 阶段监听编辑器按键。Tab 或行尾右箭头接受；
  // 只在 caret 位于末尾时接受，否则放行编辑器默认行为。
  const suffixRef = useRef<string | null>(null);
  suffixRef.current = suffix;
  useEffect(() => {
    const editor = resolveEditor(containerRef.current);
    if (!editor || !suffix) return;
    const onKeydown = (event: KeyboardEvent) => {
      const current = suffixRef.current;
      if (!current) return;
      if (event.key !== "Tab" && event.key !== "ArrowRight") return;
      if (!caretAtEnd(editor)) return;
      event.preventDefault();
      event.stopPropagation();
      onAccept(current);
    };
    editor.addEventListener("keydown", onKeydown, true);
    return () => editor.removeEventListener("keydown", onKeydown, true);
  }, [containerRef, suffix, onAccept]);

  if (!suffix || !containerRef.current) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute overflow-hidden"
      ref={overlayRef}
      style={{ opacity: 0 }}
    >
      <div
        className="whitespace-pre-wrap break-words text-transparent"
        ref={mirrorRef}
      >
        {text}
        <span className="text-muted-foreground/60">{suffix}</span>
      </div>
    </div>
  );
}
