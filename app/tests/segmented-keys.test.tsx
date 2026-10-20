import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { useSegmentedKeys } from "@/components/ui/segmented";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

const VALUES = ["a", "b", "c"] as const;

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const keys = useSegmentedKeys<string>({ value, values: [...VALUES], onChange: setValue });
  return (
    <div aria-label="测试" role="radiogroup" {...keys.groupProps} ref={keys.groupRef}>
      {VALUES.map((item) => (
        <button
          aria-checked={value === item}
          key={item}
          onClick={() => setValue(item)}
          role="radio"
          tabIndex={keys.itemTabIndex(item)}
          type="button"
        >
          {item}
        </button>
      ))}
      <output data-testid="value">{value}</output>
    </div>
  );
}

const radios = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[role="radio"]')];

/**
 * 2026-10-20 审查：`.sg-segmented` 的十来处手写 radiogroup 都缺 ARIA radio 的键盘约定。
 * 规则集中到 `useSegmentedKeys`，这里钉住它：roving tabindex、方向键循环、焦点跟随、边界。
 */
test("Tab 只停在选中项（roving tabindex）", () => {
  const { container } = render(<Harness initial="b" />);
  expect(radios(container).map((el) => el.tabIndex)).toEqual([-1, 0, -1]);
});

test("方向键换选项，焦点跟到新选中项", () => {
  const { container, getByTestId } = render(<Harness initial="a" />);
  const group = container.querySelector('[role="radiogroup"]') as HTMLElement;
  radios(container)[0]?.focus();

  fireEvent.keyDown(group, { key: "ArrowRight" });
  expect(getByTestId("value").textContent).toBe("b");
  expect(document.activeElement?.textContent).toBe("b");

  fireEvent.keyDown(group, { key: "ArrowDown" });
  expect(getByTestId("value").textContent).toBe("c");
  expect(document.activeElement?.textContent).toBe("c");
});

test("首尾相接，Home / End 到两端", () => {
  const { container, getByTestId } = render(<Harness initial="c" />);
  const group = container.querySelector('[role="radiogroup"]') as HTMLElement;

  fireEvent.keyDown(group, { key: "ArrowRight" });
  expect(getByTestId("value").textContent).toBe("a");

  fireEvent.keyDown(group, { key: "ArrowLeft" });
  expect(getByTestId("value").textContent).toBe("c");

  fireEvent.keyDown(group, { key: "Home" });
  expect(getByTestId("value").textContent).toBe("a");

  fireEvent.keyDown(group, { key: "End" });
  expect(getByTestId("value").textContent).toBe("c");
});

test("选中的值不在列表里时，第一项仍然进得去", () => {
  const { container } = render(<Harness initial="gone" />);
  expect(radios(container).map((el) => el.tabIndex)).toEqual([0, -1, -1]);
});

test("无关按键不动它", () => {
  const { container, getByTestId } = render(<Harness initial="b" />);
  const group = container.querySelector('[role="radiogroup"]') as HTMLElement;
  fireEvent.keyDown(group, { key: "a" });
  expect(getByTestId("value").textContent).toBe("b");
});
