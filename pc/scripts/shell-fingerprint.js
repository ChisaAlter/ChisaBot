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
 * 同时计算 clientHash（chisabotClient，客户端代码指纹）：覆盖外壳指纹 + package.json 的 dependencies +
 * src/ 下打包进客户端的代码与界面资源（不含 shell-fingerprint.json / build-config.json / update-keys.json，
 * 也不含纯版本号）。当远端版本更高但 chisabotShell 与 chisabotClient 均未变化时，说明本次发版只改了网页或
 * 服务器，桌面端无需下载安装包，直接走网页「有新版本，点此刷新」即可。
 *
 * 用法：
 *   node scripts/shell-fingerprint.js            打印指纹 JSON
 *   node scripts/shell-fingerprint.js --write    写 src/shell-fingerprint.json（打进 asar，客户端拿来比较）
 *   node scripts/shell-fingerprint.js --check    src/shell-fingerprint.json 过期就退出码 1（CI / 测试用）
 *   node scripts/shell-fingerprint.js --stamp dist/latest.yml [--full]
 *        给 latest.yml 加上 chisabotShell 与 chisabotClient（--full 时再加 fullInstall: true，强制所有客户端重新安装）。
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
  // 外壳指纹决定 Windows 客户端要不要「重新安装」（重建快捷方式 / 刷新图标缓存）。macOS 的打包配置和
  // icon.icns 不影响 Windows 外壳——mac 更新本来就把整个 .app 换掉，指纹对它没有意义：排除，
  // 避免给 mac 加配置时逼所有现存 Windows 客户端白做一次完整安装。
  delete build.mac;
  delete build.dmg;
  delete build.mas;
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

const CLIENT_GENERATED_FILES = new Set([
  "src/shell-fingerprint.json",
  "src/build-config.json",
  "src/update-keys.json",
]);

function walkClientFiles(dir, prefix, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${prefix}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkClientFiles(full, rel, out);
    } else if (entry.isFile() && !CLIENT_GENERATED_FILES.has(rel)) {
      out.push([rel, full]);
    }
  }
}

/** 客户端代码输入：外壳哈希 + 运行时 JS 依赖 + src/ 代码与本机 UI（排除版本号与构建期注入文件）。 */
function collectClientInputs(root = ROOT, shellHash = "") {
  const pkgFile = path.join(root, "package.json");
  const pkg = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, "utf8")) : {};
  const clientInputs = {
    shell: shellHash,
    "package.json#dependencies": sha256(canonical(pkg.dependencies || {})),
  };
  const files = [];
  walkClientFiles(path.join(root, "src"), "src", files);
  for (const [rel, full] of files) {
    const raw = /\.(js|cjs|mjs|json|html|css|svg|txt)$/i.test(rel)
      ? Buffer.from(fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n"), "utf8")
      : fs.readFileSync(full);
    clientInputs[rel] = sha256(raw);
  }
  return clientInputs;
}

function compute(root = ROOT) {
  const inputs = collectInputs(root);
  const hash = sha256(canonical({ schema: SCHEMA, inputs })).slice(0, 16);
  const clientInputs = collectClientInputs(root, hash);
  const clientHash = sha256(canonical({ schema: SCHEMA, clientInputs })).slice(0, 16);
  return { schema: SCHEMA, hash, clientHash, inputs };
}

function readCommitted(file = OUT) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 给 latest.yml 写（或替换）chisabotShell / chisabotClient / fullInstall 行。返回新文本。 */
function stampYaml(text, { hash, clientHash = "", full = false }) {
  const kept = text
    .split(/\r?\n/)
    // chisabotSig 签的是旧的字段，盖章以后一定失效：去掉，签名永远是发布的最后一步（scripts/sign-update.js）。
    .filter((line) => !/^(chisabotShell|chisabotClient|fullInstall|chisabotSig):/.test(line))
    .join("\n")
    .replace(/\n+$/, "");
  let out = `${kept}\nchisabotShell: ${hash}\n`;
  if (clientHash) out += `chisabotClient: ${clientHash}\n`;
  if (full) out += "fullInstall: true\n";
  return out;
}

function main(argv) {
  const fp = compute();
  if (argv.includes("--write")) {
    fs.writeFileSync(OUT, `${JSON.stringify(fp, null, 2)}\n`);
    console.log(`shell fingerprint ${fp.hash} (client ${fp.clientHash}) → ${path.relative(process.cwd(), OUT)}`);
    return 0;
  }
  if (argv.includes("--check")) {
    const committed = readCommitted();
    if (!committed || committed.hash !== fp.hash || committed.clientHash !== fp.clientHash) {
      console.error(
        `src/shell-fingerprint.json 过期（文件里 shell=${committed?.hash || "没有"} client=${committed?.clientHash || "没有"}，` +
          `现在算出 shell=${fp.hash} client=${fp.clientHash}）。改了 PC 客户端代码 / 图标 / 安装配置后运行：node scripts/shell-fingerprint.js --write`,
      );
      return 1;
    }
    console.log(`shell fingerprint ${fp.hash} (client ${fp.clientHash}) ok`);
    return 0;
  }
  const at = argv.indexOf("--stamp");
  if (at >= 0) {
    const file = argv[at + 1];
    if (!file) throw new Error("--stamp 需要 latest.yml 路径");
    const committed = readCommitted();
    // 打包用的是 asar 里的 src/shell-fingerprint.json；两者不一致说明打包前没 --write，宁可失败也不发错的指纹。
    if (!committed || committed.hash !== fp.hash || committed.clientHash !== fp.clientHash) {
      console.error(
        `打进安装包的指纹（shell=${committed?.hash || "没有"} client=${committed?.clientHash || "没有"}）` +
          `和现在算出的（shell=${fp.hash} client=${fp.clientHash}）不一致，先 --write 再打包。`,
      );
      return 1;
    }
    fs.writeFileSync(
      file,
      stampYaml(fs.readFileSync(file, "utf8"), { hash: fp.hash, clientHash: fp.clientHash, full: argv.includes("--full") }),
    );
    console.log(`stamped ${file}: chisabotShell ${fp.hash} chisabotClient ${fp.clientHash}${argv.includes("--full") ? " + fullInstall" : ""}`);
    return 0;
  }
  console.log(JSON.stringify(fp, null, 2));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { compute, collectInputs, collectClientInputs, canonical, stampYaml, readCommitted, NATIVE_DEPENDENCIES, SCHEMA };
