import { describe, expect, test } from "bun:test";
import { type ImConnectionDraft, imConnectionInput } from "@/lib/im";

/**
 * IM 连接表单 → 请求体。「允许内网地址」的规矩：管理员在这次编辑里动过开关才带，
 * 不带 = 服务端沿用库里的值——改了协议端地址又没重新确认时服务端会把开关拨回关。
 * 每次保存都带上当前值会把这层重新确认静默跳掉（PR #467 后续修复）。
 */
const draft = (over: Partial<ImConnectionDraft> = {}): ImConnectionDraft => ({
  name: "NapCat",
  agentId: "bot_1",
  config: { url: "ws://napcat.internal:3099" },
  secrets: { accessToken: "tok", appSecret: "   " },
  allowUsers: "u1\nu2, u3",
  ownerUsers: "owner_1\n\nowner_2",
  allowDevices: true,
  allowPrivate: true,
  allowPrivateTouched: false,
  ...over,
});

describe("imConnectionInput", () => {
  test("管理员没动开关：请求里没有 allowPrivate", () => {
    const body = imConnectionInput(draft({ allowPrivate: true }), "onebot", true);
    expect("allowPrivate" in body).toBe(false);
  });

  test("管理员动过开关：带上这次编辑的最终值", () => {
    expect(imConnectionInput(draft({ allowPrivate: true, allowPrivateTouched: true }), "onebot", true).allowPrivate).toBe(true);
    // 开 → 关也是「动过」：显式传 false 才能关掉库里已开的开关。
    expect(imConnectionInput(draft({ allowPrivate: false, allowPrivateTouched: true }), "onebot", true).allowPrivate).toBe(false);
  });

  test("非管理员：动过开关也不带（服务器本来就只认管理员的）", () => {
    const body = imConnectionInput(draft({ allowPrivate: true, allowPrivateTouched: true }), "onebot", false);
    expect("allowPrivate" in body).toBe(false);
  });

  test("其余字段照表单收：空密钥丢掉、名单按行/逗号拆", () => {
    const body = imConnectionInput(draft(), "onebot", true);
    expect(body).toMatchObject({
      platform: "onebot",
      name: "NapCat",
      agentId: "bot_1",
      config: { url: "ws://napcat.internal:3099" },
      secrets: { accessToken: "tok" },
      allowUsers: ["u1", "u2", "u3"],
      ownerUsers: ["owner_1", "owner_2"],
      allowDevices: true,
    });
  });

  test("扫码授权键：微信平台额外带一份 weixinLogin 兼容旧接口", () => {
    const weixin = imConnectionInput(draft({ qrLogin: "qr_key_1" }), "weixin", true);
    expect(weixin.qrLogin).toBe("qr_key_1");
    expect(weixin.weixinLogin).toBe("qr_key_1");
    const other = imConnectionInput(draft({ qrLogin: "qr_key_1" }), "dingtalk", true);
    expect(other.qrLogin).toBe("qr_key_1");
    expect("weixinLogin" in other).toBe(false);
  });
});
