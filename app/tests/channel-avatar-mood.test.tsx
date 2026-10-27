import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { avatarKeys } from "@/lib/agents/avatars";
import { agentListQueryOptions } from "@/lib/agents/queries";

/** 机器人列表 / 对话行里的形象头像：选中、在跑会变表情（DESIGN.md §81）。默认左栏是机器人列表，曾经漏接。 */
let ChannelAvatar: typeof import("@/components/channels/avatar").ChannelAvatar;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  ({ ChannelAvatar } = await import("@/components/channels/avatar"));
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
afterEach(cleanup);

function mount(props: { selected?: boolean; working?: boolean; typing?: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } });
  client.setQueryData(avatarKeys.all, { bot1: { kind: "shape", shape: "round", color: "red" }, bot2: { kind: "monogram", color: "sky" } });
  client.setQueryData(agentListQueryOptions().queryKey, []);
  return render(
    <QueryClientProvider client={client}>
      <ChannelAvatar participantIds={["bot1"]} size={28} {...props} />
    </QueryClientProvider>,
  );
}
const mood = (ui: ReturnType<typeof mount>) => ui.container.querySelector(".sa")?.getAttribute("data-mood");

describe("ChannelAvatar moods", () => {
  test("a bot-list row passes selected / working through to the shape avatar", () => {
    expect(mood(mount({}))).toBe("idle");
    expect(mood(mount({ selected: true }))).toBe("selected");
    expect(mood(mount({ working: true }))).toBe("working");
    expect(mood(mount({ selected: true, working: true }))).toBe("working");
  });

  test("a conversation row's `typing` still means working, and still draws the badge; `working` alone draws none", () => {
    const typing = mount({ typing: true });
    expect(mood(typing)).toBe("working");
    expect(typing.container.textContent).toContain("正在处理中");
    cleanup();
    const working = mount({ working: true });
    expect(mood(working)).toBe("working");
    expect(working.container.textContent).not.toContain("正在处理中");
  });

  test("an avatar that is not a shape is untouched by the mood props", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } });
    client.setQueryData(avatarKeys.all, { bot2: { kind: "monogram", color: "sky" } });
    client.setQueryData(agentListQueryOptions().queryKey, []);
    const ui = render(
      <QueryClientProvider client={client}>
        <ChannelAvatar participantIds={["bot2"]} selected size={28} working />
      </QueryClientProvider>,
    );
    expect(ui.container.querySelector(".sa")).toBeNull();
  });
});