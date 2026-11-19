import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import {
  type SpeechAudioPlayer,
  type SpeechPlaybackOptions,
  useSpeechPlayback,
} from "@/hooks/use-speech-playback";
import { stripMarkdownForSpeech, truncateForSpeech } from "@/lib/audio/speech";
import { CHAT_FILES_MARKER } from "../../shared/chat-files";
import { settleReactWork } from "./settle-react-work";

type MockAudioRecord = {
  url: string;
  paused: boolean;
  playCount: number;
  cleared: boolean;
  triggerEnded: () => void;
  player: SpeechAudioPlayer;
};

function makeMockAudioFactory() {
  const created: MockAudioRecord[] = [];
  const createAudio = (url: string): SpeechAudioPlayer => {
    const listeners: Record<"ended" | "error", Set<() => void>> = {
      ended: new Set(),
      error: new Set(),
    };
    const record: MockAudioRecord = {
      url,
      paused: false,
      playCount: 0,
      cleared: false,
      triggerEnded: () => {
        for (const fn of [...listeners.ended]) fn();
      },
      player: {
        src: url,
        play() {
          record.playCount += 1;
          return Promise.resolve();
        },
        pause() {
          record.paused = true;
        },
        addEventListener(type, listener) {
          listeners[type].add(listener);
        },
        removeEventListener(type, listener) {
          listeners[type].delete(listener);
        },
        removeAttribute(name) {
          if (name === "src") record.cleared = true;
        },
      },
    };
    created.push(record);
    return record.player;
  };
  return { created, createAudio };
}

describe("stripMarkdownForSpeech 与 truncateForSpeech", () => {
  test("清理代码块、图片、链接 URL 与格式符号，保留自然可读正文", () => {
    const markdown = [
      "# 今日总结",
      "",
      "你好 **千咲**，请查看 [设计文档](https://example.com/docs/design.md) 中的说明。",
      "",
      "![示意图](https://cdn.example.com/diagram.png)",
      "",
      "```ts",
      "const secret_code = 42;",
      "console.log(secret_code);",
      "```",
      "",
      "> 引用：调用 `speech_synthesize` 生成语音，保留 snake_case_name 不损坏。",
      "- 第一项：~~废弃内容~~ 更新为 *新版方案*",
      "- 第二项：访问 https://internal.example.com/path 了解详情",
      "",
      "| 名称 | 状态 |",
      "| --- | --- |",
      "| ASR | 就绪 |",
      `${CHAT_FILES_MARKER}[{"id":"f1","url":"/api/chat-files/f1"}]`,
    ].join("\n");

    const cleaned = stripMarkdownForSpeech(markdown);
    expect(cleaned).toContain("今日总结");
    expect(cleaned).toContain("你好 千咲，请查看 设计文档 中的说明。");
    expect(cleaned).toContain("speech_synthesize");
    expect(cleaned).toContain("snake_case_name");
    expect(cleaned).toContain("新版方案");
    expect(cleaned).toContain("ASR，就绪");

    expect(cleaned).not.toContain("```");
    expect(cleaned).not.toContain("secret_code");
    expect(cleaned).not.toContain("https://");
    expect(cleaned).not.toContain("diagram.png");
    expect(cleaned).not.toContain("示意图");
    expect(cleaned).not.toContain("**");
    expect(cleaned).not.toContain("~~");
    expect(cleaned).not.toContain(CHAT_FILES_MARKER);
  });

  test("纯代码块或纯图片内容清理后为空字符串", () => {
    expect(
      stripMarkdownForSpeech(
        "```js\nalert(1)\n```\n![pic](https://a.test/1.png)",
      ),
    ).toBe("");
  });

  test("truncateForSpeech 在上限内保持原样，超长时优先按句末标点安全截断", () => {
    expect(truncateForSpeech("短句无需截断。", 100)).toBe("短句无需截断。");

    const longText = "第一句内容比较充实。第二句也非常重要！第三句会被截掉。";
    const truncated = truncateForSpeech(longText, 22);
    expect(truncated).toBe("第一句内容比较充实。第二句也非常重要！");
    expect(truncated.length).toBeLessThanOrEqual(22);

    // 不破坏 UTF-16 代理对（emoji 占 2 个 code unit）
    const emojis = "😀".repeat(10);
    const cut = truncateForSpeech(emojis, 5);
    expect(cut.length).toBe(4);
  });
});

describe("useSpeechPlayback 模块级单路互斥协调", () => {
  const realCreateObjectURL = URL.createObjectURL;
  const realRevokeObjectURL = URL.revokeObjectURL;
  const revokedUrls: string[] = [];
  let urlCounter = 0;

  beforeAll(() => {
    GlobalRegistrator.register({ url: "http://localhost/" });
    URL.createObjectURL = () => {
      urlCounter += 1;
      return `blob:mock-speech-${urlCounter}`;
    };
    URL.revokeObjectURL = (url: string) => {
      revokedUrls.push(url);
    };
  });

  afterEach(() => {
    cleanup();
    revokedUrls.length = 0;
  });

  afterAll(async () => {
    await settleReactWork();
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
    GlobalRegistrator.unregister();
  });

  function PlaybackHarness({
    label,
    itemId,
    text,
    options,
  }: {
    label: string;
    itemId: string;
    text: string;
    options: SpeechPlaybackOptions;
  }) {
    const playback = useSpeechPlayback(options);
    return createElement(
      "div",
      { "data-testid": `harness-${label}`, "data-status": playback.status },
      createElement(
        "button",
        {
          type: "button",
          "data-testid": `play-${label}`,
          onClick: () => {
            void playback.speak({ id: itemId, text });
          },
        },
        "play",
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": `stop-${label}`,
          onClick: () => playback.stop(),
        },
        "stop",
      ),
    );
  }

  test("新实例播放时自动停止先前正在播放的实例并释放其对象 URL", async () => {
    const audioA = makeMockAudioFactory();
    const audioB = makeMockAudioFactory();
    const synthesize = async () =>
      new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" });

    const view = render(
      createElement(
        "div",
        null,
        createElement(PlaybackHarness, {
          label: "a",
          itemId: "msg-a",
          text: "第一条消息",
          options: { synthesize, createAudio: audioA.createAudio },
        }),
        createElement(PlaybackHarness, {
          label: "b",
          itemId: "msg-b",
          text: "第二条消息",
          options: { synthesize, createAudio: audioB.createAudio },
        }),
      ),
    );

    const statusOf = (label: string) =>
      view.getByTestId(`harness-${label}`).getAttribute("data-status");

    // 1. 播放 A -> playing
    fireEvent.click(view.getByTestId("play-a"));
    await waitFor(() => expect(statusOf("a")).toBe("playing"));
    expect(audioA.created).toHaveLength(1);
    expect(audioA.created[0]?.paused).toBe(false);

    // 2. 播放 B -> A 自动停止并释放 ObjectURL，B 进入 playing
    fireEvent.click(view.getByTestId("play-b"));
    await waitFor(() => expect(statusOf("b")).toBe("playing"));
    expect(statusOf("a")).toBe("idle");
    expect(audioA.created[0]?.paused).toBe(true);
    expect(audioA.created[0]?.cleared).toBe(true);
    expect(revokedUrls).toContain(audioA.created[0]?.url ?? "");
    expect(audioB.created).toHaveLength(1);
    expect(audioB.created[0]?.paused).toBe(false);

    // 3. B 自然播完 -> 回到 idle
    act(() => {
      audioB.created[0]?.triggerEnded();
    });
    expect(statusOf("b")).toBe("idle");
  });

  test("前一个实例处于 loading 时，新实例抢占会中止旧请求且不让旧响应误播放", async () => {
    const audioA = makeMockAudioFactory();
    const audioB = makeMockAudioFactory();
    let resolveA: ((blob: Blob) => void) | null = null;
    let signalA: AbortSignal | undefined;

    const view = render(
      createElement(
        "div",
        null,
        createElement(PlaybackHarness, {
          label: "a",
          itemId: "msg-a",
          text: "慢响应消息",
          options: {
            synthesize: ({ signal }) => {
              signalA = signal;
              return new Promise<Blob>((resolve) => {
                resolveA = resolve;
              });
            },
            createAudio: audioA.createAudio,
          },
        }),
        createElement(PlaybackHarness, {
          label: "b",
          itemId: "msg-b",
          text: "快速消息",
          options: {
            synthesize: async () =>
              new Blob([new Uint8Array([4, 5])], { type: "audio/mpeg" }),
            createAudio: audioB.createAudio,
          },
        }),
      ),
    );

    const statusOf = (label: string) =>
      view.getByTestId(`harness-${label}`).getAttribute("data-status");

    fireEvent.click(view.getByTestId("play-a"));
    await waitFor(() => expect(statusOf("a")).toBe("loading"));
    expect(signalA?.aborted).toBe(false);

    // 启动 B 抢占正在加载的 A
    fireEvent.click(view.getByTestId("play-b"));
    await waitFor(() => expect(statusOf("b")).toBe("playing"));
    expect(signalA?.aborted).toBe(true);
    expect(statusOf("a")).toBe("idle");

    // 即使 A 的旧 Promise 随后 resolve，也不得创建播放器或破坏 B
    await act(async () => {
      resolveA?.(new Blob([new Uint8Array([9, 9])], { type: "audio/mpeg" }));
      await Promise.resolve();
    });
    expect(audioA.created).toHaveLength(0);
    expect(statusOf("a")).toBe("idle");
    expect(statusOf("b")).toBe("playing");
  });
});
