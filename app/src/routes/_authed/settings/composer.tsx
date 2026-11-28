import {
  IconArrowDown,
  IconArrowUp,
  IconBulb,
  IconKeyboard,
  IconPlus,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
  PageSkeleton,
} from "@/components/layout/page-shell";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  clearComposerHabitsMutationOptions,
  createQuickPhraseMutationOptions,
  deleteQuickPhraseMutationOptions,
  reorderQuickPhrasesMutationOptions,
  updateComposerSettingsMutationOptions,
  updateQuickPhraseMutationOptions,
} from "@/lib/composer/mutations";
import {
  composerSettingsQueryOptions,
  type QuickPhrase,
  quickPhrasesQueryOptions,
} from "@/lib/composer/queries";

export const Route = createFileRoute("/_authed/settings/composer")({
  component: ComposerSettingsPage,
});

/**
 * 设置 → 输入助手（CB-144 PR4/PR5）：本地候选、快捷短语、学习习惯与 AI 建议的开关和维护。
 * 行内补全的开关在对应功能上线（PR6）时才出现在这里——现在摆出来的话是假开关。
 */
function ComposerSettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery(composerSettingsQueryOptions());
  const phrases = useQuery(quickPhrasesQueryOptions());
  const updateSettings = useMutation(
    updateComposerSettingsMutationOptions(queryClient),
  );
  const createPhrase = useMutation(
    createQuickPhraseMutationOptions(queryClient),
  );
  const updatePhrase = useMutation(
    updateQuickPhraseMutationOptions(queryClient),
  );
  const deletePhrase = useMutation(
    deleteQuickPhraseMutationOptions(queryClient),
  );
  const reorder = useMutation(reorderQuickPhrasesMutationOptions(queryClient));
  const clearHabits = useMutation(
    clearComposerHabitsMutationOptions(queryClient),
  );
  const [newPhrase, setNewPhrase] = useState("");
  const [editing, setEditing] = useState<QuickPhrase | null>(null);
  const [editText, setEditText] = useState("");

  const move = (list: readonly QuickPhrase[], id: string, delta: -1 | 1) => {
    const index = list.findIndex((phrase) => phrase.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) return;
    const ids = list.map((phrase) => phrase.id);
    const a = ids[index];
    const b = ids[target];
    if (a === undefined || b === undefined) return;
    ids[index] = b;
    ids[target] = a;
    reorder.mutate(ids);
  };

  const submitNewPhrase = () => {
    if (!newPhrase.trim()) return;
    createPhrase.mutate(
      { text: newPhrase.trim() },
      { onSuccess: () => setNewPhrase("") },
    );
  };

  return (
    <PageShell
      description={
        "输入时优先匹配你的快捷短语和常用输入，全部在本机服务器完成，不请求模型。"
      }
      title={"输入助手"}
    >
      <PageSection
        description={"关掉「学习习惯」后不再记录新习惯，已记录的也不再出候选。"}
        settingItem="composer.composer-enabled"
        title={"输入候选"}
      >
        <PageRows>
          {settings.isPending ? (
            <PageSkeleton rows={3} />
          ) : settings.error || !settings.data ? (
            <PageEmpty>{"无法加载输入助手设置。"}</PageEmpty>
          ) : (
            <>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconKeyboard />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{"输入助手"}</ItemTitle>
                  <ItemDescription>
                    {settings.data.enabled
                      ? "输入时显示快捷短语与常用输入候选。"
                      : "输入候选、学习与候选条全部停止。"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={"输入助手"}
                    checked={settings.data.enabled}
                    disabled={updateSettings.isPending}
                    onCheckedChange={(enabled) =>
                      updateSettings.mutate({ enabled })
                    }
                  />
                </ItemActions>
              </Item>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBulb />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{"本地候选"}</ItemTitle>
                  <ItemDescription>
                    {settings.data.localCompletionEnabled
                      ? "输入前缀匹配快捷短语与常用输入。"
                      : "不再按输入前缀出候选。"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={"本地候选"}
                    checked={settings.data.localCompletionEnabled}
                    disabled={updateSettings.isPending}
                    onCheckedChange={(localCompletionEnabled) =>
                      updateSettings.mutate({ localCompletionEnabled })
                    }
                  />
                </ItemActions>
              </Item>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBulb />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{"学习习惯"}</ItemTitle>
                  <ItemDescription>
                    {settings.data.learningEnabled
                      ? "发送过的消息按机器人记住，常用地排在前面。"
                      : "不记录新习惯，已有习惯也不出候选。"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={"学习习惯"}
                    checked={settings.data.learningEnabled}
                    disabled={updateSettings.isPending}
                    onCheckedChange={(learningEnabled) =>
                      updateSettings.mutate({ learningEnabled })
                    }
                  />
                </ItemActions>
              </Item>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconSparkles />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{"AI 建议"}</ItemTitle>
                  <ItemDescription>
                    {settings.data.aiEnabled
                      ? "最近几条对话会发给部署方配置的模型，预判你下一步想发送的消息。"
                      : "起草内容不离开本机，不出 AI 建议。"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={"AI 建议"}
                    checked={settings.data.aiEnabled}
                    disabled={updateSettings.isPending}
                    onCheckedChange={(aiEnabled) =>
                      updateSettings.mutate({ aiEnabled })
                    }
                  />
                </ItemActions>
              </Item>
            </>
          )}
        </PageRows>
      </PageSection>

      <PageSection
        description={
          "输入短语开头几个字，整句就会出现在候选里；点一下就填进输入框，不会直接发送。"
        }
        title={"快捷短语"}
      >
        <PageRows>
          {phrases.isPending ? (
            <PageSkeleton rows={2} />
          ) : phrases.error ? (
            <PageEmpty>{"无法加载快捷短语。"}</PageEmpty>
          ) : (
            <>
              {(phrases.data ?? []).length === 0 ? (
                <PageEmpty>{"还没有快捷短语。"}</PageEmpty>
              ) : (
                (phrases.data ?? []).map((phrase, index, list) => (
                  <div key={phrase.id}>
                    {index > 0 ? <Separator /> : null}
                    <Item
                      data-setting-item={`composer.phrase.${phrase.id}`}
                      render={
                        <button
                          onClick={() => {
                            setEditing(phrase);
                            setEditText(phrase.text);
                          }}
                          type="button"
                        />
                      }
                      size="sm"
                    >
                      <ItemContent>
                        <ItemTitle className="line-clamp-1">
                          {phrase.text}
                        </ItemTitle>
                      </ItemContent>
                      <ItemActions>
                        <Button
                          aria-label={"上移"}
                          disabled={index === 0 || reorder.isPending}
                          onClick={(event) => {
                            event.stopPropagation();
                            move(list, phrase.id, -1);
                          }}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <IconArrowUp />
                        </Button>
                        <Button
                          aria-label={"下移"}
                          disabled={
                            index === list.length - 1 || reorder.isPending
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            move(list, phrase.id, 1);
                          }}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <IconArrowDown />
                        </Button>
                        <Button
                          aria-label={"删除"}
                          disabled={deletePhrase.isPending}
                          onClick={(event) => {
                            event.stopPropagation();
                            deletePhrase.mutate(phrase.id);
                          }}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <IconTrash />
                        </Button>
                      </ItemActions>
                    </Item>
                  </div>
                ))
              )}
              {(phrases.data ?? []).length > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconPlus />
                </ItemMedia>
                <ItemContent>
                  <input
                    aria-label={"新快捷短语"}
                    className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    onChange={(event) => setNewPhrase(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitNewPhrase();
                    }}
                    placeholder={"添加一句常用的话，回车保存"}
                    value={newPhrase}
                  />
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={!newPhrase.trim() || createPhrase.isPending}
                    onClick={submitNewPhrase}
                    size="sm"
                    variant="outline"
                  >
                    {createPhrase.isPending ? "保存中…" : "添加"}
                  </Button>
                </ItemActions>
              </Item>
            </>
          )}
        </PageRows>
      </PageSection>

      <PageSection
        description={
          "习惯按机器人隔离，只来自你实际发送的消息；未发送的草稿从不记录。"
        }
        settingItem="composer.composer-learning"
        title={"学习习惯"}
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconTrash />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{"清空学习习惯"}</ItemTitle>
              <ItemDescription>
                {"删除所有机器人记住的常用输入，立即生效。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                disabled={clearHabits.isPending}
                onClick={() => clearHabits.mutate(undefined)}
                size="sm"
                variant="outline"
              >
                {clearHabits.isPending ? "清空中…" : "清空"}
              </Button>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <Dialog
        onOpenChange={(open) => !open && setEditing(null)}
        open={editing !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{"编辑快捷短语"}</DialogTitle>
            <DialogDescription>
              {"改完保存后立即对新的输入生效。"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <input
              aria-label={"短语内容"}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setEditText(event.target.value)}
              value={editText}
            />
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setEditing(null)} size="sm" variant="ghost">
              {"取消"}
            </Button>
            <Button
              disabled={!editText.trim() || updatePhrase.isPending}
              onClick={() => {
                if (!editing) return;
                updatePhrase.mutate(
                  { id: editing.id, input: { text: editText.trim() } },
                  { onSuccess: () => setEditing(null) },
                );
              }}
              size="sm"
            >
              {updatePhrase.isPending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
