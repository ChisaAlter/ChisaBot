import { IconCamera, IconUser } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/client";
import { authKeys, currentUserQueryOptions } from "@/lib/auth/queries";
import { cn } from "@/lib/utils";

/**
 * 个人资料（头像 + 显示名称）。
 *
 * - 「个人资料」：点左下角账号卡 → 个人资料，随时修改。
 * - 首次设置：登录后名称还是空的或仍是邮箱（全新部署、或老部署从没设置过）时，进入应用前先弹出
 *   这个玻璃弹窗，必须设好头像和名称才能继续。
 *
 * 头像在浏览器里裁成正方形（拖动定位、滑块缩放），导出 256×256 JPEG 再上传，服务器只存这张小图。
 */

const OUTPUT = 256;
const STAGE = 200;

type Crop = { src: string; w: number; h: number; zoom: number; x: number; y: number };

async function saveProfile(body: { name?: string; image?: string | null }) {
  const response = await client("/api/me/profile", {
    method: "PATCH",
    body,
    fallback: "保存个人资料失败",
  });
  return (await response.json()) as { profile: { name: string | null; image: string | null } };
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片无法读取"));
    img.src = src;
  });
}

/** 基础缩放：短边正好铺满取景框。 */
const baseScale = (c: Crop) => STAGE / Math.min(c.w, c.h);

function clampCrop(c: Crop): Crop {
  const s = baseScale(c) * c.zoom;
  const maxX = Math.max(0, (c.w * s - STAGE) / 2);
  const maxY = Math.max(0, (c.h * s - STAGE) / 2);
  return { ...c, x: Math.min(maxX, Math.max(-maxX, c.x)), y: Math.min(maxY, Math.max(-maxY, c.y)) };
}

async function exportCrop(c: Crop): Promise<string> {
  const img = await loadImage(c.src);
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT;
  canvas.height = OUTPUT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持裁剪");
  const k = OUTPUT / STAGE;
  const s = baseScale(c) * c.zoom * k;
  const dw = c.w * s;
  const dh = c.h * s;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, OUTPUT, OUTPUT);
  ctx.drawImage(img, (OUTPUT - dw) / 2 + c.x * k, (OUTPUT - dh) / 2 + c.y * k, dw, dh);
  return canvas.toDataURL("image/jpeg", 0.86);
}

function AvatarCropper({
  crop,
  current,
  onChange,
  onPick,
}: {
  crop: Crop | null;
  current: string | null;
  onChange: (c: Crop) => void;
  onPick: () => void;
}) {
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!crop) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: crop.x, y: crop.y };
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!crop || !drag.current) return;
    onChange(
      clampCrop({ ...crop, x: drag.current.x + e.clientX - drag.current.px, y: drag.current.y + e.clientY - drag.current.py }),
    );
  };
  const onUp = () => {
    drag.current = null;
  };
  const s = crop ? baseScale(crop) * crop.zoom : 1;

  return (
    <div className="profile-avatar-edit">
      <div
        aria-label={crop ? "拖动调整头像位置" : "头像"}
        className={cn("profile-crop-stage", crop && "is-cropping")}
        onPointerCancel={onUp}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        role="img"
        style={{ width: STAGE, height: STAGE }}
      >
        {crop ? (
          <img
            alt=""
            draggable={false}
            src={crop.src}
            style={{
              width: crop.w * s,
              height: crop.h * s,
              transform: `translate(calc(-50% + ${crop.x}px), calc(-50% + ${crop.y}px))`,
            }}
          />
        ) : current ? (
          <img alt="" className="profile-crop-current" src={current} />
        ) : (
          <IconUser className="profile-crop-empty" />
        )}
      </div>
      {crop ? (
        <label className="profile-zoom">
          <span>{"缩放"}</span>
          <input
            aria-label={"缩放头像"}
            max={4}
            min={1}
            onChange={(e) => onChange(clampCrop({ ...crop, zoom: Number(e.target.value) }))}
            step={0.01}
            type="range"
            value={crop.zoom}
          />
        </label>
      ) : null}
      <Button onClick={onPick} size="sm" type="button" variant="outline">
        <IconCamera className="size-4" />
        {crop || current ? "更换头像" : "上传头像"}
      </Button>
    </div>
  );
}

/** 头像 + 名称表单；`required` 时两样都要有才能保存（首次设置）。 */
function ProfileForm({
  required,
  onSaved,
}: {
  required?: boolean;
  onSaved?: () => void;
}) {
  const { data: user } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const initialName = user && user.name && user.name !== user.email ? user.name : "";
  const [name, setName] = useState(initialName);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const current = user?.image ?? null;

  const save = useMutation({
    mutationFn: async () => {
      const body: { name?: string; image?: string } = { name: name.trim() };
      if (crop) body.image = await exportCrop(crop);
      return saveProfile(body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: authKeys.currentUser() });
      window.setTimeout(() => onSaved?.(), 900);
    },
  });

  const onFile = useCallback(async (file: File | undefined) => {
    setPickError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) {
      setPickError("请选择 PNG、JPG 或 WebP 图片。");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setPickError("图片太大（最大 15 MB）。");
      return;
    }
    const src = URL.createObjectURL(file);
    try {
      const img = await loadImage(src);
      setCrop({ src, w: img.naturalWidth, h: img.naturalHeight, zoom: 1, x: 0, y: 0 });
    } catch (e) {
      setPickError(e instanceof Error ? e.message : "图片无法读取");
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 按 src 释放 blob URL；crop 的其他字段变化不需要重新释放
  useEffect(() => () => (crop ? URL.revokeObjectURL(crop.src) : undefined), [crop?.src]);

  const trimmed = name.trim();
  const ready = trimmed.length > 0 && [...trimmed].length <= 40;
  const dirty = trimmed !== initialName || Boolean(crop);

  return (
    <form
      className="profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && (dirty || required)) save.mutate();
      }}
    >
      <AvatarCropper
        crop={crop}
        current={current}
        onChange={setCrop}
        onPick={() => fileRef.current?.click()}
      />
      <input
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
        ref={fileRef}
        type="file"
      />
      {pickError ? (
        <p className="text-center text-destructive text-xs" role="alert">
          {pickError}
        </p>
      ) : null}
      <label className="profile-field">
        <span>{"显示名称"}</span>
        <Input
          autoFocus={required}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          placeholder={"例如：千咲"}
          value={name}
        />
      </label>
      {save.isError ? (
        <p className="text-destructive text-xs" role="alert">
          {save.error instanceof Error ? save.error.message : "保存失败"}
        </p>
      ) : null}
      <Button
        className="w-full"
        disabled={!ready || (!dirty && !required)}
        feedback="save"
        mutation={save}
        type="submit"
      >
        {required ? "保存并进入" : "保存"}
      </Button>
      {required && !ready ? (
        <p className="text-center text-muted-foreground text-xs">{"填写显示名称即可开始；头像可以以后再换。"}</p>
      ) : null}
    </form>
  );
}

/** 「个人资料」弹窗（账号菜单 → 个人资料）。 */
export function ProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="glass-modal profile-dialog max-w-[400px]">
        <DialogTitle className="font-semibold text-lg">{"个人资料"}</DialogTitle>
        <DialogDescription className="text-xs">{"头像和名称显示在左下角的账号卡上。"}</DialogDescription>
        {open ? <ProfileForm onSaved={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 首次设置：名称为空或仍是邮箱时，进入应用前必须先设置头像和名称。不能关闭；
 * 引导页（/onboarding）上不弹，等引导结束后再弹。
 */
export function ProfileSetupGate() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [done, setDone] = useState(false);
  const open = Boolean(user?.profileNeedsSetup) && !done && pathname !== "/onboarding";
  return (
    <Dialog open={open}>
      <DialogContent
        className="glass-modal profile-dialog max-w-[420px]"
        overlayClassName="profile-setup-overlay"
        showCloseButton={false}
      >
        <DialogTitle className="text-center font-semibold text-lg">{"欢迎使用 ChisaBot"}</DialogTitle>
        <DialogDescription className="text-center text-xs">
          {"先设置你的头像和名称，就可以开始了。"}
        </DialogDescription>
        {open ? <ProfileForm onSaved={() => setDone(true)} required /> : null}
      </DialogContent>
    </Dialog>
  );
}
