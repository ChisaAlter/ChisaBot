import {
  IconAlarm,
  IconInbox,
  IconLogout,
  IconMoon,
  IconQrcode,
  IconSelector,
  IconSettings,
  IconUserCircle,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { GlassAvatar } from "@/components/layout/glass-topbar";
import { useTheme } from "@/components/theme-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { lazyDialog } from "@/components/ui/lazy-dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { approvalInboxOptions } from "@/lib/approvals";
import { recentConfirmationsQueryOptions } from "@/lib/confirmations";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { PROTO_PREVIEW } from "@/lib/proto-preview";
import { fetchServedVersion } from "@/lib/version";
import { cn } from "@/lib/utils";

// 用到才加载、打开过才挂载（DESIGN.md §41.3）。
const PairPhoneDialog = lazyDialog(() => import("@/components/devices/pair-phone").then((m) => m.PairPhoneDialog));
const ProfileDialog = lazyDialog(() => import("@/components/layout/profile-dialog").then((m) => m.ProfileDialog));
function preloadAccountDialogs() {
  PairPhoneDialog.preload();
  ProfileDialog.preload();
}

/**
 * 账号（DESIGN-v4）：左栏最底下一张小玻璃卡 —— 头像 + 名字 + 版本号，点开账号菜单（向上弹出）。
 * 聊天、偏好设置、管理后台三个区域都在同一个位置。左栏收起后只剩头像，菜单向右弹出。
 *
 * 菜单只放「我」的事（DESIGN.md §57 导航收敛）：个人资料 · 设置 · 定时任务 · 待处理（审批角标）‖ 绑定手机 ‖ 暗色外观 ‖ 退出登录。
 * 「通知」（上游 Slack/Teams/短信可达性页）去掉了，IM 接入在设置里；设备管理在 设置 → 设备。
 */
export function AccountMenu({
  compact = false,
  anchorRef,
  placement = "rail",
}: {
  compact?: boolean;
  /** 「topbar」：顶栏右上角的圆形头像（Hark 风格），菜单向下弹出、右边对齐。 */
  placement?: "rail" | "topbar";
  /** 展开时菜单贴着这张账号卡：左右边与卡片齐平、同宽（DESIGN.md §34.2）。 */
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const { data: user } = useQuery(currentUserQueryOptions());
  const approvals = useQuery(approvalInboxOptions());
  const { dark, setDark } = useTheme();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const sidebar = useOptionalSidebar();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  // 「待处理」的数 = 聊天里没点的确认卡片（§58）+ 交给你的操作 + 在等你回答的问题（DESIGN.md §71.1）。
  const confirms = useQuery(recentConfirmationsQueryOptions());
  const pending =
    (approvals.data?.requests.filter((r) => r.status === "pending").length ?? 0) +
    (approvals.data?.questions.length ?? 0) +
    (confirms.data?.filter((r) => r.status === "pending").length ?? 0);
  const [open, setOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  // 当前应用版本（/api/version 的 version，例如 0.1.0）。
  const served = useQuery({
    queryKey: ["app-version"],
    queryFn: () => fetchServedVersion(),
    staleTime: 5 * 60_000,
  });
  const version = served.data?.version ? `v${served.data.version}` : "";

  // 菜单先关、目标路由的代码块加载好再切页，当前屏幕不会闪成占位。
  const go = (to: string) => {
    setOpen(false);
    if (sidebar?.isMobile) sidebar.setOpenMobile(false);
    void router
      .preloadRoute({ to })
      .catch(() => undefined)
      .finally(() => void navigate({ to }));
  };

  const handleSignOut = async () => {
    if (PROTO_PREVIEW) {
      // 沙箱和线上共用一个登录会话：真的退出会把线上也退掉。
      setOpen(false);
      toast.info("原型预览：退出登录已停用（会话与线上共用）");
      return;
    }
    try {
      await signOut.mutateAsync();
      await navigate({ to: "/sign" });
    } catch {
      toast.error("退出失败，请检查网络后重试。");
    }
  };

  // 只显示头像 + 名称 + 版本号；不显示邮箱和身份。
  const name = user?.name || user?.email || "";
  const sub = version;
  const icon = "size-[18px] shrink-0";

  const topbar = placement === "topbar";
  const trigger = topbar ? (
    <button aria-label={"账号与设置"} className="hk-avatar-btn glass is-flat" type="button" />
  ) : compact ? (
    <button aria-label={"账号与设置"} className="acct-mini" type="button" />
  ) : (
    <button aria-label={"账号与设置"} className="acct-row" type="button" />
  );
  const triggerBody = topbar ? (
    <>
      <GlassAvatar ring={false} size={32} />
      {pending > 0 ? <span aria-hidden className="glass-avatar-dot" /> : null}
    </>
  ) : compact ? (
    <>
      <GlassAvatar ring={false} size={36} />
      {pending > 0 ? <span aria-hidden className="glass-avatar-dot" /> : null}
    </>
  ) : (
    <>
      <span className="acct-ava">
        <GlassAvatar ring={false} size={32} />
        {pending > 0 ? <span aria-hidden className="glass-avatar-dot" /> : null}
      </span>
      <span className="acct-text">
        <span className="acct-name">{name}</span>
        {sub ? <span className="acct-sub">{sub}</span> : null}
      </span>
      <IconSelector aria-hidden className="acct-chev" />
    </>
  );

  return (
    <>
    <DropdownMenu
      onOpenChange={(next) => {
        if (next) preloadAccountDialogs();
        setOpen(next);
      }}
      open={open}
    >
      {compact || topbar ? (
        <Tooltip>
          <TooltipTrigger render={<DropdownMenuTrigger render={trigger} />}>{triggerBody}</TooltipTrigger>
          <TooltipContent side={topbar ? "bottom" : "right"} sideOffset={topbar ? 8 : 10}>
            {name || "账号"}
          </TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger render={trigger}>{triggerBody}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        align={compact || topbar ? "end" : "start"}
        anchor={compact || topbar ? undefined : anchorRef}
        className={cn("glass-pop acct-pop", compact || topbar ? "w-[264px]" : "is-flush")}
        side={topbar ? "bottom" : compact ? "right" : "top"}
        sideOffset={topbar ? 8 : compact ? 12 : 8}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="acct-pop-head">
            <span className="mi-lead">
              <GlassAvatar ring={false} size={32} />
            </span>
            <span className="acct-text">
              <span className="acct-name">{name}</span>
              {version ? <span className="acct-sub">{version}</span> : null}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="glass-sep" />
        <DropdownMenuGroup className="py-1">
          <Row
            icon={<IconUserCircle className={icon} />}
            label={"个人资料"}
            onClick={() => {
              setOpen(false);
              setProfileOpen(true);
            }}
          />
          <Row icon={<IconSettings className={icon} />} label={"设置"} onClick={() => go("/settings")} />
          <Row icon={<IconAlarm className={icon} />} label={"定时任务"} onClick={() => go("/settings/schedules")} />
          <Row
            hint={pending > 0 ? `${pending} 项` : undefined}
            icon={<IconInbox className={icon} />}
            label={"待处理"}
            onClick={() => go("/approvals")}
          />
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="glass-sep" />
        <DropdownMenuGroup className="py-1">
          {/* 扫码绑定手机：直接弹出二维码（网页和 PC 客户端里都一样，DESIGN.md §33）。 */}
          <Row
            icon={<IconQrcode className={icon} />}
            label={"绑定手机"}
            onClick={() => {
              setOpen(false);
              if (sidebar?.isMobile) sidebar.setOpenMobile(false);
              setPairOpen(true);
            }}
          />
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="glass-sep" />
        <DropdownMenuGroup className="py-1">
          <DropdownMenuItem className="glass-mi" closeOnClick={false} onClick={() => setDark(!dark)}>
            <span className="mi-lead">
              <IconMoon className={icon} />
            </span>
            <span className="t-line min-w-0 flex-1">{"暗色外观"}</span>
            <Switch
              aria-label={"暗色外观"}
              checked={dark}
              onCheckedChange={setDark}
              onClick={(event) => event.stopPropagation()}
            />
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="glass-sep" />
        <DropdownMenuGroup className="py-1">
          <Row
            danger
            icon={<IconLogout className={icon} />}
            label={signOut.isPending ? "正在退出…" : "退出登录"}
            onClick={handleSignOut}
          />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <ProfileDialog onOpenChange={setProfileOpen} open={profileOpen} />
    <PairPhoneDialog onOpenChange={setPairOpen} open={pairOpen} />
    </>
  );
}

function Row({
  icon,
  label,
  hint,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <DropdownMenuItem
      className={cn("glass-mi", danger && "is-danger")}
      onClick={onClick}
      variant={danger ? "destructive" : "default"}
    >
      <span className="mi-lead">{icon}</span>
      <span className="t-line min-w-0 flex-1">{label}</span>
      {hint ? <span className="glass-mi-hint">{hint}</span> : null}
    </DropdownMenuItem>
  );
}

/** 左栏底部的账号卡（展开时）。 */
export function AccountCard() {
  const card = useRef<HTMLDivElement>(null);
  return (
    <div className="glass-card acct-card" ref={card}>
      <AccountMenu anchorRef={card} />
    </div>
  );
}
