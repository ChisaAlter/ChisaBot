import { useEffect, useState } from "react";
import { lazyDialog } from "@/components/ui/lazy-dialog";

type AccountDialog = "profile" | "pair-phone" | "brand";
const OPEN_EVENT = "chisabot-account-dialog";
const ProfileDialog = lazyDialog(() =>
  import("./profile-dialog").then((m) => m.ProfileDialog),
);
const PairPhoneDialog = lazyDialog(() =>
  import("@/components/devices/pair-phone").then((m) => m.PairPhoneDialog),
);
const BrandDialog = lazyDialog(() =>
  import("./brand-mark").then((m) => m.BrandDialog),
);

export function preloadAccountDialogs() {
  ProfileDialog.preload();
  PairPhoneDialog.preload();
}

export function openAccountDialog(dialog: AccountDialog) {
  window.dispatchEvent(
    new CustomEvent<AccountDialog>(OPEN_EVENT, { detail: dialog }),
  );
}

/** Owned by the signed-in route, not by the desktop/mobile copies of each trigger. */
export function AccountDialogsHost() {
  const [active, setActive] = useState<AccountDialog | null>(null);
  useEffect(() => {
    const open = (event: Event) =>
      setActive((event as CustomEvent<AccountDialog>).detail);
    window.addEventListener(OPEN_EVENT, open);
    return () => window.removeEventListener(OPEN_EVENT, open);
  }, []);
  const close = (open: boolean) => {
    if (!open) setActive(null);
  };
  return (
    <>
      <ProfileDialog open={active === "profile"} onOpenChange={close} />
      <PairPhoneDialog open={active === "pair-phone"} onOpenChange={close} />
      <BrandDialog open={active === "brand"} onOpenChange={close} />
    </>
  );
}
