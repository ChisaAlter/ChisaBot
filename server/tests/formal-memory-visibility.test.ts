import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import fc from "fast-check";
import { lastValueFrom, of, toArray } from "rxjs";
import {
  canModifyMemoryNote,
  canReadMemoryNote,
  isSharedVisibility,
  MEMORY_LIMITS,
  type MemoryKind,
  type MemoryViewer,
  type MemoryVisibility,
  type MemoryVisibilityNote,
  resolveMemoryVisibility,
} from "../../shared/memory-notes";
import {
  assertModelHolds,
  exploreModel,
  type StateModel,
} from "../../shared/verification/model-checker";
import type { BotReset } from "../src/agents/lifecycle-reset";
import { createAgentPurge } from "../src/agents/purge";
import type { Database } from "../src/db/client";
import {
  createPersonalMemoryLoader,
  PersonalMemoryMiddleware,
} from "../src/memory/tools";
import {
  compareMemoryKindId,
  searchMemoryNotes,
  toVisibilityNote,
} from "../src/memory-notes/search";
import {
  assembleMemoryContext,
  createMemoryNotes,
  dayIn,
  MemoryNoteError,
} from "../src/memory-notes/service";
import { planTidy, type TidyRow } from "../src/memory-notes/tidy";

/**
 * 四级记忆隔离（private / bot_private / team / public）+ 删 Bot 清理 + 滞后写入拦截 + 4000 字稳定前缀缓存形式化验证。
 */

type OwnerId = "ownerA" | "ownerB";
type BotId = "bot1" | "bot2" | "deletedBot";
type ChatMode = "privateChat" | "groupChat";

const OWNERS: readonly OwnerId[] = ["ownerA", "ownerB"];
const BOTS: readonly BotId[] = ["bot1", "bot2", "deletedBot"];
const CHAT_MODES: readonly ChatMode[] = ["privateChat", "groupChat"];

type ModelNote = {
  id: string;
  ownerUserId: OwnerId;
  agentId: BotId;
  kind: MemoryKind;
  subject: string;
  content: string;
  context: string | null;
  visibility: MemoryVisibility;
  shared: boolean;
};

interface VisibilityModelState {
  notes: readonly ModelNote[];
  deletedBotRemoved: boolean;
  laggedWriteSucceeded: boolean;
  seq: number;
}

interface VisibilityFaults {
  /** 变异体 1：读校验漏掉 agent_id 比对，导致兄弟 Bot 读到 bot_private。 */
  omitAgentIdCheck?: boolean;
  /** 变异体 2A：删 Bot 时漏清已存在的 bot_private 记忆。 */
  skipPurgeOnDelete?: boolean;
  /** 变异体 2B：未拦截来自已删除 Bot 的 bot_private 滞后写入。 */
  allowLaggedWriteAfterDelete?: boolean;
  /** 变异体 3：群聊场景漏检 isGroupChat，导致 private/bot_private 泄露。 */
  omitGroupChatCheck?: boolean;
}

type CanonicalSpec = {
  slotKey: string;
  owner: OwnerId;
  bot: BotId;
  visibility: MemoryVisibility;
  kind: MemoryKind;
};

const CANONICAL_SPECS: readonly CanonicalSpec[] = [
  {
    slotKey: "A-bot1-private",
    owner: "ownerA",
    bot: "bot1",
    visibility: "private",
    kind: "preference",
  },
  {
    slotKey: "A-bot1-bot_private",
    owner: "ownerA",
    bot: "bot1",
    visibility: "bot_private",
    kind: "note",
  },
  {
    slotKey: "A-deletedBot-bot_private",
    owner: "ownerA",
    bot: "deletedBot",
    visibility: "bot_private",
    kind: "note",
  },
  {
    slotKey: "B-bot2-private",
    owner: "ownerB",
    bot: "bot2",
    visibility: "private",
    kind: "profile",
  },
  {
    slotKey: "B-bot2-bot_private",
    owner: "ownerB",
    bot: "bot2",
    visibility: "bot_private",
    kind: "note",
  },
  {
    slotKey: "A-bot1-team",
    owner: "ownerA",
    bot: "bot1",
    visibility: "team",
    kind: "note",
  },
  {
    slotKey: "B-bot2-public",
    owner: "ownerB",
    bot: "bot2",
    visibility: "public",
    kind: "note",
  },
];

function evaluateRead(
  note: MemoryVisibilityNote,
  viewer: MemoryViewer,
  faults: VisibilityFaults,
): boolean {
  if (
    faults.omitAgentIdCheck &&
    resolveMemoryVisibility(note) === "bot_private"
  ) {
    return (
      note.ownerUserId === viewer.userId &&
      !viewer.isGroupChat &&
      (!note.agentId || !viewer.deletedBotIds?.has(note.agentId))
    );
  }
  if (faults.omitGroupChatCheck) {
    return canReadMemoryNote(note, { ...viewer, isGroupChat: false });
  }
  return canReadMemoryNote(note, viewer);
}

function toRow(note: ModelNote) {
  return {
    id: note.id,
    owner_user_id: note.ownerUserId,
    kind: note.kind,
    subject: note.subject,
    content: note.content,
    context: note.context,
    agent_id: note.agentId,
    visibility: note.visibility,
    shared: note.shared,
    created_at: "2026-11-16T00:00:00.000Z",
    updated_at: "2026-11-16T00:00:00.000Z",
  };
}

function createMemoryVisibilityModel(
  faults: VisibilityFaults = {},
  name = "四级记忆隔离与删Bot净化状态机",
): StateModel<VisibilityModelState> {
  return {
    name,
    initial: (): VisibilityModelState => ({
      notes: [],
      deletedBotRemoved: false,
      laggedWriteSucceeded: false,
      seq: 0,
    }),
    canonicalize: (s) =>
      JSON.stringify({
        notes: s.notes.map((n) => n.id).sort(),
        deleted: s.deletedBotRemoved,
        lagged: s.laggedWriteSucceeded,
      }),
    transitions: [
      ...CANONICAL_SPECS.map((spec) => ({
        name: `writeNote(${spec.slotKey})`,
        guard: (s: Readonly<VisibilityModelState>) =>
          !s.notes.some((n) => n.id === `mem_${spec.slotKey}`),
        apply: (s: Readonly<VisibilityModelState>): VisibilityModelState => {
          const isDeletedWriter =
            s.deletedBotRemoved && spec.bot === "deletedBot";
          if (spec.visibility === "bot_private" && isDeletedWriter) {
            if (!faults.allowLaggedWriteAfterDelete) {
              return { ...s };
            }
            const nextNote: ModelNote = {
              id: `mem_${spec.slotKey}`,
              ownerUserId: spec.owner,
              agentId: spec.bot,
              kind: spec.kind,
              subject: spec.slotKey,
              content: `secret-${spec.slotKey}`,
              context: null,
              visibility: spec.visibility,
              shared: isSharedVisibility(spec.visibility),
            };
            return {
              ...s,
              notes: [...s.notes, nextNote],
              laggedWriteSucceeded: true,
              seq: s.seq + 1,
            };
          }

          const nextNote: ModelNote = {
            id: `mem_${spec.slotKey}`,
            ownerUserId: spec.owner,
            agentId: spec.bot,
            kind: spec.kind,
            subject: spec.slotKey,
            content: `secret-${spec.slotKey}`,
            context: null,
            visibility: spec.visibility,
            shared: isSharedVisibility(spec.visibility),
          };
          return {
            ...s,
            notes: [...s.notes, nextNote],
            seq: s.seq + 1,
          };
        },
      })),
      {
        name: "deleteBot(deletedBot)",
        guard: (s) => !s.deletedBotRemoved,
        apply: (s): VisibilityModelState => ({
          ...s,
          deletedBotRemoved: true,
          notes: faults.skipPurgeOnDelete
            ? s.notes
            : s.notes.filter(
                (n) =>
                  !(
                    n.agentId === "deletedBot" && n.visibility === "bot_private"
                  ),
              ),
        }),
      },
    ],
    invariants: [
      {
        name: "noCrossUserOrBotPrivateLeak",
        check: (s) => {
          const deletedSet = s.deletedBotRemoved
            ? new Set<string>(["deletedBot"])
            : new Set<string>();
          for (const owner of OWNERS) {
            for (const bot of BOTS) {
              for (const chat of CHAT_MODES) {
                const isGroupChat = chat === "groupChat";
                const viewer: MemoryViewer = {
                  userId: owner,
                  agentId: bot,
                  isGroupChat,
                  deletedBotIds: deletedSet,
                };
                for (const note of s.notes) {
                  const allowed = evaluateRead(note, viewer, faults);
                  if (note.visibility === "private") {
                    const expected = note.ownerUserId === owner && !isGroupChat;
                    if (allowed !== expected) {
                      return `private 越权：note=${note.id} viewer=(${owner},${bot},${chat}) allowed=${allowed}`;
                    }
                  }
                  if (note.visibility === "bot_private") {
                    const expected =
                      note.ownerUserId === owner &&
                      note.agentId === bot &&
                      !isGroupChat &&
                      !deletedSet.has(note.agentId);
                    if (allowed !== expected) {
                      return `bot_private 越权：note=${note.id} viewer=(${owner},${bot},${chat}) allowed=${allowed}`;
                    }
                  }
                  if (
                    isGroupChat &&
                    (note.visibility === "private" ||
                      note.visibility === "bot_private") &&
                    allowed
                  ) {
                    return `群聊泄露私有记忆：note=${note.id} viewer=(${owner},${bot})`;
                  }
                }
              }
            }
          }
          return true;
        },
      },
      {
        name: "deletedBotBotPrivatePurgedAndLaggedWriteBlocked",
        check: (s) => {
          if (s.laggedWriteSucceeded) {
            return "已删除 Bot 的滞后 bot_private 写入未被拦截";
          }
          if (s.deletedBotRemoved) {
            const leftover = s.notes.find(
              (n) =>
                n.agentId === "deletedBot" && n.visibility === "bot_private",
            );
            if (leftover) {
              return `删 Bot 后仍残留 bot_private 记忆：${leftover.id}`;
            }
          }
          return true;
        },
      },
      {
        name: "sharedMappingAndReadOnlyPublic",
        check: (s) => {
          for (const note of s.notes) {
            const expectedShared =
              note.visibility === "team" || note.visibility === "public";
            if (note.shared !== expectedShared) {
              return `shared 兼容列不一致：${note.id}`;
            }
            if (note.visibility === "public") {
              const nonAdminViewer: MemoryViewer = {
                userId: note.ownerUserId,
                agentId: note.agentId,
                isGroupChat: false,
                isAdmin: false,
              };
              if (canModifyMemoryNote(note, nonAdminViewer)) {
                return `public 记忆未保持只读：${note.id}`;
              }
            }
          }
          return true;
        },
      },
      {
        name: "searchAndTidyMatchReadPolicy",
        check: (s) => {
          const deletedSet = s.deletedBotRemoved
            ? new Set<string>(["deletedBot"])
            : new Set<string>();
          const rows = s.notes.map(toRow);
          for (const owner of OWNERS) {
            for (const bot of BOTS) {
              for (const chat of CHAT_MODES) {
                const viewer: MemoryViewer = {
                  userId: owner,
                  agentId: bot,
                  isGroupChat: chat === "groupChat",
                  deletedBotIds: deletedSet,
                };
                const searched = searchMemoryNotes(rows, "", viewer, {
                  limit: 100,
                });
                const expectedIds = s.notes
                  .filter((n) => canReadMemoryNote(n, viewer))
                  .map((n) => n.id);
                if (
                  searched.map((r) => r.id).join(",") !== expectedIds.join(",")
                ) {
                  return `searchMemoryNotes 与 canReadMemoryNote 不一致`;
                }
                const tidyPlan = planTidy(rows as TidyRow[], viewer);
                if (viewer.isGroupChat && tidyPlan.total !== 0) {
                  return "群聊场景 planTidy 不应纳入私有笔记";
                }
              }
            }
          }
          return true;
        },
      },
    ],
  };
}

/** 轻量内存 PostgreSQL 适配层：直接驱动真实 `createMemoryNotes` 的存储/搜索/整理/上下文全路径。 */
function createInMemoryMemoryDb(initialDeletedProfiles: string[] = []) {
  type DbRow = ReturnType<typeof toRow> & {
    id: string;
    owner_user_id: string;
    kind: MemoryKind;
    subject: string | null;
    content: string;
    context: string | null;
    agent_id: string | null;
    visibility: MemoryVisibility;
    shared: boolean;
    created_at: string;
    updated_at: string;
  };
  type BotPref = { owner_user_id: string; agent_id: string; enabled: boolean };

  const notes: DbRow[] = [];
  const bots: BotPref[] = [];
  const profiles = new Map<string, Date | null>();
  for (const id of initialDeletedProfiles) {
    profiles.set(id, new Date("2026-11-16T00:00:00.000Z"));
  }
  const backups: Array<{
    batch_id: string;
    owner_user_id: string;
    note_id: string;
    action: "updated" | "deleted";
    original: string;
    after_content: string | null;
    merged: number;
    deduplicated: number;
    created_at: string;
  }> = [];
  let ensured = false;
  let tick = 0;

  const matchesScope = (row: DbRow, q: string, params: unknown[]) => {
    if (q.includes("visibility = 'bot_private' AND agent_id = $4")) {
      return row.visibility === "bot_private" && row.agent_id === params[3];
    }
    if (q.includes("visibility = 'team'")) {
      return (
        row.visibility === "team" ||
        (row.shared === true && row.visibility === "private")
      );
    }
    if (q.includes("visibility = 'public'")) {
      return row.visibility === "public";
    }
    if (q.includes("visibility = 'private' AND shared = false")) {
      return row.visibility === "private" && !row.shared;
    }
    return true;
  };

  const run = async (
    query: string,
    params: unknown[] = [],
  ): Promise<unknown[]> => {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.includes("CREATE TABLE IF NOT EXISTS chisabot_memory_notes")) {
      ensured = true;
      return [];
    }
    if (q.includes("to_regclass('public.agent_profiles')")) {
      return [{ present: true }];
    }
    if (
      q.startsWith(
        "SELECT agent_id FROM agent_profiles WHERE deleted_at IS NOT NULL",
      )
    ) {
      return [...profiles.entries()]
        .filter(([, deletedAt]) => deletedAt !== null)
        .map(([agent_id]) => ({ agent_id }));
    }
    if (
      q.startsWith("SELECT deleted_at FROM agent_profiles WHERE agent_id = $1")
    ) {
      const id = String(params[0] ?? "");
      if (!profiles.has(id)) return [];
      return [{ deleted_at: profiles.get(id) ?? null }];
    }
    if (
      q.startsWith(
        "SELECT * FROM chisabot_memory_notes WHERE owner_user_id = $1 ORDER BY updated_at DESC",
      )
    ) {
      const owner = String(params[0] ?? "");
      const limit = Number(params[1] ?? 3000);
      return notes
        .filter((r) => r.owner_user_id === owner)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, limit)
        .map((r) => ({ ...r }));
    }
    if (
      q.startsWith(
        "SELECT * FROM chisabot_memory_notes WHERE (visibility IN ('team', 'public') OR shared = true) AND owner_user_id <> $1",
      )
    ) {
      const owner = String(params[0] ?? "");
      const limit = Number(params[1] ?? 200);
      return notes
        .filter(
          (r) =>
            r.owner_user_id !== owner &&
            (r.visibility === "team" || r.visibility === "public" || r.shared),
        )
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, limit)
        .map((r) => ({ ...r }));
    }
    if (q.startsWith("SELECT * FROM chisabot_memory_notes WHERE id = $1 AND")) {
      const [id, owner, isAdmin] = params as [string, string, boolean];
      const found = notes.find(
        (r) =>
          r.id === id &&
          (r.owner_user_id === owner ||
            (isAdmin &&
              (r.visibility === "team" ||
                r.visibility === "public" ||
                r.shared))),
      );
      return found ? [{ ...found }] : [];
    }
    if (q.includes("AND lower(subject) = lower($3)")) {
      const [owner, kind, subject] = params as [string, MemoryKind, string];
      const found = notes.find(
        (r) =>
          r.owner_user_id === owner &&
          r.kind === kind &&
          (r.subject ?? "").toLowerCase() === subject.toLowerCase() &&
          matchesScope(r, q, params),
      );
      return found ? [{ ...found }] : [];
    }
    if (q.includes("AND content = $3")) {
      const [owner, kind, content] = params as [string, MemoryKind, string];
      const found = notes.find(
        (r) =>
          r.owner_user_id === owner &&
          r.kind === kind &&
          r.content === content &&
          matchesScope(r, q, params),
      );
      return found ? [{ ...found }] : [];
    }
    if (
      q.startsWith(
        "SELECT count(*)::int AS n FROM chisabot_memory_notes WHERE owner_user_id = $1",
      )
    ) {
      const owner = String(params[0] ?? "");
      return [{ n: notes.filter((r) => r.owner_user_id === owner).length }];
    }
    if (
      q.startsWith("INSERT INTO chisabot_memory_notes") &&
      q.includes("visibility")
    ) {
      const [
        id,
        owner,
        kind,
        subject,
        content,
        context,
        agentId,
        shared,
        visibility,
      ] = params as [
        string,
        string,
        MemoryKind,
        string | null,
        string,
        string | null,
        string | null,
        boolean,
        MemoryVisibility,
      ];
      tick += 1;
      const now = new Date(Date.UTC(2026, 10, 16, 0, 0, tick)).toISOString();
      const row: DbRow = {
        id,
        owner_user_id: owner,
        kind,
        subject,
        content,
        context,
        agent_id: agentId,
        shared,
        visibility,
        created_at: now,
        updated_at: now,
      };
      notes.push(row);
      return [{ ...row }];
    }
    if (
      q.startsWith(
        "UPDATE chisabot_memory_notes SET content = $3, context = COALESCE($4, context)",
      )
    ) {
      const [id, owner, content, context] = params as [
        string,
        string,
        string,
        string | null,
      ];
      const row = notes.find((r) => r.id === id && r.owner_user_id === owner);
      if (!row) return [];
      tick += 1;
      row.content = content;
      if (context !== null) row.context = context;
      row.updated_at = new Date(
        Date.UTC(2026, 10, 16, 0, 0, tick),
      ).toISOString();
      return [{ ...row }];
    }
    if (q.startsWith("UPDATE chisabot_memory_notes SET kind = $3")) {
      const [id, owner, kind, subject, content, context, shared, visibility] =
        params as [
          string,
          string,
          MemoryKind,
          string | null,
          string,
          string | null,
          boolean,
          MemoryVisibility,
        ];
      const row = notes.find((r) => r.id === id && r.owner_user_id === owner);
      if (!row) return [];
      tick += 1;
      row.kind = kind;
      row.subject = subject;
      row.content = content;
      row.context = context;
      row.shared = shared;
      row.visibility = visibility;
      row.updated_at = new Date(
        Date.UTC(2026, 10, 16, 0, 0, tick),
      ).toISOString();
      return [{ ...row }];
    }
    if (
      q.startsWith(
        "SELECT * FROM chisabot_memory_notes WHERE (owner_user_id = $1",
      )
    ) {
      const [owner, isAdmin, joined] = params as [string, boolean, string];
      const idSet = new Set(joined.split("\u001f"));
      return notes
        .filter(
          (r) =>
            idSet.has(r.id) &&
            (r.owner_user_id === owner ||
              (isAdmin &&
                (r.visibility === "team" ||
                  r.visibility === "public" ||
                  r.shared))),
        )
        .map((r) => ({ ...r }));
    }
    if (
      q.startsWith(
        "DELETE FROM chisabot_memory_notes WHERE (owner_user_id = $1",
      )
    ) {
      const [owner, isAdmin, joined] = params as [string, boolean, string];
      const idSet = new Set(joined.split("\u001f"));
      const deleted: DbRow[] = [];
      for (let i = notes.length - 1; i >= 0; i--) {
        const r = notes[i];
        if (
          r &&
          idSet.has(r.id) &&
          (r.owner_user_id === owner ||
            (isAdmin &&
              (r.visibility === "team" ||
                r.visibility === "public" ||
                r.shared)))
        ) {
          deleted.unshift({ ...r });
          notes.splice(i, 1);
        }
      }
      return deleted;
    }
    if (q.startsWith("SELECT enabled FROM chisabot_memory_bots")) {
      const [owner, agentId] = params as [string, string];
      const hit = bots.find(
        (b) => b.owner_user_id === owner && b.agent_id === agentId,
      );
      return hit ? [{ enabled: hit.enabled }] : [];
    }
    if (q.startsWith("INSERT INTO chisabot_memory_bots")) {
      const [owner, agentId, enabled] = params as [string, string, boolean];
      const hit = bots.find(
        (b) => b.owner_user_id === owner && b.agent_id === agentId,
      );
      if (hit) hit.enabled = enabled;
      else bots.push({ owner_user_id: owner, agent_id: agentId, enabled });
      return [];
    }
    if (
      q.startsWith(
        "SELECT * FROM chisabot_memory_notes WHERE owner_user_id = $1 AND shared = false",
      )
    ) {
      const owner = String(params[0] ?? "");
      return notes
        .filter((r) => r.owner_user_id === owner && !r.shared)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((r) => ({ ...r }));
    }
    if (
      q.startsWith(
        "DELETE FROM chisabot_memory_tidy_backups WHERE owner_user_id = $1 OR",
      )
    ) {
      const owner = String(params[0] ?? "");
      for (let i = backups.length - 1; i >= 0; i--) {
        if (backups[i]?.owner_user_id === owner) backups.splice(i, 1);
      }
      return [];
    }
    if (q.startsWith("INSERT INTO chisabot_memory_tidy_backups")) {
      const [
        batch_id,
        owner_user_id,
        note_id,
        action,
        original,
        after_content,
        merged,
        deduplicated,
      ] = params as [
        string,
        string,
        string,
        "updated" | "deleted",
        string,
        string | null,
        number,
        number,
      ];
      backups.push({
        batch_id,
        owner_user_id,
        note_id,
        action,
        original,
        after_content,
        merged,
        deduplicated,
        created_at: new Date().toISOString(),
      });
      return [];
    }
    if (
      q.startsWith(
        "UPDATE chisabot_memory_notes SET content = $3, updated_at = now()",
      )
    ) {
      const [id, owner, content] = params as [string, string, string];
      const row = notes.find((r) => r.id === id && r.owner_user_id === owner);
      if (row) row.content = content;
      return [];
    }
    if (
      q.startsWith(
        "DELETE FROM chisabot_memory_notes WHERE owner_user_id = $1 AND id = ANY",
      )
    ) {
      const [owner, joined] = params as [string, string];
      const idSet = new Set(joined.split("\u001f"));
      for (let i = notes.length - 1; i >= 0; i--) {
        const r = notes[i];
        if (r && r.owner_user_id === owner && idSet.has(r.id)) {
          notes.splice(i, 1);
        }
      }
      return [];
    }
    if (
      q.startsWith(
        "SELECT * FROM chisabot_memory_tidy_backups WHERE owner_user_id = $1 AND batch_id = $2",
      )
    ) {
      const [owner, batchId] = params as [string, string];
      return backups
        .filter((b) => b.owner_user_id === owner && b.batch_id === batchId)
        .map((b) => ({ ...b, original: JSON.parse(b.original) }));
    }
    if (
      q.startsWith("INSERT INTO chisabot_memory_notes") &&
      q.includes("ON CONFLICT (id) DO NOTHING")
    ) {
      const [
        id,
        owner,
        kind,
        subject,
        content,
        context,
        agentId,
        createdAt,
        updatedAt,
      ] = params as [
        string,
        string,
        MemoryKind,
        string | null,
        string,
        string | null,
        string | null,
        string,
        string,
      ];
      if (notes.some((r) => r.id === id)) return [];
      notes.push({
        id,
        owner_user_id: owner,
        kind,
        subject,
        content,
        context,
        agent_id: agentId,
        shared: false,
        visibility: "private",
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return [{ id }];
    }
    if (
      q.startsWith(
        "UPDATE chisabot_memory_notes SET visibility = 'bot_private'",
      )
    ) {
      const [id, owner] = params as [string, string];
      const row = notes.find((r) => r.id === id && r.owner_user_id === owner);
      if (row) row.visibility = "bot_private";
      return [];
    }
    if (
      q.startsWith(
        "DELETE FROM chisabot_memory_tidy_backups WHERE owner_user_id = $1 AND batch_id = $2",
      )
    ) {
      const [owner, batchId] = params as [string, string];
      for (let i = backups.length - 1; i >= 0; i--) {
        if (
          backups[i]?.owner_user_id === owner &&
          backups[i]?.batch_id === batchId
        ) {
          backups.splice(i, 1);
        }
      }
      return [];
    }
    if (
      q.startsWith(
        "SELECT batch_id, created_at, merged, deduplicated FROM chisabot_memory_tidy_backups",
      )
    ) {
      const owner = String(params[0] ?? "");
      const latest = [...backups]
        .reverse()
        .find((b) => b.owner_user_id === owner);
      return latest ? [{ ...latest }] : [];
    }
    throw new Error(`未实现的测试 SQL: ${q}`);
  };

  const client = {
    unsafe: run,
    begin: async <T>(
      fn: (tx: { unsafe: typeof run; begin: unknown }) => Promise<T>,
    ) => fn({ unsafe: run, begin: client.begin }),
  };

  return {
    database: { $client: client } as unknown as Database,
    notes,
    markBotDeleted: (agentId: string) => {
      profiles.set(agentId, new Date("2026-11-16T00:00:00.000Z"));
      for (let i = notes.length - 1; i >= 0; i--) {
        const r = notes[i];
        if (r && r.agent_id === agentId && r.visibility === "bot_private") {
          notes.splice(i, 1);
        }
      }
    },
    isEnsured: () => ensured,
  };
}

describe("四级记忆隔离形式化证明（BFS + fast-check + 双变异体捕杀）", () => {
  test("BFS 全可达状态空间证明四级读写隔离、删 Bot 清除与滞后写入拦截", () => {
    const result = assertModelHolds(createMemoryVisibilityModel());
    expect(result.exploredStates).toBeGreaterThan(50);
    expect(result.exploredTransitions).toBeGreaterThan(200);
  });

  test("fast-check 随机动作序列直接验证真实 canReadMemoryNote 与存储过滤路径", async () => {
    const actionArb = fc.array(
      fc.oneof(
        fc.record({
          type: fc.constant("create" as const),
          owner: fc.constantFrom<OwnerId>("ownerA", "ownerB"),
          bot: fc.constantFrom<BotId>("bot1", "bot2", "deletedBot"),
          visibility: fc.constantFrom<MemoryVisibility>(
            "private",
            "bot_private",
            "team",
            "public",
          ),
          tag: fc.constantFrom("咖啡", "项目", "机密", "规范"),
          nonce: fc.integer({ min: 1, max: 50 }),
        }),
        fc.record({
          type: fc.constant("search" as const),
          owner: fc.constantFrom<OwnerId>("ownerA", "ownerB"),
          bot: fc.constantFrom<BotId>("bot1", "bot2", "deletedBot"),
          isGroupChat: fc.boolean(),
          query: fc.constantFrom("", "咖啡", "机密"),
        }),
        fc.record({
          type: fc.constant("context" as const),
          owner: fc.constantFrom<OwnerId>("ownerA", "ownerB"),
          bot: fc.constantFrom<BotId>("bot1", "bot2", "deletedBot"),
          isGroupChat: fc.boolean(),
          question: fc.constantFrom("", "咖啡", "无关问题"),
        }),
        fc.record({
          type: fc.constant("deleteBot" as const),
          bot: fc.constant<BotId>("deletedBot"),
        }),
      ),
      { minLength: 5, maxLength: 35 },
    );

    await fc.assert(
      fc.asyncProperty(actionArb, async (actions) => {
        const db = createInMemoryMemoryDb();
        const deletedBots = new Set<string>();
        const service = createMemoryNotes(db.database, {
          isBotDeleted: (id) => deletedBots.has(id),
        });
        await service.ensure();

        for (const action of actions) {
          if (action.type === "deleteBot") {
            deletedBots.add(action.bot);
            db.markBotDeleted(action.bot);
            continue;
          }

          if (action.type === "create") {
            const isAdmin =
              action.visibility === "team" || action.visibility === "public";
            const input = {
              kind: "note" as const,
              subject: `${action.tag}-${action.nonce}`,
              content: `TAG_${action.owner}_${action.bot}_${action.visibility}_${action.tag}_${action.nonce}`,
              visibility: action.visibility,
            };
            if (
              action.visibility === "bot_private" &&
              deletedBots.has(action.bot)
            ) {
              await expect(
                service.create(action.owner, input, action.bot, isAdmin),
              ).rejects.toThrow(MemoryNoteError);
            } else {
              const created = await service.create(
                action.owner,
                input,
                action.bot,
                isAdmin,
              );
              expect(created.note.visibility).toBe(action.visibility);
              expect(created.note.shared).toBe(
                isSharedVisibility(action.visibility),
              );
            }
            continue;
          }

          if (action.type === "search") {
            const viewer: MemoryViewer = {
              userId: action.owner,
              agentId: action.bot,
              isGroupChat: action.isGroupChat,
              deletedBotIds: deletedBots,
            };
            const found = await service.search(
              action.owner,
              action.query,
              undefined,
              100,
              viewer,
            );
            for (const row of found) {
              expect(canReadMemoryNote(toVisibilityNote(row), viewer)).toBe(
                true,
              );
            }
            // 禁止出现任何其他 Bot 的 bot_private 或已删 Bot 的 bot_private
            for (const row of found) {
              if (row.visibility === "bot_private") {
                expect(action.isGroupChat).toBe(false);
                expect(row.owner_user_id).toBe(action.owner);
                expect(row.agent_id).toBe(action.bot);
                expect(deletedBots.has(row.agent_id ?? "")).toBe(false);
              }
              if (row.visibility === "private") {
                expect(action.isGroupChat).toBe(false);
                expect(row.owner_user_id).toBe(action.owner);
              }
            }
            continue;
          }

          if (action.type === "context") {
            const basePrefix = await service.context(action.owner, action.bot, {
              isGroupChat: action.isGroupChat,
            });
            const withQuestion = await service.context(
              action.owner,
              action.bot,
              {
                question: action.question,
                isGroupChat: action.isGroupChat,
              },
            );
            if (deletedBots.has(action.bot)) {
              expect(basePrefix).toBe("");
              expect(withQuestion).toBe("");
            } else {
              expect(basePrefix.length).toBeLessThanOrEqual(
                MEMORY_LIMITS.prefixChars,
              );
              expect(withQuestion.startsWith(basePrefix)).toBe(true);
              if (action.isGroupChat) {
                expect(withQuestion).not.toContain("_private_");
                expect(withQuestion).not.toContain("_bot_private_");
              }
            }
          }
        }
      }),
      { numRuns: 40 },
    );
  });

  test("变异体 1 捕杀：去掉 agent_id 校验时兄弟 Bot 越权读取 bot_private，输出精确反例", () => {
    const result = exploreModel(
      createMemoryVisibilityModel(
        { omitAgentIdCheck: true },
        "变异体-漏检agent_id",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "noCrossUserOrBotPrivateLeak",
    );
    expect(result.counterexample?.actions).toEqual([
      "writeNote(A-bot1-bot_private)",
    ]);
  });

  test("变异体 2A 捕杀：删 Bot 时漏清 bot_private 记忆被精确捕获", () => {
    const result = exploreModel(
      createMemoryVisibilityModel(
        { skipPurgeOnDelete: true },
        "变异体-删Bot漏清bot_private",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "deletedBotBotPrivatePurgedAndLaggedWriteBlocked",
    );
    expect(result.counterexample?.actions).toEqual([
      "writeNote(A-deletedBot-bot_private)",
      "deleteBot(deletedBot)",
    ]);
  });

  test("变异体 2B 捕杀：已删除 Bot 滞后写入 bot_private 未被拦截时被精确捕获", () => {
    const result = exploreModel(
      createMemoryVisibilityModel(
        { allowLaggedWriteAfterDelete: true },
        "变异体-滞后写入未拦截",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "deletedBotBotPrivatePurgedAndLaggedWriteBlocked",
    );
    expect(result.counterexample?.actions).toEqual([
      "deleteBot(deletedBot)",
      "writeNote(A-deletedBot-bot_private)",
    ]);
  });

  test("变异体 3 捕杀：群聊漏检 isGroupChat 导致私人记忆渗入群聊时被精确捕获", () => {
    const result = exploreModel(
      createMemoryVisibilityModel(
        { omitGroupChatCheck: true },
        "变异体-群聊未过滤私有记忆",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "noCrossUserOrBotPrivateLeak",
    );
    expect(result.counterexample?.actions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("四级记忆隔离、删 Bot 清理与 4000 字稳定缓存前缀核心行为", () => {
  test("兼容历史 shared 布尔列映射与 public 公开只读权限", async () => {
    expect(resolveMemoryVisibility({ shared: true })).toBe("team");
    expect(
      resolveMemoryVisibility({ visibility: "private", shared: true }),
    ).toBe("team");
    expect(
      resolveMemoryVisibility({ visibility: "public", shared: false }),
    ).toBe("public");
    expect(isSharedVisibility("team")).toBe(true);
    expect(isSharedVisibility("public")).toBe(true);
    expect(isSharedVisibility("private")).toBe(false);
    expect(isSharedVisibility("bot_private")).toBe(false);

    const db = createInMemoryMemoryDb();
    const service = createMemoryNotes(db.database);
    await service.ensure();
    expect(db.isEnsured()).toBe(true);

    // 遗留仅传 shared: true（admin）自动映射为 team
    const legacyTeam = await service.create(
      "ownerA",
      {
        kind: "note",
        subject: "团队规范",
        content: "必须先跑检查",
        shared: true,
      },
      null,
      true,
    );
    expect(legacyTeam.note.visibility).toBe("team");
    expect(legacyTeam.note.shared).toBe(true);

    // public 公开只读：其他用户可读，非管理员（含创建者自身降权或 Bot）不可改删
    const pub = await service.create(
      "ownerA",
      {
        kind: "note",
        subject: "平台公告",
        content: "公共文档只读",
        visibility: "public",
      },
      null,
      true,
    );
    expect(pub.note.visibility).toBe("public");
    expect(pub.note.shared).toBe(true);

    const ownerBRead = await service.search("ownerB", "平台公告", "note", 10, {
      agentId: "bot2",
      isGroupChat: true,
    });
    expect(ownerBRead.map((r) => r.id)).toContain(pub.note.id);

    await expect(
      service.update("ownerA", pub.note.id, { content: "篡改" }, false),
    ).rejects.toThrow("只读");
    expect(await service.remove("ownerA", [pub.note.id], false)).toEqual([]);
    const adminUpdated = await service.update(
      "ownerB",
      pub.note.id,
      { content: "管理员更新后的公告" },
      true,
    );
    expect(adminUpdated.content).toBe("管理员更新后的公告");
  });

  test("bot_private 同主兄弟 Bot / 群聊 / 跨用户 / 已删 Bot 全面隔离且工具链同步拦截", async () => {
    const db = createInMemoryMemoryDb();
    const service = createMemoryNotes(db.database);
    await service.ensure();

    const secret = await service.create(
      "ownerA",
      {
        kind: "note",
        subject: "秘方",
        content: "bot1专属备忘密钥",
        visibility: "bot_private",
      },
      "bot1",
    );
    const sharedPersonal = await service.create(
      "ownerA",
      { kind: "preference", content: "早起喝黑咖啡", visibility: "private" },
      "bot1",
    );

    // bot1 私聊可见两条，bot2 私聊只能看到 private 而绝对看不到 bot1 的 bot_private
    const bot1Tools = service.tools("ownerA", "bot1");
    const bot2Tools = service.tools("ownerA", "bot2");
    const groupTools = service.tools("ownerA", "bot1", { isGroupChat: true });

    const runTool = (
      tools: ReturnType<typeof service.tools>,
      name: string,
      args: unknown,
    ) => {
      const target = tools.find((t) => t.name === name);
      if (!target) throw new Error(`missing tool ${name}`);
      return target.execute(args);
    };

    const bot1Found = await runTool(bot1Tools, "memory_search", { query: "" });
    expect(bot1Found).toContain(secret.note.id);
    expect(bot1Found).toContain(sharedPersonal.note.id);

    const bot2Found = await runTool(bot2Tools, "memory_search", { query: "" });
    expect(bot2Found).not.toContain(secret.note.id);
    expect(bot2Found).not.toContain("bot1专属备忘密钥");
    expect(bot2Found).toContain(sharedPersonal.note.id);

    // 兄弟 Bot 试图通过 update / forget 探测或篡改 bot1 的 bot_private 也被拒绝
    expect(
      await runTool(bot2Tools, "memory_update", {
        id: secret.note.id,
        content: "越权改写",
      }),
    ).toContain("找不到这条记忆");
    expect(
      await runTool(bot2Tools, "memory_forget", { ids: [secret.note.id] }),
    ).toContain("没有删掉任何笔记");

    // 群聊工具绝不可读出或整理 private / bot_private
    expect(await runTool(groupTools, "memory_search", { query: "" })).toBe(
      "没有找到相关笔记。",
    );
    expect(
      await runTool(groupTools, "memory_save", {
        kind: "note",
        content: "群聊误记",
      }),
    ).toContain("群聊");

    // 软删除 bot1 后（agent_profiles.deleted_at 检查点），读与滞后写入全部拦截
    db.markBotDeleted("bot1");
    expect(await service.context("ownerA", "bot1", { question: "秘方" })).toBe(
      "",
    );
    await expect(
      service.create(
        "ownerA",
        { kind: "note", content: "滞后写入", visibility: "bot_private" },
        "bot1",
      ),
    ).rejects.toThrow("已删除的机器人");
    expect(await runTool(bot1Tools, "memory_search", { query: "" })).toContain(
      "已拦截",
    );
  });

  test("purge.removeForGood 检查 chisabot_memory_notes 并同步删除 bot_private 行而保留用户 private", async () => {
    const executedSql: string[] = [];
    const memoryRows = [
      { id: "m1", agent_id: "bot-gone", visibility: "bot_private" },
      { id: "m2", agent_id: "bot-gone", visibility: "private" },
      { id: "m3", agent_id: "bot-keep", visibility: "bot_private" },
    ];

    const extractText = (queryObj: unknown): string => {
      if (typeof queryObj === "string") return queryObj;
      if (
        queryObj &&
        typeof queryObj === "object" &&
        "queryChunks" in queryObj
      ) {
        const chunks = (queryObj as { queryChunks: unknown[] }).queryChunks;
        return chunks
          .map((c) => {
            if (typeof c === "string") return c;
            if (c && typeof c === "object" && "value" in c) {
              const v = (c as { value: unknown }).value;
              return Array.isArray(v) ? v.join("") : String(v ?? "");
            }
            return "";
          })
          .join(" ");
      }
      return String(queryObj ?? "");
    };

    const tx = {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: async () => [],
        }),
      }),
      execute: async (queryObj: unknown) => {
        const text = extractText(queryObj).replace(/\s+/g, " ").toLowerCase();
        executedSql.push(text);
        if (text.includes("to_regclass('public.chisabot_memory_notes')")) {
          return [{ present: true }];
        }
        if (
          text.includes("information_schema.columns") &&
          text.includes("visibility")
        ) {
          return [{ present: true }];
        }
        if (text.includes("to_regclass(")) {
          return [{ present: false }];
        }
        if (text.includes("delete from chisabot_memory_notes")) {
          for (let i = memoryRows.length - 1; i >= 0; i--) {
            const row = memoryRows[i];
            if (
              row?.agent_id === "bot-gone" &&
              row.visibility === "bot_private"
            ) {
              memoryRows.splice(i, 1);
            }
          }
          return [];
        }
        return [];
      },
    };

    const fakeDatabase = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: async () => [{ total: 0 }],
          }),
          where: () => ({
            limit: async () => [
              { deletedAt: new Date("2026-11-16T00:00:00Z") },
            ],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      transaction: async <T>(fn: (trx: typeof tx) => Promise<T>) => fn(tx),
    } as unknown as Database;

    const purge = createAgentPurge({
      database: fakeDatabase,
      reset: { execute: async () => null } as unknown as BotReset,
      profilesDir: "C:/non-existent-chisabot-profiles-dir",
    });

    const report = await purge.purge(
      { id: "ownerA", role: "admin" },
      "bot-gone",
    );
    expect(report.removed).toBe(true);
    expect(
      executedSql.some(
        (s) =>
          s.includes("delete from chisabot_memory_notes") &&
          s.includes("visibility = 'bot_private'"),
      ),
    ).toBe(true);
    expect(memoryRows.map((r) => r.id)).toEqual(["m2", "m3"]);
  });

  test("context 两段输出：<= 4000 字符按 (kind, id) 稳定前缀 + 按需动态召回与中间件群聊集成", async () => {
    const db = createInMemoryMemoryDb();
    const service = createMemoryNotes(db.database, {
      timeZone: "Asia/Shanghai",
    });
    await service.ensure();

    const today = dayIn("Asia/Shanghai");
    // 构造足够多笔记以超出 4000 字预算，检验稳定前缀封顶、字典序确定性与溢出条目的动态召回
    for (let i = 0; i < 45; i++) {
      await service.create(
        "ownerA",
        {
          kind: "note",
          subject: `笔记-${String(i).padStart(2, "0")}`,
          content: `普通备忘第 ${i} 条：${"甲".repeat(80)}`,
          visibility: "private",
        },
        "bot1",
      );
    }
    const special = await service.create(
      "ownerA",
      {
        kind: "project",
        subject: "量子编译器迁移",
        content: "目标架构为 RISC-V64，需保留零拷贝内存池",
        visibility: "private",
      },
      "bot1",
    );
    await service.create(
      "ownerA",
      {
        kind: "daily",
        subject: today,
        content: "- 09:00 晨会确认里程碑",
        visibility: "private",
      },
      "bot1",
    );
    await service.create(
      "ownerA",
      {
        kind: "note",
        subject: "公共安全规范",
        content: "禁止把用户私钥写入日志",
        visibility: "team",
      },
      null,
      true,
    );

    const prefixOnly = await service.context("ownerA", "bot1");
    expect(prefixOnly.length).toBeLessThanOrEqual(MEMORY_LIMITS.prefixChars);
    expect(prefixOnly).not.toContain("## 相关记忆召回");

    const ctxNoHit = await service.context(
      "ownerA",
      "bot1",
      "完全不搭边的话题XYZ123",
    );
    expect(ctxNoHit).toBe(prefixOnly);

    const ctxHit = await service.context(
      "ownerA",
      "bot1",
      "RISC-V64 量子编译器怎么迁移",
    );
    expect(ctxHit.startsWith(prefixOnly)).toBe(true);
    expect(ctxHit).toContain("## 相关记忆召回（按相关性排序）");
    expect(ctxHit).toContain(special.note.id);
    expect(ctxHit).toContain("量子编译器迁移");

    // 校验稳定前缀内 ID 顺序严格遵循 (kind, id) 字典序
    const rows = db.notes.map((r) => ({ ...r }));
    const assembled = assembleMemoryContext(
      rows,
      { userId: "ownerA", agentId: "bot1", isGroupChat: false },
      { today, yesterday: today, timeZone: "Asia/Shanghai" },
    );
    expect(assembled.length).toBeLessThanOrEqual(4000);
    const idPairs = [...assembled.matchAll(/- \[(mem_[a-f0-9]+)\]/g)]
      .map((m) => rows.find((r) => r.id === m[1]))
      .filter((r): r is NonNullable<typeof r> => Boolean(r));
    for (let i = 1; i < idPairs.length; i++) {
      const prev = idPairs[i - 1];
      const curr = idPairs[i];
      if (prev && curr) {
        expect(compareMemoryKindId(prev, curr)).toBeLessThan(0);
      }
    }

    // PersonalMemoryMiddleware + createPersonalMemoryLoader 群聊隔离端到端验证
    class CaptureAgent extends AbstractAgent {
      readonly captured: RunAgentInput[] = [];
      run(input: RunAgentInput) {
        this.captured.push(input);
        return of<BaseEvent>({
          type: EventType.RUN_STARTED,
          runId: input.runId,
          threadId: input.threadId,
        });
      }
    }
    const capture = new CaptureAgent({ agentId: "bot1" });
    const middleware = new PersonalMemoryMiddleware(
      "bot1",
      createPersonalMemoryLoader(service, "ownerA"),
    );
    await lastValueFrom(
      middleware
        .run(
          {
            runId: "r1",
            threadId: "t1",
            messages: [
              { id: "u1", role: "user", content: "量子编译器和公共安全规范" },
            ],
            context: [],
            tools: [],
            state: {},
            forwardedProps: { isGroupChat: true },
          },
          capture,
        )
        .pipe(toArray()),
    );
    const injected = String(capture.captured[0]?.messages[0]?.content ?? "");
    expect(injected).toContain("公共安全规范");
    expect(injected).not.toContain("量子编译器迁移");
    expect(injected).not.toContain("普通备忘第 0 条");
  });

  test("tidy 整理与撤销遵守四级隔离：不跨 Bot 合并 bot_private，且不复活已删 Bot 的记忆", async () => {
    const db = createInMemoryMemoryDb();
    const service = createMemoryNotes(db.database);
    await service.ensure();

    db.notes.push(
      {
        id: "mem_000000000001",
        owner_user_id: "ownerA",
        kind: "person",
        subject: "小林",
        content: "bot1专属一条",
        context: null,
        agent_id: "bot1",
        visibility: "bot_private",
        shared: false,
        created_at: "2026-11-16T00:00:01.000Z",
        updated_at: "2026-11-16T00:00:02.000Z",
      },
      {
        id: "mem_000000000002",
        owner_user_id: "ownerA",
        kind: "person",
        subject: "小林",
        content: "bot1专属二条",
        context: null,
        agent_id: "bot1",
        visibility: "bot_private",
        shared: false,
        created_at: "2026-11-16T00:00:01.000Z",
        updated_at: "2026-11-16T00:00:01.000Z",
      },
      {
        id: "mem_000000000003",
        owner_user_id: "ownerA",
        kind: "person",
        subject: "小林",
        content: "bot2专属一条",
        context: null,
        agent_id: "bot2",
        visibility: "bot_private",
        shared: false,
        created_at: "2026-11-16T00:00:01.000Z",
        updated_at: "2026-11-16T00:00:03.000Z",
      },
      {
        id: "mem_000000000004",
        owner_user_id: "ownerA",
        kind: "person",
        subject: "小林",
        content: "bot2专属二条",
        context: null,
        agent_id: "bot2",
        visibility: "bot_private",
        shared: false,
        created_at: "2026-11-16T00:00:01.000Z",
        updated_at: "2026-11-16T00:00:02.000Z",
      },
    );

    // bot2 预览整理时只能看到自己的 bot_private 组，绝看不到 bot1 的 bot_private
    const bot2Preview = await service.previewDream("ownerA", {
      agentId: "bot2",
      isGroupChat: false,
    });
    expect(bot2Preview.groups).toHaveLength(1);
    expect(bot2Preview.groups[0]?.agentId).toBe("bot2");

    // 群聊下整理建议必须为空
    const groupPreview = await service.previewDream("ownerA", {
      agentId: "bot1",
      isGroupChat: true,
    });
    expect(groupPreview.groups).toHaveLength(0);

    // bot1 整理自己的 bot_private 后删除 bot1，撤销整理不能复活已删 bot1 的 bot_private
    const bot1Dream = await service.dream("ownerA", undefined, {
      agentId: "bot1",
      isGroupChat: false,
    });
    expect(bot1Dream.mergedCount).toBe(1);
    const batchId = bot1Dream.batchId;
    expect(batchId).not.toBeNull();
    db.markBotDeleted("bot1");
    if (batchId) {
      const undoRes = await service.undoDream("ownerA", batchId);
      expect(undoRes.restored).toBe(0);
      expect(undoRes.skipped).toBeGreaterThanOrEqual(1);
    }
    expect(
      db.notes.some(
        (n) => n.agent_id === "bot1" && n.visibility === "bot_private",
      ),
    ).toBe(false);
  });
});

// 回归护栏：服务端接线必须经 createPersonalMemoryLoader 注入个人记忆，
// 任何直调 memoryNotes.context 的装配都会丢掉群聊/线程可见性参数（曾致私密记忆进群聊）。
test("index.ts 的个人记忆装配不绕过 createPersonalMemoryLoader", () => {
  const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
  expect(source).not.toContain("memoryNotes.context(");
  expect(source).toContain("createPersonalMemoryLoader");
});

// 群聊回合的 RunAgentInput 必须带 isGroupChat 标记，否则中间件按私聊注入私密记忆。
test("群聊回合必须给 RunAgentInput 打 isGroupChat 标记", () => {
  const source = readFileSync(
    join(import.meta.dir, "../src/channels/group.ts"),
    "utf8",
  );
  expect(source).toContain("forwardedProps: { isGroupChat: true }");
});
