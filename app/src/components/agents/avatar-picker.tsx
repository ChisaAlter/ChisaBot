import { IconCamera, IconMinus, IconPhotoUp, IconPlus } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { monogramOf } from "../../../../shared/bot-avatars";
import { BotAvatar } from "@/components/agents/bot-avatar";
import { ShapeAvatar } from "@/components/agents/shape-avatar";
import { Button } from "@/components/ui/button";
import { useSegmentedKeys } from "@/components/ui/segmented";
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
  ACCEPTED_AVATAR_TYPES,
  AVATAR_COLORS,
  AVATAR_EMOJIS,
  AVATAR_SHAPES,
  type AvatarColor,
  type AvatarDraft,
  type AvatarShape,
  loadAvatarSource,
  renderAvatar,
  SHAPE_COLORS,
  type ShapeColor,
} from "@/lib/agents/avatars";
import { SHAPE_COLOR_HEX, SHAPE_COLOR_LABEL, SHAPE_LABEL } from "@/lib/agents/avatar-shapes";
import { cn } from "@/lib/utils";

const COLOR_LABEL: Record<AvatarColor, string> = {
  sky: "天蓝",
  ocean: "海蓝",
  mint: "薄荷",
  lime: "青柠",
  amber: "琥珀",
  coral: "珊瑚",
  rose: "玫瑰",
  violet: "紫罗兰",
  slate: "石板灰",
};

/**
 * 表单里的「头像」一行（DESIGN.md §81）：圆形头像 + 「更换头像」。点了打开头像窗：上传图片（圆形取景框里拖动、缩放）、
 * 表情 + 底色、名字首字 + 底色、（已有机器人）默认花纹。选好只改表单草稿，和其它字段一起按「创建 / 保存」写入。
 */
export function AvatarField({
  agentId,
  name,
  seed,
  draft,
  onChange,
  allowPattern,
  disabled,
  autoPicked = false,
}: {
  agentId?: string;
  name: string;
  seed?: string;
  draft: AvatarDraft;
  onChange: (draft: AvatarDraft) => void;
  /** 当前头像是表单自动给的（新建时的首字），不是用户选的。 */
  autoPicked?: boolean;
  /** 默认花纹按机器人 id 生成：新建时还没有 id，不提供。 */
  allowPattern: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shownName = name.trim() || "新";
  return (
    <div className="bot-ava-field">
      {/* 圆形头像本身也能点；读屏和 Tab 只走旁边的「更换头像」按钮，不念两遍。 */}
      <button
        aria-hidden
        className="bot-ava-field-btn"
        disabled={disabled}
        onClick={() => setOpen(true)}
        tabIndex={-1}
        type="button"
      >
        <BotAvatar agentId={agentId} decorative draft={draft} name={shownName} seed={seed} size={64} />
        <span aria-hidden className="bot-ava-field-cam">
          <IconCamera className="size-3.5" />
        </span>
      </button>
      <div className="bot-ava-field-text">
        <Button disabled={disabled} onClick={() => setOpen(true)} size="sm" type="button" variant="outline">
          {"更换头像"}
        </Button>
        <span className="bot-ava-field-hint">{"选一个形象，或上传图片 / 选表情 / 首字"}</span>
      </div>
      <AvatarDialog
        agentId={agentId}
        allowPattern={allowPattern}
        autoPicked={autoPicked}
        draft={draft}
        name={shownName}
        onDone={(next) => {
          onChange(next);
          setOpen(false);
        }}
        onOpenChange={setOpen}
        open={open}
        seed={seed}
      />
    </div>
  );
}

type Tab = "shape" | "upload" | "emoji" | "monogram";

function AvatarDialog({
  open,
  onOpenChange,
  ...rest
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId?: string;
  name: string;
  seed?: string;
  draft: AvatarDraft;
  allowPattern: boolean;
  autoPicked: boolean;
  onDone: (draft: AvatarDraft) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="bot-ava-dialog sm:max-w-[420px]" overlayClassName="bg-black/25 supports-backdrop-filter:backdrop-blur-sm">
        {/* 关窗即丢掉没按「完成」的选择。 */}
        {open ? <AvatarDialogBody {...rest} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** 打开时停在当前头像那一类；新建时自动给的首字不算「选过」，直接到「形象」（有表情会动的那种）。 */
function initialTab(draft: AvatarDraft, autoPicked: boolean): Tab {
  if (draft.kind === "emoji") return "emoji";
  if (draft.kind === "monogram" && !autoPicked) return "monogram";
  if (draft.kind === "shape" || (draft.kind === "monogram" && autoPicked)) return "shape";
  return "upload";
}

/** 停在「形象」页就得有一个确定的选择，不然预览里是圆团而按「完成」什么也没发生。 */
function initialChoice(draft: AvatarDraft, tab: Tab): AvatarDraft {
  return tab === "shape" && draft.kind !== "shape" ? { kind: "shape", shape: "round", color: "violet" } : draft;
}

function AvatarDialogBody({
  agentId,
  name,
  seed,
  draft,
  allowPattern,
  autoPicked,
  onDone,
  onCancel,
}: {
  agentId?: string;
  name: string;
  seed?: string;
  draft: AvatarDraft;
  allowPattern: boolean;
  autoPicked: boolean;
  onDone: (draft: AvatarDraft) => void;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab(draft, autoPicked));
  const [choice, setChoice] = useState<AvatarDraft>(() => initialChoice(draft, initialTab(draft, autoPicked)));
  const [color, setColor] = useState<AvatarColor>(
    draft.kind === "emoji" || draft.kind === "monogram" ? draft.color : "sky",
  );
  const [emoji, setEmoji] = useState<string>(draft.kind === "emoji" ? draft.emoji : "🤖");
  const [shape, setShape] = useState<AvatarShape>(draft.kind === "shape" ? draft.shape : "round");
  const [shapeColor, setShapeColor] = useState<ShapeColor>(draft.kind === "shape" ? draft.color : "violet");
  const [source, setSource] = useState<{ image: HTMLImageElement; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cropRef = useRef<CropHandle | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => {
    if (source) URL.revokeObjectURL(source.url);
  }, [source]);

  const pick = (next: Tab) => {
    setTab(next);
    setError(null);
    if (next === "emoji") setChoice({ kind: "emoji", emoji, color });
    if (next === "monogram") setChoice({ kind: "monogram", color });
    if (next === "shape") setChoice({ kind: "shape", shape, color: shapeColor });
  };
  // 三处分段选择（来源 / 表情 / 底色）都走共用的键盘约定（2026-10-20）：roving tabindex + 方向键。
  const tabKeys = useSegmentedKeys<Tab>({ value: tab, values: ["shape", "upload", "emoji", "monogram"], onChange: pick });
  const emojiKeys = useSegmentedKeys<string>({
    value: emoji,
    values: AVATAR_EMOJIS,
    onChange: (next) => {
      setEmoji(next);
      setChoice({ kind: "emoji", emoji: next, color });
    },
  });
  const colorKeys = useSegmentedKeys<AvatarColor>({
    value: color,
    values: AVATAR_COLORS,
    onChange: (next) => {
      setColor(next);
      setChoice(tab === "emoji" ? { kind: "emoji", emoji, color: next } : { kind: "monogram", color: next });
    },
  });
  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setTab("upload");
    try {
      setSource(await loadAvatarSource(file));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "这张图片打不开。");
    }
  };

  const done = async () => {
    if (tab === "upload" && source && cropRef.current) {
      setBusy(true);
      try {
        const blob = await renderAvatar(source.image, cropRef.current.crop());
        onDone({ kind: "image", blob, previewUrl: URL.createObjectURL(blob) });
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "图片没能处理。");
      } finally {
        setBusy(false);
      }
      return;
    }
    onDone(choice);
  };

  const cropping = tab === "upload" && source !== null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{"头像"}</DialogTitle>
        <DialogDescription>{"图片、表情、首字显示成圆形；形象保持自己的形状。"}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div aria-label={"头像来源"} className="sg-segmented bot-ava-seg" {...tabKeys.groupProps} ref={tabKeys.groupRef} role="radiogroup">
          {(
            [
              ["shape", "形象"],
              ["upload", "上传图片"],
              ["emoji", "表情"],
              ["monogram", "首字"],
            ] as const
          ).map(([id, label]) => (
            // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
            <button
              aria-checked={tab === id}
              className="sg-segmented-item"
              data-testid={`ava-tab-${id}`}
              key={id}
              onClick={() => pick(id)}
              role="radio"
              tabIndex={tabKeys.itemTabIndex(id)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="bot-ava-stage">
          {tab === "shape" ? (
            <ShapePicker
              color={shapeColor}
              onChange={(nextShape, nextColor) => {
                setShape(nextShape);
                setShapeColor(nextColor);
                setChoice({ kind: "shape", shape: nextShape, color: nextColor });
              }}
              shape={shape}
            />
          ) : tab === "upload" ? (
            source ? (
              <AvatarCropper handleRef={cropRef} image={source.image} key={source.url} />
            ) : (
              <div className="bot-ava-drop-wrap">
                <BotAvatar
                  agentId={agentId}
                  decorative
                  draft={choice.kind === "image" ? choice : draft.kind === "image" ? draft : { kind: "keep" }}
                  name={name}
                  seed={seed}
                  size={96}
                />
                <button
                  className="bot-ava-drop"
                  data-testid="ava-choose-file"
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    void chooseFile(event.dataTransfer.files[0]);
                  }}
                  type="button"
                >
                  <IconPhotoUp className="size-5" />
                  <span>{"选择一张图片"}</span>
                  <span className="bot-ava-drop-sub">{"PNG / JPEG / WebP，最大 15 MB；选好后在圆框里拖动、缩放"}</span>
                </button>
              </div>
            )
          ) : (
            <div className="bot-ava-preset">
              <BotAvatar decorative draft={choice} name={name} size={96} />
              {tab === "emoji" ? (
                <div aria-label={"表情"} className="bot-ava-emojis" {...emojiKeys.groupProps} ref={emojiKeys.groupRef} role="radiogroup">
                  {AVATAR_EMOJIS.map((item) => (
                    // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
                    <button
                      aria-checked={emoji === item}
                      aria-label={item}
                      className="bot-ava-emoji"
                      key={item}
                      onClick={() => {
                        setEmoji(item);
                        setChoice({ kind: "emoji", emoji: item, color });
                      }}
                      role="radio"
                      tabIndex={emojiKeys.itemTabIndex(item)}
                      type="button"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="bot-ava-mono-note">{`用名字的第一个字「${monogramOf(name)}」，改名后跟着变。`}</p>
              )}
              <div aria-label={"底色"} className="bot-ava-colors" {...colorKeys.groupProps} ref={colorKeys.groupRef} role="radiogroup">
                {AVATAR_COLORS.map((item) => (
                  // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
                  <button
                    aria-checked={color === item}
                    aria-label={COLOR_LABEL[item]}
                    className={`bot-ava-swatch bot-ava-c-${item}`}
                    key={item}
                    onClick={() => {
                      setColor(item);
                      setChoice(tab === "emoji" ? { kind: "emoji", emoji, color: item } : { kind: "monogram", color: item });
                    }}
                    role="radio"
                    tabIndex={colorKeys.itemTabIndex(item)}
                    title={COLOR_LABEL[item]}
                    type="button"
                  />
                ))}
              </div>
            </div>
          )}
        </div>
        <input
          accept={ACCEPTED_AVATAR_TYPES}
          className="sr-only"
          data-testid="ava-file"
          onChange={(event) => {
            void chooseFile(event.target.files?.[0]);
            event.target.value = "";
          }}
          ref={fileRef}
          tabIndex={-1}
          type="file"
        />
        <p className={cn("bot-ava-error", !error && "is-empty")} role={error ? "alert" : undefined}>
          {error ?? "\u00a0"}
        </p>
      </DialogBody>
      <DialogFooter className="bot-ava-foot">
        {cropping ? (
          <Button onClick={() => fileRef.current?.click()} size="sm" type="button" variant="ghost">
            {"换一张"}
          </Button>
        ) : allowPattern ? (
          <Button
            data-testid="ava-default"
            onClick={() => onDone({ kind: "default" })}
            size="sm"
            type="button"
            variant="ghost"
          >
            {"用默认花纹"}
          </Button>
        ) : (
          <span />
        )}
        <span className="bot-ava-foot-gap" />
        <Button onClick={onCancel} type="button" variant="outline">
          {"取消"}
        </Button>
        <Button
          data-testid="ava-done"
          disabled={busy || (tab === "upload" && !source && choice.kind !== "image")}
          onClick={() => void done()}
          type="button"
        >
          {cropping ? "用这张" : "完成"}
        </Button>
      </DialogFooter>
    </>
  );
}

type CropHandle = { crop: () => { x: number; y: number; size: number } };

/** 取景：圆框直径（屏幕像素）；外面多露一圈看得到被裁掉的部分。 */
const RING = 224;
const PAD = 28;
const MAX_ZOOM = 4;

/**
 * 圆形取景框（用户 2026-10-16：左栏头像是圆的，裁剪也要是圆的）。拖动 = 平移，滚轮 / 双指 / 下面的滑杆 = 缩放，
 * 方向键平移、+ / − 缩放。图片永远盖满圆框；存下来的是圆框外接的正方形（显示时再裁成圆）。
 */
function AvatarCropper({ image, handleRef }: { image: HTMLImageElement; handleRef: React.RefObject<CropHandle | null> }) {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const base = Math.max(RING / w, RING / h);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);

  const scale = base * zoom;
  const width = w * scale;
  const height = h * scale;
  const clamp = (next: { x: number; y: number }, z = zoom) => {
    const s = base * z;
    const limitX = Math.max(0, (w * s - RING) / 2);
    const limitY = Math.max(0, (h * s - RING) / 2);
    return { x: Math.min(limitX, Math.max(-limitX, next.x)), y: Math.min(limitY, Math.max(-limitY, next.y)) };
  };
  const zoomTo = (next: number) => {
    const z = Math.min(MAX_ZOOM, Math.max(1, next));
    setZoom(z);
    setOffset((current) => clamp({ x: (current.x * z) / zoom, y: (current.y * z) / zoom }, z));
  };

  handleRef.current = {
    crop: () => {
      const size = RING / scale;
      const left = (width / 2 - offset.x - RING / 2) / scale;
      const top = (height / 2 - offset.y - RING / 2) / scale;
      return { x: Math.max(0, left), y: Math.max(0, top), size: Math.min(size, w, h) };
    },
  };

  return (
    <div className="bot-ava-crop-wrap">
      <div
        aria-label={"拖动调整位置，滚轮或滑杆缩放"}
        className="bot-ava-crop"
        data-testid="ava-crop"
        onKeyDown={(event) => {
          const step = event.shiftKey ? 24 : 8;
          const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
          const move = moves[event.key];
          if (move) {
            event.preventDefault();
            setOffset((current) => clamp({ x: current.x + move[0], y: current.y + move[1] }));
          } else if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            zoomTo(zoom + 0.2);
          } else if (event.key === "-") {
            event.preventDefault();
            zoomTo(zoom - 0.2);
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            pinch.current = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom };
          }
        }}
        onPointerMove={(event) => {
          const last = pointers.current.get(event.pointerId);
          if (!last) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size === 2 && pinch.current) {
            const [a, b] = [...pointers.current.values()];
            zoomTo((pinch.current.zoom * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / pinch.current.distance);
            return;
          }
          setOffset((current) => clamp({ x: current.x + event.clientX - last.x, y: current.y + event.clientY - last.y }));
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          pinch.current = null;
        }}
        onWheel={(event) => zoomTo(zoom * Math.exp(-event.deltaY * 0.0015))}
        role="application"
        style={{ width: RING + PAD * 2, height: RING + PAD * 2 }}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: role=application 的取景环要拿键盘焦点才能响应方向键
        tabIndex={0}
      >
        <img
          alt=""
          className="bot-ava-crop-img"
          draggable={false}
          src={image.src}
          style={{ width, height, transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))` }}
        />
        <span aria-hidden className="bot-ava-crop-ring" style={{ width: RING, height: RING }} />
      </div>
      <div className="bot-ava-zoom">
        <button aria-label={"缩小"} className="bot-ava-zoom-btn" onClick={() => zoomTo(zoom - 0.25)} type="button">
          <IconMinus className="size-4" />
        </button>
        <input
          aria-label={"缩放"}
          className="bot-ava-range"
          data-testid="ava-zoom"
          max={MAX_ZOOM}
          min={1}
          onChange={(event) => zoomTo(Number(event.target.value))}
          step={0.01}
          type="range"
          value={zoom}
        />
        <button aria-label={"放大"} className="bot-ava-zoom-btn" onClick={() => zoomTo(zoom + 0.25)} type="button">
          <IconPlus className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** 「形象」页：预览（可以试三种表情）+ 14 个形状 + 11 种颜色。 */
function ShapePicker({ shape, color, onChange }: { shape: AvatarShape; color: ShapeColor; onChange: (shape: AvatarShape, color: ShapeColor) => void }) {
  const [selected, setSelected] = useState(false);
  const [working, setWorking] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const shapeKeys = useSegmentedKeys<AvatarShape>({ value: shape, values: AVATAR_SHAPES, onChange: (next) => onChange(next, color) });
  const colorKeys = useSegmentedKeys<ShapeColor>({ value: color, values: SHAPE_COLORS, onChange: (next) => onChange(shape, next) });
  // 「做完」：先跑一下再停，头像会自己露出做完的表情。
  const finish = () => {
    window.clearTimeout(timer.current);
    setWorking(true);
    timer.current = window.setTimeout(() => setWorking(false), 1200);
  };
  return (
    <div className="bot-ava-preset">
      <span className="bot-ava" data-avatar="shape" style={{ width: 96, height: 96 }}>
        <ShapeAvatar color={color} selected={selected} shape={shape} size={96} working={working} />
      </span>
      <div className="bot-ava-moods">
        <button aria-pressed={selected} className="bot-ava-mood" data-testid="ava-mood-selected" onClick={() => setSelected((value) => !value)} type="button">
          {"选中"}
        </button>
        <button aria-pressed={working} className="bot-ava-mood" data-testid="ava-mood-working" onClick={() => { window.clearTimeout(timer.current); setWorking((value) => !value); }} type="button">
          {"工作中"}
        </button>
        <button className="bot-ava-mood" data-testid="ava-mood-done" onClick={finish} type="button">
          {"做完了"}
        </button>
      </div>
      <div aria-label={"形状"} className="bot-ava-shapes" {...shapeKeys.groupProps} ref={shapeKeys.groupRef} role="radiogroup">
        {AVATAR_SHAPES.map((item) => (
          // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
          <button
            aria-checked={shape === item}
            aria-label={SHAPE_LABEL[item]}
            className="bot-ava-shape"
            data-testid={`ava-shape-${item}`}
            key={item}
            onClick={() => onChange(item, color)}
            role="radio"
            tabIndex={shapeKeys.itemTabIndex(item)}
            title={SHAPE_LABEL[item]}
            type="button"
          >
            <span className="bot-ava" data-avatar="shape" style={{ width: 38, height: 38 }}>
              <ShapeAvatar color={color} shape={item} size={38} />
            </span>
          </button>
        ))}
      </div>
      <div aria-label={"颜色"} className="bot-ava-colors is-shape" {...colorKeys.groupProps} ref={colorKeys.groupRef} role="radiogroup">
        {SHAPE_COLORS.map((item) => (
          // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
          <button
            aria-checked={color === item}
            aria-label={SHAPE_COLOR_LABEL[item]}
            className="bot-ava-swatch"
            data-testid={`ava-shape-color-${item}`}
            key={item}
            onClick={() => onChange(shape, item)}
            role="radio"
            style={{ background: SHAPE_COLOR_HEX[item] }}
            tabIndex={colorKeys.itemTabIndex(item)}
            title={SHAPE_COLOR_LABEL[item]}
            type="button"
          />
        ))}
      </div>
    </div>
  );
}