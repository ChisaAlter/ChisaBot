import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import brandAvatar from "@/assets/brand/chisa-mark.png";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { DEFAULT_USER_PREFERENCES } from "../../../../shared/user-preferences";

/**
 * 左上角的品牌名：前一段品牌红粗体（默认「Chisa」），后一段普通字（默认「Bot」）。
 *
 * 每个人可以自己改（点品牌名 → 修改名称），存在个人偏好里，换设备也跟着走。两段都留空时回到默认。
 * 字体是随应用打包的 Sora（几何无衬线，只含拉丁字母；中文自动落到系统黑体），不依赖外网字体。
 * 名字前面是品牌头像（assets/brand/，DESIGN.md §28），只是标志，不随名字改。
 */
export function useBrandName() {
  const { data } = useUserPreferences();
  const accent = data?.brandAccent ?? DEFAULT_USER_PREFERENCES.brandAccent;
  const rest = data?.brandRest ?? DEFAULT_USER_PREFERENCES.brandRest;
  if (!accent.trim() && !rest.trim()) {
    return {
      accent: DEFAULT_USER_PREFERENCES.brandAccent,
      rest: DEFAULT_USER_PREFERENCES.brandRest,
    };
  }
  return { accent, rest };
}

export function BrandWordmark({ accent, rest }: { accent: string; rest: string }) {
  return (
    <span className="brand-mark" aria-label={`${accent}${rest}`} role="img">
      {accent ? (
        <span aria-hidden className="brand-mark-accent">
          {accent}
        </span>
      ) : null}
      {rest ? (
        <span aria-hidden className="brand-mark-rest">
          {rest}
        </span>
      ) : null}
    </span>
  );
}

/** 品牌头像：红发带黑长发的圆形头像，顶栏和登录页用同一张。 */
export function BrandAvatar({ size = 28 }: { size?: number }) {
  return (
    <img
      alt=""
      aria-hidden
      className="brand-avatar"
      decoding="async"
      draggable={false}
      height={size}
      src={brandAvatar}
      width={size}
    />
  );
}

/** 顶栏里的品牌名，点一下就能改。 */
export function BrandMark() {
  const { accent, rest } = useBrandName();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={`${accent}${rest}，点击修改名称`}
              className="brand-mark-btn"
              onClick={() => setOpen(true)}
              type="button"
            />
          }
        >
          <BrandAvatar />
          <BrandWordmark accent={accent} rest={rest} />
        </TooltipTrigger>
        <TooltipContent>{"点击修改名称"}</TooltipContent>
      </Tooltip>
      <BrandDialog onOpenChange={setOpen} open={open} />
    </>
  );
}

function BrandDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="glass-modal brand-dialog max-w-[400px]">
        <DialogTitle className="font-semibold text-lg">{"修改名称"}</DialogTitle>
        <DialogDescription className="text-xs">
          {"左上角显示的名字。前一段是品牌红粗体，后一段是细体。只对你自己生效。"}
        </DialogDescription>
        {open ? <BrandForm onSaved={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function BrandForm({ onSaved }: { onSaved: () => void }) {
  const queryClient = useQueryClient();
  const { userId } = useUserPreferences();
  const current = useBrandName();
  const [accent, setAccent] = useState(current.accent);
  const [rest, setRest] = useState(current.rest);
  const save = useMutation(saveUserPreferencesMutationOptions(queryClient, userId));

  // 保存成功后让按钮先显示「已保存」再关闭。
  useEffect(() => {
    if (!save.isSuccess) return;
    const timer = setTimeout(onSaved, 700);
    return () => clearTimeout(timer);
  }, [save.isSuccess, onSaved]);

  const empty = !accent.trim() && !rest.trim();
  const preview = empty
    ? { accent: DEFAULT_USER_PREFERENCES.brandAccent, rest: DEFAULT_USER_PREFERENCES.brandRest }
    : { accent: accent.trim(), rest: rest.trim() };
  const dirty = accent.trim() !== current.accent || rest.trim() !== current.rest;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ brandAccent: accent.trim(), brandRest: rest.trim() });
  };

  return (
    <form className="brand-form" onSubmit={submit}>
      <div className="brand-preview">
        <BrandWordmark accent={preview.accent} rest={preview.rest} />
      </div>
      <div className="brand-fields">
        <label className="profile-field">
          <span>{"红色部分"}</span>
          <Input
            autoFocus
            maxLength={24}
            onChange={(e) => setAccent(e.target.value)}
            placeholder={DEFAULT_USER_PREFERENCES.brandAccent}
            value={accent}
          />
        </label>
        <label className="profile-field">
          <span>{"细体部分"}</span>
          <Input
            maxLength={24}
            onChange={(e) => setRest(e.target.value)}
            placeholder={DEFAULT_USER_PREFERENCES.brandRest}
            value={rest}
          />
        </label>
      </div>
      {save.isError ? (
        <p className="text-destructive text-xs" role="alert">
          {save.error instanceof Error ? save.error.message : "保存失败"}
        </p>
      ) : null}
      <div className="brand-actions">
        <Button
          onClick={() => {
            setAccent(DEFAULT_USER_PREFERENCES.brandAccent);
            setRest(DEFAULT_USER_PREFERENCES.brandRest);
          }}
          type="button"
          variant="ghost"
        >
          {"恢复默认"}
        </Button>
        <Button disabled={!dirty} feedback="save" mutation={save} type="submit">
          {"保存"}
        </Button>
      </div>
    </form>
  );
}
