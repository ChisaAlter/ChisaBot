import {
  IconAlarm,
  IconInbox,
  IconListCheck,
  IconLogout,
  IconMoon,
  IconQrcode,
  IconSettings,
  IconUserCircle,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { GlassAvatar } from "@/components/layout/glass-topbar";
import { useTheme } from "@/components/theme-provider";
import { useOpenTaskCenter } from "@/components/task-center/task-center-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openAccountDialog, preloadAccountDialogs } from "./account-dialogs";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { usePendingActionCount } from "@/lib/pending-actions";
import { PROTO_PREVIEW } from "@/lib/proto-preview";
import { cn } from "@/lib/utils";


/**
 * 账号（DESIGN-v4）：左栏最底下一张小玻璃卡 —— 头像 + 名字，点开账号菜单（向上弹出）。
 * 聊天、偏好设置、管理后台三个区域都在同一个位置。左栏收起后只剩头像，菜单向右弹出。
 *
 * 菜单只放「我」的高频入口（DESIGN.md §57 导航收敛）：个人资料 · 设置 · 任务中心 · 定时任务 · 待处理（审批角标）‖ 绑定手机 ‖ 暗色外观 ‖ 退出登录。
 * 版本号、桌面端更新与服务端更新统一收束至「设置 → 版本与更新」，不占用账号卡与账号菜单。
 */
export function AccountMenu({
  compact = false,
  anchorRef,
}: {
  compact?: boolean;
  /** 展开时菜单贴着这张账号卡：左右边与卡片齐平、同宽（DESIGN.md §34.2）。 */
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const { data: user } = useQuery(currentUserQueryOptions());
  const { dark, setDark } = useTheme();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const sidebar = useOptionalSidebar();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const pending = usePendingActionCount();
  const [open, setOpen] = useState(false);
  const openTaskCenter = useOpenTaskCenter();

  /*
   * 点菜单项去别的页（jank P1-6）：菜单立刻收起、不播退出动画，收起那一帧画出来后马上切页——
   * 不再等代码块加载完（菜单打开时、外壳空闲时就已经在预取），也不把整页渲染塞进点击那一下。
   */
  const [leaving, setLeaving] = useState(false);
  const go = (to: string) => {
    setLeaving(true);
    setOpen(false);
    if (sidebar?.isMobile) sidebar.setOpenMobile(false);
    requestAnimationFrame(() => setTimeout(() => void navigate({ to }), 0));
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

  // 只显示头像 + 名称；版本号与升级入口统一收束在「设置 → 版本与更新」。
  const name = user?.name || user?.email || "";
  const icon = "size-[18px] shrink-0";

  const trigger = compact ? (
    <button aria-label={"账号与设置"} className="acct-mini" type="button" />
  ) : (
    <button aria-label={"账号与设置"} className="acct-row" type="button" />
  );
  const triggerBody = compact ? (
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
        <span className="acct-name" data-private="">
          {name}
        </span>
      </span>
    </>
  );

  return (
    <DropdownMenu
      // 非模态（jank P1-6）：不铺全屏遮罩，打开 / 关闭不为它量整页布局。
      modal={false}
      onOpenChange={(next) => {
        if (next) {
          preloadAccountDialogs();
          setLeaving(false);
          void router.preloadRoute({ to: "/settings" }).catch(() => undefined);
        }
        setOpen(next);
      }}
      open={open}
    >
      {compact ? (
        <Tooltip>
          <TooltipTrigger render={<DropdownMenuTrigger render={trigger} />}>{triggerBody}</TooltipTrigger>
          <TooltipContent side={"right"} sideOffset={10}>
            {name || "账号"}
          </TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger render={trigger}>{triggerBody}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        align={compact ? "end" : "start"}
        anchor={compact ? undefined : anchorRef}
        className={cn("glass-pop acct-pop", leaving && "is-leaving", compact ? "w-[264px]" : "is-flush")}
        side={compact ? "right" : "top"}
        sideOffset={compact ? 12 : 8}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="acct-pop-head">
            <span className="mi-lead">
              <GlassAvatar ring={false} size={32} />
            </span>
            <span className="acct-text">
              <span className="acct-name" data-private="">
                {name}
              </span>
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
              if (sidebar?.isMobile) sidebar.setOpenMobile(false);
              openAccountDialog("profile");
            }}
          />
          <Row icon={<IconSettings className={icon} />} label={"设置"} onClick={() => go("/settings")} />
          <Row icon={<IconListCheck className={icon} />} label={"任务中心"} onClick={() => {
            setOpen(false);
            if (sidebar?.isMobile) sidebar.setOpenMobile(false);
            openTaskCenter();
          }} />
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
              openAccountDialog("pair-phone");
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
