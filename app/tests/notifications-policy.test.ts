import { describe, expect, test } from "bun:test";
import {
  activeChannelIdFromPath,
  buildAgentDeepLink,
  buildChannelDeepLink,
  deepLinkToAppPath,
  extractBarkEndpointFromCurl,
  NOTIFICATION_SOUNDS,
  parseChisaDeepLink,
  shouldNotifyReply,
  truncateNotificationText,
} from "../../shared/notifications";
import {
  type AudioContextLike,
  createSoundPlayer,
  NOTIFICATION_SOUND_DEBOUNCE_MS,
} from "../src/lib/notifications/sounds";

function createFakeAudioContext() {
  let started = 0;
  let stopped = 0;
  const ctx: AudioContextLike = {
    currentTime: 1.5,
    state: "running",
    destination: {},
    createOscillator() {
      const osc = {
        type: "sine" as OscillatorType,
        frequency: {
          setValueAtTime: () => {},
          linearRampToValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
        connect: () => {},
        start: () => {
          started += 1;
        },
        stop: () => {
          stopped += 1;
        },
        disconnect: () => {},
        onended: null,
      };
      return osc;
    },
    createGain() {
      return {
        gain: {
          setValueAtTime: () => {},
          linearRampToValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
        connect: () => {},
        disconnect: () => {},
      };
    },
  };
  return {
    ctx,
    stats: () => ({ started, stopped }),
  };
}

describe("ChisaBot 深链构造与解析", () => {
  test("支持 agent / channel 深链构造、往返解析与路径映射", () => {
    const agentLink = buildAgentDeepLink("agent_42");
    expect(agentLink).toBe("chisabot://agent/agent_42");
    const parsedAgent = parseChisaDeepLink(agentLink);
    expect(parsedAgent).toEqual({ kind: "agent", agentId: "agent_42" });
    expect(parsedAgent ? deepLinkToAppPath(parsedAgent) : null).toBe(
      "/channel/new?agent=agent_42",
    );

    const channelLink = buildChannelDeepLink("channel_99", "agent_42");
    expect(channelLink).toBe("chisabot://channel/channel_99?agent=agent_42");
    const parsedChannel = parseChisaDeepLink(channelLink);
    expect(parsedChannel).toEqual({
      kind: "channel",
      channelId: "channel_99",
      agentId: "agent_42",
    });
    expect(parsedChannel ? deepLinkToAppPath(parsedChannel) : null).toBe(
      "/channel/channel_99",
    );
  });

  test("完整保留既有 chisabot://pair?... 扫码配对协议", () => {
    const raw =
      "chisabot://pair?server=https%3A%2F%2Fbot.example.com&code=cbp_abcdefghijklmnopqrstuvwxyz123456";
    const parsed = parseChisaDeepLink(raw);
    expect(parsed).toEqual({
      kind: "pair",
      raw,
      server: "https://bot.example.com",
      code: "cbp_abcdefghijklmnopqrstuvwxyz123456",
    });
    expect(parsed ? deepLinkToAppPath(parsed) : "unexpected").toBeNull();
  });

  test("拒绝路径穿越、多段路径、非 chisabot 协议及控制字符", () => {
    const badUrls = [
      "https://example.com/channel/ch_1",
      "chisabot://agent/..",
      "chisabot://agent/a/b",
      "chisabot://channel/ch_1#frag",
      "chisabot://user:pass@channel/ch_1",
      "chisabot://agent/bot_1?unexpected=1",
      "chisabot://channel/ch_1\nnewline",
      "chisabot://unknown/abc",
      "",
    ];
    for (const url of badUrls) {
      expect(parseChisaDeepLink(url)).toBeNull();
    }
  });
});

describe("前端通知策略、字素截断、路由提取与 Bark 解析", () => {
  test("shouldNotifyReply 与 activeChannelIdFromPath 保持精确会话粒度", () => {
    expect(activeChannelIdFromPath("/channel/ch_abc")).toBe("ch_abc");
    expect(activeChannelIdFromPath("/channel/new")).toBeNull();
    expect(activeChannelIdFromPath("/settings")).toBeNull();

    expect(
      shouldNotifyReply({
        frequency: "every-reply",
        kind: "reply",
        channelForeground: true,
      }),
    ).toBe(false);
    expect(
      shouldNotifyReply({
        frequency: "task-complete",
        kind: "needs-input",
        channelForeground: false,
      }),
    ).toBe(true);
  });

  test("truncateNotificationText 按字素安全截断 140 字符且不拆散 Emoji 家族序列", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `${family.repeat(150)}`;
    const truncated = truncateNotificationText(text, 140);
    const segments = Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        truncated,
      ),
      (s) => s.segment,
    );
    expect(segments.length).toBe(140);
    expect(segments[0]).toBe(family);
    expect(segments[139]).toBe("…");
  });

  test("extractBarkEndpointFromCurl 解析标准 curl 命令", () => {
    expect(
      extractBarkEndpointFromCurl(
        'curl "https://api.day.app/MyBarkKey_001/ChisaBot/Hello"',
      ),
    ).toEqual({
      serverUrl: "https://api.day.app",
      deviceKey: "MyBarkKey_001",
    });
  });
});

describe("WebAudio 柔和提示音与 800ms 防并发叠音去抖", () => {
  test("支持 5 种柔和提示音合成、none 静音与 800ms 防并发叠音", () => {
    let now = 10_000;
    const fake = createFakeAudioContext();
    const player = createSoundPlayer({
      now: () => now,
      debounceMs: NOTIFICATION_SOUND_DEBOUNCE_MS,
      createContext: () => fake.ctx,
    });

    // none 始终静默
    expect(player.play("none")).toBe(false);
    expect(fake.stats().started).toBe(0);

    // 首次播放成功
    expect(player.play("soft-blip")).toBe(true);
    expect(fake.stats().started).toBe(1);

    // 800ms 内并发到达自动去抖，不叠音
    now += 400;
    expect(player.play("chime")).toBe(false);
    expect(fake.stats().started).toBe(1);

    // 用户主动试听（force: true）跳过防抖，先停止旧音轨再播放新音轨
    expect(player.play("chime", { force: true })).toBe(true);
    expect(fake.stats().started).toBe(3); // chime 有 2 个音轨

    // 超过 800ms 后自动通知恢复正常触发
    now += NOTIFICATION_SOUND_DEBOUNCE_MS + 10;
    for (const sound of NOTIFICATION_SOUNDS) {
      if (sound === "none") continue;
      now += NOTIFICATION_SOUND_DEBOUNCE_MS + 10;
      expect(player.play(sound)).toBe(true);
    }
  });

  test("无 WebAudio 环境优雅降级返回 false 而不抛错", () => {
    const player = createSoundPlayer({
      createContext: () => null,
    });
    expect(player.play("bell")).toBe(false);
  });
});
