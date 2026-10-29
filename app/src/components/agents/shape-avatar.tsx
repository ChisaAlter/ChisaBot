import { animate, useReducedMotion } from "motion/react";
import {
  type CSSProperties,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  attachMorph,
  morphLevelOf as levelOfState,
  type MorphHandle,
  type MorphLevel,
  type MorphPose,
} from "@/lib/agents/avatar-morph";
import {
  mixShapes,
  SHAPE_COLOR_HEX,
  SHAPES,
  type ShapeGeometry,
  shapePath,
} from "@/lib/agents/avatar-shapes";
import { usePerfMode } from "@/lib/perf-mode";
import {
  AVATAR_SHAPES,
  type AvatarShape,
  type ShapeColor,
} from "../../../../shared/bot-avatars";

export type ShapeMood = "idle" | "selected" | "working" | "done";

/** 一轮做完后，开心的表情停留多久。 */
export const DONE_MOOD_MS = 2400;

/**
 * 表情只有四种，由两个开关决定：机器人在跑（active：在干活或在想）> 刚做完（done，整轮结束——active 从 true 落到 false——之后停一会）> 被选中（selected）> 待机。
 * 一轮中间工具跑完回到「在想」不算做完（active 一直是 true）；只在想、没跑工具的一轮结束也会露出做完。
 * 待机什么动画都没有（左栏一屏几十个头像，不能都在动）；只有在跑的那几个才有持续动画。
 */
export function useShapeMood(
  selected: boolean,
  active: boolean,
  doneMs = DONE_MOOD_MS,
  /** 这一轮是被停止或出错结束的：不跳「做完了」，直接回到静止。 */
  interrupted = false,
): ShapeMood {
  const working = active;
  const [done, setDone] = useState(false);
  const wasWorking = useRef(working);
  useEffect(() => {
    if (working) {
      wasWorking.current = true;
      setDone(false);
      return;
    }
    if (!wasWorking.current || interrupted) {
      wasWorking.current = false;
      setDone(false);
      return;
    }
    wasWorking.current = false;
    setDone(true);
    const timer = window.setTimeout(() => setDone(false), doneMs);
    return () => window.clearTimeout(timer);
  }, [working, doneMs, interrupted]);
  if (working) return "working";
  if (done && !interrupted) return "done";
  return selected ? "selected" : "idle";
}

/** 变形看哪个状态：干活 > 做完了 > 思考 > 被选中 > 待机。 */
export function morphLevelOf(
  selected: boolean,
  thinking: boolean,
  working: boolean,
  done = false,
): MorphLevel {
  return levelOfState({ selected, thinking, working, done });
}

/** 干活时往相邻的形状流过去一点。 */
function neighborOf(shape: AvatarShape): AvatarShape {
  return AVATAR_SHAPES[
    (AVATAR_SHAPES.indexOf(shape) + 1) % AVATAR_SHAPES.length
  ];
}

/**
 * 有表情的形象头像（DESIGN.md §81）：形状 + 颜色 + 一对竖条眼睛。换形状时用 motion 的弹簧在两个形状之间逐点变形；
 * 表情用 CSS 动画（styles.css 的 .sa-*），尊重「减少动态效果」。
 * 在想 / 在干活 / 被选中 / 做完了时轮廓像果冻一样持续变形、眼睛会眨会看（lib/agents/avatar-morph.ts，全局一个 rAF，直接改属性），
 * 减少动态效果或性能模式下只留静态形状：不变形、换形状不走弹簧，CSS 表情动画和过渡也全停（styles.css 的 .sa 一节）。
 */
export const ShapeAvatar = memo(function ShapeAvatar({
  shape,
  color,
  size,
  selected = false,
  thinking = false,
  working = false,
  interrupted = false,
  mood: forcedMood,
}: {
  shape: AvatarShape;
  color: ShapeColor;
  size: number;
  selected?: boolean;
  thinking?: boolean;
  working?: boolean;
  /** 这一轮被停止 / 出错结束：不跳「做完了」。 */
  interrupted?: boolean;
  /** 只给预览用（头像编辑框的「选中 / 工作中 / 做完了」）：直接定表情。 */
  mood?: ShapeMood;
}) {
  // 「做完了」看整轮（干活或在想）结束，不看工具结束（DESIGN.md §81）。
  const ownMood = useShapeMood(
    selected,
    working || thinking,
    DONE_MOOD_MS,
    interrupted,
  );
  const mood = forcedMood ?? ownMood;
  const isWorking = forcedMood ? forcedMood === "working" : working;
  const state = {
    selected: mood === "selected" || selected,
    thinking: thinking && !isWorking,
    working: isWorking,
    done: mood === "done",
  };
  const level = levelOfState(state);
  const reduceMotion = useReducedMotion();
  const perfMode = usePerfMode();
  const still = Boolean(reduceMotion) || perfMode;
  const svgRef = useRef<SVGSVGElement>(null);
  const bodyRef = useRef<SVGGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const faceRef = useRef<SVGGElement>(null);
  const leftRef = useRef<SVGGElement>(null);
  const rightRef = useRef<SVGGElement>(null);
  const morph = useRef<MorphHandle | null>(null);
  // 第一次的样子写进属性；之后换形状、变形全部直接改 DOM，React 不再碰这几个属性。
  const first = useRef(SHAPES[shape]);
  /** 它自己的形状（换形状的弹簧停在哪儿就是哪儿），变形叠在它上面。 */
  const shown = useRef<ShapeGeometry>(SHAPES[shape]);
  const initial = useRef({
    d: shapePath(first.current),
    face: faceTransform(first.current),
    gap: first.current.face.gap / 2,
  }).current;

  const sizeRef = useRef(size);
  sizeRef.current = size;
  const shapeRef = useRef(shape);
  shapeRef.current = shape;
  const paintRef = useRef((geometry: ShapeGeometry, pose?: MorphPose) => {
    pathRef.current?.setAttribute("d", shapePath(geometry));
    faceRef.current?.setAttribute(
      "transform",
      faceTransform(geometry, pose?.blink ?? 1),
    );
    bodyRef.current?.setAttribute(
      "transform",
      pose
        ? `translate(${pose.tx.toFixed(2)} ${pose.ty.toFixed(2)}) rotate(${pose.rot.toFixed(2)} 50 58)`
        : "",
    );
    leftRef.current?.setAttribute(
      "transform",
      `translate(${-geometry.face.gap / 2} 0)`,
    );
    rightRef.current?.setAttribute(
      "transform",
      `translate(${geometry.face.gap / 2} 0)`,
    );
  });

  useLayoutEffect(() => {
    const paint = (geometry: ShapeGeometry) => {
      shown.current = geometry;
      paintRef.current(geometry);
    };
    const target = SHAPES[shape];
    if (shown.current === target) return;
    // 减少动态效果 / 性能模式：换形状直接画到位，不起 motion 的弹簧（它也是一个 rAF 循环）。
    if (still) {
      paint(target);
      return;
    }
    const from = shown.current;
    const controls = animate(0, 1, {
      type: "spring",
      stiffness: 240,
      damping: 15,
      onUpdate: (t) => paint(mixShapes(from, target, t)),
    });
    return () => {
      controls.stop();
      // 被新的选择打断：停在最后一帧，下一次从这里继续变。
    };
  }, [shape, still]);

  // 变形：减少动态效果 / 性能模式下不登记；切过去时画回自己的形状。
  useLayoutEffect(() => {
    const element = svgRef.current;
    if (still || !element) return;
    const handle = attachMorph({
      element,
      base: () => shown.current,
      neighbor: () => SHAPES[neighborOf(shapeRef.current)],
      size: () => sizeRef.current,
      paint: (geometry, pose) => paintRef.current(geometry, pose),
    });
    morph.current = handle;
    return () => {
      handle.detach();
      morph.current = null;
      paintRef.current(shown.current);
    };
  }, [still]);

  useLayoutEffect(() => {
    morph.current?.setState({
      selected: state.selected,
      thinking: state.thinking,
      working: state.working,
      done: state.done,
    });
  }, [state.selected, state.thinking, state.working, state.done, still]);

  return (
    <svg
      aria-hidden
      className="sa"
      data-activity={level}
      data-color={color}
      data-mood={mood}
      data-morph={still ? undefined : "on"}
      height={size}
      ref={svgRef}
      style={{ "--sa-fill": SHAPE_COLOR_HEX[color] } as CSSProperties}
      viewBox="0 0 100 100"
      width={size}
    >
      <g className="sa-body">
        <g ref={bodyRef}>
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
      </g>
    </svg>
  );
});

function faceTransform(geometry: ShapeGeometry, blink = 1) {
  const { x, y, rot, scale } = geometry.face;
  const base = `translate(${x} ${y}) rotate(${rot}) scale(${scale})`;
  return blink === 1 ? base : `${base} scale(1 ${blink.toFixed(3)})`;
}

/** 睁着的竖条，和做完时的「开心」弯眼，两个叠在一起，按表情切换。 */
function Eye() {
  return (
    <>
      <rect
        className="sa-open"
        fill="#fff"
        height="15.5"
        rx="3.25"
        width="6.5"
        x="-3.25"
        y="-7.75"
      />
      <path
        className="sa-happy"
        d="M-6 4 Q0 -8 6 4"
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeWidth="3.8"
      />
    </>
  );
}
