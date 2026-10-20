import { describe, expect, test } from "bun:test";
import { compactTurns } from "../src/components/channels/chat-transcript";
import { isMediaOnly, splitBubbles } from "../src/lib/chat/bubbles";
import { isQuietWork, QUIET_MAX_SECONDS, workCallFailed, type WorkCall } from "../src/lib/chat/work-steps";

/**
 * DESIGN.md §93：简单回合收起干活卡 + 开场一句收进卡片 + 只有图片的段不画空气泡。
 * 复现 2026-10-16 18:39 用户那一轮：「k看我当前的电脑」→ 开场一句 → device_list → device_screenshot → 「这是你当前在线的 …屏幕：」+ 截图。
 */
type Item = Parameters<typeof compactTurns>[0][number];
const user = (id: string, text: string): Item => ({ kind: "text", id, role: "user", text }) as Item;
const bot = (id: string, text: string): Item => ({ kind: "text", id, role: "assistant", text }) as Item;
const call = (id: string, name: string, result: string | undefined = '"{\\"ok\\":true}"', args: Record<string, unknown> = {}): Item =>
  ({ kind: "tool", id, toolCall: { id, type: "function", function: { name, arguments: JSON.stringify(args) } }, ...(result === undefined ? {} : { result }) }) as Item;

const LEAD = "我来查看你当前在线电脑的屏幕；如果有多台在线，会先确认设备列表。";
const SHOT_URL = "/api/devices/dev_d92955affc754d90b8be/screenshots/4742d801-cbce-4ee5-842a-af7c7e03b153";
const ANSWER = `这是你当前在线的 **DESKTOP-ES2O7G4** 屏幕：\n\n![当前电脑截图](${SHOT_URL})`;
const DEVICES = JSON.stringify(JSON.stringify({ devices: [{ deviceId: "dev_d92955affc754d90b8be", name: "DESKTOP-ES2O7G4", online: true }] }));
const SHOT = JSON.stringify(JSON.stringify({ format: "png", width: 1600, height: 670, url: SHOT_URL, bytes: 796776 }));

const userTurn = (extra: Item[] = []): Item[] => [
  user("u1", "k看我当前的电脑"),
  bot("a1", LEAD),
  call("t1", "device_list", DEVICES),
  call("t2", "device_screenshot", SHOT, { deviceId: "dev_d92955affc754d90b8be" }),
  ...extra,
];

describe("简单回合（§93）", () => {
  test("用户那一轮：做完后干活卡可以整行收起，开场一句收进卡片，结果照旧是气泡", () => {
    const compact = compactTurns([...userTurn(), bot("a2", ANSWER)], false, new Set());
    expect(compact.work.get("t1")?.quiet).toBe(true);
    expect(compact.hidden.has("a1")).toBe(true);
    expect(compact.tone.get("a2")).toBe("final");
    expect(compact.hidden.has("a2")).toBe(false);
    // 数据都还在（只是不画）：两步 + 开场一句
    expect(compact.work.get("t1")?.calls.map((c) => c.name)).toEqual(["device_list", "device_screenshot"]);
    expect(compact.work.get("t1")?.notes).toEqual([{ at: 0, text: LEAD }]);
  });

  test("还在跑：卡片照常显示（不 quiet）；开场一句在第一个工具开始后就收", () => {
    const compact = compactTurns(userTurn(), true, new Set());
    expect(compact.work.get("t1")?.live).toBe(true);
    expect(compact.work.get("t1")?.quiet).toBe(false);
    expect(compact.hidden.has("a1")).toBe(true);
  });

  test("开场一句还没调工具：照旧露着（可能就是正在写的回答）", () => {
    const compact = compactTurns([user("u1", "k看我当前的电脑"), bot("a1", LEAD)], true, new Set());
    expect(compact.hidden.has("a1")).toBe(false);
  });

  test("有结果才收：工具后面没有回答（出错 / 中断）卡片照常显示", () => {
    const compact = compactTurns(userTurn(), false, new Set());
    expect(compact.work.get("t1")?.quiet).toBe(false);
  });

  test("被停掉的一轮不收", () => {
    const compact = compactTurns([...userTurn(), bot("a2", ANSWER)], false, new Set(["u1"]));
    expect(compact.work.get("t1")?.quiet).toBe(false);
  });

  test("有一步失败 / 被拒 / 被中断：不收", () => {
    for (const bad of [
      '"Refused. 设备离线 可用设备：…"',
      '"This call produced no result: the surface was interrupted before it could answer. Do not assume it succeeded."',
      JSON.stringify(JSON.stringify({ error: "设备离线" })),
    ]) {
      const items = [user("u1", "看电脑"), bot("a1", LEAD), call("t1", "device_list", DEVICES), call("t2", "device_screenshot", bad), bot("a2", ANSWER)];
      expect(compactTurns(items, false, new Set()).work.get("t1")?.quiet).toBe(false);
    }
  });

  test("说得出做了什么的照旧露着，只说得出「做了 N 步」的收起（2026-10-20）", () => {
    // 全是搜索 / 读网页：这一行说的是「搜索 1 次 · 看了 1 个网页」，有信息量，不收。
    const web = [user("u1", "查"), call("t1", "web_search"), call("t2", "web_fetch"), bot("a2", "好了")];
    expect(compactTurns(web, false, new Set()).work.get("t1")?.quiet).toBe(false);
    // 命令 / 写文件 / 输入 / 存记忆：这一行只会写「做了 2 步」，收起，只留回答。
    for (const name of ["device_run_shell", "device_write_file", "device_input", "memory_save"]) {
      const items = [user("u1", "做"), call("t1", "device_list", DEVICES), call("t2", name), bot("a2", "好了")];
      expect(compactTurns(items, false, new Set()).work.get("t1")?.quiet).toBe(true);
    }
  });

  test("超过 3 步：不收", () => {
    const items = [
      user("u1", "看"),
      call("t1", "device_list"),
      call("t2", "device_system_info"),
      call("t3", "device_list_files"),
      call("t4", "device_read_file"),
      bot("a2", "好了"),
    ];
    expect(compactTurns(items, false, new Set()).work.get("t1")?.quiet).toBe(false);
    expect(compactTurns([...items.slice(0, 4), items[5]!], false, new Set()).work.get("t1")?.quiet).toBe(true);
  });

  test("准备动作（看技能）不算步骤、也不挡", () => {
    const items = [user("u1", "看"), call("s1", "skill_list"), call("t1", "device_screenshot", SHOT), bot("a2", ANSWER)];
    expect(compactTurns(items, false, new Set()).work.get("t1")?.quiet).toBe(true);
  });

  test("isQuietWork：确认卡、知道的用时", () => {
    const calls: WorkCall[] = [
      { name: "device_list", arguments: "{}", done: true, id: "t1" },
      { name: "device_screenshot", arguments: "{}", done: true, id: "t2" },
    ];
    expect(isQuietWork({ calls, live: false, hasFinal: true })).toBe(true);
    expect(isQuietWork({ calls, live: false, hasFinal: true, confirmed: new Set(["t2"]) })).toBe(false);
    expect(isQuietWork({ calls, live: false, hasFinal: true, seconds: 7 })).toBe(true);
    expect(isQuietWork({ calls, live: false, hasFinal: true, seconds: QUIET_MAX_SECONDS + 1 })).toBe(false);
    expect(isQuietWork({ calls, live: true, hasFinal: true })).toBe(false);
    expect(isQuietWork({ calls: [{ ...calls[0]!, done: false }], live: false, hasFinal: true })).toBe(false);
    expect(isQuietWork({ calls: [], live: false, hasFinal: true })).toBe(false);
  });

  /*
   * 2026-10-20 用户（截图「做了 2 步 · 13 秒」+「Claude Code 已装好…」）：「把做了几步去掉，隐藏」。
   * 只说得出「做了 N 步」的一轮不再占一行；失败的（「1 步失败」）和搜索/网页次数照旧显示。
   */
  test("只说得出「做了 N 步」的一轮整行收起（跑命令也算）", () => {
    const items = [
      user("u1", "装 Claude Code"),
      call("c1", "computer_run_command", JSON.stringify(JSON.stringify({ exitCode: 0, stdout: "done" }))),
      call("c2", "computer_run_command", JSON.stringify(JSON.stringify({ exitCode: 0 }))),
      bot("a2", "装好了：版本 2.1.303"),
    ];
    const compact = compactTurns(items, false, new Set());
    expect(compact.work.get("c1")?.quiet).toBe(true);
    // 调用都还在（只是不画），打开「调试：显示工具调用」照常看得到。
    expect(compact.work.get("c1")?.calls.map((c) => c.name)).toEqual(["computer_run_command", "computer_run_command"]);
  });

  test("有一条失败就不收：这一行还有话要说", () => {
    const items = [
      user("u1", "装 Claude Code"),
      call("c1", "computer_run_command", JSON.stringify(JSON.stringify({ exitCode: 0 }))),
      call("c2", "computer_run_command", "Error: signal is aborted without reason"),
      bot("a2", "没装成。"),
    ];
    expect(compactTurns(items, false, new Set()).work.get("c1")?.quiet).toBe(false);
  });

  test("isQuietWork：genericSummary 越过工具白名单和用时，但越过不了失败 / 确认卡 / 没结果", () => {
    const calls: WorkCall[] = [
      { name: "computer_run_command", arguments: "{}", done: true, id: "c1" },
      { name: "computer_run_command", arguments: "{}", done: true, id: "c2" },
    ];
    // 跑命令本来不在 QUIET_TOOLS 里，用时 600 秒也一样收（只说得出「做了 2 步」）。
    expect(isQuietWork({ calls, live: false, hasFinal: true, seconds: 600 })).toBe(false);
    expect(isQuietWork({ calls, live: false, hasFinal: true, seconds: 600, genericSummary: true })).toBe(true);
    expect(isQuietWork({ calls, live: false, hasFinal: false, genericSummary: true })).toBe(false);
    expect(isQuietWork({ calls, live: false, hasFinal: true, genericSummary: true, confirmed: new Set(["c1"]) })).toBe(false);
    expect(
      isQuietWork({
        calls: [{ ...calls[0]!, failed: true }],
        live: false,
        hasFinal: true,
        genericSummary: true,
      }),
    ).toBe(false);
  });

  test("workCallFailed", () => {    expect(workCallFailed(undefined)).toBe(true);
    expect(workCallFailed(DEVICES)).toBe(false);
    expect(workCallFailed(SHOT)).toBe(false);
    expect(workCallFailed('"Refused. no"')).toBe(true);
    expect(workCallFailed("Error: boom")).toBe(true);
    expect(workCallFailed('{"ok":false}')).toBe(true);
    expect(workCallFailed('{"ok":true,"note":"error handling is fine"}')).toBe(false);
    expect(workCallFailed('"The vendor reported an error: 500"')).toBe(true);
  });
});

describe("只有图片的段不画空气泡（§93.2）", () => {
  test("用户那条回答：只剩引导句一个气泡（图片在下面的图片卡里）", () => {
    const segs = splitBubbles(ANSWER);
    expect(segs.map((s) => s.text)).toEqual(["这是你当前在线的 **DESKTOP-ES2O7G4** 屏幕："]);
  });
  test("流式写到一半的图片也不出空气泡", () => {
    expect(splitBubbles("这是屏幕：\n\n![当前电脑截图](/api/dev").map((s) => s.text)).toEqual(["这是屏幕："]);
    expect(splitBubbles("这是屏幕：\n\n![当前").map((s) => s.text)).toEqual(["这是屏幕："]);
  });
  test("isMediaOnly", () => {
    expect(isMediaOnly(`![a](${SHOT_URL})`)).toBe(true);
    expect(isMediaOnly(`![a](/x.png)\n![b](/y.png)`)).toBe(true);
    expect(isMediaOnly('<img src="/x.png">')).toBe(true);
    expect(isMediaOnly(`看这张 ![a](/x.png)`)).toBe(false);
    expect(isMediaOnly("好的！")).toBe(false);
  });
});
