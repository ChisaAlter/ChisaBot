import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChevronLeft,
  IconPlugConnectedX,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * 设备页的几块小部件（模块 14 审计 O5 / O6 / O7 / O8）。颜色、间距只用 DESIGN.md 的令牌
 * （sg-errcard / device-* 现有类 + Tailwind 间距刻度），不引入新颜色。
 */

/** 面包屑「设置 / 设备」（O5）：每个点击目标至少 32px 高（min-h-8），比原来 19px 的纯文字链接好点。 */
export function DeviceCrumbs({ label = "设备" }: { label?: string }) {
  const crumb = "inline-flex min-h-8 items-center gap-1 rounded-md px-1 -mx-1";
  return (
    <>
      <Link className={crumb} data-testid="device-crumb-area" to="/settings">
        {"设置"}
      </Link>
      <span aria-hidden className="ph-crumb-sep">
        {"/"}
      </span>
      <Link
        className={cn("ph-crumb-back", crumb)}
        data-testid="device-crumb-back"
        to="/settings/devices"
      >
        <IconChevronLeft className="size-3.5" />
        {label}
      </Link>
    </>
  );
}

/**
 * 设备页的错误卡（O6）：外观同 ErrorCard（sg-errcard），但标题是 h2——页面标题是 h1，
 * 原来的 h4 让标题层级跳了两级。
 */
export function DeviceErrorCard({
  title,
  description,
  action,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="sg-errcard" data-testid="device-error-card" role="alert">
      <IconAlertTriangle className="sg-errcard-ic size-[18px]" />
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-sm font-semibold">{title}</h2>
        {description ? <p>{description}</p> : null}
        {action}
      </div>
    </div>
  );
}

/** 读不到这台设备（404 / 已删除 / 网络错误）（O7）：给出「返回设备列表」，不再是死胡同。 */
export function DeviceNotFound({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <DeviceErrorCard
      action={
        <div className="mt-2 flex flex-wrap gap-2">
          <Link
            className={buttonVariants({ size: "sm" })}
            data-testid="device-back-to-list"
            to="/settings/devices"
          >
            <IconArrowLeft />
            {"返回设备列表"}
          </Link>
          {onRetry ? (
            <button
              className={buttonVariants({ size: "sm", variant: "outline" })}
              onClick={onRetry}
              type="button"
            >
              {"重试"}
            </button>
          ) : null}
        </div>
      }
      description={message ?? "没有这台设备，可能已经被删除。"}
      title="无法读取这台设备"
    />
  );
}

/** 离线说明（O8）：被禁用的按钮用 aria-describedby 指向这里，屏幕阅读器和视觉用户都知道为什么点不了。 */
export function DeviceOfflineNote({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  return (
    <p
      className={cn("device-hero-s flex items-center gap-1", className)}
      data-testid="device-offline-note"
      id={id}
    >
      <IconPlugConnectedX className="size-4 shrink-0" />
      {"这台设备离线，测试连接、紧急停止和开启完全访问要等它重新连上才能用。"}
    </p>
  );
}
