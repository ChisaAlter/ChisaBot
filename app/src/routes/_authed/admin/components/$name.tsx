import { requireExtra } from "@/lib/deployment/extras";
import { RouteSkeleton } from "@/components/startup-status";
import {
  IconAlertTriangle,
  IconChevronRight,
  IconClock,
  IconCode,
  IconDatabase,
  IconFileText,
  IconTag,
  IconUsers,
  IconWorld,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { AdminComponentPreview } from "@/components/component-preview";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { SettingsItemBackground } from "@/components/settings/background";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  saveComponentDraftMutationOptions,
  setComponentFunctionMutationOptions,
  setComponentGrantMutationOptions,
  setComponentPublishedMutationOptions,
} from "@/lib/components/mutations";
import {
  type ComponentRecord,
  componentListQueryOptions,
  type DataFunctionSummary,
  dataFunctionsQueryOptions,
} from "@/lib/components/queries";
import { RENDERABLE_NAMES } from "@/lib/copilot/gallery-registry";
import { CopilotProvider } from "@/lib/copilot/provider";
import { queryClient } from "@/query-client";

/**
 * Governance for one compiled component: publication, per-Bot grants, the model-facing description,
 * and which data functions it may read.
 */
/** The same way back from every state this route can be in. */
const BACK = {
  label: "UI 组件",
  linkProps: { to: "/admin/components" },
} as const;

export const Route = createFileRoute("/_authed/admin/components/$name")({
  // 功能精简（DESIGN.md §74）：默认隐藏，CHISABOT_EXTRAS 含 components 才能进。
  beforeLoad: requireExtra("components"),
  // 组件预览里的工具卡片要 CopilotKit 上下文；它不再包整个应用，只包聊天主区（DESIGN.md §41.5），这里自己包一层。
  component: () => (
    <CopilotProvider>
      <RouteComponent />
    </CopilotProvider>
  ),
});

function RouteComponent() {
  const { name } = Route.useParams();
  const components = useQuery(componentListQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const dataFunctions = useQuery(dataFunctionsQueryOptions());

  const setGrant = useMutation(setComponentGrantMutationOptions(queryClient));
  const setFunction = useMutation(
    setComponentFunctionMutationOptions(queryClient),
  );
  const setPublished = useMutation(
    setComponentPublishedMutationOptions(queryClient),
  );
  const saveDraft = useMutation(saveComponentDraftMutationOptions(queryClient));

  /*
   * Read out of the list rather than held in state, so a change made here is reflected here.
   */
  const component = components.data?.find((entry) => entry.name === name);

  /*
   * Pending first and drawing nothing: there is no loading placeholder in this app, and the
   * alternative here is worse than a blank — "no such component" while the list is still in flight
   * says something false about a component that is about to appear.
   */
  if (components.isPending) return <RouteSkeleton />;

  if (components.error) {
    return (
      <PageShell backButton={BACK} title={"组件"}>
        <p className="mt-8 text-destructive text-sm" role="alert">
          {"无法加载组件。"}
        </p>
      </PageShell>
    );
  }

  if (!component) {
    /*
     * A name in the URL is a claim, not a promise: it can be stale, mistyped, or a component this
     * build no longer ships.
     */
    return (
      <PageShell
        backButton={BACK}
        description={"此处没有匹配该名称的"}
        title={"不存在此组件"}
      >
        <Empty className="mt-12 min-h-[30dvh] border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{name}</EmptyTitle>
            <EmptyDescription className="text-pretty">
              {"它可能已被重命名，或者此部署可能不再包含它。"}
            </EmptyDescription>
          </EmptyHeader>
          <Button
            render={<Link to="/admin/components" />}
            size="sm"
            variant="outline"
          >
            {"返回组件"}
          </Button>
        </Empty>
      </PageShell>
    );
  }

  return (
    /*
     * Keyed on the name so the draft is seeded from the component actually being looked at. The
     * route component is reused when only the parameter changes, so without it the text held from
     * the last one opened would be what a save wrote back.
     */
    <ComponentDetail
      bots={agents.data ?? []}
      component={component}
      dataFunctions={dataFunctions.data ?? []}
      key={component.name}
      onPublish={(published) => setPublished.mutate({ name, published })}
      onSaveDraft={(description) => saveDraft.mutate({ description, name })}
      onSetFunction={(functionName, granted) =>
        setFunction.mutate({ functionName, granted, name })
      }
      onSetGrant={(agentId, granted) =>
        setGrant.mutate({ agentId, granted, name })
      }
    />
  );
}

/** Which sub-dialog is open, if any. */
type Sheet = "description" | "grants" | "functions" | null;

/**
 * A row that states something and cannot be changed. No chevron, because there is nothing behind it.
 */
function FactRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
      </ItemContent>
      <ItemActions className="text-muted-foreground text-sm">
        {children}
      </ItemActions>
    </Item>
  );
}

/**
 * A row whose detail is a dialog. The whole row is the button, as it is in the settings screens this
 * follows — a chevron on the right announces where it goes, but it is not the only thing you can hit.
 */
function SheetRow({
  icon,
  label,
  summary,
  onOpen,
  testId,
}: {
  icon: ReactNode;
  label: string;
  summary: string;
  onOpen: () => void;
  testId: string;
}) {
  return (
    <Item
      className="w-full text-left transition-colors hover:bg-muted/50"
      /*
       * No children on the render element. `useRender` merges props, and children given here would
       * replace the row's own — which is how this first drew as three empty rows. The button takes
       * its accessible name from the title and summary inside instead.
       */
      render={<button data-testid={testId} onClick={onOpen} type="button" />}
      size="sm"
    >
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        <ItemDescription>{summary}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/**
 * One component in full: what it is, what it looks like, what the model is told about it, and who
 * may use it.
 *
 * Settings-screen shape rather than a form. Each row states where something stands and, if it can be
 * changed, opens a dialog to change it; nothing is saved by a button at the bottom of the page,
 * because there is no page-level state to save. Publication and the grants take effect as they are
 * switched, and the description is the one thing held while it is being typed — which is why it is
 * the only dialog with a Cancel.
 */
function ComponentDetail({
  component,
  bots,
  dataFunctions,
  onSetGrant,
  onSetFunction,
  onPublish,
  onSaveDraft,
}: {
  component: ComponentRecord;
  bots: { id: string; name: string }[];
  dataFunctions: DataFunctionSummary[];
  onSetGrant: (agentId: string, granted: boolean) => void;
  onSetFunction: (functionName: string, granted: boolean) => void;
  onPublish: (published: boolean) => void;
  onSaveDraft: (description: string) => void;
}) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const [draft, setDraft] = useState(component.draftDescription);
  const withheld = new Set(component.withheldFrom);
  const heldFunctions = new Set(component.functions);
  const renderable =
    RENDERABLE_NAMES.has(component.name) || component.kind === "sandboxed";

  const granted = bots.filter((bot) => !withheld.has(bot.id));
  const held = dataFunctions.filter((fn) => heldFunctions.has(fn.name));

  const grantSummary =
    bots.length === 0
      ? "还没有机器人"
      : granted.length === bots.length
        ? `All ${bots.length} Bots`
        : granted.length === 0
          ? "没有机器人"
          : `${granted.length} of ${bots.length} Bots`;

  const functionSummary =
    dataFunctions.length === 0
      ? "This deployment grants no data functions"
      : held.length === 0
        ? "Nothing — it draws only what the model hands it"
        : held.map((fn) => fn.name).join(", ");

  return (
    <PageShell
      backButton={BACK}
      description={
        component.publishedDescription ??
        "未发布任何内容，因此未告知机器人此信息。"
      }
      title={component.title}
    >
      {/*
       * The render at the top of the page. Bordered and rounded rather than bleeding to the edges:
       * inside a prose column that is what the tiles do, and a page has no dialog edge to reach for.
       */}
      <div className="relative mt-8 aspect-[2/1] overflow-hidden rounded-lg border border-border bg-card">
        <div className="absolute inset-0">
          <SettingsItemBackground className="h-full w-full" />
        </div>
        <div className="absolute inset-0 z-10">
          <AdminComponentPreview kind={component.kind} name={component.name} />
        </div>
      </div>

      <PageSection
        description={"这个组件是做什么的，以及哪些机器人被允许使用它回答。"}
        title={"配置"}
      >
        <PageRows>
          {/*
           * First, and only when it applies: a component this build cannot draw is a fact that
           * outranks everything under it, because none of it can have any effect.
           */}
          {renderable ? null : (
            <>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconAlertTriangle className="text-amber-600 dark:text-amber-400" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{"此构建中不存在"}</ItemTitle>
                  <ItemDescription>
                    {"此处无法绘制它，无论其他设置如何。"}
                  </ItemDescription>
                </ItemContent>
              </Item>
              <Separator />
            </>
          )}

          <Item size="sm">
            <ItemMedia variant="icon">
              <IconWorld />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{"已发布"}</ItemTitle>
              <ItemDescription>
                {component.published
                  ? "机器人可能用它回答。"
                  : "机器人不得使用它。"}
                {component.hasUnpublishedChanges
                  ? "描述有未发布的更改。"
                  : null}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={"已发布"}
                checked={component.published}
                data-testid={`publish-${component.name}`}
                onCheckedChange={onPublish}
              />
            </ItemActions>
          </Item>

          <Separator />

          <SheetRow
            icon={<IconFileText />}
            label={"描述"}
            onOpen={() => setSheet("description")}
            summary={component.draftDescription || "暂无"}
            testId={`description-${component.name}`}
          />

          <Separator />

          <SheetRow
            icon={<IconUsers />}
            label={"可用于"}
            onOpen={() => setSheet("grants")}
            summary={grantSummary}
            testId={`grants-${component.name}`}
          />

          <Separator />

          <SheetRow
            icon={<IconDatabase />}
            label={"可读取"}
            onOpen={() => setSheet("functions")}
            summary={functionSummary}
            testId={`functions-${component.name}`}
          />
        </PageRows>
      </PageSection>

      <PageSection title={"详情"}>
        <PageRows>
          <FactRow icon={<IconTag />} label={"类型"}>
            {component.kind}
          </FactRow>
          <Separator />
          <FactRow icon={<IconCode />} label={"称为"}>
            <code className="rounded bg-foreground/5 px-1.5 py-0.5 text-xs">
              {component.name}
            </code>
          </FactRow>
          <Separator />
          <FactRow icon={<IconClock />} label={"最后修改"}>
            {new Date(component.updatedAt).toLocaleString("zh-CN")}
            {component.updatedBy ? `由 ${component.updatedBy}` : null}
          </FactRow>
        </PageRows>
      </PageSection>

      {/*
       * The one dialog holding state of its own, so the one with something to discard. The draft is
       * reset on close either way, so reopening reads what is actually stored rather than what was
       * abandoned.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setSheet(null);
            setDraft(component.draftDescription);
          }
        }}
        open={sheet === "description"}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{"描述"}</DialogTitle>
            <DialogDescription>
              {"模型在决定调用此操作时读取什么。直到组件发布前它什么都不改变。"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <Textarea
              aria-label={"描述"}
              onChange={(event) => setDraft(event.target.value)}
              rows={6}
              value={draft}
            />
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => {
                setSheet(null);
                setDraft(component.draftDescription);
              }}
              size="sm"
              variant="ghost"
            >
              {"取消"}
            </Button>
            <Button
              onClick={() => {
                onSaveDraft(draft);
                setSheet(null);
              }}
              size="sm"
            >
              {"保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Grants take effect as they are switched, so there is nothing here to save or to discard. */}
      <Dialog
        onOpenChange={(open) => !open && setSheet(null)}
        open={sheet === "grants"}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{"可用于"}</DialogTitle>
            <DialogDescription>
              {
                "关闭 Bot 后，它永远不会被告知此组件存在，因此无法请求它，也不会为没有它而道歉。每次更改立即生效。"
              }
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {bots.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {"还没有机器人。"}
              </p>
            ) : (
              <div className="flex flex-col">
                {bots.map((bot, index) => {
                  const has = !withheld.has(bot.id);
                  return (
                    <div key={bot.id}>
                      {index === 0 ? null : <Separator />}
                      <Item size="sm">
                        <ItemContent>
                          <ItemTitle>{bot.name}</ItemTitle>
                        </ItemContent>
                        <ItemActions>
                          <Switch
                            aria-label={bot.name}
                            checked={has}
                            data-testid={`grant-${component.name}-${bot.id}`}
                            onCheckedChange={(next) => onSetGrant(bot.id, next)}
                          />
                        </ItemActions>
                      </Item>
                    </div>
                  );
                })}
              </div>
            )}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setSheet(null)} size="sm">
              {"完成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => !open && setSheet(null)}
        open={sheet === "functions"}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{"可读取"}</DialogTitle>
            <DialogDescription>
              {
                "单独的授权，与 Available 不同且不隐含：它决定谁可以提取此项，以及此项决定它可以去取什么来提取自己。直到其中一个开启，它只显示机器人传递的，直到它做的每次读取都是审计中的一行。每次更改立即生效。"
              }
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {dataFunctions.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {"此部署不授予任何数据功能。"}
              </p>
            ) : (
              <div className="flex flex-col">
                {dataFunctions.map((fn, index) => {
                  const has = heldFunctions.has(fn.name);
                  return (
                    <div key={fn.name}>
                      {index === 0 ? null : <Separator />}
                      <Item size="sm">
                        <ItemContent>
                          <ItemTitle>{fn.name}</ItemTitle>
                          <ItemDescription>{fn.description}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Switch
                            aria-label={fn.name}
                            checked={has}
                            data-testid={`function-${component.name}-${fn.name}`}
                            onCheckedChange={(next) =>
                              onSetFunction(fn.name, next)
                            }
                          />
                        </ItemActions>
                      </Item>
                    </div>
                  );
                })}
              </div>
            )}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setSheet(null)} size="sm">
              {"完成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
