import { requireExtra } from "@/lib/deployment/extras";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageSection,
  PageShell,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isComposing } from "@/lib/composing";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import {
  type ActionPolicy,
  actionPolicyQueryOptions,
  type DryRunReport,
  dryRunActionPolicy,
  type PolicyMode,
} from "@/lib/computers/queries";
import { queryClient } from "@/query-client";

/**
 * CEL computer-action boundary editor. Rules are shown as the gateway evaluates them, and denied
 * actions are recorded in Audit with the matching rule.
 */

/**
 * Presets are concrete CEL rules, not a separate policy language.
 */
const PRESETS: { label: string; rule: string; cost?: string }[] = [
  {
    label: "从未提交表单",
    // `key` is guarded by tool name so the clause short-circuits before it on actions that have no
    // keypress in them. Both tools that can press Enter are named: `computer_type` takes a `submit`
    // flag that presses it once the text is in, and a rule naming only `computer_key` left that door
    // open.
    rule: '(intent == "activate" && contains(element.name, "submit")) || ((tool.name == "computer_key" || tool.name == "computer_type") && key == "Enter")',
    cost: "代价：机器人在任何输入框里按回车也会被拦，因为表单在任一字段按回车都会提交。",
  },
  {
    label: "从未在密码字段中输入",
    rule: 'intent == "type" && contains(element.name, "password")',
    cost: "注意：只认标签里带 password 的输入框，网页起了别的名字的密码框拦不住。",
  },
  {
    label: "远离社交媒体",
    rule: 'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com"))',
    cost: "注意：只拦这两个网址；从别处跳转过去的链接不拦。",
  },
];

export const Route = createFileRoute("/_authed/admin/boundaries")({
  // 功能精简（DESIGN.md §74）：默认隐藏，CHISABOT_EXTRAS 含 boundaries 才能进。
  beforeLoad: requireExtra("boundaries"),
  component: BoundariesPage,
});

function BoundariesPage() {
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState("");

  const [tested, setTested] = useState<{
    rule: string;
    report: DryRunReport;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const stored = useQuery(actionPolicyQueryOptions());
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));

  /*
   * The saved policy wins while a save is in flight and after it lands: the server normalises what
   * it stores, so what came back is the policy, not what was sent.
   */
  const policy = savePolicy.data ?? stored.data ?? null;
  const saving = savePolicy.isPending;

  const save = (next: ActionPolicy) => {
    setSaved(false);
    setProblem(null);
    savePolicy.mutate(next, {
      onError: (thrown: Error) => setProblem(thrown.message),
      onSuccess: () => setSaved(true),
    });
  };

  /*
   * A read that failed says so. This screen used to set "The boundary could not be read." itself;
   * since the read became a query, that sentence (or the server's own) is the query's error, and
   * without this the page sat on its title with nothing under it for as long as it was open.
   */
  const unreadable = problem ?? stored.error?.message ?? null;
  if (unreadable && !policy) {
    return (
      <PageShell title={"权限规则"}>
        <p className="mt-4 text-destructive text-sm" role="alert">
          {unreadable}
        </p>
      </PageShell>
    );
  }

  /* Nothing until the policy is known: a rule list that guesses is worse than a blank. */
  if (!policy) {
    return (
      <PageShell title={"权限规则"}>
        <PageSkeleton rows={3} />
      </PageShell>
    );
  }

  const addRule = (rule: string) => {
    const trimmed = rule.trim();
    if (!trimmed || policy.deny.includes(trimmed)) return;
    void save({ ...policy, deny: [...policy.deny, trimmed] });
    setDraft("");
    setTested(null);
  };

  /*
   * The rule as it would be in force — the current policy plus this draft — replayed over recent
   * recorded actions. Nothing is saved and nothing is decided; the reply names the actions the
   * addition would have decided differently, so the rule's real reach is known before it starts
   * refusing anybody.
   */
  const testRule = async (rule: string) => {
    const trimmed = rule.trim();
    if (!trimmed) return;
    setProblem(null);
    setTesting(true);
    try {
      const report = await dryRunActionPolicy({
        ...policy,
        deny: [...policy.deny, trimmed],
      });
      setTested({ rule: trimmed, report });
    } catch (thrown) {
      setProblem((thrown as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <PageShell
      description={
        <>
          {"机器人在电脑和浏览器上能做、不能做的事。每个操作执行前都会先过一遍规则，被拦下的会记在"}
          <Link className="underline" to="/admin/audit">
            {"活动记录"}
          </Link>
          {"里。"}
        </>
      }
      title={"权限规则"}
    >
      <PageSection
        description={
          "「拦下」会直接阻止操作；「只记录」放行但照样记一笔，适合新规则先试跑一段时间。"
        }
        title={"命中规则时"}
      >
        <div className="mt-2 flex gap-2">
          {(["enforce", "dry-run"] as PolicyMode[]).map((mode) => (
            <Button
              key={mode}
              aria-pressed={policy.mode === mode}
              className={policy.mode === mode ? "bg-foreground/5" : undefined}
              disabled={saving}
              onClick={() => void save({ ...policy, mode })}
              size="sm"
              variant="outline"
            >
              {mode === "enforce" ? "拦下" : "只记录"}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {policy.mode === "enforce"
            ? "操作被拦下，机器人会知道是哪条规则拦的。"
            : "不拦。命中规则的操作照常执行，但会像被拦下一样记录下来。"}
        </p>
      </PageSection>

      <PageSection
        description={
          <>
            {"从上到下检查，命中第一条就拦下，机器人会知道是哪条。规则用 CEL 写，可以用到 "}
            <code>tool.name</code>、<code>page.host</code>、<code>command</code>、<code>mcp.server</code>
            {" 等字段。写错、无法判断的规则按「命中」处理，宁可多拦也不悄悄放行。"}
          </>
        }
        title={"永远不允许"}
      >
        {policy.deny.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {"没有禁止规则。所有操作都允许，并且都会记录。"}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-md border border-border">
            {policy.deny.map((rule) => (
              <li
                className="flex items-center justify-between gap-4 px-3 py-2"
                key={rule}
              >
                <code className="min-w-0 break-all font-mono text-xs">
                  {rule}
                </code>
                <Button
                  disabled={saving}
                  onClick={() =>
                    void save({
                      ...policy,
                      deny: policy.deny.filter((one) => one !== rule),
                    })
                  }
                  size="sm"
                  variant="ghost"
                >
                  {"移除"}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex gap-2">
          <Input
            aria-label={"规则，用 CEL 编写"}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 font-mono text-xs"
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
              setTested(null);
            }}
            onKeyDown={(event) => {
              // Not the Enter that confirms a composed character, which would put a half-typed
              // rule into the policy in force.
              if (event.key === "Enter" && !isComposing(event)) addRule(draft);
            }}
            placeholder={
              'tool.name == "computer_click" && contains(element.name, "submit")'
            }
            value={draft}
          />
          <Button
            disabled={testing || draft.trim().length === 0}
            onClick={() => void testRule(draft)}
            size="sm"
            variant="outline"
          >
            {testing ? "测试中…" : "先测试"}
          </Button>
          <Button
            disabled={saving || draft.trim().length === 0}
            onClick={() => addRule(draft)}
            size="sm"
          >
            {"添加规则"}
          </Button>
        </div>

        {tested ? <DryRunResult report={tested.report} /> : null}

        <ul className="mt-3 space-y-2">
          {PRESETS.map((preset) => (
            <li className="flex items-start gap-3" key={preset.rule}>
              <Button
                className="shrink-0"
                disabled={saving || policy.deny.includes(preset.rule)}
                onClick={() => addRule(preset.rule)}
                size="sm"
                variant="outline"
              >
                {preset.label}
              </Button>
              {preset.cost ? (
                <span className="pt-1 text-xs text-muted-foreground">
                  {preset.cost}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </PageSection>

      <PageSection
        description={
          "没被上面拦下的操作，还要在这里有一条允许规则才能执行。注意：这里清空等于什么都不允许，而不是什么都允许。"
        }
        title={"其余允许"}
      >
        <ul className="mt-2 space-y-1">
          {policy.allow.map((rule) => (
            <li className="font-mono text-xs text-muted-foreground" key={rule}>
              {rule === "true" ? "true，任何未被拒绝的" : rule}
            </li>
          ))}
        </ul>
      </PageSection>

      <p className="mt-8 text-muted-foreground text-xs">
        {problem ? (
          <span className="text-destructive" role="alert">
            {problem}
          </span>
        ) : saved ? (
          "已保存。它适用于机器人执行的下一个操作。"
        ) : (
          "更改适用于任何机器人采取的下一个操作，并被保留：重启会重新应用这里的内容。"
        )}
      </p>
    </PageShell>
  );
}

/**
 * What the tested rule would have done to actions already on the trail.
 *
 * Says the number over everything scanned first, because the list below it is capped and a reader
 * who stops at the rows should not believe the rows are the whole answer.
 */
function DryRunResult({ report }: { report: DryRunReport }) {
  if (report.scanned === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" role="status">
        {
          "暂无记录的计算机操作可供测试。规则有效；匹配的内容只有在机器人行动后才会知道。"
        }
      </p>
    );
  }

  return (
    <div className="mt-2" role="status">
      <p className="text-xs text-muted-foreground">
        {report.wouldRefuse === 0
          ? `针对最近 ${report.scanned} 次记录的操作进行测试：此规则本应拒绝其中任何操作。它可能仍匹配未来的操作。`
          : `针对最近 ${report.scanned} 次记录的操作进行测试：此规则本应拒绝 ${report.wouldRefuse}。`}
      </p>
      {report.changes.length > 0 ? (
        <ul className="mt-2 divide-y divide-border rounded-md border border-border">
          {report.changes.map((change) => (
            <li className="px-3 py-2" key={change.id}>
              <p className="text-xs">
                <span className="font-medium">
                  {change.would === "refused" ? "将拒绝" : "现在允许"}
                </span>{" "}
                <code className="font-mono">{change.action}</code>
                {change.element?.name ? (
                  <>
                    {" "}
                    {"开 “"}
                    {change.element.name}”
                  </>
                ) : null}
                {change.command ? (
                  <>
                    {" "}
                    {"运行中"}
                    <code className="font-mono">{change.command}</code>
                  </>
                ) : null}
                {change.file ? (
                  <>
                    {" "}
                    {"触摸"}
                    {change.file}
                  </>
                ) : null}
              </p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                {change.bot}
                {change.page ? <> · {change.page}</> : null} ·{" "}
                {new Date(change.createdAt).toLocaleString("zh-CN")}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {report.wouldRefuse > report.changes.length ? (
        <p className="mt-1 text-muted-foreground text-xs">
          {"显示第一个"}
          {report.changes.length}
          {"; 上面的计数涵盖了所有扫描的内容。"}
        </p>
      ) : null}
    </div>
  );
}
