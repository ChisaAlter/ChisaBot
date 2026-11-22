import { createFileRoute } from "@tanstack/react-router";
import { UpdatesScreen } from "@/components/system-update/updates-screen";

export const Route = createFileRoute("/_authed/settings/updates")({
  component: UpdatesScreen,
});
