import { animate, useReducedMotion } from "motion/react";
import { type CSSProperties, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AvatarShape, ShapeColor } from "../../../../shared/bot-avatars";
import { mixShapes, SHAPE_COLOR_HEX, SHAPES, type ShapeGeometry, shapePath } from "@/lib/agents/avatar-shapes";

export type ShapeMood = "idle" | "selected" | "working" | "done";

/** 一轮做完后，开心的表情停留多久。 */
export const DONE_MOOD_MS = 2400;

/**
 * 表情只有四种，由两个开关决定：机器人在跑（working）> 刚做完（done，从 working 落下来之后停一会）> 被选中（selected）> 待机。
 * 待机什么动画都没有（左栏一屏几十个头像，不能都在动）；只有在跑的那几个才有持续动画。
 */
export function useShapeMood(selected: boolean, working: boolean, doneMs = DONE_MOOD_MS): ShapeMood {
  const [done, setDone] = useState(false);
  const wasWorking = useRef(working);
  useEffect(() => {
    if (working) {
      wasWorking.current = true;
      setDone(false);
      return;
    }
    if (!wasWorking.current) return;
    wasWorking.current = false;
    setDone(true);
    const timer = window.setTimeout(() => setDone(false), doneMs);
    return () => window.clearTimeout(timer);
  }, [working, doneMs]);
  if (working) return "working";
  if (done) return "done";
  return selected ? "selected" : "idle";
}

/**
 * 有表情的形象头像（DESIGN.md §81）：形状 + 颜色 + 一对竖条眼睛。换形状时用 motion 的弹簧在两个形状之间逐点变形；
 * 表情用 CSS 动画（styles.css 的 .sa-*），尊重「减少动态效果」。
 */
export const ShapeAvatar = memo(function ShapeAvatar({
  shape,
  color,
  size,
  selected = false,
  working = false,
}: {
  shape: AvatarShape;
  color: ShapeColor;
  size: number;
  selected?: boolean;
  working?: boolean;
}) {
  const mood = useShapeMood(selected, working);
  const reduceMotion = useReducedMotion();
  const pathRef = useRef<SVGPathElement>(null);
  const faceRef = useRef<SVGGElement>(null);
  const leftRef = useRef<SVGGElement>(null);
  const rightRef = useRef<SVGGElement>(null);
  // 第一次的样子写进属性；之后换形状全部由下面的动画直接改 DOM，React 不再碰这几个属性。
  const first = useRef(SHAPES[shape]);
  const shown = useRef<ShapeGeometry>(SHAPES[shape]);
  const initial = useRef({ d: shapePath(first.current), face: faceTransform(first.current), gap: first.current.face.gap / 2 }).current;

  useLayoutEffect(() => {
    const paint = (geometry: ShapeGeometry) => {
      shown.current = geometry;
      pathRef.current?.setAttribute("d", shapePath(geometry));
      faceRef.current?.setAttribute("transform", faceTransform(geometry));
      leftRef.current?.setAttribute("transform", `translate(${-geometry.face.gap / 2} 0)`);
      rightRef.current?.setAttribute("transform", `translate(${geometry.face.gap / 2} 0)`);
    };
    const target = SHAPES[shape];
    if (shown.current === target) return;
    if (reduceMotion) {
      paint(target);
      return;
    }
    const from = shown.current;
    const controls = animate(0, 1, { type: "spring", stiffness: 240, damping: 15, onUpdate: (t) => paint(mixShapes(from, target, t)) });
    return () => {
      controls.stop();
      // 被新的选择打断：停在最后一帧，下一次从这里继续变。
    };
  }, [shape, reduceMotion]);

  return (
    <svg aria-hidden className="sa" data-color={color} data-mood={mood} height={size} style={{ "--sa-fill": SHAPE_COLOR_HEX[color] } as CSSProperties} viewBox="0 0 100 100" width={size}>
      <g className="sa-body">
        <path d={initial.d} fill="var(--sa-fill)" ref={pathRef} />
        <g ref={faceRef} transform={initial.face}>
          <g className="sa-eyes">
            <g ref={leftRef} transform={`translate(${-initial.gap} 0)`}>
              <Eye />
            </g>
            <g ref={rightRef} transform={`translate(${initial.gap} 0)`}>
              <Eye />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
});

function faceTransform(geometry: ShapeGeometry) {
  const { x, y, rot, scale } = geometry.face;
  return `translate(${x} ${y}) rotate(${rot}) scale(${scale})`;
}

/** 睁着的竖条，和做完时的「开心」弯眼，两个叠在一起，按表情切换。 */
function Eye() {
  return (
    <>
      <rect className="sa-open" fill="#fff" height="15.5" rx="3.25" width="6.5" x="-3.25" y="-7.75" />
      <path className="sa-happy" d="M-6 4 Q0 -8 6 4" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="3.8" />
    </>
  );
}