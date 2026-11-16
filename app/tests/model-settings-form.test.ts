import { expect, test } from "bun:test";
import {
  describePooledKeyHealth,
  modelSettingsInput,
  modelSettingsValidation,
  pooledKeyDraftsFromCurrent,
} from "@/lib/model-settings/form";

const current = {
  provider: "openai" as const,
  model: "current-model",
  baseUrl: "https://models.example.test/v1",
  useApiKey: true,
  hasApiKey: true,
  source: "environment" as const,
};

test.each(["openai", "anthropic"] as const)(
  "the official Step Plan %s base shares the canonical address without re-entering its key",
  (provider) => {
    const saved = {
      ...current,
      provider,
      model: "step-5-preview",
      baseUrl: "https://api.stepfun.com/step_plan",
    };
    const draft = {
      ...saved,
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      apiKey: "",
    };
    expect(modelSettingsValidation(draft, saved)).toEqual({});
    expect(
      modelSettingsValidation(
        { ...draft, baseUrl: saved.baseUrl },
        { ...saved, baseUrl: draft.baseUrl },
      ),
    ).toEqual({});
    expect(
      modelSettingsInput({ ...draft, baseUrl: `${saved.baseUrl}/` }).baseUrl,
    ).toBe(draft.baseUrl);
    expect(
      modelSettingsValidation(
        { ...draft, baseUrl: "https://api.stepfun.ai/step_plan" },
        saved,
      ).apiKey,
    ).toBeTruthy();
    expect(
      modelSettingsValidation(
        { ...draft, baseUrl: "https://api.stepfun.com/custom" },
        saved,
      ).apiKey,
    ).toBeTruthy();
  },
);

test("leaving the key blank preserves it without sending an empty secret", () => {
  expect(
    modelSettingsInput({ ...current, model: "next-model", apiKey: "  " }),
  ).toEqual({
    provider: "openai",
    model: "next-model",
    baseUrl: "https://models.example.test/v1",
    useApiKey: true,
  });
});

test("a changed destination requires its own key instead of forwarding the current one", () => {
  const errors = modelSettingsValidation(
    { ...current, baseUrl: "https://other.example.test/v1", apiKey: "" },
    current,
  );
  expect(errors.apiKey).toBeTruthy();
  expect(
    modelSettingsValidation(
      { ...current, provider: "anthropic", apiKey: "" },
      current,
    ).apiKey,
  ).toBeTruthy();
});

test("an explicitly unauthenticated local endpoint needs no key", () => {
  expect(
    modelSettingsValidation(
      {
        ...current,
        baseUrl: "http://localhost:11434/v1",
        useApiKey: false,
        apiKey: "",
      },
      current,
    ),
  ).toEqual({});
});

test("disabling authentication omits a previously typed key", () => {
  expect(
    modelSettingsInput({ ...current, useApiKey: false, apiKey: "unused-key" })
      .apiKey,
  ).toBeUndefined();
});

test("a missing deployment key requires a new key before submitting", () => {
  expect(
    modelSettingsValidation(
      { ...current, apiKey: "" },
      { ...current, hasApiKey: false },
    ).apiKey,
  ).toBeTruthy();
});

test("the same normalized endpoint keeps its existing key", () => {
  expect(
    modelSettingsValidation(
      { ...current, baseUrl: "https://models.example.test/", apiKey: "" },
      current,
    ),
  ).toEqual({});
});

test.each([
  ["", "model"],
  ["file:///etc/config", "baseUrl"],
  ["https://user:secret@models.example.test/v1", "baseUrl"],
  ["https://models.example.test/v1?key=secret", "baseUrl"],
  ["https://models.example.test/v1#secret", "baseUrl"],
])("rejects incomplete or unsafe fields: %s", (value, field) => {
  expect(
    modelSettingsValidation(
      { ...current, [field]: value, apiKey: "" },
      current,
    )[field as "model" | "baseUrl"],
  ).toBeTruthy();
});

test("pooledKeys serializes additions, rotations without blank overwrite, and removals cleanly", () => {
  expect(
    modelSettingsInput({
      ...current,
      apiKey: "",
      pooledKeys: [],
    }).pooledKeys,
  ).toBeUndefined();

  expect(
    modelSettingsInput({
      ...current,
      useApiKey: false,
      apiKey: "",
      pooledKeys: [
        { kind: "new", clientKey: "new-1", label: "备选", apiKey: "sk-1" },
      ],
    }).pooledKeys,
  ).toBeUndefined();

  expect(
    modelSettingsInput({
      ...current,
      apiKey: "",
      pooledKeys: [
        {
          kind: "existing",
          id: "k1",
          label: " 主备 1 ",
          hasApiKey: true,
          newApiKey: "   ",
          removed: false,
        },
        {
          kind: "existing",
          id: "k2",
          label: "备选 2",
          hasApiKey: true,
          newApiKey: " sk-rotated ",
          removed: false,
        },
        {
          kind: "existing",
          id: "k3",
          label: "旧 Key",
          hasApiKey: true,
          newApiKey: "",
          removed: true,
        },
        {
          kind: "new",
          clientKey: "new-1",
          label: " 新增备选 ",
          apiKey: " sk-new ",
        },
      ],
    }).pooledKeys,
  ).toEqual([
    { id: "k1", label: "主备 1" },
    { id: "k2", label: "备选 2", apiKey: "sk-rotated" },
    { id: "k3", label: "旧 Key", remove: true },
    { label: "新增备选", apiKey: "sk-new" },
  ]);
});

test("pooledKeys validation rejects empty alias or missing key while skipping removed rows", () => {
  const drafts = pooledKeyDraftsFromCurrent([
    {
      id: "k1",
      label: "已存在未填密钥",
      hasApiKey: false,
      healthy: true,
      cooldownUntil: null,
    },
    {
      id: "k2",
      label: "",
      hasApiKey: true,
      healthy: true,
      cooldownUntil: null,
    },
  ]);
  const errors = modelSettingsValidation(
    {
      ...current,
      apiKey: "",
      pooledKeys: [
        drafts[0] as (typeof drafts)[number],
        {
          ...(drafts[1] as (typeof drafts)[number]),
          kind: "existing",
          removed: true,
          id: "k2",
          label: "",
          hasApiKey: true,
          newApiKey: "",
        },
        { kind: "new", clientKey: "new-1", label: "  ", apiKey: " " },
      ],
    },
    current,
  );
  expect(errors.pooledKeys).toEqual({
    k1: { apiKey: "请填写此备选 Key 的 API Key，或将其移除。" },
    "new-1": {
      label: "请填写备选 Key 的别名。",
      apiKey: "请填写新增备选 Key 的 API Key。",
    },
  });
});

test("describePooledKeyHealth formats healthy, active cooldown, expired cooldown, and error states", () => {
  const now = 1_700_000_000_000;
  expect(
    describePooledKeyHealth(
      {
        id: "k1",
        label: "A",
        hasApiKey: true,
        healthy: true,
        cooldownUntil: null,
      },
      now,
    ).label,
  ).toBe("健康");
  expect(
    describePooledKeyHealth(
      {
        id: "k2",
        label: "B",
        hasApiKey: true,
        healthy: false,
        cooldownUntil: now + 12_300,
        lastStatus: 429,
      },
      now,
    ).label,
  ).toBe("冷却中，剩余 13 秒");
  expect(
    describePooledKeyHealth(
      {
        id: "k2",
        label: "B",
        hasApiKey: true,
        healthy: false,
        cooldownUntil: now - 500,
      },
      now,
    ).label,
  ).toBe("冷却已结束（待恢复）");
  expect(
    describePooledKeyHealth(
      {
        id: "k3",
        label: "C",
        hasApiKey: true,
        healthy: false,
        cooldownUntil: null,
        lastStatus: 401,
      },
      now,
    ).label,
  ).toBe("异常（HTTP 401）");
});
