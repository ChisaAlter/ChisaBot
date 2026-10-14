import { z } from "zod";

/**
 * Browser-side coworker form contract. Limits match the server parser so validation errors can be
 * shown next to fields before submit.
 */
export const agentFormSchema = z.object({
  name: z.string().trim().min(1, "请填写名称。").max(80, "名称最多 80 个字。"),
  title: z
    .string()
    .trim()
    .min(1, "请填写职责。")
    .max(120, "职责最多 120 个字。"),
  roleDescription: z
    .string()
    .trim()
    .min(1, "请填写角色说明。")
    .max(1000, "角色说明最多 1000 个字。"),
  visibility: z.enum(["public", "private"]),
  /**
   * The AG-UI endpoint this coworker runs on. Empty means the Bot in the box.
   *
   * Only URL shape is checked here; deployment allow/deny rules are server-side.
   */
  endpoint: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^https?:\/\/\S+$/.test(value),
      "请输入以 http:// 或 https:// 开头的网址。",
    ),
  /**
   * A key the agent sits behind. WRITE-ONLY: it is never sent back from the server, so this field is
   * always empty when editing, and leaving it empty keeps whatever key is already set.
   */
  authValue: z.string(),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;

export const emptyAgentForm: AgentFormValues = {
  name: "",
  title: "",
  roleDescription: "",
  visibility: "private",
  endpoint: "",
  authValue: "",
};

/**
 * Convert form values to API input; omit an empty key so editing preserves the current credential.
 *
 * `portrait` is the cropped JPEG data URL from the shared avatar cropper. Omitted leaves the
 * generated face (create) or the stored one (edit) alone.
 */
export function agentInputFrom(values: AgentFormValues, portrait?: string) {
  return {
    name: values.name,
    title: values.title,
    roleDescription: values.roleDescription,
    visibility: values.visibility,
    endpoint: values.endpoint,
    ...(values.authValue.trim()
      ? { auth: { header: "Authorization", value: values.authValue.trim() } }
      : {}),
    ...(portrait ? { avatarSeed: portrait } : {}),
  };
}
