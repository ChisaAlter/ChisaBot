"use strict";
/* 由 pc/scripts/sync-skyglass.mjs 从 app/src/lib/sky.ts 生成，请勿手改。 */
function computeSky(minuteOfDay, dark) {
  // [minute, light, dark]; each palette: c1..c4 top→bottom, cloud, glow, stars, lift, muted.
  const night = [
    ["#5a6aa0", "#7b88b8", "#a3acd0", "#c9cee4", "rgba(225,230,250,0.30)", "rgba(235,240,255,0.50)", 0.6, 0.14, "#4b5262"],
    ["#070d1c", "#0c1730", "#13213f", "#1a2a4a", "rgba(90,120,190,0.12)", "rgba(170,190,240,0.20)", 0.85, 0, "#97a1b2"],
  ];
  const noon = [
    ["#6f9bc7", "#9dbddc", "#c9dbeb", "#e4ecf3", "rgba(255,255,255,0.75)", "rgba(255,255,240,0.45)", 0, 0, "#5f6673"],
    ["#0c1626", "#12203a", "#172a46", "#1b304d", "rgba(110,150,215,0.18)", "rgba(200,220,255,0.12)", 0, 0, "#97a1b2"],
  ];
  const keys = [
    [0, night[0], night[1]],
    [270, night[0], night[1]],
    // 05:30 拂晓 — lavender
    [330,
      ["#7d7fb4", "#a99cc8", "#d6bfd6", "#efdcdc", "rgba(255,240,245,0.45)", "rgba(255,200,190,0.40)", 0.2, 0.08, "#565c6a"],
      ["#11132a", "#1f1d3d", "#34294a", "#44324f", "rgba(150,110,170,0.14)", "rgba(220,140,150,0.20)", 0.4, 0, "#97a1b2"]],
    // 06:30 黎明 — peach / lavender
    [390,
      ["#9aa6d6", "#c9b6dc", "#f2cdd0", "#fde3cf", "rgba(255,248,245,0.60)", "rgba(255,214,170,0.65)", 0, 0.04, "#5a6070"],
      ["#1a2140", "#2f2c4f", "#4a3550", "#5a3f4f", "rgba(200,140,150,0.14)", "rgba(240,170,130,0.25)", 0.05, 0, "#97a1b2"]],
    // 08:30 上午 — fresh light blue
    [510,
      ["#84aee0", "#a9cbeb", "#d3e5f4", "#edf4fa", "rgba(255,255,255,0.75)", "rgba(255,250,230,0.50)", 0, 0, "#5f6673"],
      ["#0f1c33", "#16294a", "#1e3558", "#264064", "rgba(120,160,220,0.18)", "rgba(200,220,255,0.14)", 0, 0, "#97a1b2"]],
    // 11:30–14:30 正午 — the classic blue sky
    [690, noon[0], noon[1]],
    [870, noon[0], noon[1]],
    // 16:30 午后 — warm gold
    [990,
      ["#7ea3c9", "#b9c7d6", "#ead8b8", "#f6e6c8", "rgba(255,248,232,0.65)", "rgba(255,214,140,0.60)", 0, 0, "#5c6270"],
      ["#10192c", "#1e2638", "#33302f", "#3e3730", "rgba(200,160,110,0.13)", "rgba(240,190,110,0.20)", 0, 0, "#97a1b2"]],
    // 17:45 傍晚 — amber
    [1065,
      ["#8a98c0", "#d2b9a8", "#f0c48e", "#f9dcb4", "rgba(255,236,210,0.55)", "rgba(255,180,100,0.65)", 0, 0.03, "#595e6a"],
      ["#141a2e", "#2a2433", "#45302a", "#52382c", "rgba(220,150,90,0.14)", "rgba(250,160,80,0.26)", 0, 0, "#97a1b2"]],
    // 18:45 黄昏 — sunset pink / purple
    [1125,
      ["#7a74ad", "#c48aae", "#f2a99a", "#f9cfb0", "rgba(255,220,220,0.45)", "rgba(255,150,120,0.60)", 0.05, 0.07, "#535866"],
      ["#15142c", "#2c1f3b", "#4a2a44", "#5a3343", "rgba(220,120,140,0.14)", "rgba(250,130,110,0.24)", 0.1, 0, "#97a1b2"]],
    // 19:45 入夜 — dusk blue-violet
    [1185,
      ["#5f639e", "#8f84b8", "#c4a8c8", "#e2cad6", "rgba(240,225,245,0.35)", "rgba(220,170,200,0.35)", 0.3, 0.11, "#4e5463"],
      ["#0d1024", "#181a38", "#262646", "#2f2c4c", "rgba(140,120,190,0.12)", "rgba(180,150,210,0.16)", 0.5, 0, "#97a1b2"]],
    // 21:00 → 24:00 夜晚
    [1260, night[0], night[1]],
    [1440, night[0], night[1]],
  ];

  const parse = (c) => {
    if (c.charAt(0) === "#") {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1];
    }
    const m = c.slice(c.indexOf("(") + 1, c.indexOf(")")).split(",");
    return [Number(m[0]), Number(m[1]), Number(m[2]), m.length > 3 ? Number(m[3]) : 1];
  };
  const mix = (a, b, t, alphaScale) => {
    const x = parse(a);
    const y = parse(b);
    const ch = (i) => Math.round(x[i] + (y[i] - x[i]) * t);
    const al = Math.round((x[3] + (y[3] - x[3]) * t) * alphaScale * 1000) / 1000;
    return `rgba(${ch(0)},${ch(1)},${ch(2)},${al})`;
  };
  const num = (a, b, t) => Math.round((a + (b - a) * t) * 1000) / 1000;

  let m = ((minuteOfDay % 1440) + 1440) % 1440;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] <= m) i++;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const span = k1[0] - k0[0];
  let t = span > 0 ? (m - k0[0]) / span : 0;
  t = t * t * (3 - 2 * t); // smoothstep: eases in and out of every keyframe
  const p0 = dark ? k0[2] : k0[1];
  const p1 = dark ? k1[2] : k1[1];

  // Sun from 05:30 to 19:30, moon the rest; both sit at the horizon (and fade out) at the hand-over.
  const rise = 330;
  const set = 1170;
  let u;
  if (m >= rise && m < set) {
    u = (m - rise) / (set - rise);
  } else {
    if (m < rise) m += 1440;
    u = (m - set) / (rise + 1440 - set);
  }
  const arc = Math.sin(Math.PI * u);
  const fade = Math.min(1, arc * 6);

  return {
    body: {
      "--sky-1": mix(p0[0], p1[0], t, 1),
      "--sky-2": mix(p0[1], p1[1], t, 1),
      "--sky-3": mix(p0[2], p1[2], t, 1),
      "--sky-4": mix(p0[3], p1[3], t, 1),
      "--sky-cloud": mix(p0[4], p1[4], t, 1),
      "--sky-glow": mix(p0[5], p1[5], t, fade),
      "--sky-glow-x": `${Math.round((8 + 84 * u) * 10) / 10}%`,
      "--sky-glow-y": `${Math.round((80 - 64 * arc) * 10) / 10}%`,
      "--sky-stars": String(num(p0[6], p1[6], t)),
    },
    root: {
      "--sky-lift": String(num(p0[7], p1[7], t)),
      "--sky-muted": mix(p0[8], p1[8], t, 1),
    },
  };
}

if (typeof module !== "undefined") module.exports = { computeSky };
