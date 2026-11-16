import { PanelError, type Json } from "./types";
export function canonicalJson(value: unknown): string {
  let count = 0;
  function visit(v: unknown, depth: number): unknown {
    if (++count > 10000 || depth > 32) throw new PanelError("json_limit", 400);
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map((item) => visit(item, depth + 1));
    if (
      typeof v === "object" &&
      v &&
      (Object.getPrototypeOf(v) === Object.prototype ||
        Object.getPrototypeOf(v) === null)
    )
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((key) => [
            key,
            visit((v as Record<string, unknown>)[key], depth + 1),
          ]),
      );
    throw new PanelError("invalid_json", 400);
  }
  return JSON.stringify(visit(value, 0));
}
export function assertBoundedJson(
  value: unknown,
  bytes = 256 * 1024,
): asserts value is Json {
  if (new TextEncoder().encode(canonicalJson(value)).length > bytes)
    throw new PanelError("json_limit", 400);
}
// Only this portable subset is accepted; unsupported constraints fail closed.
const keywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "description",
  "title",
]);
export function validateStateSchema(
  schema: unknown,
  depth = 0,
): asserts schema is Record<string, Json> {
  if (
    depth > 16 ||
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  )
    throw new PanelError("invalid_state_schema", 400);
  const s = schema as Record<string, unknown>;
  if (
    Object.keys(s).some((k) => !keywords.has(k)) ||
    ![
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
      "null",
    ].includes(String(s.type))
  )
    throw new PanelError("unsupported_state_schema", 400);
  if (s.properties !== undefined) {
    if (
      s.type !== "object" ||
      !s.properties ||
      typeof s.properties !== "object" ||
      Array.isArray(s.properties)
    )
      throw new PanelError("invalid_state_schema", 400);
    for (const child of Object.values(s.properties))
      validateStateSchema(child, depth + 1);
  }
  if (
    s.required !== undefined &&
    (!Array.isArray(s.required) ||
      s.required.some((k) => typeof k !== "string"))
  )
    throw new PanelError("invalid_state_schema", 400);
  if (
    s.additionalProperties !== undefined &&
    typeof s.additionalProperties !== "boolean"
  )
    throw new PanelError("invalid_state_schema", 400);
  if (s.type === "array") validateStateSchema(s.items, depth + 1);
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0))
    throw new PanelError("invalid_state_schema", 400);
  for (const k of [
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
  ])
    if (
      s[k] !== undefined &&
      (typeof s[k] !== "number" ||
        !Number.isFinite(s[k]) ||
        ((k.includes("Length") || k.endsWith("Items")) &&
          (!Number.isInteger(s[k]) || s[k] < 0)))
    )
      throw new PanelError("invalid_state_schema", 400);
  assertBoundedJson(schema);
}
export function stateMatches(s: Record<string, Json>, value: Json): boolean {
  if (
    s.enum &&
    !(s.enum as Json[]).some(
      (item) => canonicalJson(item) === canonicalJson(value),
    )
  )
    return false;
  if ("const" in s && canonicalJson(s.const) !== canonicalJson(value))
    return false;
  switch (s.type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return (
        typeof value === "string" &&
        value.length >= Number(s.minLength ?? 0) &&
        value.length <= Number(s.maxLength ?? Infinity)
      );
    case "number":
    case "integer":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (s.type !== "integer" || Number.isInteger(value)) &&
        value >= Number(s.minimum ?? -Infinity) &&
        value <= Number(s.maximum ?? Infinity)
      );
    case "array":
      return (
        Array.isArray(value) &&
        value.length >= Number(s.minItems ?? 0) &&
        value.length <= Number(s.maxItems ?? Infinity) &&
        value.every((v) => stateMatches(s.items as Record<string, Json>, v))
      );
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      const props = (s.properties ?? {}) as Record<
        string,
        Record<string, Json>
      >;
      if (
        (s.required as string[] | undefined)?.some(
          (key) => !Object.hasOwn(value, key),
        )
      )
        return false;
      return Object.entries(value).every(([key, v]) => {
        const propSchema = props[key];
        return Object.hasOwn(props, key) && propSchema
          ? stateMatches(propSchema, v)
          : s.additionalProperties !== false;
      });
    }
    default:
      return false;
  }
}
