import { describe, expect, test } from "bun:test";
import { openPanelSheet, panelSheetOpenSource, setPanelSheetOpen } from "../src/lib/panels/rail-open";

describe("用户打开右抽屉的统一入口（CB-098）", () => {
  test("抽屉没开时按来源打开；已经开着时再调用什么都不做，不改来源", () => {
    setPanelSheetOpen(false);
    openPanelSheet("restore");
    expect(panelSheetOpenSource()).toBe("restore");
    openPanelSheet("user");
    expect(panelSheetOpenSource()).toBe("restore");
    setPanelSheetOpen(false);
    expect(panelSheetOpenSource()).toBe("user");
    openPanelSheet();
    expect(panelSheetOpenSource()).toBe("user");
    setPanelSheetOpen(false);
  });
});
