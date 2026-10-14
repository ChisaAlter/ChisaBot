import { IconCamera, IconUser } from "@tabler/icons-react";
import { type PointerEvent as ReactPointerEvent, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The account portrait cropper, shared with 新建机器人.
 *
 * A file is cropped to a square in the browser and exported as a 256×256 JPEG data URL. The
 * server stores that same string it already accepts for a person's profile image — there is no
 * second upload endpoint.
 */

const OUTPUT = 256;
/** The account dialog's stage. Callers that need a smaller preview pass their own. */
export const PROFILE_AVATAR_STAGE = 200;

export type AvatarCrop = {
  src: string;
  w: number;
  h: number;
  zoom: number;
  x: number;
  y: number;
};

export function loadAvatarImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片无法读取"));
    img.src = src;
  });
}

/** Base scale: the short side exactly fills the stage. */
function baseScale(crop: AvatarCrop, stage: number) {
  return stage / Math.min(crop.w, crop.h);
}

export function clampAvatarCrop(crop: AvatarCrop, stage: number): AvatarCrop {
  const scale = baseScale(crop, stage) * crop.zoom;
  const maxX = Math.max(0, (crop.w * scale - stage) / 2);
  const maxY = Math.max(0, (crop.h * scale - stage) / 2);
  return {
    ...crop,
    x: Math.min(maxX, Math.max(-maxX, crop.x)),
    y: Math.min(maxY, Math.max(-maxY, crop.y)),
  };
}

export async function exportAvatarCrop(
  crop: AvatarCrop,
  stage: number = PROFILE_AVATAR_STAGE,
): Promise<string> {
  const img = await loadAvatarImage(crop.src);
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT;
  canvas.height = OUTPUT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持裁剪");
  const k = OUTPUT / stage;
  const scale = baseScale(crop, stage) * crop.zoom * k;
  const dw = crop.w * scale;
  const dh = crop.h * scale;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, OUTPUT, OUTPUT);
  ctx.drawImage(
    img,
    (OUTPUT - dw) / 2 + crop.x * k,
    (OUTPUT - dh) / 2 + crop.y * k,
    dw,
    dh,
  );
  return canvas.toDataURL("image/jpeg", 0.86);
}

/** Read a picked file into a crop, or a sentence the form can show. */
export async function avatarCropFromFile(
  file: File,
): Promise<{ ok: true; crop: AvatarCrop } | { ok: false; error: string }> {
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) {
    return { ok: false, error: "请选择 PNG、JPG 或 WebP 图片。" };
  }
  if (file.size > 15 * 1024 * 1024) {
    return { ok: false, error: "图片太大（最大 15 MB）。" };
  }
  const src = URL.createObjectURL(file);
  try {
    const img = await loadAvatarImage(src);
    return {
      ok: true,
      crop: {
        src,
        w: img.naturalWidth,
        h: img.naturalHeight,
        zoom: 1,
        x: 0,
        y: 0,
      },
    };
  } catch (error) {
    URL.revokeObjectURL(src);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "图片无法读取",
    };
  }
}

export function AvatarCropper({
  crop,
  current,
  stage = PROFILE_AVATAR_STAGE,
  layout = "profile",
  onChange,
  onPick,
}: {
  crop: AvatarCrop | null;
  current: string | null;
  stage?: number;
  /**
   * `profile` is the account sheet: a centred circle on the pink glass.
   * `field` is a form row: the same crop, drawn as the bot face (glass squircle)
   * beside the same outline button the other sheets use.
   */
  layout?: "profile" | "field";
  onChange: (crop: AvatarCrop) => void;
  onPick: () => void;
}) {
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(
    null,
  );
  const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!crop) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      px: event.clientX,
      py: event.clientY,
      x: crop.x,
      y: crop.y,
    };
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!crop || !drag.current) return;
    onChange(
      clampAvatarCrop(
        {
          ...crop,
          x: drag.current.x + event.clientX - drag.current.px,
          y: drag.current.y + event.clientY - drag.current.py,
        },
        stage,
      ),
    );
  };
  const onUp = () => {
    drag.current = null;
  };
  const scale = crop ? baseScale(crop, stage) * crop.zoom : 1;
  /* 40 matches the text fields and the outline button on this row (DESIGN §10.3). */
  const frame = crop ? stage : layout === "field" ? 40 : stage;
  const face = crop ? (
    <img
      alt=""
      draggable={false}
      src={crop.src}
      style={{
        width: crop.w * scale,
        height: crop.h * scale,
        transform: `translate(calc(-50% + ${crop.x}px), calc(-50% + ${crop.y}px))`,
      }}
    />
  ) : current ? (
    <img alt="" className="profile-crop-current" src={current} />
  ) : (
    <IconUser className={layout === "field" ? "size-5" : "profile-crop-empty"} />
  );
  const frameClass = cn(
    "profile-crop-stage",
    layout === "field" && "is-bot",
    crop && "is-cropping",
  );

  return (
    <div className={layout === "field" ? "flex flex-col items-start gap-2" : "profile-avatar-edit"}>
      <div className={layout === "field" ? "flex items-center gap-3" : "contents"}>
        {layout === "field" && !crop ? (
          <button
            aria-label={"头像"}
            className={frameClass}
            onClick={onPick}
            style={{ width: frame, height: frame }}
            type="button"
          >
            {face}
          </button>
        ) : (
          <div
            aria-label={crop ? "拖动调整头像位置" : "头像"}
            className={frameClass}
            onPointerCancel={onUp}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            role="img"
            style={{ width: frame, height: frame }}
          >
            {face}
          </div>
        )}
        {layout === "field" && !crop ? (
          <Button onClick={onPick} type="button" variant="outline">
            <IconCamera className="size-4" />
            {current ? "更换头像" : "上传头像"}
          </Button>
        ) : null}
      </div>
      {crop ? (
        <label
          className={cn("profile-zoom", layout === "field" && "is-bot")}
          style={{ width: stage }}
        >
          <span>{"缩放"}</span>
          <input
            aria-label={"缩放头像"}
            max={4}
            min={1}
            onChange={(event) =>
              onChange(
                clampAvatarCrop(
                  { ...crop, zoom: Number(event.target.value) },
                  stage,
                ),
              )
            }
            step={0.01}
            type="range"
            value={crop.zoom}
          />
        </label>
      ) : null}
      {layout === "field" && crop ? (
        <Button onClick={onPick} type="button" variant="outline">
          <IconCamera className="size-4" />
          {"更换头像"}
        </Button>
      ) : null}
      {layout === "profile" ? (
        <Button onClick={onPick} size="sm" type="button" variant="outline">
          <IconCamera className="size-4" />
          {crop || current ? "更换头像" : "上传头像"}
        </Button>
      ) : null}
    </div>
  );
}
