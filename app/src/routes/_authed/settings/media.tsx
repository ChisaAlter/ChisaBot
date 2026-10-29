import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { ImagePersonalCard, VisionPersonalCard } from "@/components/settings/media-models";
import { Button } from "@/components/ui/button";
import { ErrorCard } from "@/components/ui/skyglass";
import { mediaPersonalQueryOptions } from "@/lib/media-models";

export const Route = createFileRoute("/_authed/settings/media")({
  component: MediaPersonalPage,
});

/**
 * 设置 → 生图与识图（DESIGN.md §59）：自己的生图模型、识图模型。不设就用管理员在 设置 → 模型 里的默认。
 * 密钥加密保存，保存后只显示末四位，不会进机器人的上下文。
 */
function MediaPersonalPage() {
  const media = useQuery(mediaPersonalQueryOptions());
  return (
    <PageShell description="你的机器人画图、看图用的模型。不设就用管理员给所有人的默认；设了只对你自己的机器人生效。密钥加密保存，保存后只显示末四位。" title="生图与识图">
      {media.isPending ? (
        <PageSkeleton rows={4} />
      ) : media.error || !media.data ? (
        <ErrorCard action={<Button onClick={() => media.refetch()} variant="outline">{"重试"}</Button>} title={media.error?.message ?? "无法加载生图 / 识图设置"} />
      ) : (
        <>
          <div className="media-anchor" id="image-model">
            <PageSection description="机器人画图、改图用的模型。" settingItem="media.my-image-model" title="生图模型">
              <ImagePersonalCard current={media.data.image} defaults={media.data.defaults} />
            </PageSection>
          </div>
          <div className="media-anchor" id="vision-model">
            <PageSection description="聊天里上传的图片怎么让机器人看懂。" settingItem="media.my-vision-model" title="识图模型">
              <VisionPersonalCard current={media.data.vision} defaults={media.data.defaults} />
            </PageSection>
          </div>
          {media.data.privateUrlsAllowed ? null : <p className="im-field-h">{"个人设置只能填公网接口地址。"}</p>}
        </>
      )}
    </PageShell>
  );
}
