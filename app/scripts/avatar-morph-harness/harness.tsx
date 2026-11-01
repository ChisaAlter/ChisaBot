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

function Sidebar({ children }: { children?: React.ReactNode }) {
  const [working, setWorking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [selected, setSelected] = useState(false);
  useEffect(() => {
    w.__setWorking = setWorking;
    w.__setThinking = setThinking;
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
      {children}
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
              thinking={thinking && i >= 3 && i < 6}
              working={working && i < 3}
            />
          </span>
          <span>Bot {i + 1}</span>
        </div>
      ))}
    </div>
  );
}

/** 流式回复：每 30 ms 往对话里加一段字（React 状态 → 重渲染），同时 3 个在想 + 3 个在干活 + 对话里 18px 的在想头像。 */
function Stream() {
  const [text, setText] = useState<string[]>([]);
  useEffect(() => {
    w.__startStream = () => {
      let n = 0;
      const id = setInterval(() => {
        n++;
        setText((t) => [...t, `token ${n} 这是流式回复里的一小段字，`]);
      }, 30);
      w.__stopStream = () => clearInterval(id);
    };
  }, []);
  return (
    <Sidebar>
      <div style={{ height: 160, overflow: "auto", font: "13px system-ui" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="bot-ava" style={{ width: 18, height: 18 }}>
            <ShapeAvatar color="violet" shape="cloud" size={18} thinking />
          </span>
          思考中
        </div>
        <p>{text.join("")}</p>
      </div>
    </Sidebar>
  );
}

function States() {
  const px = Number(new URLSearchParams(location.search).get("size") ?? 120);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setRound((r) => r + 1), 3000);
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
    <div
      style={{
        display: "flex",
        gap: px < 60 ? 28 : 36,
        padding: px < 60 ? 16 : 32,
      }}
    >
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
          <span className="bot-ava" style={{ width: px, height: px }}>
            <ShapeAvatar
              color={cell.color}
              key={cell.mood === "done" || cell.mood === "selected" ? round : 0}
              mood={cell.mood === "idle" ? undefined : cell.mood}
              selected={cell.mood === "selected"}
              shape={cell.shape}
              size={px}
              thinking={cell.thinking}
              working={cell.mood === "working"}
            />
          </span>
          <span style={{ font: px < 60 ? "11px system-ui" : "14px system-ui" }}>
            {cell.label}
          </span>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  scene === "states" ? (
    <States />
  ) : scene === "stream" ? (
    <Stream />
  ) : (
    <Sidebar />
  ),
);
