import { expect, test } from "bun:test";
import {
  filterCcTree,
  parsePinnedSessions,
  recentCcWorkspace,
  sortPinnedSessions,
  togglePinnedSession,
} from "@/components/cloud-cc/cc-tree";
import type {
  CcSessionView,
  CcWorkspaceView,
} from "../../shared/cloud-cc";

function session(
  id: string,
  title: string,
  lastTurnAt: string | null = null,
): CcSessionView {
  return {
    id,
    workspaceId: "w1",
    title,
    status: "idle",
    branch: null,
    model: null,
    effort: null,
    turns: 0,
    resumable: false,
    lastTurnAt,
    createdAt: lastTurnAt ?? "2026-10-01T00:00:00.000Z",
    lastError: null,
    prUrl: null,
    prNumber: null,
    mergedAt: null,
  };
}

function workspace(
  id: string,
  name: string,
  sessions: CcSessionView[],
  extra: Partial<CcWorkspaceView> = {},
): CcWorkspaceView {
  return {
    id,
    name,
    source: "scratch",
    sourceLabel: "草稿",
    repoFullName: null,
    isGit: false,
    syncState: "cloud_only",
    cloneState: "ready",
    cloneError: null,
    defaultBranch: null,
    sessions,
    ...extra,
  };
}

const alpha = workspace("w1", "dsh-pad", [
  session("s1", "你好", "2026-10-20T10:00:00.000Z"),
  session("s2", "修登录页", "2026-10-19T10:00:00.000Z"),
]);
const beta = workspace("w2", "chisabot", [
  session("s3", "写测试", "2026-10-21T10:00:00.000Z"),
]);

test("no query keeps every workspace and every session", () => {
  const groups = filterCcTree([alpha, beta], "  ");
  expect(groups.map((g) => g.ws.id)).toEqual(["w1", "w2"]);
  expect(groups[0].sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
});

test("a workspace-name hit keeps all of that workspace's sessions", () => {
  const groups = filterCcTree([alpha, beta], "dsh");
  expect(groups).toHaveLength(1);
  expect(groups[0].ws.id).toBe("w1");
  expect(groups[0].sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
});

test("a session-title hit drops the other workspaces and the other sessions", () => {
  const groups = filterCcTree([alpha, beta], "测试");
  expect(groups).toHaveLength(1);
  expect(groups[0].ws.id).toBe("w2");
  expect(groups[0].sessions.map((s) => s.id)).toEqual(["s3"]);
});

test("search is case-insensitive and also matches the repo name", () => {
  const github = workspace("w3", "site", [], {
    source: "github",
    sourceLabel: "GitHub",
    repoFullName: "ChisaAlter/Site",
  });
  expect(filterCcTree([github], "chisaalter")[0]?.ws.id).toBe("w3");
});

test("no hit returns an empty list", () => {
  expect(filterCcTree([alpha, beta], "不存在的会话")).toEqual([]);
});

test("recent workspace is the one whose newest session moved last", () => {
  expect(recentCcWorkspace([alpha, beta])?.id).toBe("w2");
});

test("recent workspace skips workspaces that are still cloning", () => {
  const cloning = workspace("w3", "clone", [session("s4", "新")], {
    cloneState: "cloning",
  });
  expect(recentCcWorkspace([cloning, alpha])?.id).toBe("w1");
});

test("recent workspace falls back to the first ready workspace with no sessions", () => {
  const empty = workspace("w4", "empty", []);
  const later = workspace("w5", "later", []);
  expect(recentCcWorkspace([empty, later])?.id).toBe("w4");
});

test("pinned sessions parse defensively from localStorage", () => {
  expect([...parsePinnedSessions(null)]).toEqual([]);
  expect([...parsePinnedSessions("not json")]).toEqual([]);
  expect([...parsePinnedSessions('["s1", 3, "s2"]')]).toEqual(["s1", "s2"]);
});

test("pinning toggles an id without mutating the previous set", () => {
  const before = new Set(["s1"]);
  const added = togglePinnedSession(before, "s2");
  const removed = togglePinnedSession(added, "s1");
  expect([...before]).toEqual(["s1"]);
  expect([...added]).toEqual(["s1", "s2"]);
  expect([...removed]).toEqual(["s2"]);
});

test("sorting pinned sessions only moves pinned rows, keeping the rest in order", () => {
  const sessions = [
    session("s1", "一"),
    session("s2", "二"),
    session("s3", "三"),
  ];
  expect(
    sortPinnedSessions(sessions, new Set(["s3", "s1"])).map((s) => s.id),
  ).toEqual(["s1", "s3", "s2"]);
  expect(sortPinnedSessions(sessions, new Set()).map((s) => s.id)).toEqual([
    "s1",
    "s2",
    "s3",
  ]);
});
