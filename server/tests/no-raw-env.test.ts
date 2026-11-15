import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/*
 * AGENTS.md：新环境变量在 server/src/config.ts 里读和校验（loadConfig 失败即拒启动），不在业务
 * 代码里直接 process.env.X。2026-11 审查时已有 15 个文件在读——它们是存量，原因写在下面的名单；
 * 本测试拦的是名单之外的新裸读，不是逼一次大迁移。要收编存量，把变量接进 DeploymentConfig 后
 * 从名单删掉。
 *
 * 匹配前剥掉块注释；行注释里的 `process.env.X` 也会命中——写注释别用全大写变量名。
 */
const ALLOWED: Record<string, string> = {
  "index.ts": "接线根的存量读法；新变量走 config.ts 的 loadConfig。",
  "conversation-runtime.ts": "模型端点 / 输出上限 / 托管 agent 环境，存量。",
  "local-conversations.ts": "CHISABOT_RELEASE_LOCKS_ON_START 启动开关，存量。",
  "live-panels/service.ts": "CHISABOT_PANEL_* 功能开关，存量。",
  "workers/service.ts": "并发上限的模块作用域常量，存量。",
  "local-agents/service.ts": "超时 / LLM 调用上限，存量。",
  "local-agents/server-host.ts": "CHISABOT_SERVER_AGENT_ROOTS，存量。",
  "local-agents/acp-registry.ts": "CHISABOT_ACP_REGISTRY_URL，存量。",
  "agents/model-fallback.ts": "模型冷却 / 超时调参，存量。",
  "agents/purge.ts": "PROFILES_DIR，存量。",
  "computer/sandbox.ts":
    "KUBERNETES_SERVICE_HOST/PORT 平台探测，不是部署配置。",
  "conversations/maintenance.ts": "CHISABOT_DSH_ROOT，存量。",
  "devices/node-install.ts": "CHISABOT_NODE_BUNDLE 打包路径覆盖，存量。",
  "package-orphans.ts": "CHISABOT_ORPHAN_SWEEP 开关，存量。",
  "db/client.ts":
    "故意 delete 继承来的 DATABASE_URL 再拼连接串——清理环境，不是读配置。",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.ts$/.test(name) && !name.endsWith(".test.ts") ? [full] : [];
  });
}

function envReads(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...code.matchAll(/process\.env\.[A-Za-z_][A-Za-z0-9_]*/g)].map(
    (match) => match[0],
  );
}

test("server/src 的裸 process.env.X 不许超出白名单（新变量进 config.ts）", () => {
  const root = path.join(import.meta.dir, "../src");
  const offenders = files(root)
    .map((file) => ({
      rel: path.relative(root, file).replaceAll("\\", "/"),
      reads: envReads(readFileSync(file, "utf8")),
    }))
    .filter(({ rel, reads }) => !(rel in ALLOWED) && reads.length > 0)
    .map(({ rel, reads }) => `${rel}（${[...new Set(reads)].join("、")}）`);
  expect(offenders).toEqual([]);
});

test("白名单不过期：名单里的文件必须仍然真的在读环境", () => {
  const root = path.join(import.meta.dir, "../src");
  const stale = Object.keys(ALLOWED).filter((rel) => {
    const full = path.join(root, rel);
    try {
      return envReads(readFileSync(full, "utf8")).length === 0;
    } catch {
      return true;
    }
  });
  expect(stale).toEqual([]);
});
