#!/usr/bin/env node
/**
 * 上传到 GitHub Release 前的把关（.github/workflows/release.yml「Assert release assets are generic」步骤）。
 *
 * 背景：generic 和 custom 两个 flavor 的安装包 / latest.yml / update-keys.json 文件名完全相同，
 * 产物目录一旦合并就会互相覆盖——可能把内置了自建服务器地址的 custom 包传上公开 Release，或者
 * latest.yml 与安装包不是同一个 build。这里在上传前最后一次确认「待上传的就是 generic flavor 的那套」。
 *
 * 用法：node scripts/check-release-assets.mjs <release-assets 目录> (--expect-signed | --expect-unsigned) [--version <版本>]
 *   --expect-signed    pc_sign=true 的发布：latest.yml / latest-mac.yml 必须带 chisabotSig；
 *   --expect-unsigned  CHISABOT_PC_UPDATE_UNSIGNED=1 的发布：清单不得带 chisabotSig；
 *   --version <v>      清单的 version 必须等于 v。
 *
 * 检查（任一不过即退出 1，打 ::error::）：
 *   1. flavor.txt（pc job 打进每个 pc-* 产物的 flavor 标记）内容必须是 generic；
 *   2. 剔除 flavor.txt / update-keys.json 后，目录里只允许发布白名单：*-setup.exe、*-setup.exe.blockmap、
 *      *-portable.zip、latest.yml、latest-mac.yml、*-mac.dmg(+blockmap)、*-mac.zip(+blockmap)、
 *      *.apk、chisabot-android.json；子目录一律算越界文件；
 *   3. 恰好一个 *-setup.exe；latest.yml 的 path 指向它，顶层 sha512 与文件一致；
 *   4. 每个清单 files[] 每一项都是同目录文件名、文件存在、sha512 / size 一致；
 *   5. 按开关断言 chisabotSig 在场 / 缺席。
 *
 * macOS 资产（latest-mac.yml、*-mac.dmg/zip）是可选的：有 latest-mac.yml 就做和 latest.yml 一样的
 * 清单校验（path/files[] 必须指到目录里的真实 mac 资产）；没有就跳过，向后兼容只有 Windows 的发布。
 *
 * 副作用：flavor.txt、update-keys.json 是构建过程文件，校验通过后从目录里删掉，不作为 Release 资产上传。
 * 退出码：0 通过；1 校验失败；2 用法错误。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BUILD_FILES = new Set(["flavor.txt", "update-keys.json"]);
const ASSET_PATTERNS = [
  /-setup\.exe$/,
  /-setup\.exe\.blockmap$/,
  /-portable\.zip$/,
  /^latest\.yml$/,
  /^latest-mac\.yml$/,
  /-mac\.dmg$/,
  /-mac\.dmg\.blockmap$/,
  /-mac\.zip$/,
  /-mac\.zip\.blockmap$/,
  /\.apk$/,
  /^chisabot-android\.json$/,
];

function fail(message) {
  console.error(`::error::check-release-assets: ${message}`);
  process.exit(1);
}

function sha512File(file) {
  return crypto
    .createHash("sha512")
    .update(fs.readFileSync(file))
    .digest("base64");
}

function unquote(value) {
  const v = String(value).trim();
  if (
    v.length >= 2 &&
    ((v.startsWith("'") && v.endsWith("'")) ||
      (v.startsWith('"') && v.endsWith('"')))
  )
    return v.slice(1, -1);
  return v;
}

/** latest.yml 的最小解析：顶层 key: value + files: 下的 - url:/sha512:/size: 条目（electron-builder 的输出格式）。 */
function parseLatestYml(textValue) {
  const top = {};
  const files = [];
  let current = null;
  for (const raw of textValue.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const entry = /^\s+-\s+url:\s*(.+?)\s*$/.exec(raw);
    if (entry) {
      current = { url: unquote(entry[1]) };
      files.push(current);
      continue;
    }
    const m = /^(\s*)([A-Za-z0-9_]+):\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const value = unquote(m[3]);
    if (m[1].length === 0) {
      top[m[2]] = value;
      current = null;
    } else if (current) {
      current[m[2]] = value;
    }
  }
  return { top, files };
}

function main(argv) {
  const [dir, flag, ...rest] = argv;
  if (!dir || (flag !== "--expect-signed" && flag !== "--expect-unsigned")) {
    console.error(
      "用法：check-release-assets.mjs <目录> (--expect-signed | --expect-unsigned) [--version <版本>]",
    );
    return 2;
  }
  let version = "";
  if (rest.length) {
    if (rest[0] !== "--version" || !rest[1]) {
      console.error(
        "用法：check-release-assets.mjs <目录> (--expect-signed | --expect-unsigned) [--version <版本>]",
      );
      return 2;
    }
    version = rest[1];
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    fail(`读不出资产目录 ${dir}：${error.message}`);
  }

  // 1. flavor 标记：pc job 给每个 pc-<flavor>(-unsigned) 产物都写了 flavor.txt。
  const marker = path.join(dir, "flavor.txt");
  if (!entries.some((e) => e.isFile() && e.name === "flavor.txt"))
    fail("缺 flavor.txt：无法确认 PC 产物来自 generic flavor");
  const flavor = fs.readFileSync(marker, "utf8").trim();
  if (flavor !== "generic")
    fail(
      `flavor 标记是 ${flavor || "空"} 而不是 generic：混入了自建版产物，中止上传`,
    );

  // 2. 白名单（构建过程文件不算资产：校验后删掉）。
  const assets = [];
  for (const entry of entries) {
    if (entry.isDirectory()) fail(`资产目录里出现子目录 ${entry.name}`);
    if (BUILD_FILES.has(entry.name)) continue;
    if (!ASSET_PATTERNS.some((re) => re.test(entry.name)))
      fail(`越界文件 ${entry.name}：不在 Release 资产白名单里`);
    assets.push(entry.name);
  }

  // 3./4. 每个清单（latest.yml 必选，latest-mac.yml 可选）↔ 同目录资产：
  // version、path 指向真实文件、顶层 sha512、files[] 每项存在且哈希/大小一致、签名在场性。
  const checkManifest = (ymlName) => {
    const { top, files } = parseLatestYml(
      fs.readFileSync(path.join(dir, ymlName), "utf8"),
    );
    if (version && top.version !== version)
      fail(`${ymlName} version ${top.version || "空"} != ${version}`);
    if (!top.path || !assets.includes(top.path))
      fail(
        `${ymlName} 的 path 是 ${top.path || "空"}，不在资产目录里：清单和安装包不是同一套`,
      );
    if (top.sha512 !== sha512File(path.join(dir, top.path)))
      fail(
        `${ymlName} 的 sha512 与 ${top.path} 不符（清单和安装包不是同一 flavor/build）`,
      );
    if (!files.length) fail(`${ymlName} 的 files[] 为空`);
    for (const f of files) {
      if (!f.url || f.url !== path.basename(f.url))
        fail(`${ymlName} files[] 里有非法 url：${f.url || "空"}`);
      const file = path.join(dir, f.url);
      if (!assets.includes(f.url) || !fs.existsSync(file))
        fail(`${ymlName} files[] 指向的 ${f.url} 不在资产目录里`);
      if (f.sha512 !== sha512File(file))
        fail(`${ymlName} files[] 里 ${f.url} 的 sha512 与文件不符`);
      if (
        f.size !== undefined &&
        f.size !== "" &&
        Number(f.size) !== fs.statSync(file).size
      ) {
        fail(`${ymlName} files[] 里 ${f.url} 的 size 与文件不符`);
      }
    }
    const hasSig = top.chisabotSig !== undefined && top.chisabotSig !== "";
    if (flag === "--expect-signed" && !hasSig)
      fail(`pc_sign=true 的发布，${ymlName} 却没有 chisabotSig`);
    if (flag === "--expect-unsigned" && hasSig)
      fail(
        `CHISABOT_PC_UPDATE_UNSIGNED=1 的发布，${ymlName} 却带了 chisabotSig`,
      );
    return top;
  };

  if (!assets.includes("latest.yml")) fail("缺 latest.yml");
  const setups = assets.filter((f) => f.endsWith("-setup.exe"));
  if (setups.length !== 1)
    fail(`*-setup.exe 应该恰好一个，实际 ${setups.length} 个`);
  const winTop = checkManifest("latest.yml");
  if (winTop.path !== setups[0])
    fail(
      `latest.yml 的 path 是 ${winTop.path}，目录里的安装包是 ${setups[0]}：清单和安装包不是同一套`,
    );
  if (assets.includes("latest-mac.yml")) {
    // mac 清单在场时，至少一个 .app 更新包（*-mac.zip）必须跟着进 Release——没有它清单没有意义。
    if (!assets.some((f) => f.endsWith("-mac.zip")))
      fail("latest-mac.yml 在场，但没有任何 *-mac.zip 更新包");
    checkManifest("latest-mac.yml");
  } else if (assets.some((f) => /-mac\.(dmg|zip)$/.test(f))) {
    fail("有 mac 资产但没有 latest-mac.yml：mac 客户端无法更新，中止上传");
  }

  // 6. 构建过程文件不进 Release。
  for (const name of BUILD_FILES)
    fs.rmSync(path.join(dir, name), { force: true });
  console.log(
    `release assets ok: ${assets.sort().join(", ")}（generic，${
      flag === "--expect-signed" ? "signed" : "unsigned"
    }）`,
  );
  return 0;
}

const code = main(process.argv.slice(2));
if (code !== 0) process.exitCode = code;
