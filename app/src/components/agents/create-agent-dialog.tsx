import { useMutation } from "@tanstack/react-query";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type AvatarCrop,
  AvatarCropper,
  avatarCropFromFile,
  exportAvatarCrop,
} from "@/components/avatar-crop";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentFormValues,
  agentFormSchema,
  agentInputFrom,
  emptyAgentForm,
} from "@/lib/agents/form";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import { isComposing } from "@/lib/composing";
import { queryClient } from "@/query-client";

/**
 * Creating a coworker.
 *
 * One form: an optional portrait, then name, title, and role. Every new coworker is private and
 * runs on this server — there is no visibility choice and no self-hosted endpoint. An empty
 * endpoint is what the API treats as the in-process Bot; the role text is the prompt it runs on.
 * A portrait uses the account cropper and is stored as this coworker's avatar seed.
 */
/** Smaller than the account dialog so this sheet still fits the three fields. */
const CREATE_AVATAR_STAGE = 128;
export function CreateAgentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** The new coworker's id, so the caller can open its dialog on it. */
  onCreated: (agentId: string) => void;
}) {
  /*
   * Closing must not re-render the form (DESIGN.md §37). Callers pass fresh arrow functions on
   * every render, and the close itself re-renders the caller, so the form gets callbacks that
   * never change identity and is memoised: the only work a close does is the exit animation.
   */
  const latest = useRef({ onClose, onCreated });
  useLayoutEffect(() => {
    latest.current = { onClose, onCreated };
  });
  const close = useCallback(() => latest.current.onClose(), []);
  const created = useCallback(
    (agentId: string) => latest.current.onCreated(agentId),
    [],
  );
  return (
    <Dialog onOpenChange={(next) => !next && close()} open={open}>
      <DialogContent>
        {/* All form state lives below DialogContent, whose portal unmounts on close: dismissing
            the dialog discards a half-filled form rather than pickling it. */}
        <CreateAgentForm onClose={close} onCreated={created} />
      </DialogContent>
    </Dialog>
  );
}

/** Name, title, and role — the slice the server requires before it will create. */
const identitySchema = agentFormSchema.pick({
  name: true,
  title: true,
  roleDescription: true,
});

type IdentityField = keyof typeof identitySchema.shape;

/** First message per field, or nothing when the form parses. */
function identityIssues(
  values: AgentFormValues,
): Partial<Record<IdentityField, string>> {
  const parsed = identitySchema.safeParse(values);
  if (parsed.success) return {};
  const issues: Partial<Record<IdentityField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as IdentityField | undefined;
    if (field && !issues[field]) issues[field] = issue.message;
  }
  return issues;
}

const CreateAgentForm = memo(function CreateAgentForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (agentId: string) => void;
}) {
  const createAgent = useMutation(createAgentMutationOptions(queryClient));
  /** Whether Create was pressed, which is when errors become worth showing. */
  const [tried, setTried] = useState(false);
  const [values, setValues] = useState<AgentFormValues>(emptyAgentForm);
  const [crop, setCrop] = useState<AvatarCrop | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cropSrc = crop?.src;
  useEffect(
    () => () => {
      if (cropSrc) URL.revokeObjectURL(cropSrc);
    },
    [cropSrc],
  );

  const set = <K extends keyof AgentFormValues>(
    key: K,
    value: AgentFormValues[K],
  ) => setValues((current) => ({ ...current, [key]: value }));

  const errors = tried ? identityIssues(values) : {};

  /**
   * Enter in a single-line field creates, the same as the button. A textarea keeps Enter for its
   * line breaks. The Enter that confirms a composed character finishes the character, not the form.
   */
  const submit = async () => {
    if (!identitySchema.safeParse(values).success) {
      setTried(true);
      return;
    }
    let portrait: string | undefined;
    if (crop) {
      try {
        portrait = await exportAvatarCrop(crop, CREATE_AVATAR_STAGE);
      } catch (error) {
        setPickError(error instanceof Error ? error.message : "图片无法读取");
        return;
      }
    }
    try {
      const agent = await createAgent.mutateAsync(
        agentInputFrom(
          {
            ...values,
            visibility: "private",
            endpoint: "",
            authValue: "",
          },
          portrait,
        ),
      );
      onCreated(agent.id);
    } catch {
      // The mutation's error is what the form shows.
    }
  };

  const onFile = async (file: File | undefined) => {
    setPickError(null);
    if (!file) return;
    const picked = await avatarCropFromFile(file);
    if (!picked.ok) {
      setPickError(picked.error);
      return;
    }
    setCrop(picked.crop);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{"新建机器人"}</DialogTitle>
        <DialogDescription>
          {"名字和角色会出现在左栏；角色就是它每次对话的工作说明。"}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="overflow-y-auto">
        <form
          noValidate
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !isComposing(event) &&
              event.target instanceof HTMLInputElement
            ) {
              event.preventDefault();
              void submit();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <AvatarCropper
            crop={crop}
            current={null}
            onChange={setCrop}
            onPick={() => fileRef.current?.click()}
            stage={CREATE_AVATAR_STAGE}
          />
          <input
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            className="hidden"
            onChange={(event) => {
              void onFile(event.target.files?.[0]);
              event.target.value = "";
            }}
            ref={fileRef}
            type="file"
          />
          {pickError ? (
            <p className="text-center text-destructive text-xs" role="alert">
              {pickError}
            </p>
          ) : null}
          <FieldGroup>
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor="create-agent-name">{"名称"}</FieldLabel>
              <Input
                aria-invalid={errors.name ? true : undefined}
                id="create-agent-name"
                onChange={(event) => set("name", event.target.value)}
                placeholder={"怎么称呼它"}
                value={values.name}
              />
              {errors.name ? (
                <FieldError errors={[{ message: errors.name }]} />
              ) : null}
            </Field>
            <Field data-invalid={errors.title ? true : undefined}>
              <FieldLabel htmlFor="create-agent-title">{"职责"}</FieldLabel>
              <Input
                aria-invalid={errors.title ? true : undefined}
                id="create-agent-title"
                onChange={(event) => set("title", event.target.value)}
                placeholder={"一句话说明它负责什么"}
                value={values.title}
              />
              {errors.title ? (
                <FieldError errors={[{ message: errors.title }]} />
              ) : null}
            </Field>
            <Field data-invalid={errors.roleDescription ? true : undefined}>
              <FieldLabel htmlFor="create-agent-role">{"角色"}</FieldLabel>
              <Textarea
                aria-invalid={errors.roleDescription ? true : undefined}
                id="create-agent-role"
                onChange={(event) => set("roleDescription", event.target.value)}
                placeholder={"它每次对话要做的事"}
                rows={4}
                value={values.roleDescription}
              />
              {errors.roleDescription ? (
                <FieldError errors={[{ message: errors.roleDescription }]} />
              ) : null}
            </Field>
          </FieldGroup>
          {createAgent.error ? (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {createAgent.error.message}
            </p>
          ) : null}
        </form>
      </DialogBody>
      <DialogFooter className="mt-4 justify-between">
        <Button onClick={onClose} type="button" variant="outline">
          {"取消"}
        </Button>
        <Button
          feedback="create"
          mutation={createAgent}
          onClick={() => void submit()}
          type="button"
        >
          {"创建机器人"}
        </Button>
      </DialogFooter>
    </>
  );
});
