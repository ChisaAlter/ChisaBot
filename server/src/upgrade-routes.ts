import { VOICE_WS_PATH } from "../../shared/voice-call";
import type { AuthenticatedActor } from "./auth/guards";
import { isValidRecordingId } from "./computer/demonstration-store";
import { streamPathBotId } from "./computer/stream-path";
import type { VoiceCallService, VoiceSocketData } from "./voice/voice-routes";

export const COMPUTER_STREAM_WS_PATH = "/api/computers/:botId/stream";

export const UPGRADE_ROUTES = [
  { method: "GET", path: VOICE_WS_PATH },
  { method: "GET", path: COMPUTER_STREAM_WS_PATH },
] as const;

/** What each proxied computer screen socket carries: where to connect inward, and the socket once opened. */
export type ComputerStreamSocketData = {
  upstream: string;
  ownerUserId: string;
  botId: string;
  recordingId?: string;
  inward?: WebSocket;
  detachLive?: () => void;
};

export type UpgradeSocketData = VoiceSocketData | ComputerStreamSocketData;

export type UpgradeServer = {
  upgrade(
    request: Request,
    options: {
      data: UpgradeSocketData;
      headers?: Record<string, string>;
    },
  ): boolean;
};

export type UpgradeDispatcherDeps = {
  voiceCallService: Pick<
    VoiceCallService,
    "prepareUpgrade" | "releaseFailedUpgrade"
  >;
  computerConfigured: boolean;
  resolveRequestActor: (
    request: Request,
  ) => Promise<Pick<AuthenticatedActor, "id" | "role">>;
  canAccessComputer: (
    actor: Pick<AuthenticatedActor, "id" | "role">,
    botId: string,
  ) => Promise<boolean>;
  isActiveRecording: (
    ownerUserId: string,
    botId: string,
    recordingId: string,
  ) => boolean;
  locateComputer: (botId: string) => Promise<string | undefined>;
  toStreamUrl: (baseUrl: string, botId: string, recordingId?: string) => string;
};

/**
 * Bun.serve pre-Hono WebSocket upgrade dispatcher.
 *
 * Extracted so `route-auth-inventory.test.ts` can enumerate and exercise the exact same
 * authentication and ownership guards that run before `app.fetch`. Returns `null` when the
 * request is not one of the registered upgrade routes.
 */
export function createUpgradeDispatcher(deps: UpgradeDispatcherDeps) {
  return async function handleUpgrade(
    request: Request,
    url: URL,
    server: UpgradeServer,
  ): Promise<Response | undefined | null> {
    if (
      url.pathname === VOICE_WS_PATH &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      const upgraded = await deps.voiceCallService.prepareUpgrade(request);
      if (!upgraded.ok) {
        return new Response(upgraded.message, { status: upgraded.status });
      }
      if (
        server.upgrade(request, {
          data: upgraded.data,
          headers: { "sec-websocket-protocol": upgraded.protocol },
        })
      ) {
        return undefined;
      }
      deps.voiceCallService.releaseFailedUpgrade(upgraded.data);
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }

    const streamBotId = streamPathBotId(url.pathname);
    if (
      streamBotId !== null &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      if (!deps.computerConfigured) {
        return new Response("No computer is configured.", { status: 503 });
      }
      // The session guard, applied by hand because middleware does not run on an upgrade. An
      // unauthenticated socket here would be the whole point of the proxy defeated.
      const actor = await deps.resolveRequestActor(request).catch(() => null);
      if (!actor) {
        return new Response("Sign in first.", { status: 401 });
      }
      // And which Bot, which the guard above does not answer. This socket carries that Bot's screen,
      // so signing in is not enough: without this, anybody signed in watches anybody's Bot work. And
      // seeing a Team Bot is not enough either: its screen is its owner's signed-in browser.
      if (
        !(await deps.canAccessComputer(
          { id: actor.id, role: actor.role },
          streamBotId,
        ))
      ) {
        return new Response("There is no such Bot.", { status: 404 });
      }
      /*
       * Through the gateway, not the provider.
       *
       * `gateway.locate` runs checkComputerAddress; `provider.locate` does not, and the URL built
       * below carries COMPUTER_TOKEN in its query string. A provider that answered with a foreign
       * host was handed the deployment's computer token, which is the case that check was written
       * for. Every acting path already went through the gateway; this one did not.
       */
      const rawRecording = url.searchParams.get("recording");
      const recordingId =
        isValidRecordingId(rawRecording) &&
        deps.isActiveRecording(actor.id, streamBotId, rawRecording)
          ? rawRecording
          : undefined;
      let upstream: string;
      try {
        const streamBase = await deps.locateComputer(streamBotId);
        if (!streamBase) {
          return new Response("No computer address is configured.", {
            status: 503,
          });
        }
        upstream = deps.toStreamUrl(streamBase, streamBotId, recordingId);
      } catch (error) {
        // Said out loud rather than falling back to another Bot's computer, which is the failure this
        // whole path exists to prevent.
        return new Response(
          error instanceof Error
            ? error.message
            : "That Bot's computer could not be reached.",
          { status: 502 },
        );
      }
      if (
        server.upgrade(request, {
          data: {
            upstream,
            ownerUserId: actor.id,
            botId: streamBotId,
            ...(recordingId ? { recordingId } : {}),
          },
        })
      ) {
        return undefined;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }

    return null;
  };
}
