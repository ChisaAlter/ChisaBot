// Median-of-runs summary used by jank.mjs and compare.mjs.
const median = (xs) => {
  const v = xs
    .filter((x) => typeof x === "number" && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : +((v[m - 1] + v[m]) / 2).toFixed(1);
};
const max = (xs) => {
  const v = xs.filter((x) => typeof x === "number");
  return v.length ? Math.max(...v) : null;
};

/** Phase-level numbers for one run (interactions collapsed to worst/sum). */
export function phaseMetrics(p) {
  const it = p.interactions || [];
  return {
    fps: p.fps,
    p95: p.p95,
    longTasks: p.longTasks,
    longTaskMs: p.longTaskMs,
    maxLongTask: p.maxLongTask,
    styleMs: p.styleMs,
    layoutMs: p.layoutMs,
    scriptMs: p.scriptMs,
    taskMs: p.taskMs,
    nodes: p.nodes,
    inpMax: max(it.map((x) => x.inp)),
    firstFrameMax: max(it.map((x) => x.firstFrameAfterChange)),
    droppedMax: max(it.map((x) => x.dropped1s)),
    forcedMs: p.trace?.forcedMs ?? null,
  };
}

/** @param {any[]} runs results of runOnce() */
export function summarizeRuns(runs) {
  const phases = {};
  const names = [...new Set(runs.flatMap((r) => Object.keys(r.phases)))];
  for (const n of names) {
    const per = runs.map((r) => r.phases[n]).filter(Boolean);
    const ms = per.map(phaseMetrics);
    const keys = Object.keys(ms[0] || {});
    phases[n] = {
      runs: per.length,
      ...Object.fromEntries(keys.map((k) => [k, median(ms.map((m) => m[k]))])),
    };
    const labels = [
      ...new Set(per.flatMap((p) => p.interactions.map((x) => x.label))),
    ];
    phases[n].interactions = labels.map((label) => {
      const xs = per
        .map((p) => p.interactions.find((x) => x.label === label))
        .filter(Boolean);
      const f = (k) => median(xs.map((x) => x[k]));
      return {
        label,
        inp: f("inp"),
        inputDelay: f("inputDelay"),
        processing: f("processing"),
        presentation: f("presentation"),
        firstFrameAfterChange: f("firstFrameAfterChange"),
        domSettled: f("domSettled"),
        fps1s: f("fps1s"),
        dropped1s: f("dropped1s"),
      };
    });
  }
  return {
    tag: runs[0]?.tag,
    runs: runs.length,
    cpu: runs[0]?.cpu,
    lat: runs[0]?.lat,
    idle: runs.at(-1)?.idle,
    phases,
  };
}
