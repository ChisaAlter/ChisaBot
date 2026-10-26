import { afterAll, describe, expect, test } from "bun:test";
import { parseAriaSnapshot } from "../src/aria-snapshot";
import { describeOptions, type NativeOption, OPTION_LIST_LIMIT, pickOption } from "../src/native-select";

/**
 * 原生 `<select>`（DESIGN.md §100）。2026-10-17 用户截图：机器人在 Hark 注册页选生日，点开月份下拉框后
 * 「填写」「按键」都超时，这一轮静默结束。现在「填写」一个原生下拉框 = 选中对应的选项。
 */

const opts = (labels: string[], values?: string[]): NativeOption[] =>
  labels.map((label, i) => ({ label, value: values ? values[i]! : label }));

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

describe("which option a filled-in value means", () => {
  test("the Hark birthday form: Month / Day / Year", () => {
    const month = [{ label: "Month", value: "", disabled: true }, ...opts(MONTHS_EN)];
    expect(pickOption(month, "7")).toBe(7);
    expect(pickOption(month, "07")).toBe(7);
    expect(pickOption(month, "Jul")).toBe(7);
    expect(pickOption(month, "July")).toBe(7);
    expect(pickOption(month, "七月")).toBe(7);
    expect(pickOption(month, "7月")).toBe(7);
    const days = opts(Array.from({ length: 31 }, (_, i) => String(i + 1)));
    expect(pickOption(days, "12")).toBe(11);
    expect(pickOption(days, "12日")).toBe(11);
    const years = opts(Array.from({ length: 100 }, (_, i) => String(2026 - i)));
    expect(pickOption(years, "2000")).toBe(26);
  });

  test("month values that start at 0 still pick by the month name", () => {
    const month = opts(MONTHS_EN, MONTHS_EN.map((_, i) => String(i)));
    expect(pickOption(month, "7")).toBe(6);
    expect(month[pickOption(month, "7")]!.label).toBe("Jul");
  });

  test("exact value, zero-padded numbers and a unique prefix", () => {
    const list = opts(["Hong Kong", "Hungary", "China"], ["HK", "HU", "CN"]);
    expect(pickOption(list, "cn")).toBe(2);
    expect(pickOption(list, "Hong")).toBe(0);
    expect(pickOption(list, "H")).toBe(-1); // two start with H: ambiguous
    expect(pickOption(opts(["01", "02", "03"]), "2")).toBe(1);
  });

  test("disabled and missing options are never chosen", () => {
    const list = [{ label: "A", value: "a", disabled: true }, { label: "B", value: "b" }];
    expect(pickOption(list, "A")).toBe(-1);
    expect(pickOption(list, "Z")).toBe(-1);
    expect(pickOption(list, "")).toBe(-1);
  });

  test("a long list is cut for the Bot, with the total", () => {
    const list = opts(Array.from({ length: 100 }, (_, i) => String(i)));
    const shown = describeOptions(list);
    expect(shown).toHaveLength(OPTION_LIST_LIMIT + 1);
    expect(shown.at(-1)).toBe("……共 100 项");
    expect(describeOptions([{ label: "Jul", value: "7" }])).toEqual(["Jul（值 7）"]);
  });
});

describe("a native select in the snapshot", () => {
  test("its options fold into the combobox instead of one element each", () => {
    const yaml = [
      '- combobox "Month" [ref=e3]:',
      '  - option "Month" [disabled]',
      '  - option "Jan" [selected]',
      '  - option "Feb"',
      '- combobox "Year" [ref=e9]:',
      ...Array.from({ length: 100 }, (_, i) => `  - option "${2026 - i}"`),
      '- button "Continue" [ref=e20]',
    ].join("\n");
    const { elements, truncated } = parseAriaSnapshot(yaml);
    expect(truncated).toBe(false);
    expect(elements.map((e) => e.ref)).toEqual(["e3", "e9", "e20"]);
    expect(elements[0]).toMatchObject({ role: "combobox", name: "Month", value: "Jan", options: ["Month", "Jan", "Feb"] });
    expect(elements[1]!.options).toHaveLength(61);
    expect(elements[1]!.options!.at(-1)).toBe("……共 100 项");
  });

  test("a custom combobox with a listbox elsewhere keeps its options clickable", () => {
    const yaml = ['- combobox "City" [ref=e1]', '- listbox [ref=e2]:', '  - option "Paris" [ref=e3]'].join("\n");
    const { elements } = parseAriaSnapshot(yaml);
    expect(elements.map((e) => e.ref)).toEqual(["e1", "e2", "e3"]);
  });
});

/**
 * 真浏览器（和 tests/follows-popup.test.ts 一样按名字跑）：
 *   CHISABOT_COMPUTER_BROWSER=1 bun test tests/native-select.test.ts
 */
const asked = process.env.CHISABOT_COMPUTER_BROWSER === "1";
const FORM = `<!doctype html><title>Birthday</title><body>
<label>Month <select id="m" name="m"><option value="" disabled selected>Month</option>${MONTHS_EN.map((m, i) => `<option value="${i}">${m}</option>`).join("")}</select></label>
<label>Day <select id="d"><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => `<option>${i + 1}</option>`).join("")}</select></label>
<label>Year <select id="y"><option value="">Year</option>${Array.from({ length: 100 }, (_, i) => `<option>${2026 - i}</option>`).join("")}</select></label>
<p id="log"></p>
<script>for (const s of document.querySelectorAll("select")) s.addEventListener("change", () => { document.getElementById("log").textContent += s.id + ";"; });</script>
</body>`;
const site = asked
  ? Bun.serve({ port: 0, fetch: () => new Response(FORM, { headers: { "content-type": "text/html; charset=utf-8" } }) })
  : null;
afterAll(() => site?.stop(true));

describe.skipIf(!asked)("choosing in a real Chromium", () => {
  test(
    "fills 2000-07-12 into three native selects and fires change, even with a popup opened first",
    async () => {
      const { chromium } = await import("playwright");
      const { chooseNativeOption, focusNativeSelect, nativeSelectKind } = await import("../src/native-select");
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${site!.port}/`);
        const acting = { timeout: 5000 };
        const month = page.locator("#m");
        expect(await nativeSelectKind(month, 5000)).toBe("select");
        // 先像截图里那样点开（有界面的浏览器会弹出系统列表），再选。
        await month.click({ timeout: 5000 }).catch(() => undefined);
        const listed = await focusNativeSelect(month, 5000);
        expect(listed.options).toContain("Jul（值 6）");
        expect((await chooseNativeOption(month, "7", acting)).label).toBe("Jul");
        expect((await chooseNativeOption(page.locator("#d"), "12", acting)).label).toBe("12");
        expect((await chooseNativeOption(page.locator("#y"), "2000", acting)).label).toBe("2000");
        expect(await page.locator("#m").inputValue()).toBe("6");
        expect(await page.locator("#d").inputValue()).toBe("12");
        expect(await page.locator("#y").inputValue()).toBe("2000");
        expect(await page.locator("#log").textContent()).toBe("m;d;y;");
        await expect(chooseNativeOption(page.locator("#y"), "1800", acting)).rejects.toThrow("没有「1800」");
      } finally {
        await browser.close();
      }
    },
    60_000,
  );
});
