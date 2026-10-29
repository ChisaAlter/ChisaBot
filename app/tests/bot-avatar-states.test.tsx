import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { settleReactWork } from "./settle-react-work";

/**
 * 审查 10-3 / 10-6 / 10-10 / 10-11 / 10-12 / 10-16：BotAvatar 的加载中、失败、图片坏了；头像窗的格式说明、
 * 拖放反馈、关窗后焦点、取景框的读屏说明。
 */

let BotAvatar: typeof import("@/components/agents/bot-avatar").BotAvatar;
let AvatarField: typeof import("@/components/agents/avatar-picker").AvatarField;
let ACCEPTED_AVATAR_HINT: string;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  ({ BotAvatar } = await import("@/components/agents/bot-avatar"));
  ({ AvatarField } = await import("@/components/agents/avatar-picker"));
  ({ ACCEPTED_AVATAR_HINT } = await import("@/lib/agents/avatars"));
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});
afterEach(cleanup);

const originalFetch = global.fetch;
let respond: () => Promise<Response> = async () =>
  Response.json({ avatars: {} });
beforeEach(() => {
  respond = async () => Response.json({ avatars: {} });
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      if (String(input) === "/api/bot-avatars") return respond();
      return Response.json({ agents: [] });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

// 每个用例的 QueryClient 用完就 clear()：不然查询缓存的 gcTime 定时器会让进程迟迟不退出。
const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});
// happy-dom 的 getAnimations 让 Base UI 关窗收尾拖好几秒；测试里关掉对话框动画（Base UI 自带的开关）。
const g = globalThis as { BASE_UI_ANIMATIONS_DISABLED?: boolean };
const hadAnimationsDisabled = g.BASE_UI_ANIMATIONS_DISABLED;
beforeAll(() => {
  g.BASE_UI_ANIMATIONS_DISABLED = true;
});
afterAll(() => {
  g.BASE_UI_ANIMATIONS_DISABLED = hadAnimationsDisabled;
});

function draw(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}
const kindOf = (root: HTMLElement) =>
  root.querySelector(".bot-ava")?.getAttribute("data-avatar");

describe("BotAvatar", () => {
  test("cold start shows a neutral placeholder, never the default pattern, then the saved avatar", async () => {
    let release: () => void = () => {};
    respond = () =>
      new Promise((resolve) => {
        release = () =>
          resolve(
            Response.json({
              avatars: {
                "bot-1": { kind: "emoji", emoji: "🐶", color: "sky" },
              },
            }),
          );
      });
    const view = draw(<BotAvatar agentId="bot-1" name="助手" />);
    expect(kindOf(view.container)).toBe("loading");
    expect(view.container.querySelector("svg")).toBeNull();
    expect(
      view.container.querySelector(".bot-ava")?.getAttribute("aria-busy"),
    ).toBe("true");
    await act(async () => release());
    await waitFor(() => expect(kindOf(view.container)).toBe("emoji"));
  });

  test("a 500 on the avatar table shows the slate monogram, not the pattern", async () => {
    respond = async () => Response.json({ error: "x" }, { status: 500 });
    const view = draw(<BotAvatar agentId="bot-1" name="助手" />);
    await waitFor(() => expect(kindOf(view.container)).toBe("unknown-error"));
    expect(view.container.querySelector(".bot-ava-c-slate")?.textContent).toBe(
      "助",
    );
  });

  test("no saved avatar → default pattern; broken image → monogram", async () => {
    const plain = draw(<BotAvatar agentId="bot-1" name="助手" />);
    await waitFor(() => expect(kindOf(plain.container)).toBe("pattern"));
    cleanup();
    respond = async () =>
      Response.json({
        avatars: { "bot-1": { kind: "image", url: "/x.webp" } },
      });
    const view = draw(<BotAvatar agentId="bot-1" name="助手" />);
    const img = await waitFor(() => {
      const found = view.container.querySelector("img");
      if (!found) throw new Error("no img yet");
      return found;
    });
    fireEvent.error(img);
    expect(view.container.querySelector(".bot-ava-c-slate")?.textContent).toBe(
      "助",
    );
  });

  test("a draft is shown right away, without waiting for the table", () => {
    respond = () => new Promise(() => {});
    const view = draw(
      <BotAvatar
        agentId="bot-1"
        draft={{ kind: "monogram", color: "mint" }}
        name="助手"
      />,
    );
    expect(kindOf(view.container)).toBe("monogram");
  });
});

describe("avatar dialog", () => {
  function openPicker() {
    const view = draw(
      <AvatarField
        allowPattern
        draft={{ kind: "keep" }}
        name="助手"
        onChange={() => {}}
      />,
    );
    fireEvent.click(view.getByTestId("ava-open"));
    return view;
  }

  test("upload tab lists every accepted format (10-6) and lights up while a file is dragged over (10-10)", async () => {
    const view = openPicker();
    fireEvent.click(await view.findByTestId("ava-tab-upload"));
    const drop = view.getByTestId("ava-choose-file");
    expect(drop.textContent).toContain(ACCEPTED_AVATAR_HINT);
    expect(ACCEPTED_AVATAR_HINT).toContain("GIF");
    fireEvent.dragEnter(drop, {
      dataTransfer: { files: [], dropEffect: "none" },
    });
    expect(drop.getAttribute("data-dragging")).toBe("true");
    expect(drop.textContent).toContain("松开");
    fireEvent.dragLeave(drop, { relatedTarget: document.body });
    expect(drop.getAttribute("data-dragging")).toBeNull();
  });

  test("「完成」 closes the dialog and puts focus back on 更换头像 (10-11)", async () => {
    const view = openPicker();
    fireEvent.click(await view.findByTestId("ava-tab-monogram"));
    fireEvent.click(view.getByTestId("ava-done"));
    // 不用 waitFor：它在这里要轮好几秒才看到焦点。焦点在下一帧就回来了，自己等几帧再看。
    const trigger = view.getByTestId("ava-open");
    for (let i = 0; i < 20 && document.activeElement !== trigger; i++)
      await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
    expect(document.activeElement).toBe(trigger);
  });
});
