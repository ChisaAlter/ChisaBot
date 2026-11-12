/**
 * 官方 ACP（Agent Client Protocol）Registry 索引拉取、缓存与搜索。
 *
 * 数据源：https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
 * 当网络不可达或超时时，优雅回退到内置的常见 ACP 智能体目录兜底，绝不阻塞设置界面。
 */

import type { AcpRegistryEntry } from "../../../shared/agent-providers";

const ACP_REGISTRY_URL =
  process.env.CHISABOT_ACP_REGISTRY_URL ||
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const CACHE_TTL_MS = 15 * 60_000;

export const FALLBACK_ACP_REGISTRY: readonly AcpRegistryEntry[] = [
  {
    id: "codebuddy",
    name: "Codebuddy Code",
    version: "2.182.0",
    description:
      "腾讯 Codebuddy 智能编码 CLI，原生支持 ACP 协议会话与工作区编辑。",
    vendor: "Tencent",
    homepage: "https://www.codebuddy.ai",
    iconUrl: null,
    launcher: "npx",
    packageSpec: "@tencent-ai/codebuddy-code",
    args: ["--acp"],
  },
  {
    id: "devin",
    name: "Devin",
    version: null,
    description: "Cognition 自主软件工程智能体（ACP 协议接入）。",
    vendor: "Cognition",
    homepage: "https://devin.ai",
    iconUrl: null,
    launcher: "binary",
    packageSpec: null,
    args: ["acp"],
  },
  {
    id: "claude-code-acp",
    name: "Claude Code (ACP Adapter)",
    version: null,
    description: "通过 Zed / ACP 适配器以标准 ACP 协议驱动 Claude Code。",
    vendor: "Zed / Anthropic",
    homepage: "https://agentclientprotocol.com",
    iconUrl: null,
    launcher: "npx",
    packageSpec: "@zed-industries/claude-code-acp",
    args: [],
  },
  {
    id: "codex-acp",
    name: "Codex (ACP Adapter)",
    version: null,
    description: "通过标准 ACP 适配器驱动 OpenAI Codex。",
    vendor: "Zed / OpenAI",
    homepage: "https://agentclientprotocol.com",
    iconUrl: null,
    launcher: "npx",
    packageSpec: "@zed-industries/codex-acp",
    args: [],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI (ACP)",
    version: null,
    description: "Google Gemini CLI 原生 `--experimental-acp` 模式。",
    vendor: "Google",
    homepage: "https://github.com/google-gemini/gemini-cli",
    iconUrl: null,
    launcher: "npx",
    packageSpec: "@google/gemini-cli",
    args: ["--experimental-acp"],
  },
  {
    id: "goose",
    name: "Goose",
    version: null,
    description: "Block 开源可扩展开发智能体，支持 `goose acp` 模式。",
    vendor: "Block",
    homepage: "https://block.github.io/goose/",
    iconUrl: null,
    launcher: "binary",
    packageSpec: null,
    args: ["acp"],
  },
  {
    id: "openhands",
    name: "OpenHands",
    version: null,
    description: "开源自主软件开发智能体（uvx Python 分发，支持 ACP）。",
    vendor: "All Hands AI",
    homepage: "https://www.all-hands.dev",
    iconUrl: null,
    launcher: "uvx",
    packageSpec: "openhands",
    args: ["acp"],
  },
];

type RawRegistryAgent = {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  description?: unknown;
  authors?: unknown;
  repository?: unknown;
  homepage?: unknown;
  icon?: unknown;
  distribution?: {
    npx?: { package?: unknown; args?: unknown; env?: unknown };
    uvx?: { package?: unknown; args?: unknown; env?: unknown };
    binary?: Record<
      string,
      { archive?: unknown; cmd?: unknown; args?: unknown }
    >;
  };
};

function normalizeRawAgent(raw: RawRegistryAgent): AcpRegistryEntry | null {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const name =
    typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
  const version =
    typeof raw.version === "string" && raw.version.trim()
      ? raw.version.trim()
      : null;
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  const vendor = Array.isArray(raw.authors)
    ? raw.authors.filter((a) => typeof a === "string").join(", ") || null
    : typeof raw.authors === "string"
      ? raw.authors
      : null;
  const homepage =
    typeof raw.homepage === "string"
      ? raw.homepage
      : typeof raw.repository === "string"
        ? raw.repository
        : null;
  const iconUrl = typeof raw.icon === "string" ? raw.icon : null;

  const dist = raw.distribution ?? {};
  if (dist.npx && typeof dist.npx.package === "string") {
    const args = Array.isArray(dist.npx.args) ? dist.npx.args.map(String) : [];
    const envHints =
      dist.npx.env && typeof dist.npx.env === "object"
        ? Object.keys(dist.npx.env as Record<string, unknown>)
        : undefined;
    return {
      id,
      name,
      version,
      description,
      vendor,
      homepage,
      iconUrl,
      launcher: "npx",
      packageSpec: dist.npx.package,
      args,
      envHints,
    };
  }
  if (dist.uvx && typeof dist.uvx.package === "string") {
    const args = Array.isArray(dist.uvx.args) ? dist.uvx.args.map(String) : [];
    const envHints =
      dist.uvx.env && typeof dist.uvx.env === "object"
        ? Object.keys(dist.uvx.env as Record<string, unknown>)
        : undefined;
    return {
      id,
      name,
      version,
      description,
      vendor,
      homepage,
      iconUrl,
      launcher: "uvx",
      packageSpec: dist.uvx.package,
      args,
      envHints,
    };
  }
  let binArgs: string[] = [];
  if (dist.binary && typeof dist.binary === "object") {
    const first = Object.values(dist.binary)[0];
    if (first && Array.isArray(first.args)) {
      binArgs = first.args.map(String);
    }
  }
  return {
    id,
    name,
    version,
    description,
    vendor,
    homepage,
    iconUrl,
    launcher: "binary",
    packageSpec: null,
    args: binArgs,
  };
}

let cachedEntries: AcpRegistryEntry[] | null = null;
let cachedAt = 0;

export async function listAcpRegistryEntries(options?: {
  query?: string;
  refresh?: boolean;
  offlineOnly?: boolean;
}): Promise<{ entries: AcpRegistryEntry[]; fromRemote: boolean }> {
  const now = Date.now();
  let entries = cachedEntries;
  let fromRemote = entries !== null;

  if (
    !options?.offlineOnly &&
    (!entries || options?.refresh || now - cachedAt > CACHE_TTL_MS)
  ) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(ACP_REGISTRY_URL, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const json = (await res.json()) as { agents?: RawRegistryAgent[] };
        if (Array.isArray(json.agents) && json.agents.length > 0) {
          const parsed = json.agents
            .map(normalizeRawAgent)
            .filter((item): item is AcpRegistryEntry => item !== null);
          // 合并内置条目中尚未被远端覆盖的常用项
          const byId = new Map(parsed.map((item) => [item.id, item]));
          for (const fb of FALLBACK_ACP_REGISTRY) {
            if (!byId.has(fb.id)) byId.set(fb.id, fb);
          }
          entries = [...byId.values()];
          cachedEntries = entries;
          cachedAt = now;
          fromRemote = true;
        }
      }
    } catch {
      // 网络离线或超时，静默使用缓存或内置目录
    }
  }

  const finalEntries = entries ?? [...FALLBACK_ACP_REGISTRY];
  const q = options?.query?.trim().toLowerCase();
  if (!q) {
    return { entries: finalEntries, fromRemote };
  }
  return {
    entries: finalEntries.filter(
      (item) =>
        item.id.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        (item.vendor?.toLowerCase().includes(q) ?? false) ||
        (item.packageSpec?.toLowerCase().includes(q) ?? false),
    ),
    fromRemote,
  };
}
