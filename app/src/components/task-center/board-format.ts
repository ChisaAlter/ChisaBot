import {
  type FenceState,
  parseCheckboxLine,
  updateFenceState,
} from "../../../../shared/markdown-syntax";
import {
  type MarkdownBoardCard,
  TASK_BOARD_COLUMN_LABELS,
  TASK_HORIZON_LABELS,
} from "../../../../shared/task-board-core";

const TECHNICAL_ACRONYMS = new Set([
  "API",
  "HTTP",
  "HTTPS",
  "URL",
  "URI",
  "SQL",
  "JSON",
  "HTML",
  "CSS",
  "DOM",
  "CLI",
  "GUI",
  "SDK",
  "SSH",
  "TLS",
  "SSL",
  "JWT",
  "OIDC",
  "SAML",
  "SCIM",
  "RBAC",
  "CORS",
  "CSRF",
  "SSRF",
  "XSS",
  "CSP",
  "E2E",
  "LLM",
  "MCP",
  "DSH",
  "UI",
  "UX",
  "UTF",
  "SHA",
  "AES",
  "RSA",
  "HMAC",
  "UUID",
  "CRLF",
  "YAML",
  "TOML",
  "WEBP",
  "JSONL",
  "REST",
  "GRPC",
  "OAUTH",
  "PKCE",
  "TOTP",
  "PASSKEY",
  "SMTP",
  "IMAP",
  "POP3",
  "IPV4",
  "IPV6",
  "CIDR",
  "VLAN",
  "NVME",
  "SIMD",
  "WASM",
  "WASI",
  "WEBGL",
  "WEBGPU",
]);

const DESHOUT_RUN_RE =
  /(?<![A-Za-z0-9_-])[A-Z]{4,}(?:\s+[A-Z]{4,})*(?![A-Za-z0-9_-])/g;

/**
 * 展示层 deshout：将 Markdown 文本中连续全大写英文单词柔化为句首大写，
 * 保留白名单技术缩写原样（只影响界面展示，不改写原始文件）。
 */
export function normalizeMarkdownDeshout(text: string): string {
  return text.replace(DESHOUT_RUN_RE, (run) => {
    const parts = run.split(/(\s+)/);
    let seenNonAcronymWord = false;
    return parts
      .map((part) => {
        if (/^\s+$/.test(part) || !part) return part;
        if (TECHNICAL_ACRONYMS.has(part)) return part;
        if (!seenNonAcronymWord) {
          seenNonAcronymWord = true;
          return `${part.charAt(0)}${part.slice(1).toLowerCase()}`;
        }
        return part.toLowerCase();
      })
      .join("");
  });
}

const KV_COLON_INSIDE_BOLD_RE =
  /^\s*(?:[-*+]\s+)?\*\*([^*:：\r\n]+?)[:：]\*\*\s*(.+)$/;
const KV_COLON_OUTSIDE_BOLD_RE =
  /^\s*(?:[-*+]\s+)?\*\*([^*:：\r\n]+?)\*\*\s*[:：]\s*(.+)$/;

/** 从 Markdown 单行提取 `**Key:** Value` 或 `**Key**: Value` 规格键值对。 */
export function extractMarkdownKvSpec(
  line: string,
): { key: string; value: string } | null {
  const match =
    KV_COLON_INSIDE_BOLD_RE.exec(line) ?? KV_COLON_OUTSIDE_BOLD_RE.exec(line);
  const key = match?.[1]?.trim() ?? "";
  const value = match?.[2]?.trim() ?? "";
  if (!key || !value) return null;
  return { key, value };
}

export type BodyElement =
  | { kind: "heading"; key: number; level: number; text: string }
  | {
      kind: "checkbox";
      key: number;
      checkboxIndex: number;
      checked: boolean;
      text: string;
    }
  | { kind: "code"; key: number; content: string }
  | { kind: "quote"; key: number; text: string }
  | { kind: "paragraph"; key: number; text: string };

/** 将卡片正文拆分为规格胶囊与有序 Markdown 展示元素，保证复选框序号与服务端一致。 */
export function parseCardBodyForView(body: string): {
  specs: Array<{ id: string; key: string; value: string }>;
  elements: BodyElement[];
} {
  const lines = body.split(/\r\n|\r|\n/);
  const specs: Array<{ id: string; key: string; value: string }> = [];
  const seenSpecKeys = new Map<string, number>();
  const elements: BodyElement[] = [];
  let checkboxIndex = 0;
  let fence: FenceState = null;
  let codeLines: string[] = [];
  let codeStartLine = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const nextFence = updateFenceState(line, fence);
    if (!fence && nextFence) {
      fence = nextFence;
      codeLines = [];
      codeStartLine = i;
      continue;
    }
    if (fence && !nextFence) {
      elements.push({
        kind: "code",
        key: codeStartLine,
        content: codeLines.join("\n"),
      });
      fence = null;
      codeLines = [];
      continue;
    }
    if (fence) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) continue;
    const kv = extractMarkdownKvSpec(line);
    if (kv && specs.length < 10) {
      const occ = (seenSpecKeys.get(kv.key) ?? 0) + 1;
      seenSpecKeys.set(kv.key, occ);
      specs.push({
        id: occ === 1 ? kv.key : `${kv.key}#${occ}`,
        key: kv.key,
        value: kv.value,
      });
      continue;
    }
    const checkbox = parseCheckboxLine(line);
    if (checkbox) {
      const idx = checkboxIndex;
      checkboxIndex += 1;
      elements.push({
        kind: "checkbox",
        key: i,
        checkboxIndex: idx,
        checked: checkbox.checked,
        text: normalizeMarkdownDeshout(checkbox.label),
      });
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch?.[1] && headingMatch[2]) {
      elements.push({
        kind: "heading",
        key: i,
        level: headingMatch[1].length,
        text: normalizeMarkdownDeshout(headingMatch[2].trim()),
      });
      continue;
    }
    if (/^\s*>/.test(line)) {
      elements.push({
        kind: "quote",
        key: i,
        text: normalizeMarkdownDeshout(line.replace(/^\s*>\s?/, "")),
      });
      continue;
    }
    elements.push({
      kind: "paragraph",
      key: i,
      text: normalizeMarkdownDeshout(line),
    });
  }
  if (fence && codeLines.length > 0) {
    elements.push({
      kind: "code",
      key: codeStartLine,
      content: codeLines.join("\n"),
    });
  }
  return { specs, elements };
}

export function buildBoardCardChatPrompt(card: MarkdownBoardCard): string {
  const snippet = card.body.replace(/\s+/g, " ").trim().slice(0, 600);
  return [
    `请帮我讨论并推进任务看板卡片 [${card.id}] ${card.title}`,
    `当前列：${TASK_BOARD_COLUMN_LABELS[card.lane]}（原属：${TASK_HORIZON_LABELS[card.filedIn]}）`,
    `来源：${card.sourceFile}:${card.line}`,
    snippet ? `摘要：${snippet}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
