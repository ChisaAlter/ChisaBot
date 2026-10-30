import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import {
  isLoginLoopDetected,
  signOutAndReLogin,
  subscribeLoginLoop,
} from "@/lib/auth/login-redirect";

/**
 * 「登录状态异常」：刚从 /login 回来又被网关 401（会话有效但后端不认：身份头重放、签名校验失败），
 * 不再自动跳 /login（会死循环），而是停在这里让用户「退出重新登录」。
 * 外观沿用整页加载卡片（page-loader-*），不加新的 backdrop-filter。在 main.tsx 挂在路由外面，
 * 因为 _authed 此时停在启动骨架上，路由树里的东西不会渲染。
 */
export function AuthLoopNotice() {
  const open = useSyncExternalStore(
    subscribeLoginLoop,
    isLoginLoopDetected,
    () => false,
  );
  if (!open || typeof document === "undefined") return null;
  return createPortal(<AuthLoopCard />, document.body);
}

export function AuthLoopCard({
  onSignOut = () => signOutAndReLogin(),
}: {
  onSignOut?: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    buttonRef.current?.focus();
  }, []);
  return (
    <div className="page-loader-overlay" data-auth-loop="">
      <div
        aria-describedby="auth-loop-desc"
        aria-labelledby="auth-loop-title"
        aria-modal="true"
        className="page-loader-card"
        data-btn-state="error"
        role="alertdialog"
      >
        <div className="page-loader-title" id="auth-loop-title">
          {"登录状态异常"}
        </div>
        <div className="page-loader-desc" id="auth-loop-desc">
          {
            "你已经登录，但服务器暂时没认出这次登录。退出后重新登录一次，通常就能恢复。"
          }
        </div>
        <div className="page-loader-actions">
          <Button
            disabled={pending}
            onClick={() => {
              setPending(true);
              void onSignOut().catch(() => setPending(false));
            }}
            ref={buttonRef}
          >
            {pending ? "正在退出…" : "退出重新登录"}
          </Button>
        </div>
      </div>
    </div>
  );
}
