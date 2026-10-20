import { describe, expect, test } from "bun:test";
import {
  CONTINUOUS_SEND_MS,
  isContinuousSend,
  localSentAt,
  previousSentAt,
  readSentAt,
  noteSendWhileBusy,
  rememberSent,
  sentMessageId,
  staysInSameTurn,
  takeSendWhileBusy,
} from "../src/lib/chat/send-scroll";

describe("连续发消息不翻页（DESIGN.md §94 / §94.7）", () => {
  const now = 1_800_000_000_000;

  test("界限是 30 分钟", () => {
    expect(CONTINUOUS_SEND_MS).toBe(1_800_000);
  });

  test("上一条不到 30 分钟 → 连续", () => {
    expect(isContinuousSend(now - 1_000, now)).toBe(true);
    expect(isContinuousSend(now - 1_799_999, now)).toBe(true);
    expect(isContinuousSend(now, now)).toBe(true);
  });

  test("满 30 分钟及以上 → 不连续（照旧翻页）", () => {
    expect(isContinuousSend(now - 1_800_000, now)).toBe(false);
    expect(isContinuousSend(now - 7_200_000, now)).toBe(false);
  });

  test("不知道上一条什么时候发的 / 时钟倒了 → 不连续", () => {
    expect(isContinuousSend(null, now)).toBe(false);
    expect(isContinuousSend(undefined, now)).toBe(false);
    expect(isContinuousSend(Number.NaN, now)).toBe(false);
    expect(isContinuousSend(now + 5_000, now)).toBe(false);
  });

  test("回答还在跑 → 不管上一条隔了多久都算同一轮（§94.7）", () => {
    expect(staysInSameTurn(now - 20 * 60_000, now, true)).toBe(true);
    expect(staysInSameTurn(now - 3 * 3_600_000, now, true)).toBe(true);
    expect(staysInSameTurn(null, now, true)).toBe(true);
  });

  test("空闲时照旧按时刻判断", () => {
    expect(staysInSameTurn(now - 60_000, now, false)).toBe(true);
    expect(staysInSameTurn(now - 31 * 60_000, now, false)).toBe(false);
    expect(staysInSameTurn(null, now, false)).toBe(false);
  });

  test("服务器时刻按服务器的「现在」换算到本机时钟", () => {
    // 服务器时钟比本机快 1 小时；消息是服务器上 2 分钟前发的。
    const received = now;
    const serverNow = new Date(now + 3_600_000).toISOString();
    const at = new Date(now + 3_600_000 - 120_000).toISOString();
    const r = readSentAt({ userMessageId: "m1", at, now: serverNow }, received);
    expect(r).toEqual({ userMessageId: "m1", at: now - 120_000 });
    expect(isContinuousSend(r!.at, now + 1_000)).toBe(true);
  });

  test("服务器回 null / 格式不对 → null", () => {
    expect(readSentAt({ userMessageId: null, at: null, now: null }, now)).toBeNull();
    expect(readSentAt({ userMessageId: "m", at: null }, now)).toBeNull();
    expect(readSentAt({ userMessageId: "m", at: "bad" }, now)).toBeNull();
    expect(readSentAt(null, now)).toBeNull();
  });

  test("没有服务器的「现在」时直接用服务器时刻", () => {
    const at = new Date(now - 10_000).toISOString();
    expect(readSentAt({ userMessageId: "m", at }, now)).toEqual({ userMessageId: "m", at: now - 10_000 });
  });

  test("上一条：服务器读数对得上 id 优先，否则本机记的；附件行按消息算", () => {
    expect(sentMessageId("abc:attachments")).toBe("abc");
    rememberSent("local-1", now - 50_000);
    expect(localSentAt("local-1")).toBe(now - 50_000);
    rememberSent("local-1", now); // 第一次记的为准
    expect(localSentAt("local-1")).toBe(now - 50_000);
    expect(previousSentAt("local-1", { userMessageId: "local-1", at: now - 400_000 })).toBe(now - 400_000);
    expect(previousSentAt("local-1", { userMessageId: "other", at: now - 400_000 })).toBe(now - 50_000);
    expect(previousSentAt("srv:attachments", { userMessageId: "srv", at: now - 7_000 })).toBe(now - 7_000);
    expect(previousSentAt("unknown", null)).toBeNull();
    expect(previousSentAt(null, null)).toBeNull();
  });
});

describe("回答还在跑时补的那一句（DESIGN.md §94.7）", () => {
  const at = 1_800_000_000_000;

  test("提交时在回答 → 这一条算连续，取一次就清掉", () => {
    noteSendWhileBusy(true, at);
    expect(takeSendWhileBusy(at + 1_000)).toBe(true);
    expect(takeSendWhileBusy(at + 1_000)).toBe(false);
  });

  test("提交时没在回答 → 不记", () => {
    noteSendWhileBusy(false, at);
    expect(takeSendWhileBusy(at + 1_000)).toBe(false);
  });

  test("发送没落地、过了 60 秒 → 过期，不误伤下一条", () => {
    noteSendWhileBusy(true, at);
    expect(takeSendWhileBusy(at + 61_000)).toBe(false);
  });
});
