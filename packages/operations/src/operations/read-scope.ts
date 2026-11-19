import type { PermissionEntry } from "@tinycloud/sdk-core";
import { z } from "zod";

import { PermissionEntrySchema } from "../artifacts.js";
import { canonicalizeCapabilities } from "../authority.js";
import type { OperationDefinition, RuntimeOperationContext } from "../contract.js";
import { OperationInvocationError, operationError } from "../errors.js";
import { KvGetInputSchema, resolveGenericKvSpace, runtimeContext } from "./exploration.js";
import { SqlQueryInputSchema } from "./sql.js";

const InputSchema = z.object({
  space: KvGetInputSchema.shape.space,
  kvPrefixes: z.array(z.string().max(2048).refine(
    (prefix) => (prefix === "" || prefix.endsWith("/")) && prefix !== "/" &&
      !prefix.includes("*") && !/[\u0000-\u001f\u007f]/.test(prefix),
    "Select a recursive slash-ended KV prefix, or explicitly select the empty prefix for the whole space.",
  )).min(1).max(20).optional(),
  databases: z.array(SqlQueryInputSchema.shape.database).min(1).max(20).optional(),
}).strict().superRefine((input, issue) => {
  if (input.kvPrefixes === undefined && input.databases === undefined) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "Select at least one KV prefix or exact database." });
  }
});

type ReadScopeInput = z.infer<typeof InputSchema>;
const OutputSchema = z.object({
  space: z.string().min(1),
  permissions: z.array(PermissionEntrySchema).min(1),
  access: z.literal("not-tested"),
}).strict();

function scopeSpace(context: RuntimeOperationContext, input: ReadScopeInput): string {
  const space = resolveGenericKvSpace(context, input.space);
  // Hosted consent signs the selected owner's named space, never another
  // owner's same-named space. Preserve that identity before creating a request.
  const ownSpace = resolveGenericKvSpace(context, space.split(":").at(-1)!);
  if (space !== ownSpace) {
    throw new OperationInvocationError(operationError(
      "INPUT_INVALID",
      "Read-scope approval must target the selected owner's space.",
    ));
  }
  return space;
}

async function planReadScope(context: RuntimeOperationContext, input: ReadScopeInput): Promise<z.infer<typeof PermissionEntrySchema>[]> {
  const space = scopeSpace(context, input);
  const permissions: PermissionEntry[] = [];
  for (const path of input.kvPrefixes ?? []) {
    permissions.push({
      service: "tinycloud.kv", space, path,
      actions: ["tinycloud.kv/get", "tinycloud.kv/metadata", "tinycloud.kv/list"],
    });
  }
  for (const path of input.databases ?? []) {
    permissions.push({ service: "tinycloud.sql", space, path, actions: ["tinycloud.sql/read"] });
  }
  return canonicalizeCapabilities(permissions);
}

export const readScopeOperationDefinitions: readonly OperationDefinition<ReadScopeInput, z.infer<typeof OutputSchema>>[] = [{
  id: "tinycloud.auth.read_scope",
  version: 1,
  title: "Approve a reusable TinyCloud read scope",
  description: "Explicitly select recursive KV prefixes and/or exact read-only databases in one existing owner space. Missing authority uses the normal request-bound approval flow. Empty KV prefix explicitly requests the whole space. No write authority is requested; ordinary GET/HEAD requests stay exact. Future children are covered only until grant expiry/revocation. Success reports capability coverage, not a storage read; then use KV/SQL discovery or tinycloud_read.",
  input: InputSchema,
  output: OutputSchema,
  effects: ["read"],
  runtime: "authenticated",
  postures: ["owner-openkey", "delegate-session", "local-owner-key"],
  exposure: {
    cli: { status: "excluded", reason: "The CLI retains its explicit permission-manifest/request flow; SDK callers use invokeOperation." },
    mcp: { status: "required" }, skill: { status: "required" }, docs: { status: "required" },
  },
  sensitivity: { input: ["/kvPrefixes", "/databases"], output: ["/permissions"] },
  authority: planReadScope,
  execute: async (context, input) => {
    const runtime = runtimeContext(context);
    return {
      status: "ok",
      output: { space: scopeSpace(runtime, input), permissions: await planReadScope(runtime, input), access: "not-tested" },
    };
  },
}];
