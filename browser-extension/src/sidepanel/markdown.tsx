import type { ReactNode } from "react";

/**
 * 零 dangerouslySetInnerHTML 的安全轻量 Markdown 渲染器（用于 Side Panel 流式气泡）。
 */

function renderInline(text: string, prefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenRe =
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = tokenRe.exec(text);

  while (match !== null) {
    const start = match.index;
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }
    const token = match[0];
    const key = `${prefix}-${start}`;

    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (match[2] && match[3]) {
      nodes.push(
        <a key={key} href={match[3]} target="_blank" rel="noopener noreferrer">
          {match[2]}
        </a>,
      );
    } else {
      nodes.push(token);
    }

    lastIndex = start + token.length;
    match = tokenRe.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

interface ListEntry {
  key: string;
  text: string;
}

interface Block {
  key: string;
  kind: "code" | "paragraph" | "list" | "quote";
  lines: string[];
  items?: ListEntry[];
  lang?: string;
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const start = i;
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({
        key: `code-${start}`,
        kind: "code",
        lines: codeLines,
        lang,
      });
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const start = i;
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test((lines[i] ?? "").trim())) {
        quoteLines.push((lines[i] ?? "").trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({
        key: `quote-${start}`,
        kind: "quote",
        lines: quoteLines,
      });
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const start = i;
      const items: ListEntry[] = [];
      while (i < lines.length && /^[-*+]\s+/.test((lines[i] ?? "").trim())) {
        const text = (lines[i] ?? "").trim().replace(/^[-*+]\s+/, "");
        items.push({ key: `li-${i}`, text });
        i += 1;
      }
      blocks.push({
        key: `list-${start}`,
        kind: "list",
        lines: [],
        items,
      });
      continue;
    }

    const start = i;
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = (lines[i] ?? "").trim();
      if (
        !cur ||
        cur.startsWith("```") ||
        /^>\s?/.test(cur) ||
        /^[-*+]\s+/.test(cur)
      ) {
        break;
      }
      paraLines.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({
      key: `p-${start}`,
      kind: "paragraph",
      lines: paraLines,
    });
  }

  return blocks;
}

export function SimpleMarkdown({ content }: { content: string }) {
  const blocks = parseBlocks(content);
  return (
    <div className="sp-md">
      {blocks.map((block) => {
        if (block.kind === "code") {
          return (
            <pre key={block.key} data-lang={block.lang || undefined}>
              <code>{block.lines.join("\n")}</code>
            </pre>
          );
        }
        if (block.kind === "quote") {
          return (
            <blockquote key={block.key}>
              {renderInline(block.lines.join(" "), block.key)}
            </blockquote>
          );
        }
        if (block.kind === "list") {
          return (
            <ul key={block.key}>
              {(block.items ?? []).map((entry) => (
                <li key={entry.key}>{renderInline(entry.text, entry.key)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={block.key}>
            {renderInline(block.lines.join("\n"), block.key)}
          </p>
        );
      })}
    </div>
  );
}
