import { useEffect, useState } from "react";

/**
 * ChisaBot PC 客户端的本机桥（docs/pc-node.md §8.2）。
 *
 * PC 客户端的主窗口就是这个网页本身，所以「设备」页面同时是 PC 的本机设置页。只有网页做不到的本机事情
 * 才走这座桥：本机紧急停止、高风险操作的本机确认、开机自启、文件夹选择器、退出登录。桥由 Electron 的
 * preload 只在「已登录的那台服务器」的页面里注入；主进程对每次调用再核对来源，并且任何「放松安全」的改动
 * （解除紧急停止、关闭本机确认、退出登录）都会在 PC 上弹出本机确认窗，网页无法替用户点。
 * 在普通浏览器里 `window.chisabotPC` 不存在，所有本机界面都不渲染。
 */

export type PcLocalState = {
  version: string;
  platform: string;
  hostname: string;
  serverUrl: string;
  deviceId: string;
  agentState: "online" | "connecting" | "offline" | "revoked" | "stopped";
  statusText: string;
  /** 本机有没有设备令牌（0.1.1 起）。false = 已登录但这台电脑还没登记成设备。旧客户端没有这个字段。 */
  enrolled?: boolean;
  /** 需要「登记这台电脑」：没登记 / 令牌无效 / 被撤销（0.1.1 起）。 */
  needsEnroll?: boolean;
  /** 节点这次连接走的路线：「直连」或「HTTP 代理 127.0.0.1:7890」（0.1.6 起，系统代理）。 */
  networkRoute?: string;
  tokenProtected: boolean;
  localPaused: boolean;
  forceLocalApproval: boolean;
  autoStart: boolean;
  startHidden: boolean;
  /** 自动更新（docs/online-update.md §PC）。旧客户端没有这个字段，网页就不显示更新设置。 */
  autoUpdate?: boolean;
  update?: PcUpdateState;
};

export type PcUpdateState = {
  /** 打包后的安装版才能自动更新；开发运行 / 免安装版为 false。 */
  supported: boolean;
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "none" | "error";
  /** 发现 / 下载好的新版本号。 */
  version?: string;
  /** 下载进度 0–100。 */
  percent?: number;
  checkedAt?: string;
  error?: string;
};

export type PcLocalPatch = Partial<
  Pick<PcLocalState, "localPaused" | "forceLocalApproval" | "autoStart" | "startHidden" | "autoUpdate">
>;

export type PcBridge = {
  state(): Promise<PcLocalState>;
  /** 收紧（开启紧急停止 / 开启本机确认）立即生效；放松要在 PC 上本机确认，用户取消时返回的状态不变。 */
  setLocal(patch: PcLocalPatch): Promise<PcLocalState>;
  /** 系统文件夹选择器；返回选中的绝对路径（取消 = 空数组）。 */
  pickFolders(): Promise<string[]>;
  /** 退出登录并作废这台电脑的设备令牌（本机确认后），回到设置向导。 */
  logout(): Promise<boolean>;
  /**
   * 用当前登录会话把这台电脑（重新）登记成设备（0.1.1 起，旧客户端没有）。被撤销过的设备会先在 PC 上弹本机确认。
   * status：enrolled / already（令牌仍有效，重新连接）/ login（会话过期）/ offline / failed / cancelled。
   */
  enroll?(): Promise<{ status: string; message: string; state: PcLocalState }>;
  /** 跳过重连等待，立刻重新连接服务器（没登记时先补登记；0.1.6 起）。 */
  reconnect?(): Promise<{ status: string; message: string; state: PcLocalState }>;
  /** 立即检查更新（返回最新的更新状态）。 */
  checkUpdate?(): Promise<PcUpdateState>;
  /** 新版本已下载时，退出并安装（会先在本机弹确认窗）。 */
  installUpdate?(): Promise<boolean>;
  onChange(callback: () => void): () => void;
};

declare global {
  interface Window {
    chisabotPC?: PcBridge;
  }
}

export function pcBridge(): PcBridge | null {
  return typeof window !== "undefined" && window.chisabotPC ? window.chisabotPC : null;
}

/** 在 PC 客户端里返回本机状态（随托盘 / 节点状态变化刷新）；在浏览器里始终是 null。 */
export function usePcLocal(): [PcLocalState | null, (next: PcLocalState) => void] {
  const [state, setState] = useState<PcLocalState | null>(null);
  useEffect(() => {
    const bridge = pcBridge();
    if (!bridge) return;
    let alive = true;
    const load = () =>
      bridge
        .state()
        .then((next) => alive && setState(next))
        .catch(() => {});
    void load();
    const off = bridge.onChange(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, []);
  return [state, setState];
}
