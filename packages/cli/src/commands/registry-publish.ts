import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import {
  DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL, exactHttpOrigin,
  principalDidEquals, registryOwnerKeyV2,
  verifyRegistryCacheEntry, type LocationRecordV2, type LocationRecordV2Payload,
} from "@tinycloud/sdk-core";
import { boundedResponseBytes, publishLocationRecordV2 } from "@tinycloud/sdk-core/registry-publication";
import { createProfileRegistryCacheStore, createProfileRegistrySequenceStore } from "@tinycloud/operations/state";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { resolveProfilePosture } from "../config/types.js";
import { CLIError, handleError } from "../output/errors.js";
import { outputJson, shouldOutputJson } from "../output/formatter.js";

const DISCLOSURE = "Anyone who knows your account ID can look these up.";
const EFFECT = "After this, a space that isn't in your storage settings stops with an error instead of using another server.";
const CONFLICT = "These storage settings changed before they could be published. Run this command again without --yes to review the latest settings.";

async function nodeAt(value: string, option: "--server" | "--decryption-server"): Promise<{ did: string; url: string }> {
  const url = exactHttpOrigin(value, "storage server URL");
  const unavailable = () => new CLIError("SERVER_IDENTITY_UNAVAILABLE", `Couldn't check this storage server, so nothing was published. Check the ${option} address and try again.`);
  const invalid = () => new CLIError("SERVER_IDENTITY_INVALID", `This doesn't look like a TinyCloud storage server, so nothing was published. Check the ${option} address.`);
  let response: Response;
  try {
    response = await fetch(`${url}/info`, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  } catch { throw unavailable(); }
  if (!response.ok || response.redirected) throw unavailable();
  const bytes = await boundedResponseBytes(response, 64 * 1024);
  if (bytes === null) throw invalid();
  let info: unknown;
  try { info = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
  if (!info || typeof info !== "object" || !("nodeId" in info) || typeof info.nodeId !== "string") throw invalid();
  // The publisher checks this DID against both public identity surfaces before signing.
  return { did: info.nodeId, url };
}

function preview(payload: Readonly<LocationRecordV2Payload>, current: Readonly<LocationRecordV2> | null, includeDisclosure: boolean): void {
  const quote = (value: string) => JSON.stringify(value);
  const nodes = new Map(payload.nodes.map((node) => [node.did, node.url]));
  process.stderr.write(`Account: ${quote(payload.subject)}\nStorage servers:\n`);
  for (const node of payload.nodes) process.stderr.write(`  ${quote(node.url)}, server ID ${quote(node.did)}\n`);
  process.stderr.write("Spaces:\n");
  let hasChanges = false;
  for (const entry of payload.spaces) {
    const previous = current?.spaces.find(({ space }) => space === entry.space);
    const changed = !previous || JSON.stringify([...previous.nodes].sort((a, b) => a.did.localeCompare(b.did))) !==
      JSON.stringify([...entry.nodes].sort((a, b) => a.did.localeCompare(b.did)));
    hasChanges ||= changed;
    process.stderr.write(`  ${quote(entry.space)}${changed ? " *" : ""}\n`);
    for (const node of entry.nodes) process.stderr.write(`    ${quote(nodes.get(node.did)!)} (${node.mode === "read-write" ? "read and write" : "read only"})\n`);
  }
  if (hasChanges) process.stderr.write("* new or changed\n");
  process.stderr.write(`Decryption service: ${payload.encryptionNode === null ? "none" : quote(nodes.get(payload.encryptionNode)!)}\n${EFFECT}\n`);
  if (includeDisclosure) process.stderr.write(`${DISCLOSURE}\n`);
}

export function registerRegistryPublishCommand(registry: Command): void {
  registry.command("publish")
    .description("Sign and publish this account's storage settings, so TinyCloud knows which servers to use for your data.")
    .argument("<space...>", "Spaces to include in these storage settings.")
    .requiredOption("--server <url>", "Storage server to use for these spaces.")
    .option("--read-only", "Use this server only for reading these spaces.")
    .option("--decryption-server <url>", "Decryption service to use with these storage settings.")
    .option("--yes", "Publish without asking. Anyone who knows your account ID can look up the servers and spaces you list.")
    .action(async (names: string[], options: { server: string; readOnly?: boolean; decryptionServer?: string; yes?: boolean }, command: Command) => {
      try {
        if (!options.yes && (!process.stdin.isTTY || !process.stderr.isTTY || command.optsWithGlobals().json)) {
          throw new CLIError("CONFIRMATION_REQUIRED", "Publishing lets anyone who knows your account ID look up these servers and space names. Run this in a terminal to review them, or add --yes to publish without asking.");
        }
        // Explicit --server must not trigger discovery or a saved-host resolution.
        const context = await ProfileManager.resolveContext({ ...command.optsWithGlobals(), host: options.server }, { storedSession: "unused" });
        const result = await ProfileManager.withLock(context.profile, async () => {
          const profile = await ProfileManager.getProfile(context.profile);
          if (resolveProfilePosture(profile) !== "local-owner-key" || profile.authMethod !== "local" || !profile.privateKey || profile.authSignedOut) {
            throw new CLIError("AUTH_REQUIRED", "This profile can't sign storage settings for this account. Use a profile that holds the account's own key (signed in with --method local).", ExitCode.AUTH_REQUIRED);
          }
          const signer = new PrivateKeySigner(profile.privateKey);
          const address = await signer.getAddress();
          const subject = `did:pkh:eip155:${profile.chainId}:${address}`;
          if ((profile.ownerDid && !principalDidEquals(profile.ownerDid, subject)) ||
              (profile.address && profile.address.toLowerCase() !== address.toLowerCase())) {
            throw new CLIError("AUTH_REQUIRED", "This profile can't sign storage settings for this account. Use a profile that holds the account's own key (signed in with --method local).", ExitCode.AUTH_REQUIRED);
          }
          const storage = await nodeAt(options.server, "--server");
          const encryptionNode = options.decryptionServer === undefined ? undefined : await nodeAt(options.decryptionServer, "--decryption-server");
          const cache = createProfileRegistryCacheStore(context.profile);
          const sequences = createProfileRegistrySequenceStore(context.profile);
          let previewShown = false;
          const record = await publishLocationRecordV2({
            registryUrl: context.tinycloudRegistryUrl ?? DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL,
            subject, signer: { type: "did:pkh", signMessage: (message) => signer.signMessage(message) },
            memberships: names.map((name) => ({
              space: name.startsWith("tinycloud:") ? name : `tinycloud:pkh:eip155:${profile.chainId}:${address.toLowerCase()}:${name}`,
              node: storage, mode: options.readOnly ? "read-only" : "read-write",
            })),
            ...(encryptionNode === undefined ? {} : { encryptionNode }),
            cacheStore: cache, sequenceStore: sequences,
            onPrepared: async (payload, current) => {
              preview(payload, current, options.yes === true);
              previewShown = true;
              if (options.yes) return true;
              const terminal = createInterface({ input: process.stdin, output: process.stderr });
              try {
                const answer = await terminal.question(`${DISCLOSURE} Publish these storage settings for this account? [y/N] `);
                if (answer.trim().toLowerCase() !== "y") throw new CLIError("PUBLICATION_CANCELLED", "Nothing was published.");
                return true;
              } finally { terminal.close(); }
            },
          });
          if (!previewShown) preview(record, record, true);
          // Publication has already happened. Report that fact even if local persistence fails.
          const ownerKey = registryOwnerKeyV2(subject);
          try {
            await cache.update(ownerKey, async (previous, revision) => {
              if (previous) {
                const accepted = await verifyRegistryCacheEntry(subject, ownerKey, previous);
                if (accepted.sequence > record.sequence) return previous;
              }
              await sequences.set(ownerKey, record.sequence);
              return { ownerKey, responseBody: JSON.stringify({ record }), fetchedAt: Date.now(), sequence: record.sequence, revision };
            });
          } catch {
            throw new CLIError("REGISTRY_CACHE_WRITE_FAILED", "Storage settings were published, but this computer couldn't save its copy. Run this command again to save it.");
          }
          return { published: true, changed: previewShown, record, disclosure: DISCLOSURE, effect: EFFECT };
        });
        if (shouldOutputJson()) outputJson(result);
        else process.stdout.write(result.changed
          ? "Published this account's storage settings.\n"
          : "These storage settings are already published. Nothing changed.\n");
      } catch (error) {
        if (error && typeof error === "object" && "status" in error && error.status === 409) return handleError(new CLIError("REGISTRY_CONFLICT", CONFLICT));
        return handleError(error);
      }
    });
}
