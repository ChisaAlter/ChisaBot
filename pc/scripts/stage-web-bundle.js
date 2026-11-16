#!/usr/bin/env node
"use strict";
/**
 * 将已构建好的网页前端（app/dist）暂存到 pc/src/web-bundle/，供打包进 app.asar；
 * 并提供 --verify-asar <app.asar> 直接校验打包产出的 ASAR 头目录树内是否真实包含前端包。
 */
const fs = require("node:fs");
const path = require("node:path");

const PC_ROOT = path.resolve(__dirname, "..");
const DEFAULT_FROM = path.resolve(PC_ROOT, "..", "app", "dist");
const TARGET_DIR = path.resolve(PC_ROOT, "src", "web-bundle");
const META_NAME = "chisabot-web-meta.json";

function copyTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === "node-agent") continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += copyTree(srcPath, destPath);
    } else if (entry.isFile() && !entry.name.endsWith(".map")) {
      fs.copyFileSync(srcPath, destPath);
      count += 1;
    }
  }
  return count;
}

/** 将 app/dist 暂存到 targetDir，跳过 node-agent/ 与 *.map，并写入版本元数据。 */
function stageWebBundle({
  fromDir = DEFAULT_FROM,
  targetDir = TARGET_DIR,
  version,
} = {}) {
  const srcRoot = path.resolve(fromDir);
  const destRoot = path.resolve(targetDir);
  if (path.basename(destRoot) !== "web-bundle") {
    throw new Error(`拒绝清理非 web-bundle 目录：${destRoot}`);
  }
  const indexHtml = path.join(srcRoot, "index.html");
  const assetsDir = path.join(srcRoot, "assets");
  if (
    !fs.existsSync(indexHtml) ||
    !fs.existsSync(assetsDir) ||
    !fs.statSync(assetsDir).isDirectory()
  ) {
    throw new Error(
      `前端构建产物不完整（缺少 index.html 或 assets/）：${srcRoot}`,
    );
  }
  const effectiveVersion =
    typeof version === "string" && version.trim()
      ? version.trim()
      : String(
          JSON.parse(
            fs.readFileSync(path.join(PC_ROOT, "package.json"), "utf8"),
          ).version || "",
        ).trim();
  if (!effectiveVersion) {
    throw new Error(
      "缺少有效的桌面端版本号，无法写入 chisabot-web-meta.json。",
    );
  }

  fs.rmSync(destRoot, { recursive: true, force: true });
  const fileCount = copyTree(srcRoot, destRoot);
  const meta = {
    version: effectiveVersion,
    buildId: `pc-${effectiveVersion}`,
  };
  fs.writeFileSync(
    path.join(destRoot, META_NAME),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );
  return {
    fromDir: srcRoot,
    targetDir: destRoot,
    fileCount: fileCount + 1,
    meta,
  };
}

/** 读取 ASAR 头部 JSON 目录树，验证 src/web-bundle 完整打包在内。 */
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const headerBuf = Buffer.alloc(16);
    const readHead = fs.readSync(fd, headerBuf, 0, 16, 0);
    if (readHead < 16) {
      throw new Error(`ASAR 文件头不完整：${asarPath}`);
    }
    const headerSize = headerBuf.readUInt32LE(4);
    const stringLen = headerBuf.readUInt32LE(12);
    if (
      headerSize === 0 ||
      stringLen === 0 ||
      stringLen > 64 * 1024 * 1024 ||
      headerSize < stringLen + 8
    ) {
      throw new Error(`ASAR Pickle 头异常：${asarPath}`);
    }
    const jsonBuf = Buffer.alloc(stringLen);
    const readJson = fs.readSync(fd, jsonBuf, 0, stringLen, 16);
    if (readJson < stringLen) {
      throw new Error(`ASAR JSON 目录读取不完整：${asarPath}`);
    }
    return JSON.parse(jsonBuf.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function verifyAsarWebBundle(asarPath) {
  const resolved = path.resolve(asarPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`找不到 ASAR 文件：${resolved}`);
  }
  const tree = readAsarHeader(resolved);
  const webBundle = tree?.files?.src?.files?.["web-bundle"]?.files;
  if (!webBundle || typeof webBundle !== "object") {
    throw new Error(`ASAR 内缺少 src/web-bundle 目录：${resolved}`);
  }
  if (!webBundle["index.html"] || !webBundle[META_NAME]) {
    throw new Error(
      `ASAR 内 src/web-bundle 缺少 index.html 或 ${META_NAME}：${resolved}`,
    );
  }
  const assets = webBundle.assets?.files;
  const assetNames =
    assets && typeof assets === "object" ? Object.keys(assets) : [];
  if (assetNames.length === 0) {
    throw new Error(`ASAR 内 src/web-bundle/assets 为空：${resolved}`);
  }
  return { asarPath: resolved, assetCount: assetNames.length };
}

function argValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return "";
}

function main(argv) {
  const verifyTarget = argValue(argv, "--verify-asar");
  if (verifyTarget) {
    const res = verifyAsarWebBundle(verifyTarget);
    console.log(
      `ASAR 前端包校验通过：${res.asarPath}（assets 文件数：${res.assetCount}）`,
    );
    return 0;
  }
  const fromDir = argValue(argv, "--from") || DEFAULT_FROM;
  const version = argValue(argv, "--version") || undefined;
  const res = stageWebBundle({ fromDir, version });
  console.log(
    `已暂存内置前端（${res.meta.buildId}，共 ${res.fileCount} 个文件）→ ${res.targetDir}`,
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`stage-web-bundle 失败：${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { stageWebBundle, verifyAsarWebBundle };
