/**
 * 多平台扫码一键绑定协议（微信 ClawBot、QQ 官方机器人、企业微信智能机器人、钉钉机器人、飞书/Lark）。
 *
 * 借鉴各平台官方开放给 AI 助手的扫码注册/绑定公开接口：
 * - 微信 ClawBot：ilinkai.weixin.qq.com get_bot_qrcode / get_qrcode_status
 * - QQ 官方机器人：q.qq.com/lite/create_bind_task / poll_bind_result（AES-256-GCM 解密 bot_encrypt_secret）
 * - 企业微信智能机器人：work.weixin.qq.com/ai/qc/generate / query_result
 * - 钉钉机器人：oapi.dingtalk.com/app/registration/init / begin / poll（source: DING_DWS_CLAW）
 * - 飞书 / Lark：accounts.feishu.cn/oauth/v1/app/registration（PersonalAgent 设备码授权）
 */

import { createDecipheriv, randomBytes } from "node:crypto";
import type { ImPlatform } from "../../../shared/im";
import { weixinFetchQr, weixinQrStatus } from "./adapters/weixin";
import type { FetchLike } from "./types";

export type QrPlatform = Extract<
  ImPlatform,
  "weixin" | "qq_official" | "wecom_bot" | "dingtalk" | "feishu"
>;

export function isQrPlatform(platform: string): platform is QrPlatform {
  return (
    platform === "weixin" ||
    platform === "qq_official" ||
    platform === "wecom_bot" ||
    platform === "dingtalk" ||
    platform === "feishu"
  );
}

export type QrStartOptions = {
  platform: QrPlatform;
  /** 微信可传自定义 baseUrl；飞书可传 domain（"feishu" | "lark"）。 */
  baseUrl?: string;
  domain?: string;
};

export type QrStartResult = {
  /** 二维码内容（URL 或 data:image/...）。 */
  qrUrl: string;
  /** 二维码是纯链接还是可直接展示的图片。 */
  qrKind: "url" | "image";
  /** 平台侧原始会话标识（供调试或旧接口兼容）。 */
  qrcode: string;
  /** 内部会话状态（加密密钥、device_code、host 等）。 */
  state: Record<string, string>;
};

export type QrPollResult = {
  status: "wait" | "scaned" | "confirmed" | "expired";
  /** 确认后填充到连接 config 的非敏感字段（如 appId、botId、clientId、baseUrl、domain）。 */
  config?: Record<string, string>;
  /** 确认后填充到连接 secrets 的敏感字段（如 appSecret、secret、clientSecret、token）。 */
  secrets?: Record<string, string>;
  /** 识别到的账号/机器人标识，用于界面回显。 */
  account?: string;
  /** 扫码人自己的平台用户 id（平台有返回才有）：绑定时自动加进连接的主人名单。 */
  boundUserId?: string;
  /** 状态更新后的内部 state（例如飞书自动切换 Lark 域名）。 */
  nextState?: Record<string, string>;
  /** 平台返回的附加错误说明。 */
  message?: string;
};

const QQ_LITE_BASE = "https://q.qq.com";
const WECOM_AI_BASE = "https://work.weixin.qq.com";
const DINGTALK_OAPI_BASE = "https://oapi.dingtalk.com";

/** 各平台扫码确认响应里「扫码人自己的用户 id」的候选字段（各家命名不同，取第一个非空字符串）。 */
function firstUserId(...candidates: unknown[]): string | undefined {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return undefined;
}

/**
 * 解密 QQ 官方扫码绑定返回的 `bot_encrypt_secret`。
 * 格式：base64(iv[12] + ciphertext + authTag[16])，密钥为 create_bind_task 时生成的 32 字节随机 key。
 */
export function decryptQqBotSecret(
  botEncryptSecret: string,
  base64Key: string,
): string {
  const keyBuf = Buffer.from(base64Key, "base64");
  if (keyBuf.length !== 32) {
    throw new Error(
      `QQ 扫码密钥长度错误（期望 32 字节，实际 ${keyBuf.length}）`,
    );
  }
  const buf = Buffer.from(botEncryptSecret, "base64");
  if (buf.length < 29) {
    throw new Error("QQ 机器人加密凭据格式无效");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const encrypted = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}

export async function startPlatformQr(
  opts: QrStartOptions,
  fetchImpl: FetchLike = fetch,
): Promise<QrStartResult> {
  switch (opts.platform) {
    case "weixin": {
      const baseUrl = (opts.baseUrl || "https://ilinkai.weixin.qq.com").replace(
        /\/+$/,
        "",
      );
      const qr = await weixinFetchQr(fetchImpl, baseUrl);
      const qrKind =
        qr.url.startsWith("data:image/") ||
        /\.(png|jpg|jpeg|gif|webp)(\?|$)/i.test(qr.url)
          ? "image"
          : "url";
      return {
        qrUrl: qr.url,
        qrKind,
        qrcode: qr.qrcode,
        state: { qrcode: qr.qrcode, baseUrl },
      };
    }

    case "qq_official": {
      const key = randomBytes(32).toString("base64");
      const res = await fetchImpl(`${QQ_LITE_BASE}/lite/create_bind_task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json().catch(() => ({}))) as {
        retcode?: number;
        msg?: string;
        data?: { task_id?: string };
      };
      const taskId = data.data?.task_id;
      if (
        !res.ok ||
        (data.retcode !== undefined && data.retcode !== 0) ||
        !taskId
      ) {
        throw new Error(`QQ 扫码任务创建失败：${data.msg || res.status}`);
      }
      const qrUrl = `${QQ_LITE_BASE}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&source=chisabot&_wv=2`;
      return {
        qrUrl,
        qrKind: "url",
        qrcode: taskId,
        state: { taskId, key },
      };
    }

    case "wecom_bot": {
      const res = await fetchImpl(
        `${WECOM_AI_BASE}/ai/qc/generate?source=chisabot&plat=2`,
        { signal: AbortSignal.timeout(15_000) },
      );
      const data = (await res.json().catch(() => ({}))) as {
        data?: { scode?: string; auth_url?: string };
        errmsg?: string;
      };
      const scode = data.data?.scode;
      const authUrl = data.data?.auth_url;
      if (!res.ok || !scode || !authUrl) {
        throw new Error(`企业微信扫码获取失败：${data.errmsg || res.status}`);
      }
      return {
        qrUrl: authUrl,
        qrKind: "url",
        qrcode: scode,
        state: { scode },
      };
    }

    case "dingtalk": {
      const initRes = await fetchImpl(
        `${DINGTALK_OAPI_BASE}/app/registration/init`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "DING_DWS_CLAW" }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      const initData = (await initRes.json().catch(() => ({}))) as {
        errcode?: number;
        errmsg?: string;
        nonce?: string;
      };
      if (
        !initRes.ok ||
        (initData.errcode && initData.errcode !== 0) ||
        !initData.nonce
      ) {
        throw new Error(
          `钉钉扫码初始化失败：${initData.errmsg || initRes.status}`,
        );
      }
      const beginRes = await fetchImpl(
        `${DINGTALK_OAPI_BASE}/app/registration/begin`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nonce: initData.nonce }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      const beginData = (await beginRes.json().catch(() => ({}))) as {
        errcode?: number;
        errmsg?: string;
        device_code?: string;
        verification_uri_complete?: string;
      };
      if (
        !beginRes.ok ||
        (beginData.errcode && beginData.errcode !== 0) ||
        !beginData.device_code ||
        !beginData.verification_uri_complete
      ) {
        throw new Error(
          `钉钉扫码生成失败：${beginData.errmsg || beginRes.status}`,
        );
      }
      return {
        qrUrl: beginData.verification_uri_complete,
        qrKind: "url",
        qrcode: beginData.device_code,
        state: { deviceCode: beginData.device_code },
      };
    }

    case "feishu": {
      const domain = opts.domain === "lark" ? "lark" : "feishu";
      const host =
        domain === "lark" ? "accounts.larksuite.com" : "accounts.feishu.cn";
      const url = `https://${host}/oauth/v1/app/registration`;
      const initBody = new URLSearchParams({ action: "init" }).toString();
      await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: initBody,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);

      const beginBody = new URLSearchParams({
        action: "begin",
        archetype: "PersonalAgent",
        auth_method: "client_secret",
        request_user_info: "open_id",
      }).toString();
      const beginRes = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: beginBody,
        signal: AbortSignal.timeout(15_000),
      });
      const beginData = (await beginRes.json().catch(() => ({}))) as {
        device_code?: string;
        verification_uri_complete?: string;
        error?: string;
        error_description?: string;
      };
      if (
        !beginRes.ok ||
        !beginData.device_code ||
        !beginData.verification_uri_complete
      ) {
        throw new Error(
          `飞书扫码初始化失败：${beginData.error_description || beginData.error || beginRes.status}`,
        );
      }
      let qrUrl = beginData.verification_uri_complete;
      try {
        const parsed = new URL(qrUrl);
        parsed.searchParams.set("from", "sdk");
        parsed.searchParams.set("source", "node-sdk/chisabot");
        parsed.searchParams.set("tp", "sdk");
        qrUrl = parsed.toString();
      } catch {
        // Keep raw verification_uri_complete if URL parsing fails
      }
      return {
        qrUrl,
        qrKind: "url",
        qrcode: beginData.device_code,
        state: { deviceCode: beginData.device_code, host, domain },
      };
    }
  }
}

export async function pollPlatformQr(
  platform: QrPlatform,
  state: Record<string, string>,
  fetchImpl: FetchLike = fetch,
): Promise<QrPollResult> {
  switch (platform) {
    case "weixin": {
      const baseUrl = state.baseUrl || "https://ilinkai.weixin.qq.com";
      const qrcode = state.qrcode || "";
      const res = await weixinQrStatus(fetchImpl, baseUrl, qrcode);
      if (res.status === "confirmed" && res.token) {
        const resolvedBase = (res.baseUrl || baseUrl).replace(/\/+$/, "");
        return {
          status: "confirmed",
          config: {
            baseUrl: resolvedBase,
            ...(res.botId ? { accountId: res.botId } : {}),
          },
          secrets: { token: res.token },
          account: res.botId || "微信 ClawBot",
          ...(res.userId ? { boundUserId: res.userId } : {}),
        };
      }
      const norm =
        res.status === "scaned" || res.status === "scanned"
          ? "scaned"
          : res.status === "expired"
            ? "expired"
            : "wait";
      return { status: norm };
    }

    case "qq_official": {
      const taskId = state.taskId || "";
      const key = state.key || "";
      const res = await fetchImpl(`${QQ_LITE_BASE}/lite/poll_bind_result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: taskId }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        retcode?: number;
        msg?: string;
        data?: {
          status?: number;
          bot_appid?: string | number;
          bot_encrypt_secret?: string;
          user_openid?: string;
        };
      };
      if (body.retcode !== undefined && body.retcode !== 0) {
        return { status: "expired", message: body.msg || "QQ 扫码已失效" };
      }
      const st = body.data?.status ?? 0;
      if (st === 3) {
        return { status: "expired" };
      }
      if (st === 1) {
        return { status: "scaned" };
      }
      if (st === 2 && body.data?.bot_appid && body.data?.bot_encrypt_secret) {
        const appId = String(body.data.bot_appid).trim();
        const appSecret = decryptQqBotSecret(
          body.data.bot_encrypt_secret,
          key,
        ).trim();
        return {
          status: "confirmed",
          config: { appId },
          secrets: { appSecret },
          account: `AppID ${appId}`,
          ...(body.data.user_openid
            ? { boundUserId: String(body.data.user_openid).trim() }
            : {}),
        };
      }
      return { status: "wait" };
    }

    case "wecom_bot": {
      const scode = state.scode || "";
      const res = await fetchImpl(
        `${WECOM_AI_BASE}/ai/qc/query_result?scode=${encodeURIComponent(scode)}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      const body = (await res.json().catch(() => ({}))) as {
        data?: {
          status?: string;
          bot_info?: { botid?: string; secret?: string };
          userid?: string;
          user_id?: string;
          operator_userid?: string;
          user_info?: { userid?: string; user_id?: string };
        };
      };
      const st = body.data?.status;
      if (
        st === "success" &&
        body.data?.bot_info?.botid &&
        body.data?.bot_info?.secret
      ) {
        const botId = String(body.data.bot_info.botid).trim();
        const secret = String(body.data.bot_info.secret).trim();
        // 平台回了扫码人自己的 userid 就带上（自动回填主人名单）；没回也不挡绑定。
        // bot_info 里的 userid 是机器人自己的 id，不是扫码人的，绝不能拿来回填。
        const boundUserId = firstUserId(
          body.data.userid,
          body.data.user_id,
          body.data.operator_userid,
          body.data.user_info?.userid,
          body.data.user_info?.user_id,
        );
        return {
          status: "confirmed",
          config: { botId },
          secrets: { secret },
          account: botId,
          ...(boundUserId ? { boundUserId } : {}),
        };
      }
      if (st === "scaned" || st === "scanned") {
        return { status: "scaned" };
      }
      if (st === "expired" || st === "timeout" || st === "canceled") {
        return { status: "expired" };
      }
      return { status: "wait" };
    }

    case "dingtalk": {
      const deviceCode = state.deviceCode || "";
      const res = await fetchImpl(
        `${DINGTALK_OAPI_BASE}/app/registration/poll`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: deviceCode }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        errcode?: number;
        errmsg?: string;
        status?: string;
        client_id?: string;
        client_secret?: string;
        fail_reason?: string;
        staff_id?: string;
        user_id?: string;
        userId?: string;
        user_info?: {
          staffId?: string;
          staff_id?: string;
          userId?: string;
          user_id?: string;
        };
      };
      const st = (body.status || "").toUpperCase();
      if (st === "SUCCESS" && body.client_id && body.client_secret) {
        const clientId = String(body.client_id).trim();
        const clientSecret = String(body.client_secret).trim();
        // 平台回了扫码人的钉钉用户 id 就带上（自动回填主人名单）；没回也不挡绑定。
        // 消息里认人用的是 senderStaffId（adapters/dingtalk.ts）：只回填同一种类型的 id
        // （staffId / userid）；unionid、openId 跟它对不上，回填了也是永远匹配不上的假主人。
        const boundUserId = firstUserId(
          body.user_info?.staffId,
          body.user_info?.staff_id,
          body.staff_id,
          body.user_info?.userId,
          body.user_info?.user_id,
          body.user_id,
          body.userId,
        );
        return {
          status: "confirmed",
          config: { clientId },
          secrets: { clientSecret },
          account: clientId,
          ...(boundUserId ? { boundUserId } : {}),
        };
      }
      if (st === "SCANNED") {
        return { status: "scaned" };
      }
      if (
        st === "EXPIRED" ||
        st === "FAIL" ||
        st === "FAILED" ||
        st === "CANCELED"
      ) {
        return {
          status: "expired",
          ...(body.fail_reason ? { message: body.fail_reason } : {}),
        };
      }
      return { status: "wait" };
    }

    case "feishu": {
      const deviceCode = state.deviceCode || "";
      let host = state.host || "accounts.feishu.cn";
      let domain = state.domain || "feishu";
      const pollBody = new URLSearchParams({
        action: "poll",
        device_code: deviceCode,
      }).toString();
      const res = await fetchImpl(`https://${host}/oauth/v1/app/registration`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: pollBody,
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        client_id?: string;
        client_secret?: string;
        error?: string;
        error_description?: string;
        user_info?: { open_id?: string; tenant_brand?: string };
      };
      let nextState: Record<string, string> | undefined;
      if (
        body.user_info?.tenant_brand === "lark" &&
        host !== "accounts.larksuite.com"
      ) {
        host = "accounts.larksuite.com";
        domain = "lark";
        nextState = { ...state, host, domain };
      }
      if (body.client_id && body.client_secret) {
        const appId = String(body.client_id).trim();
        const appSecret = String(body.client_secret).trim();
        return {
          status: "confirmed",
          config: { appId, domain },
          secrets: { appSecret },
          account: appId,
          ...(body.user_info?.open_id
            ? { boundUserId: String(body.user_info.open_id).trim() }
            : {}),
          ...(nextState ? { nextState } : {}),
        };
      }
      if (
        body.error === "expired_token" ||
        body.error === "access_denied" ||
        body.error === "invalid_grant"
      ) {
        return {
          status: "expired",
          ...(body.error_description
            ? { message: body.error_description }
            : {}),
        };
      }
      return {
        status: "wait",
        ...(nextState ? { nextState } : {}),
      };
    }
  }
}
