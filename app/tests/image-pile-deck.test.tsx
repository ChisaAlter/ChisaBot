import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Spec } from "@json-render/react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { LinkCardStack } from "@/components/rich-previews/link-card";
import {
  ImagePile,
  imagePileGeometry,
} from "@/components/rich-previews/rich-previews";
import { JsonRenderSurface } from "@/lib/conversations/json-render-surface";
import { inspectRenderUiSpec } from "../../shared/json-render/catalog";
import { settleReactWork } from "./settle-react-work";

describe("imagePileGeometry", () => {
  test("computes spread slots and span bounds for 2, 3, and 4 images", () => {
    const two = imagePileGeometry(2);
    expect(two.leftSpan).toBe(0.42);
    expect(two.rightSpan).toBe(0.42);
    expect(two.dropSpan).toBe(0.32);
    expect(two.slots).toEqual([
      { sx: -0.42, sy: 0, rot: -2.8, scale: 1, z: 20 },
      { sx: 0.42, sy: 0.32, rot: 3.5, scale: 0.95, z: 10 },
    ]);

    const three = imagePileGeometry(3);
    expect(three.leftSpan).toBe(0.82);
    expect(three.rightSpan).toBe(0.82);
    expect(three.dropSpan).toBe(0.38);
    expect(three.slots).toEqual([
      { sx: -0.82, sy: 0.28, rot: -4, scale: 0.94, z: 20 },
      { sx: 0, sy: 0, rot: 0, scale: 1, z: 30 },
      { sx: 0.82, sy: 0.38, rot: 3.5, scale: 0.94, z: 10 },
    ]);

    const four = imagePileGeometry(4);
    expect(four.leftSpan).toBe(1.02);
    expect(four.rightSpan).toBe(1.02);
    expect(four.dropSpan).toBe(0.28);
    expect(four.slots).toHaveLength(4);
    expect(four.slots[2]?.z).toBe(30);
    expect(four.slots[3]?.sx).toBe(1.02);
  });
});

const realFetch = globalThis.fetch;

describe("ImagePile, LinkCardStack, and JsonRenderSurface media deck", () => {
  beforeAll(() => {
    if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
    (
      window as unknown as { happyDOM?: { setURL(url: string): void } }
    ).happyDOM?.setURL("http://localhost/");
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = decodeURIComponent(String(input).split("url=")[1] ?? "");
      return new Response(
        JSON.stringify({
          preview: {
            url,
            finalUrl: url,
            title: `Preview ${url}`,
            siteName: "Example",
            domain: "example.com",
            description: "",
            image: null,
            imageKind: "none",
            imagePending: false,
            favicon: null,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
  });

  afterEach(() => cleanup());

  afterAll(async () => {
    await settleReactWork();
    globalThis.fetch = realFetch;
    GlobalRegistrator.unregister();
  });

  test("ImagePile renders captioned images with sibling external links and opens Lightbox directly on click", () => {
    const view = render(
      <ImagePile
        images={[
          {
            src: "/api/chat-files/cf_1",
            alt: "湖畔木桥",
            caption: "第一张",
            href: "https://picsum.photos/id/1/800/600",
          },
          {
            src: "/api/chat-files/cf_2",
            alt: "群山晨雾",
            caption: "第二张",
            href: "https://picsum.photos/id/2/800/600",
          },
          {
            src: "/api/chat-files/cf_3",
            alt: "森林小径",
            caption: "第三张",
          },
        ]}
      />,
    );

    const pile = view.getByRole("group", { name: "3 张图片" });
    expect(pile.hasAttribute("data-captioned")).toBe(true);

    const cards = [...view.container.querySelectorAll(".rp-pile-card")];
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.querySelector("a")).toBeNull();
    }

    const links = [...view.container.querySelectorAll("a.rp-pile-go")];
    expect(links).toHaveLength(2);
    expect(links[0]?.closest(".rp-pile-card")).toBeNull();
    expect(links[0]?.closest(".rp-pile-item")).not.toBeNull();

    fireEvent.click(view.getByLabelText("查看第 2 张图片（共 3 张）"));
    const dialog = view.getByRole("dialog");
    expect(
      dialog.querySelector("img.rp-lightbox-img")?.getAttribute("src"),
    ).toBe("/api/chat-files/cf_2");
  });

  test("JsonRenderSurface upgrades Card > Carousel > 3 Image to a shell-less ImagePile", () => {
    const verdict = inspectRenderUiSpec(
      JSON.stringify({
        root: "card",
        elements: {
          card: {
            type: "Card",
            props: { title: "三张图", icon: "photo" },
            children: ["car"],
          },
          car: {
            type: "Carousel",
            props: { itemWidth: "md" },
            children: ["i1", "i2", "i3"],
          },
          i1: {
            type: "Image",
            props: {
              src: "/api/chat-files/cf_1",
              alt: "图1",
              caption: "第一张",
              href: "https://example.com/1",
            },
            children: [],
          },
          i2: {
            type: "Image",
            props: {
              src: "/api/chat-files/cf_2",
              alt: "图2",
              caption: "第二张",
            },
            children: [],
          },
          i3: {
            type: "Image",
            props: {
              src: "/api/chat-files/cf_3",
              alt: "图3",
              caption: "第三张",
            },
            children: [],
          },
        },
      }),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const view = render(
      <JsonRenderSurface spec={verdict.spec as Spec} streaming={false} />,
    );
    expect(view.container.querySelector(".jr-card")).toBeNull();
    expect(view.container.querySelector(".jr-carousel")).toBeNull();
    const surface = view.container.querySelector(".jr-surface");
    expect(surface?.getAttribute("data-media-deck")).toBe("images");
    const cards = view.container.querySelectorAll(".rp-pile-card");
    expect(cards).toHaveLength(3);
    expect(
      view.container.querySelector(".rp-pile")?.hasAttribute("data-captioned"),
    ).toBe(true);
  });

  test("JsonRenderSurface upgrades Carousel > 2 Link to LinkCardStack with tilted two-card fan", async () => {
    const verdict = inspectRenderUiSpec(
      JSON.stringify({
        root: "car",
        elements: {
          car: {
            type: "Carousel",
            props: {},
            children: ["l1", "l2"],
          },
          l1: {
            type: "Link",
            props: {
              url: "https://two-1.example.com/a",
              title: "OPPO Enco Free4",
            },
            children: [],
          },
          l2: {
            type: "Link",
            props: {
              url: "https://two-2.example.com/b",
              title: "vivo TWS 5",
            },
            children: [],
          },
        },
      }),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const view = render(
      <JsonRenderSurface spec={verdict.spec as Spec} streaming={false} />,
    );
    expect(view.container.querySelector(".jr-carousel")).toBeNull();
    const cards = await view.findAllByTestId("link-card");
    expect(cards).toHaveLength(2);
    const items = [...view.container.querySelectorAll<HTMLElement>(".lc-item")];
    expect(items[0]?.style.getPropertyValue("--lc-rot")).toBe("-2.5deg");
    expect(items[1]?.style.getPropertyValue("--lc-rot")).toBe("3.5deg");
    expect(items[1]?.style.getPropertyValue("--lc-sy")).toBe("0.4");
  });

  test("LinkCardStack two-card fan uses tilted slots while three-card keeps centered main slot", async () => {
    const view = render(
      <LinkCardStack
        items={[
          { url: "https://fan-1.example.com/", title: "卡片一", site: "站一" },
          { url: "https://fan-2.example.com/", title: "卡片二", site: "站二" },
        ]}
      />,
    );
    const cards = await view.findAllByTestId("link-card");
    expect(cards).toHaveLength(2);
    const items = [...view.container.querySelectorAll<HTMLElement>(".lc-item")];
    expect(items[0]?.style.getPropertyValue("--lc-rot")).toBe("-2.5deg");
    expect(items[1]?.style.getPropertyValue("--lc-rot")).toBe("3.5deg");
    expect(items[1]?.style.getPropertyValue("--lc-sy")).toBe("0.4");
  });

  test("JsonRenderSurface upgrades nested Carousel inside composite Card to ImagePile", () => {
    const verdict = inspectRenderUiSpec(
      JSON.stringify({
        root: "card",
        elements: {
          card: {
            type: "Card",
            props: { title: "图文混排" },
            children: ["txt", "car"],
          },
          txt: {
            type: "Text",
            props: { text: "这里是正文说明" },
            children: [],
          },
          car: {
            type: "Carousel",
            props: {},
            children: ["i1", "i2", "i3"],
          },
          i1: {
            type: "Image",
            props: { src: "/api/chat-files/cf_a", alt: "图A" },
            children: [],
          },
          i2: {
            type: "Image",
            props: { src: "/api/chat-files/cf_b", alt: "图B" },
            children: [],
          },
          i3: {
            type: "Image",
            props: { src: "/api/chat-files/cf_c", alt: "图C" },
            children: [],
          },
        },
      }),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const view = render(
      <JsonRenderSurface spec={verdict.spec as Spec} streaming={false} />,
    );
    expect(view.container.querySelector(".jr-card")).not.toBeNull();
    expect(view.container.querySelector(".jr-carousel")).toBeNull();
    expect(view.container.textContent).toContain("这里是正文说明");
    expect(
      view.container.querySelectorAll(".rp-pile .rp-pile-card"),
    ).toHaveLength(3);
  });
});
