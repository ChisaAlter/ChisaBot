import { type FormEvent, useState } from "react";
import type { DetectedChisaBotTab } from "../../types/protocol";

interface LoginViewProps {
  detectedTabs: DetectedChisaBotTab[];
  detecting: boolean;
  onRefreshDetect: () => void;
  onClaimTab: (tab: DetectedChisaBotTab) => Promise<void>;
  onLoginPassword: (input: {
    serverUrl: string;
    username: string;
    password: string;
  }) => Promise<void>;
  onLoginPairing: (input: { serverUrl: string; code: string }) => Promise<void>;
}

export function LoginView({
  detectedTabs,
  detecting,
  onRefreshDetect,
  onClaimTab,
  onLoginPassword,
  onLoginPairing,
}: LoginViewProps) {
  const [mode, setMode] = useState<"password" | "pairing">("password");
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClaim(tab: DetectedChisaBotTab) {
    setError(null);
    setBusy(true);
    try {
      await onClaimTab(tab);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "免密认领失败，请改用账号密码或配对码登录。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "password") {
        await onLoginPassword({ serverUrl, username, password });
      } else {
        await onLoginPairing({ serverUrl, code: pairingCode });
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "登录失败，请检查地址与凭据。",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sp-login-page">
      <div className="sp-login-hero">
        <img
          src="../icons/icon-128.png"
          alt="ChisaBot"
          className="sp-login-logo"
        />
        <h1 className="sp-login-title">ChisaBot 浏览器伴侣</h1>
        <p className="sp-login-sub">
          登录你的 ChisaBot 服务器，让助手在侧边栏安全协作浏览当前网页
        </p>
      </div>

      {/* 一键免密认领卡片 */}
      <section className="sp-card" data-surface="panel">
        <div className="sp-popover-head">
          <strong style={{ fontSize: "13.5px" }}>已登录网页一键免密登录</strong>
          <button
            type="button"
            className="sp-btn sp-btn-sm"
            disabled={detecting || busy}
            onClick={onRefreshDetect}
          >
            {detecting ? "探测中…" : "重新探测"}
          </button>
        </div>

        {detectedTabs.length > 0 ? (
          <div className="sp-list">
            {detectedTabs.map((tab) => (
              <div
                key={`${tab.tabId}-${tab.origin}`}
                className="sp-detected-item"
                data-surface="inset"
              >
                <div className="sp-detected-meta">
                  <span className="sp-detected-origin">{tab.origin}</span>
                  <span className="sp-detected-user">
                    {tab.userName ? `已登录账号：${tab.userName}` : tab.title}
                  </span>
                </div>
                <button
                  type="button"
                  className="sp-btn sp-btn-primary sp-btn-sm"
                  disabled={busy}
                  onClick={() => void handleClaim(tab)}
                >
                  一键登录
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="sp-login-sub" style={{ textAlign: "left" }}>
            {detecting
              ? "正在检测当前 Chrome 中已打开的 ChisaBot 网页…"
              : "未检测到已登录的 ChisaBot 标签页。你可以先在浏览器中打开 ChisaBot 网页，或直接在下方登录。"}
          </p>
        )}
      </section>

      {/* 账号密码 / 配对码切换 */}
      <form className="sp-card" data-surface="panel" onSubmit={handleSubmit}>
        <div className="sp-seg-row" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <button
            type="button"
            className="sp-seg-btn"
            data-selected={mode === "password"}
            onClick={() => {
              setMode("password");
              setError(null);
            }}
          >
            账号密码登录
          </button>
          <button
            type="button"
            className="sp-seg-btn"
            data-selected={mode === "pairing"}
            onClick={() => {
              setMode("pairing");
              setError(null);
            }}
          >
            配对码绑定
          </button>
        </div>

        <div className="sp-field">
          <label htmlFor="cb-server-url">服务器地址</label>
          <input
            id="cb-server-url"
            className="sp-input"
            type="url"
            placeholder="https://chisabot.example.com:8443"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            required={
              mode === "password" || !pairingCode.startsWith("chisabot://")
            }
          />
        </div>

        {mode === "password" ? (
          <>
            <div className="sp-field">
              <label htmlFor="cb-username">账号或邮箱</label>
              <input
                id="cb-username"
                className="sp-input"
                type="text"
                autoComplete="username"
                placeholder="输入登录账号"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>

            <div className="sp-field">
              <label htmlFor="cb-password">密码</label>
              <input
                id="cb-password"
                className="sp-input"
                type="password"
                autoComplete="current-password"
                placeholder="输入登录密码（不保存在本地）"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </>
        ) : (
          <div className="sp-field">
            <label htmlFor="cb-pairing-code">一次性配对码</label>
            <input
              id="cb-pairing-code"
              className="sp-input"
              type="text"
              placeholder="粘贴 cbp_... 配对码或 chisabot://pair 链接"
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value)}
              required
            />
            <span className="sp-tier-desc">
              在 ChisaBot 网页「设置 → 设备 → Chrome / Edge
              浏览器扩展」生成一次性配对码
            </span>
          </div>
        )}

        {error ? (
          <div className="sp-alert" role="alert">
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          className="sp-btn sp-btn-primary"
          disabled={busy}
          style={{ width: "100%" }}
        >
          {busy
            ? "正在连接服务器…"
            : mode === "password"
              ? "登录并绑定此浏览器"
              : "验证配对码并绑定"}
        </button>
      </form>
    </div>
  );
}
