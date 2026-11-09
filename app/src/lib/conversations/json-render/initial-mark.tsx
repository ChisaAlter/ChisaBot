import { IconPhoto, IconUser } from "@tabler/icons-react";
import { initials } from "./rich-utils";

/**
 * 图 / 头像的退化内容：名字的首字；名字为空或全是符号时画一个中性的通用图标
 * （人 = 头像，物 = 列表图位 / 商品），容器加 data-empty 换成中性底色，不出「?」也不出半个 emoji。
 */
export function InitialMark({
  name,
  kind,
}: {
  name: string;
  kind: "person" | "item";
}) {
  const text = initials(name);
  if (text) return <>{text}</>;
  const Glyph = kind === "person" ? IconUser : IconPhoto;
  return (
    <Glyph
      aria-hidden
      className="jr-ph-glyph"
      data-testid="jr-ph-glyph"
      stroke={1.75}
    />
  );
}

/** 容器上的 data-empty（没有可用首字时）。 */
export function emptyMarkProps(name: string): { "data-empty"?: "" } {
  return initials(name) ? {} : { "data-empty": "" };
}
