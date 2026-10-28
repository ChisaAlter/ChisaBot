#!/usr/bin/env node
"use strict";
/**
 * 「外壳指纹」：PC 客户端里只有完整安装才会真正换到用户桌面上的那部分（docs/online-update.md §2.1）。
 *
 * 在线更新本来就是下载完整的 NSIS 安装包，但 electron-updater 用「--updated」模式静默运行它：
 * 安装目录里的文件会全部换新，可桌面 / 开始菜单 / 任务栏上的快捷方式被原样保留（keepShortcuts），
 * Windows 的图标缓存也不刷新，所以换了图标之后用户看到的还是旧图标。
 *
 * 这里把这些「外壳输入」算成一个短哈希：
 *   - build/icon.ico（exe 资源里的图标）、build/icons/*.ico（快捷方式图标）、build/installer.nsh（安装脚本）、assets/icon.png、assets/tray-*.png
 *   - package.json：main、productName、build（appId / win / nsis / asar / electronLanguages 等，publish 除外，
 *     CI 会按版本类型改写它）、devDependencies 里的 electron、electron-builder
 *   - NATIVE_DEPENDENCIES 里列出的原生依赖的版本（现在没有；加了带 .node 的依赖要写进来）
 * 新旧版本的哈希不同 = 这次更新要走「重新安装」（不带 --updated，重建快捷方式、刷新图标缓存）。
 *
 * 用法：
 *   node scripts/shell-fingerprint.js            打印指纹 JSON
 *   node scripts/shell-fingerprint.js --write    写 src/shell-fingerprint.json（打进 asar，客户端拿来比较）
 *   node scripts/shell-fingerprint.js --check    src/shell-fingerprint.json 过期就退出码 1（CI / 测试用）
 *   node scripts/shell-fingerprint.js --stamp dist/latest.yml [--full]
 *        给 latest.yml 加上 chisabotShell: <哈希>（--full 时再加 fullInstall: true，强制所有客户端重新安装）。
 *        latest.yml 里的 sha512 是安装包的，改 yml 不影响校验。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "src", "shell-fingerprint.json");
const SCHEMA = 1;
/** 带原生模块（.node）的运行时依赖。它们跟着 Electron ABI 走，换版本必须完整安装。 */
const NATIVE_DEPENDENCIES = [];

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** 外壳输入：文件（相对 pc/）→ 内容哈希；配置项 → 规范化 JSON 的哈希。缺的文件记为 "missing"。 */
function collectInputs(root = ROOT) {
  const inputs = {};
  const files = ["build/icon.ico", "build/installer.nsh", "assets/icon.png"];
  // build/icons/chisabot-<哈希>.ico：快捷方式指向的图标文件（docs/online-update.md §2.1）。
  const iconsDir = path.join(root, "build", "icons");
  if (fs.existsSync(iconsDir)) {
    for (const name of fs.readdirSync(iconsDir).sort()) if (/\.ico$/i.test(name)) files.push(`build/icons/${name}`);
  }
  const assetsDir = path.join(root, "assets");
  if (fs.existsSync(assetsDir)) {
    for (const name of fs.readdirSync(assetsDir).sort()) if (/^tray-.*\.png$/.test(name)) files.push(`assets/${name}`);
  }
  for (const rel of files) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      inputs[rel] = "missing";
      continue;
    }
    const raw = /\.nsh$/i.test(rel) ? Buffer.from(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"), "utf8") : fs.readFileSync(file);
    inputs[rel] = sha256(raw);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const build = { ...(pkg.build || {}) };
  delete build.publish;
  const dev = pkg.devDependencies || {};
  const deps = pkg.dependencies || {};
  const shellConfig = {
    main: pkg.main || "",
    productName: pkg.productName || "",
    build,
    electron: dev.electron || deps.electron || "",
    electronBuilder: dev["electron-builder"] || "",
    native: Object.fromEntries(NATIVE_DEPENDENCIES.map((name) => [name, deps[name] || "missing"])),
  };
  inputs["package.json#shell"] = sha256(canonical(shellConfig));
  return inputs;
}

/** 键排序后的 JSON，同样的配置在任何机器上得到同样的字符串。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

function compute(root = ROOT) {
  const inputs = collectInputs(root);
  const hash = sha256(canonical({ schema: SCHEMA, inputs })).slice(0, 16);
  return { schema: SCHEMA, hash, inputs };
}

function readCommitted(file = OUT) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 给 latest.yml 写（或替换）chisabotShell / fullInstall 两行。返回新文本。 */
function stampYaml(text, { hash, full = false }) {
  const kept = text
    .split(/\r?\n/)
    .filter((line) => !/^(chisabotShell|fullInstall):/.test(line))
    .join("\n")
    .replace(/\n+$/, "");
  let out = `${kept}\nchisabotShell: ${hash}\n`;
  if (full) out += "fullInstall: true\n";
  return out;
}

function main(argv) {
  const fp = compute();
  if (argv.includes("--write")) {
    fs.writeFileSync(OUT, `${JSON.stringify(fp, null, 2)}\n`);
    console.log(`shell fingerprint ${fp.hash} → ${path.relative(process.cwd(), OUT)}`);
    return 0;
  }
  if (argv.includes("--check")) {
    const committed = readCommitted();
    if (!committed || committed.hash !== fp.hash) {
      console.error(
        `src/shell-fingerprint.json 过期（文件里 ${committed?.hash || "没有"}，现在算出 ${fp.hash}）。` +
          "改了图标 / 安装配置 / Electron 版本后运行：node scripts/shell-fingerprint.js --write",
      );
      return 1;
    }
    console.log(`shell fingerprint ${fp.hash} ok`);
    return 0;
  }
  const at = argv.indexOf("--stamp");
  if (at >= 0) {
    const file = argv[at + 1];
    if (!file) throw new Error("--stamp 需要 latest.yml 路径");
    const committed = readCommitted();
    // 打包用的是 asar 里的 src/shell-fingerprint.json；两者不一致说明打包前没 --write，宁可失败也不发错的指纹。
    if (!committed || committed.hash !== fp.hash) {
      console.error(`打进安装包的指纹（${committed?.hash || "没有"}）和现在算出的（${fp.hash}）不一致，先 --write 再打包。`);
      return 1;
    }
    fs.writeFileSync(file, stampYaml(fs.readFileSync(file, "utf8"), { hash: fp.hash, full: argv.includes("--full") }));
    console.log(`stamped ${file}: chisabotShell ${fp.hash}${argv.includes("--full") ? " + fullInstall" : ""}`);
    return 0;
  }
  console.log(JSON.stringify(fp, null, 2));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { compute, collectInputs, canonical, stampYaml, readCommitted, NATIVE_DEPENDENCIES, SCHEMA };
