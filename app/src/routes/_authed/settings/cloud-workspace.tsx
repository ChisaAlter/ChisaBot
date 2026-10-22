import { IconKey, IconCloudComputing, IconExternalLink, IconRefresh, IconShieldCheck, IconTrash, IconWorldWww, IconPlugConnected, IconCircleCheck, IconCircleX, IconLink, IconLoader2 } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { classifyProxyInput, countryZh, type CcLoginStart, type CcProxyTest } from "../../../../../shared/cloud-cc";
import { CloudLoginBrowser } from "@/components/cloud-cc/cloud-login-browser";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { toast } from "@/components/ui/toast";
import { PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Card, CardBody, EmptyState, ErrorCard, ListRow, SettingRow } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { useClaudeAuthRecheck } from "@/lib/claude-auth-recheck";
import { ccApi, ccKeys, cloudWorkspaceQueryOptions } from "@/lib/cloud-cc";
import { client } from "@/lib/client";
import { agoText } from "@/lib/im";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/settings/cloud-workspace")({
  component: CloudWorkspacePage,
});

const PLAN_ZH: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", free: "Free" };

/** 设置 → 云端工作区（DESIGN.md §73.1，docs/cloud-claude-code.md §3.1）：Claude 账号登录、总是允许的规则、操作记录。 */
function CloudWorkspacePage() {
  const status = useQuery(cloudWorkspaceQueryOptions());
  const node = status.data?.node ?? null;
  const pills = node ? (
    <span className="cc-pills">
      <span className={cn("cc-pill", node.online ? "is-ok" : "is-off")}><T>{node.online ? "在线" : "离线"}</T></span>
      <span className="cc-pill is-info"><T>{`正在运行 ${status.data?.running ?? 0} / ${status.data?.maxConcurrent ?? 2}`}</T></span>
    </span>
  ) : null;
  return (
    <PageShell
      action={pills}
      description="云端工作区是服务器上一个独立的容器，里面有 Claude Code。电脑关着也能在网页、手机上让它写代码。它碰不到数据库、密钥和别的容器，也不能开完全访问。"
      title="云端工作区"
    >
      {status.isPending ? (
        <PageSkeleton rows={3} tall />
      ) : status.isError ? (
        <ErrorCard action={<Button onClick={() => void status.refetch()} variant="outline">{"重试"}</Button>} description={status.error.message} title="读不到云端工作区" />
      ) : !node ? (
        <EmptyState
          description="还没有云端工作区节点。部署方法见 deploy/cloud-node/README.md：在服务器上起一个容器，用 设置 → 设备 → 添加设备 → 服务器 的安装码配对。"
          icon={<IconCloudComputing className="size-6" />}
          title="先连接云端工作区"
        />
      ) : (
        <>
          <ClaudeAccount />
          <ProxySection />
          <RulesSection />
          <ActivitySection />
          <p className="cc-foot-note">
            {"节点「"}
            {node.name}
            {"」也出现在 "}
            <Link to="/settings/devices">{"设置 → 设备"}</Link>
            {node.claudeVersion ? ` · Claude Code ${node.claudeVersion.replace(/\s*\(.*\)$/, "")}` : ""}
            {node.online || !node.lastSeenAt ? "" : ` · 最后在线 ${agoText(node.lastSeenAt)}`}
          </p>
        </>
      )}
    </PageShell>
  );
}

function ClaudeAccount() {
  const queryClient = useQueryClient();
  const status = useQuery(cloudWorkspaceQueryOptions());
  const claude = status.data?.claude;
  const online = !!status.data?.node?.online;
  // 节点程序只在容器启动时从服务器下载（§73.1）：改了 pc/src/cloud-cc 而容器没重启，节点会一直回旧逻辑的答案。
  const staleNode = online && !!status.data?.node?.scriptStale;
  const scriptRestartable = !!status.data?.node?.scriptRestartable;
  // 打开这一页 / 回到窗口时，缓存「未登录」或超过 60 秒就后台复查一次（§73.1）。
  const { checking } = useClaudeAuthRecheck();
  const [login, setLogin] = useState<CcLoginStart | null>(null);
  const [cloud, setCloud] = useState(false);
  const browserLogin = !!status.data?.browserLogin;
  const phone = !!useOptionalSidebar()?.isMobile;
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!login) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [login]);
  const remaining = login ? Math.max(0, Date.parse(login.expiresAt) - now) : 0;
  useEffect(() => {
    if (login && remaining === 0) {
      setLogin(null);
      setError("登录流程过期了（10 分钟），请重新开始。");
    }
  }, [login, remaining]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ccKeys.status });

  const start = useAsyncAction(
    async () => {
      setError(null);
      setCode("");
      setLogin(await ccApi.loginStart());
    },
    { errorToast: (e) => `没能开始登录：${e.message}` },
  );
  const finish = useAsyncAction(
    async () => {
      if (!login) return;
      const result = await ccApi.loginCode(login.id, code.trim());
      if (!result.ok) {
        setError(result.error ?? "登录没有成功");
        setLogin(null);
        throw new Error(result.error ?? "登录没有成功");
      }
      setLogin(null);
      setCode("");
      await refresh();
    },
    { errorToast: false },
  );
  const cancel = async () => {
    if (login) await ccApi.loginCancel(login.id).catch(() => {});
    setLogin(null);
    setCode("");
  };
  const check = useAsyncAction(async () => {
    await ccApi.check();
    await refresh();
  });
  /** 让节点重启换上新版节点程序（容器起来时重新下载）：几秒后它会自己连回来。 */
  const restart = useAsyncAction(
    async () => {
      await ccApi.restartNode();
      toast.info("云端节点正在重启，几秒后自动回来。");
      setTimeout(() => void refresh(), 6000);
    },
    { errorToast: (e) => `没能重启节点：${e.message}` },
  );
  const logout = useAsyncAction(
    async () => {
      setError(null);
      try {
        const result = await ccApi.logout();
        // 服务器已经核对过节点（节点以 auth status 为准）。这里还是「已登录」= 没退掉，别让按钮显示「已退出」。
        // 节点跑的是旧程序时，回答「还登着」本来就是这个旧逻辑的结论——直接点名，别让人以为是自己账号的问题。
        if (result?.loggedIn) throw new Error(staleNode ? "云端节点还在跑旧版节点程序：新的退出逻辑要节点重启后才生效（见下方提示）。" : "云端工作区里的 Claude 还没有退出，请再试一次。");
      } catch (thrown) {
        const text =
          thrown instanceof Error
            ? thrown.name === "TimeoutError"
              ? "云端工作区没有及时回应（45 秒），请稍后再试。"
              : thrown.message
            : String(thrown);
        setError(`没有退出：${text}`);
        throw thrown;
      }
      await refresh();
    },
    // DESIGN.md §73.1：失败在卡片底部一行红字，不弹 toast。
    { errorToast: false },
  );
  const askLogout = async () => {
    const ok = await confirmDialog({ title: "退出 Claude 账号？", description: "云端工作区里的 Claude Code 会退出登录，正在跑的会话会失败。以后可以重新登录。", confirmLabel: "退出", destructive: true });
    if (ok) void logout.run();
  };

  const plan = claude?.plan ? (PLAN_ZH[claude.plan.toLowerCase()] ?? claude.plan) : null;
  return (
    <PageSection description="用你的 Claude 订阅登录云端工作区里的 Claude Code。凭据只存在云端工作区的容器里，ChisaBot 的数据库和日志里都没有。" title="Claude 账号">
      <Card className="cc-account" data-testid="cc-account">
        {cloud ? (
          <CardBody className="cc-rb-body">
            <CloudLoginBrowser
              onCancel={(err) => {
                setCloud(false);
                if (err) setError(err);
              }}
              onDone={() => {
                setCloud(false);
                setError(null);
                void refresh();
                toast.success("已在云端登录 Claude");
              }}
              phone={phone}
            />
          </CardBody>
        ) : claude?.loggedIn && !login ? (
          <CardBody className="cc-account-row">
            <span className="cc-account-ic is-ok">
              <IconShieldCheck className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="cc-account-t" data-testid="cc-logged-in">{`已登录 · ${claude.email ?? "Claude 账号"}${plan ? ` · ${plan}` : ""}`}</div>
              <div className="cc-account-s">{claude.checkedAt ? `${agoText(claude.checkedAt)}检查过` : "已登录"}</div>
            </div>
            <span className="cc-account-actions">
            <Button disabled={!online} feedback="refresh" onClick={() => void check.run()} size="sm" state={check.state} variant="outline">
              <IconRefresh className="size-4" />
              {"重新检查"}
            </Button>
            <Button disabled={!online} feedback={{ pending: "退出中…", success: "已退出", error: "没有退出" }} onClick={() => void askLogout()} size="sm" state={logout.state} variant="ghost">
              {"退出"}
            </Button>
            </span>
          </CardBody>
        ) : login ? (
          <CardBody className="cc-steps" data-testid="cc-login-steps">
            <Step n={1} sub={browserLogin ? "备用方式：授权页会在你自己的浏览器里打开（用你电脑的 IP）。想全程在云端，用「在云端完成登录」。" : undefined} title="打开 Claude 授权页">
              <div className="cc-step-actions">
                <Button render={<a href={login.url} rel="noreferrer noopener" target="_blank" />} size="sm">
                  {"打开 Claude 授权页"}
                  <IconExternalLink className="size-4" />
                </Button>
                <CopyButton size="sm" value={login.url} variant="outline">
                  {"复制链接"}
                </CopyButton>
              </div>
            </Step>
            <Step n={2} sub="在授权页用你的 Claude 账号登录，页面会显示一串授权码。" title="登录后复制页面上的授权码" />
            <Step n={3} title="粘贴授权码">
              <form
                className="cc-code-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (code.trim()) void finish.run();
                }}
              >
                <Input autoComplete="off" data-testid="cc-code" onChange={(e) => setCode(e.target.value)} placeholder="粘贴授权码" spellCheck={false} value={code} />
                <Button disabled={!code.trim()} feedback={{ pending: "登录中…", success: "已登录", error: "没有成功" }} state={finish.state} type="submit">
                  {"完成登录"}
                </Button>
                <span className="cc-code-meta">
                  {`剩余 ${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0")}`}
                  {" · "}
                  <button className="cc-link" onClick={() => void cancel()} type="button">
                    {"取消"}
                  </button>
                </span>
              </form>
            </Step>
          </CardBody>
        ) : checking ? (
          <CardBody className="cc-account-row" data-testid="cc-auth-checking">
            <span className="cc-account-ic">
              <IconLoader2 className="size-5 motion-safe:animate-spin" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="cc-account-t">{"正在确认登录状态…"}</div>
              <div className="cc-account-s">{"正在向云端工作区确认 Claude 是否已登录。"}</div>
            </div>
          </CardBody>
        ) : (
          <CardBody className="cc-account-row">
            <span className="cc-account-ic">
              <IconKey className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="cc-account-t">{online ? "还没有登录 Claude" : "云端工作区不在线"}</div>
              <div className="cc-account-s">
                {!online
                  ? "节点上线后才能登录。"
                  : browserLogin
                    ? "Claude Pro / Max 订阅都可以。浏览器在云端打开，你在这里登录、授权，整个过程不经过你的电脑，和 Claude Code 用同一个出口。"
                    : "Claude Pro / Max 订阅都可以。三步：打开授权页 → 复制授权码 → 粘回来。（更新云端节点后可以在云端完成登录。）"}
              </div>
            </div>
            <span className="cc-account-actions">
              {browserLogin ? (
                <>
                  <Button
                    data-testid="cc-login-cloud"
                    disabled={!online}
                    onClick={() => {
                      setError(null);
                      setCloud(true);
                    }}
                  >
                    {"在云端完成登录"}
                  </Button>
                  <Button data-testid="cc-login-start" disabled={!online} feedback={{ pending: "打开中…", success: "已打开", error: "没有打开" }} onClick={() => void start.run()} state={start.state} variant="ghost">
                    {"粘贴授权码（备用）"}
                  </Button>
                </>
              ) : (
                <Button data-testid="cc-login-start" disabled={!online} feedback={{ pending: "打开中…", success: "已打开", error: "没有打开" }} onClick={() => void start.run()} state={start.state}>
                  {"用 Claude 订阅登录"}
                </Button>
              )}
            </span>
          </CardBody>
        )}
        {error ? (
          <div className="cc-account-err" data-testid="cc-login-error" role="alert">
            {error}
          </div>
        ) : null}
        {staleNode ? (
          <div className="cc-account-warn" data-testid="cc-node-stale">
            <div className="cc-account-warn-t">{"云端节点还在跑旧版节点程序"}</div>
            <div className="cc-account-warn-s">
              {scriptRestartable
                ? "节点程序只在容器启动时从服务器下载一次，所以登录 / 退出的新逻辑要节点重启后才生效。点「重启节点」让它换成新版本，几秒后自己连回来。"
                : "节点程序只在容器启动时从服务器下载一次，而这个节点还不支持在线更新：在服务器上执行下面这条命令，几秒后它会自己连回来。"}
            </div>
            <div className="cc-account-warn-a">
              {scriptRestartable ? (
                <Button feedback={{ pending: "重启中…", success: "已重启", error: "没有重启" }} onClick={() => void restart.run()} size="sm" state={restart.state} variant="outline">
                  {"重启节点"}
                </Button>
              ) : (
                <CopyButton size="sm" value="docker restart chisabot-cloudnode" variant="outline">
                  {"复制命令"}
                </CopyButton>
              )}
            </div>
          </div>
        ) : null}
      </Card>
    </PageSection>
  );
}

/**
 * 「Claude 上游代理」（DESIGN.md §73.8、§85）：你自己的代理 / 静态住宅 IP，或者 trojan / vless / vmess / ss / hysteria2 / tuic 节点链接。
 * 设了以后，云端节点里 Claude Code 的所有请求（含登录、换令牌）和「在云端完成登录」的浏览器访问 Claude 的域名时都走它；
 * GitHub、npm 这些不走。节点链接要打开「用 sing-box 转换此链接」：服务器上的云端节点起一个本机转换器（sing-box）。
 * 地址 / 链接存在保险箱里，这里只显示打码后的（协议 · 主机:端口 · 节点名）。
 */
function ProxySection() {
  const queryClient = useQueryClient();
  const status = useQuery(cloudWorkspaceQueryOptions());
  const proxy = status.data?.proxy;
  const online = !!status.data?.node?.online;
  const converterReady = !!proxy?.converter.available;
  const [value, setValue] = useState("");
  const [convert, setConvert] = useState(false);
  const [result, setResult] = useState<CcProxyTest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = classifyProxyInput(value);
  const isLink = input.kind === "link";
  /** 节点链接：链接写对了、开关打开了、节点里有 sing-box 才能测试 / 保存。 */
  const linkBlocked = isLink && (!!input.error || !convert || !converterReady);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ccKeys.status });
  const runTest = async (url: string | null) => {
    setError(null);
    setResult(null);
    const r = await client("/api/cloud-workspace/claude/proxy/test", { method: "POST", body: url ? { url } : {}, fallback: "测试失败" }).then((x) => x.json() as Promise<CcProxyTest>);
    setResult(r);
    if (!r.ok) throw new Error(r.error ?? "连不上 Claude");
  };
  const test = useAsyncAction(async () => runTest(value.trim() || null), { errorToast: false });
  /** 保存后自动测一次已保存的：出口 IP + 国家。 */
  const check = useAsyncAction(async () => runTest(null), { errorToast: false });
  const save = useAsyncAction(
    async () => {
      setError(null);
      setResult(null);
      const r = await client("/api/cloud-workspace/claude/proxy", { method: "PUT", body: { url: value.trim(), ...(isLink ? { convert } : {}) }, fallback: "保存失败" })
        .then((x) => x.json() as Promise<{ masked: string | null; applied: boolean; running: number }>)
        .catch((e: Error) => {
          setError(e.message);
          throw e;
        });
      setValue("");
      setConvert(false);
      await refresh();
      if (r.running) toast.info(`正在跑的 ${r.running} 个会话不会被打断：这一轮里新的连接马上走新代理，下一轮整轮都用它。`);
      else if (!r.applied) toast.info("已保存。云端工作区现在不在线，上线后自动用上。");
      if (r.applied) void check.run();
    },
    { errorToast: false },
  );
  const clear = useAsyncAction(async () => {
    await client("/api/cloud-workspace/claude/proxy", { method: "DELETE", fallback: "清除失败" });
    setResult(null);
    await refresh();
  });
  const askClear = async () => {
    const ok = await confirmDialog({ title: "清除 Claude 上游代理？", description: "之后 Claude Code 和云端登录浏览器直接走机房的默认出口；用的是节点链接的话，云端的 sing-box 转换器也会停掉。正在跑的这一轮不会被打断。", confirmLabel: "清除", destructive: true });
    if (ok) void clear.run();
  };
  const row = (label: string, r: CcProxyTest["claudeAi"]) => (
    <span className={cn("cc-proxy-chk", r?.ok ? "is-ok" : "is-bad")}>
      {r?.ok ? <IconCircleCheck className="size-4" /> : <IconCircleX className="size-4" />}
      {label}
      <span className="cc-proxy-chk-s">{r?.ok ? (r.status ? `HTTP ${r.status}` : "通") : (r?.error ?? "不通")}</span>
    </span>
  );
  const country = countryZh(result?.country);
  const currentSub = !proxy?.configured
    ? "支持 http://、https://、socks5://（可以带 用户名:密码@），也支持 trojan://、vless://、vmess://、ss://、hysteria2://、tuic:// 节点链接。"
    : proxy.kind === "link"
      ? "经 sing-box 转换。Claude Code 和云端登录浏览器访问 Claude 时走这个节点。"
      : "Claude Code 和云端登录浏览器访问 Claude 时走这个代理。";
  return (
    <PageSection description="用你自己的代理、静态住宅 IP 或节点链接访问 Claude。设了以后，云端 Claude Code（包括登录、续期）和「在云端完成登录」的浏览器访问 Claude 时都走它，登录和日常使用是同一个 IP；GitHub、npm 等其他网站不走。地址加密存在保险箱里。" title="Claude 上游代理">
      <Card data-testid="cc-proxy">
        <CardBody className="cc-proxy-body">
          <div className="cc-proxy-now">
            <span className={cn("cc-account-ic", proxy?.configured && "is-ok")}>
              {proxy?.configured ? <IconPlugConnected className="size-5" /> : <IconWorldWww className="size-5" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="cc-account-t" data-testid="cc-proxy-current">{proxy?.configured ? proxy.masked : "没有设置 · 走机房默认出口"}</div>
              <div className="cc-account-s">{currentSub}</div>
              {proxy?.kind === "link" && proxy.converter.lastError ? (
                <div className="cc-proxy-warn is-bad" data-testid="cc-proxy-conv-error">{`sing-box 没起来：${proxy.converter.lastError}`}</div>
              ) : null}
            </div>
            {proxy?.configured ? (
              <Button data-testid="cc-proxy-clear" disabled={!online} feedback={{ pending: "清除中…", success: "已清除", error: "没清除" }} onClick={() => void askClear()} size="sm" state={clear.state} variant="ghost">
                {"清除"}
              </Button>
            ) : null}
          </div>
          <form
            className="cc-proxy-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim() && !linkBlocked) void save.run();
            }}
          >
            <Input
              aria-label="代理地址或节点链接"
              autoComplete="off"
              data-testid="cc-proxy-input"
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              placeholder={proxy?.configured ? "填新的地址或节点链接来替换" : "socks5://用户名:密码@1.2.3.4:1080 或 trojan://…"}
              spellCheck={false}
              type="text"
              value={value}
            />
            <Button
              data-testid="cc-proxy-test"
              disabled={!online || linkBlocked}
              feedback={{ pending: "测试中…", success: "连接正常", error: "连不上" }}
              onClick={() => void test.run()}
              state={test.state}
              type="button"
              variant="outline"
            >
              {value.trim() ? "测试连接" : proxy?.configured ? "测试当前代理" : "测试默认出口"}
            </Button>
            <Button data-testid="cc-proxy-save" disabled={!value.trim() || !online || linkBlocked} feedback="save" state={save.state} type="submit">
              {"保存"}
            </Button>
          </form>
          {input.kind === "link" ? (
            <div className="cc-proxy-conv" data-testid="cc-proxy-conv">
              <div className={cn("cc-proxy-kind", input.error && "is-bad")} data-testid="cc-proxy-kind">
                {input.error ? <IconCircleX className="size-4" /> : <IconLink className="size-4" />}
                <span className="min-w-0">{input.error ? `${input.protocolZh} 链接：${input.error}` : `识别为 ${input.masked}`}</span>
              </div>
              <SettingRow
                className="cc-proxy-switch"
                description="在云端服务器上运行一个本机转换器（sing-box），把这个节点转成只给 Claude Code 和云端登录浏览器用的本地代理。http / https / socks5 地址不需要它。"
                title="用 sing-box 转换此链接"
              >
                <Switch aria-label="用 sing-box 转换此链接" checked={convert} data-testid="cc-proxy-convert" disabled={!converterReady} onCheckedChange={(v) => setConvert(!!v)} />
              </SettingRow>
              {!converterReady ? (
                <div className="cc-proxy-warn" data-testid="cc-proxy-no-singbox">{"云端节点镜像里还没有 sing-box，更新云端节点镜像后才能用节点链接。"}</div>
              ) : !convert ? (
                <div className="cc-proxy-hint">{"打开上面的开关才能测试和保存这个链接。"}</div>
              ) : null}
              <div className="cc-proxy-hint" data-testid="cc-proxy-risk">{"提醒：多人共用的机场节点 IP 比静态住宅 IP 更容易被 Claude 风控，长期使用建议选固定的住宅 IP。"}</div>
            </div>
          ) : input.kind === "invalid" ? (
            <div className="cc-proxy-hint" data-testid="cc-proxy-kind">{"认不出来：写成 http://、https://、socks5://主机:端口，或者粘贴 trojan / vless / vmess / ss / hysteria2 / tuic 节点链接。"}</div>
          ) : null}
          {result ? (
            <div className="cc-proxy-result" data-testid="cc-proxy-result">
              <span className="cc-proxy-ip">{result.ip ? `出口 IP ${result.ip}${country ? ` · ${country}` : ""}` : "拿不到出口 IP"}</span>
              {row("claude.ai", result.claudeAi)}
              {row("api.anthropic.com", result.anthropicApi)}
              {result.ms ? <span className="cc-proxy-chk-s">{`${(result.ms / 1000).toFixed(1)} 秒`}</span> : null}
            </div>
          ) : check.state === "pending" ? (
            <div className="cc-proxy-hint" data-testid="cc-proxy-checking">{"已保存，正在经新的代理测试 claude.ai 和 api.anthropic.com…"}</div>
          ) : null}
          {error ? (
            <div className="cc-account-err" role="alert">
              {error}
            </div>
          ) : null}
        </CardBody>
      </Card>
    </PageSection>
  );
}

function Step({ n, title, sub, children }: { n: number; title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="cc-step">
      <span className="cc-step-n">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="cc-step-t">{title}</div>
        {sub ? <div className="cc-step-s">{sub}</div> : null}
        {children}
      </div>
    </div>
  );
}

type Rule = { id: string; scope: string; scopeTitle: string | null; kind: string; value: string; createdAt: string };
const KIND_ZH: Record<string, string> = { bash: "命令", domain: "网站", tool: "工具", read: "读取" };

function RulesSection() {
  const rules = useQuery({
    queryKey: ccKeys.rules,
    queryFn: ({ signal }) => client("/api/cloud-workspace/permission-rules", "rules", { fallback: "读不到规则", signal }) as Promise<Rule[]>,
  });
  const queryClient = useQueryClient();
  const remove = useAsyncAction(async (id: string) => {
    await client(`/api/cloud-workspace/permission-rules/${encodeURIComponent(id)}`, { method: "DELETE", fallback: "删除失败" });
    await queryClient.invalidateQueries({ queryKey: ccKeys.rules });
  });
  const list = rules.data ?? [];
  return (
    <PageSection description="只读操作、会话目录里的改动直接做；其他命令先在会话里弹审批卡。你在卡片上选「本会话总是允许」的会记在这里。推送、gh、ssh、sudo 一律不允许。" title="总是允许">
      <Card>
        {rules.isPending ? (
          <div className="cc-empty-line">{"读取中…"}</div>
        ) : list.length === 0 ? (
          <div className="cc-empty-line">{"还没有。"}</div>
        ) : (
          list.map((rule) => (
            <ListRow
              actions={
                <Button aria-label="删除这条规则" feedback="delete" onClick={() => void remove.run(rule.id)} size="icon-sm" variant="ghost">
                  <IconTrash className="size-4" />
                </Button>
              }
              key={rule.id}
              sub={`${KIND_ZH[rule.kind] ?? rule.kind} · ${rule.scopeTitle ? `会话「${rule.scopeTitle}」` : "会话"}`}
              title={<code className="cc-code-inline">{rule.value}</code>}
            />
          ))
        )}
      </Card>
    </PageSection>
  );
}

type Event = { id: string; kind: string; detail: Record<string, unknown> | null; at: string };
const EVENT_ZH: Record<string, string> = {
  node_registered: "云端工作区已连接",
  claude_login_started: "开始登录 Claude",
  claude_login_succeeded: "Claude 登录成功",
  claude_login_failed: "Claude 登录没有成功",
  claude_logout: "退出 Claude",
  claude_logout_failed: "退出 Claude 没有成功",
  node_restart: "重启云端节点（更新节点程序）",
  node_restart_failed: "重启云端节点没有成功",
  claude_login_browser_started: "在云端打开登录浏览器",
  claude_login_browser_egress: "登录浏览器出口",
  claude_proxy_set: "设置 Claude 上游代理",
  claude_proxy_cleared: "清除 Claude 上游代理",
  session_created: "新会话",
  turn_started: "开始一轮",
  turn_done: "一轮结束",
  turn_stop_requested: "停止",
  turn_undone: "撤销一轮",
  claude_session_reset: "新的 Claude 会话",
  approval_requested: "请求批准",
  approval_approved: "已允许",
  approval_denied: "已拒绝",
  approval_expired: "审批超时，按拒绝",
  tool_denied: "自动拒绝",
};

function ActivitySection() {
  const events = useQuery({
    queryKey: [...ccKeys.status, "activity"],
    queryFn: ({ signal }) => client("/api/cloud-workspace/activity", "events", { fallback: "读不到操作记录", signal }) as Promise<Event[]>,
  });
  const list = (events.data ?? []).filter((e) => e.kind !== "turn_started").slice(0, 30);
  return (
    <PageSection description="登录、审批、每一轮的结果。不记录授权码、令牌和对话内容。" title="操作记录">
      <Card>
        {list.length === 0 ? (
          <div className="cc-empty-line">{events.isPending ? "读取中…" : "还没有记录。"}</div>
        ) : (
          list.map((e) => (
            <div className="cc-event" key={e.id}>
              <span className="cc-event-t">{EVENT_ZH[e.kind] ?? e.kind}</span>
              <span className="cc-event-d">{describe(e)}</span>
              <span className="cc-event-at">{agoText(e.at) ?? ""}</span>
            </div>
          ))
        )}
      </Card>
    </PageSection>
  );
}

function describe(e: Event) {
  const d = e.detail ?? {};
  if (e.kind === "turn_done") return `${d.ok ? "完成" : d.stopped ? "已停止" : "出错"}${typeof d.files === "number" && d.files ? ` · 改了 ${d.files} 个文件` : ""}${typeof d.costUsd === "number" ? ` · $${d.costUsd.toFixed(3)}` : ""}`;
  if (typeof d.summary === "string") return d.summary.slice(0, 80);
  if (typeof d.reason === "string") return d.reason.slice(0, 80);
  if (typeof d.title === "string") return d.title;
  if (e.kind === "claude_login_browser_egress") return `浏览器 ${d.browser ?? "?"} · Claude Code ${d.node ?? "?"}${d.match ? " · 一致" : ""}${d.viaProxy ? " · 经上游代理" : ""}`;
  if (typeof d.proxy === "string") return d.proxy;
  if (d.via === "cloud_browser") return "在云端完成";
  return "";
}

