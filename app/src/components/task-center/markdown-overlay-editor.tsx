import { type KeyboardEvent, type ReactNode, useMemo, useRef } from "react";

type TokenKind =
  | "plain"
  | "heading"
  | "cardId"
  | "checkbox"
  | "checkboxDone"
  | "quote"
  | "code"
  | "bold"
  | "fence";

type Token = {
  offset: number;
  kind: TokenKind;
  text: string;
};

const INLINE_TOKEN_RE =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\b[A-Z][A-Z0-9]*-\d+\b)/g;

function tokenizeInline(
  text: string,
  baseOffset: number,
  out: Token[],
): void {
  let cursor = 0;
  INLINE_TOKEN_RE.lastIndex = 0;
  for (;;) {
    const match = INLINE_TOKEN_RE.exec(text);
    if (!match) break;
    const idx = match.index;
    const raw = match[0];
    if (idx > cursor) {
      out.push({
        offset: baseOffset + cursor,
        kind: "plain",
        text: text.slice(cursor, idx),
      });
    }
    const kind: TokenKind = raw.startsWith("`")
      ? "code"
      : raw.startsWith("**")
        ? "bold"
        : "cardId";
    out.push({
      offset: baseOffset + idx,
      kind,
      text: raw,
    });
    cursor = idx + raw.length;
  }
  if (cursor < text.length) {
    out.push({
      offset: baseOffset + cursor,
      kind: "plain",
      text: text.slice(cursor),
    });
  }
}

function tokenizeMarkdownLines(value: string): Token[] {
  const tokens: Token[] = [];
  let inFence = false;
  let offset = 0;
  const parts = value.split("\n");
  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i] ?? "";
    const lineEnd = i < parts.length - 1 ? "\n" : "";
    const rawLine = `${line}${lineEnd}`;
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      tokens.push({ offset, kind: "fence", text: rawLine });
      offset += rawLine.length;
      continue;
    }
    if (inFence) {
      tokens.push({ offset, kind: "code", text: rawLine });
      offset += rawLine.length;
      continue;
    }
    const headingMatch = /^(#{1,6}\s+)(.*)$/.exec(line);
    if (headingMatch) {
      const marker = headingMatch[1] ?? "";
      const rest = headingMatch[2] ?? "";
      tokens.push({ offset, kind: "heading", text: marker });
      tokenizeInline(rest, offset + marker.length, tokens);
      if (lineEnd) {
        tokens.push({
          offset: offset + line.length,
          kind: "plain",
          text: lineEnd,
        });
      }
      offset += rawLine.length;
      continue;
    }
    const checkMatch = /^(\s*[-*+]\s+\[([ xX])\])(.*)$/.exec(line);
    if (checkMatch) {
      const prefix = checkMatch[1] ?? "";
      const done = (checkMatch[2] ?? " ").toLowerCase() === "x";
      const rest = checkMatch[3] ?? "";
      tokens.push({
        offset,
        kind: done ? "checkboxDone" : "checkbox",
        text: prefix,
      });
      tokenizeInline(rest, offset + prefix.length, tokens);
      if (lineEnd) {
        tokens.push({
          offset: offset + line.length,
          kind: "plain",
          text: lineEnd,
        });
      }
      offset += rawLine.length;
      continue;
    }
    if (/^\s*>/.test(line)) {
      tokens.push({ offset, kind: "quote", text: rawLine });
      offset += rawLine.length;
      continue;
    }
    tokenizeInline(rawLine, offset, tokens);
    offset += rawLine.length;
  }
  return tokens;
}

function renderTokens(tokens: Token[]): ReactNode[] {
  return tokens.map((token) =>
    token.kind === "plain" ? (
      <span key={token.offset}>{token.text}</span>
    ) : (
      <span className={`tc-md-tok-${token.kind}`} key={token.offset}>
        {token.text}
      </span>
    ),
  );
}

/**
 * 字符 1:1 对齐的透明 `<textarea>` + `<pre>` 语法高亮覆盖层编辑器。
 * 保证编辑光标、换行与选区零偏移，不引入重型编辑器依赖。
 */
export function MarkdownOverlayEditor({
  value,
  onChange,
  onSave,
  onCancel,
  readOnly = false,
  placeholder,
  ariaLabel = "Markdown 源码编辑器",
  minRows = 12,
}: {
  value: string;
  onChange: (next: string) => void;
  onSave?: () => void;
  onCancel?: () => void;
  readOnly?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  minRows?: number;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const tokens = useMemo(() => tokenizeMarkdownLines(value), [value]);

  function syncScroll(target: HTMLTextAreaElement) {
    const pre = preRef.current;
    if (!pre) return;
    pre.scrollTop = target.scrollTop;
    pre.scrollLeft = target.scrollLeft;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!readOnly) onSave?.();
      return;
    }
    if (event.key === "Escape") {
      onCancel?.();
    }
  }

  return (
    <div
      className="tc-md-overlay"
      style={{ minHeight: `${Math.max(8, minRows) * 1.65 + 1.5}em` }}
    >
      <pre aria-hidden="true" className="tc-md-overlay-pre" ref={preRef}>
        <code>
          {renderTokens(tokens)}
          {"\n"}
        </code>
      </pre>
      <textarea
        aria-label={ariaLabel}
        className="tc-md-overlay-input"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onScroll={(event) => syncScroll(event.currentTarget)}
        placeholder={placeholder}
        readOnly={readOnly}
        spellCheck={false}
        value={value}
      />
    </div>
  );
}
