import { createFileRoute } from "@tanstack/react-router";
import { UpdatesScreen } from "@/routes/_authed/admin/system-update";

export const Route = createFileRoute("/_authed/settings/updates")({
  component: UpdatesScreen,
});
