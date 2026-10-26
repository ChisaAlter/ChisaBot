import { Link, useRouterState } from "@tanstack/react-router";
import { IconCompass } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * 这个地址在这个版本里不存在。
 *
 * 以前根路由的 `notFoundComponent` 是 `<Navigate replace to="/" />`：打错的地址先跳回 `/`，而 `/`
 * 又会按「上次停在哪」把人送进当时的另一个页签（已移除的 Claude Code，CB-099）。于是一个 `…/settings/models` 打错，人只会看到自己莫名其妙
 * 进了另一个页签——像应用在乱跳，也没法知道「我刚才那个页面没了」，更不知道该怎么办（2026-10-20 审查）。
 *
 * 现在是一个真正的 404：把找不到的地址写出来，给两条确定能回去的路。它不再猜你想去哪，也不改写地址栏，
 * 所以刷新、复制链接、按后退都还是原来那个地址。
 */
export function NotFoundRoute() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  return <NotFoundPage path={path} />;
}

export function NotFoundPage({ path }: { path?: string }) {
  return (
    <main className="flex min-h-dvh w-full items-center justify-center p-6">
      <Empty className="max-w-md border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconCompass className="size-4" />
          </EmptyMedia>
          <EmptyTitle>页面不存在</EmptyTitle>
          <EmptyDescription>
            {path ? (
              <code className="mr-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                {path}
              </code>
            ) : null}
            {"这个地址在这个版本里没有。可能是链接过期了，或者地址里打错了一个字符。"}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {/*
           * 真链接，不是 `<Button render={<Link/>}>`：那会把角色的名字报成「按钮」，而这里的两条出路都是
           * 导航。样式仍然用按钮那套（`buttonVariants` + `.btn-t` 的字形裁切），键盘和读屏听到的是链接。
           */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link className={buttonVariants()} to="/">
              <span className="btn-t">{"回到聊天"}</span>
            </Link>
            <Link className={buttonVariants({ variant: "outline" })} to="/settings">
              <span className="btn-t">{"打开设置"}</span>
            </Link>
          </div>
        </EmptyContent>
      </Empty>
    </main>
  );
}
