import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { presenceRef, usePresenceFlag } from "@/lib/presence-flag";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function Banner({ n }: { n: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} ref={presenceRef("has-test-banner")} />
      ))}
    </>
  );
}

test("presenceRef sets the body flag while at least one element is mounted", () => {
  expect(document.body.hasAttribute("data-has-test-banner")).toBe(false);
  const view = render(<Banner n={2} />);
  expect(document.body.hasAttribute("data-has-test-banner")).toBe(true);
  view.rerender(<Banner n={1} />);
  expect(document.body.hasAttribute("data-has-test-banner")).toBe(true);
  view.rerender(<Banner n={0} />);
  expect(document.body.hasAttribute("data-has-test-banner")).toBe(false);
  view.rerender(<Banner n={1} />);
  expect(document.body.hasAttribute("data-has-test-banner")).toBe(true);
  view.unmount();
  expect(document.body.hasAttribute("data-has-test-banner")).toBe(false);
});

test("presenceRef returns one stable callback per name", () => {
  expect(presenceRef("has-x")).toBe(presenceRef("has-x"));
  expect(presenceRef("has-x")).not.toBe(presenceRef("has-x", "html"));
});

function Shell() {
  usePresenceFlag("has-test-shell", "html");
  return null;
}

test("usePresenceFlag flags <html> while the component is mounted", () => {
  const view = render(<Shell />);
  expect(document.documentElement.hasAttribute("data-has-test-shell")).toBe(
    true,
  );
  view.unmount();
  expect(document.documentElement.hasAttribute("data-has-test-shell")).toBe(
    false,
  );
});
