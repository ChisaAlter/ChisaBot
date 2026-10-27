import { AVATAR_SHAPES, type AvatarShape, type ShapeColor } from "../../../../shared/bot-avatars";

/**
 * 头像形状（DESIGN.md §81）。每个形状是围着中心的 32 个半径，转成同样结构的闭合平滑曲线，
 * 所以任意两个形状之间都能逐点插值（变形），不需要路径插值库。
 * 画布 100×100，形状居中、最大半径 ≤ 47。眼睛的位置 / 倾斜 / 大小跟着形状走，一起插值。
 */
export const SHAPE_ANCHORS = 32;
const TAU = Math.PI * 2;
const UP = -Math.PI / 2;

/** 离「正上方」多远，-π..π。 */
const fromUp = (t: number) => ((((t - UP + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

/** |x/a|^n + |y/b|^n = 1，转 rot；n 越大越方。 */
const superellipse = (a: number, b: number, n: number, rot = 0) => (t: number) => {
  const c = Math.abs(Math.cos(t - rot));
  const s = Math.abs(Math.sin(t - rot));
  return ((c / a) ** n + (s / b) ** n) ** (-1 / n);
};

/** 正 m 边形，k 越大角越圆。 */
const polygon = (m: number, rot: number, radius: number, k: number) => (t: number) => {
  const seg = TAU / m;
  const apothem = radius * Math.cos(Math.PI / m);
  const local = ((((t - rot) % seg) + seg) % seg) - seg / 2;
  const edge = apothem / Math.cos(local);
  const round = apothem + (radius - apothem) * 0.35;
  return edge * (1 - k) + round * k;
};

const RADIUS: Record<AvatarShape, (t: number) => number> = {
  round: () => 44,
  // 圆润的瓣、谷底是尖的：像云。
  cloud: (t) => 33 + 11 * Math.abs(Math.sin(3 * t + 0.5)) ** 0.55,
  tile: superellipse(39, 39, 3.8, 0.2),
  sparkle: (t) => 27 + 18 * Math.abs(Math.cos(2 * t)) ** 1.7,
  bloom: (t) => 38 + 6 * Math.cos(5 * (t - UP)),
  bean: (t) => 38 + 5 * Math.cos(t - 0.6) + 3 * Math.cos(2 * t + 1) + 2 * Math.cos(3 * t),
  scallop: (t) => 38 + 3.5 * Math.cos(8 * t),
  drop: (t) => 33 + 12 * Math.exp(-((fromUp(t) / 0.55) ** 2)),
  pill: superellipse(46, 30, 2.8),
  tri: polygon(3, 0, 50, 0.12),
  hex: polygon(6, 0, 47, 0.3),
  burst: (t) => 31 + 12 * Math.abs(Math.cos(4 * t)) ** 0.8,
  gem: superellipse(40, 40, 2.6, Math.PI / 4),
  fruit: (t) => 41 - 9 * Math.exp(-((fromUp(t) / 0.22) ** 2)) + 2 * Math.cos(2 * t),
};

/** 眼睛（一对竖条）：中心、两眼间距、缩放、倾斜。 */
export type Face = { x: number; y: number; gap: number; scale: number; rot: number };

const FACE: Record<AvatarShape, Face> = {
  round: { x: 50, y: 48, gap: 17, scale: 1, rot: 0 },
  cloud: { x: 50, y: 49, gap: 17, scale: 1, rot: 0 },
  tile: { x: 50, y: 50, gap: 17, scale: 1, rot: 10 },
  sparkle: { x: 50, y: 50, gap: 14, scale: 0.75, rot: 0 },
  bloom: { x: 50, y: 50, gap: 17, scale: 1, rot: 0 },
  bean: { x: 48, y: 50, gap: 17, scale: 1, rot: -8 },
  scallop: { x: 50, y: 49, gap: 17, scale: 1, rot: 0 },
  drop: { x: 50, y: 58, gap: 16, scale: 0.95, rot: 0 },
  pill: { x: 50, y: 50, gap: 24, scale: 1, rot: 0 },
  tri: { x: 45, y: 50, gap: 15, scale: 0.9, rot: 0 },
  hex: { x: 50, y: 50, gap: 17, scale: 1, rot: 0 },
  burst: { x: 50, y: 50, gap: 14, scale: 0.8, rot: 0 },
  gem: { x: 50, y: 50, gap: 16, scale: 0.95, rot: 0 },
  fruit: { x: 50, y: 52, gap: 17, scale: 1, rot: 0 },
};

export type ShapeGeometry = { radii: number[]; dx: number; dy: number; face: Face };

function build(shape: AvatarShape): ShapeGeometry {
  const radii = Array.from({ length: SHAPE_ANCHORS }, (_, i) => Math.min(47, Math.max(12, RADIUS[shape]((i / SHAPE_ANCHORS) * TAU))));
  const xs = radii.map((r, i) => r * Math.cos((i / SHAPE_ANCHORS) * TAU));
  const ys = radii.map((r, i) => r * Math.sin((i / SHAPE_ANCHORS) * TAU));
  // 形状不一定关于中心对称（水滴、三角）：按外框居中，免得头像看起来偏。
  const dx = -(Math.min(...xs) + Math.max(...xs)) / 2;
  const dy = -(Math.min(...ys) + Math.max(...ys)) / 2;
  const face = FACE[shape];
  return { radii, dx, dy, face: { ...face, x: face.x + dx, y: face.y + dy } };
}

export const SHAPES: Record<AvatarShape, ShapeGeometry> = Object.fromEntries(AVATAR_SHAPES.map((shape) => [shape, build(shape)])) as Record<AvatarShape, ShapeGeometry>;

/** 闭合的 Catmull-Rom → 三次贝塞尔：平滑，所有形状的路径命令结构完全一样。 */
export function shapePath(geometry: ShapeGeometry): string {
  const { radii, dx, dy } = geometry;
  const n = radii.length;
  const point = (i: number) => {
    const t = ((((i % n) + n) % n) / n) * TAU;
    const r = radii[((i % n) + n) % n]!;
    return [50 + dx + r * Math.cos(t), 50 + dy + r * Math.sin(t)] as const;
  };
  const f = (v: number) => v.toFixed(2);
  const first = point(0);
  let d = `M${f(first[0])} ${f(first[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = point(i - 1);
    const p1 = point(i);
    const p2 = point(i + 1);
    const p3 = point(i + 2);
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 两个形状之间 t（0..1）处的样子。 */
export function mixShapes(a: ShapeGeometry, b: ShapeGeometry, t: number): ShapeGeometry {
  return {
    radii: a.radii.map((r, i) => lerp(r, b.radii[i]!, t)),
    dx: lerp(a.dx, b.dx, t),
    dy: lerp(a.dy, b.dy, t),
    face: {
      x: lerp(a.face.x, b.face.x, t),
      y: lerp(a.face.y, b.face.y, t),
      gap: lerp(a.face.gap, b.face.gap, t),
      scale: lerp(a.face.scale, b.face.scale, t),
      rot: lerp(a.face.rot, b.face.rot, t),
    },
  };
}

export const SHAPE_COLOR_HEX: Record<ShapeColor, string> = {
  ink: "#16161a",
  brown: "#a0693a",
  red: "#ff2d46",
  orange: "#ff6a13",
  amber: "#f7931e",
  green: "#12c26a",
  teal: "#14b8a6",
  blue: "#2188ff",
  violet: "#9b59f5",
  pink: "#ff3d9a",
  gray: "#8e8e93",
};

export const SHAPE_COLOR_LABEL: Record<ShapeColor, string> = {
  ink: "黑",
  brown: "棕",
  red: "红",
  orange: "橙",
  amber: "琥珀",
  green: "绿",
  teal: "青",
  blue: "蓝",
  violet: "紫",
  pink: "粉",
  gray: "灰",
};

export const SHAPE_LABEL: Record<AvatarShape, string> = {
  round: "圆团",
  cloud: "云朵",
  tile: "方块",
  sparkle: "闪光",
  bloom: "花瓣",
  bean: "豆豆",
  scallop: "波浪",
  drop: "水滴",
  pill: "胶囊",
  tri: "三角",
  hex: "六边",
  burst: "星爆",
  gem: "菱形",
  fruit: "果子",
};