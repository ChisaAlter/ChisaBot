import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AvatarCrop,
  AvatarCropper,
  avatarCropFromFile,
  exportAvatarCrop,
} from "@/components/avatar-crop";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authKeys, currentUserQueryOptions } from "@/lib/auth/queries";
import { client } from "@/lib/client";

/**
 * 个人资料（头像 + 显示名称）。
 *
 * - 「个人资料」：点左下角账号卡 → 个人资料，随时修改。
 * - 首次设置：登录后名称还是空的或仍是邮箱（全新部署、或老部署从没设置过）时，进入应用前先弹出
 *   这个玻璃弹窗，必须设好头像和名称才能继续。
 *
 * 头像在浏览器里裁成正方形（拖动定位、滑块缩放），导出 256×256 JPEG 再上传，服务器只存这张小图。
 */

async function saveProfile(body: { name?: string; image?: string | null }) {
  const response = await client("/api/me/profile", {
    method: "PATCH",
    body,
    fallback: "保存个人资料失败",
  });
  return (await response.json()) as {
    profile: { name: string | null; image: string | null };
  };
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
  const initialName =
    user && user.name && user.name !== user.email ? user.name : "";
  const [name, setName] = useState(initialName);
  const [crop, setCrop] = useState<AvatarCrop | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const current = user?.image ?? null;

  const save = useMutation({
    mutationFn: async () => {
      const body: { name?: string; image?: string } = { name: name.trim() };
      if (crop) body.image = await exportAvatarCrop(crop);
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
    const picked = await avatarCropFromFile(file);
    if (!picked.ok) {
      setPickError(picked.error);
      return;
    }
    setCrop(picked.crop);
  }, []);
  const cropSrc = crop?.src;
  useEffect(
    () => () => {
      if (cropSrc) URL.revokeObjectURL(cropSrc);
    },
    [cropSrc],
  );

  const trimmed = name.trim();
  const ready =
    trimmed.length > 0 &&
    [...trimmed].length <= 40 &&
    (!required || Boolean(crop || current));
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
        <p className="text-center text-muted-foreground text-xs">
          {"请先上传头像并填写名称。"}
        </p>
      ) : null}
    </form>
  );
}

/** 「个人资料」弹窗（账号菜单 → 个人资料）。 */
export function ProfileDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="glass-modal profile-dialog max-w-[400px]">
        <DialogTitle className="font-semibold text-lg">
          {"个人资料"}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {"头像和名称显示在左下角的账号卡上。"}
        </DialogDescription>
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
  const open =
    Boolean(user?.profileNeedsSetup) && !done && pathname !== "/onboarding";
  return (
    <Dialog open={open}>
      <DialogContent
        className="glass-modal profile-dialog max-w-[420px]"
        overlayClassName="profile-setup-overlay"
        showCloseButton={false}
      >
        <DialogTitle className="text-center font-semibold text-lg">
          {"欢迎使用 ChisaBot"}
        </DialogTitle>
        <DialogDescription className="text-center text-xs">
          {"先设置你的头像和名称，就可以开始了。"}
        </DialogDescription>
        {open ? <ProfileForm onSaved={() => setDone(true)} required /> : null}
      </DialogContent>
    </Dialog>
  );
}
