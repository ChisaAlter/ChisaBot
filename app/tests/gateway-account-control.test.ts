import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

/**
 * CB-100c: the public gateway (deploy/public) is not updated together with the app image. Every
 * gateway generation must see the app's "I draw my own sign-out" marker, or it floats its own
 * 「退出登录」 button over the right drawer (dogfood 2026-10-26, v0.1.75: 「退出 OpenBot 登录」).
 */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const gateway = readFileSync(
  new URL("../../deploy/public/auth-web/workspace.js", import.meta.url),
  "utf8",
);

const windows: Window[] = [];
afterEach(async () => {
  // The gateway starts a 45 s session poll; close each page so its timers do not outlive the test.
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

/**
 * Runs the gateway script against a page holding `body`.
 *
 * happy-dom 20+ no longer evaluates scripts by default, and under Bun its VM context never gains an
 * `eval` even when evaluation is switched on, so `window.eval(script)` threw for every case here.
 * The script only reaches the page through `window` and `document` (it is an IIFE written for a
 * browser), so it is run as a function of exactly those two. It is a file from this repository.
 */
function mountWith(script: string, body: string) {
  const window = new Window({ url: "https://chisa.example/" });
  windows.push(window);
  window.document.body.innerHTML = body;
  new Function("window", "document", script)(window, window.document);
  return window.document;
}

test("index.html carries the current and the pre-rename marker", () => {
  expect(html).toContain('<div id="chisabot-account-control" hidden></div>');
  expect(html).toContain('<div id="openbot-account-control" hidden></div>');
});

const legacyGateway = gateway.replaceAll(
  "chisabot-account-control",
  "openbot-account-control",
);

for (const [name, script] of [
  ["current gateway", gateway],
  ["pre-rename gateway", legacyGateway],
] as const) {
  test(`${name} adds no floating sign-out button over the app`, () => {
    const markers = html
      .match(/<div id="(?:chisabot|openbot)-account-control" hidden><\/div>/g)!
      .join("");
    const document = mountWith(script, markers);
    expect(
      document.querySelectorAll(
        "#chisabot-account-control, #openbot-account-control",
      ).length,
    ).toBe(2);
    expect(
      document.querySelector("[id$=account-control]:not([hidden])"),
    ).toBeNull();
  });
}

test("the gateway still mounts its button for a page without any marker", () => {
  const document = mountWith(gateway, "<main></main>");
  const host = document.querySelector("#chisabot-account-control");
  expect(host).not.toBeNull();
  const button = host!.shadowRoot!.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe("退出 ChisaBot 登录");
});

test("the gateway honours an older app that only has the pre-rename marker", () => {
  const document = mountWith(
    gateway,
    '<div id="openbot-account-control" hidden></div>',
  );
  expect(document.querySelector("#chisabot-account-control")).toBeNull();
});
