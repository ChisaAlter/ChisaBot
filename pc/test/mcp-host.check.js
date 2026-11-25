"use strict";

/**
 * PC 端 `pc/src/agent/mcp-host.js` 升级回归测试：
 * 1. `StderrRingBuffer` 64 KiB 尾部环形日志滚动保留与 UTF-8 边界防乱码；
 * 2. `callLocalMcp` 长日志崩溃时在错误信息中保留尾部关键报错；
 * 3. `stripJsonCommentsAndBom` UTF-8 BOM + JSONC 注释 + 尾逗号剥离且不破坏字符串字面量；
 * 4. `discoverLocalMcpConfigs` 变量展开、未解析占位符 `needsConfig` 标记、多键名/多 URL 字段兼容、
 *    工作区 `mcp.json` 与 `~/.claude.json` `projects[workspaceDir].mcpServers` 扫描，以及 symlink/realpath 边界拦截。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_STDERR_BYTES,
  StderrRingBuffer,
  stripJsonCommentsAndBom,
  extractEntriesFromConfig,
  callLocalMcp,
  discoverLocalMcpConfigs,
} = require("../src/agent/mcp-host");

test("StderrRingBuffer: 保留尾部最新字节、记录截断标记并跳过被切断的 UTF-8 续字节", () => {
  assert.equal(MAX_STDERR_BYTES, 64 * 1024);

  const small = new StderrRingBuffer(32);
  small.append("hello ");
  small.append("world");
  assert.equal(small.truncated, false);
  assert.equal(small.bytes, 11);
  assert.equal(small.toString(), "hello world");

  // 超过上限时滚动丢弃头部，保留尾部
  const ring = new StderrRingBuffer(16);
  ring.append("0123456789");
  ring.append("ABCDEFGHIJ");
  assert.equal(ring.truncated, true);
  assert.equal(ring.bytes, 16);
  assert.equal(ring.droppedBytes, 4);
  assert.equal(ring.toString(), "456789ABCDEFGHIJ");

  // 多字节 UTF-8 汉字（每字 3 字节）在缓冲区头被切断时不应输出乱码替换符 \uFFFD
  const utf8Ring = new StderrRingBuffer(7);
  utf8Ring.append(Buffer.from("一二三四", "utf8")); // 12 字节，留后 7 字节，首字必被切断
  assert.equal(utf8Ring.truncated, true);
  const out = utf8Ring.toString();
  assert.equal(out.includes("\uFFFD"), false);
  assert.ok(out.endsWith("三四"));
});

test("callLocalMcp: 子进程输出超过 64 KiB stderr 后崩溃，报错保留尾部关键日志", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-mcp-stderr-"));
  try {
    const crashScript = path.join(workDir, "noisy-crash.js");
    fs.writeFileSync(
      crashScript,
      `
const filler = "INFO startup noise line 0123456789abcdef\\n".repeat(2200);
process.stderr.write(filler);
process.stderr.write("FATAL_TAIL_CRASH_TOKEN: missing native binding\\n");
process.exit(1);
`,
      "utf8",
    );

    await assert.rejects(
      callLocalMcp({
        command: process.execPath,
        args: [crashScript],
        action: "list_tools",
      }),
      (err) => {
        assert.match(err.message, /stderr 已滚动截断，保留尾部/);
        assert.match(
          err.message,
          /FATAL_TAIL_CRASH_TOKEN: missing native binding/,
        );
        return true;
      },
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("stripJsonCommentsAndBom: 支持 UTF-8 BOM、单/多行注释与尾逗号且不破坏字符串字面量", () => {
  const jsonc =
    "\uFEFF" +
    `{
      // 单行注释
      "url": "https://example.com/a//b/*not-comment*/",
      "text": "keep \\"quote\\", } and [1, ] inside string",
      /* 多行
         注释 */
      "items": [
        "one",
        "two", // 行尾注释
      ],
    }`;

  const stripped = stripJsonCommentsAndBom(jsonc);
  const parsed = JSON.parse(stripped);
  assert.equal(parsed.url, "https://example.com/a//b/*not-comment*/");
  assert.equal(parsed.text, 'keep "quote", } and [1, ] inside string');
  assert.deepEqual(parsed.items, ["one", "two"]);
});

const ph = (name) => ["$", "{", name, "}"].join("");

test("extractEntriesFromConfig & discoverLocalMcpConfigs: 变量展开、needsConfig 脱敏、多格式字段、新扫描源与边界防护", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbla-mcp-disc-"));
  try {
    const homeDir = path.join(rootDir, "home");
    const appDataDir = path.join(rootDir, "appdata");
    const workspaceDir = path.join(rootDir, "my-workspace");
    const outsideDir = path.join(rootDir, "outside-secret");

    fs.mkdirSync(path.join(homeDir, ".cursor"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, ".cursor"), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    // 1. 工作区根目录 mcp.json：BOM + JSONC 注释 + 尾逗号 + mcp_servers + ${workspaceFolder} / ${workspaceFolderBasename}
    fs.writeFileSync(
      path.join(workspaceDir, "mcp.json"),
      "\uFEFF" +
        `{
          // 工作区根配置
          "mcp_servers": {
            "wsTool": {
              "command": "\${workspaceFolder}/bin/mcp-bin",
              "args": ["--name", "\${workspaceFolderBasename}", "--endpoint", "https://api.example.com/v1//x"],
              "env": { "WS_ROOT": "\${workspaceFolder}" },
            },
          },
        }`,
      "utf8",
    );

    // 2. 工作区 .cursor/mcp.json：含未解析占位符 ${env:API_KEY} + sseUrl + headers 秘钥脱敏
    fs.writeFileSync(
      path.join(workspaceDir, ".cursor", "mcp.json"),
      JSON.stringify({
        servers: {
          sseNeedsEnv: {
            sseUrl: `https://user:rawpass@sse.example.com/events?token=${ph("env:SSE_TOKEN")}`,
            headers: {
              Authorization: `Bearer ${ph("input:apiToken")}`,
              "X-Static-Key": "real-header-secret-xyz",
            },
          },
          httpUrlServer: {
            httpUrl: "https://http.example.com/mcp?key=real-query-secret",
          },
          serverUrlServer: {
            serverUrl: "https://srv.example.com/rpc",
            env: {
              PLAIN_TOKEN: "real-env-secret-abc",
              MISSING_ENV: ph("env:FOO"),
            },
          },
        },
      }),
      "utf8",
    );

    // 3. ~/.claude.json：包含全局 mcpServers 与 projects[workspaceDir].mcpServers（同时包含另一个不相关项目）
    fs.writeFileSync(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          claudeGlobal: {
            command: "npx",
            args: ["-y", "global-mcp"],
          },
        },
        projects: {
          [workspaceDir]: {
            mcpServers: {
              claudeProjectTool: {
                command: "node",
                args: [`${ph("workspaceFolder")}/scripts/proj-mcp.js`],
              },
            },
          },
          [path.join(rootDir, "other-project")]: {
            mcpServers: {
              unrelatedTool: {
                command: "npx",
                args: ["should-not-appear"],
              },
            },
          },
        },
      }),
      "utf8",
    );

    // 4. 边界防护：工作区外敏感配置 + 构造目录联接/符号链接尝试逃逸 workspaceDir
    const outsideConfig = path.join(outsideDir, "mcp.json");
    fs.writeFileSync(
      outsideConfig,
      JSON.stringify({
        mcpServers: {
          escapedEvil: { command: "evil-cmd" },
        },
      }),
      "utf8",
    );

    let junctionCreated = false;
    try {
      fs.symlinkSync(
        outsideDir,
        path.join(workspaceDir, ".vscode"),
        process.platform === "win32" ? "junction" : "dir",
      );
      junctionCreated = true;
    } catch {
      // 无符号链接权限时跳过目录联接测试
    }

    let fileSymlinkCreated = false;
    const symlinkTarget = path.join(outsideDir, "cursor-target.json");
    fs.writeFileSync(
      symlinkTarget,
      JSON.stringify({
        mcpServers: { symlinkEvil: { command: "evil-symlink" } },
      }),
      "utf8",
    );
    try {
      fs.symlinkSync(symlinkTarget, path.join(homeDir, ".cursor", "mcp.json"));
      fileSymlinkCreated = true;
    } catch {
      // 无文件符号链接权限时跳过
    }

    const result = await discoverLocalMcpConfigs({
      homeDir,
      appDataDir,
      platform: process.platform,
      workspaceDir,
    });

    const serialized = JSON.stringify(result);
    // 绝不回传任何真实秘钥值
    assert.equal(serialized.includes("rawpass"), false);
    assert.equal(serialized.includes("real-header-secret-xyz"), false);
    assert.equal(serialized.includes("real-query-secret"), false);
    assert.equal(serialized.includes("real-env-secret-abc"), false);

    // 不相关项目与越界 symlink/junction 不得被发现
    assert.equal(serialized.includes("unrelatedTool"), false);
    if (junctionCreated) {
      assert.equal(serialized.includes("escapedEvil"), false);
    }
    if (fileSymlinkCreated) {
      assert.equal(serialized.includes("symlinkEvil"), false);
    }

    const byName = Object.fromEntries(result.servers.map((s) => [s.name, s]));

    // 验证工作区 mcp.json 与变量展开
    assert.equal(byName.wsTool.source, "workspace");
    assert.equal(byName.wsTool.command, `${workspaceDir}/bin/mcp-bin`);
    assert.deepEqual(byName.wsTool.args, [
      "--name",
      "my-workspace",
      "--endpoint",
      "https://api.example.com/v1//x",
    ]);
    assert.equal(byName.wsTool.needsConfig, undefined);

    // 验证 sseUrl / httpUrl / serverUrl 与 needsConfig 标记
    assert.equal(byName.sseNeedsEnv.transport, "http");
    assert.equal(byName.sseNeedsEnv.needsConfig, true);
    assert.ok(
      byName.sseNeedsEnv.url.startsWith("https://sse.example.com/events"),
    );
    assert.ok(byName.sseNeedsEnv.url.includes("token=***"));
    assert.deepEqual(byName.sseNeedsEnv.headerKeys, [
      "Authorization",
      "X-Static-Key",
    ]);

    assert.equal(byName.httpUrlServer.transport, "http");
    assert.equal(byName.httpUrlServer.needsConfig, undefined);
    assert.ok(byName.httpUrlServer.url.includes("key=***"));

    assert.equal(byName.serverUrlServer.transport, "http");
    assert.equal(byName.serverUrlServer.needsConfig, true);
    assert.deepEqual(byName.serverUrlServer.envKeys, [
      "PLAIN_TOKEN",
      "MISSING_ENV",
    ]);

    // 验证 ~/.claude.json 全局与 projects[workspaceDir].mcpServers
    assert.equal(byName.claudeGlobal.source, "claude-code");
    assert.equal(byName.claudeProjectTool.source, "claude-code");
    assert.deepEqual(byName.claudeProjectTool.args, [
      `${workspaceDir}/scripts/proj-mcp.js`,
    ]);

    // 验证无 workspaceDir 时，${workspaceFolder} 无法展开也应标记 needsConfig: true
    const withoutWs = extractEntriesFromConfig(
      "workspace",
      {
        mcpServers: {
          needsWs: { command: `${ph("workspaceFolder")}/bin/run` },
        },
      },
      {},
    );
    assert.equal(withoutWs[0].needsConfig, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
