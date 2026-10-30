#!/usr/bin/env node
// Before/after markdown table from two harness output dirs (or summary.json files).
// One argument prints that run alone.
// node perf/compare.mjs <before> [<after>] [--interactions] [--label-before=main] [--label-after=PR]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: o, positionals } = parseArgs({
  options: {
    interactions: { type: "boolean", default: false },
    "label-before": { type: "string", default: "before" },
    "label-after": { type: "string", default: "after" },
  },
  allowPositionals: true,
  // `bun run perf:jank -- --x` forwards a literal "--"; drop it so options still parse.
  args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--")),
});
if (positionals.length === 1) positionals.push(positionals[0]);
if (positionals.length !== 2) {
  console.error(
    "usage: node perf/compare.mjs <before-dir|summary.json> [<after-dir|summary.json>] [--interactions]",
  );
  process.exit(2);
}
const load = (p) =>
  JSON.parse(
    fs.readFileSync(
      fs.statSync(p).isDirectory() ? path.join(p, "summary.json") : p,
      "utf8",
    ),
  );
const [A, B] = positionals.map(load);

// [key, header, lower-is-better]
const COLS = [
  ["fps", "fps", false],
  ["p95", "p95 frame ms", true],
  ["longTaskMs", "long-task ms", true],
  ["maxLongTask", "max long task", true],
  ["inpMax", "worst INP", true],
  ["firstFrameMax", "worst first frame", true],
  ["styleMs", "style ms", true],
  ["layoutMs", "layout ms", true],
  ["scriptMs", "script ms", true],
  ["forcedMs", "forced ms (trace)", true],
];
const single = positionals[0] === positionals[1];
const cell = (a, b, lower) => {
  if (single) return a ?? "–";
  if (a == null && b == null) return "–";
  if (a == null || b == null) return `${a ?? "–"} → ${b ?? "–"}`;
  const pct =
    a === 0 ? (b === 0 ? 0 : 100) : Math.round(((b - a) / Math.abs(a)) * 100);
  const better = lower ? b < a : b > a;
  const flag = Math.abs(pct) < 10 ? "" : better ? " ✅" : " ⚠️";
  return `${a} → ${b} (${pct > 0 ? "+" : ""}${pct}%)${flag}`;
};
const names = [
  ...new Set([...Object.keys(A.phases), ...Object.keys(B.phases)]),
];
const cols = COLS.filter(([k]) =>
  names.some((n) => A.phases[n]?.[k] != null || B.phases[n]?.[k] != null),
);
const lines = [];
lines.push(
  single
    ? `${A.tag} (${A.runs} run(s), cpu ${A.cpu}x); medians`
    : `${o["label-before"]} (${A.runs} run, cpu ${A.cpu}x) → ${o["label-after"]} (${B.runs} run, cpu ${B.cpu}x); medians; ✅/⚠️ = ≥10% better/worse`,
  "",
);
lines.push(
  `| scenario | ${cols.map((c) => c[1]).join(" | ")} |`,
  `|---|${cols.map(() => "---").join("|")}|`,
);
for (const n of names)
  lines.push(
    `| ${n} | ${cols.map(([k, , lower]) => cell(A.phases[n]?.[k], B.phases[n]?.[k], lower)).join(" | ")} |`,
  );
if (o.interactions) {
  lines.push(
    "",
    "| interaction | INP | input delay | processing | presentation | first frame | dropped (1s) |",
    "|---|---|---|---|---|---|---|",
  );
  for (const n of names) {
    const ia = A.phases[n]?.interactions || [];
    const ib = B.phases[n]?.interactions || [];
    for (const label of [...new Set([...ia, ...ib].map((x) => x.label))]) {
      const a = ia.find((x) => x.label === label) || {};
      const b = ib.find((x) => x.label === label) || {};
      const f = (k) => cell(a[k], b[k], true);
      lines.push(
        `| ${n} / ${label} | ${f("inp")} | ${f("inputDelay")} | ${f("processing")} | ${f("presentation")} | ${f("firstFrameAfterChange")} | ${f("dropped1s")} |`,
      );
    }
  }
}
console.log(lines.join("\n"));
