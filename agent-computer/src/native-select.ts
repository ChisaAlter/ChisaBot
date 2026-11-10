/**
 * 原生 `<select>` 下拉框（DESIGN.md §100，2026-10-17 用户反馈「无法操作电脑里的浏览器」）。
 *
 * 为什么单独处理：有界面的 Chromium（§ 机器人不用无头模式）里，点一下原生下拉框会弹出系统自己画的选项列表。
 * 那个列表不在页面里——快照看不到选项，`fill` 填不进去（select 不是输入框，Playwright 一直等到超时），
 * 弹出来之后对这个元素按键也会超时。用户截图里机器人就卡在这里：月份列表展开着（Jan 高亮），
 * 「填写」「按键」都报「元素不在页面上了」，这一轮就静默结束了。
 *
 * 做法：
 * - 点原生下拉框 → 不真的点开，只聚焦，并把选项列给机器人，告诉它用 computer_type 填选项。
 * - 往原生下拉框里「填写」（computer_type）→ 按选项文字 / 值挑出一项，用 `selectOption` 直接选中
 *   （和人选一样触发 input / change 事件），顺手让它失焦，关掉之前可能弹出来的系统列表。
 * - 点下拉框里的某个 option → 同样选中那一项。
 *
 * `pickOption` 是纯函数（不碰 Playwright），规则单测见 tests/native-select.test.ts。
 */

import type { Locator } from "playwright";

/** 一项选项：页面上显示的文字、提交的值、是否禁用。 */
export type NativeOption = { label: string; value: string; disabled?: boolean };

/** 给机器人看的选项最多列这么多项（年份下拉常有一百多项）。 */
export const OPTION_LIST_LIMIT = 60;

/** 填的内容找不到对应选项：是请求的问题（换个写法能成），不是电脑坏了。 */
export class SelectOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectOptionError";
  }
}

const MONTHS = [
  ["jan", "january", "一月", "1月"],
  ["feb", "february", "二月", "2月"],
  ["mar", "march", "三月", "3月"],
  ["apr", "april", "四月", "4月"],
  ["may", "may", "五月", "5月"],
  ["jun", "june", "六月", "6月"],
  ["jul", "july", "七月", "7月"],
  ["aug", "august", "八月", "8月"],
  ["sep", "september", "九月", "9月"],
  ["oct", "october", "十月", "10月"],
  ["nov", "november", "十一月", "11月"],
  ["dec", "december", "十二月", "12月"],
];

const norm = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
/** 「07」「7」「7日」「7号」→ 7；不是数字 → null。 */
const asNumber = (text: string): number | null => {
  const match = /^0*(\d{1,4})\s*(日|号|月|年)?$/.exec(text.trim());
  return match ? Number(match[1]) : null;
};
/** 一个月份写法 → 1–12；认不出 → null。 */
const monthOf = (text: string): number | null => {
  const t = norm(text).replace(/\.$/, "");
  const index = MONTHS.findIndex((names) => names.includes(t) || (t.length >= 3 && names[1]!.startsWith(t)));
  return index >= 0 ? index + 1 : null;
};

/**
 * 机器人填的内容对应哪一项。按这个顺序找，找到就停：
 * 1. 文字完全一样（忽略大小写和多余空格）；
 * 2. 选项是月份列表时，月份写法互通（「7」「Jul」「July」「七月」「7月」都能选中「Jul」/「July」/「7月」）；
 * 3. 值完全一样；
 * 4. 数字一样（「7」对「07」、「7日」；先看文字再看值）；
 * 5. 选项文字以它开头且只有一项这样（「Jul」→「July」）。
 * 禁用的选项不选。返回下标；找不到返回 -1。
 */
export function pickOption(options: readonly NativeOption[], wanted: string): number {
  const usable = (index: number) => index >= 0 && !options[index]!.disabled;
  const w = norm(wanted);
  if (!w) return -1;
  const find = (test: (option: NativeOption) => boolean) => {
    const index = options.findIndex((option) => !option.disabled && test(option));
    return usable(index) ? index : -1;
  };

  let index = find((o) => norm(o.label) === w);
  if (index >= 0) return index;

  // 月份：这一组选项的文字是月份名（Jan / July / 七月 / 7月），想要的是月份写法或 1–12 的数字。
  // 放在按值匹配之前：有的网站月份的值从 0 开始（Jul 的值是 "6"），按值找「7」会选成 Aug。
  const n = asNumber(w);
  const wantedMonth = monthOf(w) ?? (n !== null && n >= 1 && n <= 12 ? n : null);
  if (wantedMonth !== null) {
    const monthish = options.filter((o) => monthOf(o.label) !== null).length >= 6;
    if (monthish) {
      index = find((o) => monthOf(o.label) === wantedMonth);
      if (index >= 0) return index;
    }
  }

  index = find((o) => norm(o.value) === w);
  if (index >= 0) return index;

  if (n !== null) {
    index = find((o) => asNumber(o.label) === n || asNumber(o.value) === n);
    if (index >= 0) return index;
  }

  const starts = options
    .map((o, i) => (!o.disabled && norm(o.label).startsWith(w) ? i : -1))
    .filter((i) => i >= 0);
  return starts.length === 1 ? starts[0]! : -1;
}

/** 给机器人看的选项清单（文字为主，文字和值不同时带上值），最多 OPTION_LIST_LIMIT 项。 */
export function describeOptions(options: readonly NativeOption[]): string[] {
  const shown = options.slice(0, OPTION_LIST_LIMIT).map((o) => {
    const label = o.label.trim() || o.value;
    const extra = o.value && o.value !== label ? `（值 ${o.value}）` : "";
    return `${label}${extra}${o.disabled ? "（不可选）" : ""}`;
  });
  if (options.length > OPTION_LIST_LIMIT) shown.push(`……共 ${options.length} 项`);
  return shown;
}

/** 这个元素是原生下拉框、下拉框里的一项，还是别的。 */
export async function nativeSelectKind(
  locator: Locator,
  timeout: number,
): Promise<"select" | "option" | null> {
  const tag = await locator
    .evaluate(
      (el) => {
        const name = el.tagName.toLowerCase();
        if (name === "select") return (el as HTMLSelectElement).multiple ? "multi" : "select";
        if (name === "option" && el.closest("select")) return "option";
        return "";
      },
      undefined,
      { timeout },
    )
    .catch(() => "");
  return tag === "select" || tag === "option" ? tag : null;
}

/** 读出一个原生下拉框的全部选项和当前选中项。 */
export async function readNativeOptions(
  select: Locator,
  timeout: number,
): Promise<{ options: NativeOption[]; selectedIndex: number }> {
  return select.evaluate(
    (el) => {
      const s = el as HTMLSelectElement;
      return {
        options: Array.from(s.options).map((o) => ({
          label: (o.label || o.textContent || "").trim(),
          value: o.value,
          ...(o.disabled ? { disabled: true } : {}),
        })),
        selectedIndex: s.selectedIndex,
      };
    },
    undefined,
    { timeout },
  );
}

/** 关掉可能已经弹出来的系统选项列表：失焦就会收起。 */
async function closePopup(select: Locator, timeout: number) {
  await select.evaluate((el) => (el as HTMLElement).blur(), undefined, { timeout }).catch(() => undefined);
}

/**
 * 在原生下拉框里选中 `wanted` 对应的一项。找不到就抛 SelectOptionError，带上可选项清单，
 * 让机器人换一个写法（而不是一直等到超时、再被说成「元素不在页面上了」）。
 */
export async function chooseNativeOption(
  select: Locator,
  wanted: string,
  acting: { timeout: number; signal?: AbortSignal },
): Promise<{ label: string; value: string; options: string[] }> {
  const { options } = await readNativeOptions(select, acting.timeout);
  const index = pickOption(options, wanted);
  if (index < 0) {
    throw new SelectOptionError(
      `这个下拉框里没有「${wanted}」对应的选项。可选：${describeOptions(options).join("、")}。用 computer_type 填其中一项的文字或值。`,
    );
  }
  await closePopup(select, acting.timeout);
  await select.selectOption({ index }, acting);
  const chosen = options[index]!;
  return { label: chosen.label, value: chosen.value, options: describeOptions(options) };
}

/** 点了下拉框里的某个 option：选中它所在的下拉框里的这一项。 */
export async function chooseClickedOption(
  option: Locator,
  acting: { timeout: number; signal?: AbortSignal },
): Promise<{ label: string; value: string }> {
  const picked = await option.evaluate(
    (el) => {
      const o = el as HTMLOptionElement;
      return { index: o.index, label: (o.label || o.textContent || "").trim(), value: o.value };
    },
    undefined,
    { timeout: acting.timeout },
  );
  const select = option.locator("xpath=ancestor::select[1]");
  await closePopup(select, acting.timeout);
  await select.selectOption({ index: picked.index }, acting);
  return { label: picked.label, value: picked.value };
}

/** 点原生下拉框本身：只聚焦，不弹系统列表；把选项交给机器人。 */
export async function focusNativeSelect(
  select: Locator,
  timeout: number,
): Promise<{ options: string[]; selected?: string }> {
  await select.focus({ timeout }).catch(() => undefined);
  const { options, selectedIndex } = await readNativeOptions(select, timeout);
  const selected = selectedIndex >= 0 ? options[selectedIndex]?.label : undefined;
  return { options: describeOptions(options), ...(selected ? { selected } : {}) };
}

/** 给机器人的提示：怎么选原生下拉框。点下拉框 / 按键之后都附上。 */
export const NATIVE_SELECT_HINT =
  "这是原生下拉框（<select>）：不要点开它或按键，用 computer_type 把要选的选项文字或值填进去（例如月份填「Jul」或「7」），会直接选中。";
