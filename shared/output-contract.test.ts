import { describe, expect, test } from "bun:test";
import { OUTPUT_FORMS, WORK_STEP_TOOLS } from "./output-contract";

// 契约本身的完整性：每条形态都要对三个界面表态，id 不重、写法不空。
// 新增输出形态时这一份清单强迫你为 web/app/im 各做一个明确决定（native/degraded/none），
// 两端的解析测试再按 id 逐条对照实现。
describe("output contract", () => {
  test("ids are unique and every surface has a disposition", () => {
    const ids = new Set<string>();
    for (const f of OUTPUT_FORMS) {
      expect(f.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
      expect(f.syntax.length).toBeGreaterThan(0);
      for (const s of [f.web, f.app, f.im])
        expect(["native", "degraded", "none"]).toContain(s);
      if (f.app === "degraded" || f.web === "degraded" || f.im === "degraded")
        expect(f.note, `${f.id} degraded without note`).toBeTruthy();
    }
  });

  test("interactive waits are web-only", () => {
    // 「等人填/批」的形态在 app/im 上必须是 none——由服务端闸门挡住而不是发卡等人。
    for (const id of ["github-action", "vault-request"]) {
      const f = OUTPUT_FORMS.find((x) => x.id === id)!;
      expect(f.app).toBe("none");
      expect(f.im).toBe("none");
    }
  });

  test("work-step tool vocabulary is covered in both web and Android", async () => {
    const { describeWorkerStep } = await import("./work-step");
    const kt = await Bun.file(
      new URL(
        "../android/app/src/main/java/cn/ayase/chisabot/chat/WorkSteps.kt",
        import.meta.url,
      ),
    ).text();
    expect(WORK_STEP_TOOLS.length).toBeGreaterThan(20);
    expect(new Set(WORK_STEP_TOOLS).size).toBe(WORK_STEP_TOOLS.length);
    for (const tool of WORK_STEP_TOOLS) {
      const label = describeWorkerStep(tool, {});
      expect(label, `${tool} missing in shared/work-step.ts`).toBeTruthy();
      expect(
        label!.startsWith("正在使用 "),
        `${tool} fell back to generic label`,
      ).toBe(false);
      const inKt =
        kt.includes(`"${tool}"`) ||
        (tool === "memory" && kt.includes('startsWith("memory")'));
      expect(inKt, `${tool} missing in WorkSteps.kt`).toBe(true);
    }
  });
});
