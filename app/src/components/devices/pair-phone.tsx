import { IconCheck, IconDeviceMobile, IconQrcode, IconRefresh } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pairingUri } from "../../../../shared/devices";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cancelPairing, createPairing, deviceKeys, type PairingTicket, pairingStatus } from "@/lib/devices";
import { qrPath } from "@/lib/qr";
import { cn } from "@/lib/utils";

/**
 * 设置 → 设备 →「绑定手机」（DESIGN.md §33）。
 *
 * 弹窗里是一次性二维码：内容 = 服务器地址 + 5 分钟有效、只能用一次的绑定码。
 * 每 2 秒问一次状态：等待扫码 → 已绑定（二维码淡出，✓ 和手机名淡入）。码过期自动换新码；
 * 连续自动换 {@link MAX_AUTO_REFRESH} 次没人扫就停下，等人点「刷新二维码」。关窗即作废当前码。
 */

const POLL_MS = 2000;
const MAX_AUTO_REFRESH = 6;

type Phase =
  | { kind: "loading" }
  | { kind: "pending"; ticket: PairingTicket }
  | { kind: "paused" }
  | { kind: "bound"; name: string }
  | { kind: "error"; message: string };

function useCountdown(expiresAt: string | null, ttlSeconds: number) {
  // 服务器时钟和本机可能差几分钟：只用 ttlSeconds + 本机单调时钟倒数（同 useApprovalCountdown 的做法）。
  const [left, setLeft] = useState(ttlSeconds);
  useEffect(() => {
    if (!expiresAt) return;
    const start = performance.now();
    setLeft(ttlSeconds);
    const timer = window.setInterval(() => {
      setLeft(Math.max(0, Math.ceil(ttlSeconds - (performance.now() - start) / 1000)));
    }, 500);
    return () => window.clearInterval(timer);
  }, [expiresAt, ttlSeconds]);
  return left;
}

function mmss(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function PairQr({ value, dim }: { value: string; dim?: boolean }) {
  const qr = useMemo(() => qrPath(value), [value]);
  const quiet = 2;
  const box = qr.size + quiet * 2;
  return (
    <svg
      aria-label="绑定二维码"
      className={cn("pair-qr-svg", dim && "is-dim")}
      role="img"
      shapeRendering="crispEdges"
      viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
    >
      <rect fill="#fff" height={box} width={box} x={-quiet} y={-quiet} />
      <path d={qr.path} fill="#0b1220" />
    </svg>
  );
}

export function PairPhoneDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const autoRefreshes = useRef(0);
  const current = useRef<string | null>(null);
  const server = typeof window === "undefined" ? "" : window.location.origin;

  const issue = useCallback(async () => {
    const previous = current.current;
    const ticket = await createPairing();
    current.current = ticket.id;
    if (previous) void cancelPairing(previous);
    setPhase({ kind: "pending", ticket });
    return ticket;
  }, []);

  // 打开时签发；关闭时作废。
  useEffect(() => {
    if (!open) return;
    autoRefreshes.current = 0;
    setPhase({ kind: "loading" });
    let alive = true;
    issue().catch((error: Error) => alive && setPhase({ kind: "error", message: error.message }));
    return () => {
      alive = false;
      if (current.current) void cancelPairing(current.current);
      current.current = null;
    };
  }, [open, issue]);

  const ticket = phase.kind === "pending" ? phase.ticket : null;
  const left = useCountdown(ticket?.expiresAt ?? null, ticket?.ttlSeconds ?? 300);

  // 轮询绑定状态。
  useEffect(() => {
    if (!ticket) return;
    const controller = new AbortController();
    let timer = 0;
    const tick = async () => {
      try {
        const status = await pairingStatus(ticket.id, controller.signal);
        if (controller.signal.aborted) return;
        if (status.state === "bound") {
          current.current = null;
          setPhase({ kind: "bound", name: status.device?.name ?? "这台手机" });
          void queryClient.invalidateQueries({ queryKey: deviceKeys.all });
          return;
        }
        if (status.state === "expired" || status.state === "cancelled") return; // 倒计时那边负责换码
      } catch {
        /* 偶发网络错误：下一轮再问。 */
      }
      if (!controller.signal.aborted) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [ticket, queryClient]);

  // 过期自动换码。
  useEffect(() => {
    if (!ticket || left > 0) return;
    if (autoRefreshes.current >= MAX_AUTO_REFRESH) {
      if (current.current) void cancelPairing(current.current);
      current.current = null;
      setPhase({ kind: "paused" });
      return;
    }
    autoRefreshes.current += 1;
    issue().catch((error: Error) => setPhase({ kind: "error", message: error.message }));
  }, [left, ticket, issue]);

  const refresh = useAsyncAction(
    async () => {
      autoRefreshes.current = 0;
      await issue();
    },
    { errorToast: (error) => `刷新失败：${error.message}` },
  );

  const status =
    phase.kind === "bound"
      ? { tone: "is-ok", text: "已绑定" }
      : phase.kind === "pending"
        ? { tone: "is-accent", text: "等待扫码" }
        : phase.kind === "paused"
          ? { tone: "is-muted", text: "已暂停刷新" }
          : phase.kind === "error"
            ? { tone: "is-danger", text: "生成失败" }
            : { tone: "is-muted", text: "生成中…" };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="pair-dialog max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{"绑定手机"}</DialogTitle>
          <DialogDescription>{"用 ChisaBot 安卓 App 扫这个二维码，手机就会登录到你的账号并出现在设备列表里。"}</DialogDescription>
        </DialogHeader>

        <DialogBody className="pair-body">
          <div className={cn("pair-qr", phase.kind === "bound" && "is-bound")}>
            {phase.kind === "pending" ? (
              <PairQr value={pairingUri(server, phase.ticket.code)} />
            ) : phase.kind === "loading" ? (
              <div aria-hidden className="pair-qr-skeleton" />
            ) : (
              <div aria-hidden className="pair-qr-skeleton is-still" />
            )}
            {phase.kind === "bound" ? (
              <div className="pair-qr-done" role="status">
                <span className="pair-qr-check">
                  <IconCheck className="size-8" stroke={2.4} />
                </span>
                <b>{phase.name}</b>
                <span>{"已绑定，手机正在进入主机器人"}</span>
              </div>
            ) : null}
            {phase.kind === "paused" || phase.kind === "error" ? (
              <div className="pair-qr-done is-plain">
                <IconQrcode className="size-7 opacity-70" />
                <span>{phase.kind === "paused" ? "二维码已暂停刷新" : phase.message}</span>
              </div>
            ) : null}
          </div>

          <div className="pair-meta">
            <span aria-live="polite" className={cn("device-badge", status.tone)}>
              {phase.kind === "pending" ? <span className="device-dot is-ok pair-dot" /> : null}
              <T>{status.text}</T>
            </span>
            {phase.kind === "pending" ? (
              <span className="pair-countdown">{`${mmss(left)} 后自动刷新 · 只能用一次`}</span>
            ) : null}
          </div>

          <ol className="pair-steps">
            <li>
              <IconDeviceMobile aria-hidden className="size-4" />
              <span>
                {"在手机上打开 ChisaBot，登录页点 "}
                <b>{"扫码绑定"}</b>
              </span>
            </li>
            <li>
              <IconQrcode aria-hidden className="size-4" />
              <span>
                {"对准二维码，服务器地址 "}
                <code className="device-code pair-server">{server}</code>
                {" 会自动填好"}
              </span>
            </li>
          </ol>
        </DialogBody>

        <DialogFooter className="pair-footer">
          {phase.kind === "bound" ? (
            <>
              <Button
                onClick={() => {
                  autoRefreshes.current = 0;
                  setPhase({ kind: "loading" });
                  issue().catch((error: Error) => setPhase({ kind: "error", message: error.message }));
                }}
                type="button"
                variant="outline"
              >
                {"再绑定一台"}
              </Button>
              <Button onClick={() => onOpenChange(false)} type="button">
                {"完成"}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
                {"关闭"}
              </Button>
              <Button
                disabled={phase.kind === "loading"}
                feedback="refresh"
                onClick={() => void refresh.run()}
                state={refresh.state}
                type="button"
              >
                <IconRefresh />
                {"刷新二维码"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PairPhoneButton({ size = "sm", variant = "outline" }: { size?: "sm" | "default"; variant?: "outline" | "default" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} size={size} type="button" variant={variant}>
        <IconQrcode />
        {"绑定手机"}
      </Button>
      <PairPhoneDialog onOpenChange={setOpen} open={open} />
    </>
  );
}
