import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { clockStatus, useNow } from "../src/lib/use-now";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

test("many ticking cards share a single interval that stops with the last subscriber", async () => {
  const realSetInterval = globalThis.setInterval;
  let intervals = 0;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    if (args[1] === 1000) intervals += 1;
    return realSetInterval(...args);
  }) as typeof setInterval;
  try {
    const renders: number[] = [0, 0, 0, 0];
    function Card({ index, active }: { index: number; active: boolean }) {
      useNow(active);
      renders[index]! += 1;
      return null;
    }
    const view = render(
      <>
        <Card index={0} active />
        <Card index={1} active />
        <Card index={2} active />
        <Card index={3} active={false} />
      </>,
    );
    expect(clockStatus()).toEqual({ subscribers: 3, running: true });
    expect(intervals).toBe(1);
    const before = [...renders];
    await act(async () => {
      await pause(1150);
    });
    for (const index of [0, 1, 2])
      expect(renders[index]).toBeGreaterThan(before[index]!);
    expect(renders[3]).toBe(before[3]);
    view.unmount();
    expect(clockStatus()).toEqual({ subscribers: 0, running: false });
    const again = render(<Card index={0} active />);
    expect(clockStatus()).toEqual({ subscribers: 1, running: true });
    expect(intervals).toBe(2);
    again.unmount();
    expect(clockStatus().running).toBe(false);
  } finally {
    globalThis.setInterval = realSetInterval;
  }
});

test("an inactive card keeps the last time it saw", async () => {
  const seen: number[] = [];
  function Card({ active }: { active: boolean }) {
    seen.push(useNow(active));
    return null;
  }
  const view = render(<Card active />);
  await act(async () => {
    await pause(1100);
  });
  view.rerender(<Card active={false} />);
  const frozen = seen.at(-1)!;
  await act(async () => {
    await pause(1100);
  });
  view.rerender(<Card active={false} />);
  expect(seen.at(-1)).toBe(frozen);
  expect(clockStatus().running).toBe(false);
  view.unmount();
});
