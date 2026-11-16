import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/*
 * AGENTS.md：依赖方向只有一条 app → shared ← server（agent-computer 同走 shared）。三个 surface
 * 的源码互不 import——2026-11 审查抓到多处违规（server 测试 import app/src/lib/chat/*、server 生产
 * 代码 import type agent-computer/src/egress），在此之前这条规则没有任何机器检查。
 *
 * 判断方法：把 import / export … from / require 的 specifier 按相对路径解析回仓库根，落在另一个
 * surface 的顶层目录就算违规；裸包名（node:*、@/、npm 包）不看。pc/ 与 runtime/ 是独立运行时，
 * 不在此列。
 *
 * 唯一的合法例外是测试文件按真声明 pin 契约——名单按「文件 → specifier」逐条写原因；契约本身能挪
 * shared 的就挪（chat-bubbles / chat-origin / egress-policy 都是这么过来的），挪不动的才进名单。
 */
const ALLOWED: Record<string, Record<string, string>> = {
  "app/tests/agent-api-path.test.ts": {
    "../../server/src/agents/profile-store":
      "挂真 profile store + 路由测 API 路径契约",
    "../../server/src/agents/profile-types": "同上",
    "../../server/src/agents/routes": "同上",
  },
  "app/tests/agent-dialog-built-in-edit.test.tsx": {
    "../../server/src/agents/profile-store":
      "挂真 profile store + 路由测内建编辑契约",
    "../../server/src/agents/profile-types": "同上",
    "../../server/src/agents/routes": "同上",
  },
  "app/tests/brokered-account-row.test.tsx": {
    "../../server/src/plugins/store":
      "BROKERED_PROBE_OUTCOMES 是双向 pin 的运行时名单（store.ts 头注），测试按真声明数数防漂移",
  },
  "app/tests/connection-fields.test.tsx": {
    "../../server/src/plugins/broker":
      "BROKER_FIELD_KEYS 是双向 pin 的运行时名单（broker.ts 注释），测试按真声明数数防漂移",
  },
  "server/tests/agent-model-policy.test.ts": {
    "../../app/src/lib/chat/session-client":
      "用真 ConversationSession 当测试对端",
  },
  "server/tests/approvals-frontend.test.ts": {
    "../../app/src/lib/conversations/approval-context":
      "验收流要过真 approval context",
  },
  "server/tests/formal-computer-takeover.test.ts": {
    "../../agent-computer/src/control":
      "BFS 形式化模型检验直接驱动真 createControl 与 canBotAct 对齐状态机",
  },
  "server/tests/untrusted-content.test.ts": {
    "../../app/src/lib/plugins/tool-result":
      "信封格式双端各自声明（tool-result.ts 头注），靠这个测试对齐两份",
  },
  "shared/reply-sources.test.ts": {
    "../server/src/generative-ui/render-ui":
      "验证 reply-sources 指引与 server 工具定义一致",
  },
};

const ROOT = path.join(import.meta.dir, "../..");
const SURFACES = ["app", "server", "agent-computer", "shared"] as const;
const SKIP_DIRS = new Set(["node_modules", ".tanstack", "dist", ".git"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

function surfaceOf(file: string): string | null {
  const top = path.relative(ROOT, file).split(/[\\/]/)[0] ?? "";
  return (SURFACES as readonly string[]).includes(top) ? top : null;
}

function specifiersOf(source: string): string[] {
  return [...source.matchAll(SPECIFIER)]
    .map((match) => match[1])
    .filter((spec): spec is string => Boolean(spec?.startsWith(".")));
}

test("surface 之间互不 import：app / server / agent-computer / shared 只许进 shared", () => {
  const offenders: string[] = [];
  for (const surface of SURFACES) {
    for (const file of files(path.join(ROOT, surface))) {
      const rel = path.relative(ROOT, file).replaceAll("\\", "/");
      const allowed = ALLOWED[rel] ?? {};
      for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
        const target = surfaceOf(path.resolve(path.dirname(file), spec));
        if (
          target &&
          target !== surface &&
          target !== "shared" &&
          !(spec in allowed)
        ) {
          offenders.push(`${rel} → ${spec}（跨进 ${target}/）`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("白名单不过期：名单里的 specifier 必须仍然是那个文件的真 import", () => {
  const stale: string[] = [];
  for (const [rel, specs] of Object.entries(ALLOWED)) {
    let source = "";
    try {
      source = readFileSync(path.join(ROOT, rel), "utf8");
    } catch {
      stale.push(`${rel}（文件不存在）`);
      continue;
    }
    const present = new Set(specifiersOf(source));
    for (const spec of Object.keys(specs)) {
      if (!present.has(spec)) stale.push(`${rel} → ${spec}`);
    }
  }
  expect(stale).toEqual([]);
});
