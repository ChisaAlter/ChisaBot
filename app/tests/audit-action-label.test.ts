import { describe, expect, test } from "bun:test";
import {
  auditFailureLabel,
  computerActionLabel,
} from "../src/lib/audit/action-label";

describe("computerActionLabel", () => {
  test("maps computer_ verbs and stripped names to Chinese", () => {
    expect(computerActionLabel("computer_navigate")).toBe("打开网页");
    expect(computerActionLabel("navigate")).toBe("打开网页");
    expect(computerActionLabel("computer_type")).toBe("填写");
    expect(computerActionLabel("download_file")).toBe("下载文件");
    expect(computerActionLabel("computer_run_command")).toBe("运行命令");
    expect(computerActionLabel("write_file")).toBe("写入文件");
  });

  test("falls back to stripped English for unknown tools", () => {
    expect(computerActionLabel("computer_frobnicate")).toBe("frobnicate");
    expect(computerActionLabel("mystery")).toBe("mystery");
  });
});

describe("auditFailureLabel", () => {
  test("translates the human-control block reason", () => {
    expect(
      auditFailureLabel(
        "A person has control or has been asked to take control. Wait for them to hand it back before acting.",
      ),
    ).toBe("有人正在用电脑，或已被请去接管。等交还后再操作。");
    expect(auditFailureLabel("A person has control")).toBe(
      "有人正在用电脑，等交还后再操作。",
    );
  });

  test("leaves unknown English alone", () => {
    expect(auditFailureLabel("ECONNREFUSED 127.0.0.1:9222")).toBe(
      "ECONNREFUSED 127.0.0.1:9222",
    );
  });
});
