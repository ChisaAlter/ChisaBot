import { IconCreditCard, IconDeviceDesktop, IconDots, IconLock, IconSend2, IconTrash } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  CONFIRM_CATEGORIES,
  CONFIRM_CATEGORY_INFO,
  CONFIRM_MODE_LABEL,
  type ConfirmCategory,
  type ConfirmMode,
  type ConfirmPrefView,
} from "../../../../../shared/confirmations";
import { PageEmpty, PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { BotPermissionsAbout, BotPermissionsSection } from "@/components/settings/bot-permissions";
import { ConfirmRow } from "@/components/approvals/confirm-row";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, ErrorCard, ListRow } from "@/components/ui/skyglass";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  addConfirmRule,
  confirmKeys,
  confirmPrefsQueryOptions,
  deleteConfirmRule,
  recentConfirmationsQueryOptions,
  setConfirmPref,
} from "@/lib/confirmations";
import { agoText } from "@/lib/im";

export const Route = createFileRoute("/_authed/settings/approvals")({
  component: ApprovalPrefsPage,
});

const ICON: Record<ConfirmCategory, typeof IconSend2> = {
  message: IconSend2,
  delete: IconTrash,
  purchase: IconCreditCard,
  device: IconDeviceDesktop,
};

const CATEGORY_ITEMS = Object.fromEntries(CONFIRM_CATEGORIES.map((c) => [c, CONFIRM_CATEGORY_INFO[c].label])) as Record<ConfirmCategory, string>;
const MODE_ITEMS = CONFIRM_MODE_LABEL;

/**
 * 设置 → 机器人 → 权限与审批（DESIGN.md §58 + §97）：每个机器人的权限（请求批准 / 完全访问）；哪些事先问我、哪些直接做；用自己的话写的规则；最近的确认记录。
 * 机器人每轮都读这里，用户在聊天里说「以后 X 不用问我」时机器人也会写进来。
 */
function ApprovalPrefsPage() {
  const queryClient = useQueryClient();
  const data = useQuery(confirmPrefsQueryOptions());
  const recent = useQuery(recentConfirmationsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const botName = useMemo(() => new Map((bots.data ?? []).map((bot) => [bot.id, bot.name])), [bots.data]);
  const [hiddenRule, setHiddenRule] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: confirmKeys.all });

  async function removeRule(id: string, text: string) {
    const ok = await confirmDialog({ title: "删除这条规则？", description: `「${text}」删除后，机器人按这一类的偏好处理。`, confirmLabel: "删除", destructive: true });
    if (!ok) return;
    setHiddenRule(id);
    try {
      await deleteConfirmRule(id);
      await refresh();
      toast.success("已删除规则");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setHiddenRule(null);
    }
  }

  const rules = (data.data?.rules ?? []).filter((rule) => rule.id !== hiddenRule);
  return (
    <PageShell
      description="机器人做有后果的事之前——对外发消息、删除东西、付款购买、操作你的电脑——按这里决定先问你还是直接做。问的时候聊天里会出一张确认卡片，点「确认」它才继续；若通过微信 / QQ / 飞书 / Telegram 对话，也可直接回复「允许」或「拒绝」远程审批。你在聊天里说「以后 X 不用问我」，机器人也会记到这里。"
      title="权限与审批"
    >
      <BotPermissionsSection />
      {data.isPending ? (
        <PageSkeleton rows={4} />
      ) : data.isError ? (
        <ErrorCard
          action={
            <Button className="mt-2" onClick={() => void data.refetch()} size="sm" variant="outline">
              {"重试"}
            </Button>
          }
          description={data.error.message}
          title="审批偏好暂时无法读取"
        />
      ) : (
        <>
          <PageSection description="所有机器人共用。单独设过权限的机器人，「操作你的电脑」按它自己的权限来。" settingItem="permissions.confirm-prefs" title="哪些事先问我">
            <Card className="mem-card">
              {(data.data?.prefs ?? []).map((pref) => (
                <PrefRow key={pref.category} pref={pref} onSaved={refresh} />
              ))}
            </Card>
          </PageSection>

          <PageSection settingItem="permissions.confirm-rules" title={rules.length ? `你的规则 · ${rules.length}` : "你的规则"}>
            <Card className="mem-card">
              <RuleForm onAdded={refresh} />
              {rules.map((rule) => (
                <div className="im-row ap-row" data-testid="confirm-rule" key={rule.id}>
                  <div className="im-row-main">
                    <ListRow
                      icon={
                        <span className="ap-ico" data-category={rule.category}>
                          {(() => {
                            const Icon = ICON[rule.category];
                            return <Icon className="size-5" />;
                          })()}
                        </span>
                      }
                      sub={
                        <>
                          <span className="device-row-meta">
                            <span className="ap-chip" data-mode={rule.mode}>
                              {CONFIRM_MODE_LABEL[rule.mode]}
                            </span>
                            <span className="ap-chip">{CONFIRM_CATEGORY_INFO[rule.category].label}</span>
                            {rule.keywords.length ? <span className="device-cap-chip"><T>{`涉及 ${rule.keywords.join("、")}`}</T></span> : null}
                          </span>
                          <span className="mem-by">
                            {`${rule.source === "bot" ? `${botName.get(rule.agentId ?? "") ?? "机器人"}记下的` : "你写的"} · ${agoText(rule.createdAt)}`}
                          </span>
                        </>
                      }
                      title={`「${rule.text}」`}
                    />
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<button aria-label="这条规则的更多操作" className="device-row-more" title={"更多操作"} type="button" />}>
                      <IconDots className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="glass-pop w-[160px] p-1.5">
                      <DropdownMenuItem className="glass-mi is-danger" onClick={() => void removeRule(rule.id, rule.text)}>
                        <IconTrash className="size-[18px] shrink-0 opacity-80" />
                        <span className="min-w-0 flex-1">{"删除…"}</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </Card>
          </PageSection>

          <PageSection settingItem="permissions.confirm-recent" title="最近的确认">
            {recent.isPending ? (
              <PageSkeleton rows={2} />
            ) : (recent.data ?? []).length ? (
              <Card className="mem-card">
                {(recent.data ?? []).map((request) => (
                  <ConfirmRow botName={botName.get(request.agentId) ?? "机器人"} key={request.id} onDecided={refresh} request={request} />
                ))}
              </Card>
            ) : (
              <PageEmpty>{"还没有确认过什么。机器人要做有后果的事时，卡片会出现在聊天里，也会记在这里。"}</PageEmpty>
            )}
          </PageSection>
        </>
      )}
      <BotPermissionsAbout />
    </PageShell>
  );
}

function PrefRow({ pref, onSaved }: { pref: ConfirmPrefView; onSaved: () => Promise<unknown> }) {
  const [optimistic, setOptimistic] = useState<ConfirmMode | null>(null);
  const mode = optimistic ?? pref.mode;
  const Icon = ICON[pref.category];
  async function choose(next: ConfirmMode) {
    if (next === mode || pref.locked) return;
    setOptimistic(next);
    try {
      await setConfirmPref(pref.category, next, null);
      await onSaved();
      toast.success(`「${pref.label}」改成${CONFIRM_MODE_LABEL[next]}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setOptimistic(null);
    }
  }
  return (
    <div className="im-row ap-row ap-pref" data-category={pref.category} data-testid="confirm-pref">
      <div className="im-row-main">
        <ListRow
          icon={
            <span className="ap-ico" data-category={pref.category}>
              <Icon className="size-5" />
            </span>
          }
          sub={
            <>
              <span>{pref.description}</span>
              {pref.locked ? (
                <span className="ap-quote">
                  <IconLock className="mr-1 inline size-3 align-[-1px]" />
                  {"付款一律先问你，这是安全底线，不能关。"}
                </span>
              ) : pref.note ? (
                <span className="ap-quote">{`你说过：「${pref.note}」`}</span>
              ) : null}
            </>
          }
          title={pref.label}
        />
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了 */}
      <div aria-label={`${pref.label}：先问我还是直接做`} className="ap-seg" role="group">
        {(["ask", "auto"] as const).map((value) => (
          <button
            aria-pressed={mode === value}
            data-testid={`pref-${pref.category}-${value}`}
            disabled={pref.locked && value === "auto"}
            key={value}
            onClick={() => void choose(value)}
            title={pref.locked && value === "auto" ? "付款一律先问你" : undefined}
            type="button"
          >
            <T>{CONFIRM_MODE_LABEL[value]}</T>
          </button>
        ))}
      </div>
    </div>
  );
}

function RuleForm({ onAdded }: { onAdded: () => Promise<unknown> }) {
  const [text, setText] = useState("");
  const [category, setCategory] = useState<ConfirmCategory>("message");
  const [mode, setMode] = useState<ConfirmMode>("auto");
  const [keywords, setKeywords] = useState("");
  const words = keywords
    .split(/[\s,，、]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  const blocked = category === "purchase" && mode === "auto";
  const add = useAsyncAction(
    async () => {
      await addConfirmRule({ text: text.trim(), category, mode, ...(words.length ? { keywords: words } : {}) });
      setText("");
      setKeywords("");
      await onAdded();
    },
    { errorToast: (error) => error.message },
  );
  const valid = text.trim().length > 0 && !blocked;
  return (
    <form
      className="ap-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && add.state !== "pending") void add.run();
      }}
    >
      <Textarea
        aria-label="用你自己的话写一条规则"
        className="min-h-[64px]"
        data-testid="rule-text"
        maxLength={300}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (valid && add.state !== "pending") void add.run();
          }
        }}
        placeholder={"用你自己的话写，比如「给张三发微信不用问我」「删除下载文件夹里的东西不用问」"}
        value={text}
      />
      <div className="ap-form-row">
        <Select items={CATEGORY_ITEMS} onValueChange={(next) => next && setCategory(next as ConfirmCategory)} value={category}>
          <SelectTrigger aria-label="属于哪一类" className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONFIRM_CATEGORIES.map((value) => (
              <SelectItem key={value} value={value}>
                {CATEGORY_ITEMS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select items={MODE_ITEMS} onValueChange={(next) => next && setMode(next as ConfirmMode)} value={mode}>
          <SelectTrigger aria-label="先问我还是直接做" className="w-[112px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["ask", "auto"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {MODE_ITEMS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="涉及的人或东西（可选）"
          className="min-w-[160px] flex-1"
          data-testid="rule-keywords"
          maxLength={120}
          onChange={(event) => setKeywords(event.target.value)}
          placeholder={"涉及（可选）：张三、下载文件夹"}
          value={keywords}
        />
        <Button data-testid="rule-add" disabled={!valid} feedback="add" state={add.state} type="submit">
          {"添加"}
        </Button>
      </div>
      <span className="ap-quote">
        {blocked
          ? "付款购买一律先问你，不能设成直接做。"
          : words.length
            ? `执行时内容里同时出现「${words.join("」「")}」才按这条来；「先问我」的规则优先。`
            : "不填「涉及」= 整一类都按这条来（等于改上面这一类的偏好）。"}
      </span>
    </form>
  );
}
