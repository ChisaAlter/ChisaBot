/*
 * Time-of-day sky (「背景随时间变化」). See DESIGN.md §7.
 *
 * `computeSky` is the ONE palette. It is also serialised with `Function.prototype.toString()` by the
 * `chisabot-sky-boot` Vite plugin and inlined into index.html, so the pre-JS skeleton paints the same
 * sky before React loads. That is why it must stay fully self-contained: no imports, no references
 * to anything outside its own body, plain syntax only.
 */

export type SkyVars = {
  /** Non-inherited, registered, transitioned props — set on <body> only (cheap to animate). */
  body: Record<string, string>;
  /** Inherited, unanimated readability knobs for the glass — set on <html>. */
  root: Record<string, string>;
};

export function computeSky(minuteOfDay: number, dark: boolean): SkyVars {
  // [minute, light, dark]; each palette: c1..c4 top→bottom, cloud, glow, stars, lift, muted.
  type P = [string, string, string, string, string, string, number, number, string];
  const night: [P, P] = [
    ["#5a6aa0", "#7b88b8", "#a3acd0", "#c9cee4", "rgba(225,230,250,0.30)", "rgba(235,240,255,0.50)", 0.6, 0.14, "#4b5262"],
    ["#070d1c", "#0c1730", "#13213f", "#1a2a4a", "rgba(90,120,190,0.12)", "rgba(170,190,240,0.20)", 0.85, 0, "#97a1b2"],
  ];
  const noon: [P, P] = [
    ["#6f9bc7", "#9dbddc", "#c9dbeb", "#e4ecf3", "rgba(255,255,255,0.75)", "rgba(255,255,240,0.45)", 0, 0, "#5f6673"],
    ["#0c1626", "#12203a", "#172a46", "#1b304d", "rgba(110,150,215,0.18)", "rgba(200,220,255,0.12)", 0, 0, "#97a1b2"],
  ];
  const keys: Array<[number, P, P]> = [
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

  const parse = (c: string): number[] => {
    if (c.charAt(0) === "#") {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1];
    }
    const m = c.slice(c.indexOf("(") + 1, c.indexOf(")")).split(",");
    return [Number(m[0]), Number(m[1]), Number(m[2]), m.length > 3 ? Number(m[3]) : 1];
  };
  const mix = (a: string, b: string, t: number, alphaScale: number): string => {
    const x = parse(a);
    const y = parse(b);
    const ch = (i: number) => Math.round(x[i] + (y[i] - x[i]) * t);
    const al = Math.round((x[3] + (y[3] - x[3]) * t) * alphaScale * 1000) / 1000;
    return `rgba(${ch(0)},${ch(1)},${ch(2)},${al})`;
  };
  const num = (a: number, b: number, t: number) => Math.round((a + (b - a) * t) * 1000) / 1000;

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
  let u: number;
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

/** Phase name for a minute of day, as shown next to the preview slider. */
export function skyPhaseName(minuteOfDay: number): string {
  const h = (((minuteOfDay % 1440) + 1440) % 1440) / 60;
  if (h >= 5 && h < 7) return "黎明";
  if (h >= 7 && h < 11) return "上午";
  if (h >= 11 && h < 15) return "正午";
  if (h >= 15 && h < 18) return "午后";
  if (h >= 18 && h < 20) return "黄昏";
  return "夜晚";
}

export function formatMinuteOfDay(minuteOfDay: number): string {
  const m = Math.round(((minuteOfDay % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const SKY_BODY_PROPS = [
  "--sky-1",
  "--sky-2",
  "--sky-3",
  "--sky-4",
  "--sky-cloud",
  "--sky-glow",
  "--sky-glow-x",
  "--sky-glow-y",
  "--sky-stars",
] as const;
export const SKY_ROOT_PROPS = ["--sky-lift", "--sky-muted"] as const;

export function applySky(sky: SkyVars | null) {
  const body = document.body.style;
  const root = document.documentElement.style;
  if (!sky) {
    for (const prop of SKY_BODY_PROPS) body.removeProperty(prop);
    for (const prop of SKY_ROOT_PROPS) root.removeProperty(prop);
    return;
  }
  for (const [prop, value] of Object.entries(sky.body)) body.setProperty(prop, value);
  for (const [prop, value] of Object.entries(sky.root)) root.setProperty(prop, value);
}

export function currentMinuteOfDay(now = new Date()): number {
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

/** Same key the boot script in index.html reads. "off" = fixed blue sky. */
export const SKY_STORAGE_KEY = "chisabot-sky";

/**
 * The inline boot script (vite plugin injects it as the first thing in <body>). It runs before the
 * skeleton paints, so first paint already has the right sky.
 */
export function skyBootScript(): string {
  return `(function(){try{if(window.localStorage.getItem(${JSON.stringify(SKY_STORAGE_KEY)})==="off")return;var computeSky=${computeSky.toString()};var n=new Date();var s=computeSky(n.getHours()*60+n.getMinutes()+n.getSeconds()/60,document.documentElement.classList.contains("dark"));var k;for(k in s.body)document.body.style.setProperty(k,s.body[k]);for(k in s.root)document.documentElement.style.setProperty(k,s.root[k]);document.documentElement.setAttribute("data-sky","time")}catch(e){}})();`;
}
