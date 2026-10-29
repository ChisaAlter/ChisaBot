/**
 * 未保存改动的拦截规则（审查模块 12 第 3 条，DESIGN.md §11）。
 *
 * 全站只用一种做法：有改动时离开先确认，不偷偷存草稿。这里放纯逻辑，方便单测；
 * React 那一半在 components/ui/unsaved-guard.tsx。
 */

/** 弹窗被这些方式关掉时，有改动就先确认。「取消」按钮是用户明说要放弃，不拦。 */
export const GUARDED_DISMISS_REASONS: ReadonlySet<string> = new Set(["escape-key", "outside-press", "close-press"]);

export function shouldConfirmDismiss(dirty: boolean, reason: string | undefined): boolean {
  return dirty && reason !== undefined && GUARDED_DISMISS_REASONS.has(reason);
}

/** 两份表单值浅比较：任何一个字段不一样就算有改动。 */
export function formDirty<T extends Record<string, unknown>>(initial: T, current: T): boolean {
  const keys = new Set([...Object.keys(initial), ...Object.keys(current)]);
  for (const key of keys) if (!Object.is(initial[key], current[key])) return true;
  return false;
}

/** 左栏 / 后退离开时的确认框文案。 */
export const LEAVE_CONFIRM = {
  title: "有未保存的更改，确定离开？",
  description: "离开后这次的改动不会保存。",
  confirmLabel: "离开",
  cancelLabel: "继续编辑",
  destructive: true,
} as const;

/** 弹窗按 Esc / 点外面时的确认框文案。 */
export const DISCARD_CONFIRM = {
  title: "放弃这次的改动？",
  description: "关掉后刚才填的内容不会保存。",
  confirmLabel: "放弃",
  cancelLabel: "继续编辑",
  destructive: true,
} as const;
