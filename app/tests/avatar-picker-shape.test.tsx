import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AvatarDraft } from "@/lib/agents/avatars";

/** 头像窗的「形象」页（DESIGN.md §81）：新建时默认停在这一页，选形状和颜色，按「完成」写进表单草稿。 */
let AvatarField: typeof import("@/components/agents/avatar-picker").AvatarField;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  ({ AvatarField } = await import("@/components/agents/avatar-picker"));
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
afterEach(cleanup);

/** `autoPicked`：和新建表单一样，当前头像是自动给的首字，不是用户选的。 */
function open(draft: AvatarDraft, onChange: (next: AvatarDraft) => void, autoPicked = false) {
  const ui = render(
    <QueryClientProvider client={new QueryClient()}>
      <AvatarField allowPattern={!autoPicked} autoPicked={autoPicked} draft={draft} name="新" onChange={onChange} />
    </QueryClientProvider>,
  );
  fireEvent.click(ui.getByText("更换头像"));
  return ui;
}

describe("avatar dialog · 形象", () => {
  test("a new bot opens on the shape tab, and the choice goes into the draft as shape + colour", async () => {
    const changes: AvatarDraft[] = [];
    const ui = open({ kind: "monogram", color: "sky" }, (next) => changes.push(next), true);
    const tab = await waitFor(() => ui.getByTestId("ava-tab-shape"));
    expect(tab.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(ui.getByTestId("ava-shape-tile"));
    fireEvent.click(ui.getByTestId("ava-shape-color-red"));
    expect(ui.getByTestId("ava-shape-tile").getAttribute("aria-checked")).toBe("true");
    expect(ui.getByTestId("ava-shape-color-red").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(ui.getByTestId("ava-done"));
    await waitFor(() => expect(changes).toEqual([{ kind: "shape", shape: "tile", color: "red" }]));
  });

  test("an existing shape avatar reopens on its own shape and colour", async () => {
    const ui = open({ kind: "shape", shape: "drop", color: "teal" }, () => {});
    await waitFor(() => ui.getByTestId("ava-shape-drop"));
    expect(ui.getByTestId("ava-shape-drop").getAttribute("aria-checked")).toBe("true");
    expect(ui.getByTestId("ava-shape-color-teal").getAttribute("aria-checked")).toBe("true");
  });

  test("the mood buttons only change the preview, never the saved choice", async () => {
    const changes: AvatarDraft[] = [];
    const ui = open({ kind: "monogram", color: "sky" }, (next) => changes.push(next), true);
    await waitFor(() => ui.getByTestId("ava-mood-working"));
    fireEvent.click(ui.getByTestId("ava-mood-working"));
    expect(ui.getByTestId("ava-mood-working").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(ui.getByTestId("ava-done"));
    await waitFor(() => expect(changes).toEqual([{ kind: "shape", shape: "round", color: "violet" }]));
  });
});