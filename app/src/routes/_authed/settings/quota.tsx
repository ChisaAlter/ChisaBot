import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { UsageBreakdownCard } from "@/components/settings/harness-and-observation";
import { MyQuotaSection } from "@/components/settings/my-quota-section";
import { UsageAnalyticsCard } from "@/components/settings/usage-analytics-card";

export const Route = createFileRoute("/_authed/settings/quota")({
  component: QuotaPage,
});

/** 设置 → 配额与用量：当前账号的模型 Token / 请求消耗与按本地时区/用途/思考 Token 拆分的只读页。 */
function QuotaPage() {
  return (
    <PageShell
      description="你的账号今日与本月的模型 Token、请求次数消耗，以及按本地时区、用途和思考预算拆分的用量账本。"
      title="配额与用量"
    >
      <div className="space-y-8">
        <MyQuotaSection />
        <UsageBreakdownCard />
        <UsageAnalyticsCard />
      </div>
    </PageShell>
  );
}
