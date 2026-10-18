import { createHash, randomUUID } from "node:crypto";
import { PanelError, type PanelCapability } from "../../shared/panels/types";
import { createPanelServices } from "./panels/service";
import { createNormalPanelTaskService } from "./panels/normal-task-service";
import { recoverPanelTaskStatus } from "./panels/task-status";
import { createGovernedPanelTaskAdapter } from "./panels/task-adapter";
import { panelTaskRequests } from "./db/schema/panels";
import { isDeepStrictEqual } from "node:util";
import type { AbstractAgent, Message } from "@ag-ui/client";
import {
  IntelligenceAgentRunner,
  type CopilotKitIntelligence,
} from "@copilotkit/runtime/v2";
import { serve } from "bun";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { COMPUTER_GUIDANCE } from "../../shared/bot-prompt";
import { DICTATION_HTTP_IDLE_SECONDS } from "../../shared/dictation";
import { buildResponsibilityTurn } from "../../shared/responsibility-turn";
import { workOwner } from "../../shared/work-owner";
import { createActivityStore } from "./activity/activity";
import {
  CoworkerUnavailableError,
  createActorAgentResolver,
} from "./agents/agent-resolver";
import {
  mintRunAssertion,
  type RunAssertion,
  readApprovedRunAssertion,
  readRunAssertion,
} from "./agents/callback-token";
import { canUseComputer, computerAccessCheck } from "./agents/computer-access";
import { createAgentFetch } from "./agents/endpoint";
import { createHandoffDesk, HANDOFF_KIND } from "./agents/handoff";
import { createHandoffDelivery } from "./agents/handoff-delivery";
import { createHandoffRunner } from "./agents/handoff-runner";
import { signHandoffDeliveryRun } from "./agents/handoff-signing";
import {
  authoriseCoordinationRun,
  createCoordinationTools,
  readCoordinationHandoffClaim,
} from "./agents/handoff-tool";
import {
  BotPausedError,
  configureBotLifecycle,
  createBotLifecycleStore,
} from "./agents/lifecycle";
import { createBotReset } from "./agents/lifecycle-reset";
import { createAgentPurge } from "./agents/purge";
import { createAgentProfileStore } from "./agents/profile-store";
import { createAgentModelService } from "./agents/model-selection";
import type { AgentActor } from "./agents/profile-types";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import {
  createWakeUpRunner,
  createWakeUpStore,
  wakeUpTools,
} from "./agents/wake-up";
import { createApp } from "./app";
import { createApprovedActionExecutor } from "./approvals/execute";
import {
  PERSON_QUESTION_WAITING,
  resumePersonQuestion,
} from "./approvals/question-resume";
import {
  createApprovalQuestions,
  type PersonQuestion,
  personQuestionSchema,
  questionConversationBot,
} from "./approvals/questions";
import {
  type ApprovalResumeDependencies,
  createApprovalService,
  isApprovalRecheck,
} from "./approvals/service";
import { createApprovalStore } from "./approvals/store";
import {
  ApprovalRefusedError,
  currentApprovalContext,
  parseApprovalContinuation,
  parseApprovalResult,
} from "./approvals/types";
import {
  type AuditInitiator,
  createAuditReader,
  createAuditStore,
  DEPLOYMENT_INITIATOR,
  PERSON_INITIATOR,
  recordAuditEvent,
} from "./audit";
import { startRetentionSweeps } from "./audit-retention";
import { createAuth } from "./auth";
import { DEV_ACTOR, initializeDevActorUser } from "./auth/dev-actor";
import type { AuthService } from "./auth/guards";
import { createRoleRepository } from "./auth/guards";
import { type OpenBotRole, setRole } from "./auth/roles";
import {
  createGatewayRequireUser,
  gatewaySecretFromEnvironment,
  resolveGatewayRequest,
} from "./auth/gateway-identity";
import type { AuthenticatedActor } from "./auth/guards";
import {
  loadAttachmentForTurn,
  markAttachmentsSent,
  setChannelUploadMirror,
} from "./channels/attachments";
import {
  createChannelEventHub,
  startChannelActivityListener,
} from "./channels/events";
import {
  createGroupConversations,
  createGroupStore,
  groupSourceForRun,
} from "./channels/group";
import { createChannelStore } from "./channels/routes";
import { websocket as channelSocket } from "./channels/socket";
import { createStallGuard } from "./channels/stall-guard";
import {
  forgetSettledSummaries,
  offerChannelsAwaitingSummary,
  summariseClaimedChannels,
} from "./channels/summary";
import { createThreadIdentity } from "./channels/thread-identity";
import { createChannelTitler } from "./channels/titler";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import { createComputerGateway } from "./computer/gateway";
import { onControlReleased } from "./computer/control-blocks";
import {
  createHeadlessComputerTools,
  HeadlessToolSuspension,
} from "./computer/headless-tools";
import { createPageFrameStore } from "./computer/page-frames";
import { startPolicyListener } from "./computer/policy-listener";
import {
  NO_NETWORK_POLICY,
  startEgressPolicyPush,
  withPolicyPushOnWake,
} from "./computer/policy-network";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "./computer/policy-store";
import {
  createComputerProvider,
  describeComputerIsolation,
} from "./computer/provider";
import { createSnapshotStore } from "./computer/snapshot-store";
import { streamPathBotId } from "./computer/stream-path";
import { loadConfig } from "./config";
import {
  type IdentifyActor,
  type IdentifyUser,
  mountCopilotRuntime,
  normalizeModelBaseUrls,
  runtimeModelForEnvironment,
  setModelOutputLimitResolver,
  setModelFallbackCatalog,
  setModelFallbackList,
  type ToolSelection,
} from "./copilot";
import {
  createCredentialAdminService,
  createCredentialStore,
  resolveModelApiKey,
} from "./credentials";
import { createDatabase } from "./db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  responsibilityRuns,
  users,
} from "./db/schema";
import { createDeliveryStore } from "./delivery/store";
import type { DeliveryScope } from "./delivery/types";
import { createDeviceHub } from "./devices/hub";
import { createDeviceRoutes } from "./devices/routes";
import { createDeviceStore } from "./devices/store";
import { deviceTools } from "./devices/tools";
import { executeRenderUi, renderUiTools } from "./generative-ui/render-ui";
import { RENDER_UI_TOOL } from "../../shared/json-render/catalog";
import { createIntelligenceClient } from "./intelligence-client";
import { createLocalConversations } from "./local-conversations";
import { createBotThreads } from "./bot-threads";
import { createChatShots } from "./chat-shots";
import { createImService, type ImService, imConnectionOf } from "./im/service";
import { createLinkPreviews } from "./link-preview/service";
import { createMemoryNotes } from "./memory-notes/service";
import { createBotAvatars } from "./bot-avatars/service";
import { createBrowserBookmarks } from "./browser-bookmarks/service";
import { createChisaSkills } from "./skills-chisa/tools";
import { createVault, VAULT_GUIDANCE } from "./vault/service";
import { createGithub } from "./github/service";
import { createPages } from "./pages/service";
import { createSchedules } from "./schedules/service";
import { createChannelUploadMirror } from "./chat-files/channel-mirror";
import { createChatFiles } from "./chat-files/service";
import { createConfirmations } from "./confirmations/service";
import { createSignInNotifier, createSignInResumer } from "./passwords/resume";
import { createSignInService } from "./passwords/service";
import { createPasswordStore } from "./passwords/store";
import { createOnboardingStore } from "./people/onboarding";
import { createPeopleStore } from "./people/store";
import { useComposioClient } from "./plugins/composio";
import { createComposioClient } from "./plugins/composio-adapter";
import { backfillComposioLogos } from "./plugins/logos";
import { redirectUriFor } from "./plugins/oauth";
import { createPluginStore } from "./plugins/store";
import {
  grantedSkills,
  grantedTools,
  REFUSAL_MARKER,
  vendorAnswer,
} from "./plugins/tools";
import {
  createPrivateShareCheck,
  PRIVATE_SHARE_TOOL_REF,
} from "./proactive/private-share";
import {
  createReadOnlyClassifier,
  guardProactiveCallback,
  restrictCoordinationForRun,
  restrictToolsForRun,
} from "./proactive/restriction";
import { createProviderOAuthProxy } from "./provider-oauth";
import { createResponsibilityBindingStore } from "./responsibilities/bindings";
import {
  createEmailTriggerRoutes,
  createSnsVerifier,
  fetchText as fetchSnsText,
  inboundEmailConfigFromEnv,
} from "./responsibilities/email";
import {
  createResponsibilityEngine,
  type ResponsibilityEngine,
} from "./responsibilities/engine";
import {
  createSlackTriggerIngest,
  slackAccessFrom,
  useSlackTriggerIngest,
} from "./responsibilities/slack";
import { createResponsibilityStore } from "./responsibilities/store";
import { responsibilityTools } from "./responsibilities/tools";
import { createTriggerIngressRoutes } from "./responsibilities/trigger-routes";
import { useTriggerTools } from "./responsibilities/trigger-tools";
import { createTriggerStore } from "./responsibilities/triggers";
import type { Responsibility } from "./responsibilities/types";
import { createTurnRunner } from "./turns/run-turn";
import { createWorkflowEngine, type WorkflowEngine } from "./workflows/engine";
import { createLivePanelService } from "./live-panels/service";
import { createLivePanelStore } from "./live-panels/store";
import { webTools } from "./web/tools";
import {
  restrictNamedToolsForWorkflow,
  restrictToolsForWorkflow,
} from "./workflows/policy";
import { createWorkflowRoutes } from "./workflows/routes";
import { createWorkflowStore } from "./workflows/store";
import { workflowChatTools } from "./workflows/tools";
import { createModelCompleter } from "./routing/model";
import {
  createModelSettingsService,
  createModelSettingsStore,
} from "./model-settings";
import {
  resolveScopedAgentModelConnection,
  resolveScopedModelConnection,
} from "./model-connection-context";
import { createModelCatalogService } from "./model-catalog";
import { createMagpieService, readMagpieWebKey } from "./magpie";
import { readRunningBuild } from "./build-info";
import { createSystemUpdateRoutes, createSystemUpdateService } from "./system-update";
import { createAdminSmokeRoutes } from "./admin-smoke";
import {
  createDatabasePinger,
  createOpsHealthRoutes,
} from "./ops-health";
import { createOpsBudgetRoutes } from "./ops-budget";
import { OPS_CODES } from "../../shared/ops-codes";
import { bumpOps } from "../../shared/ops-counters";
import { createModelFallbackService, createModelFallbackStore } from "./agents/model-fallback-settings";
import { createSelfHostBanner } from "./self-host-banner";
import { createTeamBots } from "./team-bots/team-bots";
import {
  createPackageStatusReader,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "./tenant-package";
import { markUntrusted } from "./untrusted-content";
import { createUserInstructionsStore } from "./user-instructions";
import { createUserPreferencesStore } from "./user-preferences";
import { repeatAfterEach } from "./work/loop";
import { createWorkerService, type WorkerService } from "./workers/service";
import { createLocalAgentService, type LocalAgentService } from "./local-agents/service";
import { createCloudCcService, type CloudCcService } from "./cloud-cc/service";
import { createCloudSyncService, type CloudSyncService } from "./cloud-cc/sync";
import { reasonWithoutStatement } from "./db/query-failure";
import {
  createWorkQueue,
  DEFAULT_MAX_ATTEMPTS,
  startWorkOfferedListener,
  type WorkOfferedListener,
} from "./work/queue";

/**
 * Who is asking, for a CopilotKit request.
 *
 * One resolver, because a run has two questions to answer about the same person: whose threads and
 * memory these are, and which coworkers they may run. Answering them from different places is how
 * one person ends up running another's private coworker, or reading their thread.
 */
async function resolveRequestActor(request: Request): Promise<{
  id: string;
  name: string;
  role: OpenBotRole;
}> {
  if (config.singleUser) {
    if (gatewaySecret) {
      const resolved = resolveGatewayRequest(gatewaySecret, request.headers);
      if (resolved.kind === "refuse") throw new Error("A CopilotKit run requires a signed-in user.");
      await provisionGatewayUser(resolved.actor);
      const actor = resolved.actor;
      return { id: actor.id, name: actor.id === DEV_ACTOR.id ? DEV_ACTOR.email : (actor.name ?? actor.id), role: actor.role };
    }
    return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
  }
  const session = await auth?.api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) {
    throw new Error("A CopilotKit run requires a signed-in user.");
  }
  const roles = user.role
    ? [user.role]
    : await roleRepository.rolesForUser(user.id);
  if (!roles.includes("admin") && !roles.includes("user")) {
    throw new Error("A CopilotKit run requires an authorized user.");
  }
  return {
    id: user.id,
    name: user.name ?? user.email ?? user.id,
    role: roles.includes("admin") ? "admin" : "user",
  };
}

/** The Intelligence projection of {@link resolveRequestActor}: threads are scoped to this person. */
const identifyUser: IdentifyUser = async (request) => {
  const { id, name } = await resolveRequestActor(request);
  return { id, name };
};

/**
 * The authorization projection of the same person: agent visibility is decided from this.
 *
 * An unauthenticated request resolves to a person who owns nothing rather than an error, so the
 * runtime can still describe itself, `/info` reports the licence and the public roster, which is
 * what a deployment check reads to tell "the licence is invalid" apart from "chat is silently
 * broken". It grants nothing: this actor matches no private profile and is not an administrator,
 * and a run still fails in `identifyUser`, which has no anonymous case because a thread must belong
 * to somebody.
 */
const ANONYMOUS_ACTOR = { id: "", role: "user" } as const;

const identifyActor: IdentifyActor = async (request) => {
  try {
    const { id, role } = await resolveRequestActor(request);
    return { id, role };
  } catch {
    return ANONYMOUS_ACTOR;
  }
};

const config = loadConfig();
// The environment seeds local policy once. The SDK fallback must not reapply an old revision
// after an administrator clears a pin to follow the latest published Skills.
// Read with the rest of the configuration, where an empty variable is an absent one. See
// `serverPort` in config.ts for what `process.env.PORT ?? …` did with `PORT=` instead.
const port = config.port;
const database = createDatabase(config.databaseUrl);
const localBackend =
  config.runtime.mode === "local"
    ? await createLocalConversations(database)
    : undefined;
// Every dispatch point asks this database whether its person paused the Bot. See agents/lifecycle.ts.
configureBotLifecycle({ database });
await initializeDevActorUser(database, config.singleUser);
// The vault, built before the agent store because a customer's agent may sit behind a key and that
// key belongs here rather than on the agent row. See agents/auth-header.ts.
const credentialStore = createCredentialStore(database);
const agentVault = {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
};
const agentProfileStore = createAgentProfileStore(
  database,
  config.managedAgent?.endpoint,
  agentVault,
);
// Read here rather than beside the synchronise below, because the package names the deployment and
// the channel store needs that name before it can mint a thread id.
const tenantPackage = await loadTenantPackage(config.tenantPackageDirectory);
const threadIdentity = createThreadIdentity(
  config.deploymentId ?? tenantPackage.tenantId,
);
const channelStore = createChannelStore(
  database,
  agentProfileStore,
  threadIdentity,
);
const channelEvents = createChannelEventHub();
// One reset for the profile screen's "重置" and for deleting a Bot, which starts with the same reset.
const botReset = createBotReset({
  database,
  softDeleteChannel: (actor, channelId) =>
    channelStore.softDelete(actor, channelId),
});
/**
 * Which components each Bot may answer with.
 *
 * Nothing is seeded here. The catalogue is a fact about the build; a fork that ships four components
 * of its own should start with four rows, and the only thing that can enumerate them is
 * the app that compiled them. It announces itself on load; this process learns what exists from that,
 * and owns only what may be done with it.
 */
const componentStore = createComponentStore(database);
// Its own connection is held for the life of the process; announced activity from any instance
// arrives here and is fanned out to connected members.
const channelActivityListener = await startChannelActivityListener(
  config.databaseUrl,
  channelEvents,
);
const roleRepository = createRoleRepository(database);
/**
 * 多账号（CB-040，docs/adr/0009-gateway-accounts.md）：单用户部署前面的登录网关签名告诉应用「这是谁」。
 * 第一次见到的朋友账号在 users / user_roles 建行；角色以网关为准（管理员在网关里改）。
 */
const gatewaySecret = config.singleUser ? gatewaySecretFromEnvironment(process.env) : undefined;
const provisionedGatewayUsers = new Map<string, { role: OpenBotRole; at: number }>();
async function provisionGatewayUser(actor: AuthenticatedActor): Promise<void> {
  if (actor.id === DEV_ACTOR.id) return;
  const seen = provisionedGatewayUsers.get(actor.id);
  if (seen && seen.role === actor.role && Date.now() - seen.at < 5 * 60_000) return;
  const inserted = await database
    .insert(users)
    .values({ id: actor.id, email: actor.email, name: actor.name ?? actor.id, emailVerified: false })
    .onConflictDoNothing()
    .returning({ id: users.id });
  await setRole(database, actor.id, actor.role);
  // 朋友第一次进来直接到聊天（自己的「助手」），不走上游的英文引导页；名字已在邀请页设好。
  if (inserted.length) await createOnboardingStore(database).complete(actor.id).catch(() => undefined);
  provisionedGatewayUsers.set(actor.id, { role: actor.role, at: Date.now() });
}
if (gatewaySecret) console.info(JSON.stringify({ type: "gateway-identity", enabled: true }));
const loadAgentsForActor = createRuntimeAgentLoader(
  database,
  agentVault,
  config.managedAgent,
);
await synchronizeTenantPackage(database, tenantPackage);
/*
 * Built before `auth`, because the deny list is consulted during sign-in and the store is what
 * holds it. It needs the administrator list too, so it can tell the screen which people the
 * deployment's configuration has already decided about.
 */
const peopleStore = createPeopleStore(
  database,
  config.auth?.initialAdminEmails ?? [],
  /*
   * Removing somebody retires the credentials they granted this deployment.
   *
   * A closure rather than the method itself, because the plugin store is built further down: this
   * has to exist before `auth` does, and that one needs the vault and the policy. Nothing calls this
   * during module initialisation — it runs when an administrator removes somebody, over HTTP — so by
   * then the binding is there.
   */
  (userId, by) => pluginStore.retireConnectionsFor(userId, by),
);
/*
 * Built before `auth` for the same reason the people store is: sign-in writes to the trail, and the
 * store that receives those rows has to exist before anything can sign in.
 */
const signInAuditStore = createAuditStore(database);
const auth: AuthService | undefined = config.auth
  ? createAuth(
      config,
      database,
      (email) => peopleStore.isRevoked(email),
      signInAuditStore,
    )
  : undefined;
// Each computer is pushed its network policy on the way to the action that woke it, because a
// computer refuses every connection until one arrives (see `withPolicyPushOnWake`).
const computerProvider = config.computer
  ? withPolicyPushOnWake(createComputerProvider(config.computer), {
      policyForBot: async () => NO_NETWORK_POLICY,
      ...(config.computer.token ? { token: config.computer.token } : {}),
    })
  : undefined;

if (computerProvider?.warm) {
  void computerProvider.warm();
}
// What Bots may do on their computers. Configuration supplies the deployment's default; an
// administrator can change it while running, and a restart returns to the configured one.
const policyStore = createPolicyStore(
  config.computer?.policy ?? DEFAULT_ACTION_POLICY,
  database,
);
// A boundary an administrator set is read back before the first action is decided, so a restart no
// longer silently returns to the configured default.
const policySource = await policyStore.load();
/*
 * And kept current afterwards.
 *
 * A boundary an administrator changes arrives at one server. Without this, every other server keeps
 * enforcing what it read at boot, so a new deny rule stops roughly one action in N while the screen
 * and the audit row both report success. See policy-listener.ts.
 */
const policyListener = await startPolicyListener(
  config.databaseUrl,
  policyStore,
);

/*
 * Record which boundary this process started with.
 *
 * The trail records the boundary a process starts with, so later audit reads can distinguish the
 * configured default from any administrator-updated policy that was persisted before restart.
 *
 * Not awaited and never fatal. A deployment must not fail to start because its audit trail is
 * unavailable, and the row is a note for a reader rather than something the server depends on.
 */
const bootAuditStore = createAuditStore(database);
// One store: the gateway writes through it, a route reads it, and the sweep below takes the old ones out.
const pageFrameStore = createPageFrameStore(database);
let deliveryNotifications: (
  scope: DeliveryScope,
  input: {
    id: string;
    text: string;
    kind: "reply" | "question" | "approval";
    requestId?: string;
  },
) => Promise<void> = async () => {
  // Slack / Teams / SMS / push delivery was removed in slimming P4b (no transport is configured on a
  // personal deployment). In-app notifications are unaffected; this stays as a no-op call site.
};
const authoriseQuestion = async (question: PersonQuestion) => {
  const source = await sourceForCoordinationRun({
    ...question,
    botId: questionConversationBot(question),
    depth: 0,
  });
  if (question.channelId && source?.channelId !== question.channelId)
    throw new ApprovalRefusedError("The saved question source has changed.");
  if (!source)
    throw new ApprovalRefusedError(
      "That conversation is no longer available to this Bot and person.",
    );
  if (
    !(await agentProfileStore.get(
      await actorFor(question.actorId),
      question.botId,
    ))
  )
    throw new ApprovalRefusedError("That Bot is no longer available to you.");
};
const storedApprovals = createApprovalStore(database);
const approvalService = createApprovalService(
  {
    ...storedApprovals,
    open: async (action) => {
      const request = await storedApprovals.open(action);
      if (request.status === "pending") {
        const forwarded = action.continuation?.forwardedProps;
        const signed =
          forwarded &&
          typeof forwarded === "object" &&
          "openbotRun" in forwarded
            ? readRunAssertion(forwarded.openbotRun, config.keyEncryptionKey)
            : null;
        const run =
          signed &&
          signed.actorId === action.actorId &&
          signed.botId === action.botId
            ? signed
            : {
                actorId: action.actorId,
                botId: action.botId,
                runId: action.runId,
                threadId: action.threadId,
                depth: 0,
              };
        const source = await sourceForCoordinationRun(run);
        const botName = source
          ? ((
              await agentProfileStore
                .get(await actorFor(action.actorId), action.botId)
                .catch(() => null)
            )?.name ?? action.botId)
          : action.botId;
        if (source && run.threadId)
          await deliveryNotifications(
            {
              ownerUserId: action.actorId,
              channelId: source.channelId,
              agentId: source.botId,
              threadId: run.threadId,
            },
            {
              id: request.id,
              kind: "approval",
              requestId: request.id,
              text: `${botName} asks for approval to use ${action.toolRef}. Open your ChisaBot approval inbox to review this action.`,
            },
          );
      }
      return request;
    },
  },
  createApprovalQuestions(database, authoriseQuestion),
  async (ownerUserId, botId, snapshot) => {
    const source = await sourceForCoordinationRun({
      actorId: ownerUserId,
      botId,
      threadId: snapshot.threadId,
      runId: snapshot.runId,
      depth: 0,
      initiator: PERSON_INITIATOR,
    });
    if (!source)
      throw new ApprovalRefusedError(
        "That conversation is no longer available to this Bot and person.",
      );
    // Intelligence saves a streaming run's messages a moment behind the stream, and the browser runs
    // the tool as soon as the call arrives. A call that is not saved yet is waited for briefly; one
    // that never appears is refused below.
    let history = await routineIntelligence.getThreadMessages({
      threadId: snapshot.threadId,
      userId: ownerUserId,
    });
    const findCall = () =>
      history.messages
        .flatMap((message) => message.toolCalls ?? [])
        .find((call) => call.id === snapshot.toolCallId);
    for (let attempt = 0; !findCall() && attempt < 10; attempt++) {
      await Bun.sleep(500);
      history = await routineIntelligence.getThreadMessages({
        threadId: snapshot.threadId,
        userId: ownerUserId,
      });
    }
    const canonicalCall = findCall();
    if (
      !canonicalCall ||
      canonicalCall.name !== snapshot.toolName ||
      !isDeepStrictEqual(JSON.parse(canonicalCall.args), snapshot.args) ||
      history.messages.some(
        (message) =>
          message.role === "tool" && message.toolCallId === snapshot.toolCallId,
      )
    )
      throw new ApprovalRefusedError(
        "That unanswered tool call is not saved in this conversation.",
      );
    const tools = await approvalComputerTools(
      ownerUserId,
      botId,
      PERSON_INITIATOR,
    );
    const tool = tools.find(
      (tool) => tool.definition.name === snapshot.toolName,
    );
    if (!tool)
      throw new ApprovalRefusedError("That computer tool is not available.");
    return tool.execute(snapshot.args, {
      toolCallId: snapshot.toolCallId,
      signal: new AbortController().signal,
    });
  },
  { review: (prompt, signal) => chooseSkills(prompt, signal) },
);
// Housekeeping on a schedule: audit rows when asked for, screenshots always, one timer. See audit-retention.ts.
const retentionSweeps = startRetentionSweeps(
  config.databaseUrl,
  config.auditRetentionDays,
  pageFrameStore,
);
/**
 * 确认卡片 + 审批偏好（server/src/confirmations，DESIGN.md §58）。云端浏览器：用户在聊天里确认过付款
 * （confirm_action 类别 purchase）之后，这段对话 20 分钟内的浏览器操作不再被上游的付款安全规则交还给人。
 */
const confirmations = createConfirmations(database, { auditStore: bootAuditStore });
await confirmations.ensure();
// 机器人权限（输入框「请求批准 / 完全访问」，§97）：看得到这个机器人（自己的或共享给自己的）就能改自己那一份。
confirmations.setBotAccess(async (actor, agentId) => {
  const profile = await agentProfileStore.get({ id: actor.id, role: actor.role === "admin" ? "admin" : "user" }, agentId);
  return Boolean(profile && profile.deletedAt === null);
});
const confirmAwareGate: typeof approvalService.gate = async (candidate) => {
  // 网页上点「发送 / 发布 / 删除」这类按钮：服务器自己判断，按审批偏好出确认卡片（不靠机器人先调用 confirm_action）。
  if (!isApprovalRecheck() && candidate.toolRef === "computer_click") {
    const target = (candidate.target ?? {}) as { pageUrl?: string; element?: { role?: string; name?: string } };
    const outcome = await confirmations.pageAction({
      ownerUserId: candidate.actorId,
      agentId: candidate.botId,
      threadId: (candidate.continuation ?? currentApprovalContext())?.threadId ?? null,
      element: target.element ?? null,
      pageUrl: target.pageUrl ?? null,
    });
    if (outcome && !outcome.ok) throw new ApprovalRefusedError(outcome.message);
  }
  if (!isApprovalRecheck() && candidate.toolRef.startsWith("computer_") && candidate.effect !== "read") {
    const threadId = (candidate.continuation ?? currentApprovalContext())?.threadId;
    if (threadId && (await confirmations.purchaseConfirmed(candidate.actorId, threadId).catch(() => false))) return undefined;
  }
  return approvalService.gate(candidate);
};
const computerGateway = computerProvider
  ? createComputerGateway({
      provider: computerProvider,
      auditStore: bootAuditStore,
      approvalGate: confirmAwareGate,
      policy: () => policyStore.get(),
      // In Postgres, so the ref a click carries resolves against the snapshot that produced it even
      // when the snapshot was taken by another server. A Map here would be blank on every replica
      // but the one that snapshotted, and the boundary would decide with no element to look at.
      snapshots: createSnapshotStore(database),
      // So wiping a profile takes the pictures of its signed-in pages with it, which is what the
      // sentence on that button already promised.
      pageFrames: pageFrameStore,
      allowPrivateHosts: config.computer?.allowPrivateHosts,
      token: config.computer?.token,
    })
  : undefined;

/**
 * What a Bot can reach beyond its own computer.
 *
 * Built here rather than beside the component store because it needs the policy, and it needs the
 * same policy the computer gateway enforces rather than one of its own. A deployment that has said
 * "this Bot may not change anything in Jira" has said one thing, and it should not matter whether
 * the change would arrive through a browser or through a tool call.
 */
const sandboxedStore = createSandboxedStore(database, bootAuditStore);

/**
 * Composio, built ONCE: the client the transport calls through and the broker behind the app
 * directory are the same client, and the store below and the routes further down share it.
 *
 * ONE CLIENT, TWO SEAMS, INSTALLED TWO DIFFERENT WAYS, because the two are reached two different
 * ways. The transport is reached as a MODULE — `transportFor` maps a kind to one, exactly as the
 * builtin routines transport above is reached — so there is no constructor to hand a client to and
 * the registry is built at IMPORT TIME, long before there is configuration to read. That is why the
 * actions seam is installed globally, from here, the one place that has the key. The broker has no
 * such problem: it is an ordinary argument, passed to the store and to `createApp`.
 *
 * A DEPLOYMENT WITH NO KEY INSTALLS NEITHER, which is the state the transport is written for rather
 * than an edge of it. The seam stays null and every Composio listing and call refuses saying the
 * connector is not configured here; the store gets no broker and the app directory says the same.
 * Installing a client built from an absent key would turn all of that into a vendor error at first
 * use, which sends an operator looking for a broken Composio instead of at their own configuration.
 */
const composio = config.composioApiKey
  ? createComposioClient(config.composioApiKey)
  : null;
if (composio) useComposioClient(composio.actions);

/**
 * The private sign-in form and the Passwords vault. A Bot asks to be signed in; the person answers
 * in a form outside the conversation; the computer types the login. See passwords/service.ts.
 */
const signInService = computerGateway
  ? createSignInService({
      store: createPasswordStore(database),
      gateway: computerGateway,
      encryptionKey: config.keyEncryptionKey,
      auditStore: bootAuditStore,
      notify: createSignInNotifier({
        database,
        appUrl: config.appUrl,
        notify: (scope, input) => deliveryNotifications(scope, input),
      }),
      onResolved: (request) =>
        createSignInResumer({
          database,
          resumeResponsibility: (owner, runId, result) =>
            responsibilityStore.resumeWaiting(owner, runId, result),
          continueTurn: ({ ownerUserId, botId, snapshot, result, messageId }) =>
            approvalContinuationRunner({
              ownerUserId,
              routineId: "sign-in",
              agentId: botId,
              threadId: snapshot.threadId,
              instruction: "",
              initiator: snapshot.initiator ?? PERSON_INITIATOR,
              continuation: { snapshot, result, messageId },
            }),
          recordReply: async ({
            ownerUserId,
            channelId,
            botId,
            text,
            messageId,
          }) => {
            await channelStore.recordActivity(
              await actorFor(ownerUserId),
              channelId,
              { text, agentId: botId, at: new Date() },
              { id: messageId },
            );
          },
        })(request),
    })
  : undefined;

/** 工作流（docs/workflows.md）。执行器在 governedTurnRunner 之后建，这里先给聊天工具一个取用口。 */
const workflowStore = createWorkflowStore(database);
let workflowEngineInstance: WorkflowEngine | undefined;
const workflowEngineRef = (): WorkflowEngine => {
  if (!workflowEngineInstance) throw new Error("工作流执行器还没准备好。");
  return workflowEngineInstance;
};

const pluginStore = createPluginStore({
  database,
  auditStore: bootAuditStore,
  credentials: credentialStore,
  encryptionKey: config.keyEncryptionKey,
  policy: () => policyStore.get(),
  approvalGate: approvalService.gate,
  // A connector send to other people asks the owner first. See plugins/share-target.ts.
  privateShareCheck: createPrivateShareCheck({
    approvals: approvalService.store,
  }),
  /*
   * Where a vendor sends people back, for a vendor whose client this deployment registers itself.
   *
   * The same value the connect and callback routes build, from the same config field, because it has
   * to match what was registered character for character. Undefined without a public URL, which is
   * the honest state: there is nowhere for a consent flow to come back to, so there is nothing worth
   * registering.
   */
  redirectUri: config.publicUrl ? redirectUriFor(config.publicUrl) : undefined,
  /*
   * The same client the transport seam above was installed with, never a second one. Enabling an
   * app writes the row here and creates the auth config at the vendor, and a store holding a
   * different client from the one the call goes out through is two deployments' worth of state
   * behind one screen. Undefined without a key, which leaves enabling an app refused rather than
   * attempted.
   */
  broker: composio?.broker,
});

// Logo metadata is optional; a vendor outage must not prevent the API from starting.
if (composio) {
  void backfillComposioLogos(database, composio.broker).catch(() => {
    console.warn(
      "Composio app logos could not be updated. Existing icons remain available; missing logos will be retried on the next restart.",
    );
  });
}

const responsibilityStore = createResponsibilityStore(database, {
  resolveTarget: async (ownerUserId, agentId, channelId) => {
    const actor = await actorFor(ownerUserId);
    const [bot, channel] = await Promise.all([
      agentProfileStore.get(actor, agentId),
      channelStore.get(actor, channelId),
    ]);
    return bot && channel?.active && channel.agentIds.includes(agentId)
      ? { threadId: channel.threadId }
      : null;
  },
});
const responsibilityBindings = createResponsibilityBindingStore(database, {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
});
/*
 * Event triggers. Every kind authenticates with its vendor's own scheme and then goes through the
 * responsibility engine's one ingest (event + run + queue in one transaction), so dispatch is the
 * same headless AG-UI path as every other responsibility run. `responsibilityEngine` is read at
 * delivery time, long after it is constructed further down.
 */
/*
 * Slack access: the owner's own linked Slack identity comes from the delivery bindings (read at call
 * time; `deliveryStore` is built further down), and channel membership from the Slack pairing via
 * `useSlackChannelMembership`, which nothing installs since slimming P4b removed the Slack pairing, so Slack triggers are refused.
 */
const slackAccess = slackAccessFrom(async (ownerUserId, teamId) => {
  const bindings = await deliveryStore.listBindings(ownerUserId);
  return (
    bindings.find(
      (binding) =>
        binding.transport === "slack" &&
        binding.realm === teamId &&
        binding.enabled,
    )?.identity ?? null
  );
});
const responsibilityTriggerStore = createTriggerStore(
  database,
  {
    store: credentialStore,
    reader: credentialStore,
    encryptionKey: config.keyEncryptionKey,
  },
  { slackAccess },
);
const triggerIngressDeps = {
  directory: responsibilityTriggerStore.directory,
  ingest: (event: unknown) => responsibilityEngine.ingest(event),
  auditStore: bootAuditStore,
};
const inboundEmail = inboundEmailConfigFromEnv(process.env);
const responsibilityTriggers = {
  store: responsibilityTriggerStore,
  emailDomain: inboundEmail?.domain ?? null,
  ingressRoutes: createTriggerIngressRoutes(triggerIngressDeps),
  emailRoutes: inboundEmail
    ? createEmailTriggerRoutes({
        ...triggerIngressDeps,
        config: inboundEmail,
        verify: createSnsVerifier(fetchSnsText),
        confirmSubscription: fetchSnsText,
      })
    : null,
};
// The Slack pairing calls `ingestSlackEvent` from responsibilities/slack.ts; this installs it.
useSlackTriggerIngest(
  createSlackTriggerIngest({ ...triggerIngressDeps, slackAccess }),
);
// Bots manage triggers from chat through the builtin Routines transport; keys never reach the model.
useTriggerTools({
  triggers: responsibilityTriggerStore,
  responsibilities: responsibilityStore,
  publicUrl: config.publicUrl ?? null,
  emailDomain: inboundEmail?.domain ?? null,
});

/**
 * Where a Bot handing work to another gets decided.
 *
 * The queue is the one #216 shipped, shared with the idle-computer culler and with routines: durable
 * work claimed by whichever replica gets to it, leased so a dead replica's work comes back. A hop is
 * that, because the Bot being addressed will very likely run on a different pod from the Bot that
 * addressed it, and a hop held in memory is lost the moment either is rescheduled.
 */
const handoffDesk = createHandoffDesk({
  queue: createWorkQueue(database),
  profiles: agentProfileStore,
  // Read per hop and never held, so revoking a grant applies to the next hop rather than after a
  // restart.
  mayAddress: async (fromBotId, toBotId) =>
    (
      await pluginStore
        .botsReachableFrom(fromBotId)
        // A grant that cannot be read is not a grant. Failing closed here costs a hop; failing open
        // would let a Bot address one nobody gave it because the database blinked.
        .catch(() => [] as string[])
    ).includes(toBotId),
  /*
   * Deferred rather than passed directly, because `actorFor` is defined further down with the rest
   * of the run-building collaborators. It is only ever called during a hop, long after this module
   * has finished loading.
   */
  actorFor: (userId) =>
    // Null rather than a throw: see the seam's own note. A role that cannot be read is not a role,
    // and the hop is refused with a sentence rather than ending the run in silence.
    actorFor(userId).catch(() => null),
  auditStore: bootAuditStore,
  caps: config.handoff,
});

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.policy_loaded",
  targetType: "policy",
  initiator: DEPLOYMENT_INITIATOR,
  payload: {
    ...policyStore.get(),
    source:
      policySource === "the database"
        ? "an administrator, saved in this deployment"
        : config.computer?.policy
          ? "configuration"
          : "the built-in default",
    note:
      policySource === "the database"
        ? "Set while running and kept. A restart returns to this."
        : "The deployment default. Anything an administrator sets from here is kept.",
  },
}).catch(() => undefined);

/*
 * Record whether each Bot has a computer of its own.
 *
 * A shared provider is a fine way to run on a laptop, but the shared isolation state must be visible
 * rather than inferred.
 */
const isolation = describeComputerIsolation(computerProvider);

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.isolation_loaded",
  targetType: "computer",
  initiator: DEPLOYMENT_INITIATOR,
  payload: {
    isolation: isolation.isolation,
    note: isolation.note,
  },
}).catch(() => undefined);

console.info(
  JSON.stringify({
    type: "computer-isolation",
    provider: computerProvider ? computerProvider.name : "none",
    isolation: isolation.isolation,
    ...(isolation.warning ? { warning: isolation.warning } : {}),
  }),
);
/**
 * One Bot's endpoint must not take down the platform.
 *
 * Restarting a remote agent while a run is in flight resets the socket. The rejection reaches the top
 * of the process, and Bun kills the whole server: every other person's conversation, every other Bot
 * and the admin surface go with it, because somebody redeployed their own agent.
 *
 * That blast radius is created by design the moment people can register their own endpoints,
 * so it belongs to that feature. A remote agent is untrusted infrastructure: it will restart, it will
 * time out, it will close a stream halfway through, and none of that is exceptional.
 *
 * Logged loudly rather than swallowed. A process that hides unhandled rejections is worse than one
 * that dies, so this prints the full reason and keeps serving; what it must never do is stay quiet.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({
      type: "unhandled-rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      code:
        reason && typeof reason === "object" && "code" in reason
          ? String((reason as { code: unknown }).code)
          : undefined,
      note: "The server kept running. A remote agent's connection failing must not stop everyone else.",
    }),
  );
});

/**
 * The watch on Bot streams, built once and shared by every run.
 *
 * It has to outlive the request that opens a stream: the sweep that notices a silent one is still
 * running long after the run request has been answered, because in Intelligence mode that request is
 * answered in about a second and the Bot keeps writing for as long as it has something to say.
 *
 * The same audit store as everything else, so a Bot that hangs is recorded beside what Bots do.
 */
const stallGuard = createStallGuard({
  stallMs: config.agentStallTimeoutMs,
  auditStore: bootAuditStore,
});

normalizeModelBaseUrls();
const runtimeModel = runtimeModelForEnvironment(tenantPackage.model);

const resolveRuntimeModelApiKey = () =>
  resolveModelApiKey({
    encryptionKey: config.keyEncryptionKey,
    reader: credentialStore,
    provider: runtimeModel.provider,
    keyId: tenantPackage.model.credentialSecretRef,
    environment: process.env,
  });
const modelSettings = createModelSettingsService({
  store: createModelSettingsStore(database),
  encryptionKey: config.keyEncryptionKey,
  fallback: {
    provider: runtimeModel.provider,
    model: runtimeModel.defaultModel,
    baseUrl:
      runtimeModel.provider === "anthropic"
        ? process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1"
        : process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  },
  fallbackApiKey: resolveRuntimeModelApiKey,
});
const resolveRuntimeConnection = () =>
  resolveScopedModelConnection(async () => {
    const connection = await modelSettings.resolve();
    return {
      model: {
        provider: connection.provider,
        defaultModel: connection.model,
        baseUrl: connection.baseUrl,
        useApiKey: connection.useApiKey,
        ...(connection.source === "environment" && runtimeModel.plan
          ? { plan: runtimeModel.plan }
          : {}),
      },
      apiKey: connection.apiKey,
    };
  });

const modelCatalog = createModelCatalogService({
  resolveConnection: () => modelSettings.resolve(),
});
// 不认识的模型（走 Anthropic 协议的非 Claude 模型）按目录里的 max_output_tokens 定输出上限，别被截在 4096。
setModelOutputLimitResolver(async (modelId) =>
  (await modelCatalog.list()).models.find((entry) => entry.id === modelId)?.maxOutputTokens,
);
setModelFallbackCatalog(async () => (await modelCatalog.list()).models.map((entry) => entry.id));
// 设置 → 模型 →「备用模型」（DESIGN.md §61）：管理员排好的顺序优先于环境变量 / 同平台自动挑选。
const modelFallbacks = createModelFallbackService({ store: createModelFallbackStore(database) });
setModelFallbackList(() => modelFallbacks.models());
/*
 * Magpie, the model gateway. MAGPIE_ADMIN_URL (e.g. http://magpie:3430) plus its web key
 * (MAGPIE_WEB_KEY_FILE, readable only by the API user) turn on 管理后台 → 模型平台 Magpie and the
 * embedded console. The model list syncs on start and every MODEL_CATALOG_REFRESH_MINUTES (10).
 */
const magpie = createMagpieService({
  adminUrl: process.env.MAGPIE_ADMIN_URL?.trim() || undefined,
  webKey: readMagpieWebKey(process.env),
});
magpie.onChange(() => modelCatalog.invalidate());

/**
 * 管理后台 → 系统更新：和宿主机更新程序共享的目录（CHISABOT_UPDATER_DIR，compose 里挂
 * /var/lib/chisabot-updater）。没挂就显示「未安装」，其余照常。docs/online-update.md。
 */
const systemUpdate = createSystemUpdateService({
  dir: process.env.CHISABOT_UPDATER_DIR,
  sourceDir: process.env.CHISABOT_SOURCE_DIR,
  running: readRunningBuild(),
});
const modelCatalogRefreshMinutes = (() => {
  const value = Number(process.env.MODEL_CATALOG_REFRESH_MINUTES ?? 10);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 24 * 60) : 10;
})();
if (modelCatalogRefreshMinutes > 0)
  modelCatalog.startAutoRefresh(modelCatalogRefreshMinutes * 60_000);
const agentModels = createAgentModelService({
  database,
  profiles: agentProfileStore,
  resolveDefaultModel: async () =>
    (await resolveRuntimeConnection()).model.defaultModel,
  catalog: modelCatalog,
});
const resolveRuntimeConnectionForAgent = (agentId: string) =>
  resolveScopedAgentModelConnection(agentId, async () => {
    const [connection, selected] = await Promise.all([
      resolveRuntimeConnection(),
      agentModels.resolveModel(agentId),
    ]);
    return selected === null
      ? connection
      : {
          model: {
            ...connection.model,
            defaultModel: selected,
            plan: undefined,
          },
          apiKey: connection.apiKey,
        };
  });

/**
 * Pass one of tool selection: which skills a message needs, on the deployment's own model.
 *
 * Built once rather than per request, because it holds nothing about a person: the key is resolved
 * on every call, so a credential rotated a moment ago is used by the next run.
 */
const chooseSkills = createModelCompleter({
  model: runtimeModel,
  resolveConnection: resolveRuntimeConnection,
  resolveApiKey: () =>
    resolveModelApiKey({
      encryptionKey: config.keyEncryptionKey,
      reader: credentialStore,
      provider: runtimeModel.provider,
      keyId: tenantPackage.model.credentialSecretRef,
      environment: process.env,
    }),
});

// Named collaborators are bound once in actorAgentResolver for chat, hops, and headless turns.


// PC 节点（docs/pc-node.md）：设备登记在数据库，在线连接在内存里的 hub。
const deviceStore = createDeviceStore(database);
await deviceStore.ensure();
const deviceHub = createDeviceHub({ store: deviceStore, confirm: confirmations.deviceHook });
confirmations.setDeviceDecider((approvalId, approved) => deviceHub.decide(approvalId, approved, "web"));
// 2026-10-14：旧版登记、能力仍是出厂「全部关闭」且没人改过配置的电脑 → 新默认「全部询问」（每次审批）。
// 幂等，用户自己关掉的不动；CHISABOT_DEVICE_ASK_DEFAULTS=0 关掉。
if (process.env.CHISABOT_DEVICE_ASK_DEFAULTS !== "0") {
  try {
    const adopted = await deviceStore.adoptAskDefaults();
    if (adopted.length) console.log(JSON.stringify({ type: "device-defaults-ask", count: adopted.length }));
  } catch (error) {
    console.warn("adopting device ask defaults failed", error);
  }
}
const deviceToolsFor = async (
  actorId: string,
  botId: string,
  initiator?: AuditInitiator,
) => {
  try {
    // 设备属于账号：这个人的任何机器人都能用他名下的在线设备（能力 / 文件夹 / 审批 / 紧急停止仍逐台生效）。
    // 例外：别人发布的团队机器人（agent_profiles 的主人是另一个人）不能碰这个人的电脑。
    const owner = await pluginStore.agentOwner(botId).catch(() => undefined);
    if (typeof owner === "string" && owner !== actorId) return [];
    // 全部未撤销的设备（含离线的）：都离线时 deviceTools 只给只读的 device_list + 「电脑离线」提示，
    // 机器人才能如实回答，而不是说「我看不到你的电脑」。操作类工具仍只在设备在线时出现。
    const devices = await deviceStore.forOwner(actorId);
    if (!devices.length) return [];
    const botName = await agentProfileStore
      .get(await actorFor(actorId), botId)
      .then((profile) => profile?.name ?? null)
      .catch(() => null);
    // device_upload / device_download：机器人自己的云端工作区（和聊天文件同一个通道）。
    const gateway = computerGateway;
    const workspace = gateway?.writeBytes
      ? {
          write: async (path: string, bytes: Buffer) => {
            await gateway.writeBytes!(botId, { id: actorId, userId: actorId, initiator: PERSON_INITIATOR }, { path, base64: bytes.toString("base64") });
            return true;
          },
          read: async (path: string) => {
            const file = await gateway.downloadFile(botId, { id: actorId, userId: actorId, initiator: PERSON_INITIATOR }, { path });
            if (file.bytes > 200 * 1024 * 1024) {
              await file.body.cancel().catch(() => {});
              throw new Error(`文件 ${path} 超过 200 MB。`);
            }
            return { bytes: Buffer.from(await new Response(file.body).arrayBuffer()), name: file.name };
          },
        }
      : undefined;
    return deviceTools({
      store: deviceStore,
      hub: deviceHub,
      botId,
      actorId,
      devices,
      botName,
      ...(initiator ? { initiator } : {}),
      ...(workspace ? { workspace } : {}),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "device-tools-load-failed",
        error: error instanceof Error ? error.name : "UnknownError",
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }
};

// Tools run here, not in the browser. Each connector still executes through the plugin store, so the
// grant, the policy and the audit row are exactly where they were. Host-folder tools are also
// server-dispatched: the selected Bot and the signed-in owner are bound here, then the desktop worker
// receives only opaque grant ids and relative paths.
// Proactive research may only read; see proactive/restriction.ts. Read from the catalogue per call.
const proactiveReadOnlyRefs = createReadOnlyClassifier(pluginStore);
/** 长期记忆（DESIGN.md §50）：每轮开头的记忆用法 + 笔记；上游 personal_memories 不再给机器人。 */
const memoryNotes = createMemoryNotes(database);
await memoryNotes.ensure();
/** 机器人头像（DESIGN.md §81）：上传的图片 / 表情 / 首字；没有 = 花纹头像。 */
const botAvatars = createBotAvatars(database, agentProfileStore);
await botAvatars.ensure();
// 浏览器收藏夹（DESIGN §95）：每个用户一份，推给机器人浏览器的起始页。
const browserBookmarks = createBrowserBookmarks(database, {
  agents: agentProfileStore,
  ...(computerGateway?.startLinks
    ? { pushStartLinks: (botId: string, links: { title: string; url: string }[]) => computerGateway.startLinks!(botId, links) }
    : {}),
});
await browserBookmarks.ensure();
/** 密钥保险箱（DESIGN.md §52）：API 密钥 / 令牌，值不进模型；api_request 按域名替换。 */
const vault = createVault(database, { encryptionKey: config.keyEncryptionKey });
await vault.ensure();
/** GitHub 账号连接（DESIGN.md §53）：令牌在保险箱（保留名 github），读直接做，写先在聊天里确认。 */
const github = createGithub(database, { vault, apiBase: process.env.CHISABOT_GITHUB_API_BASE });
await github.ensure();
/** 页面（DESIGN.md §54）：机器人做的单页网页，/p/<随机串>/ 公开可看（沙箱 CSP），设置 → 页面。 */
const pages = createPages(database, {
  publicUrl: process.env.CHISABOT_PUBLIC_URL?.trim() || null,
  ...(computerGateway
    ? {
        readBotFile: async ({ ownerUserId, botId, path, initiator }: { ownerUserId: string; botId: string; path: string; initiator?: AuditInitiator }) => {
          const actor = await actorFor(ownerUserId);
          if (!(await agentProfileStore.get(actor, botId))) throw new Error("That Bot is not available to this owner.");
          const file = await computerGateway.downloadFile(botId, { id: actor.id, userId: actor.id, ...(initiator ? { initiator } : {}) }, { path });
          if (file.bytes > 8 * 1024 * 1024 + 1) {
            await file.body.cancel().catch(() => {});
            throw new Error(`file too large: ${path}`);
          }
          return { bytes: new Uint8Array(await new Response(file.body).arrayBuffer()), name: file.name };
        },
      }
    : {}),
});
/** 聊天文件 + 图片生成（DESIGN.md §56）：上传进工作区、file_share 文件卡、image_generate / image_edit。 */
const chatFiles = createChatFiles(database, {
  encryptionKey: config.keyEncryptionKey,
  // 识图模型（DESIGN.md §59）：主模型能不能看图看模型目录（Magpie 的 input modalities），不知道就当能。
  mainModelSupportsImages: async (agentId) => {
    const modelId = (await agentModels.resolveModel(agentId).catch(() => null)) ?? (await resolveRuntimeConnection()).model.defaultModel;
    return (await modelCatalog.list()).models.find((entry) => entry.id === modelId)?.supportsImages;
  },
  isAdmin: async (userId) => (await actorFor(userId)).role === "admin",
  ownsBot: async (owner, bot) => (await agentProfileStore.get(await actorFor(owner), bot).catch(() => null)) !== null,
  ...(computerGateway?.writeBytes
    ? {
        workspace: {
          write: async (owner: string, bot: string, path: string, bytes: Buffer) => {
            await computerGateway.writeBytes!(bot, { id: owner, userId: owner, initiator: PERSON_INITIATOR }, { path, base64: bytes.toString("base64") });
            return true;
          },
          read: async (owner: string, bot: string, path: string) => {
            const file = await computerGateway.downloadFile(bot, { id: owner, userId: owner, initiator: PERSON_INITIATOR }, { path });
            if (file.bytes > 20 * 1024 * 1024) {
              await file.body.cancel().catch(() => {});
              throw new Error(`文件 ${path} 超过 20 MB。`);
            }
            return { bytes: Buffer.from(await new Response(file.body).arrayBuffer()), name: file.name };
          },
        },
      }
    : {}),
});
await pages.ensure();
await chatFiles.ensure();
/** 频道聊天的上传也存进机器人工作区 uploads/（CB-046，DESIGN.md §68），和旧 /bot 一样。 */
setChannelUploadMirror(
  createChannelUploadMirror({
    botsInChannel: async (channelId) =>
      (await database.$client.unsafe<{ agent_id: string }[]>("SELECT agent_id FROM channel_agents WHERE channel_id = $1", [channelId])).map((row) => row.agent_id),
    upload: (owner, agentId, file) => chatFiles.upload(owner, agentId, file),
  }),
);
/** 技能（DESIGN.md §51）：用户自己的 + 部署共享的，所有机器人按需加载，不用逐个授权。 */
const chisaSkills = createChisaSkills({
  store: pluginStore,
  actorFor: async (userId) => {
    const actor = await actorFor(userId);
    return { id: actor.id, isAdmin: actor.role === "admin" };
  },
});
const loadPersonalMemoryForActor = (ownerUserId: string) => async (botId: string) =>
  [
    await memoryNotes.context(ownerUserId, botId).catch(() => ""),
    await chisaSkills.catalog(ownerUserId).catch(() => ""),
    VAULT_GUIDANCE,
    await github.guidance(ownerUserId).catch(() => ""),
    await chatFiles.guidance(ownerUserId, botId).catch(() => ""),
    await confirmations.context(ownerUserId, botId).catch(() => ""),
  ]
    .filter(Boolean)
    .join("\n\n");
// Follow-ups a Bot schedules for itself, on the shared work queue. See agents/wake-up.ts.
const wakeUpStore = createWakeUpStore(database, { auditStore: bootAuditStore });
/** Team Bots: published Bots, their audiences, and teammates' consent to their own accounts. */
const teamBots = createTeamBots({
  database,
  connectedServers: async (userId) =>
    new Set(
      [
        ...(await pluginStore.connectionsFor(userId)),
        ...(await pluginStore.brokeredConnectionsFor(userId)),
      ].map((connection) => connection.serverId),
    ),
});

/** IM 接入（server/src/im，DESIGN.md §49）：下面才建；IM 回合的工具按连接的开关裁剪。 */
let imService: ImService | undefined;
const loadToolsForActor =
  (actorId: string, initiator: AuditInitiator = PERSON_INITIATOR) =>
  async (botId: string) => {
    // IM 回合（initiator = routine「im:<连接>」）：网页才能显示的工具（render_ui、面板）不给；
    // 电脑 / 设备类工具只有连接里打开了「允许使用电脑和设备」才给。
    const imConnection = imConnectionOf(initiator);
    const imDevices = !imConnection || imService?.allowsDevices(imConnection) === true;
    // 有后果的工具（删除 / 付款 / 对外发消息）按审批偏好先出确认卡片（server/src/confirmations）。
    return confirmations.wrap([
    ...(initiator.kind === "routine" && initiator.id.startsWith("lp_") ? [] : confirmations.tools(actorId, botId, initiator)),
    ...wakeUpTools({
      store: wakeUpStore,
      ownerUserId: actorId,
      agentId: botId,
      initiator,
    }),
    // 长期记忆（server/src/memory-notes，DESIGN.md §50）：一个人的所有机器人共用；后台刷新面板的回合不给。
    ...(initiator.kind === "routine" && initiator.id.startsWith("lp_") ? [] : memoryNotes.tools(actorId, botId)),
    ...(initiator.kind === "routine" && initiator.id.startsWith("lp_") ? [] : chisaSkills.tools(actorId, botId)),
    ...(initiator.kind === "routine" && initiator.id.startsWith("lp_") ? [] : vault.tools(actorId, botId, initiator)),
    ...(initiator.kind === "routine" && initiator.id.startsWith("lp_") ? [] : await github.tools(actorId, botId, initiator).catch(() => [])),
    ...(initiator.kind === "routine" && initiator.id.startsWith("lp_") ? [] : pages.tools(actorId, botId, initiator)),
    ...(initiator.kind === "routine" && initiator.id.startsWith("lp_") ? [] : await chatFiles.tools(actorId, botId, initiator).catch(() => [])),
    ...(await grantedTools({
      store: pluginStore,
      botId,
      actorId,
      initiator,
      // A Team Bot reaches its owner's accounts, and a teammate's own only with their consent.
      credentialActorFor: teamBots.credentialActorFor(actorId, botId),
    })),
    ...(imDevices ? await deviceToolsFor(actorId, botId, initiator) : []),
    // 生成式界面（json-render，取代 A2UI）：与 /api/capabilities 的 generativeUi 同一个开关。
    ...(config.generativeUi && !imConnection ? renderUiTools() : []),
    // 内置联网（web_search / web_fetch）：先搜、再读，浏览器留给需要点击 / 登录 / 给人看的时候。
    ...webTools(),
    // 实时面板（server/src/live-panels）：右栏会自己刷新的卡片，规范与 render_ui 同一套组件。
    // 后台刷新面板的无头回合（initiator 是 lp_… 的 routine）只拿 panel_update / panel_fail / panel_list，且只能动那一张：
    // 以前它也拿到 panel_refresh，刷新里又触发一次刷新，回合叠回合（2026-10-13 实测）。
    ...(config.generativeUi && !imConnection
      ? livePanelService.tools(actorId, botId, initiator.kind === "routine" && initiator.id.startsWith("lp_") ? { refreshOf: initiator.id } : {})
      : []),
    // 工作流（docs/workflows.md）：在聊天和长期任务里运行工作流；工作流自己的步骤拿不到。
    // 功能精简（DESIGN.md §74）：默认隐藏，CHISABOT_EXTRAS 含 workflows 才给机器人这两个工具。
    ...(config.extras?.includes("workflows")
      ? workflowChatTools({
          store: workflowStore,
          engine: workflowEngineRef,
          ownerUserId: actorId,
          botId,
          initiator,
        })
      : []),
  ], { ownerUserId: actorId, agentId: botId, initiator });
  };

/** One person's standing instructions, for both the /api/settings routes and every run they start. */
const userInstructionsStore = createUserInstructionsStore(database);

/*
 * What this person has told every built-in coworker they run.
 *
 * Per actor and read per build, for the reason every other per-person fact here is: somebody who
 * edits their instructions and sends a message expects the message to land on the new ones, and a
 * value captured at boot would serve the whole deployment whatever the first person to sign in had
 * written.
 */
const loadInstructionsForActor = (actorId: string) => () =>
  userInstructionsStore.read(actorId);

/*
 * The file behind an attachment reference, read when a turn turns out to name one.
 *
 * Read per turn rather than held, for the reason the bytes are in the database at all: a message
 * carries a `/api/attachments/<id>` URL, and a model provider is not going to go and fetch it. The
 * row is fetched here and the bytes go up inline, so the Bot sees the file the person attached
 * instead of a link it cannot follow.
 *
 * Built per actor and passed to both turn paths — the request path through `mountCopilotRuntime` and
 * a routine's turn through `buildAgentFor` — so a routine firing at three in the morning inlines
 * exactly as a person's chat turn does, on exactly the same footing.
 *
 * NARROWED BY ACTOR AND BY CONVERSATION, and not silent. The reference reaches the loader out of
 * browser-supplied message content, so a turn can name an attachment in a channel the asker was
 * never in — or in one they ARE in but which is not the channel this turn is running in.
 * `loadAttachmentForTurn` answers both with the same membership join the fetch route uses plus the
 * run's own thread, and null when there is no row this person may see here.
 * `resolveAttachmentParts` fails the turn on that null rather than letting a Bot read a file back
 * to somebody who cannot open it.
 *
 * The thread is the CLOSURE'S ARGUMENT rather than something baked in beside the actor, because one
 * of these is built per actor per request and then used for however many runs that request makes;
 * a thread captured here would be the first run's, silently, for all of them.
 *
 * A PURE READ. `attachedAt` is written by the send rather than by anything here; see
 * `markAttachmentsSentForActor` below.
 */
const loadAttachmentForActor =
  (actorId: string) => (id: string, threadId: string) =>
    // 机器人私聊里上传的文件（`cf:` 引用，DESIGN.md §56）只按人取：私聊不是频道，没有成员表可查。
    id.startsWith("cf:")
      ? chatFiles.loadForTurn(actorId, id.slice(3))
      : loadAttachmentForTurn(database, { actorId, threadId }, id);

/**
 * That the files on a message went out in it, recorded when a turn turns out to be a send.
 *
 * Bound per actor and handed to the same two turn paths as the reader above, so a routine's send at
 * three in the morning is recorded exactly as a person's chat turn is. `inlineAttachments`
 * (copilot.ts) calls it with the ids on the message being asked about and no others: history is
 * replayed on every turn and by whoever is running it, so nothing behind that message is evidence
 * of a send.
 *
 * NARROWED BY ACTOR, and more strictly than the reader is. Reading is scoped to channel
 * membership, because members are meant to see each other's sent files; recording a send is scoped
 * to the UPLOADER, because `attachedAt` is what the sweeper, the upload cap and the withdrawal
 * route all read as "this file rode in a message somebody sent" — and a member who could write it
 * on a colleague's staged row would freeze that colleague's own withdrawal at 409 and leave the row
 * unsweepable. See `markAttachmentsSent` in channels/attachments.ts.
 *
 * AND NARROWED BY CONVERSATION, taking the thread as an argument for the reason the reader does.
 * A stamp written against a channel that never saw the file freezes the row the same way, and is
 * reached without any colleague being involved: one person, two channels of their own, a file
 * named from the wrong one.
 */
const markAttachmentsSentForActor =
  (actorId: string) => (ids: readonly string[], threadId: string) =>
    markAttachmentsSent(database, { actorId, threadId }, ids);

/*
 * What the deployment tells a remote Bot about the run it is starting.
 *
 * Signed here, where the encryption key lives, so the runtime module never holds a secret. The Bot
 * hands this back when it calls a tool, and it is where the Bot id and the person's name come
 * from: its own token proves which agent is calling, this proves who it is calling for, and
 * neither is read out of the request body any more.
 */
const signRunForActor =
  (
    actorId: string,
    initiator: AuditInitiator = PERSON_INITIATOR,
    // How deep in a Bot-to-Bot chain a headless turn already is; see createGroupConversations.
    depth?: number,
  ) =>
  (
    botId: string,
    runId: string,
    threadId?: string,
    previousAssertion?: unknown,
  ) => {
    const previous = readRunAssertion(
      previousAssertion,
      config.keyEncryptionKey,
    );
    if (previous?.handoff) {
      if (previous.botId !== botId || previous.actorId !== actorId)
        throw new Error(
          "The delegated run identity does not match this Bot and owner.",
        );
      return previousAssertion as string;
    }
    return mintRunAssertion(
      {
        botId,
        actorId,
        runId,
        threadId,
        initiator,
        ...(depth ? { depth } : {}),
      },
      config.keyEncryptionKey,
    );
  };

/*
 * Which vendors this deployment connects to, held by a Bot or not.
 *
 * A Bot holding no grants used to be told nothing about connectors at all, so it treated a
 * connected vendor as an ordinary website and browsed to it: a Bot with no Drive grant opened
 * Google's sign-in page and asked a person to sign in to an account the deployment had already
 * connected. Naming them lets it say which one it has not been granted instead.
 *
 * Read per request rather than held, because a connector added a minute ago has to count.
 * Let failures reach buildAgents, which reports the missing guidance once and keeps the run usable.
 */
const loadVendors = async () =>
  (await pluginStore.listServers()).map((server) => server.id);

/*
 * How a run's tools are narrowed to the ones it is about.
 *
 * A model picks the right tool reliably out of about ten, and a deployment of this template
 * clears that as soon as it connects a second vendor. Past it the wrong tool gets called, or
 * none does and the answer comes from memory, and neither says so. So a Bot holding more than a
 * handful is offered the tools of the skills that match the message rather than everything at
 * once. See `plugins/selection.ts`.
 *
 * This narrows the offer and nothing else. What a Bot may call is the grant, checked in
 * `callTool` with the policy and the audit row exactly as before, so every path through here can
 * be wrong without a Bot gaining anything. That is also why every failure below is silent and
 * lands on the whole catalogue: the narrowing is worth an accuracy point, never a capability.
 */
const selectionForActor = (actorId: string): ToolSelection => ({
  loadSkills: (botId) => grantedSkills({ store: pluginStore, botId }),
  // The deployment's own model and key, the same pair the intent router uses, so selection is
  // never a second thing to configure. It throws on a missing key, which reads as "could not
  // choose" and leaves the whole catalogue offered.
  choose: chooseSkills,
  record: async (botId, selection) => {
    await recordAuditEvent(bootAuditStore, {
      eventType: "mcp.tools_discovered",
      targetType: "bot",
      targetId: botId,
      actorUserId: actorId,
      payload: {
        bot: botId,
        reason: selection.reason,
        granted: selection.granted,
        offered: selection.offered.length,
        skills: selection.skills,
      },
    });
  },
});

// Every run dials the stored endpoint again, so the check that was applied when it was
// registered has to be applied to wherever it redirects now.
// Absent computer configuration means nothing opted into private hosts, which is the safe
// reading and the same one `createApp` takes.
const agentFetch = createAgentFetch({
  allowPrivateHosts: config.computer?.allowPrivateHosts === true,
  // Named addresses are reachable on every hop, not only the one that was registered.
  allowedHosts: config.agentEndpointAllowedHosts,
  // The refusal is what the run already knows; this is what the deployment knows. Written here
  // rather than in `endpoint.ts` so that file keeps deciding and nothing else, the way the
  // target check it reuses does.
  onRefusal: ({ address, reason }) => {
    void recordAuditEvent(bootAuditStore, {
      eventType: "agent.dial_refused",
      targetType: "agent_endpoint",
      targetId: address,
      payload: { address, reason },
    }).catch((error) => {
      // A trail that cannot be written must not take a refusal down with it: the request is
      // already refused by the time this runs, and the alternative to a logged failure here is
      // an unhandled rejection.
      console.error("Could not record a refused agent dial.", error);
    });
  },
});

/**
 * Who a routine acts as, resolved the way {@link resolveRequestActor} resolves it.
 *
 * THE ROLE IS READ, NOT ASSUMED. Which coworkers exist is decided per person and an administrator
 * sees Bots a user does not, so hardcoding `role: "user"` here would hide an administrator's own Bots
 * from their own routine — the routine would fail with "that Bot is no longer registered" for a Bot
 * sitting in front of them in chat. This asks the same repository the request path asks, so a routine
 * sees exactly the coworkers its owner sees.
 */
const actorFor = async (ownerUserId: string): Promise<AgentActor> => {
  // One person, and they are an administrator. The id stays the routine owner's rather than being
  // rewritten to DEV_ACTOR's: in this mode they are the same person, and if they ever were not,
  // silently borrowing the dev actor's identity would be worse than finding nothing.
  // 多账号（CB-040）：朋友账号的定时任务按他自己的角色跑，不再一律当管理员。
  if (config.singleUser && (!gatewaySecret || ownerUserId === DEV_ACTOR.id)) return { id: ownerUserId, role: DEV_ACTOR.role };
  const roles = await roleRepository.rolesForUser(ownerUserId);
  if (!roles.includes("admin") && !roles.includes("user")) {
    throw new Error("A routine requires an authorized owner.");
  }
  return {
    id: ownerUserId,
    role: roles.includes("admin") ? "admin" : "user",
  };
};

/*
 * A run's source conversation: a channel's own thread, or a Bot's thread in a group conversation.
 * The group lookup applies the same live-membership and own-Bot checks. See channels/group.ts.
 */
const sourceForCoordinationRun = async (run: RunAssertion) => {
  if (run.threadId) {
    const [task] = await database
      .select({
        actorId: panelTaskRequests.actorId,
        status: panelTaskRequests.status,
      })
      .from(panelTaskRequests)
      .where(eq(panelTaskRequests.threadId, run.threadId));
    if (
      task &&
      (task.actorId !== run.actorId ||
        ["cancelled", "failed", "succeeded"].includes(task.status))
    )
      return null;
  }
  return (await channelSourceForRun(run)) ?? groupSourceForRun(database, run);
};
const channelSourceForRun = async (run: RunAssertion) => {
  if (!run.threadId) return null;
  const sources = await database
    .select({ channelId: channels.id, botId: channelAgents.agentId })
    .from(intelligenceChannelMappings)
    .innerJoin(channels, eq(channels.id, intelligenceChannelMappings.channelId))
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, run.actorId),
      ),
    )
    .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
    .where(
      and(
        eq(intelligenceChannelMappings.threadId, run.threadId),
        eq(intelligenceChannelMappings.userId, run.actorId),
        isNull(channels.deletedAt),
      ),
    );
  return (
    sources.find((source) => source.botId === run.botId) ??
    (run.handoff ? (sources[0] ?? null) : null)
  );
};
const personQuestions = createWorkQueue(database);
const coordination = createCoordinationTools({
  desk: handoffDesk,
  caps: config.handoff,
  approvalGate: approvalService.gate,
  privateShare: {
    check: createPrivateShareCheck({ approvals: approvalService.store }),
    // Resolved the way the desk resolves it: an id wins, then a single visible name. Null for the
    // owner's own Bot or a deployment Bot, since nobody else reads that work.
    audienceFor: async (from, target) => {
      const roster = await agentProfileStore.list(await actorFor(from.actorId));
      const wanted = target.trim().toLowerCase();
      const found =
        roster.find((candidate) => candidate.id.toLowerCase() === wanted) ??
        roster.find(
          (candidate) =>
            !candidate.hidden &&
            candidate.deletedAt === null &&
            candidate.name.toLowerCase() === wanted,
        );
      if (!found?.ownerUserId || found.ownerUserId === from.actorId)
        return null;
      return {
        kind: "handoff",
        id: found.ownerUserId,
        recipientUserIds: [found.ownerUserId],
        label: found.name,
      };
    },
    // A question from a conversation other people are in reaches them too, so it is held like a
    // handoff to another person. Only the owner reading it is the ordinary, unheld case.
    questionAudience: async (from) => {
      const channel = await channelSourceForRun(from);
      const group = channel ? null : await groupSourceForRun(database, from);
      const source = channel ?? group;
      if (!source) return null;
      const members = (
        await database
          .select({ userId: channelMemberships.userId })
          .from(channelMemberships)
          .where(eq(channelMemberships.channelId, source.channelId))
      ).map((row) => row.userId);
      if (members.every((userId) => userId === from.actorId)) return null;
      return {
        audience: {
          kind: group ? "group" : "channel",
          id: source.channelId,
          recipientUserIds: members,
        },
        // A channel thread is the conversation itself; a group Bot's own thread also holds context
        // only its owner has seen.
        origin: channel
          ? { kind: "shared_conversation", sharedWithUserIds: members }
          : { kind: "private_conversation" },
      };
    },
  },
  botsReachableFrom: (botId) => pluginStore.botsReachableFrom(botId),
  auditStore: bootAuditStore,
  authoriseRun: (run) =>
    authoriseCoordinationRun(run, {
      canUseBot: async (scope) => {
        const person = await peopleStore.find(scope.actorId);
        if (!person || person.revoked) return false;
        return (
          (await agentProfileStore.get(
            await actorFor(scope.actorId),
            scope.botId,
          )) !== null
        );
      },
      sourceThread: sourceForCoordinationRun,
      delegationFor: (claim) => readCoordinationHandoffClaim(database, claim),
    }),
  route: async (question) => {
    const source = await sourceForCoordinationRun(question);
    if (!source)
      return {
        refusal: "That question could not reach its source conversation.",
      };
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          question.actorId,
          question.botId,
          question.runId,
          question.question,
        ]),
      )
      .digest("hex");
    const queued = await personQuestions.offer({
      kind: "person.question",
      key,
      payload: {
        ...question,
        sourceBotId: source.botId,
        channelId: source.channelId,
        mode: "completed_question",
        toolName: "ask_person",
        args: {
          question: question.question,
          ...(question.why ? { why: question.why } : {}),
        },
      },
    });
    if (queued === "refused")
      return { refusal: "The question could not be saved for its person." };
    await channelStore.recordActivity(
      await actorFor(question.actorId),
      source.channelId,
      {
        text: `A question needs your answer: ${question.question}`,
        agentId: source.botId,
        at: new Date(),
      },
      { id: `question:${key}` },
    );
    if (question.threadId) {
      // A person reads this in Slack or on their phone, where "general-assistant" is an id, not a name.
      const botName =
        (
          await agentProfileStore
            .get(await actorFor(question.actorId), question.botId)
            .catch(() => null)
        )?.name ?? question.botId;
      await deliveryNotifications(
        {
          ownerUserId: question.actorId,
          channelId: source.channelId,
          agentId: source.botId,
          threadId: question.threadId,
        },
        {
          id: key,
          text: `${botName} asks: ${question.question}`,
          kind: "question",
          requestId: key,
        },
      );
    }
    return {
      reached:
        "the person in the source conversation; the question is saved awaiting their reply",
    };
  },
});
const coordinationForActor =
  (
    actorId: string,
    initiator: AuditInitiator = PERSON_INITIATOR,
    baseDepth = 0,
  ) =>
  async (botId: string, input: import("@ag-ui/client").RunAgentInput) => {
    const assertion = readRunAssertion(
      input.forwardedProps?.openbotRun,
      config.keyEncryptionKey,
    );
    if (
      assertion &&
      (assertion.botId !== botId || assertion.actorId !== actorId)
    )
      throw new Error("The run assertion does not match this Bot and owner.");
    const run: RunAssertion = assertion?.handoff
      ? assertion
      : {
          botId,
          actorId,
          runId: input.runId,
          threadId: input.threadId,
          depth: assertion?.depth ?? baseDepth,
          initiator: assertion?.initiator ?? initiator,
        };
    const tools = await coordination.toolsForRun(run);
    return tools.map((tool) => ({
      ...tool,
      execute: async (args: unknown) => {
        if (!args || typeof args !== "object" || Array.isArray(args))
          return `${REFUSAL_MARKER} Tool arguments must be an object.`;
        const result = await coordination.call({
          name: tool.name,
          args: args as Record<string, unknown>,
          run,
        });
        if (!result) throw new Error("A coordination tool was not dispatched.");
        /*
         * A responsibility's question pauses its run, the way an approval does.
         *
         * Left running, the run ended "succeeded" the moment the question was saved, and the answer
         * came back to a run that was already over: the Bot read it, and then the store refused its
         * progress because it was not from the responsibility's current run, so the goal stayed
         * open for ever. Suspended, the run waits, and the answer resumes that same run as this
         * tool's result, with the right to record progress and finish.
         */
        const snapshot = currentApprovalContext();
        if (
          tool.name === "ask_person" &&
          run.initiator?.kind === "responsibility" &&
          snapshot &&
          !result.text.startsWith(REFUSAL_MARKER)
        )
          throw new HeadlessToolSuspension(
            "This responsibility is waiting for the person's answer.",
            {
              kind: PERSON_QUESTION_WAITING,
              continuation: snapshot,
            },
          );
        return result.text;
      },
    }));
  };

/**
 * One Bot, built for a routine's turn, as its owner.
 *
 * Per turn rather than per boot, for the same reason the request path rebuilds: a Bot registered or
 * edited since the last firing has to count, and a private coworker must be absent for everybody but
 * its owner. No header and no request are involved — the owner is asserted by construction, from the
 * routine row — which is the whole point of doing it here rather than adding an impersonation path to
 * a public route.
 */
const buildAgentFor = async ({
  ownerUserId,
  agentId,
  initiator,
  depth,
}: {
  ownerUserId: string;
  agentId: string;
  initiator: AuditInitiator;
  depth?: number;
}) => {
  const actor = await actorFor(ownerUserId);
  let agent: AbstractAgent | undefined;
  try {
    agent = await actorAgentResolver.resolveAgentForActor(actor, agentId, {
      initiator,
      depth,
    });
  } catch (error) {
    if (!(error instanceof CoworkerUnavailableError)) throw error;
  }
  if (!agent) {
    /*
     * Named, and raised rather than swallowed. The routine's Bot was deleted, or made private by
     * somebody else, or the owner lost the role that could see it. The runner turns this into a
     * failed run row with this sentence on it, the first failure is said once in the channel, and
     * the fatigue rule switches the routine off after ten — which is exactly the right handling for
     * a routine pointed at something that is not coming back.
     */
    const error = new Error(
      `That Bot is no longer registered, so this routine has nothing to run: ${agentId}.`,
    );
    error.name = "RoutineBotNotRegistered";
    throw error;
  }
  return agent;
};

/*
 * The pair a headless turn is driven through, built ONCE.
 *
 * Intelligence keeps its existing client and gateway runner. Local mode shares the Postgres client
 * and OSS runner used by browser turns, so routines persist into the same owner-scoped transcript.
 *
 * One runner for the process, reused across firings: it opens a socket per run and holds no idle
 * connection, but its `threads` map is per instance, and a runner per turn would fragment the
 * already-running check that keeps two turns off one thread. See `routines/run-turn.ts`.
 */
// Only the legacy turn contracts use this facade; the OSS runtime receives the public runner.
const routineIntelligence: CopilotKitIntelligence = localBackend
  ? (localBackend.client as unknown as CopilotKitIntelligence)
  : createIntelligenceClient(config.runtime.intelligence!);
const routineAgentRunner =
  localBackend?.runner ??
  new IntelligenceAgentRunner({
    url: routineIntelligence.ɵgetRunnerWsUrl(),
    authToken: routineIntelligence.ɵgetRunnerAuthToken(),
  });

const governedTurnRunner = createTurnRunner({
  intelligence: routineIntelligence,
  runner: routineAgentRunner,
  components: { store: componentStore, auditStore: bootAuditStore },
  buildAgentFor,
  toolsForTurn: async ({ ownerUserId, agentId, initiator }) => {
    if (!computerGateway) return [];
    const actor = await actorFor(ownerUserId);
    const profile = await agentProfileStore.get(actor, agentId);
    if (!profile) throw new Error("That Bot is not available to this owner.");
    // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
    if (!canUseComputer(profile, actor)) return [];
    return createHeadlessComputerTools({
      gateway: computerGateway,
      botId: agentId,
      actor: { id: actor.id, userId: actor.id, initiator },
      auditStore: bootAuditStore,
      ...(signInService ? { signIn: signInService } : {}),
    });
  },
});
/*
 * 后台任务（DESIGN.md §38，workers/service.ts）：只在本地对话后端下有。工人的回合用自己的一个回合运行器
 * （超时 15 分钟、多一个 worker_plan 工具），结果交回主对话用上面的 governedTurnRunner。
 */
const workerComputerTools = async ({ ownerUserId, agentId, initiator }: { ownerUserId: string; agentId: string; initiator: AuditInitiator }) => {
  if (!computerGateway) return [];
  const actor = await actorFor(ownerUserId);
  const profile = await agentProfileStore.get(actor, agentId);
  if (!profile || !canUseComputer(profile, actor)) return [];
  return createHeadlessComputerTools({
    gateway: computerGateway,
    botId: agentId,
    actor: { id: actor.id, userId: actor.id, initiator },
    auditStore: bootAuditStore,
    ...(signInService ? { signIn: signInService } : {}),
  });
};
let workerService: WorkerService | undefined;
if (localBackend) {
  const workerTurnRunner = createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor,
    toolsForTurn: async (input) => [
      ...(await workerComputerTools(input)),
      ...(workerService && input.threadId.startsWith("worker-") ? workerService.workerTools(input.threadId.slice("worker-".length)) : []),
    ],
    turnTimeoutMs: 15 * 60_000 + 30_000,
  });
  workerService = createWorkerService({
    database,
    inbox: localBackend.inbox,
    control: localBackend.control,
    runTurn: workerTurnRunner,
    deliverTurn: governedTurnRunner,
    agentOfThread: async (threadId) => {
      const rows = await database.$client.unsafe<{ agent_id: string }[]>("SELECT agent_id FROM openbot_local_threads WHERE id = $1", [threadId]);
      return rows[0]?.agent_id ?? null;
    },
  });
  await workerService.ensure();
  try {
    const interrupted = await workerService.recover();
    if (interrupted) console.log(JSON.stringify({ type: "workers-interrupted-by-restart", count: interrupted }));
  } catch (error) {
    console.warn("marking interrupted workers failed", error);
  }
  // 删机器人以前不清后台任务记录和收件箱：开机顺手清掉孤儿行（幂等；CHISABOT_WORKER_ORPHAN_SWEEP=0 关掉）。
  if (process.env.CHISABOT_WORKER_ORPHAN_SWEEP !== "0") {
    try {
      const swept = await workerService.sweepOrphans();
      if (swept.workers || swept.inbox) console.log(JSON.stringify({ type: "worker-orphans-swept", ...swept }));
    } catch (error) {
      console.warn("sweeping orphaned worker rows failed", error);
    }
  }
  localBackend.setWorkers(workerService);
}
/*
 * 确认卡片：工具已经不等了（超时 / 服务重启）之后用户才点「确认」——往那段对话里发一条「用户确认了」，
 * 叫机器人接着做（和后台任务交回结果同一条路：正在回答就进收件箱，空着就起一轮）。
 */
confirmations.setResume(async ({ ownerUserId, agentId, threadId, requestId, text }) => {
  const message = { id: `confirm-resume-${requestId}`, role: "user", content: text } as Message;
  if (localBackend?.control.isActive(threadId)) {
    await localBackend.inbox.enqueue({ threadId, ownerUserId, message });
    if (localBackend.control.isActive(threadId)) return;
    await localBackend.inbox.withdraw(threadId, message.id);
  }
  const rows = await database.$client.unsafe<{ agent_id: string }[]>("SELECT agent_id FROM openbot_local_threads WHERE id = $1", [threadId]);
  await governedTurnRunner({
    ownerUserId,
    routineId: `confirm:${requestId}`,
    agentId: rows[0]?.agent_id ?? agentId,
    threadId,
    instruction: text,
    initiator: { kind: "routine", id: `confirm:${requestId}` },
    userMessage: message,
    forwardedProps: { chisabotConfirmResume: { id: requestId } },
  });
});

/**
 * 本地 agent 与权限档位（server/src/local-agents，docs/local-agents.md）：设备的只读 / 工作区 / 完全访问档位挂在
 * 设备 hub 上（档位之外的 device_* 操作改成先审批）；机器人用 device_agent_run 把任务交给电脑上的 Claude Code /
 * Codex / 内置循环，进度回到聊天卡片，结果回到对话。
 */
let localAgents: LocalAgentService | undefined;
try {
  localAgents = createLocalAgentService({
    database,
    hub: deviceHub,
    deviceStore,
    ...(localBackend ? { inbox: localBackend.inbox, control: localBackend.control } : {}),
    deliverTurn: governedTurnRunner,
    agentOfThread: async (threadId) => {
      const rows = await database.$client.unsafe<{ agent_id: string }[]>("SELECT agent_id FROM openbot_local_threads WHERE id = $1", [threadId]);
      return rows[0]?.agent_id ?? null;
    },
    resolveConnectionForAgent: resolveRuntimeConnectionForAgent,
  });
  await localAgents.ensure();
  const interrupted = await localAgents.recover();
  if (interrupted) console.log(JSON.stringify({ type: "local-agent-tasks-interrupted-by-restart", count: interrupted }));
  deviceHub.setExtension(localAgents.extension);
} catch (error) {
  console.warn("local agents unavailable", error);
  localAgents = undefined;
}
/**
 * 云端 Claude Code（server/src/cloud-cc，docs/cloud-claude-code.md，ADR-0014）：云端工作区节点（一台设备）上的 Claude Code
 * 登录、会话、审批。它的设备扩展排在本地 agent 前面：cc_* 消息自己处理，其余交给本地 agent。
 */
let cloudCc: CloudCcService | undefined;
try {
  cloudCc = createCloudCcService({
    database,
    hub: deviceHub,
    deviceStore,
    next: localAgents?.extension ?? null,
    github,
    vault,
    ...(process.env.CHISABOT_GITHUB_GIT_BASE ? { gitBase: process.env.CHISABOT_GITHUB_GIT_BASE } : {}),
  });
  await cloudCc.ensure();
  const interrupted = await cloudCc.recover();
  if (interrupted) console.log(JSON.stringify({ type: "cloud-cc-turns-interrupted-by-restart", count: interrupted }));
  deviceHub.setExtension(cloudCc.extension);
} catch (error) {
  console.warn("cloud claude code unavailable", error);
  cloudCc = undefined;
}
/** 电脑文件夹同步（server/src/cloud-cc/sync.ts，P4）：绑定、租约、隧道。跟着云端 Claude Code 一起有。 */
let cloudSync: CloudSyncService | undefined;
if (cloudCc) {
  try {
    const cc = cloudCc;
    cloudSync = createCloudSyncService({ database, hub: deviceHub, deviceStore, nodeRpc: (id, op, args, ms) => cc.nodeRpc(id, op, args as never, ms), nodeFor: (owner) => cc.nodeFor(owner) });
    await cloudSync.ensure();
    await cloudSync.recover();
    cc.setSyncHooks({ withHandoff: cloudSync.withHandoff, forgetWorkspace: cloudSync.forgetWorkspace });
  } catch (error) {
    console.warn("cloud folder sync unavailable", error);
    cloudSync = undefined;
  }
}
/** 群聊（频道）的对话不给委派：交回结果要走频道的记录，这一版只做机器人私聊。 */
/**
 * 群聊（一个频道里不止一个机器人）的对话：不给委派、定时任务、本地 agent。
 * CB-046（DESIGN.md §68）起和一个机器人的频道聊天是唯一的聊天入口，所以只排除多机器人的频道；
 * 以前这里排除所有频道对话，频道聊天里就没有后台任务和定时任务。
 */
const isGroupChannelThread = async (threadId: string) =>
  (
    await database.$client.unsafe(
      "SELECT 1 FROM intelligence_channel_mappings m JOIN channel_agents a ON a.channel_id = m.channel_id WHERE m.thread_id = $1 GROUP BY m.channel_id HAVING count(*) > 1 LIMIT 1",
      [threadId],
    )
  ).length > 0;

/*
 * IM 接入（server/src/im，DESIGN.md §49，docs/im.md）：QQ / 微信 / 飞书 / 企业微信 / 钉钉 / Telegram 的消息
 * 交给连接选的机器人回答。回合用自己的运行器：电脑工具只在连接打开「允许使用电脑和设备」时给，单轮最长 10 分钟。
 */
const imTurnRunner = createTurnRunner({
  intelligence: routineIntelligence,
  runner: routineAgentRunner,
  components: { store: componentStore, auditStore: bootAuditStore },
  buildAgentFor,
  toolsForTurn: async (input) => {
    const connection = imConnectionOf(input.initiator);
    if (!connection || !imService?.allowsDevices(connection)) return [];
    return workerComputerTools(input);
  },
  turnTimeoutMs: 10 * 60_000,
});
imService = createImService({
  database,
  encryptionKey: config.keyEncryptionKey,
  runTurn: imTurnRunner,
  botAvailable: async (ownerUserId, agentId) => {
    try {
      const profile = await agentProfileStore.get(await actorFor(ownerUserId), agentId);
      return Boolean(profile && !profile.deletedAt);
    } catch {
      return false;
    }
  },
  isSuspension: (error) => error instanceof HeadlessToolSuspension,
});
await imService.ensure();

/*
 * 定时任务 / 提醒（server/src/schedules，DESIGN.md §55，docs/schedules.md）：在对话里设，到点回到那段对话；
 * IM 来的同时推回 IM。进程内每 15 秒扫一次（比较交换，不会重复触发）；CHISABOT_SCHEDULES_SWEEP=0 关掉扫描。
 */
const schedules = createSchedules(database, {
  runTurn: governedTurnRunner,
  runImTurn: imTurnRunner,
  pushToIm: (threadId, text) => imService!.pushToThread(threadId, text),
  isThreadActive: (threadId) => localBackend?.control.isActive(threadId) ?? false,
  ...(localBackend ? { enqueueToThread: (input: { threadId: string; ownerUserId: string; message: Message }) => localBackend.inbox.enqueue({ ...input, kind: "message" }) } : {}),
  // FIX-02：定时回合结束后若仍占着对话锁，放开，避免输入框一直灰、消息发不出去。
  releaseThread: async (threadId) => {
    if (!localBackend) return;
    await localBackend.control.stop({ threadId }).catch(() => undefined);
  },
  botAvailable: async (ownerUserId, agentId) => {
    try {
      const profile = await agentProfileStore.get(await actorFor(ownerUserId), agentId);
      return Boolean(profile && !profile.deletedAt);
    } catch {
      return true;
    }
  },
  isSuspension: (error) => error instanceof HeadlessToolSuspension,
  isPaused: (error) => error instanceof BotPausedError,
});
await schedules.ensure();
if (process.env.NODE_ENV !== "test" && process.env.CHISABOT_SCHEDULES_SWEEP !== "0") schedules.start();

const panelTaskService = createNormalPanelTaskService({
  database,
  createConversation: async (request) => {
    const channel = await channelStore.create(await actorFor(request.actorId), [
      request.botId,
    ]);
    return { channelId: channel.id, threadId: channel.threadId };
  },
  isWaiting: (error) => error instanceof HeadlessToolSuspension,
  run: async (input) => {
    const actor = await actorFor(input.ownerUserId),
      source = await channelSourceForRun({
        actorId: input.ownerUserId,
        botId: input.agentId,
        threadId: input.threadId,
        runId: input.runId!,
        depth: 0,
      });
    if (!source) throw new PanelError("task_binding_refused", 403);
    await channelStore.recordActivity(
      actor,
      source.channelId,
      { text: input.instruction, agentId: null, at: new Date() },
      { id: `${input.runId}:input` },
    );
    const outcome = await governedTurnRunner({
      ...input,
      userMessage: {
        id: `${input.runId}:input`,
        role: "user",
        content: input.instruction,
      },
    });
    if (outcome.replyText)
      await channelStore.recordActivity(
        actor,
        source.channelId,
        { text: outcome.replyText, agentId: input.agentId, at: new Date() },
        { id: `${input.runId}:reply` },
      );
    return outcome;
  },
  stop: async (input) => {
    const stopped = await routineAgentRunner.stop(input);
    if (!localBackend && !stopped)
      throw new PanelError("normal_run_cancel_unconfirmed", 409);
    return stopped;
  },
  read: async (request) => {
    const [task] = await database
      .select()
      .from(panelTaskRequests)
      .where(
        and(
          eq(panelTaskRequests.id, request.id),
          eq(panelTaskRequests.actorId, request.actorId),
          eq(panelTaskRequests.botId, request.botId),
        ),
      );
    if (!task) throw new PanelError("task_binding_refused", 403);
    const threadId = task.threadId;
    let transportStatus: string | undefined,
      waiting = false;
    if (threadId && task.runId) {
      const approvals = await database.$client.unsafe<{ waiting: boolean }[]>(
        `SELECT EXISTS(SELECT 1 FROM approval_requests WHERE owner_user_id=$1 AND run_id=$2
          AND action->>'botId'=$3 AND action->>'threadId'=$4
          AND action->'continuation'->>'runId'=$2 AND action->'continuation'->>'threadId'=$4
          AND status IN ('pending','approved','consumed','completed','denied')) AS waiting`,
        [task.actorId, task.runId, task.botId, threadId],
      );
      waiting = approvals[0]?.waiting === true;
    }
    if (localBackend && threadId && task.runId) {
      const runs = await database.$client.unsafe<{ status: string }[]>(
        "SELECT status FROM openbot_local_runs WHERE thread_id=$1 AND run_id=$2",
        [threadId, task.runId],
      );
      transportStatus = runs[0]?.status;
      const events = await database.$client.unsafe<{ waiting: boolean }[]>(
        `SELECT EXISTS(SELECT 1 FROM openbot_local_events WHERE thread_id=$1 AND run_id=$2
          AND event->>'type'='CUSTOM' AND event->>'name'='openbot.headless.waiting') AS waiting`,
        [threadId, task.runId],
      );
      waiting ||= events[0]?.waiting === true;
    }
    const status = recoverPanelTaskStatus({
      savedStatus: task.status,
      ageMs: Date.now() - task.createdAt.getTime(),
      bound: !!threadId && !!task.runId,
      waiting,
      transportStatus,
      isRunning:
        !!threadId && (await routineAgentRunner.isRunning({ threadId })),
    });
    if (!threadId) return { status };
    let replyText: string | undefined;
    try {
      const history = await routineIntelligence.getThreadMessages({
        threadId,
        userId: request.actorId,
      });
      const message = history.messages
        .filter((m) => m.role === "assistant" && typeof m.content === "string")
        .at(-1);
      if (message && typeof message.content === "string")
        replyText = message.content.slice(0, 16000);
    } catch {
      /* A new or interrupted run may not yet have a transcript. */
    }
    return { status, ...(replyText ? { replyText } : {}) };
  },
});
const panelOverviewCapability: PanelCapability = {
  id: "overview",
  adapter: "bot",
  action: "overview",
  effect: "read",
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  scope: { actor: "current", bot: "current" },
};
const panelTaskCapability: PanelCapability = {
  id: "task",
  adapter: "bot",
  action: "task",
  effect: "write",
  inputSchema: {
    type: "object",
    properties: {
      instruction: { type: "string", minLength: 1, maxLength: 5000 },
    },
    required: ["instruction"],
    additionalProperties: false,
  },
  outputSchema: { type: "object", additionalProperties: false },
  scope: { actor: "current", bot: "current" },
};
const panels = createPanelServices({
  database,
  permissions: async (ctx) => {
    const actor = await actorFor(ctx.actorId);
    const profile = await agentProfileStore.get(actor, ctx.botId);
    if (!profile) throw new PanelError("panel_bot_unavailable", 404);
    return {
      canInteract: true,
      canManage:
        actor.role === "admin" ||
        (!profile.systemOwned && profile.ownerUserId === actor.id),
    };
  },
  adapters: [
    {
      definition: panelOverviewCapability,
      read: async (ctx) => {
        const profile = await agentProfileStore.get(
          await actorFor(ctx.actorId),
          ctx.botId,
        );
        if (!profile) throw new PanelError("panel_bot_unavailable", 404);
        return { name: profile.name };
      },
    },
    createGovernedPanelTaskAdapter(panelTaskCapability, panelTaskService),
  ],
  audit: async (event) => {
    await recordAuditEvent(bootAuditStore, {
      eventType: "panel.action",
      targetType: "panel",
      targetId:
        typeof event.instanceId === "string"
          ? event.instanceId
          : typeof event.resourceId === "string"
            ? event.resourceId
            : undefined,
      actorUserId: String(event.actorId),
      initiator: PERSON_INITIATOR,
      payload: event,
    });
  },
});

/**
 * The runtime, and the two things beside it a hop needs.
 *
 * `agentFor` builds the addressed Bot exactly the way a person's run builds it, and `history` reads
 * the conversation through the same client. Taken from here rather than assembled again, because a
 * Bot built by parallel wiring drifts the first time one of these arguments changes, and the drift is
 * invisible: it runs, and quietly holds different tools or a different role from the one the person
 * is talking to.
 */
/**
 * 工作流执行器（docs/workflows.md）：每一步 = 某个机器人在一个新对话里跑一个无头回合，用的就是
 * 定时任务 / 长期任务 / 面板任务那条 governedTurnRunner；步骤对话用完即删（软删除）。
 */
workflowEngineInstance = createWorkflowEngine({
  store: workflowStore,
  runTurn: governedTurnRunner,
  audit: bootAuditStore,
  createConversation: async (ownerUserId, botId) => {
    const channel = await channelStore.create(await actorFor(ownerUserId), [
      botId,
    ]);
    return { channelId: channel.id, threadId: channel.threadId };
  },
  deleteConversation: async (ownerUserId, channelId) => {
    await channelStore.softDelete(await actorFor(ownerUserId), channelId);
  },
  botInfo: async (ownerUserId, botId) => {
    const profile = await agentProfileStore
      .get(await actorFor(ownerUserId), botId)
      .catch(() => null);
    return profile && !profile.deletedAt
      ? { id: profile.id, name: profile.name }
      : null;
  },
  librarySkills: async (ownerUserId) => {
    const actor = await actorFor(ownerUserId);
    const skills = await pluginStore.listSkills({
      id: actor.id,
      isAdmin: actor.role === "admin",
    });
    // 管理员能列出所有人的技能；工作流只用部署的和自己的。
    return skills
      .filter((skill) => skill.ownerUserId === null || skill.ownerUserId === actor.id)
      .map(({ slug, title, instructions }) => ({ slug, title, instructions }));
  },
  beginPanelSession: async (ownerUserId, botId) => {
    const actor = await actorFor(ownerUserId);
    const session = await panels.authoring.beginPanelAuthoring({
      actorId: actor.id,
      botId,
      isAdmin: actor.role === "admin",
    });
    return session?.sessionId ?? null;
  },
});
/**
 * 实时面板：store + 工具 + 每分钟一次的刷新循环。刷新 = 同一个机器人在一个用完即删的对话里跑一个
 * 无头回合（与工作流同一条 governedTurnRunner），用 web_search / web_fetch 取数后 panel_update。
 */
// 对话里的截图缩略图按人存在服务器上，换设备也看得到（chat-shots.ts）。
const chatShots = await createChatShots(database);
// 全端同步：每个人每个机器人的「当前对话」存在服务器上，网页 / PC / 手机打开同一段（bot-threads.ts，DESIGN.md §42）。
const botThreads = await createBotThreads(database, localBackend?.control);
// 聊天里的链接预览卡（link-preview/service.ts，DESIGN.md §31 / §48）：只连公网；没有 og:image 时的截图默认关闭，
// CHISABOT_LINK_PREVIEW_SHOTS=1 才由内置浏览器截（仅共享计算机部署）。
const linkPreviews = await createLinkPreviews(database, {
  screenshots: process.env.CHISABOT_LINK_PREVIEW_SHOTS === "1",
  ...(config.computer?.provider === "shared"
    ? { computer: { baseUrl: config.computer.baseUrl, ...(config.computer.token ? { token: config.computer.token } : {}) } }
    : {}),
});
const livePanelStore = createLivePanelStore(database);
const livePanelService = createLivePanelService({
  store: livePanelStore,
  runHeadless: async ({ ownerUserId, botId, instruction, panelId, signal }) => {
    const actor = await actorFor(ownerUserId);
    const channel = await channelStore.create(actor, [botId]);
    try {
      await governedTurnRunner({
        ownerUserId,
        routineId: panelId,
        agentId: botId,
        threadId: channel.threadId,
        instruction,
        initiator: { kind: "routine", id: panelId },
        signal,
        userMessage: { id: `${panelId}:${Date.now()}`, role: "user", content: instruction },
      });
    } finally {
      await channelStore.softDelete(actor, channel.id).catch(() => {});
    }
  },
});
// 用户点「交还」：因为有人接管被推迟的面板马上重刷（control-blocks.ts onControlReleased）。
onControlReleased((ownerUserId) => void livePanelService.resumeAfterHandback(ownerUserId));
// CHISABOT_LIVE_PANEL_SWEEP=0：不跑后台刷新循环（只给并排的预览容器用，免得它替正式实例刷新面板）。
if (process.env.CHISABOT_LIVE_PANEL_SWEEP !== "0") livePanelService.start();

void workflowEngineInstance.recover().catch((error) =>
  console.error(
    JSON.stringify({ type: "workflow-recover-failed", reason: String(error) }),
  ),
);

const actorAgentResolver = createActorAgentResolver({
  loadAgents: loadAgentsForActor,
  model: runtimeModel,
  resolveModelApiKey: resolveRuntimeModelApiKey,
  resolveConnection: resolveRuntimeConnection,
  resolveConnectionForAgent: resolveRuntimeConnectionForAgent,
  stallGuard,
  loadToolsForActor: (actorId, initiator) =>
    restrictToolsForWorkflow(
      initiator,
      restrictToolsForRun(
        initiator,
        loadToolsForActor(actorId, initiator),
        proactiveReadOnlyRefs,
      ),
    ),
  signRunForActor,
  computerGuidance: config.computer ? COMPUTER_GUIDANCE : undefined,
  loadVendors,
  selectionForActor,
  agentFetch,
  handoffForActor: (actorId, initiator, depth) => {
    const coordination = restrictNamedToolsForWorkflow(
      initiator,
      restrictCoordinationForRun(
        initiator,
        coordinationForActor(actorId, initiator, depth),
      ),
    );
    return async (botId, input) => {
      const coordinated = await coordination(botId, input);
      const props = input.forwardedProps as
        | { panelAuthoring?: { sessionId?: unknown }; chisabotWorker?: unknown; chisabotWorkerDelivery?: unknown }
        | undefined;
      // 后台任务的委派工具：只给机器人私聊里人自己的回合和交付结果的回合（工人回合、群聊不给）。
      const delegating =
        workerService &&
        // 人自己的回合，或者「后台结果交回来」的那一轮（用户在那一轮里插的话也可能要委派）。
        (!initiator || initiator.kind === "person" || Boolean(props?.chisabotWorkerDelivery)) &&
        !props?.chisabotWorker &&
        input.threadId &&
        !input.threadId.startsWith("worker-") &&
        !(await isGroupChannelThread(input.threadId).catch(() => true));
      const delegated = delegating
        ? [
            ...coordinated,
            ...(await restrictNamedToolsForWorkflow(initiator, async () =>
              workerService!.delegationTools({ ownerUserId: actorId, agentId: botId, threadId: input.threadId }),
            )()),
          ]
        : coordinated;
      // 定时任务（DESIGN.md §55）：人自己的回合、IM 回合、定时任务到点的回合、后台结果交回的回合；
      // 后台任务本身、面板刷新、群聊不给。工具要知道「这段对话」，所以从这里给（这里有 threadId）。
      const imOf = imConnectionOf(initiator);
      const firing = Boolean((props as { chisabotSchedule?: unknown } | undefined)?.chisabotSchedule) || (initiator?.kind === "routine" && initiator.id.startsWith("schedule:"));
      const scheduling =
        input.threadId &&
        !props?.chisabotWorker &&
        !input.threadId.startsWith("worker-") &&
        (!initiator || initiator.kind === "person" || Boolean(imOf) || firing || Boolean(props?.chisabotWorkerDelivery)) &&
        !(await isGroupChannelThread(input.threadId).catch(() => true));
      const tools = scheduling
        ? [
            ...delegated,
            ...(await restrictNamedToolsForWorkflow(initiator, async () =>
              schedules.tools({ owner: actorId, agentId: botId, threadId: input.threadId, imConnectionId: imOf, firing }),
            )()),
          ]
        : delegated;
      // 本地 agent（docs/local-agents.md）：人自己的回合和结果交回的回合（同委派），有在线电脑时才给。
      const localAgentTools =
        localAgents && delegating
          ? await restrictNamedToolsForWorkflow(initiator, async () => {
              const botName = await agentProfileStore
                .get(await actorFor(actorId), botId)
                .then((profile) => profile?.name ?? null)
                .catch(() => null);
              const owner = await pluginStore.agentOwner(botId).catch(() => undefined);
              if (typeof owner === "string" && owner !== actorId) return [];
              return localAgents!.tools({ ownerUserId: actorId, botId, botName, threadId: input.threadId });
            })().catch(() => [])
          : [];
      const withLocal = localAgentTools.length ? [...tools, ...localAgentTools] : tools;
      const sessionId = props?.panelAuthoring?.sessionId;
      if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128)
        return withLocal;
      return [
        ...withLocal,
        ...(await restrictNamedToolsForWorkflow(initiator, () =>
          panels.authoring.tools({ actorId, botId }, sessionId),
        )()),
      ];
    };
  },
  loadInstructionsForActor,
  loadAttachmentForActor,
  markAttachmentsSentForActor,
  loadPersonalMemoryForActor,
});

const copilotRuntime = mountCopilotRuntime(
  config,
  actorAgentResolver,
  identifyUser,
  identifyActor,
  {
    onRunBusy: (input) => {
      void channelStore.signalBusy(input.threadId, input.busy).catch(() => {});
    },
    localBackend,
  },
);

const responsibilityQueue = createWorkQueue(database);
const responsibilityEngine: ResponsibilityEngine = createResponsibilityEngine({
  store: responsibilityStore,
  queue: responsibilityQueue,
  runTurn: async (context) => {
    const initiator: AuditInitiator = {
      kind: "responsibility",
      id: context.responsibilityId,
    };
    const tools = responsibilityTools({
      store: responsibilityStore,
      engine: responsibilityEngine,
      ownerUserId: context.ownerUserId,
      agentId: context.agentId,
      channelId: context.channelId,
      responsibilityRunId: context.runId,
    });
    const runner = createTurnRunner({
      intelligence: routineIntelligence,
      runner: routineAgentRunner,
      components: { store: componentStore, auditStore: bootAuditStore },
      buildAgentFor: (input) => buildAgentFor({ ...input, initiator }),
      toolsForTurn: async () => {
        const actor = await actorFor(context.ownerUserId);
        // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
        const computer =
          computerGateway &&
          canUseComputer(
            await agentProfileStore
              .get(actor, context.agentId)
              .catch(() => null),
            actor,
          )
            ? createHeadlessComputerTools({
                gateway: computerGateway,
                botId: context.agentId,
                actor: { id: actor.id, userId: actor.id, initiator },
                auditStore: bootAuditStore,
                ...(signInService ? { signIn: signInService } : {}),
              })
            : [];
        return [
          ...computer,
          ...tools.map((tool) => ({
            definition: {
              name: tool.name,
              description: tool.description,
              parameters: z.toJSONSchema(tool.parameters),
            },
            execute: (args: unknown) => tool.execute(args),
          })),
        ];
      },
    });
    const saved = context.continuation;
    const snapshot = saved
      ? parseApprovalContinuation(saved.waiting.continuation)
      : undefined;
    const toolResult = saved ? parseApprovalResult(saved.response) : undefined;
    return runner({
      ownerUserId: context.ownerUserId,
      routineId: context.responsibilityId,
      agentId: context.agentId,
      threadId: context.threadId,
      initiator,
      signal: context.signal,
      ...(snapshot && toolResult
        ? {
            continuation: {
              snapshot,
              result: toolResult,
              messageId: `responsibility-result:${context.runId}:${snapshot.toolCallId}`,
            },
          }
        : {}),
      instruction: buildResponsibilityTurn({
        instruction: context.instruction,
        successCriteria: context.successCriteria,
        progress: context.progress,
        trigger: context.event,
        eventData: markUntrusted(
          JSON.stringify(context.event.payload),
          `${context.event.source} event`,
        ),
        responsibilityId: context.responsibilityId,
      }),
    });
  },
  onReply: async (context, text) => {
    await channelStore.recordActivity(
      await actorFor(context.ownerUserId),
      context.channelId,
      { text, agentId: context.agentId, at: new Date() },
      { id: `responsibility:${context.runId}` },
    );
    await deliveryNotifications(
      {
        ownerUserId: context.ownerUserId,
        channelId: context.channelId,
        agentId: context.agentId,
        threadId: context.threadId,
      },
      { id: `responsibility:${context.runId}`, kind: "reply", text },
    );
  },
});
/**
 * A turn for a responsibility that is not one of the engine's own firings: a person answering the
 * question its run asked. Same tools, same initiator and the same run to report progress against,
 * so the Bot can carry on with the goal instead of being unable to record it.
 */
const responsibilityAnswerTurn = ({
  responsibility,
  responsibilityRunId,
}: {
  responsibility: Responsibility;
  responsibilityRunId: string | undefined;
}) => {
  const initiator: AuditInitiator = {
    kind: "responsibility",
    id: responsibility.id,
  };
  const tools = responsibilityTools({
    store: responsibilityStore,
    engine: responsibilityEngine,
    ownerUserId: responsibility.ownerUserId,
    agentId: responsibility.agentId,
    channelId: responsibility.channelId,
    ...(responsibilityRunId ? { responsibilityRunId } : {}),
  });
  return createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor: (input) => buildAgentFor({ ...input, initiator }),
    toolsForTurn: async () => [
      ...(await approvalComputerTools(
        responsibility.ownerUserId,
        responsibility.agentId,
        initiator,
      )),
      ...tools.map((tool) => ({
        definition: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.parameters),
        },
        execute: (args: unknown) => tool.execute(args),
      })),
    ],
  });
};
const responsibilitySweep = repeatAfterEach(async () => {
  try {
    const report = await responsibilityEngine.dispatch({
      owner: workOwner("responsibility"),
      limit: 1,
    });
    if (
      report.succeeded.length ||
      report.failed.length ||
      report.waiting.length
    )
      console.info(
        JSON.stringify({ type: "responsibility-dispatch", ...report }),
      );
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "responsibility-dispatch-error",
        error: reasonWithoutStatement(error).slice(0, 300),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 2_000);

const approvalQueue = createWorkQueue(database);
const approvalOwner = workOwner("approval");
const approvalComputerTools = async (
  ownerUserId: string,
  agentId: string,
  initiator: AuditInitiator,
) => {
  const actor = await actorFor(ownerUserId);
  const profile = await agentProfileStore.get(actor, agentId);
  if (!profile)
    throw new ApprovalRefusedError("That Bot is no longer available to you.");
  // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
  return computerGateway && canUseComputer(profile, actor)
    ? createHeadlessComputerTools({
        gateway: computerGateway,
        botId: agentId,
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      })
    : [];
};
const executeApprovedAction = createApprovedActionExecutor({
  sourceFor: sourceForCoordinationRun,
  gate: approvalService.gate,
  computerTools: approvalComputerTools,
  callTool: (input) => pluginStore.callTool(input),
  credentialActorFor: (actorId, botId, ref) =>
    teamBots.credentialActorFor(actorId, botId)(ref),
  coordinationCall: (input) => coordination.call(input),
  readRun: (value) => readApprovedRunAssertion(value, config.keyEncryptionKey),
  answer: vendorAnswer,
  privateShareToolRef: PRIVATE_SHARE_TOOL_REF,
  refusalMarker: REFUSAL_MARKER,
  personInitiator: PERSON_INITIATOR,
});
const approvalTurnRunner = createTurnRunner({
  intelligence: routineIntelligence,
  runner: routineAgentRunner,
  components: { store: componentStore, auditStore: bootAuditStore },
  buildAgentFor,
  toolsForTurn: async ({ ownerUserId, agentId, initiator }) =>
    approvalComputerTools(ownerUserId, agentId, initiator),
});
const approvalContinuationRunner: typeof approvalTurnRunner = (input) =>
  panelTaskService.runContinuation(input, approvalTurnRunner);
const approvalSweep = repeatAfterEach(async () => {
  try {
    const [item] = await approvalQueue.claim({
      kind: "approval.resume",
      owner: approvalOwner,
      leaseMs: 15 * 60_000,
      limit: 1,
    });
    if (!item) return;
    // Set once the item is understood, so its last failed try can still tell the Bot.
    let abandon: ((reason: string) => Promise<void>) | undefined;
    try {
      const input = z
        .object({
          ownerUserId: z.string().min(1),
          approvalId: z.string().min(1),
        })
        .parse(item.payload);
      const resumeDependencies: ApprovalResumeDependencies = {
        validate: (action) =>
          approvalService.validateReentry(action, () =>
            executeApprovedAction(action),
          ),
        execute: executeApprovedAction,
        continue: async ({
          continuation: snapshot,
          result,
          messageId,
          approvalId,
        }) => {
          const [waitingRun] = await database
            .select({ id: responsibilityRuns.id })
            .from(responsibilityRuns)
            .where(
              and(
                eq(responsibilityRuns.status, "waiting"),
                sql`${responsibilityRuns.waiting}->>'approvalId' = ${approvalId}`,
              ),
            )
            .limit(1);
          if (waitingRun) {
            await responsibilityStore.resumeWaiting(
              input.ownerUserId,
              waitingRun.id,
              result,
            );
            return;
          }
          const request = await approvalService.store.get(
            input.ownerUserId,
            approvalId,
          );
          // A group turn's approval also writes the resumed reply into the shared transcript.
          const outcome = await groupConversations.continueWaiting(
            approvalId,
            () =>
              approvalContinuationRunner({
                ownerUserId: input.ownerUserId,
                routineId: "approval",
                agentId: request.action.botId,
                threadId: snapshot.threadId,
                instruction: "",
                initiator: snapshot.initiator ?? PERSON_INITIATOR,
                continuation: { snapshot, result, messageId },
              }),
          );
          const [source] = await database
            .select({ channelId: intelligenceChannelMappings.channelId })
            .from(intelligenceChannelMappings)
            .where(
              and(
                eq(intelligenceChannelMappings.userId, input.ownerUserId),
                eq(intelligenceChannelMappings.threadId, snapshot.threadId),
              ),
            )
            .limit(1);
          if (source && outcome.replyText)
            await channelStore.recordActivity(
              await actorFor(input.ownerUserId),
              source.channelId,
              {
                text: outcome.replyText,
                agentId: request.action.botId,
                at: new Date(),
              },
              { id: messageId },
            );
          // A decision made in Slack, SMS or the phone gets its result back there too.
          if (source && outcome.replyText)
            await deliveryNotifications(
              {
                ownerUserId: input.ownerUserId,
                channelId: source.channelId,
                agentId: request.action.botId,
                threadId: snapshot.threadId,
              },
              { id: messageId, text: outcome.replyText, kind: "reply" },
            );
        },
      };
      abandon = (reason) =>
        approvalService.abandon(
          input.ownerUserId,
          input.approvalId,
          reason,
          resumeDependencies,
        );
      await approvalService.resume(
        input.ownerUserId,
        input.approvalId,
        resumeDependencies,
      );
      if (
        !(await approvalQueue.finish({
          kind: item.kind,
          key: item.key,
          owner: approvalOwner,
        }))
      )
        throw new Error("The approval work lease was lost before completion.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // The queue will not hand this item out again, so the conversation hears now or never.
      if (abandon && item.attempts >= DEFAULT_MAX_ATTEMPTS) {
        try {
          await abandon(reason);
          await approvalQueue.finish({
            kind: item.kind,
            key: item.key,
            owner: approvalOwner,
          });
          return;
        } catch (failure) {
          console.error(
            JSON.stringify({
              type: "approval-abandon-error",
              error:
                failure instanceof Error ? failure.message : String(failure),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }
      await approvalQueue.release({
        kind: item.kind,
        key: item.key,
        owner: approvalOwner,
        delayMs: 10_000,
        reason,
      });
      throw error;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "approval-resume-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 2_000);
const deliveryStore = createDeliveryStore(database);

/*
 * Follow-ups a Bot scheduled for itself: one headless turn each, through the same turn runner as a
 * routine, into the person's conversation with that Bot. See agents/wake-up.ts.
 */
const wakeUpQueue = createWorkQueue(database);
const wakeUpRunner = createWakeUpRunner({
  queue: wakeUpQueue,
  store: wakeUpStore,
  owner: workOwner("wake-up"),
  actorFor,
  channels: channelStore,
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor,
    toolsForTurn: async ({ ownerUserId, agentId, initiator }) => {
      if (!computerGateway) return [];
      const actor = await actorFor(ownerUserId);
      const profile = await agentProfileStore.get(actor, agentId);
      if (!profile) throw new Error("That Bot is not available to this owner.");
      // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
      if (!canUseComputer(profile, actor)) return [];
      return createHeadlessComputerTools({
        gateway: computerGateway,
        botId: agentId,
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      });
    },
  }),
  notify: (scope, input) => deliveryNotifications(scope, input),
});
const wakeUpSweep = repeatAfterEach(async () => {
  try {
    const report = await wakeUpRunner.sweep();
    if (report.ran.length || report.skipped.length)
      console.info(JSON.stringify({ type: "bot-follow-up", ...report }));
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "bot-follow-up-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 5_000);
const wakeUpReaper = repeatAfterEach(async () => {
  await wakeUpRunner.reap().catch(() => 0);
}, 60 * 60_000);

const personResponseOwner = workOwner("person-response");
/**
 * Conversations with several Bots. Each Bot turn is an ordinary headless AG-UI turn into that Bot's
 * own group thread, built exactly as a routine's is, so governance, learning and the computer tools
 * apply unchanged; Bots answering each other reuse the handoff desk's grant and caps.
 */
const groupConversations = createGroupConversations({
  store: createGroupStore(database, () => threadIdentity.mint()),
  queue: createWorkQueue(database),
  owner: workOwner("group"),
  roster: async (ownerUserId, channelId) => {
    const actor = await actorFor(ownerUserId);
    const channel = await channelStore.get(actor, channelId);
    if (!channel || channel.agentIds.length < 2) return null;
    const bots: { id: string; name: string }[] = [];
    for (const agentId of channel.agentIds) {
      const profile = await agentProfileStore.get(actor, agentId);
      if (profile) bots.push({ id: agentId, name: profile.name });
    }
    return bots;
  },
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor,
    toolsForTurn: async ({ ownerUserId, agentId, initiator }) => {
      if (!computerGateway) return [];
      const actor = await actorFor(ownerUserId);
      const profile = await agentProfileStore.get(actor, agentId);
      if (!profile) throw new Error("That Bot is not available to this owner.");
      // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
      if (!canUseComputer(profile, actor)) return [];
      return createHeadlessComputerTools({
        gateway: computerGateway,
        botId: agentId,
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      });
    },
  }),
  caps: config.handoff,
  // The handoff desk's own grant check, read per hop and failing closed.
  mayAddress: async (fromBotId, toBotId) =>
    (
      await pluginStore.botsReachableFrom(fromBotId).catch(() => [] as string[])
    ).includes(toBotId),
  auditStore: bootAuditStore,
  activity: async (turn, agentId, text, sourceId) =>
    channelStore.recordActivity(
      await actorFor(turn.ownerUserId),
      turn.channelId,
      { text, agentId, at: new Date() },
      { id: sourceId },
    ),
  busy: async (turn, busy) =>
    channelStore.signalChannelBusy(
      await actorFor(turn.ownerUserId),
      turn.channelId,
      busy,
    ),
  createChannel: async (ownerUserId, agentIds) =>
    channelStore.create(await actorFor(ownerUserId), agentIds),
  // The owner says whether a Bot's words may reach the other people in a group.
  privateShare: createPrivateShareCheck({ approvals: approvalService.store }),
  // A Team Bot's consent card raised in a group turn is drawn in the shared transcript.
  listenForConsent: (ownerUserId, agentId) =>
    teamBots.listenForConsent(ownerUserId, agentId),
});
const groupSweep = repeatAfterEach(async () => {
  try {
    while (await groupConversations.sweep()) {}
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "group-sweep-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 1_000);

const personResponseSweep = repeatAfterEach(async () => {
  try {
    const [item] = await approvalQueue.claim({
      kind: "person.response",
      owner: personResponseOwner,
      leaseMs: 10 * 60_000,
      limit: 1,
      maxAttempts: 1,
    });
    if (!item) return;
    try {
      const payload = z
        .object({
          ownerUserId: z.string().min(1),
          // The saved question, initiator included, so the answer resumes the turn that asked.
          question: personQuestionSchema,
          response: z.string().min(1).max(6000),
        })
        .parse(item.payload);
      if (payload.ownerUserId !== payload.question.actorId)
        throw new ApprovalRefusedError(
          "The saved question owner does not match.",
        );
      await authoriseQuestion(payload.question);
      const outcome = await resumePersonQuestion({
        ownerUserId: payload.ownerUserId,
        question: payload.question,
        response: payload.response,
        messageId: `person-response:${item.key}`,
        runTurn: approvalContinuationRunner,
        responsibilities: responsibilityStore,
        responsibilityTurn: responsibilityAnswerTurn,
      });
      const source = await sourceForCoordinationRun({
        ...payload.question,
        botId: questionConversationBot(payload.question),
        depth: 0,
      });
      if (source && outcome.replyText)
        await channelStore.recordActivity(
          await actorFor(payload.ownerUserId),
          source.channelId,
          {
            text: outcome.replyText,
            agentId: questionConversationBot(payload.question),
            at: new Date(),
          },
          { id: `person-response:${item.key}` },
        );
      if (source && outcome.replyText)
        await deliveryNotifications(
          {
            ownerUserId: payload.ownerUserId,
            channelId: source.channelId,
            agentId: questionConversationBot(payload.question),
            threadId: payload.question.threadId,
          },
          {
            id: `person-response:${item.key}`,
            text: outcome.replyText,
            kind: "reply",
          },
        );
      if (
        !(await approvalQueue.finish({
          kind: item.kind,
          key: item.key,
          owner: personResponseOwner,
        }))
      )
        throw new Error(
          "The question response lease was lost before completion.",
        );
    } catch (error) {
      await approvalQueue.release({
        kind: item.kind,
        key: item.key,
        owner: personResponseOwner,
        delayMs: 0,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "person-response-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 2_000);

/**
 * Delivering hops, on every replica.
 *
 * A loop rather than a schedule, because a hop is somebody waiting for an answer rather than
 * housekeeping: the culler's minute-granularity CronJob would be an unexplainable pause in a
 * conversation. Every replica sweeps, and the queue decides which of them gets which hop, so adding a
 * replica adds delivery capacity rather than contention.
 *
 * Only where the capability is switched on. A deployment with a depth cap of zero never has a hop to
 * deliver, and a loop polling for work that cannot exist is a query a second for nothing.
 */
/*
 * Both zeros switch the capability off, so both have to stop the loop.
 *
 * Gated on the depth alone, a deployment that set the fan-out cap to zero still swept every two
 * seconds for hops that can never be offered: roughly forty thousand claim transactions per replica
 * per day, for a feature it had turned off.
 */
/**
 * The queue's own wake-up, when handing work between Bots is switched on at all.
 *
 * Held at module scope so the shutdown below can give its connection back. Undefined on a
 * deployment with the capability off, which is a deployment that never started one.
 */
let workOfferedListener: WorkOfferedListener | undefined;

if (config.handoff.maxDepth > 0 && config.handoff.maxPerRun > 0) {
  const runner = createHandoffRunner({
    queue: createWorkQueue(database),
    owner: workOwner("handoff"),
    auditStore: bootAuditStore,
    /*
     * The signed statement of the run the addressed Bot is about to start, carrying how deep the
     * chain has gone. Minted here, where the key lives, and one deeper than the run that asked.
     */
    sign: (work, claim) =>
      signHandoffDeliveryRun(work, config.keyEncryptionKey, undefined, claim),
    delivery: createHandoffDelivery({
      /*
       * Built as the person, WITH THEIR ROLE. The desk resolved it to decide the hop was allowed; a
       * delivery that then rebuilt them as an ordinary user could not find the Bot the desk had just
       * agreed to, and the person was told it never answered.
       */
      agentFor: async ({ actorId, botId, fromBotId }) => {
        const actor = await actorFor(actorId).catch(() => null);
        if (!actor) {
          throw new Error(
            "who this is for could not be confirmed, so the Bot was not run",
          );
        }
        return copilotRuntime.agentFor({
          actor,
          botId,
          initiator: { kind: "handoff", id: fromBotId },
        });
      },
      history: copilotRuntime.history,
      lock: copilotRuntime.threadLock,
      /*
       * A scratch thread of the addressed Bot's own, one per hop.
       *
       * An Intelligence thread has exactly one agent, so a second Bot cannot answer inside the first
       * Bot's conversation however it asks. Its turn runs here instead, unmapped to any channel, and
       * what it said comes back to the conversation that asked through the relay — in the asking
       * Bot's voice, which is the only voice that thread admits. Minted with the deployment's own
       * identity, like every thread this deployment starts.
       */
      mintThreadId: () => threadIdentity.mint(),
      /*
       * The roster, told that a relayed answer landed. The delivery knows only the thread it ran
       * in; this resolves which channel shows that thread — a scratch thread maps to nothing and
       * announces nowhere, which is the point of a scratch thread.
       */
      announce: async (input) => {
        const [mapped] = await database
          .select({ channelId: intelligenceChannelMappings.channelId })
          .from(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.threadId, input.threadId))
          .limit(1);
        // A Bot's group thread maps to no channel; its answer goes to the shared transcript.
        if (!mapped) {
          await groupConversations.announceHandoff(input);
          return;
        }
        const actor = await actorFor(input.actorId).catch(() => null);
        if (!actor) return;
        await channelStore.recordActivity(actor, mapped.channelId, {
          text: input.text,
          agentId: input.agentId,
          at: new Date(),
        });
      },
      // The asking conversation shown as working while a hop runs in it. Keyed by thread, resolved
      // to its channel by the store; a scratch thread maps to none and signals nowhere.
      setBusy: (input) => channelStore.signalBusy(input.threadId, input.busy),
      newRunId: () => randomUUID(),
      // The same address and the same token the runtime uses. Assembling either from configuration
      // produced a runner every join was refused for, because the thread's active run is a lock the
      // platform issues rather than something an API key can claim.
      runner: copilotRuntime.runner as never,
    }),
  });

  const sweep = async () => {
    try {
      const report = await runner.sweep();
      if (report.delivered.length > 0 || report.skipped.length > 0) {
        console.info(JSON.stringify({ type: "bot-handoff", ...report }));
      }
    } catch (error) {
      // A sweep that failed must not take the loop with it: the next one may find the database back.
      console.warn(
        "[handoff] a sweep could not run:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  /*
   * ONE SWEEP AT A TIME ON THIS REPLICA, from both callers below. A sweep poked while one is
   * running is remembered rather than started, and runs once the current one ends — a wake-up
   * that arrived mid-sweep may be for a hop the running sweep's claim already missed.
   */
  let sweeping = false;
  let sweepAgain = false;
  const kick = async () => {
    if (sweeping) {
      sweepAgain = true;
      return;
    }
    sweeping = true;
    try {
      do {
        sweepAgain = false;
        await sweep();
      } while (sweepAgain);
    } finally {
      sweeping = false;
    }
  };

  /*
   * Woken by the queue itself, from any replica: a person is waiting through every hop, and the
   * poll below would spend up to two seconds per leg doing nothing. The poll stays as the
   * backstop — a notification is a latency optimisation, and one lost in transit costs one
   * interval, never the work. See repeatAfterEach for why an interval must not be used: an
   * interval would start another sweep every two seconds while a five-minute delivery runs, each
   * claiming a different batch, and this replica's concurrent agent runs would grow with the
   * backlog rather than stopping at the limit it was asked for.
   */
  workOfferedListener = await startWorkOfferedListener(
    config.databaseUrl,
    (kind) => {
      if (kind === HANDOFF_KIND) void kick();
    },
  );
  repeatAfterEach(kick, 2_000);
}

/*
 * And dropping the hops that are over, whether or not the capability is switched on.
 *
 * OUTSIDE THE GATE ABOVE, deliberately. A deployment that switches handing work off still has
 * whatever it made while it was on, and rows that stop being reaped are rows that stay at the head
 * of the queue: switched back on a month later, the first thing that happens is a month-old question
 * being delivered to somebody who has long since stopped waiting. Reaping is housekeeping about the
 * past rather than part of the feature.
 *
 * Every replica reaps; the statement is a delete by age, so two doing it is the same as one doing it.
 * Its own loop rather than a phase of the sweep, so an hour of failing to reap never delays an answer.
 */
const reaper = createHandoffRunner({
  queue: createWorkQueue(database),
  owner: workOwner("reaper"),
  sign: () => "",
  auditStore: bootAuditStore,
  // Never called: `reap` deletes rows by age and claims nothing.
  delivery: {
    deliver: async () => {
      throw new Error("the reaper does not deliver hops");
    },
  },
});
repeatAfterEach(
  async () => {
    try {
      const purged = await reaper.reap();
      if (purged > 0) {
        console.info(JSON.stringify({ type: "bot-handoff-reaped", purged }));
      }
    } catch (error) {
      console.warn(
        "[handoff] hops that are over could not be dropped:",
        error instanceof Error ? error.message : error,
      );
    }
  },
  60 * 60 * 1_000,
);

/*
 * Naming conversations, in the API process rather than `worker/`, which the single-image container
 * does not run. Its own loop, so a slow model never delays a hop.
 */
const channelSummaries = {
  database,
  queue: createWorkQueue(database),
  transcript: routineIntelligence,
  title: createChannelTitler({
    model: runtimeModel.defaultModel,
    resolveApiKey: resolveRuntimeModelApiKey,
    resolveConnection: resolveRuntimeConnection,
  }),
  owner: workOwner("summariser"),
};
repeatAfterEach(async () => {
  try {
    await offerChannelsAwaitingSummary(channelSummaries);
    const report = await summariseClaimedChannels(channelSummaries);
    if (report.written.length > 0) {
      console.info(
        JSON.stringify({ type: "channel-summaries", written: report.written }),
      );
    }
    // Same pass: one statement, deletes by age, and two replicas running it changes nothing.
    await forgetSettledSummaries(channelSummaries);
  } catch (error) {
    // Never fatal, and never loud enough to drown the log: a deployment with no model configured
    // reaches this on every pass, and it has not gone wrong, it simply has no titles.
    console.warn(
      "[channels] conversations could not be named:",
      error instanceof Error ? error.message : error,
    );
  }
}, 10_000);

// Bot computers refuse egress until a policy arrives; ChisaBot has no network policy screen, so every
// running computer is kept on "allow all" (the upstream default with no organization row).
startEgressPolicyPush({
  ...(computerProvider ? { provider: computerProvider } : {}),
  ...(config.computer?.token ? { token: config.computer.token } : {}),
});

// Asked only whether this deployment pays for Intelligence, for the self-host banner. Its own client
// rather than the runtime's, the same as the thread reader: the constructor opens nothing.
const selfHostBannerIntelligence =
  config.runtime.mode === "intelligence"
    ? createIntelligenceClient(config.runtime.intelligence)
    : undefined;

const app = createApp(
  config,
  auth,
  roleRepository,
  createAuditReader(database),
  createCredentialAdminService(
    config.keyEncryptionKey,
    credentialStore,
    createAuditStore(database),
  ),
  createPackageStatusReader(database),
  // The runtime call: the model, per-actor agent loading, and the two identity
  // functions are how a run is attributed to a person.
  copilotRuntime.handler,
  // The only path to an acting call.
  computerGateway,
  policyStore,
  // Bots as durable objects, and the channels they run in.
  agentProfileStore,
  channelStore,
  channelEvents,
  // The same store the boot row uses, so a Bot's own refusal lands in the trail beside its actions.
  bootAuditStore,
  componentStore,
  // MCP servers and packaged skills. Judged by the same policy the computer actions are, read
  // fresh on every call for the same reason: a rule added a moment ago applies to the next call.
  pluginStore,
  // Components authored in the browser. Their governance is the component store's; this owns only
  // the source, which is the part a rebuild would otherwise have owned.
  sandboxedStore,
  // How a thread that has no channel is named, so the direct Bot chat is in the same namespace.
  threadIdentity,
  // Who has signed in, and what an administrator may do about them.
  peopleStore,
  // Enterprise identity providers (SSO) removed in slimming P6-2; positional slot.
  undefined,
  // Intent routing (choose a coworker for an untagged message) removed in slimming P4b; positional slot.
  undefined,
  // What a browsing turn's screen looked like when it finished, so the transcript can show it later.
  pageFrameStore,
  // Positional slots of the removed upstream routines runner + store (slimming P4c: merged into
  // ChisaBot schedules, server/src/schedules).
  undefined,
  undefined,
  // Where each person is in first-run onboarding, read by /api/me and written by the wizard.
  createOnboardingStore(database),
  // The same store every run reads through `loadInstructionsForActor`, so the screen a person edits
  // and the prompt their coworker is built from can never be two different pieces of text.
  userInstructionsStore,
  // The same database every other store here is built from, so a channel's staged and sent files
  // live behind the same connection as the messages that reference them.
  database,
  // Positional slot of the removed native host-folder broker (slimming P6-4, upstream desktop app).
  undefined,
  process.env.OPENBOT_DESKTOP_HOST_TOKEN,
  async (input) => {
    const proactiveRefusal = await guardProactiveCallback(
      input,
      proactiveReadOnlyRefs,
    );
    if (proactiveRefusal) return proactiveRefusal;
    const coordinated = await coordination.call(input);
    if (coordinated) return coordinated;
    const followUp = wakeUpTools({
      store: wakeUpStore,
      ownerUserId: input.actorId,
      agentId: input.botId,
      ...(input.initiator ? { initiator: input.initiator } : {}),
    }).find((candidate) => candidate.name === input.name);
    if (followUp) {
      const text = await followUp.execute(input.args);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    const { name, args, botId, actorId, initiator } = input;
    const memory = [
      ...memoryNotes.tools(actorId, botId),
      ...chisaSkills.tools(actorId, botId),
      ...vault.tools(actorId, botId, initiator ?? undefined),
      ...pages.tools(actorId, botId, initiator ?? undefined),
      ...(name.startsWith("github_") ? await github.tools(actorId, botId, initiator ?? undefined) : []),
      ...(/^(image_|file_share$|chat_files_)/.test(name) ? await chatFiles.tools(actorId, botId, initiator ?? undefined).catch(() => []) : []),
    ].find((candidate) => candidate.name === name);
    if (memory) {
      const text = await memory.execute(args);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if (name === RENDER_UI_TOOL) {
      if (!config.generativeUi)
        return {
          text: `${REFUSAL_MARKER} 这个部署关闭了生成式界面。`,
          isError: true,
        };
      const text = executeRenderUi(args);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if (name.startsWith("device_")) {
      const deviceTool = (
        await deviceToolsFor(actorId, botId, initiator ?? undefined)
      ).find((candidate) => candidate.name === name);
      if (!deviceTool) {
        return {
          text: `${REFUSAL_MARKER} 这项设备工具现在不可用：用户的电脑不在线，或这项能力在所有在线设备上都是关闭的（设置 → 设备 → 权限）。`,
          isError: true,
        };
      }
      const text = await deviceTool.execute(args);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    return null;
  },
  // The app directory, behind the same client the plugin store and the transport already share.
  // Absent without a key, which leaves the routes reporting no broker rather than listing apps
  // nobody could connect.
  composio ? { broker: composio.broker } : undefined,
  process.env.OPENBOT_MODEL_OAUTH_FILE?.trim()
    ? createProviderOAuthProxy(process.env.OPENBOT_MODEL_OAUTH_FILE.trim())
    : undefined,
  createUserPreferencesStore(database),
  undefined, // was voice sessions (removed in CB-046 step 2)
  undefined, // was Automatic Learning (removed in slimming P4b-3)
  {
    approvals: approvalService,
    ...(signInService ? { passwords: signInService } : {}),
    responsibilities: {
      store: responsibilityStore,
      engine: responsibilityEngine,
      bindings: responsibilityBindings,
      triggers: responsibilityTriggers,
    },
    lifecycle: {
      lifecycle: createBotLifecycleStore(database),
      reset: botReset,
      purge: createAgentPurge({
        database,
        reset: botReset,
        stopWorkers: async (agentId) => workerService?.stopForAgent(agentId),
        retirePanels: async (agentId) => livePanelService.retireBot(agentId),
        ...(computerGateway
          ? {
              forgetComputer: (agentId: string, actor: { id: string }) =>
                computerGateway.forgetComputer(
                  agentId,
                  // 不写 userId：内置管理员不一定是 users 表里的行（审计表外键），是谁记在内容里。
                  { id: actor.id },
                  "机器人被删除，它的浏览器（配置文件、登录状态、接管记录）随之删除",
                ),
            }
          : {}),
      }),
      activity: createActivityStore(database),
      wakeUps: wakeUpStore,
      profiles: agentProfileStore,
      auditStore: bootAuditStore,
    },
  },
  selfHostBannerIntelligence
    ? createSelfHostBanner({
        enabled: config.selfHostBanner,
        entitlements: () => selfHostBannerIntelligence.getRuntimeEntitlements(),
      })
    : { shown: async () => config.selfHostBanner },
  localBackend,
  modelSettings,
  agentModels,
  modelCatalog,
  panels,
  magpie,
  {
    modelCatalogRefreshMinutes,
    ...(gatewaySecret ? { singleUserGuard: createGatewayRequireUser(gatewaySecret, provisionGatewayUser) } : {}),
    extraRoutes: ({ requireUser }) => [
      [
        "/api/admin/smoke",
        createAdminSmokeRoutes({
          requireUser,
          resolveConnection: resolveRuntimeConnection,
          resolveConnectionForAgent: resolveRuntimeConnectionForAgent,
        }),
      ],
      [
        "/api/ops/budget",
        createOpsBudgetRoutes({ requireUser }),
      ],
      [
        "/api/admin/health",
        createOpsHealthRoutes({
          requireUser,
          pingDatabase: createDatabasePinger(database),
          magpie,
          gatewayMode: gatewaySecret ? "on" : "off",
          ...(computerProvider
            ? {
                probeComputer: async () => {
                  try {
                    // list() proves the provider answers. Do NOT invent a fake bot id:
                    // agent-computer /health with x-openbot-bot-id opens a session and 500s.
                    const list = await computerProvider.list();
                    let reachable = list.length === 0;
                    let error: string | undefined;
                    if (list[0]) {
                      const status = await computerProvider.status(list[0].botId);
                      reachable = status.state === "ready";
                      if (!reachable && status.reason) error = status.reason.slice(0, 200);
                    }
                    return {
                      // Provider reachable (list worked). Per-bot ready is informational.
                      ok: true as const,
                      configured: true as const,
                      provider: computerProvider.name,
                      reachable,
                      running: list.filter((c) => c.status === "running").length,
                      total: list.length,
                      ...(error ? { error } : {}),
                    };
                  } catch (error) {
                    return {
                      ok: false,
                      configured: true as const,
                      provider: computerProvider.name,
                      error: reasonWithoutStatement(error),
                    };
                  }
                },
              }
            : {}),
        }),
      ],
      ["/api/admin/model-fallbacks", modelFallbacks.routes(requireUser)],
      [
        "/api/admin/system-update",
        createSystemUpdateRoutes({
          service: systemUpdate,
          requireUser,
          auditStore: bootAuditStore,
        }),
      ],
      ["/api/live-panels", livePanelService.routes(requireUser)],
      ["/api/chat-shots", chatShots.routes(requireUser)],
      ["/api/bot-threads", botThreads.routes(requireUser)],
      ["/api/im", imService!.routes(requireUser)],
      ["/api/memory-notes", memoryNotes.routes(requireUser)],
      ["/api/bot-avatars", botAvatars.routes(requireUser)],
      ["/api/browser-bookmarks", browserBookmarks.routes(requireUser)],
      ["/api/chisa-skills", chisaSkills.routes(requireUser)],
      ["/api/vault", vault.routes(requireUser)],
      ["/api/github", github.routes(requireUser)],
      ["/api/pages", pages.routes(requireUser)],
      // 公开页面：不用登录（沙箱 CSP，见 server/src/pages/service.ts）。
      ["/p", pages.publicRoutes()],
      ["/api/schedules", schedules.routes(requireUser)],
      ...(localAgents ? [["/api/local-agents", localAgents.routes(requireUser)] satisfies [string, unknown]] : []),
      ...(cloudCc
        ? [
            ["/api/cloud-workspace", cloudCc.workspaceRoutes(requireUser)] satisfies [string, unknown],
            ["/api/claude-code", cloudCc.codeRoutes(requireUser)] satisfies [string, unknown],
            ...(cloudSync ? [["/api/claude-code", cloudSync.webRoutes(requireUser)] satisfies [string, unknown]] : []),
          ]
        : []),
      ["/api/chat-files", chatFiles.routes(requireUser)],
      ["/api/confirmations", confirmations.routes(requireUser)],
      ["/api/media-models", chatFiles.media.routes(requireUser)],
      ["/api/link-preview", linkPreviews.routes(requireUser)],
      [
        "/api/workflows",
        createWorkflowRoutes({
          store: workflowStore,
          engine: workflowEngineRef(),
          requireUser,
          auditStore: bootAuditStore,
          librarySkillSlugs: async (actorId) => {
            const actor = await actorFor(actorId);
            const skills = await pluginStore.listSkills({
              id: actor.id,
              isAdmin: actor.role === "admin",
            });
            return new Set(
              skills
                .filter(
                  (skill) =>
                    skill.ownerUserId === null || skill.ownerUserId === actor.id,
                )
                .map((skill) => skill.slug),
            );
          },
        }),
      ],
      [
        "/api/devices",
        createDeviceRoutes({
          store: deviceStore,
          hub: deviceHub,
          requireUser,
          auditStore: bootAuditStore,
          toolsFor: (actorId, botId) => deviceToolsFor(actorId, botId),
          refuseFullAccess: (device) => cloudCc?.refuseFullAccess(device.id) ?? null,
          sync: cloudSync ?? null,
          ...(config.appDistDir ? { appDistDir: config.appDistDir } : {}),
          ...(gatewaySecret ? { localCallerSecret: gatewaySecret } : {}),
        }),
      ],
    ],
  },
);

/**
 * The live screen, proxied.
 *
 * Proxied rather than connected directly. `agent-computer` authenticates its callers with a
 * shared token, not with a person's session, and it must never be reachable from a browser. So the
 * socket terminates here, behind the same session guard as every other route, and this process opens
 * a second socket inward carrying the token.
 *
 * Not a Hono route because an upgrade is not a request/response: Bun hands it over before Hono sees a
 * body, so it is handled in `fetch` ahead of the app.
 */
const toStreamUrl = (baseUrl: string, botId: string) =>
  // The Bot travels in the query, because a websocket upgrade carries no custom header for the
  // computer to read and every call it serves is per Bot. The secret travels the same way and for the
  // same reason, this socket is the one a person can type into, so it is the last thing that should
  // be reachable without it.
  `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(botId)}&token=${encodeURIComponent(config.computer?.token ?? "")}`;

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = {
  upstream: string;
  ownerUserId: string;
  botId: string;
  recordingId?: string;
  inward?: WebSocket;
};

/**
 * Bun takes exactly one WebSocket handler for the server, and two features need one: the app proxies
 * the computer stream, and it pushes channel activity through Hono's adapter. So this one
 * dispatches on what the upgrade attached, a proxy socket carries `upstream`, a Hono socket does
 * not, rather than either feature quietly taking the slot and breaking the other on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
type SocketData = StreamData | ChannelSocket["data"];

const isProxiedStream = (data: SocketData): data is StreamData =>
  typeof (data as StreamData).upstream === "string";

// Hono owns the socket's data once it has upgraded it; this hands its own back to it.
const asChannelSocket = (ws: { data: SocketData }) =>
  ws as unknown as ChannelSocket;

serve<SocketData>({
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/api/audio/transcriptions") {
      server.timeout(request, DICTATION_HTTP_IDLE_SECONDS);
    }
    // 计算机工具（打开网页、执行命令、接管）常常超过 Bun 默认的 10 秒空闲超时，被切断后用户看到
    // “计算机无法访问”而浏览器其实还在工作。由 agent-computer 自己的超时兜底。
    if (url.pathname.startsWith("/api/computers/") && !request.headers.get("upgrade")) server.timeout(request, 0);
    // §102：网页聊天里的计算机动作（含最长 600 秒的前台命令）经审批网关同步执行，同样不设空闲超时。
    if (url.pathname.startsWith("/api/approvals/computer/")) server.timeout(request, 0);
    // IM 接入：微信扫码状态是长轮询（约 25 秒），「测试连接」要等平台握手（最多 15 秒），超过 Bun 默认的 10 秒空闲。
    if (url.pathname.startsWith("/api/im/") && !request.headers.get("upgrade")) server.timeout(request, 60);
    // 模型回合是流式的（SSE）：免费 / 慢模型首个 token 前常常要想十几秒，带很多工具时更久。Bun 默认
    // 10 秒没有字节就切断连接，用户看到的就是「network error」、回合半途而废（2026-10-13 实测）。
    // 流式接口不设空闲超时，由运行本身的超时 / 停止兜底。
    if (
      url.pathname.startsWith("/api/copilotkit/") ||
      request.headers.get("accept")?.includes("text/event-stream")
    )
      server.timeout(request, 0);
    const streamBotId = streamPathBotId(url.pathname);
    if (
      streamBotId !== null &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      if (!config.computer) {
        return new Response("No computer is configured.", { status: 503 });
      }
      // The session guard, applied by hand because middleware does not run on an upgrade. An
      // unauthenticated socket here would be the whole point of the proxy defeated.
      const actor = await resolveRequestActor(request).catch(() => null);
      if (!actor) {
        return new Response("Sign in first.", { status: 401 });
      }
      // And which Bot, which the guard above does not answer. This socket carries that Bot's screen,
      // so signing in is not enough: without this, anybody signed in watches anybody's Bot work. And
      // seeing a Team Bot is not enough either: its screen is its owner's signed-in browser.
      if (
        !(await computerAccessCheck(agentProfileStore)(
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
      let upstream: string;
      try {
        const streamBase = computerGateway
          ? await computerGateway.locate(streamBotId)
          : undefined;
        if (!streamBase) {
          return new Response("No computer address is configured.", {
            status: 503,
          });
        }
        upstream = toStreamUrl(streamBase, streamBotId);
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
          },
        })
      ) {
        return undefined as unknown as Response;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }
    return app.fetch(request, { server });
  },
  websocket: {
    // CR-P2-12: browser ↔ proxy must not die on a static screencast. Bun auto-pings; idleTimeout
    // matches agent-computer. Application `{type:"ping"}` from the computer also crosses this hop
    // as a data frame (protocol pings do not).
    sendPings: true,
    idleTimeout: 120,
    open(ws) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.open(asChannelSocket(ws));
        return;
      }
      const stream = ws.data;
      // CR-P2-09：构造失败 / 两端错误都要收口，慢客户端靠 send 抛错丢帧（不排队）。
      let inward: WebSocket;
      try {
        inward = new WebSocket(stream.upstream);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "computer-stream-upstream-open-failed",
            error: reasonWithoutStatement(error).slice(0, 200),
          }),
        );
        bumpOps(OPS_CODES.STREAM_DISCONNECT, {
          fields: { reason: "upstream-open-failed" },
        });
        ws.close(1011, "upstream unavailable");
        return;
      }
      stream.inward = inward;
      // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
      // should be dropped, not queued, because a stale frame is worse than a missing one.
      // Bun's ws.send throws when the socket is not OPEN; if a future runtime queues instead,
      // drop when bufferedAmount is already large rather than grow without bound.
      inward.onmessage = (event) => {
        try {
          const buffered = (ws as unknown as { bufferedAmount?: number }).bufferedAmount;
          if (typeof buffered === "number" && buffered > 2_000_000) {
            return; // drop stale frame rather than queue forever
          }
          ws.send(String(event.data));
        } catch {
          try { inward.close(); } catch { /* ignore */ }
        }
      };
      inward.onclose = () => {
        try { ws.close(); } catch { /* ignore */ }
      };
      inward.onerror = () => {
        bumpOps(OPS_CODES.STREAM_DISCONNECT, {
          fields: { reason: "upstream-error" },
        });
        try { ws.close(); } catch { /* ignore */ }
      };
    },
    message(ws, raw) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.message(asChannelSocket(ws), raw);
        return;
      }
      if (ws.data.inward?.readyState === 1) ws.data.inward.send(String(raw));
    },
    close(ws, code, reason) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.close(asChannelSocket(ws), code, reason);
        return;
      }
      // 1000/1001 = clean; anything else is a budget event (idle kick, proxy death, …).
      if (code !== 1000 && code !== 1001) {
        bumpOps(OPS_CODES.STREAM_DISCONNECT, {
          fields: { reason: "ws-close", code },
        });
      }
      ws.data.inward?.close();
    },
  },
});

if (config.singleUser) {
  // Loud, every boot. A server that is not checking who is asking should never be a quiet default.
  console.warn(
    "No identity provider is configured, so every request is treated as " +
      `${DEV_ACTOR.email} (administrator). Configure GOOGLE_OAUTH_*, ` +
      "MICROSOFT_OAUTH_* or OKTA_OAUTH_* before anybody else can reach this.",
  );
}

// Each listener holds a connection of its own for the life of the process. Released on the way out,
// so a watch-mode restart does not leave two behind on every reload.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    responsibilitySweep.stop();
    livePanelService.stop();
    wakeUpSweep.stop();
    schedules.stop();
    wakeUpReaper.stop();
    approvalSweep.stop();
    personResponseSweep.stop();
    groupSweep.stop();
    void Promise.allSettled([
      imService?.stopAll() ?? Promise.resolve(),
      channelActivityListener.stop(),
      policyListener.stop(),
      // Started only where handing work between Bots is switched on, so it is often not there.
      workOfferedListener?.stop() ?? Promise.resolve(),
      Promise.resolve(retentionSweeps.stop()),
    ]).finally(() => process.exit(0));
  });
}

console.info(`OpenBot server listening on http://127.0.0.1:${port}`);

// IM 接入：服务起来以后再连各平台（适配器自己断线重连）。CHISABOT_IM=0 关掉（不连任何平台）。
if (process.env.CHISABOT_IM !== "0") {
  setTimeout(() => {
    void imService
      ?.startAll()
      .then((count) => count && console.info(JSON.stringify({ type: "im-started", connections: count })))
      .catch((error) => console.error(JSON.stringify({ type: "im-start-failed", reason: String(error) })));
  }, 3000);
}
