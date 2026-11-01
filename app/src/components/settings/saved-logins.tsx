/** 已保存的登录（原「密码」页），2026-10-12 并入「账号与密码」页底部。 */
import { confirmDialog } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { IconKey, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { deleteSavedLoginMutationOptions } from "@/lib/passwords/mutations";
import { savedLoginsQueryOptions } from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";


export function SavedLoginsSection() {
  const logins = useQuery(savedLoginsQueryOptions());
  const remove = useMutation(deleteSavedLoginMutationOptions(queryClient));
  return (
    <PageSection
        description={"登录网站时保存的账号密码。机器人看不到密码，每次使用都需要你确认。"}
        settingItem="connected-accounts.saved-logins"
        title={"已保存的登录"}
      >
        {logins.isPending ? <PageSkeleton /> : logins.error ? (
          <p className="text-destructive text-sm" role="alert">
            {"无法加载您的密码。"}
          </p>
        ) : !logins.data.passwordManager ? (
          <PageEmpty>
            {"此工作区已关闭保存密码。现有登录被保留但不提供。"}
          </PageEmpty>
        ) : logins.data.logins.length === 0 ? (
          <PageEmpty>{"无保存的登录。登录网站时选择保存到密码。"}</PageEmpty>
        ) : (
          <PageRows>
            {logins.data.logins.map((login, index) => (
              <div key={login.id}>
                {index > 0 ? <Separator /> : null}
                <Item className="list-enter" size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{login.origin}</ItemTitle>
                    <ItemDescription>
                      {login.username}
                      {login.lastUsedAt
                        ? `· 最后使用 ${new Date(login.lastUsedAt).toLocaleDateString("zh-CN")}`
                        : "· 从未使用"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={`删除 ${login.origin} 的登录`}
                      size="icon-sm"
                      variant="ghost"
                      disabled={remove.isPending && remove.variables !== login.id}
                      mutation={remove}
                      mutationWhen={remove.variables === login.id}
                      onClick={() => {
                        void confirmDialog({
                          title: "删除这条已保存的登录？",
                          description: `${login.origin} · ${login.username}。删除后无法恢复。`,
                          confirmLabel: "删除",
                          destructive: true,
                        }).then((ok) => {
                          if (!ok) return;
                          remove.mutate(login.id, {
                            onSuccess: () => toast.success("已删除"),
                            onError: (thrown: Error) => toast.error(`删除失败：${thrown.message}`),
                          });
                        });
                      }}
                    >
                      <IconTrash />
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )}
        {remove.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {remove.error.message}
          </p>
        ) : null}
    </PageSection>
  );
}
