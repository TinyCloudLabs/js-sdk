import { z } from "zod";
import { parseSpaceUri, registryOwnerKeyV2, verifyRegistryCacheEntry, type LocationRecordV2 } from "@tinycloud/sdk-core";
import type { OperationDefinition } from "../contract.js";
import { createProfileRegistryCacheStore, createProfileRegistrySequenceStore } from "../state.js";
import { operationError } from "../errors.js";

type Input = { did?: string };
type Output = { owner: string; sequence: number; fetchedAt: number; ageMs: number; nodes: LocationRecordV2["nodes"]; spaces: LocationRecordV2["spaces"]; encryptionNode: string | null };

export const registryShowOperationDefinitions: readonly OperationDefinition<Input, Output>[] = [{
  id: "tinycloud.registry.show", version: 1,
  title: "Show saved storage settings",
  description: "Check the storage settings saved on this computer. Works offline, no sign-in.",
  input: z.object({ did: z.string().min(1).optional() }).strict(),
  output: z.object({
    owner: z.string(), sequence: z.number().int().nonnegative(), fetchedAt: z.number().int().nonnegative(), ageMs: z.number().nonnegative(),
    nodes: z.array(z.object({ did: z.string(), url: z.string() }).strict()),
    spaces: z.array(z.object({ space: z.string(), nodes: z.array(z.object({ did: z.string(), mode: z.enum(["read-write", "read-only"]) }).strict()) }).strict()),
    encryptionNode: z.string().nullable(),
  }).strict(),
  effects: ["read"], runtime: "inspection",
  postures: ["owner-openkey", "delegate-session", "local-owner-key", "unauthenticated"],
  exposure: { cli: { status: "required" }, docs: { status: "required" }, mcp: { status: "excluded", reason: "Local profile cache inspection is CLI-owned." }, skill: { status: "excluded", reason: "Exposed by the CLI reference." } },
  sensitivity: { input: [], output: [] }, authority: async () => [],
  async execute(context, input) {
    const summary = context.summary;
    const owner = input.did ?? summary.ownerDid ?? (summary.space ? parseSpaceUri(summary.space)?.owner : undefined) ??
      (summary.posture !== "delegate-session" ? summary.principalDid : undefined);
    if (!owner) return { status: "error", error: operationError("INPUT_INVALID", "Not sure whose storage settings to show. Sign in, or name the account: tinycloud registry show <account-id>.") };
    try {
      const key = registryOwnerKeyV2(owner);
      const entry = await createProfileRegistryCacheStore(summary.profile).get(key);
      if (!entry) return { status: "error", error: operationError("REGISTRY_UNAVAILABLE", "This computer hasn't saved storage settings for this account yet.") };
      const remembered = await createProfileRegistrySequenceStore(summary.profile).get(key);
      const verdict = await verifyRegistryCacheEntry(owner, key, entry, remembered);
      const record = verdict.record!;
      return { status: "ok", output: { owner: record.subject, sequence: verdict.sequence, fetchedAt: entry.fetchedAt, ageMs: Math.max(0, Date.now() - entry.fetchedAt), nodes: record.nodes, spaces: record.spaces, encryptionNode: record.encryptionNode } };
    } catch {
      return { status: "error", error: operationError("REGISTRY_UNAVAILABLE", "The storage settings saved on this computer failed their signature check, so they weren't used.") };
    }
  },
}];
