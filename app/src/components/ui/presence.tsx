import { AnimatePresence, motion } from "motion/react";
import { forwardRef, type ReactNode } from "react";

/**
 * 列表项进出场（DESIGN.md §34.5）：新项 220ms 淡入 + 6px 上浮；删除的项 160ms 淡出 + 缩到 0.97，
 * 同时它下面的项用 transform（FLIP）平滑补位，不做高度动画、不触发逐帧重排。
 *
 * - `mode="popLayout"`：离场的项立即脱离文档流，其余项马上开始补位，不用等离场动画放完。
 *   外层容器必须是定位元素（`position: relative`），离场项才会留在原位淡出。
 * - `initial={false}`：首屏 / 切换机器人时整列直接出现，只有之后的插入 / 删除才有动画。
 * - 减少动态效果：根上的 `<MotionConfig reducedMotion="user">` 会去掉位移和缩放，只留淡入淡出。
 */
export function PresenceList({ children }: { children: ReactNode }) {
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {children}
    </AnimatePresence>
  );
}

const ENTER = [0.22, 0.8, 0.24, 1] as const;
const EXIT = [0.4, 0, 1, 1] as const;

/**
 * `layoutKey`：只有它变了才量位置做补位动画（motion 的 `layoutDependency`）。不给时 motion 每次重渲染都量——
 * 在提交前读一次 `document` 的滚动位置、提交后再读一次，两次都会强制同步布局；侧栏机器人列表每次换页都重渲染，
 * 4× 降速下关设置时这两次布局占 ~75ms。传列表里的下标即可：插入 / 删除 / 换序都会改下标，补位动画照旧。
 */
export const PresenceItem = forwardRef<
  HTMLDivElement,
  { children: ReactNode; className?: string; layoutKey?: unknown }
>(
  function PresenceItem({ children, className, layoutKey }, ref) {
    return (
      <motion.div
        animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.22, ease: ENTER } }}
        className={className}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.16, ease: EXIT } }}
        initial={{ opacity: 0, y: 6, scale: 1 }}
        layout="position"
        layoutDependency={layoutKey}
        ref={ref}
        transition={{ layout: { duration: 0.22, ease: ENTER } }}
      >
        {children}
      </motion.div>
    );
  },
);
