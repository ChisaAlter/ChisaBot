import type { Spec } from "@json-render/react";
import type { LinkStackItem } from "@/components/rich-previews/link-card";
import type { PileImage } from "@/components/rich-previews/rich-previews";
import { safeHttp, safeRenderImageSrc } from "./rich-utils";

/**
 * 从 json-render 规范中识别可直接升级为错落扇形牌组的纯多图 / 纯多链接容器。
 *
 * 模型经常用 Card > Carousel > [Image × N] 或 Stack / Grid > [Link × N] 来展示一组图片或链接，
 * 在对话画面里把它们直接渲染为无笨重外框的 ImagePile / LinkCardStack，避免横滑裁切。
 */
export type ExtractedMediaDeck =
  | { kind: "images"; items: PileImage[] }
  | { kind: "links"; items: LinkStackItem[] };

type SpecElement = {
  type?: unknown;
  props?: unknown;
  children?: unknown;
};

const CONTAINER_TYPES = new Set(["Carousel", "Stack", "Grid"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readImageItem(element: SpecElement): PileImage | null {
  if (element.type !== "Image") return null;
  const props = asRecord(element.props);
  const src = safeRenderImageSrc(props.src);
  if (!src) return null;
  const alt = asString(props.alt) ?? "图片";
  const caption = asString(props.caption);
  const href = safeHttp(props.href) ?? undefined;
  return {
    src,
    alt,
    name: caption ?? alt,
    ...(caption ? { caption } : {}),
    ...(href ? { href } : {}),
  };
}

function readLinkItem(element: SpecElement): LinkStackItem | null {
  if (element.type !== "Link") return null;
  const props = asRecord(element.props);
  const url = safeHttp(props.url);
  if (!url) return null;
  return {
    url,
    title: asString(props.title) ?? null,
    description: asString(props.description) ?? null,
    image: asString(props.image) ?? null,
    meta: asString(props.meta) ?? null,
  };
}

function collectDeckFromElements(
  children: readonly SpecElement[],
): ExtractedMediaDeck | null {
  if (children.length < 2) return null;
  const images: PileImage[] = [];
  for (const child of children) {
    const item = readImageItem(child);
    if (!item) break;
    images.push(item);
  }
  if (images.length === children.length) {
    return { kind: "images", items: images };
  }
  if (children.length <= 3) {
    const links: LinkStackItem[] = [];
    for (const child of children) {
      const item = readLinkItem(child);
      if (!item) break;
      links.push(item);
    }
    if (links.length === children.length) {
      return { kind: "links", items: links };
    }
  }
  return null;
}

export function extractMediaDeckFromElements(
  elements: readonly { type?: unknown; props?: unknown }[],
): ExtractedMediaDeck | null {
  return collectDeckFromElements(elements);
}

export function extractStandaloneMediaDeck(
  spec: Spec | null | undefined,
): ExtractedMediaDeck | null {
  const rootKey = spec?.root;
  const all = spec?.elements as
    | Record<string, SpecElement | undefined>
    | undefined;
  if (!rootKey || !all || typeof all !== "object") return null;

  const resolveChildren = (key: string): SpecElement[] | null => {
    const node = all[key];
    if (!node || !Array.isArray(node.children)) return null;
    const out: SpecElement[] = [];
    for (const childKey of node.children) {
      if (typeof childKey !== "string") return null;
      const child = all[childKey];
      if (!child) return null;
      out.push(child);
    }
    return out;
  };

  const root = all[rootKey];
  if (!root || typeof root.type !== "string") return null;

  if (CONTAINER_TYPES.has(root.type)) {
    const children = resolveChildren(rootKey);
    return children ? collectDeckFromElements(children) : null;
  }

  if (root.type === "Card") {
    const props = asRecord(root.props);
    if (asString(props.description)) return null;
    const childKeys = Array.isArray(root.children)
      ? root.children.filter((k): k is string => typeof k === "string")
      : [];
    if (childKeys.length === 1) {
      const onlyKey = childKeys[0];
      const only = onlyKey ? all[onlyKey] : undefined;
      if (
        only &&
        typeof only.type === "string" &&
        CONTAINER_TYPES.has(only.type)
      ) {
        const inner = onlyKey ? resolveChildren(onlyKey) : null;
        if (inner) return collectDeckFromElements(inner);
      }
    }
    const direct = resolveChildren(rootKey);
    return direct ? collectDeckFromElements(direct) : null;
  }

  return null;
}

export function upgradeNestedMediaDecks(spec: Spec): Spec {
  const all = spec?.elements as
    | Record<string, SpecElement | undefined>
    | undefined;
  if (!all || typeof all !== "object") return spec;

  let nextElements: Record<string, SpecElement> | null = null;

  for (const [key, node] of Object.entries(all)) {
    if (
      !node ||
      typeof node.type !== "string" ||
      !CONTAINER_TYPES.has(node.type)
    ) {
      continue;
    }
    const childKeys = Array.isArray(node.children) ? node.children : null;
    if (!childKeys || childKeys.length < 2) continue;
    const resolved: SpecElement[] = [];
    let valid = true;
    for (const childKey of childKeys) {
      if (typeof childKey !== "string") {
        valid = false;
        break;
      }
      const child = all[childKey];
      if (!child) {
        valid = false;
        break;
      }
      resolved.push(child);
    }
    if (!valid) continue;
    const deck = collectDeckFromElements(resolved);
    if (!deck) continue;
    if (!nextElements)
      nextElements = { ...(all as Record<string, SpecElement>) };
    nextElements[key] = {
      type: "__mediaDeck",
      props: { deck },
      children: [],
    };
  }

  if (!nextElements) return spec;
  return {
    ...spec,
    elements: nextElements as Spec["elements"],
  };
}
