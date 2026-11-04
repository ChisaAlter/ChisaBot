// Windows 图标（pc/build/icon.ico + pc/build/icons/chisabot-<哈希>.ico），docs/online-update.md §2.1。
//
// 为什么单独一个脚本：
//   1. 小尺寸（16–48）存成 32 位 BMP（DIB + 透明通道），64 以上存 PNG——这是 Windows 自己的图标格式建议；
//      全是 PNG 的 .ico 在部分资源管理器 / 旧控件的小图标路径上会退回默认图标或用缓存里的旧图。
//   2. 尺寸补全 Windows 缩放会用到的 20 / 40 / 96（125% / 150% / 200% 的小图标、任务栏、开始菜单）。
//   3. 同一份图标再按内容哈希命名一份放进 build/icons/（打包到 resources/icons/）：快捷方式的图标指向这个
//      新文件名，资源管理器的图标缓存里从来没有这个路径，换了图标就一定按新文件读，不会继续显示旧图标。
//
// 用法：node pc/scripts/win-icon.mjs   （源图 assets/brand/source.webp，裁切和
// assets/brand/generate.mjs 一致：≤64px 用更紧的脸部裁切，圆角）
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const PC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(PC, "..");
const SRC = path.join(ROOT, "assets", "brand", "source.webp");
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const BMP_MAX = 48;

const srcBuf = await sharp(SRC).png().toBuffer();
const FACE_CROP = { left: 400, top: 150, width: 680, height: 680 }; // 与 generate.mjs 一致（1254 坐标）
const faceBuf = await sharp(srcBuf).extract(FACE_CROP).png().toBuffer();

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
  const base = sharp(await sized(s <= 64 ? faceBuf : srcBuf, s)).ensureAlpha();
  const mask = await roundedMask(s);
  return base.composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

// 32 位 BMP 图标帧：BITMAPINFOHEADER（高度 ×2）+ 自下而上的 BGRA + 全 0 的 1 位 AND 掩码。
async function dib(pngBuf) {
  const { data, info } = await sharp(pngBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const bgra = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4, di = ((h - 1 - y) * w + x) * 4;
      bgra[di] = data[si + 2]; bgra[di + 1] = data[si + 1];
      bgra[di + 2] = data[si]; bgra[di + 3] = data[si + 3];
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
  const maskRow = Math.floor((w + 31) / 32) * 4;
  return Buffer.concat([header, bgra, Buffer.alloc(maskRow * h)]);
}

async function build() {
  const blobs = [];
  for (const s of SIZES) {
    const im = await frame(s);
    blobs.push([s, s <= BMP_MAX ? await dib(im) : im]);
  }
  const head = Buffer.alloc(6 + 16 * blobs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(blobs.length, 4);
  let offset = head.length;
  const parts = [head];
  blobs.forEach(([s, data], i) => {
    head.writeUInt8(s < 256 ? s : 0, 6 + 16 * i);
    head.writeUInt8(s < 256 ? s : 0, 7 + 16 * i);
    head.writeUInt8(0, 8 + 16 * i); head.writeUInt8(0, 9 + 16 * i);
    head.writeUInt16LE(1, 10 + 16 * i); head.writeUInt16LE(32, 12 + 16 * i);
    head.writeUInt32LE(data.length, 14 + 16 * i);
    head.writeUInt32LE(offset, 18 + 16 * i);
    offset += data.length;
    parts.push(data);
  });
  return Buffer.concat(parts);
}

const data = await build();
writeFileSync(path.join(PC, "build", "icon.ico"), data);
const icons = path.join(PC, "build", "icons");
mkdirSync(icons, { recursive: true });
for (const name of readdirSync(icons)) if (name.endsWith(".ico")) rmSync(path.join(icons, name));
const name = `chisabot-${createHash("sha256").update(data).digest("hex").slice(0, 12)}.ico`;
writeFileSync(path.join(icons, name), data);
console.log(name, data.length);
