import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  decryptDeviceFrame,
  deriveSessionKey,
  encryptDeviceFrame,
  generateE2eeKeyPair,
  isTailscaleHost,
  isTailscaleOrLanHost,
} from "../../shared/device-e2ee";
import {
  capabilityFor,
  defaultCapabilities,
  OPERATION_LABEL,
  pairingUri,
} from "../../shared/devices";
import { createDeviceHub } from "../src/devices/hub";
import type { DeviceRecord, DeviceStore } from "../src/devices/store";
import { deviceTools } from "../src/devices/tools";
import { mcpServers, mcpTools } from "../src/db/schema/plugins";
import { createPluginStore } from "../src/plugins/store";

const require = createRequire(import.meta.url);
const mcpHost = require("../../pc/src/agent/mcp-host.js") as {
  SHELL_METACHAR_ERROR: string;
  parseCommandArgs: (command: string, explicitArgs?: string[]) => string[];
  sanitizeMcpEnv: (
    baseEnv?: Record<string, string | undefined>,
    extraEnv?: Record<string, string | undefined>,
  ) => Record<string, string>;
  callLocalMcp: (options: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    action?: "list_tools" | "call_tool";
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
    spawnImpl?: unknown;
  }) => Promise<unknown>;
  discoverLocalMcpConfigs: (options?: {
    homeDir?: string;
    appDataDir?: string;
    platform?: string;
    workspaceDir?: string;
  }) => Promise<{
    servers: Array<{
      source: string;
      name: string;
      transport: "stdio" | "http";
      command?: string;
      args?: string[];
      url?: string;
      envKeys: string[];
      headerKeys?: string[];
    }>;
    files: Array<{ source: string; filePath: string }>;
  }>;
};

const pcOpsModule = require("../../pc/src/agent/ops.js") as {
  createOps: (options?: Record<string, unknown>) => {
    features: string[];
    run: (
      operation: string,
      args: Record<string, unknown>,
      ctx?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
};

const pcCoreModule = require("../../pc/src/agent/core.js") as {
  capabilityFor: (
    operation: string,
    args?: Record<string, unknown>,
  ) => string | null | undefined;
  summarize: (operation: string, args?: Record<string, unknown>) => string;
};

const pcAuth = require("../../pc/src/agent/auth.js") as {
  normalizeServerUrl: (input: string) => string;
  isTailscaleOrLanHost: (host: string) => boolean;
  parsePairingUri: (raw: string) => {
    server: string;
    code: string;
    alternates: string[];
    e2eePub: string | null;
  };
  probeWithFallback: (options: {
    serverUrl: string;
    alternates?: string[];
    fetchImpl: typeof fetch;
    timeoutMs?: number;
  }) => Promise<{
    origin: string;
    gateway: boolean;
    authenticated: boolean | null;
  }>;
};

function makeDeviceRecord(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "dev_mcp_1",
    ownerUserId: "u1",
    name: "工作电脑",
    platform: "win32",
    osVersion: "11",
    hostname: "WORKSTATION",
    arch: "x64",
    clientVersion: "0.2.0",
    capabilities: {
      ...defaultCapabilities(),
      shell: "allow",
      files_read: "allow",
    },
    allowedRoots: [],
    paused: false,
    revoked: false,
    lastSeenAt: new Date().toISOString(),
    lastIp: "127.0.0.1",
    createdAt: new Date().toISOString(),
    botIds: [],
    lastUsedBy: null,
    tokenHash: "hash",
    ...overrides,
  };
}

describe("pc/src/agent/mcp-host parseCommandArgs & sanitizeMcpEnv", () => {
  test("parses quoted command strings and explicit args without shell", () => {
    expect(
      mcpHost.parseCommandArgs(
        "npx -y \"@modelcontextprotocol/server-filesystem\" 'D:/work dir'",
      ),
    ).toEqual([
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "D:/work dir",
    ]);

    expect(
      mcpHost.parseCommandArgs(
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\work\\mcp.js"',
      ),
    ).toEqual(["C:\\Program Files\\nodejs\\node.exe", "C:\\work\\mcp.js"]);

    expect(
      mcpHost.parseCommandArgs("C:\\tools\\node.exe", [
        "D:\\mcp\\server.js",
        "--flag=1&2",
      ]),
    ).toEqual(["C:\\tools\\node.exe", "D:\\mcp\\server.js", "--flag=1&2"]);
  });

  test("rejects unquoted or dangerous shell metacharacters", () => {
    const dangerousInputs = [
      "npx foo; rm -rf /",
      "npx foo | cat",
      "npx foo && whoami",
      "npx foo > /tmp/out",
      "npx foo < /etc/passwd",
      "npx foo \\ bar",
      "npx $(whoami)",
      "npx `id`",
      'npx "$(whoami)"',
      'npx "`id`"',
      "npx foo\necho bar",
    ];
    for (const bad of dangerousInputs) {
      expect(() => mcpHost.parseCommandArgs(bad)).toThrow(
        mcpHost.SHELL_METACHAR_ERROR,
      );
    }
    expect(() => mcpHost.parseCommandArgs("   ")).toThrow();
    expect(() => mcpHost.parseCommandArgs("node", [""])).not.toThrow();
    expect(() => mcpHost.parseCommandArgs("node; rm", ["server.js"])).toThrow(
      mcpHost.SHELL_METACHAR_ERROR,
    );
  });

  test("whitelists base env and strips CHISABOT_* and dynamic injection keys", () => {
    const cleaned = mcpHost.sanitizeMcpEnv(
      {
        PATH: "/usr/bin",
        SystemRoot: "C:\\Windows",
        HOME: "/home/tester",
        DATABASE_URL: "postgres://secret@db/prod",
        CHISABOT_GATEWAY_SECRET: "gw-secret",
        CHISABOT_ANYTHING: "val",
        NODE_OPTIONS: "--require evil.js",
        LD_PRELOAD: "/evil.so",
        DYLD_INSERT_LIBRARIES: "/evil.dylib",
        ELECTRON_RUN_AS_NODE: "1",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
      {
        MCP_MODE: "readonly",
        CHISABOT_EXTRA: "must-strip",
        NODE_OPTIONS: "must-strip",
        DATABASE_URL: "must-strip",
        LD_PRELOAD: "must-strip",
        DYLD_INSERT_LIBRARIES: "must-strip",
        ELECTRON_RUN_AS_NODE: "must-strip",
      },
    );

    expect(cleaned.PATH).toBe("/usr/bin");
    expect(cleaned.SystemRoot).toBe("C:\\Windows");
    expect(cleaned.HOME).toBe("/home/tester");
    expect(cleaned.MCP_MODE).toBe("readonly");
    for (const forbidden of [
      "DATABASE_URL",
      "CHISABOT_GATEWAY_SECRET",
      "CHISABOT_ANYTHING",
      "CHISABOT_EXTRA",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "ELECTRON_RUN_AS_NODE",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      expect(cleaned[forbidden]).toBeUndefined();
    }
  });
});

describe("pc/src/agent/mcp-host callLocalMcp & discoverLocalMcpConfigs", () => {
  test("executes real stdio JSON-RPC initialize -> initialized -> list_tools & call_tool with sanitized env and shell:false", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "chisabot-mcp-host-"));
    try {
      const serverScript = path.join(workDir, "fake-mcp-server.js");
      writeFileSync(
        serverScript,
        `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo_env", description: "Reads echo + env check" }] } }) + "\\n");
  } else if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: "ok:" + (msg.params?.arguments?.text || "") }],
        seenSecret: Boolean(process.env.CHISABOT_TEST_SECRET),
        seenSafe: process.env.SAFE_ARG || null,
      },
    }) + "\\n");
  }
});
`,
        "utf8",
      );

      let seenSpawnOpts: Record<string, unknown> | null = null;
      const listRes = (await mcpHost.callLocalMcp({
        command: process.execPath,
        args: [serverScript],
        action: "list_tools",
        spawnImpl: (
          file: string,
          argv: string[],
          opts: Record<string, unknown>,
        ) => {
          seenSpawnOpts = opts;
          const { spawn } = require("node:child_process");
          return spawn(file, argv, opts);
        },
      })) as { tools: Array<{ name: string }> };

      expect(seenSpawnOpts?.shell).toBe(false);
      expect(seenSpawnOpts?.windowsHide).toBe(true);
      expect(listRes.tools.map((t) => t.name)).toEqual(["echo_env"]);

      const callRes = (await mcpHost.callLocalMcp({
        command: process.execPath,
        args: [serverScript],
        action: "call_tool",
        toolName: "echo_env",
        toolArgs: { text: "hello" },
        env: { SAFE_ARG: "ok-val", CHISABOT_TEST_SECRET: "must-not-leak" },
      })) as {
        content: Array<{ text: string }>;
        seenSecret: boolean;
        seenSafe: string | null;
      };

      expect(callRes.content[0]?.text).toBe("ok:hello");
      expect(callRes.seenSecret).toBe(false);
      expect(callRes.seenSafe).toBe("ok-val");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("rejects on timeout or AbortSignal and kills child process", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "chisabot-mcp-timeout-"));
    try {
      const hangScript = path.join(workDir, "hang-mcp.js");
      writeFileSync(hangScript, "setInterval(() => {}, 1000);", "utf8");

      await expect(
        mcpHost.callLocalMcp({
          command: process.execPath,
          args: [hangScript],
          action: "list_tools",
          timeoutMs: 180,
        }),
      ).rejects.toThrow("超时");

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 80);
      await expect(
        mcpHost.callLocalMcp({
          command: process.execPath,
          args: [hangScript],
          action: "list_tools",
          timeoutMs: 5000,
          signal: controller.signal,
        }),
      ).rejects.toThrow("取消");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("discovers standard MCP configs read-only and redacts secrets/headers/query credentials", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "chisabot-mcp-discover-"));
    try {
      const homeDir = path.join(workDir, "home");
      const appDataDir = path.join(workDir, "appdata");
      const workspaceDir = path.join(workDir, "ws");

      mkdirSync(path.join(appDataDir, "Claude"), { recursive: true });
      mkdirSync(path.join(appDataDir, "Code", "User"), { recursive: true });
      mkdirSync(path.join(homeDir, ".cursor"), { recursive: true });
      mkdirSync(path.join(workspaceDir, ".vscode"), { recursive: true });

      writeFileSync(
        path.join(appDataDir, "Claude", "claude_desktop_config.json"),
        JSON.stringify({
          mcpServers: {
            github: {
              command: "npx",
              args: [
                "-y",
                "@modelcontextprotocol/server-github",
                "--token=ghp_supersecret",
              ],
              env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret_12345" },
            },
          },
        }),
        "utf8",
      );

      writeFileSync(
        path.join(homeDir, ".cursor", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            remoteDocs: {
              url: "https://user:pass@mcp.example.com/sse?apiKey=secret_q",
              headers: { Authorization: "Bearer bearer_top_secret" },
            },
          },
        }),
        "utf8",
      );

      // 损坏的 JSON 应当静默跳过，不能阻断其他配置文件发现。
      writeFileSync(
        path.join(appDataDir, "Code", "User", "mcp.json"),
        "{broken json",
        "utf8",
      );

      writeFileSync(
        path.join(workspaceDir, ".vscode", "mcp.json"),
        JSON.stringify({
          servers: {
            localSqlite: {
              command: "uvx",
              args: ["mcp-server-sqlite", "--db", "D:/data/app.db"],
              env: { DB_PASS: "top_secret_pw" },
            },
          },
        }),
        "utf8",
      );

      const result = await mcpHost.discoverLocalMcpConfigs({
        homeDir,
        appDataDir,
        platform: "win32",
        workspaceDir,
      });

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("ghp_secret_12345");
      expect(serialized).not.toContain("ghp_supersecret");
      expect(serialized).not.toContain("bearer_top_secret");
      expect(serialized).not.toContain("secret_q");
      expect(serialized).not.toContain("pass@");
      expect(serialized).not.toContain("top_secret_pw");

      const byName = Object.fromEntries(result.servers.map((s) => [s.name, s]));
      expect(byName.github).toMatchObject({
        source: "claude-desktop",
        transport: "stdio",
        command: "npx",
        envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      });
      expect(byName.github?.args).toContain("--token=***");
      expect(byName.remoteDocs).toMatchObject({
        source: "cursor",
        transport: "http",
        headerKeys: ["Authorization"],
      });
      expect(byName.remoteDocs?.url).toContain("https://mcp.example.com/sse");
      expect(byName.remoteDocs?.url).toContain("apiKey=***");
      expect(byName.localSqlite).toMatchObject({
        source: "vscode-workspace",
        transport: "stdio",
        command: "uvx",
        envKeys: ["DB_PASS"],
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("PC ops/core + hub/tools native MCP vs legacy routing", () => {
  test("shared/devices, pc ops and core advertise mcp feature and capabilities consistently", () => {
    expect(capabilityFor("mcp_call")).toBe("shell");
    expect(capabilityFor("mcp_discover")).toBe("files_read");
    expect(OPERATION_LABEL.mcp_call).toBeTruthy();
    expect(OPERATION_LABEL.mcp_discover).toBeTruthy();

    expect(pcCoreModule.capabilityFor("mcp_call")).toBe("shell");
    expect(pcCoreModule.capabilityFor("mcp_discover")).toBe("files_read");
    expect(
      pcCoreModule.summarize("mcp_call", {
        command: "npx s",
        toolName: "ping",
      }),
    ).toContain("ping");

    const ops = pcOpsModule.createOps();
    expect(ops.features).toContain("mcp");
    expect(ops.features).toContain("mcp_call");
    expect(ops.features).toContain("mcp_discover");
  });

  test("hub tracks hello.features 'mcp' and device_mcp_call routes native vs legacy cleanly", async () => {
    const newDev = makeDeviceRecord({ id: "dev_new", name: "新客户端" });
    const oldDev = makeDeviceRecord({
      id: "dev_old",
      name: "旧客户端",
      clientVersion: "0.1.5",
    });
    const allDevices = [newDev, oldDev];
    const invoked: Array<{
      deviceId: string;
      operation: string;
      args: Record<string, unknown>;
    }> = [];

    const store = {
      get: async (id: string) => allDevices.find((d) => d.id === id) ?? null,
      forOwner: async () => allDevices,
      touch: async () => {},
      audit: async () => {},
    } as unknown as DeviceStore;

    const hub = createDeviceHub({ store });
    const sendMock = () => {};
    const newConn = hub.attach(
      newDev,
      {
        send: sendMock,
        close: () => {},
      },
      "127.0.0.1",
    );
    await newConn.onMessage(
      JSON.stringify({
        type: "hello",
        features: ["shell", "files_read", "mcp", "mcp_call", "mcp_discover"],
      }),
    );
    hub.attach(
      oldDev,
      {
        send: sendMock,
        close: () => {},
      },
      "127.0.0.1",
    );

    expect(hub.supports("dev_new", "mcp_call")).toBe(true);
    expect(hub.supports("dev_new", "mcp_discover")).toBe(true);
    expect(hub.supportsFeature("dev_new", "mcp")).toBe(true);
    expect(hub.supports("dev_old", "mcp_call")).toBe(false);
    expect(hub.supportsFeature("dev_old", "mcp")).toBe(false);

    // 通过 spy hub 校验 tools.ts 对新旧设备的分流路由。
    const spyHub = {
      isOnline: (id: string) => hub.isOnline(id),
      supports: (id: string, op: "mcp_call" | "mcp_discover" | "shell") =>
        hub.supports(id, op),
      supportsFeature: (id: string, f: string) => hub.supportsFeature(id, f),
      invoke: async (input: {
        device: DeviceRecord;
        operation: string;
        args: Record<string, unknown>;
      }) => {
        invoked.push({
          deviceId: input.device.id,
          operation: input.operation,
          args: input.args,
        });
        return { servers: [], ok: true };
      },
    } as unknown as ReturnType<typeof createDeviceHub>;

    const tools = deviceTools({
      store,
      hub: spyHub,
      botId: "bot_1",
      actorId: "u1",
      devices: allDevices,
    });
    const mcpCallTool = tools.find((t) => t.name === "device_mcp_call");
    const mcpDiscoverTool = tools.find((t) => t.name === "device_mcp_discover");
    expect(mcpCallTool).toBeDefined();
    expect(mcpDiscoverTool).toBeDefined();

    await mcpCallTool?.execute({
      deviceId: "dev_new",
      command: "node",
      args: ["server.js"],
      action: "call_tool",
      toolName: "read_notes",
      toolArgs: { q: "x" },
    });
    await mcpCallTool?.execute({
      deviceId: "dev_old",
      command: "npx -y fake-mcp",
      action: "list_tools",
    });
    await mcpDiscoverTool?.execute({
      deviceId: "dev_new",
      workspaceDir: "D:/repo",
    });

    expect(invoked[0]).toEqual({
      deviceId: "dev_new",
      operation: "mcp_call",
      args: {
        command: "node",
        args: ["server.js"],
        action: "call_tool",
        toolName: "read_notes",
        toolArgs: { q: "x" },
      },
    });
    expect(invoked[1]?.deviceId).toBe("dev_old");
    expect(invoked[1]?.operation).toBe("shell");
    expect(invoked[2]).toEqual({
      deviceId: "dev_new",
      operation: "mcp_discover",
      args: { workspaceDir: "D:/repo" },
    });
  });
});

describe("shared/device-e2ee + PC Tailscale/LAN host & fallback", () => {
  test("X25519/HKDF/AES-GCM roundtrip, AAD binding, and strict anti-replay", async () => {
    const alice = await generateE2eeKeyPair();
    const bob = await generateE2eeKeyPair();
    const aliceKey = await deriveSessionKey(
      alice.privateKey,
      bob.publicKey,
      "pair_salt",
    );
    const bobKey = await deriveSessionKey(
      bob.privateKey,
      alice.publicKey,
      "pair_salt",
    );

    const replayState = { maxSeq: 0 };
    const frame1 = await encryptDeviceFrame(
      aliceKey,
      1,
      "dev_1:session_1",
      '{"hello":"world"}',
    );
    const plain1 = await decryptDeviceFrame(
      bobKey,
      replayState,
      "dev_1:session_1",
      frame1,
    );
    expect(plain1).toBe('{"hello":"world"}');
    expect(replayState.maxSeq).toBe(1);

    // 同一序号重放或乱序旧帧必须拒绝。
    await expect(
      decryptDeviceFrame(bobKey, replayState, "dev_1:session_1", frame1),
    ).rejects.toThrow("序号");
    const frame0 = await encryptDeviceFrame(
      aliceKey,
      0,
      "dev_1:session_1",
      "old",
    );
    await expect(
      decryptDeviceFrame(bobKey, replayState, "dev_1:session_1", frame0),
    ).rejects.toThrow("序号");

    // 跨上下文篡改 context 或 seq 必须验签失败且不推进 maxSeq。
    const frame2 = await encryptDeviceFrame(
      aliceKey,
      2,
      "dev_1:session_1",
      "secret",
    );
    await expect(
      decryptDeviceFrame(bobKey, replayState, "dev_2:session_1", frame2),
    ).rejects.toThrow();
    expect(replayState.maxSeq).toBe(1);

    const frame3 = { ...frame2, seq: 3 };
    await expect(
      decryptDeviceFrame(bobKey, replayState, "dev_1:session_1", frame3),
    ).rejects.toThrow();
    expect(replayState.maxSeq).toBe(1);

    // 合法后续帧仍可正常解密。
    const plain2 = await decryptDeviceFrame(
      bobKey,
      replayState,
      "dev_1:session_1",
      frame2,
    );
    expect(plain2).toBe("secret");
    expect(replayState.maxSeq).toBe(2);
  });

  test("identifies Tailscale CGNAT/MagicDNS/LAN hosts and executes PC auth fallback", async () => {
    for (const allowed of [
      "100.64.0.1",
      "100.127.255.254",
      "mac-mini.tail1234.ts.net",
      "192.168.1.20",
      "10.0.0.5",
      "172.16.8.1",
      "localhost",
      "workstation.local",
    ]) {
      expect(isTailscaleOrLanHost(allowed)).toBe(true);
      expect(pcAuth.isTailscaleOrLanHost(allowed)).toBe(true);
    }
    for (const disallowed of [
      "100.63.255.255",
      "100.128.0.1",
      "ts.net.evil.com",
      "example.com",
      "8.8.8.8",
    ]) {
      expect(isTailscaleOrLanHost(disallowed)).toBe(false);
    }
    expect(isTailscaleHost("100.100.100.100")).toBe(true);
    expect(isTailscaleHost("mybox.tail.ts.net")).toBe(true);
    expect(isTailscaleHost("192.168.1.10")).toBe(false);

    expect(pcAuth.normalizeServerUrl("http://100.64.1.2:3000/")).toBe(
      "http://100.64.1.2:3000",
    );
    expect(pcAuth.normalizeServerUrl("mybox.tailnet.ts.net")).toBe(
      "https://mybox.tailnet.ts.net",
    );
    expect(pcAuth.normalizeServerUrl("http://mybox.tailnet.ts.net:3000")).toBe(
      "http://mybox.tailnet.ts.net:3000",
    );
    expect(() => pcAuth.normalizeServerUrl("http://ts.net.evil.com")).toThrow(
      /https/,
    );

    const code = `cbp_${"A".repeat(32)}`;
    const uri = pairingUri("https://public.example:8443", code, {
      alternates: ["https://box.tail.ts.net:8443", "http://100.64.5.6:3000"],
      e2eePub: "A".repeat(43),
    });
    const parsed = pcAuth.parsePairingUri(uri);
    expect(parsed).toEqual({
      server: "https://public.example:8443",
      code,
      alternates: ["https://box.tail.ts.net:8443", "http://100.64.5.6:3000"],
      e2eePub: "A".repeat(43),
    });

    const probed: string[] = [];
    const probeRes = await pcAuth.probeWithFallback({
      serverUrl: parsed.server,
      alternates: parsed.alternates,
      fetchImpl: (async (url: string) => {
        probed.push(url);
        if (url.startsWith("https://public.example:8443")) {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ECONNREFUSED" },
          });
        }
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
    expect(probeRes).toEqual({
      origin: "https://box.tail.ts.net:8443",
      gateway: true,
      authenticated: false,
    });
    expect(probed[0]).toBe("https://public.example:8443/auth/session");
    expect(probed[1]).toBe("https://box.tail.ts.net:8443/auth/session");
  });
});

describe("plugins/store device provenance metadata registration", () => {
  test("registers provenance='device' metadata cleanly without merging grant/policy/audit layers", async () => {
    const serverRows: Array<Record<string, unknown>> = [
      {
        id: "custom-http",
        title: "Custom HTTP",
        logo: null,
        vendor: "mcp.example",
        url: "https://mcp.example/mcp",
        provenance: "custom",
        credentialId: null,
        authScheme: null,
        toolsRefreshedAt: null,
        lastError: null,
        addedBy: "admin",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const toolRows: Array<Record<string, unknown>> = [];
    const auditEvents: Array<Record<string, unknown>> = [];

    // 仅覆盖 registerDeviceMcpServer / listServers / refreshTools 查询链的轻量内存替身。
    const extractParamValues = (expr: unknown): string[] => {
      if (!expr || typeof expr !== "object") return [];
      if (Array.isArray(expr)) {
        const out: string[] = [];
        for (const item of expr) out.push(...extractParamValues(item));
        return out;
      }
      if ("encoder" in expr && "value" in expr) {
        const val = (expr as { value: unknown }).value;
        if (typeof val === "string") return [val];
        if (Array.isArray(val))
          return val.filter((v): v is string => typeof v === "string");
        return [];
      }
      const chunks = (expr as { queryChunks?: unknown[] }).queryChunks;
      if (!Array.isArray(chunks)) return [];
      const out: string[] = [];
      for (const chunk of chunks) {
        out.push(...extractParamValues(chunk));
      }
      return out;
    };

    const makeTx = () => ({
      $client: {
        unsafe: async () => [],
      },
      select: () => {
        let target: unknown = null;
        let filterVals: string[] = [];
        const queryPromise = Promise.resolve().then(() => {
          if (target === mcpServers) {
            return filterVals.length > 0
              ? serverRows.filter((r) => filterVals.includes(String(r.id)))
              : serverRows;
          }
          if (target === mcpTools) {
            return filterVals.length > 0
              ? toolRows.filter((r) => filterVals.includes(String(r.serverId)))
              : toolRows;
          }
          return [];
        });
        const chain = Object.assign(queryPromise, {
          from: (table: unknown) => {
            target = table;
            return chain;
          },
          where: (cond: unknown) => {
            filterVals = extractParamValues(cond);
            return chain;
          },
          orderBy: () => chain,
          limit: () => chain,
        });
        return chain;
      },
      insert: (table: unknown) => ({
        values: (
          vals: Record<string, unknown> | Array<Record<string, unknown>>,
        ) => {
          const list = Array.isArray(vals) ? vals : [vals];
          const applyInsert = () => {
            if (table === mcpServers) {
              for (const row of list) {
                const idx = serverRows.findIndex((r) => r.id === row.id);
                const full = {
                  logo: null,
                  credentialId: null,
                  authScheme: null,
                  toolsRefreshedAt: null,
                  lastError: null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  ...row,
                };
                if (idx >= 0) serverRows[idx] = { ...serverRows[idx], ...full };
                else serverRows.push(full);
              }
            } else if (table === mcpTools) {
              toolRows.push(...list);
            }
          };
          applyInsert();
          return Object.assign(Promise.resolve(), {
            onConflictDoUpdate: (cfg: { set: Record<string, unknown> }) => {
              if (table === mcpServers && list[0]) {
                const idx = serverRows.findIndex((r) => r.id === list[0].id);
                if (idx >= 0) {
                  serverRows[idx] = { ...serverRows[idx], ...cfg.set };
                }
              }
              return Promise.resolve();
            },
          });
        },
      }),
      delete: (table: unknown) => ({
        where: (cond: unknown) => {
          if (table === mcpTools) {
            const ids = extractParamValues(cond);
            if (ids.length === 0) toolRows.length = 0;
            else {
              for (let i = toolRows.length - 1; i >= 0; i -= 1) {
                if (ids.includes(String(toolRows[i]?.serverId))) {
                  toolRows.splice(i, 1);
                }
              }
            }
          }
          return Promise.resolve();
        },
      }),
      transaction: async (
        cb: (tx: ReturnType<typeof makeTx>) => Promise<unknown>,
      ) => cb(makeTx()),
    });

    const database = makeTx() as unknown as Parameters<
      typeof createPluginStore
    >[0]["database"];
    const store = createPluginStore({
      database,
      auditStore: {
        insert: async (ev) => {
          auditEvents.push(ev as unknown as Record<string, unknown>);
        },
      },
      credentials: { readSecret: async () => null },
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    });

    // 不能覆盖已有的 custom 或保留前缀插件。
    await expect(
      store.registerDeviceMcpServer({
        id: "custom-http",
        title: "Conflict",
        deviceId: "dev_1",
        source: "cursor",
        by: "u1",
      }),
    ).rejects.toThrow("custom");

    await expect(
      store.registerDeviceMcpServer({
        id: "composio-gmail",
        title: "Conflict",
        deviceId: "dev_1",
        source: "cursor",
        by: "u1",
      }),
    ).rejects.toThrow("reserved");

    const registered = await store.registerDeviceMcpServer({
      id: "dev-local-notes",
      title: "本地 Notes MCP",
      deviceId: "dev_1",
      source: "cursor",
      url: "https://user:secret@100.64.1.2:9000/mcp?token=leak",
      tools: [
        {
          name: "search_notes",
          description: "搜索本地笔记",
          inputSchema: { type: "object" },
        },
      ],
      by: "u1",
    });

    expect(registered.provenance).toBe("device");
    expect(registered.url).toBe("https://100.64.1.2:9000/mcp");
    expect(registered.hasCredential).toBe(false);
    expect(registered.tools).toHaveLength(1);
    expect(registered.tools[0]?.ref).toBe("dev-local-notes/search_notes");
    expect(
      auditEvents.some((ev) => ev.eventType === "configuration.changed"),
    ).toBe(true);
    expect(await store.refreshTools("dev-local-notes")).toEqual({ tools: 1 });
  });
});
