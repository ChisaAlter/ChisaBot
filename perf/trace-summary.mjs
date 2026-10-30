// Main-thread breakdown of a Chrome trace: self time by category plus forced (JS-triggered) style/layout with stacks.
const CAT = {
  FunctionCall: "script",
  EvaluateScript: "script",
  TimerFire: "script",
  FireAnimationFrame: "script",
  EventDispatch: "script",
  "V8.Execute": "script",
  "v8.callFunction": "script",
  RunMicrotasks: "script",
  "v8.compile": "compile",
  "v8.compileModule": "compile",
  UpdateLayoutTree: "style",
  ParseAuthorStyleSheet: "style",
  Layout: "layout",
  PrePaint: "paint",
  Paint: "paint",
  Layerize: "composite",
  Commit: "composite",
  HitTest: "hittest",
  MajorGC: "gc",
  MinorGC: "gc",
  "BlinkGC.AtomicPhase": "gc",
};

/** @param {any[]} ev raw trace events */
export function summarizeTrace(ev) {
  const names = new Map();
  const busy = new Map();
  for (const e of ev) {
    if (e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args?.name);
    if (e.name === "RunTask" && e.ph === "X")
      busy.set(
        `${e.pid}:${e.tid}`,
        (busy.get(`${e.pid}:${e.tid}`) || 0) + (e.dur || 0),
      );
  }
  const main = [...busy.entries()]
    .filter(([k]) => names.get(k) === "CrRendererMain")
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!main) return null;
  const X = ev
    .filter((e) => `${e.pid}:${e.tid}` === main && e.ph === "X")
    .sort((a, b) => a.ts - b.ts || (b.dur || 0) - (a.dur || 0));
  const self = {};
  const stack = [];
  let mainMs = 0;
  const forced = new Map();
  let forcedMs = 0;
  let maxRecalcElements = 0;
  for (const e of X) {
    const s = e.ts;
    const d = e.dur || 0;
    while (stack.length && stack.at(-1).end <= s) stack.pop();
    if (e.name === "RunTask" && !stack.length) mainMs += d;
    const c = CAT[e.name];
    if (c) {
      const parent = [...stack].reverse().find((x) => x.c);
      if (parent) self[parent.c] = (self[parent.c] || 0) - d;
      self[c] = (self[c] || 0) + d;
    }
    stack.push({ end: s + d, c });
    if (e.name === "UpdateLayoutTree" || e.name === "Layout") {
      const a = e.args || {};
      const n = a.elementCount ?? a.data?.elementCount ?? 0;
      if (n > maxRecalcElements) maxRecalcElements = n;
      const st = a.beginData?.stackTrace || a.data?.stackTrace;
      if (st?.length) {
        forcedMs += d;
        const key = `${e.name} <- ${st
          .slice(0, 3)
          .map(
            (f) =>
              `${f.functionName || "(anon)"}@${(f.url || "").split("/").pop()}:${f.lineNumber}:${f.columnNumber}`,
          )
          .join(" < ")}`;
        const v = forced.get(key) || { n: 0, ms: 0 };
        v.n++;
        v.ms += d;
        forced.set(key, v);
      }
    }
  }
  const ms = (us) => Math.round(us / 1000);
  return {
    mainMs: ms(mainMs),
    selfMs: Object.fromEntries(
      Object.entries(self).map(([k, v]) => [k, ms(v)]),
    ),
    forcedMs: ms(forcedMs),
    maxRecalcElements,
    forcedTop: [...forced.entries()]
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, 8)
      .map(([k, v]) => ({ at: k, count: v.n, ms: +(v.ms / 1000).toFixed(1) })),
  };
}
