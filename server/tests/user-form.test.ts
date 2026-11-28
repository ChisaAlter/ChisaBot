import { describe, expect, test } from "bun:test";
import {
  renderFormAnswersText,
  type UserFormField,
  validateFieldAnswer,
  validateUserFormFields,
} from "../../shared/user-form";

const textField: UserFormField = {
  type: "text",
  id: "name",
  label: "你的名字",
};

describe("CB-147 表单字段定义校验", () => {
  test("合法五类型通过", () => {
    const verdict = validateUserFormFields([
      textField,
      { type: "textarea", id: "detail", label: "详细说明" },
      { type: "select", id: "env", label: "环境", options: ["dev", "prod"] },
      { type: "multiselect", id: "tags", label: "标签", options: ["a", "b"] },
      { type: "confirm", id: "ok", label: "确认执行" },
    ]);
    expect(verdict.ok).toBe(true);
  });

  test("凭据味字段一律拒收", () => {
    for (const id of ["password", "api_token", "secret_key", "apiKey"]) {
      const verdict = validateUserFormFields([{ type: "text", id, label: "x" }]);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.error).toContain("保管库");
    }
    const byLabel = validateUserFormFields([
      { type: "text", id: "input1", label: "your password" },
    ]);
    expect(byLabel.ok).toBe(false);
  });

  test("重复 id 拒收；非法结构拒收", () => {
    expect(
      validateUserFormFields([textField, { ...textField }]).ok,
    ).toBe(false);
    expect(validateUserFormFields([{ type: "password", id: "x", label: "x" }]).ok).toBe(false);
    expect(validateUserFormFields([]).ok).toBe(false);
    expect(validateUserFormFields("nope").ok).toBe(false);
  });
});

describe("CB-147 字段答案校验", () => {
  test("text：必填缺失报错、默认值兜底、长度上限", () => {
    const required = validateFieldAnswer(textField, "");
    expect(required.ok).toBe(false);
    const withDefault = validateFieldAnswer(
      { ...textField, defaultValue: "默认" },
      "",
    );
    expect(withDefault.ok).toBe(true);
    if (withDefault.ok) expect(withDefault.value).toBe("默认");
    const optional = validateFieldAnswer({ ...textField, required: false }, "");
    expect(optional.ok).toBe(true);
    const tooLong = validateFieldAnswer(textField, "x".repeat(2001));
    expect(tooLong.ok).toBe(false);
  });

  test("select：非法选项拒收、合法通过", () => {
    const field: UserFormField = {
      type: "select",
      id: "env",
      label: "环境",
      options: ["dev", "prod"],
    };
    expect(validateFieldAnswer(field, "staging").ok).toBe(false);
    const ok = validateFieldAnswer(field, "prod");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toBe("prod");
  });

  test("multiselect：数组归一去重、非法项拒收", () => {
    const field: UserFormField = {
      type: "multiselect",
      id: "tags",
      label: "标签",
      options: ["a", "b", "c"],
    };
    const ok = validateFieldAnswer(field, ["a", "a", "c"]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toEqual(["a", "c"]);
    expect(validateFieldAnswer(field, ["zzz"]).ok).toBe(false);
    expect(validateFieldAnswer(field, []).ok).toBe(false); // required 默认 true
  });

  test("confirm：boolean 直收、缺失走默认、必填无默认报错", () => {
    const field: UserFormField = { type: "confirm", id: "ok", label: "确认" };
    const yes = validateFieldAnswer(field, true);
    expect(yes.ok).toBe(true);
    if (yes.ok) expect(yes.value).toBe(true);
    expect(validateFieldAnswer(field, undefined).ok).toBe(false);
    const withDefault = validateFieldAnswer(
      { ...field, defaultValue: false },
      undefined,
    );
    expect(withDefault.ok).toBe(true);
  });
});

describe("CB-147 答案渲染", () => {
  test("结构化答案渲染为人读文本", () => {
    const fields: UserFormField[] = [
      textField,
      { type: "multiselect", id: "tags", label: "标签", options: ["a", "b"] },
      { type: "confirm", id: "ok", label: "确认执行" },
    ];
    const text = renderFormAnswersText(fields, {
      name: "小明",
      tags: ["a", "b"],
      ok: true,
    });
    expect(text).toContain("你的名字：小明");
    expect(text).toContain("标签：a、b");
    expect(text).toContain("确认执行：是");
  });
});
