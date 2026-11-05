import {
  IconChevronRight,
  IconDeviceDesktop,
  IconExternalLink,
  IconMessageReply,
  IconPlug,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { sendPromptToChat } from "@/lib/chat/quote-event";
import {
  type DirectoryItem,
  pluginsDirectoryQueryOptions,
} from "@/lib/plugins/queries";

/**
 * 国内应用目录 — the whole awesome-china-mcp index, browsed rather than listed.
 *
 * Two lists on the previous screen are reviewed decisions; this one is the rest of
 * the story: every service a person might ask for, with the honest route to it.
 * Search filters locally — the payload is one static read, not a request per key.
 */
export const Route = createFileRoute("/_authed/admin/plugins/directory")({
  component: RouteComponent,
});

const CATEGORY_LABELS: Record<string, string> = {
  cloud: "云服务与基础设施",
  "maps-travel": "地图与出行",
  payments: "支付",
  "content-social": "内容与社交",
  ecommerce: "电商",
  "local-life": "生活服务",
  office: "办公协作",
  devtools: "开发工具",
  finance: "金融与数据",
  legal: "法律",
  academic: "学术",
  weather: "天气",
  music: "音乐",
  iot: "智能家居 / IoT",
  "llm-ai": "大模型与 AI 服务",
  utilities: "实用工具",
  "skills-apis": "官方 Skills 与 API（非 MCP）",
  platforms: "托管统一平台",
  hubs: "资源站与客户端",
};
/** File order is the README's own official-first order; the labels carry the zh name. */
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

/** Lower-cased and punctuation-free, so「高德地图」hits `amap` and `gaode` alike. */
function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\-_/\\，。,.!?！？:：；;、()（）[\]【】"']+/g, "");
}

function matches(entry: DirectoryItem, query: string): boolean {
  if (!query) return true;
  const haystack = normalized(
    `${entry.key} ${entry.title} ${entry.vendor} ${entry.summary} ${entry.docsUrl}`,
  );
  return normalized(query)
    .split(/(?=[\u4e00-\u9fff])/)
    .every((piece) => piece === "" || haystack.includes(piece));
}

/** The pathway kind as the two words an administrator scans for. */
function kindLabel(entry: DirectoryItem): string {
  if (entry.catalogueKey) return "已收录";
  switch (entry.connect.kind) {
    case "remote":
      return "remote 端点";
    case "stdio":
      return "stdio 包";
    case "link":
      return "暂无 MCP";
  }
}

/** What the prompt to hand a Bot says, for the paired-PC stdio pathway. */
function devicePrompt(entry: DirectoryItem): string {
  const connect = entry.connect;
  const command =
    connect.kind === "stdio" && connect.command
      ? `：${connect.command}`
      : "（启动命令按仓库 README，通常是 npx 或 uvx）";
  const env =
    connect.kind === "stdio" && connect.env?.length
      ? `，需要环境变量 ${connect.env.join("、")}`
      : "";
  const repo =
    connect.kind === "stdio" && connect.repoUrl
      ? ` 仓库：${connect.repoUrl}`
      : "";
  return `请使用 device_mcp_call 在我已配对的电脑上启动「${entry.title}」的本地 stdio MCP 服务${command}${env}，先 list_tools 列出它的工具，再告诉我怎么用。${repo}`;
}

function RouteComponent() {
  const navigate = useNavigate();
  const directory = useQuery(pluginsDirectoryQueryOptions());
  const [search, setSearch] = React.useState("");
  const [detail, setDetail] = React.useState<DirectoryItem | null>(null);

  const entries = directory.data?.entries ?? [];
  const filtered = entries.filter((entry) => matches(entry, search));

  return (
    <>
      <ConnectDialog
        entry={detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
        onDevicePrompt={(entry) =>
          sendPromptToChat(navigate, devicePrompt(entry), `接入 ${entry.title}`)
        }
      />
      <PageShell
        backButton={{ label: "插件", linkProps: { to: "/admin/plugins" } }}
        description={
          "国内服务的接入目录（官方优先，来自 awesome-china-mcp，未逐个审查）。已收录的可一键添加；stdio 包在已配对电脑上由机器人拉起；暂无 MCP 的给官方 API 文档。"
        }
        title={"国内应用目录"}
      >
        <PageSection
          description={
            "按名称搜索，或按类别浏览。点开「接入方式」看这条服务怎么连。"
          }
          title={"目录"}
        >
          <Input
            aria-label={"搜索国内服务"}
            className="mt-4"
            onChange={(event) => setSearch(event.target.value)}
            placeholder={"例如：高德、滴滴、12306、小红书、飞书"}
            value={search}
          />

          {directory.isPending ? (
            <PageSkeleton />
          ) : directory.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {directory.error.message || "国内应用目录无法加载。"}
            </p>
          ) : filtered.length === 0 ? (
            <PageEmpty>
              {`目录中没有匹配「${search}」的服务。也可以让机器人联网查官方接法——对它说「连 ${search}」即可。`}
            </PageEmpty>
          ) : (
            CATEGORY_ORDER.map((category) => {
              const rows = filtered.filter(
                (entry) => entry.category === category,
              );
              if (rows.length === 0) return null;
              return (
                <React.Fragment key={category}>
                  <h3 className="mt-8 mb-2 font-medium text-muted-foreground text-sm">
                    {CATEGORY_LABELS[category] ?? category}
                  </h3>
                  <PageRows>
                    {rows.map((entry, index) => {
                      const action = entry.catalogueKey ? (
                        <Item
                          data-testid={`directory-${entry.key}`}
                          render={
                            <Link
                              params={{ key: entry.catalogueKey }}
                              to="/admin/plugins/$key"
                            />
                          }
                          size="sm"
                        >
                          <RowMark>
                            <IconPlug className="size-4" />
                          </RowMark>
                          <ItemContent>
                            <ItemTitle>
                              {entry.title}
                              <BadgeText official={entry.official} />
                            </ItemTitle>
                            <ItemDescription>{entry.summary}</ItemDescription>
                          </ItemContent>
                          <ItemActions>
                            <span className="text-muted-foreground text-xs">
                              {"已收录 · 去添加"}
                            </span>
                            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                          </ItemActions>
                        </Item>
                      ) : (
                        <Item data-testid={`directory-${entry.key}`} size="sm">
                          <RowMark>
                            {entry.connect.kind === "stdio" ? (
                              <IconDeviceDesktop className="size-4" />
                            ) : (
                              <IconPlug className="size-4" />
                            )}
                          </RowMark>
                          <ItemContent>
                            <ItemTitle>
                              {entry.title}
                              <BadgeText official={entry.official} />
                            </ItemTitle>
                            <ItemDescription>{entry.summary}</ItemDescription>
                          </ItemContent>
                          <ItemActions>
                            <span className="text-muted-foreground text-xs">
                              {kindLabel(entry)}
                            </span>
                            <Button
                              onClick={() => setDetail(entry)}
                              size="sm"
                              variant="outline"
                            >
                              {"接入方式"}
                            </Button>
                          </ItemActions>
                        </Item>
                      );
                      return (
                        <React.Fragment key={entry.key}>
                          {action}
                          {index !== rows.length - 1 && <Separator />}
                        </React.Fragment>
                      );
                    })}
                  </PageRows>
                </React.Fragment>
              );
            })
          )}
        </PageSection>
      </PageShell>
    </>
  );
}

/** 「官方 / 社区」放在标题后面的小字，比列宽对齐的徽章省一行。 */
function BadgeText({ official }: { official: boolean }) {
  return (
    <span className="ml-2 font-normal text-muted-foreground text-xs">
      {official ? "官方" : "社区"}
    </span>
  );
}

function ConnectDialog({
  entry,
  onOpenChange,
  onDevicePrompt,
}: {
  entry: DirectoryItem | null;
  onOpenChange: (open: boolean) => void;
  onDevicePrompt: (entry: DirectoryItem) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={entry !== null}>
      <DialogContent
        className="im-dialog max-w-lg"
        data-testid="directory-connect-dialog"
      >
        {entry ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {entry.title}
                <BadgeText official={entry.official} />
              </DialogTitle>
              <DialogDescription>{`${entry.vendor} · ${entry.summary}`}</DialogDescription>
            </DialogHeader>
            <DialogBody className="im-form mt-2">
              <ol className="list-decimal space-y-2 pl-4 text-sm">
                {entry.pathway.map((line, index) => (
                  <li key={index} className="whitespace-pre-wrap">
                    {line}
                  </li>
                ))}
              </ol>
              {entry.connect.kind === "remote" ? (
                <div className="mt-3">
                  <p className="mb-1 text-muted-foreground text-xs">{"端点"}</p>
                  <code className="block overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
                    {entry.connect.url}
                  </code>
                </div>
              ) : null}
              {entry.connect.kind === "stdio" && entry.connect.command ? (
                <div className="mt-3">
                  <p className="mb-1 text-muted-foreground text-xs">
                    {"启动命令"}
                  </p>
                  <code className="block overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
                    {entry.connect.command}
                  </code>
                </div>
              ) : null}
              {entry.note ? (
                <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700 text-xs dark:text-amber-300">
                  {`⚠️ ${entry.note}`}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter className="mt-4">
              <Button
                render={
                  <a href={entry.docsUrl} rel="noreferrer" target="_blank" />
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                <IconExternalLink className="size-3.5" />
                {"官方文档"}
              </Button>
              {entry.catalogueKey ? (
                <Button
                  render={
                    <Link
                      params={{ key: entry.catalogueKey }}
                      to="/admin/plugins/$key"
                    />
                  }
                  size="sm"
                  type="button"
                >
                  {"去添加"}
                </Button>
              ) : entry.connect.kind === "stdio" ? (
                <Button
                  onClick={() => onDevicePrompt(entry)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <IconMessageReply className="size-3.5" />
                  {"去对话调用"}
                </Button>
              ) : entry.connect.kind === "remote" ? (
                <Button
                  render={<Link to="/admin/plugins" />}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {"去插件页添加"}
                </Button>
              ) : null}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
