import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useElementEvent, useElementSync, useTimeout } from "@/hooks";
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

/**
 * caret 是否处于编辑器的绝对末尾：caret 之后不再有任何内容即在末尾。
 * 不能用 range.collapsed——(textNode,6) 与 (editor,1) 视觉等价但结构上是
 * 两个边界点，typed-at-end 的常见路径下 collapsed 恒 false（PR10 实机确诊）。
 */
export function caretAtEnd(editor: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed)
    return false;
  const anchor = selection.anchorNode;
  if (!anchor || !editor.contains(anchor)) return false;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.setStart(selection.anchorNode, selection.anchorOffset);
  if (range.toString().length > 0) return false;
  const fragment = range.cloneContents();
  return ![...fragment.childNodes].some(
    (node) => node.nodeType === Node.ELEMENT_NODE,
  );
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
  /*
   * Esc 丢弃：记录被丢弃时的 stable 文本，同一段文本的补全不再出现；
   * 文本一旦变化 stable 随之变化，匹配自然失效、补全可以重新出。
   */
  const [dismissed, setDismissed] = useState("");
  const rawSuffix = stable ? (query.data ?? null) : null;
  const suffix = rawSuffix && dismissed !== stable ? rawSuffix : null;

  /*
   * 排版 / 几何同步：把编辑器计算样式抄到 mirror 上，并按编辑器相对包裹元素的
   * 实时几何摆放 overlay。rect 相减对任何嵌套结构都正确；text 进同步值是因为
   * 它会改变编辑器几何（折行 / 高度），几何必须随每次输入重量。
   */
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  useElementSync(containerRef, { suffix, text }, () => {
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
  });

  /*
   * 接受 / 丢弃：capture 阶段监听 composer 容器按键（编辑器在容器内，
   * capture 语义相同）。Tab 或行尾右箭头接受；只在 caret 位于末尾时接受，
   * 否则放行编辑器默认行为。rebindKey=suffix：补全出现 / 变化时重绑。
   */
  const suffixRef = useRef<string | null>(null);
  suffixRef.current = suffix;
  const stableRef = useRef(stable);
  stableRef.current = stable;
  useElementEvent(
    containerRef,
    "keydown",
    suffix
      ? (event) => {
          const current = suffixRef.current;
          const editor = resolveEditor(containerRef.current);
          if (!current || !editor) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(stableRef.current);
            return;
          }
          if (event.key !== "Tab" && event.key !== "ArrowRight") return;
          if (!caretAtEnd(editor)) return;
          event.preventDefault();
          event.stopPropagation();
          onAccept(current);
        }
      : null,
    true,
    suffix ?? "none",
  );

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
