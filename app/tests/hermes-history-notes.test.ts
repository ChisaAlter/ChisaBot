import { describe, expect, test } from "bun:test";
import { hermesFallbackUnsupportedNote } from "../src/lib/runtime-kernel";

describe("Hermes 备用模型 helpers", () => {
  test("the settings note appears only when the bridge detected no fallback support", () => {
    const hermes = (modelControls?: {
      fallback: boolean;
      maxOutputTokens: boolean;
    }) => ({ kernel: "hermes", hermes: { modelControls } }) as never;
    expect(
      hermesFallbackUnsupportedNote(
        hermes({ fallback: false, maxOutputTokens: true }),
      ),
    ).toContain("不生效");
    expect(
      hermesFallbackUnsupportedNote(
        hermes({ fallback: true, maxOutputTokens: true }),
      ),
    ).toBeNull();
    // 没检测到（旧桥或尚未初始化）就不猜。
    expect(hermesFallbackUnsupportedNote(hermes(undefined))).toBeNull();
    expect(
      hermesFallbackUnsupportedNote({ kernel: "builtin", hermes: null }),
    ).toBeNull();
    expect(hermesFallbackUnsupportedNote(undefined)).toBeNull();
  });
});
