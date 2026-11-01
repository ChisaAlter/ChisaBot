/**
 * 技能「名字」（slug）规则（审查模块 12 第 5 条）。
 *
 * 名字只能是小写字母、数字、连字符，2–40 个字符，首尾不是连字符。标题是中文时没有能直接用的字母，
 * 原来的写法会把每个汉字换成「-」，「周报」变成「--」。这里从标题里留下字母数字；剩下不够两个字符时，
 * 用标题算一个稳定的短串（同一个标题每次得到同一个名字），保证一定合法。
 */
export const SKILL_SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** 输入框里边打边规整：转小写、非法字符变连字符、连续连字符合并、去掉开头的连字符（结尾的留着，方便接着打）。 */
export function normalizeSlugInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40);
}

function shortHash(text: string): string {
  // FNV-1a 32 位，只用来给中文标题一个稳定、够短的后缀。
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(6, "0").slice(0, 6);
}

/** 名字里至少要有这么多拉丁字母，才直接用、不加后缀。 */
export const MIN_LATIN_FOR_PLAIN_SLUG = 4;

function latinLetters(text: string): number {
  return text.replace(/[^a-z]/g, "").length;
}

/** 从标题生成合法的名字；标题为空时返回空串。 */
export function slugFromTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "";
  const ascii = normalizeSlugInput(trimmed)
    .replace(/-+$/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  // 「周报v2」这类中文夹少量字母的标题只剩「v2」，很容易和别的技能撞名：拉丁字母少于 4 个时也加 hash 后缀。
  if (SKILL_SLUG.test(ascii) && latinLetters(ascii) >= MIN_LATIN_FOR_PLAIN_SLUG)
    return ascii;
  const prefix = ascii ? `${ascii.slice(0, 26).replace(/-+$/, "")}-` : "skill-";
  return `${prefix}${shortHash(trimmed)}`;
}
