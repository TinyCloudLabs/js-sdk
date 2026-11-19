type JsonSchema = boolean | Record<string, unknown>;

const DRAFT_7 = "http://json-schema.org/draft-07/schema#";
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const schemaMaps = new Set(["properties", "patternProperties", "definitions", "$defs"]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf"]);
const schemaValues = new Set([
  "additionalProperties", "items", "contains", "propertyNames", "not", "if", "then", "else",
]);

/** Project the catalog's shared Draft-07/2020-12 vocabulary without changing its validation rules. */
export function toMcpJsonSchema(schema: Record<string, unknown>): Record<string, unknown>;
export function toMcpJsonSchema(schema: JsonSchema): JsonSchema;
export function toMcpJsonSchema(schema: JsonSchema): JsonSchema {
  if (typeof schema === "boolean") return schema;
  // These forms need a semantic migration, not just a dialect declaration. The
  // generated catalog does not use them; fail closed if that contract changes.
  if (Array.isArray(schema.items) || "additionalItems" in schema || "dependencies" in schema ||
    ("$ref" in schema && Object.keys(schema).some((key) => key !== "$ref"))) {
    throw new Error("The operations schema needs a semantic migration to JSON Schema 2020-12.");
  }

  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema") {
      if (value !== DRAFT_7) throw new Error(`Unsupported operations schema dialect: ${String(value)}.`);
      projected[key] = DRAFT_2020_12;
    } else if (schemaMaps.has(key)) {
      projected[key] = Object.fromEntries(Object.entries(value as Record<string, JsonSchema>)
        .map(([name, child]) => [name, toMcpJsonSchema(child)]));
    } else if (schemaArrays.has(key)) {
      projected[key] = (value as JsonSchema[]).map(toMcpJsonSchema);
    } else if (schemaValues.has(key)) {
      projected[key] = toMcpJsonSchema(value as JsonSchema);
    } else {
      // Descriptions, defaults, examples and const/enum values are data, not schemas.
      projected[key] = value;
    }
  }
  return projected;
}
