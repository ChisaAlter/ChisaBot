import { useNavigate } from "@tanstack/react-router";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import {
  closeCreateBot,
  openCreateBot,
  useCreateBotOpen,
} from "@/lib/agents/create-bot";
import { togglePrivacyMask } from "@/lib/privacy-mask";
import { useHotkey } from "./use-hotkey";

/**
 * The app-wide shortcuts, bound once for the whole signed-in app — and the one create-bot dialog
 * every 「新建机器人」 entry opens (bot list ＋, collapsed rail ＋, Shift+N, landing empty state).
 *
 * Mounted in `_authed` rather than `_app`, so a person on settings or admin can create a Bot without
 * first clicking back into the app frame. There is no "new chat" shortcut any more: opening the app
 * is facing a Bot, and each Bot is one ongoing conversation.
 */
export function AppHotkeys() {
  const navigate = useNavigate();
  const open = useCreateBotOpen();

  useHotkey("new-bot", openCreateBot);
  useHotkey("privacy-mask", togglePrivacyMask);

  return (
    <CreateAgentDialog
      onClose={closeCreateBot}
      onCreated={(agentId) => {
        closeCreateBot();
        window.dispatchEvent(new Event("chisabot-close-drawer"));
        // Straight into the new Bot's chat; the roster selects it from the URL.
        void navigate({ to: "/channel/new", search: { agent: agentId } });
      }}
      open={open}
    />
  );
}
