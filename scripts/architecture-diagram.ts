/**
 * Draws the ChisaBot architecture as a hand-drawn SVG, one file per colour scheme.
 *
 * rough.js is the same engine Excalidraw draws with, so the shapes get the wobble of a whiteboard
 * rather than the machine-perfect boxes of a Mermaid render. The seed is fixed, so regenerating
 * produces byte-identical output and the diagram does not churn in diffs.
 */
import { RoughGenerator } from "roughjs/bin/generator.js";

const W = 1420;
const H = 852;

type Theme = {
  name: string;
  paper: string;
  ink: string;
  muted: string;
  faint: string;
  gate: string;
  allow: string;
  refuse: string;
  bring: string;
  fillWeight: number;
};

const LIGHT: Theme = {
  name: "light",
  paper: "#fffefb",
  ink: "#1f2328",
  muted: "#5b6570",
  faint: "#aeb6bf",
  gate: "#f59e0b",
  allow: "#10b981",
  refuse: "#ef4444",
  bring: "#6366f1",
  fillWeight: 1.1,
};

const DARK: Theme = {
  name: "dark",
  paper: "#0f1216",
  ink: "#e9edf2",
  muted: "#98a3b0",
  faint: "#4a5361",
  gate: "#f0b429",
  allow: "#34d399",
  refuse: "#f87171",
  bring: "#8b8ff5",
  fillWeight: 0.9,
};

const FONT = `ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/** Rough's randomness is seeded per shape, so every run draws the same wobble. */
let seed = 1;
const nextSeed = () => (seed = (seed * 1103515245 + 12345) % 2147483648);

const gen = new RoughGenerator();
const out: string[] = [];

function escapeText(body: string): string {
  return body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function draw(drawable: ReturnType<RoughGenerator["rectangle"]>): void {
  for (const path of gen.toPaths(drawable)) {
    const fill = path.fill ?? "none";
    const stroke = path.stroke ?? "none";
    out.push(
      `<path d="${path.d}" fill="${fill}" stroke="${stroke}" stroke-width="${path.strokeWidth ?? 1}" ` +
        `stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }
}

type BoxOptions = {
  stroke: string;
  fill?: string;
  strokeWidth?: number;
  dashed?: boolean;
  roughness?: number;
};

function box(
  x: number,
  y: number,
  w: number,
  h: number,
  t: Theme,
  o: BoxOptions,
): void {
  draw(
    gen.rectangle(x, y, w, h, {
      seed: nextSeed(),
      stroke: o.stroke,
      strokeWidth: o.strokeWidth ?? 1.6,
      roughness: o.roughness ?? 1.15,
      bowing: 1.4,
      fill: o.fill,
      fillStyle: "solid",
      fillWeight: t.fillWeight,
      strokeLineDash: o.dashed ? [9, 7] : undefined,
    }),
  );
}

type TextOptions = {
  size?: number;
  fill?: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  spacing?: number;
  italic?: boolean;
};

function text(x: number, y: number, body: string, o: TextOptions = {}): void {
  out.push(
    `<text x="${x}" y="${y}" font-family='${FONT}' font-size="${o.size ?? 14}" ` +
      `font-weight="${o.weight ?? 400}" fill="${o.fill}" text-anchor="${o.anchor ?? "start"}" ` +
      `${o.spacing ? `letter-spacing="${o.spacing}" ` : ""}` +
      `${o.italic ? `font-style="italic" ` : ""}` +
      `>${escapeText(body)}</text>`,
  );
}

/** A stack of small lines inside a box, returning the y it finished on. */
function lines(
  x: number,
  y: number,
  items: string[],
  t: Theme,
  size = 13.5,
  step = 21,
): number {
  let cursor = y;
  for (const item of items) {
    text(x, cursor, item, { size, fill: t.muted });
    cursor += step;
  }
  return cursor;
}

function arrowHead(
  x: number,
  y: number,
  angle: number,
  colour: string,
  scale = 1,
): void {
  const len = 13 * scale;
  const spread = 0.42;
  const a = [
    x - len * Math.cos(angle - spread),
    y - len * Math.sin(angle - spread),
  ];
  const b = [
    x - len * Math.cos(angle + spread),
    y - len * Math.sin(angle + spread),
  ];
  draw(
    gen.polygon(
      [
        [x, y],
        [a[0] as number, a[1] as number],
        [b[0] as number, b[1] as number],
      ],
      {
        seed: nextSeed(),
        stroke: colour,
        strokeWidth: 1.3,
        roughness: 0.7,
        fill: colour,
        fillStyle: "solid",
        fillWeight: 2,
      },
    ),
  );
}

type ArrowOptions = {
  colour: string;
  width?: number;
  dashed?: boolean;
  head?: boolean;
  tailHead?: boolean;
};

function arrow(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  o: ArrowOptions,
): void {
  draw(
    gen.line(x1, y1, x2, y2, {
      seed: nextSeed(),
      stroke: o.colour,
      strokeWidth: o.width ?? 1.6,
      roughness: 0.9,
      bowing: 1.5,
      strokeLineDash: o.dashed ? [8, 6] : undefined,
    }),
  );
  const angle = Math.atan2(y2 - y1, x2 - x1);
  if (o.head !== false) arrowHead(x2, y2, angle, o.colour);
  if (o.tailHead) arrowHead(x1, y1, angle + Math.PI, o.colour);
}

function label(
  x: number,
  y: number,
  body: string,
  colour: string,
  anchor: "start" | "middle" | "end" = "middle",
): void {
  text(x, y, body, { size: 12.5, fill: colour, anchor, weight: 500 });
}

function render(t: Theme): string {
  seed = 1;
  out.length = 0;

  out.push(`<rect width="${W}" height="${H}" fill="${t.paper}"/>`);

  // Keep the existing whiteboard style; show runtime and product ownership separately.
  text(64, 56, "ChisaBot", { size: 26, weight: 700, fill: t.ink });
  text(
    64,
    82,
    "DSH runs the model loop; ChisaBot owns permissions, durable work and delivery.",
    {
      size: 15,
      fill: t.muted,
    },
  );

  // ---- execution and model history, along the top ------------------------
  const hostX = 372;
  const hostY = 126;
  const hostW = 476;
  const hostH = 114;
  box(hostX, hostY, hostW, hostH, t, { stroke: t.bring, strokeWidth: 2 });
  text(hostX + 22, hostY + 34, "DSH Host · Node.js", {
    size: 18,
    weight: 700,
    fill: t.bring,
  });
  lines(
    hostX + 22,
    hostY + 60,
    [
      "one isolated runtime per account",
      "model / tool loop · streaming · stop / resume",
    ],
    t,
    13.5,
    24,
  );

  box(64, hostY, 232, hostH, t, { stroke: t.muted, dashed: true });
  text(82, hostY + 34, "Model providers", {
    size: 16,
    weight: 650,
    fill: t.ink,
  });
  lines(
    82,
    hostY + 60,
    ["Magpie (optional)", "OpenAI / Anthropic APIs"],
    t,
    13,
    24,
  );

  const targetX = 1076;
  const targetW = 300;
  box(targetX, hostY, targetW, hostH, t, { stroke: t.bring });
  text(targetX + 18, hostY + 34, "DSH Session volume", {
    size: 16,
    weight: 650,
    fill: t.bring,
  });
  lines(
    targetX + 18,
    hostY + 60,
    ["account-owned model history", "durable events and checkpoints"],
    t,
    13,
    24,
  );

  // ---- the common interface, on the left ---------------------------------
  const appX = 64;
  const appY = 320;
  const appW = 232;
  box(appX, appY, appW, 196, t, { stroke: t.ink });
  text(appX + 18, appY + 34, "One shared interface", {
    size: 17,
    weight: 700,
    fill: t.ink,
  });
  lines(
    appX + 18,
    appY + 62,
    [
      "Web / PWA · Electron",
      "Android WebView (phone)",
      "HTTPS login gateway",
      "chat · tasks · approvals",
      "live browser handoff",
    ],
    t,
    13,
    23,
  );

  box(appX, 620, appW, 136, t, { stroke: t.muted, dashed: true });
  text(appX + 18, 654, "When it needs you", {
    size: 15,
    weight: 650,
    fill: t.ink,
  });
  lines(
    appX + 18,
    681,
    [
      "approve in the conversation,",
      "take over the live browser,",
      "then hand control back",
    ],
    t,
    12.5,
    22,
  );

  // ---- product core and the tool boundary, in the middle -----------------
  const coreX = 372;
  const coreY = 320;
  const coreW = 476;
  const coreH = 286;
  box(coreX, coreY, coreW, coreH, t, { stroke: t.ink, strokeWidth: 2 });
  text(coreX + 22, coreY + 35, "ChisaBot core :3001", {
    size: 18,
    weight: 700,
    fill: t.ink,
  });
  text(
    coreX + 22,
    coreY + 60,
    "conversation commands · history · tasks · delivery",
    {
      size: 13,
      fill: t.muted,
    },
  );

  const gateX = coreX + 22;
  const gateY = coreY + 86;
  box(gateX, gateY, coreW - 44, 176, t, {
    stroke: t.gate,
    strokeWidth: 2.4,
    roughness: 1.4,
  });
  text(gateX + 18, gateY + 32, "Tool gateway & approvals", {
    size: 16,
    weight: 700,
    fill: t.gate,
  });
  lines(
    gateX + 18,
    gateY + 60,
    [
      "1.  bind account, Bot and run",
      "2.  check permissions · approve / hand off",
      "3.  execute / refuse · persist the tool outcome",
    ],
    t,
    13.5,
    26,
  );
  text(gateX + 18, gateY + 151, "browser · devices · MCP · integrations", {
    size: 12.5,
    fill: t.muted,
  });

  // ---- tool targets, on the right ----------------------------------------
  box(targetX, 320, targetW, 108, t, { stroke: t.ink });
  text(targetX + 18, 351, "Cloud tools", {
    size: 16,
    weight: 650,
    fill: t.ink,
  });
  lines(
    targetX + 18,
    375,
    [
      "agent-computer · Chromium / Xvfb",
      "per-Bot browser profiles",
      "shared process and /workspace",
    ],
    t,
    12.5,
    20,
  );

  box(targetX, 462, targetW, 108, t, { stroke: t.ink });
  text(targetX + 18, 493, "Your devices", {
    size: 16,
    weight: 650,
    fill: t.ink,
  });
  lines(
    targetX + 18,
    517,
    [
      "account-owned Windows / Linux / macOS",
      "outbound WSS · device_* tools",
      "local agents · files · terminal",
    ],
    t,
    12.5,
    20,
  );

  // ---- product storage and host operations -------------------------------
  const dbY = 690;
  box(coreX, dbY, coreW, 118, t, { stroke: t.ink });
  text(coreX + 22, dbY + 32, "PostgreSQL :5432", {
    size: 16,
    weight: 650,
    fill: t.ink,
  });
  lines(
    coreX + 22,
    dbY + 59,
    [
      "conversation history · tasks · memory · delivery",
      "approvals · durable tool ledger · audit",
      "permissions and encrypted credentials",
    ],
    t,
    13,
    20,
  );

  box(targetX, dbY, targetW, 118, t, { stroke: t.muted, dashed: true });
  text(targetX + 18, dbY + 32, "Host updater", {
    size: 16,
    weight: 650,
    fill: t.ink,
  });
  lines(
    targetX + 18,
    dbY + 58,
    [
      "build · backup · compatible switch",
      "health check · guarded recovery",
      "app has no Docker socket",
    ],
    t,
    12.5,
    21,
  );

  // ---- the wiring --------------------------------------------------------
  // DSH calls the configured model connection, directly or through the core's proxy.
  arrow(hostX - 8, hostY + 47, appX + appW + 8, hostY + 47, {
    colour: t.muted,
  });
  label((appX + appW + hostX) / 2, hostY + 30, "model API", t.muted);
  text(64, hostY + hostH + 24, "direct or via the core model proxy", {
    size: 12,
    fill: t.muted,
  });
  arrow(hostX + hostW + 8, hostY + 57, targetX - 10, hostY + 57, {
    colour: t.bring,
    tailHead: true,
  });
  label((hostX + hostW + targetX) / 2, hostY + 41, "persist / resume", t.bring);

  // Commands flow to DSH; scoped tool callbacks flow back to the product gateway.
  arrow(coreX + 110, coreY - 8, coreX + 110, hostY + hostH + 8, {
    colour: t.ink,
    tailHead: true,
  });
  label(coreX + 94, 280, "commands / events", t.muted, "end");
  arrow(coreX + 334, hostY + hostH + 8, coreX + 334, coreY - 8, {
    colour: t.gate,
    dashed: true,
  });
  label(coreX + 350, 280, "tool callbacks", t.gate, "start");

  // The app's API transport is product-owned; responses stream back over the same origin.
  arrow(appX + appW + 6, appY + 76, coreX - 8, appY + 76, { colour: t.ink });
  label((appX + appW + coreX) / 2, appY + 61, "request", t.muted);
  arrow(coreX - 8, appY + 132, appX + appW + 6, appY + 132, {
    colour: t.ink,
    dashed: true,
  });
  label((appX + appW + coreX) / 2, appY + 155, "stream", t.muted);

  arrow(coreX + coreW + 8, gateY + 39, targetX - 10, 374, {
    colour: t.allow,
    width: 2.2,
  });
  label(964, 378, "authorized tools", t.allow);
  // The device initiates the WSS connection; tool requests and results use that channel.
  arrow(targetX - 10, 516, coreX + coreW + 8, 516, {
    colour: t.allow,
    width: 2.2,
    tailHead: true,
  });
  label(964, 498, "device connection", t.allow);

  arrow(coreX + 190, coreY + coreH + 8, coreX + 190, dbY - 8, {
    colour: t.gate,
    width: 2.2,
    tailHead: true,
  });
  label(coreX + 210, 654, "product records", t.muted, "start");

  arrow(coreX + coreW + 8, coreY + coreH - 16, targetX - 10, dbY + 30, {
    colour: t.muted,
    dashed: true,
  });
  label(968, 627, "spool request", t.muted);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`,
    `<title>ChisaBot architecture</title>`,
    `<desc>Web, PWA, Electron and Android WebView share the same product interface and HTTPS login gateway. ` +
      `The core owns conversation commands, history, tasks, permissions, approvals and delivery. ` +
      `A separate DSH Host per account runs the model and tool loop and persists model history in its Session volume. ` +
      `Tool callbacks return to the core gateway before reaching the shared cloud computer, account-owned devices ` +
      `or integrations. Cloud browser profiles are per Bot; the current app container shares its computer process ` +
      `and workspace. Devices initiate outbound WSS connections. Product records live in PostgreSQL. ` +
      `The host updater reads spool requests and applies compatible updates without exposing Docker to the app.</desc>`,
    ...out,
    `</svg>`,
  ].join("\n");
}
for (const theme of [LIGHT, DARK]) {
  await Bun.write(
    new URL(`../assets/architecture-${theme.name}.svg`, import.meta.url),
    render(theme),
  );
}
console.log(
  "wrote assets/architecture-light.svg and assets/architecture-dark.svg",
);
