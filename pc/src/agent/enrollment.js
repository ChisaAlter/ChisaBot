"use strict";
/**
 * 「这台电脑有没有登记成设备」的自我修复（2026-10-13）。
 *
 * 以前只有在本机登录页点「登录」时才会登记设备（POST /api/devices/enroll）。如果启动时网页会话还有效
 * （记住登录 = 30 天 Cookie）但本机没有设备令牌——重装后令牌没了、DPAPI 解不开、旧版本留下的配置——
 * 客户端会直接打开聊天窗口，节点却永远不连，机器人看不到这台电脑，托盘只写「未登录」。
 * 现在启动时、托盘「重新登记这台电脑」、网页设备页的按钮都走这里：会话有效就用会话 Cookie 补登记。
 *
 * 不会绕过撤销：被撤销的令牌仍留在本机，自动路径（force=false）看到有令牌就不动；只有用户在这台电脑上
 * 亲自点「重新登记」（force=true）才会作废本机旧令牌并重新登记。
 *
 * @param {object} deps
 * @param {{get: () => object, set: (patch: object) => object, getToken: () => string|null, setToken: (t: string|null) => void}} deps.config
 * @param {() => Promise<"ok"|"login"|"offline">} deps.sessionStatus  网页会话是否有效
 * @param {() => Promise<string>} deps.cookieHeader                  该服务器的会话 Cookie 头
 * @param {(input: {serverUrl: string, cookieHeader: string, info: object}) => Promise<{token: string, device: {id: string, name: string}}>} deps.enroll
 * @param {(input: {serverUrl: string, token: string}) => Promise<{ok: boolean, revoked?: boolean, invalid?: boolean}>} [deps.checkToken]
 * @param {object} deps.info  clientInfo() + name
 * @param {boolean} [deps.force]
 * @returns {Promise<{status: "no-server"|"already"|"login"|"offline"|"enrolled"|"failed", message: string, device?: object}>}
 */
async function ensureEnrolled({ config, sessionStatus, cookieHeader, enroll, checkToken, info, force = false }) {
  const { serverUrl } = config.get();
  if (!serverUrl) return { status: "no-server", message: "还没有登录服务器。" };
  const token = config.getToken();
  if (token) {
    if (!force) return { status: "already", message: "已登记。" };
    // 用户点了「重新登记」：令牌其实还有效（只是暂时连不上）就别重复登记出第二台设备。
    if (checkToken) {
      const check = await checkToken({ serverUrl, token }).catch(() => ({ ok: false }));
      if (check.ok) return { status: "already", message: "设备令牌仍然有效，正在重新连接。" };
      if (!check.revoked && !check.invalid) return { status: "offline", message: "暂时连不上服务器，稍后会自动重试。" };
    }
  }
  const session = await sessionStatus().catch(() => "offline");
  if (session === "login") return { status: "login", message: "登录已过期，请重新登录 ChisaBot。" };
  if (session === "offline") return { status: "offline", message: "暂时连不上服务器，稍后会自动重试。" };
  try {
    const result = await enroll({ serverUrl, cookieHeader: await cookieHeader(), info });
    config.setToken(result.token);
    config.set({ deviceId: result.device.id, deviceName: result.device.name, localPaused: false });
    return { status: "enrolled", message: `已登记为设备「${result.device.name}」。`, device: result.device };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { status: "failed", message: `这台电脑没能登记为设备：${message}` };
  }
}

module.exports = { ensureEnrolled };
