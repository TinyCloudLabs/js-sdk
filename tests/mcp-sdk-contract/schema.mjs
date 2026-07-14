import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("secret"),
    name: z.string(),
    scope: z.string().optional(),
  }),
  z.object({
    kind: z.literal("space"),
    space: z.string(),
  }),
]);

export const inputSchema = z.object({
  requestId: z.string().optional(),
  target: targetSchema,
  includeMetadata: z.boolean().optional(),
});

export const outputSchema = z.object({
  status: z.literal("ok"),
  selected: z.string(),
  metadata: z.object({ source: z.string().optional() }).optional(),
});

// This is the exact I0 contract path: Zod 3 -> zod-to-json-schema JSON Schema 7
// with references removed -> MCP v2 fromJsonSchema adapter.
const jsonSchemaOptions = { target: "jsonSchema7", $refStrategy: "none" };
export const inputJsonSchema = zodToJsonSchema(inputSchema, jsonSchemaOptions);
export const outputJsonSchema = zodToJsonSchema(outputSchema, jsonSchemaOptions);
