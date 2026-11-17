/**
 * 生成 app/public/wallpapers 的艺术壁纸 WebP（主图 1920×1080 + 缩略 480×270）。
 *
 * 用法：bun scripts/generate-wallpapers.ts [preset-id …]（不带参数生成全部 NEW_ART 条目）
 *
 * 每张图 = SVG 分层绘制 → sharp 栅格化 webp：
 *   底：多段线性渐变天空；中层：feTurbulence + feDisplacementMap 的有机笔触（山脊 / 田野 / 云絮）；
 *   点缀：星屑或光斑；覆盖：细颗粒噪点（painterly grain）。
 * 新增壁纸时往 NEW_ART 加一条，并在 app/src/lib/appearance.ts 的 ARTISTIC_WALLPAPER_PRESETS 里登记同名 id。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const OUT_DIR = path.join(import.meta.dir, "../app/public/wallpapers");
const W = 1920;
const H = 1080;
const TW = 480;
const TH = 270;

type Layer =
  | { kind: "ridge"; fill: string; y: number; amp: number; seed: number; opacity?: number }
  | { kind: "blobs"; fill: string; seed: number; opacity?: number; count?: number }
  | { kind: "stars"; count: number; color: string; seed: number }
  | { kind: "glow"; x: number; y: number; r: number; color: string };

type Art = {
  id: string;
  sky: [string, string, string, string];
  layers: Layer[];
};

/** 伪随机（可复现）：mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ridgePath(y: number, amp: number, seed: number): string {
  const r = rng(seed);
  const n = 9;
  const pts: string[] = [`M0 ${H}`, `L0 ${y + (r() - 0.5) * amp}`];
  for (let i = 1; i <= n; i++) {
    const x = (W / n) * i;
    const py = y + (r() - 0.5) * amp * 2;
    const cx = x - W / n / 2;
    pts.push(`Q${cx} ${y + (r() - 0.5) * amp * 2.4} ${x} ${py}`);
  }
  pts.push(`L${W} ${H}`, "Z");
  return pts.join(" ");
}

function blobs(fill: string, seed: number, count: number): string {
  const r = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const cx = r() * W;
    const cy = r() * H * 0.7;
    const rx = 140 + r() * 420;
    const ry = 80 + r() * 200;
    const o = 0.25 + r() * 0.4;
    out.push(
      `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${rx.toFixed(0)}" ry="${ry.toFixed(0)}" fill="${fill}" opacity="${o.toFixed(2)}"/>`,
    );
  }
  return out.join("");
}

function stars(count: number, color: string, seed: number): string {
  const r = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = r() * W;
    const y = r() * H * 0.75;
    const rad = 0.8 + r() * 2.4;
    const o = 0.35 + r() * 0.6;
    out.push(
      `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${rad.toFixed(1)}" fill="${color}" opacity="${o.toFixed(2)}"/>`,
    );
  }
  return out.join("");
}

function svg(art: Art): string {
  const [s0, s1, s2, s3] = art.sky;
  const body: string[] = [];
  for (const [i, l] of art.layers.entries()) {
    if (l.kind === "ridge") {
      body.push(
        `<g filter="url(#disp)"><path d="${ridgePath(l.y, l.amp, l.seed)}" fill="${l.fill}" opacity="${l.opacity ?? 1}"/></g>`,
      );
    } else if (l.kind === "blobs") {
      body.push(
        `<g filter="url(#blur)">${blobs(l.fill, l.seed + i * 7, l.count ?? 7)}</g>`,
      );
    } else if (l.kind === "stars") {
      body.push(stars(l.count, l.color, l.seed));
    } else {
      body.push(
        `<circle cx="${l.x}" cy="${l.y}" r="${l.r}" fill="url(#glow${i})"/>`,
      );
    }
  }
  const glowDefs = art.layers
    .map((l, i) =>
      l.kind === "glow"
        ? `<radialGradient id="glow${i}"><stop offset="0%" stop-color="${l.color}" stop-opacity=".85"/><stop offset="100%" stop-color="${l.color}" stop-opacity="0"/></radialGradient>`
        : "",
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="${s0}"/><stop offset="45%" stop-color="${s1}"/><stop offset="78%" stop-color="${s2}"/><stop offset="100%" stop-color="${s3}"/>
</linearGradient>
<filter id="disp" x="-10%" y="-30%" width="120%" height="160%">
<feTurbulence type="fractalNoise" baseFrequency="0.004 0.02" numOctaves="3" seed="7" result="n"/>
<feDisplacementMap in="SourceGraphic" in2="n" scale="60"/>
</filter>
<filter id="blur" x="-30%" y="-30%" width="160%" height="160%">
<feGaussianBlur stdDeviation="42"/>
</filter>
<filter id="grain">
<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="11" result="n"/>
<feColorMatrix in="n" type="matrix" values="0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0.06 0"/>
<feComposite in2="SourceGraphic" operator="over"/>
</filter>
${glowDefs}
</defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
${body.join("\n")}
<rect width="${W}" height="${H}" fill="#fff" opacity="0" filter="url(#grain)"/>
</svg>`;
}

const NEW_ART: Art[] = [
  {
    id: "lavender-provence",
    sky: ["#f0d8b8", "#d8b8d0", "#a88ac0", "#7a68a8"],
    layers: [
      { kind: "glow", x: 560, y: 300, r: 340, color: "#f8e0b0" },
      { kind: "blobs", fill: "#c8a8d8", seed: 3, count: 6 },
      { kind: "ridge", fill: "#9a7ec0", y: 700, amp: 60, seed: 5 },
      { kind: "ridge", fill: "#7a5ea0", y: 800, amp: 70, seed: 9 },
      { kind: "ridge", fill: "#584080", y: 900, amp: 80, seed: 13 },
    ],
  },
  {
    id: "venice-glow",
    sky: ["#e8a860", "#c87858", "#4a7080", "#1e4858"],
    layers: [
      { kind: "glow", x: 960, y: 420, r: 380, color: "#f8d080" },
      { kind: "blobs", fill: "#80b8c0", seed: 4, count: 5 },
      { kind: "ridge", fill: "#3a6070", y: 620, amp: 50, seed: 21 },
      { kind: "ridge", fill: "#28485a", y: 780, amp: 40, seed: 27 },
      { kind: "ridge", fill: "#163040", y: 900, amp: 50, seed: 33 },
    ],
  },
  {
    id: "red-maple",
    sky: ["#f0e0c8", "#e0b898", "#c87860", "#8a4848"],
    layers: [
      { kind: "glow", x: 1360, y: 260, r: 300, color: "#f8e8b8" },
      { kind: "blobs", fill: "#d86858", seed: 8, count: 8 },
      { kind: "ridge", fill: "#7a5850", y: 680, amp: 80, seed: 41 },
      { kind: "ridge", fill: "#a84a40", y: 800, amp: 90, seed: 47 },
      { kind: "ridge", fill: "#682828", y: 920, amp: 70, seed: 53 },
    ],
  },
  {
    id: "snow-river",
    sky: ["#eef1f4", "#d8e0e6", "#a8b8c2", "#68797f"],
    layers: [
      { kind: "blobs", fill: "#f4f7f9", seed: 6, count: 7 },
      { kind: "ridge", fill: "#b0bcc4", y: 640, amp: 90, seed: 61, opacity: 0.85 },
      { kind: "ridge", fill: "#7d8d95", y: 780, amp: 70, seed: 67, opacity: 0.9 },
      { kind: "ridge", fill: "#46565e", y: 910, amp: 60, seed: 73 },
    ],
  },
  {
    id: "nebula-drift",
    sky: ["#070d1e", "#141a3a", "#3a2a5e", "#6a4a8a"],
    layers: [
      { kind: "blobs", fill: "#7a5cc8", seed: 10, count: 9 },
      { kind: "blobs", fill: "#d088b8", seed: 12, count: 5 },
      { kind: "glow", x: 620, y: 380, r: 300, color: "#b8a0e8" },
      { kind: "stars", count: 180, color: "#eef2ff", seed: 15 },
      { kind: "ridge", fill: "#10182e", y: 960, amp: 60, seed: 81 },
    ],
  },
  {
    id: "dune-gold",
    sky: ["#f0cf9a", "#e0ac6c", "#b87848", "#7a4c2e"],
    layers: [
      { kind: "glow", x: 1500, y: 220, r: 280, color: "#fbe8c0" },
      { kind: "ridge", fill: "#c89058", y: 660, amp: 110, seed: 91 },
      { kind: "ridge", fill: "#a06838", y: 790, amp: 120, seed: 97 },
      { kind: "ridge", fill: "#6e4020", y: 930, amp: 100, seed: 103 },
    ],
  },
];

const only = process.argv.slice(2);
const targets = only.length
  ? NEW_ART.filter((a) => only.includes(a.id))
  : NEW_ART;

mkdirSync(OUT_DIR, { recursive: true });
for (const art of targets) {
  const markup = svg(art);
  const full = path.join(OUT_DIR, `${art.id}.webp`);
  const thumb = path.join(OUT_DIR, `${art.id}-thumb.webp`);
  await sharp(Buffer.from(markup), { density: 144 })
    .webp({ quality: 82 })
    .toFile(full);
  await sharp(Buffer.from(markup), { density: 144 })
    .resize(TW, TH)
    .webp({ quality: 78 })
    .toFile(thumb);
  console.log(`generated ${art.id} (${full}, ${thumb})`);
}
