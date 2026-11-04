// 从 assets/brand/source.webp（品牌头像原图，朽叶千咲·白底半身像）生成所有图标：
// 网页 favicon / PWA、登录页、PC、Android；desktop/（Tauri）目录存在时才写。
// 用法：node assets/brand/generate.mjs        （依赖根目录 devDep sharp，无需 Python）

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const R = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(R, "assets", "brand", "source.webp");

// 新源图是 1254×1254 白底半身像：整图即胸像；≤64px 用脸部紧裁（眼鼻口占主画面）。
const srcBuf = await sharp(SRC).png().toBuffer();
const FACE_CROP = { left: 400, top: 150, width: 680, height: 680 }; // 1254 坐标（脸偏右构图）
const faceBuf = await sharp(srcBuf).extract(FACE_CROP).png().toBuffer();

const pick = (s) => (s <= 64 ? faceBuf : srcBuf);

async function sized(buf, s) {
  let p = sharp(buf).resize(s, s, { kernel: "lanczos3" });
  if (s <= 64) {
    p = p
      .modulate({ saturation: 1.12 })
      .linear(1.08, (1 - 1.08) * 128) // 对比度 +8%
      .sharpen({ sigma: 0.6, m1: 0.6, m2: 0.6 });
  } else if (s >= 600) {
    p = p.sharpen({ sigma: 1.2, m1: 0.4, m2: 0.4 });
  }
  return p.png().toBuffer();
}

// 圆 / 圆角遮罩：4× SVG 渲染再缩回，边缘抗锯齿与原脚本一致。
async function maskBuf(s, kind) {
  const S = s * 4;
  const shape =
    kind === "circle"
      ? `<circle cx="${S / 2}" cy="${S / 2}" r="${(S - 1) / 2}" fill="#fff"/>`
      : `<rect width="${S - 1}" height="${S - 1}" rx="${Math.round(S * (s > 32 ? 0.225 : 0.18))}" fill="#fff"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><rect width="100%" height="100%" fill="#000"/>${shape}</svg>`;
  return sharp(Buffer.from(svg))
    .resize(s, s, { kernel: "lanczos3" })
    .png()
    .toBuffer();
}

async function icon(s, kind = "square", buf = null) {
  const base = sharp(await sized(buf ?? pick(s), s)).ensureAlpha();
  if (kind === "square") return base.png().toBuffer();
  const mask = await maskBuf(s, kind);
  return base
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function save(pngBuf, rel) {
  const p = path.join(R, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  const img = sharp(pngBuf);
  const meta = await img.metadata();
  if (rel.endsWith(".webp")) await img.webp({ quality: 88 }).toFile(p);
  else if (rel.endsWith(".jpg"))
    await img
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 88, progressive: true })
      .toFile(p);
  else if (meta.width >= 128)
    await img
      .png({ palette: true, colors: 256, dither: 1.0, quality: 85 })
      .toFile(p);
  else await img.png().toFile(p);
  return p;
}

// ICO 容器：帧全部存 PNG（浏览器/系统均支持，体积最小）。
async function writeIco(rel, sizes, kind) {
  const frames = [];
  for (const s of sizes) frames.push([s, await icon(s, kind)]);
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  const parts = [head];
  frames.forEach(([s, data], i) => {
    head.writeUInt8(s < 256 ? s : 0, 6 + 16 * i);
    head.writeUInt8(s < 256 ? s : 0, 7 + 16 * i);
    head.writeUInt8(0, 8 + 16 * i);
    head.writeUInt8(0, 9 + 16 * i);
    head.writeUInt16LE(1, 10 + 16 * i);
    head.writeUInt16LE(32, 12 + 16 * i);
    head.writeUInt32LE(data.length, 14 + 16 * i);
    head.writeUInt32LE(offset, 18 + 16 * i);
    offset += data.length;
    parts.push(data);
  });
  const p = path.join(R, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(p, Buffer.concat(parts));
}

// ---- master brand files ----
await save(await sized(srcBuf, 1024), "assets/brand/chisabot-logo-1024.png");
await save(
  await icon(512, "circle"),
  "assets/brand/chisabot-logo-round-512.png",
);
await save(
  await icon(512, "rounded"),
  "assets/brand/chisabot-logo-rounded-512.png",
);
await save(await icon(64, "circle"), "assets/brand/chisabot-mark-64.png");
await save(await icon(256, "circle"), "docs/images/logo.png");

// ---- web app ----
await writeIco("app/public/favicon.ico", [16, 32, 48], "rounded");
await save(await icon(32, "rounded"), "app/public/favicon-32.png");
await save(await icon(16, "rounded"), "app/public/favicon-16.png");
await save(await icon(180, "square"), "app/public/apple-touch-icon.png");
await save(await icon(192, "square"), "app/public/icon-192.png");
await save(await icon(512, "square"), "app/public/icon-512.png");
await save(await icon(96, "circle"), "app/src/assets/brand/chisa-mark.png");
// PWA（DESIGN.md §40）：any = 圆角透明边；maskable = 满版方图（脸已在中央 80% 安全区）。
await save(await icon(192, "rounded"), "app/public/pwa-any-192.png");
await save(await icon(512, "rounded"), "app/public/pwa-any-512.png");
await save(await icon(192, "square"), "app/public/pwa-maskable-192.png");
await save(await icon(512, "square"), "app/public/pwa-maskable-512.png");

// ---- login gateway ----
await writeIco(
  "deploy/public/auth-web/brand/favicon.ico",
  [16, 32, 48],
  "rounded",
);
await save(
  await icon(32, "rounded"),
  "deploy/public/auth-web/brand/favicon-32.png",
);
await save(
  await icon(180, "square"),
  "deploy/public/auth-web/brand/apple-touch-icon.png",
);
await save(await icon(288, "circle"), "deploy/public/auth-web/brand/logo.png");

// ---- PC (Electron) ----
await save(await icon(512, "rounded"), "pc/assets/icon.png");
// pc/build/icon.ico + pc/build/icons/chisabot-<哈希>.ico：小尺寸 BMP、按内容哈希命名（见 win-icon.mjs）
spawnSync(process.execPath, [path.join(R, "pc", "scripts", "win-icon.mjs")], {
  stdio: "inherit",
});
await save(await icon(192, "circle"), "pc/src/ui/logo.png");

// 托盘徽标（32px 圆角底图 + 右下角状态点；offline = 灰度 + 提亮 + 80% 透明）
async function tray(kind) {
  const s = 32;
  let buf = await icon(s, "rounded");
  if (kind === "offline") {
    buf = await sharp(buf)
      .grayscale()
      .modulate({ brightness: 1.1 })
      .png()
      .toBuffer();
    const { data, info } = await sharp(buf)
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 3; i < data.length; i += info.channels)
      data[i] = Math.round(data[i] * 0.8);
    buf = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    })
      .png()
      .toBuffer();
    return buf;
  }
  const badge =
    kind === "online"
      ? `<circle cx="24.5" cy="24.5" r="7" fill="#fff"/><circle cx="24.5" cy="24.5" r="5" fill="#22c55e"/>`
      : `<circle cx="24" cy="24" r="7.5" fill="#fff"/><circle cx="24" cy="24" r="5.5" fill="#e5484d"/><rect x="21.5" y="21.5" width="5" height="5" fill="#fff"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">${badge}</svg>`;
  return sharp(buf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
for (const k of ["online", "offline", "paused"])
  await save(await tray(k), `pc/assets/tray-${k}.png`);

// ---- Android ----
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, f] of Object.entries(dens)) {
  const L = Math.round(48 * f),
    A = Math.round(108 * f);
  await save(
    await icon(L, "rounded"),
    `android/app/src/main/res/mipmap-${name}/ic_launcher.png`,
  );
  await save(
    await icon(L, "circle"),
    `android/app/src/main/res/mipmap-${name}/ic_launcher_round.png`,
  );
  const inner = Math.round((A * 80) / 108); // 72dp 可视区在 inner 内，图边不会露进 mask
  const fg = await sharp({
    create: {
      width: A,
      height: A,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: await sized(srcBuf, inner),
        top: Math.round((A - inner) / 2),
        left: Math.round((A - inner) / 2),
      },
    ])
    .png()
    .toBuffer();
  await save(
    fg,
    `android/app/src/main/res/mipmap-${name}/ic_launcher_foreground.png`,
  );
  // 新源图为白底：背景层纯白（旧版为海蓝 #66b4d4）
  const bg = await sharp({
    create: {
      width: A,
      height: A,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  await save(
    bg,
    `android/app/src/main/res/mipmap-${name}/ic_launcher_background.png`,
  );
}
await save(
  await icon(288, "circle"),
  "android/app/src/main/res/drawable-nodpi/splash_logo.png",
);

// ---- desktop/ (Tauri, upstream source; 目录存在才写) ----
const T = "desktop/src-tauri/icons/";
if (existsSync(path.join(R, "desktop", "src-tauri"))) {
  for (const [s, n] of [
    [32, "32x32.png"],
    [64, "64x64.png"],
    [128, "128x128.png"],
    [256, "128x128@2x.png"],
    [1024, "icon.png"],
    [30, "Square30x30Logo.png"],
    [44, "Square44x44Logo.png"],
    [71, "Square71x71Logo.png"],
    [89, "Square89x89Logo.png"],
    [107, "Square107x107Logo.png"],
    [142, "Square142x142Logo.png"],
    [150, "Square150x150Logo.png"],
    [284, "Square284x284Logo.png"],
    [310, "Square310x310Logo.png"],
    [50, "StoreLogo.png"],
  ])
    await save(await icon(s, "rounded"), T + n);
  await writeIco(`${T}icon.ico`, [16, 24, 32, 48, 64, 128, 256], "rounded");
}
console.log("ok");
