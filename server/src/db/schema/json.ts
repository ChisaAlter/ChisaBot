import { jsonb as drizzleJsonb, type PgJsonbBuilder } from "drizzle-orm/pg-core";

type ObjectJsonbBuilder<TName extends string> = PgJsonbBuilder<{
  name: TName;
  dataType: "json";
  columnType: "PgJsonb";
  data: Record<string, unknown>;
  driverParam: unknown;
  enumValues: undefined;
}>;

/**
 * Object-valued JSON using Drizzle's normal serialization and read mapping.
 *
 * createDatabase explicitly uses Bun's unnamed extended-query mode. Before the server describes
 * a parameter, that mode sends a plain object's string conversion rather than JSON. Drizzle must
 * serialize it once, so PostgreSQL stores an object and JSON operators can address its fields.
 *
 * The old named-statement workaround passed objects through to Bun to avoid double serialization;
 * it is incompatible with the unnamed mode. Keep the schema entry point and object type while
 * reusing Drizzle's serializer and its string-or-object result mapping.
 *
 */
export function jsonb<TName extends string = "">(name: TName = "" as TName) {
  // Set the base data type rather than calling $type here: callers must remain free to use
  // $type<SomeArray>() without intersecting that override with Record<string, unknown>.
  return drizzleJsonb(name) as ObjectJsonbBuilder<TName>;
}
