import { IconLink, IconRocket, IconUsers } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button, T } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Card, ListRow } from "@/components/ui/skyglass";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/settings/share")({
  component: ShareWithFriendsPage,
});

/**
 * 设置 → 分享给朋友（Track D / PRD-P2-04）：两条路径用同一套 ChisaBot 卡片语言说明——
 * 邀请进你的实例，或让朋友自己一键 compose 装一份。
 */
function ShareWithFriendsPage() {
  const caps = useQuery(deploymentCapabilitiesQueryOptions());
  const accountsUi = caps.data?.accountsUi === true;
  const install = "sh deploy/friend-up.sh";

  return (
    <PageShell
      description="邀请朋友用你的实例，或让他自己装一份可分享的自托管助手。安全默认：应用只听本机、公网走 HTTPS 网关、单用户不直连公网。"
      title="分享给朋友"
    >
      <PageSection description="每个账号的机器人、对话、记忆、密钥和设备都是分开的。" title="路径一 · 邀请进你的实例">
        <Card className="mem-card">
          <div className="im-row">
            <div className="im-row-main">
              <ListRow
                icon={
                  <span className="mem-ico is-project">
                    <IconUsers className="size-5" />
                  </span>
                }
                sub={<span className="mem-by">{"设置 → 账号 → 邀请朋友（需打开多账号）"}</span>}
                title={"发一个一次性邀请链接"}
              />
            </div>
            {accountsUi ? (
              <Button nativeButton={false} render={<Link to="/admin/accounts" />} size="sm">
                <T>{"打开账号"}</T>
              </Button>
            ) : (
              <span className="device-cap-chip is-off">
                <T>{"需 CHISABOT_ACCOUNTS_UI=1"}</T>
              </span>
            )}
          </div>
        </Card>
      </PageSection>

      <PageSection
        description="朋友的服务器上跑：loopback 应用 + 可选 HTTPS 网关。详见仓库 docs/friend-deploy.md。"
        title="路径二 · 一键 compose 自托管"
      >
        <Card className="mem-card">
          <div className="im-row">
            <div className="im-row-main">
              <ListRow
                icon={
                  <span className="mem-ico">
                    <IconRocket className="size-5" />
                  </span>
                }
                sub={<span className="mem-by font-mono text-xs">{install}</span>}
                title={"好友可装包"}
              />
            </div>
            <CopyButton size="sm" value={install} variant="outline">
              {"复制命令"}
            </CopyButton>
          </div>
          <div className="im-row">
            <div className="im-row-main">
              <ListRow
                icon={
                  <span className="mem-ico">
                    <IconLink className="size-5" />
                  </span>
                }
                sub={<span className="mem-by">{"公网请走 deploy/public，禁止把 :3001 绑到 0.0.0.0"}</span>}
                title={"安全默认已写进脚本"}
              />
            </div>
          </div>
        </Card>
      </PageSection>
    </PageShell>
  );
}
