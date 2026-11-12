import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

/**
 * CB-100c: the public gateway (deploy/public) must see the app's "I draw my own sign-out" marker,
 * or it floats its own sign-out button over the right drawer.
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

function mountWith(script: string, body: string) {
  const window = new Window({ url: "https://chisa.example/" });
  windows.push(window);
  window.document.body.innerHTML = body;
  new Function("window", "document", script)(window, window.document);
  return window.document;
}

test("index declares the app-owned account control marker", () => {
  expect(html).toContain('<div id="chisabot-account-control" hidden></div>');
});

test("current gateway adds no floating sign-out button over the app", () => {
  const markers = html
    .match(/<div id="chisabot-account-control" hidden><\/div>/g)!
    .join("");
  const document = mountWith(gateway, markers);
  expect(document.querySelectorAll("#chisabot-account-control").length).toBe(1);
  expect(
    document.querySelector("[id$=account-control]:not([hidden])"),
  ).toBeNull();
});

test("the gateway still mounts its button for a page without any marker", () => {
  const document = mountWith(gateway, "<main></main>");
  const host = document.querySelector("#chisabot-account-control");
  expect(host).not.toBeNull();
  const button = host!.shadowRoot!.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe("退出 ChisaBot 登录");
});
