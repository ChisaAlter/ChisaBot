import { IconDeviceDesktopDown, IconPlugConnected, IconX } from "@tabler/icons-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { type PcLocalState, pcBridge, usePcLocal } from "@/lib/pc-bridge";

/**
 * 「这台电脑没连上」提示（DESIGN.md §45）。只在 ChisaBot PC 客户端里出现（浏览器没有 window.chisabotPC）。
 *
 * 2026-10-14 用户报告「桌面端还是不能操作本地」：用户一直在聊天里，看不到 设置 → 设备 里写的离线原因；
 * 版本号归正（0.2.x → 0.1.0）之前装的客户端自己永远不会更新到 0.1.x（版本号更小），节点也连不上。
 * 所以在聊天顶栏下面放一枚和「安装应用」同款的玻璃胶囊：
 * - 旧版（0.2.x）→「ChisaBot PC 需要重新安装」，展开三步：下载新版 → 卸载旧版 → 安装后登录；
 * - 没登记 →「登记这台电脑」；
 * - 节点离线 15 秒以上 →「这台电脑没连上 · 重新连接」，点了直接重连（旧客户端没有重连桥就去设备页）。
 * 本机紧急停止、被撤销、设备页本身都不出现；关掉后本次打开不再出现（旧版提示 1 天）。
 */
const OFFLINE_GRACE_MS = 15_000;
const OUTDATED_KEY = "chisabot-pc-outdated-hint";
const OUTDATED_SNOOZE_MS = 24 * 60 * 60 * 1000;
let dismissedThisSession = false;

/** 版本号归正之前的内部构建（0.2.x 及以上的 0.x）：不会自动更新到 0.1.x。 */
export function isPreResetClient(version: string | undefined | null): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(String(version ?? ""));
  if (!match) return false;
  return Number(match[1]) === 0 && Number(match[2]) >= 2;
}

export type PcLinkProblem = "outdated" | "enroll" | "offline" | null;

export function pcLinkProblem(local: PcLocalState | null, offlineLongEnough: boolean): PcLinkProblem {
  if (!local) return null;
  if (isPreResetClient(local.version)) return "outdated";
  if (local.localPaused || local.agentState === "stopped") return null;
  if (local.needsEnroll) return "enroll";
  if (local.agentState === "revoked") return null;
  if (local.agentState !== "online" && offlineLongEnough) return "offline";
  return null;
}

function outdatedSnoozed(): boolean {
  try {
    const at = Number(window.localStorage.getItem(OUTDATED_KEY));
    return Number.isFinite(at) && Date.now() - at < OUTDATED_SNOOZE_MS;
  } catch {
    return false;
  }
}

export function PcLinkHint() {
  const [local, setLocal] = usePcLocal();
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [gone, setGone] = useState(dismissedThisSession);

  const online = local?.agentState === "online";
  useEffect(() => {
    if (!local) return;
    if (online) setOfflineSince(null);
    else setOfflineSince((since) => since ?? Date.now());
  }, [local, online]);
  useEffect(() => {
    if (offlineSince === null) return;
    const left = offlineSince + OFFLINE_GRACE_MS - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), left + 50);
    return () => window.clearTimeout(timer);
  }, [offlineSince]);

  const offlineLongEnough = offlineSince !== null && Date.now() - offlineSince >= OFFLINE_GRACE_MS;
  void tick;
  const problem = pcLinkProblem(local, offlineLongEnough);
  const onDevicesPage = pathname.startsWith("/settings/devices");
  if (!problem || gone || onDevicesPage || pathname.startsWith("/onboarding")) return null;
  if (problem === "outdated" && outdatedSnoozed()) return null;

  const close = () => {
    dismissedThisSession = true;
    if (problem === "outdated") {
      try {
        window.localStorage.setItem(OUTDATED_KEY, String(Date.now()));
      } catch {}
    }
    setClosing(true);
    window.setTimeout(() => setGone(true), 160);
  };

  const goDevices = () => void navigate({ to: "/settings/devices" });

  const act = async () => {
    const bridge = pcBridge();
    if (problem === "outdated") {
      setOpen((value) => !value);
      return;
    }
    if (busy) return;
    if (problem === "enroll" && bridge?.enroll) {
      setBusy(true);
      try {
        const result = await bridge.enroll();
        setLocal(result.state);
      } catch {
        goDevices();
      } finally {
        setBusy(false);
      }
      return;
    }
    if (problem === "offline" && bridge?.reconnect) {
      setBusy(true);
      try {
        const result = await bridge.reconnect();
        setLocal(result.state);
        setOfflineSince(Date.now());
      } catch {
        goDevices();
      } finally {
        setBusy(false);
      }
      return;
    }
    goDevices();
  };

  // 关键的半句放前面：窄窗口（小窗模式 420px）胶囊会截断后半句。
  const title =
    problem === "outdated"
      ? `需要重装 ChisaBot PC · 当前 ${local?.version} 不会自动更新`
      : problem === "enroll"
        ? "这台电脑还没登记 · 机器人用不了它"
        : "这台电脑没连上 · 机器人暂时用不了它";
  const action =
    problem === "outdated" ? "怎么装" : busy ? (problem === "enroll" ? "登记中…" : "连接中…") : problem === "enroll" ? "登记" : "重新连接";
  const Icon = problem === "outdated" ? IconDeviceDesktopDown : IconPlugConnected;

  return (
    <div className="install-hint pc-link-hint" data-state={closing ? "closed" : "open"} role="status" aria-live="polite">
      <div className="install-hint-row">
        <button
          aria-expanded={problem === "outdated" ? open : undefined}
          className="install-hint-main"
          disabled={busy}
          onClick={() => void act()}
          title={problem === "offline" && local?.statusText ? local.statusText : undefined}
          type="button"
        >
          <img alt="" className="install-hint-logo" height={24} src="/pwa-any-192.png" width={24} />
          <span className="install-hint-t">{title}</span>
          <span className="install-hint-go">
            <Icon aria-hidden className="size-4" />
            {action}
          </span>
        </button>
        <button aria-label={"关闭提示"} className="install-hint-x" onClick={close} type="button">
          <IconX className="size-4" />
        </button>
      </div>
      {problem === "outdated" && open ? (
        <ol className="install-hint-ios">
          <li>
            {"在 "}
            <button className="pc-link-hint-link" onClick={goDevices} type="button">
              {"设置 → 设备"}
            </button>
            {" 下载最新的 ChisaBot PC 安装包。"}
          </li>
          <li>{"在 Windows「设置 → 应用」里卸载旧的 ChisaBot PC（旧版本号更大，新版装不上去）。"}</li>
          <li>{"运行新安装包，用这个账号登录。托盘图标变蓝就连上了，机器人就能在你批准后操作这台电脑。"}</li>
        </ol>
      ) : null}
    </div>
  );
}
