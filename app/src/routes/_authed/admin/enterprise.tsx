import { IconArrowLeft } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { AdaptiveRoutingPanel } from "@/components/settings/adaptive-routing-panel";
import { HarnessAndObservationPanel } from "@/components/settings/harness-and-observation";
import { PromptWorkbench } from "@/components/settings/prompt-workbench";
import { ScenarioRoutingPanel } from "@/components/settings/scenario-routing-panel";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authed/admin/enterprise")({
  component: WhiteboxWorkbenchPage,
});

/**
 * 管理后台 → 白盒调优工作台（挂载于已有路由 `/admin/enterprise`，避免 routeTree.gen.ts 生成漂移）。
 * 集中提供自适应难度路由与思考预算、7 角色提示词版本化工作台、Harness 7 项热开关、脱敏模型观测器与本地时区细分用量。
 */
function WhiteboxWorkbenchPage() {
  return (
    <PageShell
      action={
        <Button
          nativeButton={false}
          render={<Link to="/admin/models" />}
          size="sm"
          variant="outline"
        >
          <IconArrowLeft className="size-4" />
          {"返回模型设置"}
        </Button>
      }
      description="白盒化调优 AI 推理路由、思考强度、多角色系统提示词版本、内置高影响能力开关与脱敏观测记录。"
      title="白盒调优工作台"
    >
      <div className="space-y-10" data-testid="whitebox-workbench-page">
        <AdaptiveRoutingPanel />
        <ScenarioRoutingPanel />
        <PromptWorkbench />
        <HarnessAndObservationPanel />
      </div>
    </PageShell>
  );
}
