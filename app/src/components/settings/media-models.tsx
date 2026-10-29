import { IconEye, IconPhoto } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { IMAGE_PROVIDER_PRESETS, type ImageProviderKind, type ImageSettingsView } from "../../../../shared/chat-files";
import { type MediaDefaultsSummary, type PersonalImageView, type PersonalVisionView, VISION_PRESET, type VisionSettingsView } from "../../../../shared/media-models";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { SettingRow } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import {
  mediaKeys,
  saveImageDefault,
  savePersonalImage,
  savePersonalVision,
  saveVisionDefault,
  testImageModel,
  testVisionModel,
} from "@/lib/media-models";
import { cn } from "@/lib/utils";

/**
 * 生图模型 / 识图模型的设置卡（DESIGN.md §59）。
 * - scope = default：管理员给所有人设的默认（设置 → 模型）。
 * - scope = personal：自己的（设置 → 生图与识图），不设就用默认。
 * 密钥只进不出：输入框永远是空的，下面一行说「已保存（末四位 1234），留空不改」。
 */

type Probe = { ok: boolean; message: string } | null;
type AsyncHandle = Pick<ReturnType<typeof useAsyncAction<[], void>>, "state" | "run">;
const validUrl = (v: string) => /^https?:\/\/\S+$/.test(v.trim());

function Segmented<T extends string>({ value, onChange, options, label, testId }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string; testId?: string }) {
  // 分段选择的键盘约定集中在这一个钩子里（2026-10-20）：roving tabindex + 方向键换项、焦点跟随。
  const keys = useSegmentedKeys<T>({ value, values: options.map((option) => option.value), onChange });
  return (
    <div aria-label={label} className="sg-segmented media-seg" data-testid={testId} {...keys.groupProps} ref={keys.groupRef} role="radiogroup">
      {options.map((option) => (
        // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
        <button aria-checked={value === option.value} className="sg-segmented-item" key={option.value} onClick={() => onChange(option.value)} role="radio" tabIndex={keys.itemTabIndex(option.value)} type="button">
          <T>{option.label}</T>
        </button>
      ))}
    </div>
  );
}

function keyNote(typed: string, keySource: "saved" | "environment" | "none", keyHint: string, missing: string) {
  if (typed.trim()) return "保存后替换已存的密钥。";
  if (keySource === "saved") return `已保存${keyHint ? `（末四位 ${keyHint}）` : ""}，留空不改。`;
  if (keySource === "environment") return `沿用部署环境变量里的密钥${keyHint ? `（末四位 ${keyHint}）` : ""}。`;
  return missing;
}

function KeyField({ id, value, onChange, note, empty }: { id: string; value: string; onChange: (v: string) => void; note: string; empty: boolean }) {
  return (
    <label className="im-field" htmlFor={id}>
      <span className="im-field-l">{"API 密钥"}</span>
      <Input autoComplete="new-password" className="font-mono" data-1p-ignore data-testid={id} id={id} onChange={(e) => onChange(e.target.value)} placeholder={empty ? "粘贴密钥" : "留空不改"} type="password" value={value} />
      <span className="im-field-h">{note}</span>
    </label>
  );
}

function ProbeLine({ probe, testId }: { probe: Probe; testId: string }) {
  if (!probe) return null;
  return (
    <p className={probe.ok ? "img-probe is-ok" : "img-probe is-bad"} data-testid={testId} role="status">
      {probe.message}
    </p>
  );
}

// ------------------------------------------------------------------ 生图

type ImageForm = { provider: ImageProviderKind; baseUrl: string; model: string; editModel: string; apiKey: string };

function ImageFields({ form, setForm, idPrefix, keyText, keyEmpty }: { form: ImageForm; setForm: (f: ImageForm) => void; idPrefix: string; keyText: string; keyEmpty: boolean }) {
  const preset = IMAGE_PROVIDER_PRESETS[form.provider];
  function pickProvider(provider: ImageProviderKind) {
    const next = IMAGE_PROVIDER_PRESETS[provider];
    // 换了接口类型：地址和模型换成这一类的默认值（同类里改过的值保留）。
    setForm(form.provider === provider ? form : { ...form, provider, baseUrl: next.baseUrl, model: next.model, editModel: "" });
  }
  return (
    <div className="im-form">
      <label className="im-field" htmlFor={`${idPrefix}-provider`}>
        <span className="im-field-l">{"接口类型"}</span>
        <Select onValueChange={(value) => pickProvider(value as ImageProviderKind)} value={form.provider}>
          <SelectTrigger className="w-full" id={`${idPrefix}-provider`}>
            <SelectValue>{preset.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(IMAGE_PROVIDER_PRESETS) as ImageProviderKind[]).map((kind) => (
              <SelectItem key={kind} value={kind}>
                {IMAGE_PROVIDER_PRESETS[kind].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="im-field-h">{preset.editNote}</span>
      </label>
      <label className="im-field" htmlFor={`${idPrefix}-base`}>
        <span className="im-field-l">{"接口地址"}</span>
        <Input className="font-mono" data-testid={`${idPrefix}-base`} id={`${idPrefix}-base`} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={preset.baseUrl} value={form.baseUrl} />
      </label>
      <div className="im-grid">
        <label className="im-field" htmlFor={`${idPrefix}-model`}>
          <span className="im-field-l">{"生成模型"}</span>
          <Input className="font-mono" data-testid={`${idPrefix}-model`} id={`${idPrefix}-model`} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={preset.model} value={form.model} />
        </label>
        <label className="im-field" htmlFor={`${idPrefix}-edit`}>
          <span className="im-field-l">
            {"修改模型"}
            <span className="im-req">{"留空 = 同生成模型"}</span>
          </span>
          <Input className="font-mono" id={`${idPrefix}-edit`} onChange={(e) => setForm({ ...form, editModel: e.target.value })} placeholder={form.model || preset.model} value={form.editModel} />
        </label>
      </div>
      <KeyField empty={keyEmpty} id={`${idPrefix}-key`} note={keyText} onChange={(apiKey) => setForm({ ...form, apiKey })} value={form.apiKey} />
    </div>
  );
}

/** 管理员：所有人的生图默认（就是 §56 原来的 设置 → 图片生成）。 */
export function ImageDefaultCard({ current }: { current: ImageSettingsView }) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(current.enabled);
  const [form, setForm] = useState<ImageForm>({ provider: current.provider, baseUrl: current.baseUrl, model: current.model, editModel: current.editModel, apiKey: "" });
  const [probe, setProbe] = useState<Probe>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
  useEffect(() => setProbe(null), [form.provider, form.baseUrl, form.model, form.apiKey]);
  const valid = validUrl(form.baseUrl) && form.model.trim() !== "";
  const save = useAsyncAction(
    async () => {
      await saveImageDefault({ enabled, provider: form.provider, baseUrl: form.baseUrl.trim(), model: form.model.trim(), editModel: form.editModel.trim(), ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) });
      setForm((f) => ({ ...f, apiKey: "" }));
      await queryClient.invalidateQueries({ queryKey: mediaKeys.all });
    },
    { errorToast: (error) => error.message },
  );
  const test = useAsyncAction(
    async () => {
      const result = await testImageModel({ scope: "default", provider: form.provider, baseUrl: form.baseUrl.trim(), model: form.model.trim(), ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) });
      setProbe(result);
      if (!result.ok) throw new Error(result.message);
    },
    { errorToast: false },
  );
  const note = keyNote(form.apiKey, current.keySource, current.keyHint, form.provider === "minimax" ? "没有密钥：填一个，或在部署环境变量里配置 MINIMAX_API_KEY。" : "没有密钥：填一个，或在部署环境变量里配置 IMAGE_API_KEY。");
  return (
    <form
      autoComplete="off"
      className="media-card-stack"
      data-testid="image-default"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && save.state !== "pending") void save.run();
      }}
    >
      <div className="media-switch">
        <SettingRow
          description={current.ready ? "已打开：机器人可以画图、改图（个人设置了自己的生图模型的人用他自己的）。" : enabled ? "保存后打开。" : "关闭时，没设自己生图模型的人用不了画图。"}
          title={
            <span className="inline-flex items-center gap-2">
              <IconPhoto className="size-4" />
              {"允许机器人生成图片"}
            </span>
          }
        >
          <Switch aria-label="允许机器人生成图片" checked={enabled} data-testid="image-enabled" onCheckedChange={setEnabled} />
        </SettingRow>
      </div>
      <div className="media-body">
        <ImageFields form={form} idPrefix="img" keyEmpty={current.keySource === "none"} keyText={note} setForm={setForm} />
        <ProbeLine probe={probe} testId="image-probe" />
        <div className="media-actions">
          <Button disabled={!valid} feedback="test" onClick={() => void test.run()} state={test.state} type="button" variant="outline">
            {"检查（不生成图片）"}
          </Button>
          <Button data-testid="image-save" disabled={!valid} feedback="save" state={save.state} type="submit">
            {"保存"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** 个人：用默认，或者自己的生图接口。 */
export function ImagePersonalCard({ current, defaults }: { current: PersonalImageView; defaults: MediaDefaultsSummary }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState(current.mode);
  const preset = IMAGE_PROVIDER_PRESETS[current.provider];
  const [form, setForm] = useState<ImageForm>({
    provider: current.provider,
    baseUrl: current.baseUrl || preset.baseUrl,
    model: current.model || preset.model,
    editModel: current.editModel,
    apiKey: "",
  });
  const [probe, setProbe] = useState<Probe>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
  useEffect(() => setProbe(null), [form.provider, form.baseUrl, form.model, form.apiKey]);
  const hasKey = form.apiKey.trim() !== "" || current.keySource === "saved";
  const valid = mode === "default" || (validUrl(form.baseUrl) && form.model.trim() !== "" && hasKey);
  const save = useAsyncAction(
    async () => {
      await savePersonalImage(
        mode === "default"
          ? { mode }
          : { mode, provider: form.provider, baseUrl: form.baseUrl.trim(), model: form.model.trim(), editModel: form.editModel.trim(), ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) },
      );
      setForm((f) => ({ ...f, apiKey: "" }));
      await queryClient.invalidateQueries({ queryKey: mediaKeys.all });
    },
    { errorToast: (error) => error.message },
  );
  const test = useAsyncAction(
    async () => {
      const result = await testImageModel({ scope: "personal", provider: form.provider, baseUrl: form.baseUrl.trim(), model: form.model.trim(), ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) });
      setProbe(result);
      if (!result.ok) throw new Error(result.message);
    },
    { errorToast: false },
  );
  const defaultText = defaults.image.ready ? `默认：${IMAGE_PROVIDER_PRESETS[defaults.image.provider].label.replace(/（.*）/, "")} · ${defaults.image.model}` : "管理员还没打开默认的生图模型：用默认时机器人不能画图。";
  return (
    <form
      autoComplete="off"
      className="media-card-stack"
      data-testid="image-personal"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && save.state !== "pending") void save.run();
      }}
    >
      <div className="media-body">
        <div className="media-head">
          <Segmented
            label="生图模型来源"
            onChange={setMode}
            options={[
              { value: "default", label: "用默认" },
              { value: "custom", label: "我自己的" },
            ]}
            testId="my-image-mode"
            value={mode}
          />
          <span className="im-field-h media-head-note">{mode === "default" ? defaultText : "只有你的机器人用它，费用记在你的密钥上。"}</span>
        </div>
        {mode === "custom" ? <ImageFields form={form} idPrefix="my-img" keyEmpty={current.keySource === "none"} keyText={keyNote(form.apiKey, current.keySource, current.keyHint, "填你自己的密钥。")} setForm={setForm} /> : null}
        <ProbeLine probe={probe} testId="my-image-probe" />
        <div className="media-actions">
          {mode === "custom" ? (
            <Button disabled={!validUrl(form.baseUrl) || !form.model.trim() || !hasKey} feedback="test" onClick={() => void test.run()} state={test.state} type="button" variant="outline">
              {"检查（不生成图片）"}
            </Button>
          ) : null}
          <Button data-testid="my-image-save" disabled={!valid} feedback="save" state={save.state} type="submit">
            {"保存"}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ 识图

type VisionForm = { baseUrl: string; model: string; apiKey: string };

function VisionFields({ form, setForm, idPrefix, keyText, keyEmpty }: { form: VisionForm; setForm: (f: VisionForm) => void; idPrefix: string; keyText: string; keyEmpty: boolean }) {
  return (
    <div className="im-form">
      <label className="im-field" htmlFor={`${idPrefix}-base`}>
        <span className="im-field-l">{"接口地址（OpenAI 兼容）"}</span>
        <Input className="font-mono" data-testid={`${idPrefix}-base`} id={`${idPrefix}-base`} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={VISION_PRESET.baseUrl} value={form.baseUrl} />
        <span className="im-field-h">{"走 /chat/completions，消息里带图片。GPT-4o、Qwen-VL、GLM-4V、new-api 中转等都可以。"}</span>
      </label>
      <label className="im-field" htmlFor={`${idPrefix}-model`}>
        <span className="im-field-l">{"模型"}</span>
        <Input className="font-mono" data-testid={`${idPrefix}-model`} id={`${idPrefix}-model`} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={VISION_PRESET.model} value={form.model} />
      </label>
      <KeyField empty={keyEmpty} id={`${idPrefix}-key`} note={keyText} onChange={(apiKey) => setForm({ ...form, apiKey })} value={form.apiKey} />
    </div>
  );
}

// 和服务器 media.imageInputFor 一致：聊天模型能看图时图片原样发给它，识图模型只在它看不了图时写描述，以及给 image_inspect 追问细节用。
const VISION_EXPLAIN = "识图模型只在聊天模型看不了图时用：先把图片写成详细描述（含图里的文字）再交给聊天模型，同一张图只描述一次。机器人用 image_inspect 追问图片细节时也用它。聊天模型能看图时，图片直接发给聊天模型。";

function useVisionActions(scope: "default" | "personal", mode: string, form: VisionForm, hasKey: boolean, onSave: () => Promise<void>) {
  const [probe, setProbe] = useState<Probe>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
  useEffect(() => setProbe(null), [form.baseUrl, form.model, form.apiKey]);
  const fieldsOk = validUrl(form.baseUrl) && form.model.trim() !== "" && hasKey;
  const save = useAsyncAction(onSave, { errorToast: (error) => error.message });
  const test = useAsyncAction(
    async () => {
      const result = await testVisionModel({ scope, baseUrl: form.baseUrl.trim(), model: form.model.trim(), ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) });
      setProbe(result);
      if (!result.ok) throw new Error(result.message);
    },
    { errorToast: false },
  );
  return { probe, save, test, fieldsOk, valid: mode !== "custom" || fieldsOk };
}

/** 管理员：所有人的识图默认。 */
export function VisionDefaultCard({ current }: { current: VisionSettingsView }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState(current.mode);
  const [form, setForm] = useState<VisionForm>({ baseUrl: current.baseUrl, model: current.model, apiKey: "" });
  const hasKey = form.apiKey.trim() !== "" || current.keySource === "saved";
  const { probe, save, test, fieldsOk, valid } = useVisionActions("default", mode, form, hasKey, async () => {
    await saveVisionDefault(mode === "follow" ? { mode } : { mode, baseUrl: form.baseUrl.trim(), model: form.model.trim(), ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) });
    setForm((f) => ({ ...f, apiKey: "" }));
    await queryClient.invalidateQueries({ queryKey: mediaKeys.all });
  });
  return (
    <VisionShell
      actions={{ fieldsOk, save, test, valid }}
      current={current}
      form={form}
      idPrefix="vis"
      mode={mode}
      note={mode === "follow" ? "图片直接发给聊天模型。聊天模型看不了图时，机器人会提示配置识图模型。" : VISION_EXPLAIN}
      options={[
        { value: "follow", label: "跟随主模型" },
        { value: "custom", label: "单独的识图模型" },
      ]}
      probe={probe}
      setForm={setForm}
      setMode={(m) => setMode(m as typeof mode)}
      testId="vision-default"
    />
  );
}

/** 个人：用默认 / 跟随主模型 / 自己的识图模型。 */
export function VisionPersonalCard({ current, defaults }: { current: PersonalVisionView; defaults: MediaDefaultsSummary }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState(current.mode);
  const [form, setForm] = useState<VisionForm>({ baseUrl: current.baseUrl, model: current.model, apiKey: "" });
  const hasKey = form.apiKey.trim() !== "" || current.keySource === "saved";
  const { probe, save, test, fieldsOk, valid } = useVisionActions("personal", mode, form, hasKey, async () => {
    await savePersonalVision(mode !== "custom" ? { mode } : { mode, baseUrl: form.baseUrl.trim(), model: form.model.trim(), ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) });
    setForm((f) => ({ ...f, apiKey: "" }));
    await queryClient.invalidateQueries({ queryKey: mediaKeys.all });
  });
  const defaultText = defaults.vision.ready ? `默认：识图模型 ${defaults.vision.model}（只在聊天模型看不了图时描述图片，以及回答 image_inspect 追问）` : "默认：跟随主模型（图片直接发给聊天模型）。";
  return (
    <VisionShell
      actions={{ fieldsOk, save, test, valid }}
      current={current}
      form={form}
      idPrefix="my-vis"
      mode={mode}
      note={mode === "default" ? defaultText : mode === "follow" ? "图片直接发给你的聊天模型，不用识图模型。" : `${VISION_EXPLAIN}这个设置只对你的机器人生效。`}
      options={[
        { value: "default", label: "用默认" },
        { value: "follow", label: "跟随主模型" },
        { value: "custom", label: "我自己的" },
      ]}
      probe={probe}
      setForm={setForm}
      setMode={(m) => setMode(m as typeof mode)}
      testId="vision-personal"
    />
  );
}

function VisionShell({
  current,
  mode,
  setMode,
  options,
  note,
  form,
  setForm,
  idPrefix,
  probe,
  actions,
  testId,
}: {
  current: { keySource: "saved" | "none"; keyHint: string };
  mode: string;
  setMode: (m: string) => void;
  options: { value: string; label: string }[];
  note: string;
  form: VisionForm;
  setForm: (f: VisionForm) => void;
  idPrefix: string;
  probe: Probe;
  actions: { fieldsOk: boolean; valid: boolean; save: AsyncHandle; test: AsyncHandle };
  testId: string;
}) {
  return (
    <form
      autoComplete="off"
      className="media-card-stack"
      data-testid={testId}
      onSubmit={(event) => {
        event.preventDefault();
        if (actions.valid && actions.save.state !== "pending") void actions.save.run();
      }}
    >
      <div className="media-body">
        <div className="media-head">
          <Segmented label="识图方式" onChange={setMode} options={options} testId={`${idPrefix}-mode`} value={mode} />
          <span className={cn("im-field-h media-head-note")}>
            <IconEye aria-hidden className="media-head-icon" />
            {note}
          </span>
        </div>
        {mode === "custom" ? (
          <VisionFields form={form} idPrefix={idPrefix} keyEmpty={current.keySource === "none"} keyText={keyNote(form.apiKey, current.keySource, current.keyHint, "填识图接口的密钥。")} setForm={setForm} />
        ) : null}
        <ProbeLine probe={probe} testId={`${idPrefix}-probe`} />
        <div className="media-actions">
          {mode === "custom" ? (
            <Button disabled={!actions.fieldsOk} feedback="test" onClick={() => void actions.test.run()} state={actions.test.state} type="button" variant="outline">
              {"检查（发一张小图）"}
            </Button>
          ) : null}
          <Button data-testid={`${idPrefix}-save`} disabled={!actions.valid} feedback="save" state={actions.save.state} type="submit">
            {"保存"}
          </Button>
        </div>
      </div>
    </form>
  );
}
