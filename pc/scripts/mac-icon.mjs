// macOS 图标（pc/build/icon.icns）：与 Windows 图标同一构图——assets/brand/source.webp 整幅胸像 + 圆角，
// 小尺寸（≤64px）保留饱和/对比/锐化增强（和 win-icon.mjs 同一套 sized()）。
//
// 需要 macOS：图标格式 icns 用系统自带 iconutil 打包（CI macos-latest 有）。iconset 是中间产物，不进仓库。
//
// 用法：node pc/scripts/mac-icon.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const PC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(PC, "..");
const SRC = path.join(ROOT, "assets", "brand", "source.webp");
const ICONSET = path.join(PC, "build", "icon.iconset");
const OUT = path.join(PC, "build", "icon.icns");

// iconset 的 1x/2x 网格；iconutil 据此产出 Retina 各档。
const FRAMES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

const srcBuf = await sharp(SRC).png().toBuffer();

async function sized(buf, s) {
  let p = sharp(buf).resize(s, s, { kernel: "lanczos3" });
  if (s <= 64)
    p = p
      .modulate({ saturation: 1.12 })
      .linear(1.08, (1 - 1.08) * 128)
      .sharpen({ sigma: 0.6, m1: 0.6, m2: 0.6 });
  return p.png().toBuffer();
}

async function roundedMask(s) {
  const S = s * 4;
  const r = Math.round(S * (s > 32 ? 0.225 : 0.18));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><rect width="${S - 1}" height="${S - 1}" rx="${r}" fill="#fff"/></svg>`;
  return sharp(Buffer.from(svg)).resize(s, s, { kernel: "lanczos3" }).png().toBuffer();
}

async function frame(s) {
  const base = sharp(await sized(srcBuf, s)).ensureAlpha();
  const mask = await roundedMask(s);
  return base.composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

if (process.platform !== "darwin") {
  console.error("mac-icon.mjs 需要 macOS（iconutil）；在 mac 或 CI macos-latest 上运行。");
  process.exit(1);
}

rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });
for (const [name, s] of FRAMES) {
  await sharp(await frame(s)).toFile(path.join(ICONSET, name));
}
execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", OUT]);
rmSync(ICONSET, { recursive: true, force: true });
console.log(path.relative(ROOT, OUT));
