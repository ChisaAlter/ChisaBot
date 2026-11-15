import { describe, expect, test } from "bun:test";
import { classifySiteBlock } from "../src/site-block";

const CF_BLOCK = `Please enable cookies.
Sorry, you have been blocked
You are unable to access x.ai
Why have I been blocked?
This website is using a security service to protect itself from online attacks.
What can I do to resolve this?
Cloudflare Ray ID: 8c1f2a3b4c5d6e7f • Your IP: Click to reveal • Performance & security by Cloudflare`;

describe("site block pages", () => {
  test("Cloudflare 'you have been blocked' names the blocked site", () => {
    const block = classifySiteBlock({
      title: "Attention Required! | Cloudflare",
      text: CF_BLOCK,
      url: "https://accounts.x.ai/",
    });
    expect(block?.kind).toBe("cloudflare-block");
    expect(block?.site).toBe("x.ai");
    expect(block?.notice).toContain("接管控制");
    expect(block?.notice).toContain("EGRESS_PROXY_DEFAULT");
  });

  test("Cloudflare error 1020 access denied", () => {
    expect(
      classifySiteBlock({
        title: "Access denied | example.com used Cloudflare to restrict access",
        text: "Error 1020\nAccess denied\nWhat happened?\nCloudflare Ray ID: 123",
        url: "https://www.example.com/",
      }),
    ).toMatchObject({ kind: "cloudflare-block", site: "example.com" });
  });

  test("a short generic Access Denied page", () => {
    expect(
      classifySiteBlock({
        title: "Access Denied",
        text: "Access Denied\nYou don't have permission to access \"http://shop.example/\" on this server.\nReference #18.abc",
        url: "https://shop.example/",
      })?.kind,
    ).toBe("access-denied");
  });

  test("a Cloudflare challenge is not a block (challenge.ts owns it)", () => {
    expect(
      classifySiteBlock({
        title: "Just a moment...",
        text: "Verifying you are human. This may take a few seconds.\nCloudflare Ray ID: 1",
        url: "https://chatgpt.com/",
      }),
    ).toBeUndefined();
  });

  test("ordinary pages that mention access are not blocks", () => {
    expect(
      classifySiteBlock({
        title: "Grok",
        text: `What should we explore? ${"Sign in to access your chats. ".repeat(200)}`,
        url: "https://grok.com/",
      }),
    ).toBeUndefined();
    expect(
      classifySiteBlock({
        title: "Help",
        text: "If you are unable to access your account, reset your password.",
        url: "https://help.example/",
      }),
    ).toBeUndefined();
  });
});
