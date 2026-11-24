/**
 * Route inventory for the authorization-registry gate (see
 * server/tests/route-auth-inventory.test.ts).
 *
 * Builds the production-shaped Hono app — createApp plus every `extraRoutes` surface that
 * server/src/index.ts mounts — with store and service dependencies replaced by inert stubs, so
 * the complete registered route table (`app.routes`) can be enumerated without a database.
 *
 * Two stub mechanisms:
 *
 * - `hole`: a black-hole proxy. Any property read returns `hole`, calling it returns `hole`,
 *   awaiting it resolves to `hole`, iterating it is empty. Route builders hold dependencies and
 *   only call them inside request handlers, so construction succeeds and every route registers.
 *   Where construction-time reads change *which routes register* (feature flags, mount
 *   conditionals), the option is passed explicitly instead of through `hole`.
 *
 * - `depsOf({requireUser})`: for `createXRoutes(deps)` factories, a proxy that serves the real
 *   values it was given and `hole` for everything else, so the real session guard is wired while
 *   stores stay inert.
 *
 * The `extraRoutes` list here mirrors server/src/index.ts by hand. The gate test statically
 * sweeps index.ts and app.ts for mount literals and fails if a mount is not represented here,
 * so the list cannot silently drift from production wiring.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono, MiddlewareHandler } from "hono";
import { createExecutionNodeStore } from "../../src/admin/execution-node-store";
import { createHarnessSettingsService } from "../../src/admin/harness-settings";
import { createAdminSmokeRoutes } from "../../src/admin-smoke";
import { createContextPolicyStore } from "../../src/agents/context-policy-store";
import { createHistorySummaryModelService } from "../../src/agents/history-summary-settings";
import { createRuntimeKernelRoutes } from "../../src/agents/kernel-status";
import { createModelFallbackService } from "../../src/agents/model-fallback-settings";
import { createModelObservationService } from "../../src/agents/model-observation";
import type { AgentProfileStore } from "../../src/agents/profile-store";
import type { AgentProfile } from "../../src/agents/profile-types";
import { createRoutingAdminRoutes } from "../../src/agents/routing-log";
import { createApp } from "../../src/app";
import { createSpeechService } from "../../src/audio/speech-service";
import type { AppVariables, AuthService } from "../../src/auth/guards";
import { requireAdmin } from "../../src/auth/guards";
import { createBotAvatars } from "../../src/bot-avatars/service";
import { createBotThreads } from "../../src/bot-threads";
import { createBrowserBookmarks } from "../../src/browser-bookmarks/service";
import { createChunkedUploadService } from "../../src/chat-files/chunked-upload";
import { createBotLibraryService } from "../../src/chat-files/library-service";
import { createMediaPoolService } from "../../src/chat-files/media-pool-service";
import { createChatFiles } from "../../src/chat-files/service";
import { createChatShots } from "../../src/chat-shots";
import { createDesktopBrowserBridge } from "../../src/computer/desktop-browser-bridge";
import { loadConfig } from "../../src/config";
import { createConfirmations } from "../../src/confirmations/service";
import { mountConversationRuntime } from "../../src/conversation-runtime";
import { createConversationInteractions } from "../../src/conversations/interactions";
import { createSideThreadRoutes } from "../../src/conversations/side-threads";
import { createDshToolGateway } from "../../src/conversations/tool-gateway";
import { createForegroundRegistry } from "../../src/delivery/foreground-registry";
import { createPushService } from "../../src/delivery/push-service";
import { createQuickIntents } from "../../src/delivery/quick-intents";
import { createDeviceHub } from "../../src/devices/hub";
import { createDeviceRoutes } from "../../src/devices/routes";
import { createDeviceStore } from "../../src/devices/store";
import {
  createFederationRoutes,
  createFederationService,
} from "../../src/federation/routes";
import { createGithub } from "../../src/github/service";
import { createImService } from "../../src/im/service";
import { createLinkPreviews } from "../../src/link-preview/service";
import { createLivePanelService } from "../../src/live-panels/service";
import { createLocalAgentService } from "../../src/local-agents/service";
import { createMemoryNotes } from "../../src/memory-notes/service";
import { createOpsBudgetRoutes } from "../../src/ops-budget";
import { createOpsHealthRoutes } from "../../src/ops-health";
import { createPages } from "../../src/pages/service";
import { createPanelServices } from "../../src/panels/service";
import { createPersonalSources } from "../../src/personal-sources/service";
import { createAppBuilderRoutes } from "../../src/plugins/app-builder";
import { createMcpEnhancementRoutes } from "../../src/plugins/mcp-enhancements";
import { createPromptWorkbenchRoutes } from "../../src/prompts/routes";
import { createUsageBreakdownService } from "../../src/quotas/usage-breakdown";
import { createEmailTriggerRoutes } from "../../src/responsibilities/email";
import { createTriggerIngressRoutes } from "../../src/responsibilities/trigger-routes";
import { createWebhookPanelRoutes } from "../../src/responsibilities/webhook-panel-routes";
import {
  createInternalQuiesceRoutes,
  getRuntimeQuiesceController,
} from "../../src/runtime/quiesce";
import { createSchedules } from "../../src/schedules/service";
import { createSharingRoutes } from "../../src/sharing/routes";
import { createSharingService } from "../../src/sharing/service";
import { createChisaSkills } from "../../src/skills-chisa/tools";
import { createSystemUpdateRoutes } from "../../src/system-update";
import { createTaskCenterRuntime } from "../../src/task-center/runtime";
import {
  createUpgradeDispatcher,
  UPGRADE_ROUTES,
} from "../../src/upgrade-routes";
import { createVault } from "../../src/vault/service";
import { createVoiceCallService } from "../../src/voice/voice-routes";
import { createWebSearchSettingsStore } from "../../src/web/search-settings";
import { createWebSearchRoutes } from "../../src/web/tools";
import { createWorkflowRoutes } from "../../src/workflows/routes";
import { testEnvironment } from "./environment";

/**
 * Inert dependency: every property reads as another `hole`, it is callable and awaitable, and it
 * iterates as empty. Typed `never` so it is assignable to any dependency slot.
 */
const hole: never = new Proxy(() => hole, {
  get(_target, property) {
    if (property === "then") return undefined;
    if (property === Symbol.iterator) return () => [][Symbol.iterator]();
    if (property === Symbol.asyncIterator)
      return () => ({ next: async () => ({ done: true, value: undefined }) });
    if (property === Symbol.toPrimitive) return () => "";
    if (property === "valueOf") return () => 0;
    if (property === "toString") return () => "";
    return hole;
  },
  apply: () => hole,
}) as never;

/**
 * Deps object for `createXRoutes(deps)` factories: the provided real values win, everything else
 * reads as `hole`, so the real middleware reaches the route while stores stay inert.
 */
function depsOf<T extends object>(real: Partial<T> & object): T {
  return new Proxy(real, {
    get(target, property) {
      return property in target
        ? (target as Record<PropertyKey, unknown>)[property]
        : hole;
    },
  }) as T;
}

export { UPGRADE_ROUTES };

export type InventorySession =
  | { kind: "anonymous" }
  | { kind: "member"; userId: string }
  | { kind: "admin"; userId: string };

/**
 * Production-shaped pre-Hono WebSocket upgrade handler (`server/src/upgrade-routes.ts`)
 * wired with real `createVoiceCallService` ticket verification and real `computerAccessCheck`
 * over controllable session / profile stubs so `route-auth-inventory.test.ts` covers Bun.serve
 * upgrade routes.
 */
export function buildInventoryUpgradeHandler(
  session: InventorySession,
  options: {
    botProfile?: Partial<AgentProfile> | null;
    computerConfigured?: boolean;
  } = {},
) {
  const voiceCallService = createVoiceCallService(
    depsOf({
      trustedOrigins: [],
      checkReady: async () => ({ asrReady: true, ttsReady: true }),
      resolveTargetChannel: hole,
      transcribe: hole,
      synthesizeStream: hole,
      runBotTurn: hole,
    }),
  );

  return createUpgradeDispatcher({
    voiceCallService,
    isComputerConfigured: () => options.computerConfigured ?? true,
    resolveRequestActor: async () => {
      if (session.kind === "anonymous") {
        throw new Error("Unauthorized");
      }
      return {
        id: session.userId,
        role: session.kind === "admin" ? "admin" : "user",
      };
    },
    agentProfiles: {
      get: async (_actor, botId) => {
        if (options.botProfile === null) {
          throw new Error("Agent not found");
        }
        return {
          id: botId,
          visibility: "private",
          ownerUserId: "inventory-owner",
          ...options.botProfile,
        } as unknown as Awaited<ReturnType<AgentProfileStore["get"]>>;
      },
    },
    isActiveRecording: () => false,
    locateComputer: async () => "http://127.0.0.1:9999",
    toStreamUrl: (_baseUrl, botId) => `ws://127.0.0.1:9999/stream/${botId}`,
  });
}

function authFor(session: InventorySession): AuthService {
  return {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () =>
        session.kind === "anonymous"
          ? null
          : {
              user: {
                id: session.userId,
                email: `${session.userId}@chisabot.test`,
                name: `Inventory ${session.kind}`,
                image: null,
              },
            },
    },
  };
}

/**
 * The production app with every mount-gating dependency stubbed. `extraRoutes` replicates
 * server/src/index.ts's mount list with the real route builders over `hole` services; the gate
 * test's static mount sweep fails if this list drifts from index.ts.
 */
export async function buildInventoryApp(
  session: InventorySession,
): Promise<Hono<{ Variables: AppVariables }>> {
  const config = loadConfig(testEnvironment());
  const auth = authFor(session);
  const roleRepository = {
    rolesForUser: async () =>
      [session.kind === "admin" ? "admin" : "user"] as ("user" | "admin")[],
  };

  const conversationHandler = mountConversationRuntime(
    config,
    hole,
    hole,
    hole,
    { localBackend: hole },
  ).handler;

  const panels = createPanelServices(
    depsOf({
      database: hole,
      permissions: async () => ({ canManage: true, canInteract: true }),
      adapters: [],
      audit: async () => {},
    }),
  );

  // index.ts service graph, replicated with `hole` dependencies. Construction order is free —
  // `.routes()` output does not depend on it.
  const dshToolGateway = createDshToolGateway(hole);
  const modelFallbacks = createModelFallbackService(hole);
  const conversationInteractions = createConversationInteractions(hole, hole);
  const historySummaryModel = createHistorySummaryModelService(hole);
  const contextPolicyStore = createContextPolicyStore(hole);
  const webSearchSettings = createWebSearchSettingsStore(hole, hole);
  const webhookPanelStore = hole;
  const botLibrary = createBotLibraryService(hole);
  const systemUpdate = hole;
  const livePanelService = createLivePanelService(hole);
  const chatShots = await createChatShots(hole);
  const botThreads = await createBotThreads(hole);
  const sideThreads = hole;
  const imService = createImService(hole);
  const speechService = createSpeechService(hole);
  const voiceCallService = createVoiceCallService(hole);
  const memoryNotes = createMemoryNotes(hole, hole);
  const botAvatars = createBotAvatars(hole, hole);
  const browserBookmarks = createBrowserBookmarks(hole, hole);
  const chisaSkills = createChisaSkills(hole);
  const vault = createVault(hole, hole);
  const github = createGithub(
    hole,
    depsOf({ apiBase: "https://api.github.test" }),
  );
  const personalSources = createPersonalSources(hole, hole);
  const pages = createPages(hole, hole);
  const schedules = createSchedules(hole, hole);
  const taskCenter = createTaskCenterRuntime(hole);
  const localAgents = createLocalAgentService(hole);
  const chunkedUploads = createChunkedUploadService(
    depsOf({ tempRoot: join(tmpdir(), "chisabot-route-inventory") }),
  );
  const chatFiles = createChatFiles(hole, hole);
  const desktopBrowserBridge = createDesktopBrowserBridge(hole);
  const confirmations = createConfirmations(hole, hole);
  const mediaPool = createMediaPoolService(hole, hole);
  const linkPreviews = await createLinkPreviews(hole, hole);
  const deviceStore = createDeviceStore(hole);
  const deviceHub = createDeviceHub(
    depsOf({ store: deviceStore, confirm: hole }),
  );
  const pushService = createPushService(hole);
  const foregroundRegistry = createForegroundRegistry(hole);
  const quickIntents = createQuickIntents(hole);
  const usageBreakdownService = createUsageBreakdownService(hole);
  const modelObservationService = createModelObservationService();
  const harnessSettingsService = createHarnessSettingsService(hole);
  const promptWorkbenchStore = hole;
  const sharingService = createSharingService(hole);
  const mcpEnhancementStore = hole;
  // Real services where the auth behaviour under test lives inside them: the federation
  // service verifies Ed25519 envelopes in-process, and the execution-node store's routes()
  // builder owns its requireAdmin checks. Both are pure/in-memory given an inert storage.
  const executionNodeStore = createExecutionNodeStore({
    storage: hole,
    encryptionKey: "inventory-key",
    auditStore: hole,
    staticFallbackProvider: null,
  });
  const federationService = createFederationService({
    encryptionKey: "inventory-key",
  });

  return createApp(
    config,
    auth,
    roleRepository,
    hole, // auditReader
    hole, // credentialService
    hole, // packageStatusReader
    conversationHandler,
    hole, // computerGateway
    hole, // computerPolicy
    hole, // agentProfileStore
    hole, // channelStore
    hole, // channelEvents
    hole, // auditStore
    hole, // componentStore
    hole, // pluginStore
    hole, // sandboxedStore
    hole, // threadIdentity
    hole, // peopleStore
    undefined, // _removedIdentityProviders
    undefined, // _intentRouter
    hole, // pageFrames
    undefined, // _removedRoutineRunner
    undefined, // _removedRoutineStore
    hole, // onboardingStore
    hole, // userInstructions
    hole, // attachmentDatabase
    undefined, // _removedHostAccessBroker
    "inventory-desktop-host-token", // desktopHostToken: mounts /api/desktop/connection-failure
    hole, // deploymentToolCaller
    { broker: hole }, // composio
    hole, // modelProviderProxy: mounts /api/model-provider/v1/chat/completions
    hole, // userPreferences
    undefined, // _removedVoiceSessions
    undefined, // _removedLearning
    {
      approvals: hole,
      passwords: hole,
      responsibilities: {
        store: hole,
        engine: hole,
        bindings: hole,
        triggers: {
          store: hole,
          emailDomain: "inventory.test",
          ingressRoutes: createTriggerIngressRoutes(hole),
          emailRoutes: createEmailTriggerRoutes(hole),
        },
      },
      lifecycle: hole,
      groups: hole,
    },
    hole, // localBackend
    hole, // modelSettings
    hole, // agentModels
    hole, // modelCatalog
    panels,
    hole, // magpie
    {
      extraRoutes: ({
        requireUser,
      }: {
        requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
      }) => [
        // Mirrors server/src/index.ts `extraRoutes`, including the two conditional mounts
        // (dsh-tools, local-agents) so the registry covers them too.
        ["/api/internal/dsh-tools", dshToolGateway.routes],
        [
          "/api/admin/smoke",
          createAdminSmokeRoutes(
            depsOf({
              requireUser,
              resolveConnection: hole,
              resolveConnectionForAgent: hole,
            }),
          ),
        ],
        ["/api/ops/budget", createOpsBudgetRoutes(depsOf({ requireUser }))],
        [
          "/api/admin/health",
          createOpsHealthRoutes(
            depsOf({
              requireUser,
              pingDatabase: hole,
              probeAssistant: hole,
              magpie: hole,
              gatewayMode: "on",
              dshRequired: true,
              probeDsh: hole,
              probeComputer: hole,
            }),
          ),
        ],
        ["/api/admin/model-fallbacks", modelFallbacks.routes(requireUser)],
        [
          "/api/conversation-interactions",
          conversationInteractions.routes(requireUser),
        ],
        [
          "/api/admin/history-summary-model",
          historySummaryModel.routes(requireUser),
        ],
        ["/api/admin/context-policies", contextPolicyStore.routes(requireUser)],
        [
          "/api/web-search",
          createWebSearchRoutes(
            depsOf({ store: webSearchSettings, requireUser }),
          ),
        ],
        [
          "/api/webhooks",
          createWebhookPanelRoutes(
            depsOf({ store: webhookPanelStore, requireUser }),
          ),
        ],
        ["/api/bots", botLibrary.routes(requireUser)],
        [
          "/api/admin/runtime-kernel",
          createRuntimeKernelRoutes(
            depsOf({ requireUser, kernel: "dsh", probeDsh: hole }),
          ),
        ],
        [
          "/api/admin/system-update",
          createSystemUpdateRoutes(
            depsOf({ service: systemUpdate, requireUser, auditStore: hole }),
          ),
        ],
        ["/api/live-panels", livePanelService.routes(requireUser)],
        ["/api/chat-shots", chatShots.routes(requireUser)],
        ["/api/bot-threads", botThreads.routes(requireUser)],
        [
          "/api/side-threads",
          createSideThreadRoutes(
            sideThreads,
            requireUser,
            depsOf({ steerParentThread: hole }),
          ),
        ],
        ["/api/im", imService.routes(requireUser)],
        ["/api/speech", speechService.routes(requireUser, requireAdmin)],
        ["/api/voice", voiceCallService.routes(requireUser)],
        ["/api/memory-notes", memoryNotes.routes(requireUser)],
        ["/api/bot-avatars", botAvatars.routes(requireUser)],
        ["/api/browser-bookmarks", browserBookmarks.routes(requireUser)],
        ["/api/chisa-skills", chisaSkills.routes(requireUser)],
        ["/api/vault", vault.routes(requireUser)],
        ["/api/github", github.routes(requireUser)],
        ["/api/personal-sources", personalSources.routes(requireUser)],
        ["/api/pages", pages.routes(requireUser)],
        ["/p", pages.publicRoutes()],
        ["/api/schedules", schedules.routes(requireUser)],
        ["/api/task-center", taskCenter.routes(requireUser)],
        ["/api/local-agents", localAgents.routes(requireUser)],
        ["/api/chat-files/chunked", chunkedUploads.routes(requireUser)],
        ["/api/chat-files", chatFiles.routes(requireUser)],
        ["/api/desktop-browser", desktopBrowserBridge.routes(requireUser)],
        ["/api/confirmations", confirmations.routes(requireUser)],
        ["/api/media-models", chatFiles.media.routes(requireUser)],
        ["/api/media-pool", mediaPool.routes(requireUser)],
        ["/api/bots", mediaPool.botAvatarRoutes(requireUser)],
        ["/api/link-preview", linkPreviews.routes(requireUser)],
        [
          "/api/workflows",
          createWorkflowRoutes(
            depsOf({
              store: hole,
              engine: hole,
              requireUser,
              auditStore: hole,
              librarySkillSlugs: hole,
              createPausedSchedule: hole,
            }),
          ),
        ],
        [
          "/api/devices",
          createDeviceRoutes(
            depsOf({
              store: deviceStore,
              hub: deviceHub,
              requireUser,
              auditStore: hole,
              toolsFor: hole,
              checkPcRelease: hole,
              appDistDir: ".",
              localCallerSecret: "inventory-local-secret",
            }),
          ),
        ],
        ["/api/push", pushService.routes(requireUser)],
        [
          "/api/notifications/foreground",
          foregroundRegistry.routes(requireUser),
        ],
        ["/api/intents", quickIntents.routes(requireUser)],
        [
          "/api/admin/routing",
          createRoutingAdminRoutes(
            depsOf({
              storage: hole,
              router: hole,
              requireUser,
              getDefaultModel: hole,
              getProviderKind: hole,
            }),
          ),
        ],
        ["/api/usage", usageBreakdownService.routes(requireUser)],
        ["/api/admin/observation", modelObservationService.routes(requireUser)],
        ["/api/admin/harness", harnessSettingsService.routes(requireUser)],
        [
          "/api/admin/prompts",
          createPromptWorkbenchRoutes(
            depsOf({ store: promptWorkbenchStore, requireUser }),
          ),
        ],
        ["/api/sharing", createSharingRoutes(sharingService, requireUser)],
        [
          "/api/apps",
          createAppBuilderRoutes(
            depsOf({
              store: hole,
              runner: hole,
              requireUser,
              encryptionKey: "inventory-key",
              resolveSessionUserId: hole,
            }),
          ),
        ],
        [
          "/api/mcp-enhancements",
          createMcpEnhancementRoutes(
            depsOf({ store: mcpEnhancementStore, requireUser }),
          ),
        ],
        ["/api/admin/execution-nodes", executionNodeStore.routes(requireUser)],
        [
          "/api/internal",
          createInternalQuiesceRoutes(
            depsOf({
              controller: getRuntimeQuiesceController(),
              internalToken: "inventory-internal-token",
              requireUser,
            }),
          ),
        ],
        [
          "/api/federation",
          createFederationRoutes(
            depsOf({ service: federationService, requireUser }),
          ),
        ],
      ],
    },
  );
}
