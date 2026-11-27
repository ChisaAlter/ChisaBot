#!/usr/bin/env node
/**
 * ChisaBot 浏览器伴侣扩展构建与打包脚本（零额外巨型依赖）。
 *
 * 产物：
 * - browser-extension/dist/                          可直接通过 chrome://extensions 加载的 MV3 目录
 * - browser-extension/dist/chisabot-chrome-extension.zip  供服务端设备页分发与商店上传的标准 ZIP 包
 *
 * 遵循本机构建存储与临时目录回收守则：
 * - 复用仓内已有依赖（Bun.build 或 app/node_modules/esbuild + sharp）；
 * - 所有中间 staging 产物统一写入本次构建专属临时根，finally 中必然回收。
 */

import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(EXT_ROOT, "..");
const DIST_DIR = path.join(EXT_ROOT, "dist");
const ZIP_NAME = "chisabot-chrome-extension.zip";
const ZIP_PATH = path.join(DIST_DIR, ZIP_NAME);

const require = createRequire(import.meta.url);

// ---------- 标准 ZIP（PKZIP 2.0，纯 Node/zlib，跨平台零外部命令依赖） ----------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function collectFiles(dir, baseDir = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectFiles(full, baseDir));
    } else if (stat.isFile()) {
      const rel = path.relative(baseDir, full).replaceAll("\\", "/");
      out.push({ rel, full, mtime: stat.mtime });
    }
  }
  return out;
}

function createZipBuffer(sourceDir) {
  const entries = collectFiles(sourceDir);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.rel, "utf8");
    const raw = readFileSync(entry.full);
    const checksum = crc32(raw);
    const compressed = deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const { dosTime, dosDate } = dosDateTime(entry.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBytes, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

// ---------- 打包器（复用仓内已安装的 app/node_modules/esbuild，兼容 bun / node 双运行时） ----------

const EXTRA_NODE_PATHS = [
  path.join(REPO_ROOT, "app", "node_modules"),
  path.join(REPO_ROOT, "node_modules"),
];

function resolveEsbuild() {
  const candidates = [
    path.join(REPO_ROOT, "app", "node_modules", "esbuild"),
    path.join(REPO_ROOT, "node_modules", "esbuild"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return require(candidate);
    }
  }
  try {
    return require("esbuild");
  } catch {
    return null;
  }
}

async function bundleEntry({ entryPoint, outfile, format, jsx = false }) {
  mkdirSync(path.dirname(outfile), { recursive: true });
  const esbuild = resolveEsbuild();
  if (esbuild) {
    await esbuild.build({
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      platform: "browser",
      target: ["chrome116"],
      format,
      minify: true,
      nodePaths: EXTRA_NODE_PATHS,
      jsx: jsx ? "automatic" : undefined,
      define: {
        "process.env.NODE_ENV": '"production"',
      },
    });
    return;
  }

  if (typeof globalThis.Bun?.build === "function") {
    const outdir = path.dirname(outfile);
    const naming = path.basename(outfile);
    const appModules = path.join(REPO_ROOT, "app", "node_modules");
    const result = await globalThis.Bun.build({
      entrypoints: [entryPoint],
      outdir,
      naming,
      target: "browser",
      format,
      minify: true,
      sourcemap: "none",
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
      },
      plugins: [
        {
          name: "resolve-app-react",
          setup(build) {
            build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => ({
              path: require.resolve(args.path, { paths: [appModules] }),
            }));
          },
        },
      ],
    });
    if (!result.success) {
      const detail = result.logs
        .map((log) => String(log.message ?? log))
        .join("\n");
      throw new Error(`Bun.build 打包失败（${entryPoint}）：\n${detail}`);
    }
    return;
  }

  throw new Error("未找到可用的打包器（esbuild 或 Bun.build）。");
}

// ---------- 图标生成（复用仓内 app/public/icon-192.png 与 sharp） ----------

async function buildIcons(targetIconsDir) {
  mkdirSync(targetIconsDir, { recursive: true });
  const sourceIcon = path.join(REPO_ROOT, "app", "public", "icon-192.png");
  const sizes = [16, 32, 48, 128];

  let sharpLib = null;
  try {
    sharpLib = require(path.join(REPO_ROOT, "node_modules", "sharp"));
  } catch {
    try {
      sharpLib = require("sharp");
    } catch {
      sharpLib = null;
    }
  }

  if (sharpLib && existsSync(sourceIcon)) {
    for (const size of sizes) {
      await sharpLib(sourceIcon)
        .resize(size, size, { fit: "cover" })
        .png({ compressionLevel: 9 })
        .toFile(path.join(targetIconsDir, `icon-${size}.png`));
    }
    return;
  }

  // 若 sharp 不可用，直接复用现成 PNG 兜底（保证任何环境都能产出完整图标）
  const fallbackMap = {
    16: path.join(REPO_ROOT, "app", "public", "favicon-16.png"),
    32: path.join(REPO_ROOT, "app", "public", "favicon-32.png"),
    48: path.join(REPO_ROOT, "app", "public", "icon-192.png"),
    128: path.join(REPO_ROOT, "app", "public", "icon-192.png"),
  };
  for (const size of sizes) {
    const src = fallbackMap[size];
    if (!existsSync(src)) {
      throw new Error(`缺少基础图标资源：${src}`);
    }
    cpSync(src, path.join(targetIconsDir, `icon-${size}.png`));
  }
}

// ---------- Manifest 校验 ----------

function validateManifest(manifest, rootDir) {
  if (manifest.manifest_version !== 3) {
    throw new Error("manifest_version 必须为 3。");
  }
  const serialized = JSON.stringify(manifest);
  if (/https?:\/\/(?!\*\/\*)/i.test(serialized)) {
    throw new Error("manifest.json 不允许引用远程脚本或非通配符远程资源。");
  }
  const requiredPaths = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter(Boolean);

  for (const rel of requiredPaths) {
    const full = path.join(rootDir, rel);
    if (!existsSync(full)) {
      throw new Error(`manifest 引用的文件缺失：${rel}`);
    }
  }
}

export async function buildExtension() {
  const stageRoot = mkdtempSync(path.join(os.tmpdir(), "chisabot-ext-build-"));
  const stageDist = path.join(stageRoot, "unpacked");
  mkdirSync(stageDist, { recursive: true });

  try {
    // 1. 打包 Service Worker（ESM，供 MV3 background.type = "module"）
    await bundleEntry({
      entryPoint: path.join(EXT_ROOT, "src", "background", "index.ts"),
      outfile: path.join(stageDist, "background.js"),
      format: "esm",
    });

    // 2. 打包页内 HUD Content Script（IIFE，供 chrome.scripting.executeScript 按需注入）
    await bundleEntry({
      entryPoint: path.join(EXT_ROOT, "src", "content", "hud.ts"),
      outfile: path.join(stageDist, "content", "hud.js"),
      format: "iife",
    });

    // 3. 打包 Side Panel 前端（React 19）
    await bundleEntry({
      entryPoint: path.join(EXT_ROOT, "src", "sidepanel", "main.tsx"),
      outfile: path.join(stageDist, "sidepanel", "main.js"),
      format: "esm",
      jsx: true,
    });

    // 4. 拷贝 Side Panel 静态 HTML 与样式
    mkdirSync(path.join(stageDist, "sidepanel"), { recursive: true });
    cpSync(
      path.join(EXT_ROOT, "src", "sidepanel", "index.html"),
      path.join(stageDist, "sidepanel", "index.html"),
    );
    cpSync(
      path.join(EXT_ROOT, "src", "sidepanel", "styles.css"),
      path.join(stageDist, "sidepanel", "styles.css"),
    );

    // 5. 生成多尺寸 PNG 图标
    await buildIcons(path.join(stageDist, "icons"));

    // 6. 读取、同步版本并写入 manifest.json
    const manifestRaw = readFileSync(
      path.join(EXT_ROOT, "manifest.json"),
      "utf8",
    );
    const manifest = JSON.parse(manifestRaw);
    try {
      const rootPkg = JSON.parse(
        readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
      );
      if (
        typeof rootPkg.version === "string" &&
        /^\d+\.\d+\.\d+$/.test(rootPkg.version)
      ) {
        manifest.version = rootPkg.version;
      }
    } catch {
      // 保留 manifest.json 内声明的版本号
    }
    writeFileSync(
      path.join(stageDist, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    validateManifest(manifest, stageDist);

    // 7. 生成标准 ZIP（仅打包 unpacked 目录内容，不含 zip 自身）
    const zipBuffer = createZipBuffer(stageDist);

    // 8. 原子替换目标 dist/ 目录并写出 ZIP
    rmSync(DIST_DIR, { recursive: true, force: true });
    mkdirSync(DIST_DIR, { recursive: true });
    cpSync(stageDist, DIST_DIR, { recursive: true });
    writeFileSync(ZIP_PATH, zipBuffer);

    return {
      distDir: DIST_DIR,
      zipPath: ZIP_PATH,
      zipBytes: zipBuffer.length,
      version: manifest.version,
      files: collectFiles(stageDist).map((f) => f.rel),
    };
  } finally {
    // 强制回收本任务创建的临时 staging 根目录
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  const result = await buildExtension();
  console.log(
    JSON.stringify(
      {
        ok: true,
        version: result.version,
        distDir: result.distDir,
        zipPath: result.zipPath,
        zipBytes: result.zipBytes,
        fileCount: result.files.length,
      },
      null,
      2,
    ),
  );
}
