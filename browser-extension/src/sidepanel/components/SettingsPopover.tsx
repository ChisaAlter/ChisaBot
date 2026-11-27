import { useState } from "react";
import { normalizeDomainEntry } from "../../background/storage";
import {
  BROWSER_PERMISSION_INFO,
  BROWSER_PERMISSION_TIERS,
  type ColorMode,
  type CompanionAuthRecord,
  type CompanionLocalSettings,
  type MaterialId,
  type ThemeId,
} from "../../types/protocol";

const TIERS = BROWSER_PERMISSION_TIERS.map((id) => ({
  id,
  label:
    id === "cautious"
      ? `${BROWSER_PERMISSION_INFO[id].label}（推荐）`
      : BROWSER_PERMISSION_INFO[id].label,
  desc: BROWSER_PERMISSION_INFO[id].description,
}));

const THEMES: ReadonlyArray<{ id: ThemeId; label: string }> = [
  { id: "sky", label: "晴空" },
  { id: "aurora", label: "极光" },
  { id: "porcelain", label: "青花瓷" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "claude", label: "Claude" },
  { id: "cossui", label: "coss ui" },
];

const MATERIALS: ReadonlyArray<{ id: MaterialId; label: string }> = [
  { id: "glass", label: "磨砂玻璃" },
  { id: "clear", label: "通透" },
  { id: "solid", label: "实色" },
];

const COLOR_MODES: ReadonlyArray<{ id: ColorMode; label: string }> = [
  { id: "system", label: "跟随系统" },
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
];

interface SettingsPopoverProps {
  open: boolean;
  auth: CompanionAuthRecord | null;
  settings: CompanionLocalSettings;
  onClose: () => void;
  onUpdateSettings: (patch: Partial<CompanionLocalSettings>) => void;
  onLogout: () => void;
}

export function SettingsPopover({
  open,
  auth,
  settings,
  onClose,
  onUpdateSettings,
  onLogout,
}: SettingsPopoverProps) {
  const [domainInput, setDomainInput] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);

  if (!open) return null;

  function handleAddDomain() {
    const clean = normalizeDomainEntry(domainInput);
    if (!clean) {
      setDomainError("请输入有效域名，例如 bank.example.com");
      return;
    }
    setDomainError(null);
    if (!settings.blockedDomains.includes(clean)) {
      onUpdateSettings({
        blockedDomains: [...settings.blockedDomains, clean],
      });
    }
    setDomainInput("");
  }

  function handleRemoveDomain(domain: string) {
    onUpdateSettings({
      blockedDomains: settings.blockedDomains.filter((d) => d !== domain),
    });
  }

  return (
    <div
      className="sp-settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="浏览器伴侣设置"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="sp-settings-panel" data-surface="elevated">
        <div className="sp-popover-head">
          <h2 className="sp-drawer-title">浏览器伴侣设置</h2>
          <button
            type="button"
            className="sp-icon-btn"
            data-surface="control"
            aria-label="关闭设置"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* 三档权限 */}
        <section>
          <div className="sp-section-label">操控权限档位</div>
          <div className="sp-tier-grid">
            {TIERS.map((tier) => (
              <button
                key={tier.id}
                type="button"
                className="sp-tier-option"
                data-selected={settings.tier === tier.id}
                onClick={() => onUpdateSettings({ tier: tier.id })}
              >
                <span className="sp-tier-title">{tier.label}</span>
                <span className="sp-tier-desc">{tier.desc}</span>
              </button>
            ))}
          </div>
        </section>

        {/* 跨端远程调度开关 */}
        <section className="sp-switch-row" data-surface="inset">
          <div>
            <div className="sp-tier-title">允许从其他设备远程调用此浏览器</div>
            <div className="sp-tier-desc">
              开启后，从手机/网页端点名操作本机 Chrome 时可远程调度本扩展
            </div>
          </div>
          <input
            id="cb-remote-dispatch"
            type="checkbox"
            aria-label="允许从其他设备远程调用此浏览器"
            checked={settings.allowRemoteDispatch}
            onChange={(e) =>
              onUpdateSettings({ allowRemoteDispatch: e.target.checked })
            }
          />
        </section>

        {/* 自定义站点黑名单 */}
        <section>
          <div className="sp-section-label">
            站点黑名单（系统内置浏览器设置/扩展商店/密码管理器永久禁止）
          </div>
          <div className="sp-domain-row">
            <input
              type="text"
              className="sp-input"
              aria-label="添加禁止接管的域名"
              placeholder="例如 icbc.com.cn"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddDomain();
                }
              }}
            />
            <button type="button" className="sp-btn" onClick={handleAddDomain}>
              添加
            </button>
          </div>
          {domainError ? (
            <div
              className="sp-tier-desc"
              style={{ color: "var(--sem-danger)", marginTop: 4 }}
            >
              {domainError}
            </div>
          ) : null}
          {settings.blockedDomains.length > 0 ? (
            <div className="sp-domain-tags">
              {settings.blockedDomains.map((domain) => (
                <span key={domain} className="sp-domain-tag">
                  <span>{domain}</span>
                  <button
                    type="button"
                    className="sp-domain-remove"
                    aria-label={`移除禁止域名 ${domain}`}
                    onClick={() => handleRemoveDomain(domain)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div className="sp-tier-desc" style={{ marginTop: 4 }}>
              暂无自定义黑名单域名
            </div>
          )}
        </section>

        {/* 六套主题 + 深浅色 + 三档材质 */}
        <section>
          <div className="sp-section-label">主题配色</div>
          <div className="sp-theme-grid">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                className="sp-seg-btn"
                data-selected={settings.appearance.theme === t.id}
                onClick={() =>
                  onUpdateSettings({
                    appearance: { ...settings.appearance, theme: t.id },
                  })
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="sp-section-label">深浅色与材质</div>
          <div className="sp-seg-row" style={{ marginBottom: 6 }}>
            {COLOR_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className="sp-seg-btn"
                data-selected={settings.appearance.colorMode === m.id}
                onClick={() =>
                  onUpdateSettings({
                    appearance: { ...settings.appearance, colorMode: m.id },
                  })
                }
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="sp-seg-row">
            {MATERIALS.map((mat) => (
              <button
                key={mat.id}
                type="button"
                className="sp-seg-btn"
                data-selected={settings.appearance.material === mat.id}
                onClick={() =>
                  onUpdateSettings({
                    appearance: { ...settings.appearance, material: mat.id },
                  })
                }
              >
                {mat.label}
              </button>
            ))}
          </div>
        </section>

        {/* 当前设备与退出登录 */}
        {auth ? (
          <section
            className="sp-switch-row"
            data-surface="inset"
            style={{ flexDirection: "column", alignItems: "stretch" }}
          >
            <div className="sp-tier-desc">
              已连接：{auth.serverUrl}（{auth.deviceName}）
            </div>
            <button
              type="button"
              className="sp-btn sp-btn-danger"
              onClick={onLogout}
            >
              退出登录并注销此设备令牌
            </button>
          </section>
        ) : null}
      </div>
    </div>
  );
}
