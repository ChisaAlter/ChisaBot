import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  assertFileFingerprintUnchanged,
  buildAtomicTempPath,
  CHUNK_BYTES,
  ChunkedTransferError,
  computeChunkPlan,
  MAX_STANDARD_FILE_BYTES,
  MAX_VIDEO_FILE_BYTES,
  maxChunkedBytesForFile,
  normalizeTransferPath,
  sanitizeUploadFilename,
} from "../../shared/chunked-transfer";
import {
  createDiagnosticsRingBuffer,
  DIAGNOSTIC_REDACTED,
  MAX_DIAGNOSTIC_ENTRIES,
  redactDiagnosticText,
} from "../src/lib/diagnostics/ring-buffer";

const requireCjs = createRequire(import.meta.url);
const atomicDownload = requireCjs("../../pc/src/atomic-download.js") as {
  MAX_DOWNLOAD_BYTES: number;
  atomicChunkedDownload: (opts: {
    destPath: string;
    totalSize: number;
    chunkSize?: number;
    maxBytes?: number;
    allowedRoots?: string[];
    signal?: AbortSignal;
    readChunk: (input: {
      offset: number;
      length: number;
      index: number;
    }) => Promise<Buffer | { bytes: Buffer; totalSize?: number }>;
    expectedSha256?: string;
    onProgress?: (p: {
      bytesWritten: number;
      totalSize: number;
      fraction: number;
    }) => void;
  }) => Promise<{
    ok: boolean;
    destPath: string;
    bytesWritten: number;
    sha256: string;
  }>;
  makeAtomicTempPath: (destPath: string, pid?: number, uuid?: string) => string;
  createLocalDraftThumbnail: (opts: {
    filePath?: string;
    buffer?: Buffer;
    maxWidth?: number;
    maxHeight?: number;
    nativeImage?: unknown;
  }) => Promise<{
    ok: boolean;
    dataUrl?: string;
    width?: number;
    height?: number;
    reason?: string;
  }>;
};
const pcDiagnostics = requireCjs("../../pc/src/diagnostics-log.js") as {
  MAX_DIAGNOSTIC_ENTRIES: number;
  REDACTED: string;
  redactDiagnosticString: (input: string) => string;
  createDiagnosticsRingBuffer: (opts?: { maxEntries?: number }) => {
    record: (entry: Record<string, unknown>) => Record<string, unknown>;
    entries: () => Array<Record<string, unknown>>;
    exportToFile: (
      dest: string,
      meta?: Record<string, unknown>,
    ) => Promise<{ ok: boolean; count: number }>;
  };
};
const accessibility = requireCjs("../../pc/src/accessibility-bridge.js") as {
  ACCESSIBILITY_SCOPE: string;
  MAX_GRANT_TTL_MS: number;
  normalizeBundleId: (raw: string) => string;
  buildWinReadTreeScript: (opts: {
    bundleId: string;
    maxNodes?: number;
  }) => string;
  buildWinActionScript: (opts: {
    bundleId: string;
    action: string;
    name?: string;
    automationId?: string;
    value?: string;
  }) => string;
  buildMacActionScript: (opts: {
    bundleId: string;
    action: string;
    name?: string;
    value?: string;
  }) => string;
  createDirectionEpochAuthorizer: (opts?: {
    now?: () => number;
    defaultTtlMs?: number;
  }) => {
    currentEpoch: (conversationId: string) => number;
    advanceEpoch: (conversationId: string) => number;
    authorizeApp: (input: Record<string, unknown>) => {
      ok: boolean;
      reason?: string;
      grant?: { expiresAt: number; grantedAt: number };
    };
    checkAuthorization: (input: Record<string, unknown>) => {
      allowed: boolean;
      reason?: string;
      currentEpoch?: number;
    };
  };
  createAccessibilityBridge: (opts: Record<string, unknown>) => {
    authorizer: ReturnType<typeof accessibility.createDirectionEpochAuthorizer>;
    readTree: (
      req: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    performAction: (
      req: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
};
const { winInputScript, macInputPlan, linuxInputArgs } = requireCjs(
  "../../pc/src/agent/ops.js",
) as {
  winInputScript: (args: Record<string, unknown>) => string;
  macInputPlan: (
    args: Record<string, unknown>,
    opts?: { hasCliclick?: boolean },
  ) => { file: string; args: string[]; via: string };
  linuxInputArgs: (args: Record<string, unknown>) => string[];
};

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

describe("Wave 9: 4 MiB 分块切分、变更检测与原子下载", () => {
  test("4 MiB 切块计划与普通 25 MiB / 视频 200 MiB 分块上限", () => {
    expect(CHUNK_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_STANDARD_FILE_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_VIDEO_FILE_BYTES).toBe(200 * 1024 * 1024);

    expect(maxChunkedBytesForFile("clip.mp4", "video/mp4")).toBe(
      MAX_VIDEO_FILE_BYTES,
    );
    expect(maxChunkedBytesForFile("archive.zip", "application/zip")).toBe(
      MAX_STANDARD_FILE_BYTES,
    );

    const plan = computeChunkPlan(10 * 1024 * 1024 + 512);
    expect(plan.totalChunks).toBe(3);
    expect(plan.chunks[0]).toEqual({
      index: 0,
      offset: 0,
      length: CHUNK_BYTES,
    });
    expect(plan.chunks[1]).toEqual({
      index: 1,
      offset: CHUNK_BYTES,
      length: CHUNK_BYTES,
    });
    expect(plan.chunks[2]).toEqual({
      index: 2,
      offset: 2 * CHUNK_BYTES,
      length: 2 * 1024 * 1024 + 512,
    });

    expect(() => computeChunkPlan(MAX_VIDEO_FILE_BYTES + 1)).toThrow(
      ChunkedTransferError,
    );
    expect(() => sanitizeUploadFilename("../evil.txt")).toThrow(
      ChunkedTransferError,
    );
    expect(normalizeTransferPath("C:\\Users\\demo\\a\\b.txt", "\\")).toBe(
      "C:/Users/demo/a/b.txt",
    );
    expect(buildAtomicTempPath("/tmp/out.bin", 1234, "uuid-1")).toBe(
      "/tmp/out.bin.1234.uuid-1.tmp",
    );
  });

  test("文件修改期指纹（mtimeMs + size）变更检测", () => {
    expect(() =>
      assertFileFingerprintUnchanged(
        { size: 4096, mtimeMs: 1700000000000 },
        { size: 4096, mtimeMs: 1700000000000 },
      ),
    ).not.toThrow();

    expect(() =>
      assertFileFingerprintUnchanged(
        { size: 4096, mtimeMs: 1700000000000 },
        { size: 4096, mtimeMs: 1700000000500 },
      ),
    ).toThrow(/发生变更/);

    expect(() =>
      assertFileFingerprintUnchanged(
        { size: 4096, mtimeMs: 1700000000000 },
        { size: 4097, mtimeMs: 1700000000000 },
      ),
    ).toThrow(/发生变更/);
  });

  test("PC 原子分块下载：唯一 tmp 名 + fsync + rename，失败自动清理，含本地草稿缩略图", async () => {
    const dir = await makeTempDir("cb-atomic-dl-");
    const dest = path.join(dir, "video.bin");
    const source = Buffer.alloc(10_000, 0x6b);
    const sha256 = createHash("sha256").update(source).digest("hex");

    expect(atomicDownload.makeAtomicTempPath(dest, 42, "abc-123")).toBe(
      `${dest}.42.abc-123.tmp`,
    );

    const progressFractions: number[] = [];
    const res = await atomicDownload.atomicChunkedDownload({
      destPath: dest,
      totalSize: source.length,
      chunkSize: 4096,
      expectedSha256: sha256,
      readChunk: async ({ offset, length }) => ({
        bytes: source.subarray(offset, offset + length),
        totalSize: source.length,
      }),
      onProgress: (p) => progressFractions.push(p.fraction),
    });
    expect(res.ok).toBe(true);
    expect(res.sha256).toBe(sha256);
    expect(progressFractions.at(-1)).toBe(1);
    expect((await fsp.readFile(dest)).equals(source)).toBe(true);
    // 成功后不应残留任何 .tmp 文件
    expect((await fsp.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual(
      [],
    );

    // 校验失败时不应生成目标文件且不得残留 .tmp 文件
    const badDest = path.join(dir, "corrupt.bin");
    await expect(
      atomicDownload.atomicChunkedDownload({
        destPath: badDest,
        totalSize: source.length,
        chunkSize: 4096,
        expectedSha256: "0".repeat(64),
        readChunk: async ({ offset, length }) =>
          source.subarray(offset, offset + length),
      }),
    ).rejects.toThrow(/SHA-256 校验失败/);
    expect((await fsp.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual(
      [],
    );
    await expect(fsp.stat(badDest)).rejects.toThrow();

    // nativeImage 零网络本地草稿缩略图缩放
    const fakeNativeImage = {
      createFromBuffer: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 1200, height: 600 }),
        resize: ({ width, height }: { width: number; height: number }) => ({
          getSize: () => ({ width, height }),
          toDataURL: () => `data:image/png;base64,thumb-${width}x${height}`,
        }),
        toDataURL: () => "data:image/png;base64,orig",
      }),
    };
    const thumb = await atomicDownload.createLocalDraftThumbnail({
      buffer: Buffer.from([1, 2, 3, 4]),
      maxWidth: 300,
      maxHeight: 300,
      nativeImage: fakeNativeImage,
    });
    expect(thumb.ok).toBe(true);
    expect(thumb.width).toBe(300);
    expect(thumb.height).toBe(150);
    expect(thumb.dataUrl).toContain("thumb-300x150");

    // 文件路径分支经 fd fstat 校验并读取
    const imgPath = path.join(dir, "draft.png");
    await fsp.writeFile(imgPath, Buffer.from([1, 2, 3, 4]));
    const thumbFromFile = await atomicDownload.createLocalDraftThumbnail({
      filePath: imgPath,
      maxWidth: 300,
      maxHeight: 300,
      nativeImage: fakeNativeImage,
    });
    expect(thumbFromFile.ok).toBe(true);
    expect(thumbFromFile.width).toBe(300);

    // 安全边界：空 destPath、超过 MAX_DOWNLOAD_BYTES、超出 allowedRoots 均必须拒绝
    await expect(
      atomicDownload.atomicChunkedDownload({
        destPath: "   ",
        totalSize: 16,
        readChunk: async () => Buffer.alloc(16),
      }),
    ).rejects.toThrow(/路径无效/);
    await expect(
      atomicDownload.atomicChunkedDownload({
        destPath: path.join(dir, "huge.bin"),
        totalSize: atomicDownload.MAX_DOWNLOAD_BYTES + 1,
        readChunk: async () => Buffer.alloc(16),
      }),
    ).rejects.toThrow(/超过上限/);
    const otherDir = await makeTempDir("cb-atomic-outside-");
    await expect(
      atomicDownload.atomicChunkedDownload({
        destPath: path.join(otherDir, "escape.bin"),
        totalSize: 16,
        allowedRoots: [dir],
        readChunk: async () => Buffer.alloc(16),
      }),
    ).rejects.toThrow(/超出允许根目录范围/);
  });
});

describe("Wave 9: 端侧环形诊断日志上限与敏感凭据自动脱敏", () => {
  test("Web 环形缓冲严格封顶 500 条并深度脱敏 Authorization / Cookie / Token / JWT / Query", () => {
    expect(MAX_DIAGNOSTIC_ENTRIES).toBe(500);
    const ring = createDiagnosticsRingBuffer();

    for (let i = 1; i <= 620; i += 1) {
      ring.record({
        category: i % 3 === 0 ? "push" : i % 3 === 1 ? "network" : "connection",
        event: `evt_${i}`,
        message: `seq ${i}`,
      });
    }
    const items = ring.snapshot();
    expect(items).toHaveLength(500);
    expect(items[0]?.event).toBe("evt_121");
    expect(items[499]?.event).toBe("evt_620");

    const leakedJwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    ring.record({
      category: "network",
      level: "error",
      event: "ws_reconnect",
      message: `Authorization: Bearer super_secret_token_999; Cookie: sid=topsecret123; key=cbd_1234567890abcdef https://api.test/ws?token=abc987&x=1 ${leakedJwt}`,
      detail: {
        headers: {
          Authorization: "Bearer hidden_value_111",
          Cookie: "session=hidden_cookie_222",
          "X-Device-Token": "cbd_secret_device_token_333",
        },
        nested: {
          api_key: "sk-proj-verysecret123456",
          safeNote: "reconnect attempt 2",
        },
      },
    });

    const exportedJson = ring.exportJson({ runtime: { online: true } });
    expect(exportedJson).not.toContain("super_secret_token_999");
    expect(exportedJson).not.toContain("topsecret123");
    expect(exportedJson).not.toContain("cbd_1234567890abcdef");
    expect(exportedJson).not.toContain("abc987");
    expect(exportedJson).not.toContain(leakedJwt);
    expect(exportedJson).not.toContain("hidden_value_111");
    expect(exportedJson).not.toContain("hidden_cookie_222");
    expect(exportedJson).not.toContain("cbd_secret_device_token_333");
    expect(exportedJson).not.toContain("sk-proj-verysecret123456");
    expect(exportedJson).toContain(DIAGNOSTIC_REDACTED);
    expect(exportedJson).toContain("reconnect attempt 2");

    const parsed = JSON.parse(exportedJson) as {
      redacted: boolean;
      count: number;
      maxEntries: number;
    };
    expect(parsed.redacted).toBe(true);
    expect(parsed.count).toBe(500);
    expect(parsed.maxEntries).toBe(500);
    expect(
      redactDiagnosticText("Authorization: Bearer abcdef123456"),
    ).toContain(DIAGNOSTIC_REDACTED);

    // 回归 #6：多段 Cookie / Set-Cookie 整行脱敏、JSON 敏感键值、URL 凭据、#fragment 与云凭据前缀
    const multiCookie = redactDiagnosticText(
      "Cookie: theme=dark; session_id=SECRET_SESS_VAL; csrf=SECRET_CSRF",
    );
    expect(multiCookie).not.toContain("SECRET_SESS_VAL");
    expect(multiCookie).not.toContain("SECRET_CSRF");

    const setCookie = redactDiagnosticText(
      "Set-Cookie: a=1; refresh_token=TOP_SECRET_REFRESH; HttpOnly",
    );
    expect(setCookie).not.toContain("TOP_SECRET_REFRESH");

    const jsonSample = redactDiagnosticText(
      '{"cookie":"a=1; sid=JSON_COOKIE_SECRET","x-api-key":"JSON_API_KEY_999","ok":true}',
    );
    expect(jsonSample).not.toContain("JSON_COOKIE_SECRET");
    expect(jsonSample).not.toContain("JSON_API_KEY_999");
    expect(jsonSample).toContain('"ok":true');

    const urlAndKeys = redactDiagnosticText(
      "https://alice:hunter2pass@api.example.com/cb#access_token=FRAG_TOKEN_888 github_pat_11ABCDEF12345678 AIzaSyA1234567890abcdef12345 AKIAIOSFODNN7EXAMPLE",
    );
    expect(urlAndKeys).not.toContain("hunter2pass");
    expect(urlAndKeys).not.toContain("FRAG_TOKEN_888");
    expect(urlAndKeys).not.toContain("github_pat_11ABCDEF12345678");
    expect(urlAndKeys).not.toContain("AIzaSyA1234567890abcdef12345");
    expect(urlAndKeys).not.toContain("AKIAIOSFODNN7EXAMPLE");

    const pcMulti = pcDiagnostics.redactDiagnosticString(
      "Cookie: theme=dark; session_id=PC_SECRET_999\nhttps://bob:pass999@host.test/#id_token=PC_FRAG_111",
    );
    expect(pcMulti).not.toContain("PC_SECRET_999");
    expect(pcMulti).not.toContain("pass999");
    expect(pcMulti).not.toContain("PC_FRAG_111");
  });

  test("PC 端环形诊断日志同样执行 500 条上限、全量脱敏与原子 JSON 落盘", async () => {
    const dir = await makeTempDir("cb-pc-diag-");
    const outFile = path.join(dir, "diagnostics.json");
    expect(pcDiagnostics.MAX_DIAGNOSTIC_ENTRIES).toBe(500);

    const log = pcDiagnostics.createDiagnosticsRingBuffer({ maxEntries: 500 });
    for (let i = 0; i < 530; i += 1) {
      log.record({
        category: "connection",
        event: `hb_${i}`,
        detail: {
          Authorization: `Bearer pc-secret-${i}`,
          cookie: `sid=pc-cookie-${i}`,
          step: i,
        },
      });
    }
    expect(log.entries()).toHaveLength(500);
    const exportRes = await log.exportToFile(outFile, {
      clientVersion: "0.1.169",
      deviceToken: "cbd_must_be_redacted_12345",
    });
    expect(exportRes.ok).toBe(true);
    expect(exportRes.count).toBe(500);
    const raw = await fsp.readFile(outFile, "utf8");
    expect(raw).not.toContain("pc-secret-");
    expect(raw).not.toContain("pc-cookie-");
    expect(raw).not.toContain("cbd_must_be_redacted_12345");
    expect(raw).toContain(pcDiagnostics.REDACTED);
    expect((await fsp.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual(
      [],
    );
  });
});

describe("Wave 9: 无障碍 directionEpoch 代际授权失效与 macOS 输入兜底", () => {
  test("按 bundleId 绑定 directionEpoch：新指令代际递增自动失效旧授权，缺 scope 或跨应用拦截", async () => {
    let clock = 1_700_000_000_000;
    const bridge = accessibility.createAccessibilityBridge({
      platform: "darwin",
      now: () => clock,
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          found: true,
          bundleId: "com.apple.notes",
          windowTitle: "备忘录",
          nodes: [{ name: "新建备忘录", role: "AXButton", enabled: true }],
        }),
        stderr: "",
      }),
    });

    const convId = "conv-1";
    const devId = "dev-mac-1";
    const scopes = [accessibility.ACCESSIBILITY_SCOPE];

    // 1. 缺 accessibility_control scope 直接拒绝
    const noScope = await bridge.readTree({
      conversationId: convId,
      deviceId: devId,
      bundleId: "com.apple.Notes",
      scopes: [],
    });
    expect(noScope.ok).toBe(false);
    expect(noScope.status).toBe("denied");

    // 2. 有 scope 但本回合尚未授权目标应用 -> 返回 ask + 当前 epoch
    const epoch1 = bridge.authorizer.currentEpoch(convId);
    const askFirst = await bridge.readTree({
      conversationId: convId,
      deviceId: devId,
      bundleId: "com.apple.Notes",
      epoch: epoch1,
      scopes,
    });
    expect(askFirst.ok).toBe(false);
    expect(askFirst.status).toBe("ask");
    expect(askFirst.epoch).toBe(epoch1);

    // 3. 签发当前代际 com.apple.notes 临时授权后可读写该应用，但不能越权操作其他 bundleId
    const granted = bridge.authorizer.authorizeApp({
      conversationId: convId,
      deviceId: devId,
      bundleId: "com.apple.Notes",
      epoch: epoch1,
      scopes,
      ttlMs: 60_000,
    });
    expect(granted.ok).toBe(true);

    const readOk = await bridge.readTree({
      conversationId: convId,
      deviceId: devId,
      bundleId: "com.apple.notes",
      epoch: epoch1,
      scopes,
    });
    expect(readOk.ok).toBe(true);
    expect(readOk.status).toBe("done");

    const otherApp = await bridge.readTree({
      conversationId: convId,
      deviceId: devId,
      bundleId: "com.apple.Safari",
      epoch: epoch1,
      scopes,
    });
    expect(otherApp.ok).toBe(false);
    expect(otherApp.status).toBe("ask");

    // 4. 用户发新指令 -> directionEpoch 递增，旧代际授权立即自动失效！
    const epoch2 = bridge.authorizer.advanceEpoch(convId);
    expect(epoch2).toBe(epoch1 + 1);

    const staleEpochCall = await bridge.readTree({
      conversationId: convId,
      deviceId: devId,
      bundleId: "com.apple.notes",
      epoch: epoch1,
      scopes,
    });
    expect(staleEpochCall.ok).toBe(false);
    expect(staleEpochCall.status).toBe("denied");

    const newEpochNeedsAsk = await bridge.readTree({
      conversationId: convId,
      deviceId: devId,
      bundleId: "com.apple.notes",
      epoch: epoch2,
      scopes,
    });
    expect(newEpochNeedsAsk.ok).toBe(false);
    expect(newEpochNeedsAsk.status).toBe("ask");

    // 5. 同代际授权 TTL 过期也会自动失效
    bridge.authorizer.authorizeApp({
      conversationId: convId,
      deviceId: devId,
      bundleId: "com.apple.notes",
      epoch: epoch2,
      scopes,
      ttlMs: 5000,
    });
    clock += 6000;
    const expiredCall = await bridge.readTree({
      conversationId: convId,
      deviceId: devId,
      bundleId: "com.apple.notes",
      epoch: epoch2,
      scopes,
    });
    expect(expiredCall.ok).toBe(false);
    expect(expiredCall.status).toBe("denied");

    // 6. ttlMs <= 0 或非有限数必须拒绝（绝不静默扩为 10 分钟），超大 ttlMs 钳位至 MAX_GRANT_TTL_MS
    expect(
      bridge.authorizer.authorizeApp({
        conversationId: convId,
        deviceId: devId,
        bundleId: "com.apple.notes",
        epoch: epoch2,
        scopes,
        ttlMs: 0,
      }),
    ).toMatchObject({ ok: false, reason: "invalid_ttl" });
    expect(
      bridge.authorizer.authorizeApp({
        conversationId: convId,
        deviceId: devId,
        bundleId: "com.apple.notes",
        epoch: epoch2,
        scopes,
        ttlMs: -5000,
      }),
    ).toMatchObject({ ok: false, reason: "invalid_ttl" });
    const clamped = bridge.authorizer.authorizeApp({
      conversationId: convId,
      deviceId: devId,
      bundleId: "com.apple.notes",
      epoch: epoch2,
      scopes,
      ttlMs: 999_999_999,
    });
    expect(clamped.ok).toBe(true);
    expect(
      (clamped.grant?.expiresAt ?? 0) - (clamped.grant?.grantedAt ?? 0),
    ).toBe(accessibility.MAX_GRANT_TTL_MS);
  });

  test("Windows PS 5.1 弯单引号安全 Base64 传参、UIA 精确匹配、Linux xdotool 安全参数与 JXA 无双重转义", () => {
    // 1. normalizeBundleId 拒绝空串、通配符与弯引号注入
    expect(accessibility.normalizeBundleId("")).toBe("");
    expect(accessibility.normalizeBundleId("*")).toBe("");
    expect(accessibility.normalizeBundleId("notepad’ ; calc")).toBe("");
    expect(() =>
      accessibility.buildWinReadTreeScript({ bundleId: "" }),
    ).toThrow(/合法的目标应用标识/);

    // 2. UIA 仅精确匹配 $pname -eq $target，且含 Unicode 弯单引号的参数全部走 UTF-8 Base64 传入
    const curlyPayload = "确定’ ; Start-Process calc ; ‘";
    const winRead = accessibility.buildWinReadTreeScript({
      bundleId: "notepad",
    });
    expect(winRead).toContain("FromBase64String");
    expect(winRead).toContain("$pname -eq $target");
    expect(winRead).not.toContain("-like");
    expect(winRead).not.toContain("-not $target");

    const winAct = accessibility.buildWinActionScript({
      bundleId: "notepad",
      action: "set_value",
      name: curlyPayload,
      value: curlyPayload,
    });
    expect(winAct).toContain("FromBase64String");
    expect(winAct).not.toContain(curlyPayload);
    expect(winAct).not.toContain("Start-Process calc");
    expect(winAct).not.toContain("-like");

    // 3. ops.js Windows 输入脚本（type / key / focus）均使用 Base64 传参并限制长度
    const psType = winInputScript({ action: "type", text: curlyPayload });
    expect(psType).toContain("FromBase64String");
    expect(psType).not.toContain("Start-Process calc");
    const psFocus = winInputScript({ action: "focus", app: curlyPayload });
    expect(psFocus).toContain("FromBase64String");
    expect(psFocus).not.toContain("Start-Process calc");
    expect(() =>
      winInputScript({ action: "type", text: "a".repeat(5000) }),
    ).toThrow(/长度超出上限/);

    // 4. Linux xdotool 强校验坐标有限性、加 -- 防选项注入、转义 focus 正则元字符
    expect(() =>
      linuxInputArgs({ action: "click", x: Number.NaN, y: 10 }),
    ).toThrow(/有效的数字坐标/);
    expect(linuxInputArgs({ action: "key", keys: "Return" })).toEqual([
      "key",
      "--",
      "Return",
    ]);
    expect(() => linuxInputArgs({ action: "focus", app: "   " })).toThrow(
      /focus 需要/,
    );
    expect(linuxInputArgs({ action: "focus", app: "Code (app.ts)*" })).toEqual([
      "search",
      "--name",
      "--",
      "Code \\(app\\.ts\\)\\*",
      "windowactivate",
    ]);

    // 5. macOS JXA 脚本不得对 target 做 escapeAppleScript + JSON.stringify 双重转义
    const macAct = accessibility.buildMacActionScript({
      bundleId: "com.apple.Notes",
      action: "focus",
    });
    expect(macAct).toContain('const target = "com.apple.notes";');
  });

  test("macOS 输入兜底方案生成（focus / type / key / click / scroll）并正确转义引号", () => {
    const focusPlan = macInputPlan({
      action: "focus",
      bundleId: 'com.apple.Notes"',
    });
    expect(focusPlan.file).toBe("osascript");
    expect(focusPlan.args[1]).toContain(
      'tell application id "com.apple.Notes\\"" to activate',
    );

    const typePlan = macInputPlan({
      action: "type",
      text: 'hello "world" \\ test',
    });
    expect(typePlan.file).toBe("osascript");
    expect(typePlan.args[1]).toContain(
      'keystroke "hello \\"world\\" \\\\ test"',
    );

    const keyPlan = macInputPlan({ action: "key", keys: "cmd+shift+Return" });
    expect(keyPlan.args[1]).toContain(
      "key code 36 using {command down, shift down}",
    );

    const cliclickPlan = macInputPlan(
      { action: "double_click", x: 120.4, y: 240.8 },
      { hasCliclick: true },
    );
    expect(cliclickPlan.file).toBe("cliclick");
    expect(cliclickPlan.args).toEqual(["dc:120,241"]);

    const jxaPlan = macInputPlan(
      { action: "click", x: 50, y: 80 },
      { hasCliclick: false },
    );
    expect(jxaPlan.file).toBe("osascript");
    expect(jxaPlan.via).toBe("jxa-coregraphics");
    expect(jxaPlan.args[3]).toContain("CGEventCreateMouseEvent");

    const scrollPlan = macInputPlan({
      action: "scroll",
      x: 10,
      y: 20,
      amount: -5,
    });
    expect(scrollPlan.args[3]).toContain("CGEventCreateScrollWheelEvent");
  });
});
