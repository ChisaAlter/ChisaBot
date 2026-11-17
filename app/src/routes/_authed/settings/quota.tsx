import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { MyQuotaSection } from "@/components/settings/my-quota-section";

export const Route = createFileRoute("/_authed/settings/quota")({
  component: QuotaPage,
});

/** 设置 → 配额与用量：当前账号的模型 Token / 请求消耗只读页（上限由管理员在配额管理里配置）。 */
function QuotaPage() {
  return (
    <PageShell
      description="你的账号今日与本月的模型 Token、请求次数消耗。配额上限由管理员统一配置，这里只读展示。"
      title="配额与用量"
    >
      <MyQuotaSection />
    </PageShell>
  );
}
