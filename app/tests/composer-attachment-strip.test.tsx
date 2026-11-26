import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AttachmentStrip,
  type StagedFile,
} from "@/components/channels/composer/attachment-strip";
import { settleReactWork } from "./settle-react-work";

/**
 * WHAT A SCREEN READER IS OFFERED BY THE ROW ACROSS THE TOP OF THE COMPOSER, AND WHEN.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, matching `agent-roster-error.test.tsx`: bun walks every file into one process, and a
 * document another file tore down mid-run fails invisibly.
 *
 * The registration carries a `url` for the reason `composer-attachments-ui.test.tsx` records:
 * without one `location` is `about:blank` and a thumbnail's relative `src` does not resolve.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const notes: StagedFile = {
  id: "1",
  name: "notes.txt",
  size: 2048,
  loading: false,
};

test("the empty strip stays mounted but leaves the accessibility tree", () => {
  // Two halves of one bargain, and the file's comment used to claim only the first.
  //
  // The list is deliberately NOT unmounted while the composer carries nothing: it is the element
  // `Collapse` measures, and a box with nothing in it to measure cannot animate its own height.
  //
  // What that costs is the part the comment got wrong. Height 0 under `overflow-hidden` is a
  // visual state, not an accessibility one, so an `aria-label`led `<ul>` sitting at zero height is
  // still a labelled list a screen reader walks into and announces — "Attachments, list, 0 items"
  // — on a composer with no attachments on it. Nothing is drawn; something is still read.
  const { container, queryByRole } = render(
    <AttachmentStrip files={[]} images={[]} onRemove={() => {}} />,
  );

  expect(container.querySelector("ul")).toBeTruthy();
  expect(queryByRole("list")).toBeNull();
  expect(queryByRole("list", { name: "附件" })).toBeNull();
});

test("the strip is announced once it carries something", () => {
  // The other half: hiding the empty list must not hide the full one, or the label stops being
  // worth having at the only moment it says anything.
  const { getAllByRole, getByRole } = render(
    <AttachmentStrip files={[notes]} images={[]} onRemove={() => {}} />,
  );

  expect(getByRole("list", { name: "附件" })).toBeTruthy();
  expect(getAllByRole("listitem")).toHaveLength(1);
});

test("the strip leaves the accessibility tree again when the last one goes", () => {
  // Removing the last attachment is the ordinary way back to empty, and it is the path that would
  // leave a stale labelled list behind if the hiding were done once at mount.
  const { queryByRole, rerender } = render(
    <AttachmentStrip files={[notes]} images={[]} onRemove={() => {}} />,
  );

  expect(queryByRole("list", { name: "附件" })).toBeTruthy();

  rerender(<AttachmentStrip files={[]} images={[]} onRemove={() => {}} />);

  expect(queryByRole("list")).toBeNull();
});

test("an image on its own puts the strip back in the accessibility tree", () => {
  // `occupied` is either list being non-empty; a strip carrying only a picture is announced too.
  const { getAllByRole, getByRole } = render(
    <AttachmentStrip
      files={[]}
      images={[{ id: "2", url: "/a.png", alt: "A cat", loading: false }]}
      onRemove={() => {}}
    />,
  );

  expect(getByRole("list", { name: "附件" })).toBeTruthy();
  expect(getAllByRole("listitem")).toHaveLength(1);
});

test("an image still going up is named rather than left a blank box", () => {
  // The same pattern as the empty list, one level down. The skeleton is drawn to hold the tile's
  // shape while the bytes are in flight, and holding a shape was all it was asked to do — so the
  // tile announced nothing at all, and the only thing a screen reader found inside it was a button
  // offering to remove something that had never been named. The file tile beside it has said
  // "Uploading…" in plain text all along; the picture said nothing.
  //
  // Named, not announced: no live region here. The file tile does not have one either, and a paste
  // of eight images would otherwise interrupt with eight of them.
  const { getByRole } = render(
    <AttachmentStrip
      files={[]}
      images={[{ id: "3", url: "", alt: "A cat", loading: true }]}
      onRemove={() => {}}
    />,
  );

  expect(getByRole("img", { name: "A cat，正在上传" })).toBeTruthy();
});

test("an unnamed image going up falls back to the same word the finished one uses", () => {
  const { getByRole } = render(
    <AttachmentStrip
      files={[]}
      images={[{ id: "4", url: "", loading: true }]}
      onRemove={() => {}}
    />,
  );

  expect(getByRole("img", { name: "附件，正在上传" })).toBeTruthy();
});

test("a text file that fits shows no truncation warning", () => {
  // mayTruncate is what composer.tsx sets from mayBeTruncatedForModel: a file
  // at or under MAX_EXTRACTED_CHARACTERS cannot be cut (N bytes decode to at
  // most N chars), so the tile must not warn about it.
  const { queryByText } = render(
    <AttachmentStrip files={[notes]} images={[]} onRemove={() => {}} />,
  );

  expect(queryByText(/可能被截断/)).toBeNull();
});

test("a text file over the extraction ceiling warns it may be read truncated", () => {
  // The gap this closes: the server accepts up to MAX_FILE_BYTES and the
  // model reads the first MAX_EXTRACTED_CHARACTERS, so a file between the two
  // arrives truncated with nothing on screen saying so. Warned, never refused.
  const { getByText } = render(
    <AttachmentStrip
      files={[{ ...notes, id: "5", mayTruncate: true }]}
      images={[]}
      onRemove={() => {}}
    />,
  );

  expect(getByText(/· 可能被截断/)).toBeTruthy();
});

test("clicking an uploaded image opens Lightbox and Escape closes it", async () => {
  const { getByLabelText, getByRole, queryByRole } = render(
    <AttachmentStrip
      files={[]}
      images={[
        {
          id: "img-1",
          url: "/api/attachments/att-1",
          alt: "sunset.png",
          loading: false,
        },
      ]}
      onRemove={() => {}}
    />,
  );

  expect(queryByRole("dialog")).toBeNull();
  const trigger = getByLabelText("预览 sunset.png") as HTMLButtonElement;
  expect(trigger.tagName).toBe("BUTTON");
  fireEvent.click(trigger);

  const dialog = getByRole("dialog");
  const lightboxImg = dialog.querySelector("img.rp-lightbox-img");
  expect(lightboxImg?.getAttribute("src")).toBe("/api/attachments/att-1");

  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(queryByRole("dialog") === null).toBe(true));
});

test("an image with local previewUrl is previewable while uploading, while skeleton-only stays inert", () => {
  const { getByLabelText, getByRole, queryByLabelText, queryByRole } = render(
    <AttachmentStrip
      files={[]}
      images={[
        {
          id: "local-1",
          url: "",
          previewUrl: "blob:http://localhost/local-preview-1",
          alt: "local.png",
          loading: true,
        },
        {
          id: "skel-1",
          url: "",
          alt: "pending.png",
          loading: true,
        },
      ]}
      onRemove={() => {}}
    />,
  );

  expect(getByRole("img", { name: "pending.png，正在上传" })).toBeTruthy();
  expect(queryByLabelText("预览 pending.png")).toBeNull();

  fireEvent.click(getByLabelText("预览 local.png"));
  const dialog = getByRole("dialog");
  expect(dialog.querySelector("img.rp-lightbox-img")?.getAttribute("src")).toBe(
    "blob:http://localhost/local-preview-1",
  );
  expect(queryByRole("dialog")?.querySelector(".rp-lightbox-count")).toBeNull();
});

test("multi-image draft opens on clicked image and switches across previewable images", () => {
  const { getByLabelText, getByRole } = render(
    <AttachmentStrip
      files={[]}
      images={[
        {
          id: "a",
          url: "/api/attachments/a",
          alt: "first.png",
          loading: false,
        },
        {
          id: "skip",
          url: "",
          alt: "uploading.png",
          loading: true,
        },
        {
          id: "b",
          url: "",
          previewUrl: "blob:http://localhost/second",
          alt: "second.png",
          loading: true,
        },
        {
          id: "c",
          url: "/api/attachments/c",
          alt: "third.png",
          loading: false,
        },
      ]}
      onRemove={() => {}}
    />,
  );

  fireEvent.click(getByLabelText("预览 second.png"));
  const dialog = getByRole("dialog");
  expect(dialog.querySelector("img.rp-lightbox-img")?.getAttribute("src")).toBe(
    "blob:http://localhost/second",
  );
  expect(dialog.querySelector(".rp-lightbox-count")?.textContent).toBe("2 / 3");

  fireEvent.click(getByLabelText("下一张"));
  expect(dialog.querySelector("img.rp-lightbox-img")?.getAttribute("src")).toBe(
    "/api/attachments/c",
  );
  expect(dialog.querySelector(".rp-lightbox-count")?.textContent).toBe("3 / 3");

  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expect(dialog.querySelector("img.rp-lightbox-img")?.getAttribute("src")).toBe(
    "blob:http://localhost/second",
  );
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expect(dialog.querySelector("img.rp-lightbox-img")?.getAttribute("src")).toBe(
    "/api/attachments/a",
  );
});

test("remove, retry, and disabled preview buttons never accidentally open Lightbox", () => {
  const removed: string[] = [];
  const retried: string[] = [];
  const { getByLabelText, queryByRole } = render(
    <AttachmentStrip
      failed={[{ id: "fail-1", name: "broken.png", reason: "上传失败" }]}
      files={[]}
      images={[
        {
          id: "img-enabled",
          url: "/api/attachments/1",
          alt: "ok.png",
          loading: false,
        },
        {
          id: "img-disabled",
          url: "/api/attachments/2",
          alt: "locked.png",
          loading: false,
          disabled: true,
        },
      ]}
      onRemove={(id) => removed.push(id)}
      onRetry={(id) => retried.push(id)}
    />,
  );

  fireEvent.click(getByLabelText("移除 ok.png"));
  expect(removed).toEqual(["img-enabled"]);
  expect(queryByRole("dialog")).toBeNull();

  fireEvent.click(getByLabelText("重试上传 broken.png"));
  expect(retried).toEqual(["fail-1"]);
  expect(queryByRole("dialog")).toBeNull();

  const disabledPreview = getByLabelText(
    "预览 locked.png",
  ) as HTMLButtonElement;
  expect(disabledPreview.disabled).toBe(true);
  fireEvent.click(disabledPreview);
  expect(queryByRole("dialog")).toBeNull();
});

test("keyboard Enter and Space open Lightbox and Escape closes it", async () => {
  const user = userEvent.setup({ document: globalThis.document });
  const { getByLabelText, getByRole, queryByRole } = render(
    <AttachmentStrip
      files={[]}
      images={[
        {
          id: "kbd-1",
          url: "/api/attachments/kbd-1",
          alt: "kbd.png",
          loading: false,
        },
      ]}
      onRemove={() => {}}
    />,
  );

  const trigger = getByLabelText("预览 kbd.png") as HTMLButtonElement;
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(getByRole("dialog").querySelector("img.rp-lightbox-img")).toBeTruthy();

  await user.keyboard("{Escape}");
  await waitFor(() => expect(queryByRole("dialog") === null).toBe(true));

  trigger.focus();
  await user.keyboard(" ");
  expect(getByRole("dialog").querySelector("img.rp-lightbox-img")).toBeTruthy();
});
