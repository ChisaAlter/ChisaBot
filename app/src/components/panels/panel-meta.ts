/**
 * 面板卡片的小字：来源一行、搭建步骤（DESIGN.md §77）。纯函数，方便单测。
 */

export type PanelSource = { name: string; url: string };
export type SourceGroup = { label: string; url: string; names: string[] };

/** 网站：主机名去掉子域（api.open-meteo.com → open-meteo.com；weather.com.cn 这种二级后缀留三段）。 */
function siteOf(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
  if (/^[\d.]+$/.test(host) || !host.includes(".")) return host;
  const labels = host.split(".");
  const tail = labels.slice(-2).join(".");
  const keep = /^(com|net|org|gov|edu|co|ac)\.[a-z]{2}$/.test(tail) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** 一组名字的公共前缀（按字符），去掉末尾的空格和标点。 */
function commonPrefix(names: string[]): string {
  if (names.length === 0) return "";
  let prefix = names[0]!;
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.replace(/[\s·、,，:：\-–—/|（(]+$/u, "").trim();
}

/**
 * 来源按网站合并：「Open-Meteo 东京 forecast API」「Open-Meteo 上海 forecast API」「Open-Meteo API 文档」
 * 都在 open-meteo.com，卡片上只写一个「Open-Meteo」。名字没有公共前缀时用第一个名字；没有网址的来源按名字去重。
 */
export function groupSources(sources: readonly PanelSource[]): SourceGroup[] {
  const groups: SourceGroup[] = [];
  const byKey = new Map<string, SourceGroup>();
  for (const source of sources) {
    const name = source.name?.trim();
    if (!name) continue;
    const host = source.url ? siteOf(source.url) : "";
    const key = host ? `h:${host}` : `n:${name}`;
    const group = byKey.get(key);
    if (group) {
      if (!group.names.includes(name)) group.names.push(name);
      continue;
    }
    const next = { label: name, url: host ? source.url : "", names: [name] };
    byKey.set(key, next);
    groups.push(next);
  }
  for (const group of groups) {
    if (group.names.length < 2) continue;
    const prefix = commonPrefix(group.names);
    group.label = prefix.length >= 2 ? prefix : group.names[0]!;
  }
  return groups;
}

/**
 * ⋯ 菜单 →「让 AI 修改…」：塞进输入框的那句话（不发送）。标题原样带引号，机器人一眼知道是哪张卡；
 * 冒号后面留给用户接着写要改什么。
 */
export function panelEditPrompt(title: string): string {
  return `帮我改一下右栏这张「${title.trim()}」面板：`;
}

/**
 * 搭建中的卡片写机器人正在做的那一步（干活卡广播 `chisabot-work-step`）。建卡、交数据这两个面板工具
 * 换成用户听得懂的说法；还没有步骤时是「正在准备」。
 */
export function buildStepText(step: { name: string; label: string } | null): string {
  if (!step) return "正在准备";
  if (step.name === "panel_create") return "正在准备";
  if (step.name === "panel_update") return "正在把数据排进面板";
  if (step.name.startsWith("panel_")) return "正在准备";
  return step.label || "正在取数据";
}
