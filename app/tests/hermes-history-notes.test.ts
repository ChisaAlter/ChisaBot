import { describe, expect, test } from "bun:test";
import { readCompactionTurns } from "../src/lib/copilot/turn-compaction";
import { hermesFallbackUnsupportedNote } from "../src/lib/runtime-kernel";

describe("Hermes 备用模型 / 已压缩前文 helpers", () => {
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

  test("compaction turns are read defensively", () => {
    const turns = readCompactionTurns({
      turns: [
        {
          userMessageId: "u1",
          notice: "已压缩前文（较早 8 轮由摘要代替）",
          summary: "- 目标",
        },
        {
          userMessageId: "u2",
          notice: "已压缩前文（较早的工具结果和超长消息已省略）",
          summary: null,
        },
        { userMessageId: 3, notice: "x" },
        { userMessageId: "u4", notice: "" },
      ],
    });
    expect([...turns.keys()]).toEqual(["u1", "u2"]);
    expect(turns.get("u1")).toEqual({
      notice: "已压缩前文（较早 8 轮由摘要代替）",
      summary: "- 目标",
    });
    expect(turns.get("u2")?.summary).toBeNull();
    expect(readCompactionTurns(null).size).toBe(0);
    expect(readCompactionTurns({ turns: "x" }).size).toBe(0);
  });
});
