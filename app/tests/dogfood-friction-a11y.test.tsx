import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { Button } from "@/components/ui/button";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("async Button exposes a single live aria-label, not stacked status copy", () => {
  const { container } = render(
    <Button feedback="copy" state="success">
      复制
    </Button>,
  );
  const button = container.querySelector("button");
  expect(button?.getAttribute("aria-label")).toBe("已复制");
  const labels = container.querySelector(".btn-labels");
  expect(labels?.getAttribute("aria-hidden")).toBe("true");
  // Stacked spans stay in the DOM for layout, but must not form the accessible name.
  expect(labels?.textContent).toContain("已复制");
  expect(labels?.textContent).toContain("复制失败");
});

test("idle Button keeps children as the accessible name (no status aria-label)", () => {
  const { container } = render(
    <Button feedback="copy" state="idle">
      复制
    </Button>,
  );
  const button = container.querySelector("button");
  expect(button?.getAttribute("aria-label")).toBeNull();
});
