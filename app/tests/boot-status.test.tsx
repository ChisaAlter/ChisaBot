import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { BootCommitMarker, reportBootStage } from "../src/lib/boot-status";
import { settleReactWork } from "./settle-react-work";

beforeAll(() =>
  GlobalRegistrator.register({ url: "https://app.example.test/" }),
);
afterEach(async () => {
  cleanup();
  await settleReactWork();
});
afterAll(() => GlobalRegistrator.unregister());

test("the boot marker reports an actual React commit without adding page content", () => {
  const stages: unknown[] = [];
  const listener = (event: Event) => stages.push((event as CustomEvent).detail);
  window.addEventListener("chisabot-boot-stage", listener);
  try {
    reportBootStage("entry-executing");
    const view = render(
      <>
        <BootCommitMarker />
        <p>已打开模型设置</p>
      </>,
    );
    expect(stages).toEqual(["entry-executing", "react-mounted"]);
    expect(view.container.textContent).toBe("已打开模型设置");
  } finally {
    window.removeEventListener("chisabot-boot-stage", listener);
  }
});

test("an unavailable stage event transport cannot interrupt the application", () => {
  const originalDispatch = window.dispatchEvent;
  window.dispatchEvent = () => {
    throw new Error("event transport unavailable");
  };
  try {
    expect(() => reportBootStage("entry-executing")).not.toThrow();
    expect(() => reportBootStage("react-mounted")).not.toThrow();
  } finally {
    window.dispatchEvent = originalDispatch;
  }
});
