import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ShapeAvatar, type ShapeMood } from "@/components/agents/shape-avatar";
import {
  morphStats,
  setMorphSchedulerForTests,
} from "@/lib/agents/avatar-morph";
import { AVATAR_SHAPES, SHAPE_COLORS } from "../../../shared/bot-avatars";

/** 头像变形的性能 / 录屏页（scripts/avatar-morph-harness/run.ts 用 Playwright 打开）。不进应用包。 */
const costs: number[] = [];
setMorphSchedulerForTests({
  request: (cb) =>
    requestAnimationFrame((now) => {
      const start = performance.now();
      cb(now);
      costs.push(performance.now() - start);
    }),
  cancel: (id) => cancelAnimationFrame(id),
});
const w = window as unknown as Record<string, unknown>;
w.__morph = { stats: morphStats, costs };

const scene = new URLSearchParams(location.search).get("scene") ?? "perf";

function Sidebar() {
  const [working, setWorking] = useState(false);
  const [selected, setSelected] = useState(false);
  useEffect(() => {
    w.__setWorking = setWorking;
    w.__setSelected = setSelected;
  }, []);
  return (
    <div
      style={{
        width: 260,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {Array.from({ length: 24 }, (_, i) => (
        <div
          key={i}
          style={{ display: "flex", alignItems: "center", gap: 10, height: 40 }}
        >
          <span className="bot-ava" style={{ width: 28, height: 28 }}>
            <ShapeAvatar
              color={SHAPE_COLORS[i % SHAPE_COLORS.length]}
              selected={selected && i === 0}
              shape={AVATAR_SHAPES[i % AVATAR_SHAPES.length]}
              size={28}
              thinking={false}
              working={working && i < 3}
            />
          </span>
          <span>Bot {i + 1}</span>
        </div>
      ))}
    </div>
  );
}

function States() {
  const [round, setRound] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setRound((r) => r + 1), 2600);
    return () => clearInterval(id);
  }, []);
  const cells: {
    label: string;
    mood: ShapeMood;
    thinking?: boolean;
    shape: (typeof AVATAR_SHAPES)[number];
    color: (typeof SHAPE_COLORS)[number];
  }[] = [
    { label: "选中 selected", mood: "selected", shape: "round", color: "blue" },
    {
      label: "思考 thinking",
      mood: "idle",
      thinking: true,
      shape: "cloud",
      color: "violet",
    },
    {
      label: "工作中 working",
      mood: "working",
      shape: "bloom",
      color: "orange",
    },
    { label: "做完了 done", mood: "done", shape: "bean", color: "green" },
  ];
  return (
    <div style={{ display: "flex", gap: 36, padding: 32 }}>
      {cells.map((cell) => (
        <div
          key={cell.label}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
          }}
        >
          <span className="bot-ava" style={{ width: 120, height: 120 }}>
            <ShapeAvatar
              color={cell.color}
              key={cell.mood === "done" ? round : 0}
              mood={cell.mood === "idle" ? undefined : cell.mood}
              selected={cell.mood === "selected"}
              shape={cell.shape}
              size={120}
              thinking={cell.thinking}
              working={cell.mood === "working"}
            />
          </span>
          <span style={{ font: "14px system-ui" }}>{cell.label}</span>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  scene === "states" ? <States /> : <Sidebar />,
);
